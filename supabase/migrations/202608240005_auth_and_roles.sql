-- SPC authentication and strict two-role authorization.
-- New users are visitors by default. Promote the first trusted user manually.

create table if not exists public.spc_user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  display_name text not null default '',
  role text not null default 'visitor' check (role in ('admin', 'visitor')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.spc_user_roles enable row level security;

create or replace function public.spc_is_admin(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.spc_user_roles
    where user_id = p_user_id and role = 'admin' and active
  );
$$;

create or replace function public.spc_current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null then null
    else coalesce((
      select role from public.spc_user_roles
      where user_id = auth.uid() and active
    ), 'visitor')
  end;
$$;

create or replace function public.spc_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.spc_user_roles(user_id, email, display_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'name', ''),
    'visitor'
  )
  on conflict (user_id) do update
    set email = excluded.email, updated_at = now();
  return new;
end;
$$;

drop trigger if exists spc_auth_user_created on auth.users;
create trigger spc_auth_user_created
after insert or update of email on auth.users
for each row execute function public.spc_handle_new_user();

insert into public.spc_user_roles(user_id, email, display_name, role)
select id, coalesce(email, ''), coalesce(raw_user_meta_data ->> 'display_name', raw_user_meta_data ->> 'name', ''), 'visitor'
from auth.users
on conflict (user_id) do update set email = excluded.email, updated_at = now();

drop policy if exists "SPC admins can view roles" on public.spc_user_roles;
drop policy if exists "SPC admins can manage roles" on public.spc_user_roles;
create policy "SPC admins can view roles"
on public.spc_user_roles for select to authenticated
using (public.spc_is_admin());
create policy "SPC admins can manage roles"
on public.spc_user_roles for update to authenticated
using (public.spc_is_admin())
with check (public.spc_is_admin());

grant select, update on public.spc_user_roles to authenticated;
revoke all on public.spc_user_roles from anon;
revoke all on function public.spc_is_admin(uuid) from public, anon;
grant execute on function public.spc_is_admin(uuid) to authenticated;
revoke all on function public.spc_current_role() from public, anon;
grant execute on function public.spc_current_role() to authenticated;

create or replace function public.spc_require_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare request_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
begin
  -- Scheduled database jobs have no request JWT and remain allowed.
  if request_role in ('anon', 'authenticated') and not public.spc_is_admin() then
    raise exception 'SPC_ADMIN_REQUIRED' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.spc_require_admin() from public, anon, authenticated;

do $$
begin
  if to_regprocedure('public.spc_load_workspace_unchecked()') is null then
    alter function public.spc_load_workspace() rename to spc_load_workspace_unchecked;
  end if;
  if to_regprocedure('public.spc_save_workspace_unchecked(bigint,jsonb,jsonb)') is null then
    alter function public.spc_save_workspace(bigint,jsonb,jsonb) rename to spc_save_workspace_unchecked;
  end if;
  if to_regprocedure('public.spc_system_health_unchecked()') is null then
    alter function public.spc_system_health() rename to spc_system_health_unchecked;
  end if;
  if to_regprocedure('public.spc_report_error_unchecked(text,text,jsonb)') is null then
    alter function public.spc_report_error(text,text,jsonb) rename to spc_report_error_unchecked;
  end if;
end $$;

revoke all on function public.spc_load_workspace_unchecked() from public, anon, authenticated;
revoke all on function public.spc_save_workspace_unchecked(bigint,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.spc_system_health_unchecked() from public, anon, authenticated;
revoke all on function public.spc_report_error_unchecked(text,text,jsonb) from public, anon, authenticated;

create or replace function public.spc_load_workspace()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.spc_require_admin();
  return public.spc_load_workspace_unchecked();
end;
$$;

create or replace function public.spc_save_workspace(p_expected_version bigint, p_projects jsonb, p_catalog jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.spc_is_admin() then
    raise exception 'SPC_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return public.spc_save_workspace_unchecked(p_expected_version, p_projects, p_catalog);
end;
$$;

create or replace function public.spc_system_health()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.spc_require_admin();
  return public.spc_system_health_unchecked();
end;
$$;

create or replace function public.spc_report_error(p_message text, p_source text default 'browser', p_detail jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.spc_is_admin() then return; end if;
  perform public.spc_report_error_unchecked(p_message, p_source, p_detail);
end;
$$;

revoke all on function public.spc_load_workspace() from public, anon;
revoke all on function public.spc_save_workspace(bigint,jsonb,jsonb) from public, anon;
revoke all on function public.spc_system_health() from public, anon;
revoke all on function public.spc_report_error(text,text,jsonb) from public, anon;
grant execute on function public.spc_load_workspace() to authenticated;
grant execute on function public.spc_save_workspace(bigint,jsonb,jsonb) to authenticated;
grant execute on function public.spc_system_health() to authenticated;
grant execute on function public.spc_report_error(text,text,jsonb) to authenticated;

-- Remove the legacy public-state access path.
drop policy if exists "Anonymous users can read SPC data" on public.spc_app_state;
drop policy if exists "Anonymous users can create SPC data" on public.spc_app_state;
drop policy if exists "Anonymous users can update SPC data" on public.spc_app_state;
revoke all on public.spc_app_state from anon, authenticated;

-- Tables are accessed only through guarded RPCs.
revoke all on public.spc_workspaces, public.spc_projects, public.spc_products,
  public.spc_project_products, public.spc_units, public.spc_surveys, public.spc_works,
  public.spc_defects, public.spc_acceptances, public.spc_events, public.spc_journals,
  public.spc_audit_logs, public.spc_backups, public.spc_error_logs
from anon, authenticated;

-- Photos must not remain publicly retrievable. Admin sessions receive signed URLs.
update storage.buckets set public = false where id = 'spc-photos';
drop policy if exists "SPC photos public read" on storage.objects;
drop policy if exists "SPC photos anonymous upload" on storage.objects;
drop policy if exists "SPC photos anonymous update" on storage.objects;
drop policy if exists "SPC photos anonymous delete" on storage.objects;
drop policy if exists "SPC photos admin read" on storage.objects;
drop policy if exists "SPC photos admin insert" on storage.objects;
drop policy if exists "SPC photos admin update" on storage.objects;
drop policy if exists "SPC photos admin delete" on storage.objects;
create policy "SPC photos admin read" on storage.objects for select to authenticated
using (bucket_id = 'spc-photos' and public.spc_is_admin());
create policy "SPC photos admin insert" on storage.objects for insert to authenticated
with check (bucket_id = 'spc-photos' and (storage.foldername(name))[1] = 'spc' and public.spc_is_admin());
create policy "SPC photos admin update" on storage.objects for update to authenticated
using (bucket_id = 'spc-photos' and (storage.foldername(name))[1] = 'spc' and public.spc_is_admin())
with check (bucket_id = 'spc-photos' and (storage.foldername(name))[1] = 'spc' and public.spc_is_admin());
create policy "SPC photos admin delete" on storage.objects for delete to authenticated
using (bucket_id = 'spc-photos' and (storage.foldername(name))[1] = 'spc' and public.spc_is_admin());
