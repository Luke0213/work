-- Self-service account applications. Applicants receive an Auth identity but
-- remain inactive until the SPC administrator approves the requested role.

alter table public.spc_user_roles
  add column if not exists application_status text not null default 'approved';

alter table public.spc_user_roles
  drop constraint if exists spc_user_roles_application_status_check;

alter table public.spc_user_roles
  add constraint spc_user_roles_application_status_check
  check (application_status in ('pending', 'approved', 'rejected'));

update public.spc_user_roles
set application_status = 'approved'
where application_status is distinct from 'approved' and active;

update public.spc_user_roles
set application_status = 'approved', active = true, updated_at = now()
where lower(email) = 'wongkinlun9527@gmail.com';
