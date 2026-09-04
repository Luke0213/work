create or replace function public.spc_admin_save_role_permissions(p_permissions jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  role_name text;
  permission_key text;
  permission_row jsonb;
  role_count bigint;
  permission_count bigint;
  allowed_roles constant text[] := array['crew', 'client', 'sales'];
  allowed_keys constant text[] := array[
    'editUnitMaster', 'useSurvey', 'useWork', 'useAcceptance',
    'useAcceptanceJournal', 'useDefects', 'exportReceivables', 'exportShipmentDetails'
  ];
begin
  if not exists (
    select 1
    from public.spc_user_roles as caller
    where caller.user_id = auth.uid()
      and caller.role = 'admin'
      and caller.active = true
      and caller.application_status = 'approved'
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select count(*)
  into role_count
  from jsonb_object_keys(p_permissions);

  if jsonb_typeof(p_permissions) <> 'object'
    or role_count <> 3
    or not p_permissions ?& allowed_roles then
    raise exception 'INVALID_PERMISSIONS';
  end if;

  foreach role_name in array allowed_roles loop
    permission_row := p_permissions -> role_name;

    select count(*)
    into permission_count
    from jsonb_object_keys(permission_row);

    if jsonb_typeof(permission_row) <> 'object'
      or permission_count <> 8
      or not permission_row ?& allowed_keys then
      raise exception 'INVALID_PERMISSIONS';
    end if;
    foreach permission_key in array allowed_keys loop
      if jsonb_typeof(permission_row -> permission_key) <> 'boolean' then
        raise exception 'INVALID_PERMISSIONS';
      end if;
    end loop;
  end loop;

  foreach role_name in array allowed_roles loop
    permission_row := p_permissions -> role_name;
    insert into public.spc_role_permissions (
      role, edit_unit_master, use_survey, use_work, use_acceptance,
      use_acceptance_journal, use_defects, export_receivables, export_shipment_details,
      updated_at, updated_by
    ) values (
      role_name,
      (permission_row ->> 'editUnitMaster')::boolean,
      (permission_row ->> 'useSurvey')::boolean,
      (permission_row ->> 'useWork')::boolean,
      (permission_row ->> 'useAcceptance')::boolean,
      (permission_row ->> 'useAcceptanceJournal')::boolean,
      (permission_row ->> 'useDefects')::boolean,
      (permission_row ->> 'exportReceivables')::boolean,
      (permission_row ->> 'exportShipmentDetails')::boolean,
      now(), auth.uid()
    )
    on conflict (role) do update set
      edit_unit_master = excluded.edit_unit_master,
      use_survey = excluded.use_survey,
      use_work = excluded.use_work,
      use_acceptance = excluded.use_acceptance,
      use_acceptance_journal = excluded.use_acceptance_journal,
      use_defects = excluded.use_defects,
      export_receivables = excluded.export_receivables,
      export_shipment_details = excluded.export_shipment_details,
      updated_at = now(),
      updated_by = auth.uid();
  end loop;
end;
$$;

revoke all on function public.spc_admin_save_role_permissions(jsonb) from public, anon, authenticated;
grant execute on function public.spc_admin_save_role_permissions(jsonb) to authenticated;
