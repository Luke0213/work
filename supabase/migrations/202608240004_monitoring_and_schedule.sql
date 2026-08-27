create extension if not exists pg_cron with schema extensions;

create table if not exists public.spc_error_logs (
  id bigint generated always as identity primary key,
  message text not null,
  source text not null default 'browser',
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists spc_error_logs_time_idx on public.spc_error_logs(created_at desc);
alter table public.spc_error_logs enable row level security;

create or replace function public.spc_report_error(p_message text, p_source text default 'browser', p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path=public as $$
  insert into spc_error_logs(message,source,detail)
  values(left(p_message,1000),left(p_source,100),coalesce(p_detail,'{}'::jsonb));
$$;

create or replace function public.spc_system_health()
returns jsonb language sql stable security definer set search_path=public,storage as $$
  select jsonb_build_object(
    'projects',(select count(*) from public.spc_projects),
    'units',(select count(*) from public.spc_units),
    'errors24h',(select count(*) from public.spc_error_logs where created_at>now()-interval '24 hours'),
    'backups',(select count(*) from public.spc_backups),
    'latestBackup',(select max(created_at) from public.spc_backups),
    'storageFiles',(select count(*) from storage.objects where bucket_id='spc-photos'),
    'storageBytes',coalesce((select sum(coalesce((metadata->>'size')::bigint,0)) from storage.objects where bucket_id='spc-photos'),0)
  );
$$;

grant execute on function public.spc_report_error(text,text,jsonb) to anon,authenticated;
grant execute on function public.spc_system_health() to anon,authenticated;

do $$ begin
  if not exists(select 1 from cron.job where jobname='spc-daily-snapshot') then
    perform cron.schedule(
      'spc-daily-snapshot',
      '0 18 * * *',
      $job$insert into public.spc_backups(workspace_id,version,snapshot)
            select 'main',version,public.spc_load_workspace() from public.spc_workspaces where id='main';
            delete from public.spc_backups where id in
              (select id from public.spc_backups where workspace_id='main' order by created_at desc offset 30);$job$
    );
  end if;
end $$;
