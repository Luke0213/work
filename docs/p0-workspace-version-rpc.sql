-- REVIEW ONLY. Not applied. No table/schema/data/storage mutations.
-- Required because no existing version-only RPC is defined in this checkout;
-- direct table access is revoked by the existing permission migrations.
begin;
create or replace function public.spc_workspace_version()
returns bigint language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or public.spc_current_approved_role() is null
    or public.spc_current_approved_role() not in ('admin','shenyin','crew','client','sales') then
    raise exception 'SPC_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  return (select version from public.spc_workspaces where id = 'main');
end;
$$;
revoke all on function public.spc_workspace_version() from public, anon;
grant execute on function public.spc_workspace_version() to authenticated;
commit;
