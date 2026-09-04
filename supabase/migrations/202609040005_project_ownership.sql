-- Additive project ownership isolation. Existing projects are intentionally not backfilled.

create or replace function public.spc_create_project(p_project jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  approved_role text := public.spc_current_approved_role();
  owner_id text := auth.uid()::text;
  current_snapshot jsonb;
  current_projects jsonb;
  created_project jsonb;
  project_id text;
  new_version bigint;
begin
  if auth.uid() is null
    or approved_role is null
    or approved_role not in ('admin', 'shenyin', 'crew', 'client', 'sales') then
    raise exception 'SPC_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  if jsonb_typeof(p_project) is distinct from 'object' then
    raise exception 'SPC_PROJECT_INVALID' using errcode = '22023';
  end if;

  project_id := btrim(coalesce(p_project->>'id', ''));
  if project_id = '' then
    raise exception 'SPC_PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;

  perform 1 from public.spc_workspaces where id = 'main' for update;
  current_snapshot := public.spc_load_workspace_unchecked();
  current_projects := coalesce(current_snapshot->'projects', '[]'::jsonb);

  if exists (
    select 1
    from jsonb_array_elements(current_projects) as existing_project(value)
    where existing_project.value->>'id' = project_id
  ) then
    raise exception 'SPC_PROJECT_ID_EXISTS' using errcode = '23505';
  end if;

  created_project := (p_project - 'ownerUserId') || jsonb_build_object('ownerUserId', owner_id);
  new_version := public.spc_save_workspace_unchecked(
    (current_snapshot->>'version')::bigint,
    current_projects || jsonb_build_array(created_project),
    current_snapshot->'catalog'
  );
  perform public.spc_log_workspace_changes(
    current_snapshot,
    jsonb_build_object(
      'projects', current_projects || jsonb_build_array(created_project),
      'catalog', current_snapshot->'catalog'
    ),
    new_version
  );

  return jsonb_build_object('version', new_version, 'project', created_project);
end;
$$;

create or replace function public.spc_filter_permissioned_workspace(p_snapshot jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  approved_role text := public.spc_current_approved_role();
  owner_id text := auth.uid()::text;
  permissions record;
  source_project jsonb;
  filtered_project jsonb;
  source_unit jsonb;
  filtered_unit jsonb;
  filtered_units jsonb;
  filtered_projects jsonb := '[]'::jsonb;
begin
  if approved_role = 'admin' then
    return p_snapshot;
  end if;

  if auth.uid() is null
    or approved_role is null
    or approved_role not in ('shenyin', 'crew', 'client', 'sales') then
    raise exception 'SPC_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  if approved_role = 'shenyin' then
    select coalesce(jsonb_agg(value), '[]'::jsonb) into filtered_projects
    from jsonb_array_elements(coalesce(p_snapshot->'projects', '[]'::jsonb))
    where value->>'ownerUserId' = owner_id;
    return p_snapshot || jsonb_build_object('projects', filtered_projects);
  end if;

  select * into permissions from public.spc_current_effective_permissions();

  for source_project in
    select value
    from jsonb_array_elements(coalesce(p_snapshot->'projects', '[]'::jsonb))
    where value->>'ownerUserId' = owner_id
  loop
    filtered_project := source_project || jsonb_build_object(
      'journals', case
        when permissions.use_acceptance_journal then coalesce(source_project->'journals', '[]'::jsonb)
        else '[]'::jsonb
      end
    );

    if approved_role = 'crew' then
      filtered_project := filtered_project || jsonb_build_object('contact', '', 'phone', '');
    end if;

    filtered_units := '[]'::jsonb;
    for source_unit in
      select value from jsonb_array_elements(coalesce(source_project->'units', '[]'::jsonb))
    loop
      filtered_unit := source_unit || jsonb_build_object(
        'surveys', case when permissions.use_survey then coalesce(source_unit->'surveys', '[]'::jsonb) else '[]'::jsonb end,
        'works', case when permissions.use_work then coalesce(source_unit->'works', '[]'::jsonb) else '[]'::jsonb end,
        'acceptances', case when permissions.use_acceptance then coalesce(source_unit->'acceptances', '[]'::jsonb) else '[]'::jsonb end,
        'journals', case when permissions.use_acceptance_journal then coalesce(source_unit->'journals', '[]'::jsonb) else '[]'::jsonb end,
        'defects', case when permissions.use_defects then coalesce(source_unit->'defects', '[]'::jsonb) else '[]'::jsonb end,
        'events', '[]'::jsonb
      );

      if approved_role = 'crew' then
        filtered_unit := filtered_unit - array[
          'owner', 'phone', 'email', 'lineId', 'customerRole', 'contactPreference',
          'customerNeed', 'marketingConsent', 'consentAt', 'customerSource'
        ];
      end if;

      filtered_units := filtered_units || jsonb_build_array(filtered_unit);
    end loop;

    filtered_projects := filtered_projects || jsonb_build_array(
      filtered_project || jsonb_build_object('units', filtered_units)
    );
  end loop;

  return p_snapshot || jsonb_build_object('projects', filtered_projects);
end;
$$;

create or replace function public.spc_load_finance_export_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  approved_role text := public.spc_current_approved_role();
  owner_id text := auth.uid()::text;
  permissions record;
  can_export_receivables boolean := false;
  can_export_shipment_details boolean := false;
  snapshot jsonb;
  source_project jsonb;
  source_unit jsonb;
  source_work jsonb;
  source_acceptance jsonb;
  finance_projects jsonb := '[]'::jsonb;
  finance_units jsonb;
  finance_works jsonb;
  finance_acceptances jsonb;
  finance_report jsonb;
begin
  if auth.uid() is null
    or approved_role is null
    or approved_role not in ('admin', 'shenyin', 'crew', 'client', 'sales') then
    raise exception 'SPC_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select * into permissions from public.spc_current_effective_permissions();
  if approved_role in ('admin', 'shenyin') then
    can_export_receivables := true;
    can_export_shipment_details := true;
  else
    can_export_receivables := coalesce(permissions.export_receivables, false);
    can_export_shipment_details := coalesce(permissions.export_shipment_details, false);
  end if;

  if not can_export_receivables and not can_export_shipment_details then
    raise exception 'SPC_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  snapshot := public.spc_load_workspace_unchecked();
  for source_project in
    select value
    from jsonb_array_elements(coalesce(snapshot->'projects', '[]'::jsonb))
    where approved_role = 'admin' or value->>'ownerUserId' = owner_id
  loop
    finance_units := '[]'::jsonb;
    for source_unit in
      select value
      from jsonb_array_elements(coalesce(source_project->'units', '[]'::jsonb))
      where value->'_deleted' is distinct from 'true'::jsonb
    loop
      finance_works := '[]'::jsonb;
      for source_work in select value from jsonb_array_elements(coalesce(source_unit->'works', '[]'::jsonb))
      loop
        finance_works := finance_works || jsonb_build_array(jsonb_build_object(
          'date', source_work->'date', 'area', source_work->'area'
        ));
      end loop;

      finance_acceptances := '[]'::jsonb;
      for source_acceptance in select value from jsonb_array_elements(coalesce(source_unit->'acceptances', '[]'::jsonb))
      loop
        if can_export_shipment_details then
          finance_report := jsonb_build_object(
            'shipmentDateText', source_acceptance->'report'->'shipmentDateText',
            'sequenceText', source_acceptance->'report'->'sequenceText',
            'customerNameText', source_acceptance->'report'->'customerNameText',
            'productText', source_acceptance->'report'->'productText',
            'unitDisplayText', source_acceptance->'report'->'unitDisplayText',
            'squareMetersText', source_acceptance->'report'->'squareMetersText',
            'pingText', source_acceptance->'report'->'pingText',
            'unitPriceText', source_acceptance->'report'->'unitPriceText',
            'amountText', source_acceptance->'report'->'amountText',
            'vendorText', source_acceptance->'report'->'vendorText',
            'purchasePriceText', source_acceptance->'report'->'purchasePriceText',
            'noteText', source_acceptance->'report'->'noteText',
            'signedOriginal', source_acceptance->'report'->'signedOriginal',
            'signedCopy', source_acceptance->'report'->'signedCopy',
            'incomingVoOriginal', source_acceptance->'report'->'incomingVoOriginal',
            'incomingVoCopy', source_acceptance->'report'->'incomingVoCopy',
            'outgoingVoOriginal', source_acceptance->'report'->'outgoingVoOriginal',
            'outgoingVoCopy', source_acceptance->'report'->'outgoingVoCopy',
            'submitted', source_acceptance->'report'->'submitted',
            'vendorInvoice', source_acceptance->'report'->'vendorInvoice',
            'tier', source_acceptance->'report'->'tier',
            'payable', source_acceptance->'report'->'payable',
            'profitPercent', source_acceptance->'report'->'profitPercent',
            'profit', source_acceptance->'report'->'profit'
          );
        else
          finance_report := jsonb_build_object('noteText', source_acceptance->'report'->'noteText');
        end if;

        finance_acceptances := finance_acceptances || jsonb_build_array(jsonb_build_object(
          'id', source_acceptance->'id', 'date', source_acceptance->'date',
          'startedAt', source_acceptance->'startedAt', 'area', source_acceptance->'area',
          'note', source_acceptance->'note', 'draft', source_acceptance->'draft',
          'report', finance_report
        ));
      end loop;

      finance_units := finance_units || jsonb_build_array(jsonb_build_object(
        'id', source_unit->'id', 'building', source_unit->'building',
        'floor', source_unit->'floor', 'number', source_unit->'number',
        'model', source_unit->'model', 'colorNo', source_unit->'colorNo',
        'brand', source_unit->'brand', 'estimated', source_unit->'estimated',
        'rate', source_unit->'rate', 'note', source_unit->'note',
        'status', source_unit->'status', 'works', finance_works,
        'acceptances', finance_acceptances
      ));
    end loop;

    finance_projects := finance_projects || jsonb_build_array(jsonb_build_object(
      'id', source_project->'id', 'name', source_project->'name',
      'address', source_project->'address', 'contact', source_project->'contact',
      'units', finance_units
    ));
  end loop;

  return jsonb_build_object(
    'canExportReceivables', can_export_receivables,
    'canExportShipmentDetails', can_export_shipment_details,
    'projects', finance_projects
  );
end;
$$;

create or replace function public.spc_merge_workspace(
  p_base_version bigint,
  p_base_projects jsonb,
  p_projects jsonb,
  p_base_catalog jsonb,
  p_catalog jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  approved_role text := public.spc_current_approved_role();
  owner_id text := auth.uid()::text;
  current_snapshot jsonb;
  current_projects jsonb;
  current_owned jsonb := '[]'::jsonb;
  base_owned jsonb := '[]'::jsonb;
  incoming_owned jsonb := '[]'::jsonb;
  candidate_owned jsonb := '[]'::jsonb;
  merged_owned jsonb := '[]'::jsonb;
  merged_projects jsonb := '[]'::jsonb;
  merged_catalog jsonb;
  current_project jsonb;
  base_project jsonb;
  incoming_project jsonb;
  merged_project jsonb;
  new_version bigint;
begin
  if auth.uid() is null
    or approved_role is null
    or approved_role not in ('admin', 'shenyin', 'crew', 'client', 'sales') then
    raise exception 'SPC_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  perform 1 from public.spc_workspaces where id = 'main' for update;
  current_snapshot := public.spc_load_workspace_unchecked();
  current_projects := coalesce(current_snapshot->'projects', '[]'::jsonb);

  if approved_role = 'admin' then
    merged_projects := public.spc_json_merge_three_way(
      coalesce(p_base_projects, '[]'::jsonb),
      coalesce(p_projects, '[]'::jsonb),
      current_projects
    );
  else
    for current_project in select value from jsonb_array_elements(current_projects)
    loop
      if current_project->>'ownerUserId' = owner_id then
        current_owned := current_owned || jsonb_build_array(current_project);
        base_project := null;
        select value into base_project
        from jsonb_array_elements(coalesce(p_base_projects, '[]'::jsonb))
        where value->>'id' = current_project->>'id'
        limit 1;
        base_owned := base_owned || jsonb_build_array(
          case when base_project is null then current_project
          else (base_project - 'ownerUserId') || jsonb_build_object('ownerUserId', current_project->'ownerUserId') end
        );
        incoming_project := null;
        select value into incoming_project
        from jsonb_array_elements(coalesce(p_projects, '[]'::jsonb))
        where value->>'id' = current_project->>'id'
        limit 1;
        incoming_owned := incoming_owned || jsonb_build_array(
          case when incoming_project is null then current_project
          else (incoming_project - 'ownerUserId') || jsonb_build_object('ownerUserId', current_project->'ownerUserId') end
        );
      end if;
    end loop;

    candidate_owned := public.spc_json_merge_three_way(base_owned, incoming_owned, current_owned);
    merged_owned := public.spc_merge_permissioned_projects(current_owned, candidate_owned);
    for current_project in select value from jsonb_array_elements(current_projects)
    loop
      merged_project := null;
      if current_project->>'ownerUserId' = owner_id then
        select value into merged_project
        from jsonb_array_elements(merged_owned)
        where value->>'id' = current_project->>'id'
        limit 1;
      end if;
      merged_projects := merged_projects || jsonb_build_array(coalesce(merged_project, current_project));
    end loop;
  end if;

  if approved_role in ('crew', 'client', 'sales') then
    p_catalog := current_snapshot->'catalog';
    p_base_catalog := current_snapshot->'catalog';
  end if;
  merged_catalog := public.spc_json_merge_three_way(
    coalesce(p_base_catalog, '[]'::jsonb),
    coalesce(p_catalog, '[]'::jsonb),
    current_snapshot->'catalog'
  );

  new_version := public.spc_save_workspace_unchecked(
    (current_snapshot->>'version')::bigint, merged_projects, merged_catalog
  );
  perform public.spc_log_workspace_changes(
    current_snapshot,
    jsonb_build_object('projects', merged_projects, 'catalog', merged_catalog),
    new_version
  );
  return jsonb_build_object(
    'version', new_version,
    'merged', p_base_version <> (current_snapshot->>'version')::bigint
  );
end;
$$;

revoke all on function public.spc_create_project(jsonb) from public, anon;
grant execute on function public.spc_create_project(jsonb) to authenticated;
