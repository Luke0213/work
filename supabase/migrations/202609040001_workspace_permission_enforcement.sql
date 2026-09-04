-- Phase 5A-1: server-side authorization primitives for future workspace enforcement.
-- This migration is additive only. It does not replace workspace RPCs or mutate data.

create or replace function public.spc_current_approved_role()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select user_role.role
  from public.spc_user_roles as user_role
  where user_role.user_id = auth.uid()
    and user_role.active = true
    and user_role.application_status = 'approved'
    and user_role.role in ('admin', 'shenyin', 'crew', 'client', 'sales')
  limit 1;
$$;

create or replace function public.spc_current_effective_permissions()
returns table (
  edit_unit_master boolean,
  use_survey boolean,
  use_work boolean,
  use_acceptance boolean,
  use_acceptance_journal boolean,
  use_defects boolean,
  export_receivables boolean,
  export_shipment_details boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  approved_role text := public.spc_current_approved_role();
  configured public.spc_role_permissions%rowtype;
begin
  if approved_role in ('admin', 'shenyin') then
    return query select true, true, true, true, true, true, true, true;
  elsif approved_role in ('crew', 'client', 'sales') then
    select permission.*
    into configured
    from public.spc_role_permissions as permission
    where permission.role = approved_role;

    if found then
      return query select
        configured.edit_unit_master,
        configured.use_survey,
        configured.use_work,
        configured.use_acceptance,
        configured.use_acceptance_journal,
        configured.use_defects,
        configured.export_receivables,
        configured.export_shipment_details;
    elsif approved_role = 'crew' then
      return query select true, true, true, true, true, true, false, false;
    else
      return query select true, false, false, false, false, false, false, false;
    end if;
  else
    return query select false, false, false, false, false, false, false, false;
  end if;
end;
$$;

create or replace function public.spc_merge_permissioned_projects(
  p_current jsonb,
  p_incoming jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  approved_role text := public.spc_current_approved_role();
  permissions record;
  current_project jsonb;
  incoming_project jsonb;
  merged_project jsonb;
  current_unit jsonb;
  incoming_unit jsonb;
  merged_unit jsonb;
  merged_units jsonb;
  merged_projects jsonb := '[]'::jsonb;
  current_status text;
  incoming_status text;
  events_writable boolean;
  survey_changed boolean;
  work_changed boolean;
  acceptance_changed boolean;
  defects_changed boolean;
  atomic_defects jsonb;
  incoming_defect jsonb;
begin
  if approved_role in ('admin', 'shenyin') then
    return p_incoming;
  end if;

  if approved_role is null or approved_role not in ('crew', 'client', 'sales') then
    return p_current;
  end if;

  select * into permissions
  from public.spc_current_effective_permissions();

  events_writable := permissions.use_survey
    or permissions.use_work
    or permissions.use_acceptance
    or permissions.use_defects;

  -- Deliberately driven by current projects and current units. Incoming-only
  -- entities are never visited, and omitted entities are retained.
  for current_project in
    select value from jsonb_array_elements(coalesce(p_current, '[]'::jsonb))
  loop
    incoming_project := null;
    select value into incoming_project
    from jsonb_array_elements(coalesce(p_incoming, '[]'::jsonb))
    where value->>'id' = current_project->>'id'
    limit 1;

    merged_project := current_project;
    if permissions.use_acceptance_journal
      and incoming_project is not null
      and incoming_project ? 'journals' then
      merged_project := merged_project || jsonb_build_object(
        'journals', coalesce(incoming_project->'journals', current_project->'journals')
      );
    end if;

    merged_units := '[]'::jsonb;
    for current_unit in
      select value from jsonb_array_elements(coalesce(current_project->'units', '[]'::jsonb))
    loop
      incoming_unit := null;
      if incoming_project is not null then
        select value into incoming_unit
        from jsonb_array_elements(coalesce(incoming_project->'units', '[]'::jsonb))
        where value->>'id' = current_unit->>'id'
        limit 1;
      end if;

      merged_unit := current_unit;
      if incoming_unit is not null then
        survey_changed := incoming_unit ? 'surveys'
          and incoming_unit->'surveys' is distinct from current_unit->'surveys';
        work_changed := incoming_unit ? 'works'
          and incoming_unit->'works' is distinct from current_unit->'works';
        acceptance_changed := incoming_unit ? 'acceptances'
          and incoming_unit->'acceptances' is distinct from current_unit->'acceptances';
        defects_changed := incoming_unit ? 'defects'
          and incoming_unit->'defects' is distinct from current_unit->'defects';

        if permissions.edit_unit_master then
          merged_unit := merged_unit || jsonb_build_object(
            'building', coalesce(incoming_unit->'building', current_unit->'building'),
            'floor', coalesce(incoming_unit->'floor', current_unit->'floor'),
            'number', coalesce(incoming_unit->'number', current_unit->'number'),
            'order', coalesce(incoming_unit->'order', current_unit->'order'),
            'brand', coalesce(incoming_unit->'brand', current_unit->'brand'),
            'model', coalesce(incoming_unit->'model', current_unit->'model'),
            'colorNo', coalesce(incoming_unit->'colorNo', current_unit->'colorNo'),
            'spec', coalesce(incoming_unit->'spec', current_unit->'spec'),
            'estimated', coalesce(incoming_unit->'estimated', current_unit->'estimated'),
            'custom', coalesce(incoming_unit->'custom', current_unit->'custom'),
            'customNote', coalesce(incoming_unit->'customNote', current_unit->'customNote'),
            'note', coalesce(incoming_unit->'note', current_unit->'note')
          );

          if approved_role in ('client', 'sales') then
            merged_unit := merged_unit || jsonb_build_object(
              'owner', coalesce(incoming_unit->'owner', current_unit->'owner'),
              'phone', coalesce(incoming_unit->'phone', current_unit->'phone'),
              'email', coalesce(incoming_unit->'email', current_unit->'email'),
              'lineId', coalesce(incoming_unit->'lineId', current_unit->'lineId'),
              'customerRole', coalesce(incoming_unit->'customerRole', current_unit->'customerRole'),
              'contactPreference', coalesce(incoming_unit->'contactPreference', current_unit->'contactPreference'),
              'customerNeed', coalesce(incoming_unit->'customerNeed', current_unit->'customerNeed'),
              'marketingConsent', coalesce(incoming_unit->'marketingConsent', current_unit->'marketingConsent'),
              'consentAt', coalesce(incoming_unit->'consentAt', current_unit->'consentAt'),
              'customerSource', coalesce(incoming_unit->'customerSource', current_unit->'customerSource')
            );
          end if;
        end if;

        if permissions.use_survey then
          merged_unit := merged_unit || jsonb_build_object('surveys', coalesce(incoming_unit->'surveys', current_unit->'surveys'));
        end if;
        if permissions.use_work then
          merged_unit := merged_unit || jsonb_build_object('works', coalesce(incoming_unit->'works', current_unit->'works'));
        end if;
        if permissions.use_acceptance then
          merged_unit := merged_unit || jsonb_build_object('acceptances', coalesce(incoming_unit->'acceptances', current_unit->'acceptances'));
        end if;
        if permissions.use_acceptance_journal then
          merged_unit := merged_unit || jsonb_build_object('journals', coalesce(incoming_unit->'journals', current_unit->'journals'));
        end if;
        if permissions.use_defects then
          merged_unit := merged_unit || jsonb_build_object('defects', coalesce(incoming_unit->'defects', current_unit->'defects'));
        elsif (permissions.use_survey and survey_changed)
          or (permissions.use_acceptance and acceptance_changed) then
          atomic_defects := coalesce(current_unit->'defects', '[]'::jsonb);
          for incoming_defect in
            select value
            from jsonb_array_elements(coalesce(incoming_unit->'defects', '[]'::jsonb))
          loop
            if coalesce(incoming_defect->>'id', '') <> ''
              and (
                (permissions.use_survey and survey_changed and incoming_defect->>'source' = '場勘')
                or (permissions.use_acceptance and acceptance_changed and incoming_defect->>'source' = '驗收')
              )
              and not exists (
                select 1
                from jsonb_array_elements(atomic_defects) as existing_defect(value)
                where existing_defect.value->>'id' = incoming_defect->>'id'
              ) then
              atomic_defects := atomic_defects || jsonb_build_array(incoming_defect);
            end if;
          end loop;
          merged_unit := merged_unit || jsonb_build_object('defects', atomic_defects);
        end if;
        if events_writable then
          merged_unit := merged_unit || jsonb_build_object('events', coalesce(incoming_unit->'events', current_unit->'events'));
        end if;

        current_status := current_unit->>'status';
        incoming_status := incoming_unit->>'status';
        if incoming_status is not null and incoming_status <> current_status and (
          (permissions.use_survey and survey_changed
            and current_status in ('待場勘', '場勘待改善')
            and incoming_status in ('待場勘', '場勘待改善', '可進場'))
          or (permissions.use_work and work_changed
            and current_status in ('可進場', '施工中')
            and incoming_status in ('施工中', '待驗收'))
          or (permissions.use_acceptance and acceptance_changed
            and current_status in ('待驗收', '待複驗')
            and incoming_status in ('驗收缺失', '已驗收'))
          or (permissions.use_defects and defects_changed
            and current_status in ('場勘待改善', '驗收缺失', '改善中')
            and incoming_status in ('驗收缺失', '改善中', '待複驗', '可進場'))
        ) then
          merged_unit := merged_unit || jsonb_build_object('status', incoming_status);
        end if;
      end if;

      merged_units := merged_units || jsonb_build_array(merged_unit);
    end loop;

    merged_projects := merged_projects || jsonb_build_array(
      merged_project || jsonb_build_object('units', merged_units)
    );
  end loop;

  return merged_projects;
end;
$$;

create or replace function public.spc_filter_permissioned_workspace(
  p_snapshot jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  approved_role text := public.spc_current_approved_role();
  permissions record;
  source_project jsonb;
  filtered_project jsonb;
  source_unit jsonb;
  filtered_unit jsonb;
  filtered_units jsonb;
  filtered_projects jsonb := '[]'::jsonb;
begin
  if approved_role in ('admin', 'shenyin') then
    return p_snapshot;
  end if;

  if approved_role is null or approved_role not in ('crew', 'client', 'sales') then
    raise exception 'SPC_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select * into permissions
  from public.spc_current_effective_permissions();

  for source_project in
    select value from jsonb_array_elements(coalesce(p_snapshot->'projects', '[]'::jsonb))
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

    filtered_project := filtered_project || jsonb_build_object('units', filtered_units);
    filtered_projects := filtered_projects || jsonb_build_array(filtered_project);
  end loop;

  return p_snapshot || jsonb_build_object('projects', filtered_projects);
end;
$$;

create or replace function public.spc_load_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  approved_role text := public.spc_current_approved_role();
  snapshot jsonb;
begin
  if approved_role is null or approved_role not in ('admin', 'shenyin', 'crew', 'client', 'sales') then
    raise exception 'SPC_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  snapshot := public.spc_load_workspace_unchecked();
  return public.spc_filter_permissioned_workspace(snapshot);
end;
$$;

-- Phase 5C-1: finance exports receive a purpose-built, read-only DTO. Export
-- permissions intentionally do not participate in the normal workspace filter.
create or replace function public.spc_load_finance_export_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  approved_role text := public.spc_current_approved_role();
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
  if approved_role is null
    or approved_role not in ('admin', 'shenyin', 'crew', 'client', 'sales') then
    raise exception 'SPC_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select * into permissions
  from public.spc_current_effective_permissions();

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
    select value from jsonb_array_elements(coalesce(snapshot->'projects', '[]'::jsonb))
  loop
    finance_units := '[]'::jsonb;
    for source_unit in
      select value
      from jsonb_array_elements(coalesce(source_project->'units', '[]'::jsonb))
      where value->'_deleted' is distinct from 'true'::jsonb
    loop
      finance_works := '[]'::jsonb;
      for source_work in
        select value from jsonb_array_elements(coalesce(source_unit->'works', '[]'::jsonb))
      loop
        finance_works := finance_works || jsonb_build_array(jsonb_build_object(
          'date', source_work->'date',
          'area', source_work->'area'
        ));
      end loop;

      finance_acceptances := '[]'::jsonb;
      for source_acceptance in
        select value from jsonb_array_elements(coalesce(source_unit->'acceptances', '[]'::jsonb))
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
          finance_report := jsonb_build_object(
            'noteText', source_acceptance->'report'->'noteText'
          );
        end if;

        finance_acceptances := finance_acceptances || jsonb_build_array(jsonb_build_object(
          'id', source_acceptance->'id',
          'date', source_acceptance->'date',
          'startedAt', source_acceptance->'startedAt',
          'area', source_acceptance->'area',
          'note', source_acceptance->'note',
          'draft', source_acceptance->'draft',
          'report', finance_report
        ));
      end loop;

      finance_units := finance_units || jsonb_build_array(jsonb_build_object(
        'id', source_unit->'id',
        'building', source_unit->'building',
        'floor', source_unit->'floor',
        'number', source_unit->'number',
        'model', source_unit->'model',
        'colorNo', source_unit->'colorNo',
        'brand', source_unit->'brand',
        'estimated', source_unit->'estimated',
        'rate', source_unit->'rate',
        'note', source_unit->'note',
        'status', source_unit->'status',
        'works', finance_works,
        'acceptances', finance_acceptances
      ));
    end loop;

    finance_projects := finance_projects || jsonb_build_array(jsonb_build_object(
      'id', source_project->'id',
      'name', source_project->'name',
      'address', source_project->'address',
      'contact', source_project->'contact',
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
  current_snapshot jsonb;
  merged_projects jsonb;
  merged_catalog jsonb;
  new_version bigint;
begin
  if auth.uid() is null
    or approved_role is null
    or approved_role not in ('admin', 'shenyin', 'crew', 'client', 'sales') then
    raise exception 'SPC_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  perform 1
  from public.spc_workspaces
  where id = 'main'
  for update;

  current_snapshot := public.spc_load_workspace_unchecked();

  if approved_role not in ('admin', 'shenyin') then
    p_projects := public.spc_merge_permissioned_projects(
      current_snapshot->'projects',
      p_projects
    );
    p_base_projects := public.spc_merge_permissioned_projects(
      current_snapshot->'projects',
      p_base_projects
    );
    p_catalog := current_snapshot->'catalog';
    p_base_catalog := current_snapshot->'catalog';
  end if;

  merged_projects := public.spc_json_merge_three_way(
    coalesce(p_base_projects, '[]'::jsonb),
    coalesce(p_projects, '[]'::jsonb),
    current_snapshot->'projects'
  );
  merged_catalog := public.spc_json_merge_three_way(
    coalesce(p_base_catalog, '[]'::jsonb),
    coalesce(p_catalog, '[]'::jsonb),
    current_snapshot->'catalog'
  );

  new_version := public.spc_save_workspace_unchecked(
    (current_snapshot->>'version')::bigint,
    merged_projects,
    merged_catalog
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

-- Internal helpers: callable by owner/definer functions only, never by browser roles.
revoke all on function public.spc_current_approved_role() from public, anon, authenticated;
revoke all on function public.spc_current_effective_permissions() from public, anon, authenticated;
revoke all on function public.spc_merge_permissioned_projects(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.spc_filter_permissioned_workspace(jsonb) from public, anon, authenticated;

revoke all on function public.spc_load_workspace() from public, anon;
grant execute on function public.spc_load_workspace() to authenticated;
revoke all on function public.spc_load_finance_export_data() from public, anon;
grant execute on function public.spc_load_finance_export_data() to authenticated;
revoke all on function public.spc_merge_workspace(bigint, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.spc_merge_workspace(bigint, jsonb, jsonb, jsonb, jsonb) to authenticated;
