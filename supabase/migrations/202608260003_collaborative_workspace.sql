-- Shared workspace + per-user activity. Run after 202608260002_five_role_access.sql.
create table if not exists public.spc_entity_activity (
  workspace_id text not null default 'main',
  entity_type text not null,
  entity_id text not null,
  created_by uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_by_email text,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, entity_type, entity_id)
);
create index if not exists spc_entity_activity_updated_idx
  on public.spc_entity_activity(workspace_id, updated_at desc);
alter table public.spc_entity_activity enable row level security;

create or replace function public.spc_json_merge_three_way(p_base jsonb, p_local jsonb, p_remote jsonb)
returns jsonb language plpgsql immutable set search_path = public as $$
declare result jsonb; k text; item_id text; b jsonb; l jsonb; r jsonb; ids text[];
begin
  if p_local is not distinct from p_base then return p_remote; end if;
  if p_remote is not distinct from p_base then return p_local; end if;
  if p_local is not distinct from p_remote then return p_local; end if;
  if jsonb_typeof(p_base)='object' and jsonb_typeof(p_local)='object' and jsonb_typeof(p_remote)='object' then
    result := '{}'::jsonb;
    for k in select distinct key from (
      select jsonb_object_keys(p_base) key union all select jsonb_object_keys(p_local) union all select jsonb_object_keys(p_remote)
    ) q loop
      if not (p_local ? k) and (p_remote->k is not distinct from p_base->k) then continue; end if;
      if not (p_remote ? k) and (p_local->k is not distinct from p_base->k) then continue; end if;
      result := result || jsonb_build_object(k, public.spc_json_merge_three_way(p_base->k,p_local->k,p_remote->k));
    end loop;
    return result;
  end if;
  if jsonb_typeof(p_base)='array' and jsonb_typeof(p_local)='array' and jsonb_typeof(p_remote)='array'
     and not exists(select 1 from jsonb_array_elements(p_base||p_local||p_remote) x where jsonb_typeof(x)<>'object' or not (x?'id')) then
    result := '[]'::jsonb;
    select array_agg(distinct x->>'id' order by x->>'id') into ids from jsonb_array_elements(p_base||p_local||p_remote) x;
    foreach item_id in array coalesce(ids,array[]::text[]) loop
      select x into b from jsonb_array_elements(p_base) x where x->>'id'=item_id limit 1;
      select x into l from jsonb_array_elements(p_local) x where x->>'id'=item_id limit 1;
      select x into r from jsonb_array_elements(p_remote) x where x->>'id'=item_id limit 1;
      if l is null and r is not distinct from b then b:=null; l:=null; r:=null;
      elsif r is null and l is not distinct from b then b:=null; l:=null; r:=null;
      elsif l is null then l:=r;
      elsif r is null then r:=l;
      end if;
      if l is not null or r is not null then
        result := result || jsonb_build_array(public.spc_json_merge_three_way(b,l,r));
      end if;
      b:=null; l:=null; r:=null;
    end loop;
    return result;
  end if;
  -- Same scalar/list field changed concurrently: keep the already committed value.
  return p_remote;
end;
$$;

create or replace function public.spc_note_entity_change(
  p_type text, p_id text, p_before jsonb, p_after jsonb, p_version bigint
) returns void language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); actor_email text:=coalesce(auth.jwt()->>'email','unknown'); action_name text;
begin
  if p_before is not distinct from p_after then return; end if;
  action_name:=case when p_before is null then 'CREATE' when p_after is null then 'DELETE' else 'UPDATE' end;
  if p_after is not null then
    insert into spc_entity_activity(workspace_id,entity_type,entity_id,created_by,created_by_email,updated_by,updated_by_email)
    values('main',p_type,p_id,actor,actor_email,actor,actor_email)
    on conflict(workspace_id,entity_type,entity_id) do update
      set updated_by=excluded.updated_by,updated_by_email=excluded.updated_by_email,updated_at=now();
  end if;
  insert into spc_audit_logs(workspace_id,action,entity_type,entity_id,detail)
    values('main',action_name,p_type,p_id,jsonb_build_object(
      'version',p_version,'user_id',actor,'user_email',actor_email,
      'changed_at',now(),'before',p_before,'after',p_after));
end;
$$;

