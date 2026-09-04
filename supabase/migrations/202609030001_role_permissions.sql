-- Additive role permission matrix. Apply only after manual review.

create table if not exists public.spc_role_permissions (
  role text primary key,
  edit_unit_master boolean not null,
  use_survey boolean not null,
  use_work boolean not null,
  use_acceptance boolean not null,
  use_acceptance_journal boolean not null,
  use_defects boolean not null,
  export_receivables boolean not null,
  export_shipment_details boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid null,
  constraint spc_role_permissions_role_check check (role in ('crew', 'client', 'sales'))
);

alter table public.spc_role_permissions enable row level security;

revoke all on table public.spc_role_permissions from public, anon, authenticated;

insert into public.spc_role_permissions (
  role, edit_unit_master, use_survey, use_work, use_acceptance,
  use_acceptance_journal, use_defects, export_receivables, export_shipment_details
) values
  ('crew', true, true, true, true, true, true, false, false),
  ('client', true, false, false, false, false, false, false, false),
  ('sales', true, false, false, false, false, false, false, false)
on conflict (role) do nothing;

create or replace function public.spc_current_permissions()
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
  current_role text;
  configured public.spc_role_permissions%rowtype;
begin
  select user_role.role
  into current_role
  from public.spc_user_roles as user_role
  where user_role.user_id = auth.uid()
    and user_role.active
    and user_role.application_status = 'approved'
  limit 1;

  if current_role in ('admin', 'shenyin') then
    return query select true, true, true, true, true, true, true, true;
  elsif current_role in ('crew', 'client', 'sales') then
    select permission.*
    into configured
    from public.spc_role_permissions as permission
    where permission.role = current_role;

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
    elsif current_role = 'crew' then
      return query select true, true, true, true, true, true, false, false;
    else
      return query select true, false, false, false, false, false, false, false;
    end if;
  else
    return query select false, false, false, false, false, false, false, false;
  end if;
end;
$$;

revoke all on function public.spc_current_permissions() from public, anon, authenticated;
grant execute on function public.spc_current_permissions() to authenticated;

create or replace function public.spc_current_account_profile()
returns table (
  display_name text,
  role text,
  active boolean,
  application_status text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  select
    coalesce(user_role.display_name, ''),
    user_role.role,
    coalesce(user_role.active, false),
    coalesce(user_role.application_status, 'unknown')
  from public.spc_user_roles as user_role
  where user_role.user_id = auth.uid()
  limit 1;

  if not found then
    return query select ''::text, null::text, false, 'unknown'::text;
  end if;
end;
$$;

revoke all on function public.spc_current_account_profile() from public, anon, authenticated;
grant execute on function public.spc_current_account_profile() to authenticated;

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

  if jsonb_typeof(p_permissions) <> 'object'
    or jsonb_object_length(p_permissions) <> 3
    or not p_permissions ?& allowed_roles then
    raise exception 'INVALID_PERMISSIONS';
  end if;

  foreach role_name in array allowed_roles loop
    permission_row := p_permissions -> role_name;
    if jsonb_typeof(permission_row) <> 'object'
      or jsonb_object_length(permission_row) <> 8
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
