-- Durable logical deletion for projects and units. This migration only replaces
-- merge functions; it does not modify workspace rows or Storage objects.

create or replace function public.spc_json_merge_three_way_at(
  p_base jsonb,
  p_local jsonb,
  p_remote jsonb,
  p_path text
) returns jsonb language plpgsql immutable set search_path = public as $$
declare
  result jsonb;
  k text;
  item_id text;
  b jsonb;
  l jsonb;
  r jsonb;
  deleted_marker jsonb;
  ids text[];
  protected_collection boolean := p_path ~ '(^|\.)(projects|units|surveys|works|defects|acceptances|journals|events|floorAcceptances)$';
begin
  if protected_collection
     and jsonb_typeof(coalesce(p_base, '[]'::jsonb)) = 'array'
     and jsonb_typeof(coalesce(p_local, '[]'::jsonb)) = 'array'
     and jsonb_typeof(coalesce(p_remote, '[]'::jsonb)) = 'array'
     and not exists(
       select 1 from jsonb_array_elements(coalesce(p_base, '[]'::jsonb) || coalesce(p_local, '[]'::jsonb) || coalesce(p_remote, '[]'::jsonb)) x
       where jsonb_typeof(x) <> 'object' or not (x ? 'id')
     ) then
    result := '[]'::jsonb;
    select array_agg(distinct x->>'id' order by x->>'id') into ids
      from jsonb_array_elements(coalesce(p_local, '[]'::jsonb) || coalesce(p_remote, '[]'::jsonb) || coalesce(p_base, '[]'::jsonb)) x;
    foreach item_id in array coalesce(ids, array[]::text[]) loop
      select x into b from jsonb_array_elements(coalesce(p_base, '[]'::jsonb)) x where x->>'id' = item_id limit 1;
      select x into l from jsonb_array_elements(coalesce(p_local, '[]'::jsonb)) x where x->>'id' = item_id limit 1;
      select x into r from jsonb_array_elements(coalesce(p_remote, '[]'::jsonb)) x where x->>'id' = item_id limit 1;
      select marker into deleted_marker from (values (b), (l), (r)) candidate(marker)
        where coalesce(marker->>'_deleted', 'false') = 'true'
        order by coalesce(marker->>'deletedAt', '') desc limit 1;
      if deleted_marker is not null then
        result := result || jsonb_build_array(deleted_marker);
      else
        if l is not null and r is not null then
          result := result || jsonb_build_array(public.spc_json_merge_three_way_at(b, l, r, p_path));
        elsif l is not null then
          result := result || jsonb_build_array(l);
        elsif r is not null then
          result := result || jsonb_build_array(r);
        elsif b is not null then
          result := result || jsonb_build_array(b);
        end if;
      end if;
      b := null; l := null; r := null; deleted_marker := null;
    end loop;
    return result;
  end if;

  if jsonb_typeof(p_base) = 'object' and jsonb_typeof(p_local) = 'object' and jsonb_typeof(p_remote) = 'object' then
    result := '{}'::jsonb;
    for k in select distinct key from (
      select jsonb_object_keys(p_base) key union all select jsonb_object_keys(p_local) union all select jsonb_object_keys(p_remote)
    ) q loop
      if k not in ('projects', 'units', 'surveys', 'works', 'defects', 'acceptances', 'journals', 'events', 'floorAcceptances') then
        if not (p_local ? k) and (p_remote->k is not distinct from p_base->k) then continue; end if;
        if not (p_remote ? k) and (p_local->k is not distinct from p_base->k) then continue; end if;
      end if;
      result := result || jsonb_build_object(k, public.spc_json_merge_three_way_at(p_base->k, p_local->k, p_remote->k, case when p_path = '' then k else p_path || '.' || k end));
    end loop;
    return result;
  end if;

  if jsonb_typeof(p_base) = 'array' and jsonb_typeof(p_local) = 'array' and jsonb_typeof(p_remote) = 'array'
     and not exists(select 1 from jsonb_array_elements(p_base || p_local || p_remote) x where jsonb_typeof(x) <> 'object' or not (x ? 'id')) then
    result := '[]'::jsonb;
    select array_agg(distinct x->>'id' order by x->>'id') into ids from jsonb_array_elements(p_base || p_local || p_remote) x;
    foreach item_id in array coalesce(ids, array[]::text[]) loop
      select x into b from jsonb_array_elements(p_base) x where x->>'id' = item_id limit 1;
      select x into l from jsonb_array_elements(p_local) x where x->>'id' = item_id limit 1;
      select x into r from jsonb_array_elements(p_remote) x where x->>'id' = item_id limit 1;
      if l is null and r is not distinct from b then b := null; l := null; r := null;
      elsif r is null and l is not distinct from b then b := null; l := null; r := null;
      elsif l is null then l := r;
      elsif r is null then r := l;
      end if;
      if l is not null or r is not null then
        result := result || jsonb_build_array(public.spc_json_merge_three_way_at(b, l, r, p_path));
      end if;
      b := null; l := null; r := null;
    end loop;
    return result;
  end if;

  if p_local is not distinct from p_base then return p_remote; end if;
  if p_remote is not distinct from p_base then return p_local; end if;
  if p_local is not distinct from p_remote then return p_local; end if;
  return p_remote;
end;
$$;

revoke all on function public.spc_json_merge_three_way_at(jsonb, jsonb, jsonb, text) from public;
revoke all on function public.spc_json_merge_three_way_at(jsonb, jsonb, jsonb, text) from anon;

create or replace function public.spc_json_merge_three_way(p_base jsonb, p_local jsonb, p_remote jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select public.spc_json_merge_three_way_at(p_base, p_local, p_remote, '');
$$;
