-- Five-role authorization model: admin, Shen-Yin, client, crew and sales.
-- Apply after 202608260001_staff_roles_and_operator_access.sql.

alter table public.spc_user_roles drop constraint if exists spc_user_roles_role_check;

-- Preserve existing assignments without accidentally granting former visitors access.
update public.spc_user_roles set active = false where role = 'visitor';
update public.spc_user_roles set role = case
  when role = 'manager' then 'shenyin'
  when role in ('surveyor', 'acceptance', 'installer') then 'crew'
  when role = 'visitor' then 'client'
  else role
end;
update public.spc_user_roles
set role = 'admin', active = true, updated_at = now()
where lower(email) = 'wongkinlun9527@gmail.com';

alter table public.spc_user_roles
  add constraint spc_user_roles_role_check
  check (role in ('admin', 'shenyin', 'client', 'crew', 'sales'));

create or replace function public.spc_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.spc_user_roles(user_id, email, display_name, role)
  values (new.id, coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'name', ''), 'client')
  on conflict (user_id) do update set email = excluded.email, updated_at = now();
  return new;
end;
$$;

create or replace function public.spc_is_admin(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.spc_user_roles
    where user_id = p_user_id and role = 'admin' and active);
$$;

create or replace function public.spc_has_full_access(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.spc_user_roles
    where user_id = p_user_id and role in ('admin', 'shenyin') and active);
$$;

create or replace function public.spc_can_access_workspace(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.spc_user_roles
    where user_id = p_user_id and role in ('admin', 'shenyin', 'client', 'crew', 'sales') and active);
$$;

create or replace function public.spc_current_role()
returns text language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else coalesce((
    select role from public.spc_user_roles where user_id = auth.uid() and active
  ), null) end;
$$;

-- Workspace writes are audited here. Full snapshots are created once daily by pg_cron.
create or replace function public.spc_save_workspace_unchecked(p_expected_version bigint, p_projects jsonb, p_catalog jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare new_version bigint; p jsonb; u jsonb; x jsonb; product jsonb;
begin
  update spc_workspaces set version=version+1, updated_at=now()
    where id='main' and version=p_expected_version returning version into new_version;
  if new_version is null then raise exception 'SPC_VERSION_CONFLICT' using errcode='40001'; end if;
  delete from spc_projects where workspace_id='main';
  delete from spc_products where workspace_id='main';
  for product in select * from jsonb_array_elements(coalesce(p_catalog,'[]'::jsonb)) loop
    insert into spc_products(id,workspace_id,data) values(product->>'id','main',product-'id');
  end loop;
  for p in select * from jsonb_array_elements(coalesce(p_projects,'[]'::jsonb)) loop
    insert into spc_projects(id,workspace_id,data) values(p->>'id','main',p-'id'-'units'-'products'-'journals');
    for product in select * from jsonb_array_elements(coalesce(p->'products','[]'::jsonb)) loop
      insert into spc_project_products(project_id,product_id) values(p->>'id',product->>'id') on conflict do nothing;
    end loop;
    for x in select * from jsonb_array_elements(coalesce(p->'journals','[]'::jsonb)) loop
      insert into spc_journals(id,project_id,data) values(x->>'id',p->>'id',x-'id');
    end loop;
    for u in select * from jsonb_array_elements(coalesce(p->'units','[]'::jsonb)) loop
      insert into spc_units(id,project_id,data) values(u->>'id',p->>'id',u-'id'-'surveys'-'works'-'defects'-'acceptances'-'events');
      for x in select * from jsonb_array_elements(coalesce(u->'surveys','[]'::jsonb)) loop insert into spc_surveys values(x->>'id',u->>'id',x-'id'); end loop;
      for x in select * from jsonb_array_elements(coalesce(u->'works','[]'::jsonb)) loop insert into spc_works values(x->>'id',u->>'id',x-'id'); end loop;
      for x in select * from jsonb_array_elements(coalesce(u->'defects','[]'::jsonb)) loop insert into spc_defects values(x->>'id',u->>'id',x-'id'); end loop;
      for x in select * from jsonb_array_elements(coalesce(u->'acceptances','[]'::jsonb)) loop insert into spc_acceptances values(x->>'id',u->>'id',x-'id'); end loop;
      for x in select * from jsonb_array_elements(coalesce(u->'events','[]'::jsonb)) loop insert into spc_events values(x->>'id',u->>'id',x-'id'); end loop;
    end loop;
  end loop;
  insert into spc_audit_logs(workspace_id,action,entity_type,detail)
    values('main','SAVE','workspace',jsonb_build_object('version',new_version,'role',public.spc_current_role()));
  return new_version;
end;
$$;

create or replace function public.spc_filter_units(p_units jsonb, p_role text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(case
    when p_role in ('client','sales') then
      (u - array['surveys','works','defects','acceptances','events','rate','pricedAt']) ||
      jsonb_build_object('surveys','[]'::jsonb,'works','[]'::jsonb,'defects','[]'::jsonb,
        'acceptances','[]'::jsonb,'events','[]'::jsonb)
    when p_role = 'crew' then
      u - array['owner','phone','email','lineId','customerRole','contactPreference','customerNeed',
        'marketingConsent','consentAt','customerSource']
    else u end), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_units,'[]'::jsonb)) u;