create or replace function public.spc_log_workspace_changes(p_before jsonb,p_after jsonb,p_version bigint)
returns void language plpgsql security definer set search_path=public as $$
declare t text; parent jsonb; entity jsonb; entity_id text; before_entity jsonb; after_entity jsonb;
begin
  for entity_id in select distinct x->>'id' from jsonb_array_elements(coalesce(p_before->'catalog','[]')) x
    union select distinct x->>'id' from jsonb_array_elements(coalesce(p_after->'catalog','[]')) x loop
    select x into before_entity from jsonb_array_elements(coalesce(p_before->'catalog','[]')) x where x->>'id'=entity_id;
    select x into after_entity from jsonb_array_elements(coalesce(p_after->'catalog','[]')) x where x->>'id'=entity_id;
    perform spc_note_entity_change('product',entity_id,before_entity,after_entity,p_version);
  end loop;
  for entity_id in select distinct x->>'id' from jsonb_array_elements(coalesce(p_before->'projects','[]')) x
    union select distinct x->>'id' from jsonb_array_elements(coalesce(p_after->'projects','[]')) x loop
    select x into before_entity from jsonb_array_elements(coalesce(p_before->'projects','[]')) x where x->>'id'=entity_id;
    select x into after_entity from jsonb_array_elements(coalesce(p_after->'projects','[]')) x where x->>'id'=entity_id;
    perform spc_note_entity_change('project',entity_id,before_entity-'units'-'journals'-'products',after_entity-'units'-'journals'-'products',p_version);
  end loop;
  foreach t in array array['units','journals'] loop
    for entity_id in
      select distinct x->>'id' from jsonb_array_elements(coalesce(p_before->'projects','[]')) p
        cross join lateral jsonb_array_elements(coalesce(p->t,'[]')) x
      union
      select distinct x->>'id' from jsonb_array_elements(coalesce(p_after->'projects','[]')) p
        cross join lateral jsonb_array_elements(coalesce(p->t,'[]')) x
    loop
      select x into before_entity from jsonb_array_elements(coalesce(p_before->'projects','[]')) p
        cross join lateral jsonb_array_elements(coalesce(p->t,'[]')) x where x->>'id'=entity_id limit 1;
      select x into after_entity from jsonb_array_elements(coalesce(p_after->'projects','[]')) p
        cross join lateral jsonb_array_elements(coalesce(p->t,'[]')) x where x->>'id'=entity_id limit 1;
      perform spc_note_entity_change(case when t='units' then 'unit' else 'journal' end,entity_id,
        case when t='units' then before_entity-'surveys'-'works'-'defects'-'acceptances'-'events' else before_entity end,
        case when t='units' then after_entity-'surveys'-'works'-'defects'-'acceptances'-'events' else after_entity end,p_version);
    end loop;
  end loop;
  foreach t in array array['surveys','works','defects','acceptances','events'] loop
    for entity_id in
      select distinct x->>'id' from jsonb_array_elements(coalesce(p_before->'projects','[]')) p
        cross join lateral jsonb_array_elements(coalesce(p->'units','[]')) u
        cross join lateral jsonb_array_elements(coalesce(u->t,'[]')) x
      union
      select distinct x->>'id' from jsonb_array_elements(coalesce(p_after->'projects','[]')) p
        cross join lateral jsonb_array_elements(coalesce(p->'units','[]')) u
        cross join lateral jsonb_array_elements(coalesce(u->t,'[]')) x
    loop
      select x into before_entity from jsonb_array_elements(coalesce(p_before->'projects','[]')) p cross join lateral jsonb_array_elements(coalesce(p->'units','[]')) u cross join lateral jsonb_array_elements(coalesce(u->t,'[]')) x where x->>'id'=entity_id limit 1;
      select x into after_entity from jsonb_array_elements(coalesce(p_after->'projects','[]')) p cross join lateral jsonb_array_elements(coalesce(p->'units','[]')) u cross join lateral jsonb_array_elements(coalesce(u->t,'[]')) x where x->>'id'=entity_id limit 1;
      perform spc_note_entity_change(case t when 'surveys' then 'survey' when 'works' then 'work'
        when 'defects' then 'defect' when 'acceptances' then 'acceptance' else 'event' end,
        entity_id,before_entity,after_entity,p_version);
    end loop;
  end loop;
end;
$$;

create or replace function public.spc_merge_workspace(
  p_base_version bigint,p_base_projects jsonb,p_projects jsonb,p_base_catalog jsonb,p_catalog jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare current_snapshot jsonb; merged_projects jsonb; merged_catalog jsonb; new_version bigint; r text;
begin
  if auth.uid() is null or not public.spc_can_access_workspace() then raise exception 'SPC_LOGIN_REQUIRED' using errcode='42501'; end if;
  perform 1 from spc_workspaces where id='main' for update;
  current_snapshot:=public.spc_load_workspace_unchecked();
  r:=public.spc_current_role();
  if r not in ('admin','shenyin') then
    p_projects:=public.spc_merge_restricted_projects(current_snapshot->'projects',p_projects,r);
    p_base_projects:=public.spc_merge_restricted_projects(current_snapshot->'projects',p_base_projects,r);
    p_catalog:=current_snapshot->'catalog'; p_base_catalog:=current_snapshot->'catalog';
  end if;
  merged_projects:=public.spc_json_merge_three_way(coalesce(p_base_projects,'[]'),coalesce(p_projects,'[]'),current_snapshot->'projects');
  merged_catalog:=public.spc_json_merge_three_way(coalesce(p_base_catalog,'[]'),coalesce(p_catalog,'[]'),current_snapshot->'catalog');
  new_version:=public.spc_save_workspace_unchecked((current_snapshot->>'version')::bigint,merged_projects,merged_catalog);
  perform public.spc_log_workspace_changes(current_snapshot,jsonb_build_object('projects',merged_projects,'catalog',merged_catalog),new_version);
  return jsonb_build_object('version',new_version,'merged',p_base_version<>(current_snapshot->>'version')::bigint);
end;
$$;

create or replace function public.spc_load_entity_activity()
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'entityType',entity_type,'entityId',entity_id,'createdBy',created_by,'createdByEmail',created_by_email,
    'createdAt',created_at,'updatedBy',updated_by,'updatedByEmail',updated_by_email,'updatedAt',updated_at
  ) order by updated_at desc),'[]'::jsonb) from spc_entity_activity where workspace_id='main';
$$;

revoke all on function public.spc_json_merge_three_way(jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.spc_note_entity_change(text,text,jsonb,jsonb,bigint) from public,anon,authenticated;
revoke all on function public.spc_log_workspace_changes(jsonb,jsonb,bigint) from public,anon,authenticated;
revoke all on function public.spc_merge_workspace(bigint,jsonb,jsonb,jsonb,jsonb) from public,anon;
revoke all on function public.spc_load_entity_activity() from public,anon;
grant execute on function public.spc_merge_workspace(bigint,jsonb,jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.spc_load_entity_activity() to authenticated;
