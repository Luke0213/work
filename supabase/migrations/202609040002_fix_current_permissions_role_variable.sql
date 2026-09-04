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
  v_role text;
  configured public.spc_role_permissions%rowtype;
begin
  select user_role.role
  into v_role
  from public.spc_user_roles as user_role
  where user_role.user_id = auth.uid()
    and user_role.active
    and user_role.application_status = 'approved'
  limit 1;

  if v_role in ('admin', 'shenyin') then
    return query select true, true, true, true, true, true, true, true;
  elsif v_role in ('crew', 'client', 'sales') then
    select permission.*
    into configured
    from public.spc_role_permissions as permission
    where permission.role = v_role;

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
    elsif v_role = 'crew' then
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