$$;

create or replace function public.spc_load_workspace()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r text := public.spc_current_role(); snapshot jsonb; filtered jsonb;
begin
  if r is null then raise exception 'SPC_ACCESS_REQUIRED' using errcode='42501'; end if;
  snapshot := public.spc_load_workspace_unchecked();
  if r in ('admin','shenyin') then return snapshot; end if;
  select coalesce(jsonb_agg(
    case when r = 'crew' then
      (p - array['contact','phone','journals']) || jsonb_build_object(
        'contact','', 'phone','', 'journals','[]'::jsonb,
        'units',public.spc_filter_units(p->'units',r))
    else
      (p - 'journals') || jsonb_build_object('journals','[]'::jsonb,
        'units',public.spc_filter_units(p->'units',r))
    end), '[]'::jsonb)
  into filtered from jsonb_array_elements(coalesce(snapshot->'projects','[]'::jsonb)) p;
  return snapshot || jsonb_build_object('projects',filtered);
end;
$$;

create or replace function public.spc_merge_restricted_projects(p_current jsonb, p_incoming jsonb, p_role text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare cp jsonb; ip jsonb; cu jsonb; iu jsonb; merged_units jsonb; merged_projects jsonb := '[]'::jsonb; merged_unit jsonb;
begin
  for cp in select * from jsonb_array_elements(coalesce(p_current,'[]'::jsonb)) loop
    select value into ip from jsonb_array_elements(coalesce(p_incoming,'[]'::jsonb)) value
      where value->>'id'=cp->>'id' limit 1;
    merged_units := '[]'::jsonb;
    for cu in select * from jsonb_array_elements(coalesce(cp->'units','[]'::jsonb)) loop
      iu := null;
      select value into iu from jsonb_array_elements(coalesce(ip->'units','[]'::jsonb)) value
        where value->>'id'=cu->>'id' limit 1;
      merged_unit := cu;
      if iu is not null and p_role in ('client','sales') then
        merged_unit := cu || jsonb_build_object(
          'building',coalesce(iu->'building',cu->'building'),'floor',coalesce(iu->'floor',cu->'floor'),
          'number',coalesce(iu->'number',cu->'number'),'owner',coalesce(iu->'owner',cu->'owner'),
          'phone',coalesce(iu->'phone',cu->'phone'),'email',coalesce(iu->'email',cu->'email'),
          'lineId',coalesce(iu->'lineId',cu->'lineId'),'customerRole',coalesce(iu->'customerRole',cu->'customerRole'),
          'contactPreference',coalesce(iu->'contactPreference',cu->'contactPreference'),
          'customerNeed',coalesce(iu->'customerNeed',cu->'customerNeed'),
          'marketingConsent',coalesce(iu->'marketingConsent',cu->'marketingConsent'),
          'consentAt',coalesce(iu->'consentAt',cu->'consentAt'),
          'customerSource',coalesce(iu->'customerSource',cu->'customerSource'),
          'order',coalesce(iu->'order',cu->'order'),'brand',coalesce(iu->'brand',cu->'brand'),
          'model',coalesce(iu->'model',cu->'model'),'colorNo',coalesce(iu->'colorNo',cu->'colorNo'),
          'spec',coalesce(iu->'spec',cu->'spec'),'estimated',coalesce(iu->'estimated',cu->'estimated'),
          'custom',coalesce(iu->'custom',cu->'custom'),'customNote',coalesce(iu->'customNote',cu->'customNote'),
          'note',coalesce(iu->'note',cu->'note'));
      elsif iu is not null and p_role = 'crew' then
        merged_unit := cu || jsonb_build_object(
          'status',coalesce(iu->'status',cu->'status'),'surveys',coalesce(iu->'surveys',cu->'surveys'),
          'defects',coalesce(iu->'defects',cu->'defects'),'acceptances',coalesce(iu->'acceptances',cu->'acceptances'),
          'events',coalesce(iu->'events',cu->'events'));
      end if;
      merged_units := merged_units || jsonb_build_array(merged_unit);
    end loop;
    merged_projects := merged_projects || jsonb_build_array(cp || jsonb_build_object('units',merged_units));
  end loop;
  return merged_projects;
end;
$$;

create or replace function public.spc_save_workspace(p_expected_version bigint, p_projects jsonb, p_catalog jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare r text := public.spc_current_role(); current_snapshot jsonb; safe_projects jsonb;
begin
  if r is null then raise exception 'SPC_ACCESS_REQUIRED' using errcode='42501'; end if;
  if r in ('admin','shenyin') then
    return public.spc_save_workspace_unchecked(p_expected_version,p_projects,p_catalog);
  end if;
  current_snapshot := public.spc_load_workspace_unchecked();
  safe_projects := public.spc_merge_restricted_projects(current_snapshot->'projects',p_projects,r);
  return public.spc_save_workspace_unchecked(p_expected_version,safe_projects,current_snapshot->'catalog');
end;
$$;

create or replace function public.spc_system_health()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.spc_has_full_access() then raise exception 'SPC_FULL_ACCESS_REQUIRED' using errcode='42501'; end if;
  return public.spc_system_health_unchecked();
end;
$$;

create or replace function public.spc_report_error(p_message text, p_source text default 'browser', p_detail jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.spc_can_access_workspace() then
    perform public.spc_report_error_unchecked(p_message,p_source,p_detail || jsonb_build_object('role',public.spc_current_role()));
  end if;
end;
$$;

drop policy if exists "SPC photos staff read" on storage.objects;
drop policy if exists "SPC photos staff insert" on storage.objects;
drop policy if exists "SPC photos staff update" on storage.objects;
drop policy if exists "SPC photos staff delete" on storage.objects;
drop policy if exists "SPC photos field read" on storage.objects;
drop policy if exists "SPC photos field insert" on storage.objects;
drop policy if exists "SPC photos field update" on storage.objects;
drop policy if exists "SPC photos field delete" on storage.objects;
create policy "SPC photos field read" on storage.objects for select to authenticated
using (bucket_id='spc-photos' and public.spc_current_role() in ('admin','shenyin','crew'));
create policy "SPC photos field insert" on storage.objects for insert to authenticated
with check (bucket_id='spc-photos' and (storage.foldername(name))[1]='spc' and public.spc_current_role() in ('admin','shenyin','crew'));
create policy "SPC photos field update" on storage.objects for update to authenticated
using (bucket_id='spc-photos' and public.spc_current_role() in ('admin','shenyin','crew'))
with check (bucket_id='spc-photos' and (storage.foldername(name))[1]='spc' and public.spc_current_role() in ('admin','shenyin','crew'));
create policy "SPC photos field delete" on storage.objects for delete to authenticated
using (bucket_id='spc-photos' and public.spc_current_role() in ('admin','shenyin','crew'));

revoke all on function public.spc_has_full_access(uuid) from public, anon;
revoke all on function public.spc_filter_units(jsonb,text) from public, anon, authenticated;
revoke all on function public.spc_merge_restricted_projects(jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function public.spc_has_full_access(uuid) to authenticated;
grant execute on function public.spc_load_workspace() to authenticated;
grant execute on function public.spc_save_workspace(bigint,jsonb,jsonb) to authenticated;
