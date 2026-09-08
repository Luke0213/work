-- Additive targeted write path for monthly receivable data. Review only until
-- explicitly deployed; this migration does not touch Storage or existing rows.

create or replace function public.spc_save_receivable_report(
  p_expected_version bigint,
  p_project_id text,
  p_year_month text,
  p_report jsonb,
  p_acceptance_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  approved_role text := public.spc_current_approved_role();
  owner_id text := auth.uid()::text;
  current_version bigint;
  new_version bigint;
  current_project_data jsonb;
  next_project_data jsonb;
  update_item jsonb;
  update_fields jsonb;
  current_acceptance jsonb;
  updated_acceptance jsonb;
  committed_fields jsonb;
  committed_updates jsonb := '[]'::jsonb;
  target_unit_id text;
  target_acceptance_id text;
  field_name text;
  acceptance_field_names text[] := array[
    'shipmentDateText', 'productText', 'unitDisplayText',
    'pingText', 'unitPriceText', 'noteText'
  ];
  report_field_names text[] := array[
    'deliveryContact', 'deliveryAddress', 'invoiceTrack', 'invoiceDate',
    'receivedAmount', 'receivedDate', 'preparedBy', 'paymentMethod',
    'deliveryDate', 'handler', 'supervisor', 'accounting', 'detailsByUnit'
  ];
begin
  if auth.uid() is null or approved_role not in ('admin', 'shenyin') then
    raise exception 'SPC_FINANCE_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if coalesce(btrim(p_project_id), '') = ''
    or p_year_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    or jsonb_typeof(p_report) is distinct from 'object'
    or jsonb_typeof(p_acceptance_updates) is distinct from 'array' then
    raise exception 'SPC_RECEIVABLE_INVALID' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_report) as key(value)
    where not (key.value = any(report_field_names))
  ) or exists (
    select 1 from jsonb_each(p_report - 'detailsByUnit') as item(key, value)
    where jsonb_typeof(item.value) is distinct from 'string'
  ) then
    raise exception 'SPC_RECEIVABLE_REPORT_FIELDS_INVALID' using errcode = '22023';
  end if;
  if p_report ? 'detailsByUnit' and (
    jsonb_typeof(p_report->'detailsByUnit') is distinct from 'object'
    or exists (
      select 1 from jsonb_each(p_report->'detailsByUnit') as detail(unit_key, value)
      where jsonb_typeof(detail.value) is distinct from 'object'
        or detail.value - 'sizeCm' <> '{}'::jsonb
        or (detail.value ? 'sizeCm' and jsonb_typeof(detail.value->'sizeCm') is distinct from 'string')
    )
  ) then
    raise exception 'SPC_RECEIVABLE_DETAILS_INVALID' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_acceptance_updates) as candidate(value)
    group by candidate.value->>'unitId', candidate.value->>'acceptanceId'
    having count(*) > 1
  ) then
    raise exception 'SPC_RECEIVABLE_DUPLICATE_TARGET' using errcode = '22023';
  end if;

  select version into current_version
  from public.spc_workspaces
  where id = 'main'
  for update;
  if current_version is null or current_version <> p_expected_version then
    raise exception 'SPC_VERSION_CONFLICT' using errcode = '40001';
  end if;

  select data into current_project_data
  from public.spc_projects
  where id = p_project_id and workspace_id = 'main'
  for update;
  if current_project_data is null or current_project_data->>'_deleted' = 'true' then
    raise exception 'SPC_PROJECT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if approved_role <> 'admin' and current_project_data->>'ownerUserId' is distinct from owner_id then
    raise exception 'SPC_PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if p_report ? 'detailsByUnit' and exists (
    select 1
    from jsonb_object_keys(p_report->'detailsByUnit') as detail(unit_id)
    left join public.spc_units unit
      on unit.id = detail.unit_id
      and unit.project_id = p_project_id
      and unit.data->>'_deleted' is distinct from 'true'
    where unit.id is null
  ) then
    raise exception 'SPC_RECEIVABLE_DETAIL_UNIT_NOT_FOUND' using errcode = 'P0002';
  end if;

  for update_item in select value from jsonb_array_elements(p_acceptance_updates)
  loop
    if jsonb_typeof(update_item) is distinct from 'object'
      or update_item - array['unitId', 'acceptanceId', 'fields'] <> '{}'::jsonb
      or coalesce(btrim(update_item->>'unitId'), '') = ''
      or coalesce(btrim(update_item->>'acceptanceId'), '') = ''
      or jsonb_typeof(update_item->'fields') is distinct from 'object'
      or exists (
        select 1 from jsonb_object_keys(update_item->'fields') as key(value)
        where not (key.value = any(acceptance_field_names))
      )
      or exists (
        select 1 from jsonb_each(update_item->'fields') as item(key, value)
        where jsonb_typeof(item.value) is distinct from 'string'
      ) then
      raise exception 'SPC_RECEIVABLE_ACCEPTANCE_FIELDS_INVALID' using errcode = '22023';
    end if;

    target_unit_id := update_item->>'unitId';
    target_acceptance_id := update_item->>'acceptanceId';
    update_fields := update_item->'fields';
    current_acceptance := null;
    select acceptance.data into current_acceptance
    from public.spc_acceptances acceptance
    join public.spc_units unit on unit.id = acceptance.unit_id
    where acceptance.id = target_acceptance_id
      and acceptance.unit_id = target_unit_id
      and unit.project_id = p_project_id
      and unit.data->>'_deleted' is distinct from 'true'
      and acceptance.data->>'_deleted' is distinct from 'true'
    for update of acceptance;
    if current_acceptance is null
      or current_acceptance->>'draft' = 'true'
      or current_acceptance->>'_deleted' = 'true' then
      raise exception 'SPC_ACCEPTANCE_NOT_FOUND' using errcode = 'P0002';
    end if;

    updated_acceptance := jsonb_set(
      current_acceptance,
      '{report}',
      case when jsonb_typeof(current_acceptance->'report') = 'object' then current_acceptance->'report' else '{}'::jsonb end || update_fields,
      true
    );
    update public.spc_acceptances set data = updated_acceptance where id = target_acceptance_id;

    committed_fields := '{}'::jsonb;
    for field_name in select jsonb_object_keys(update_fields)
    loop
      committed_fields := committed_fields || jsonb_build_object(field_name, updated_acceptance->'report'->field_name);
    end loop;
    committed_updates := committed_updates || jsonb_build_array(jsonb_build_object(
      'unitId', target_unit_id,
      'acceptanceId', target_acceptance_id,
      'fields', committed_fields
    ));
  end loop;

  next_project_data := jsonb_set(
    current_project_data,
    '{receivableReports}',
    case when jsonb_typeof(current_project_data->'receivableReports') = 'object'
      then current_project_data->'receivableReports' else '{}'::jsonb end
      || jsonb_build_object(p_year_month, p_report),
    true
  );
  update public.spc_projects set data = next_project_data, updated_at = now() where id = p_project_id;
  update public.spc_workspaces
  set version = current_version + 1, updated_at = now()
  where id = 'main' and version = current_version
  returning version into new_version;
  if new_version is null then
    raise exception 'SPC_VERSION_CONFLICT' using errcode = '40001';
  end if;

  insert into public.spc_audit_logs(workspace_id, action, entity_type, entity_id, detail)
  values ('main', 'UPDATE', 'receivable-report', p_project_id || ':' || p_year_month, jsonb_build_object(
    'version', new_version,
    'projectId', p_project_id,
    'yearMonth', p_year_month,
    'userId', auth.uid(),
    'acceptanceIds', (
      select coalesce(jsonb_agg(value->>'acceptanceId'), '[]'::jsonb)
      from jsonb_array_elements(committed_updates)
    )
  ));

  return jsonb_build_object(
    'version', new_version,
    'projectId', p_project_id,
    'yearMonth', p_year_month,
    'report', p_report,
    'acceptances', committed_updates
  );
end;
$$;

revoke all on function public.spc_save_receivable_report(bigint, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.spc_save_receivable_report(bigint, text, text, jsonb, jsonb) to authenticated;
