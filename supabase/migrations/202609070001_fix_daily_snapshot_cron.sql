do $$
declare existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname='spc-daily-snapshot';
  if existing_job is not null then perform cron.unschedule(existing_job); end if;
  perform cron.schedule(
    'spc-daily-snapshot',
    '0 18 * * *',
    $job$insert into public.spc_backups(workspace_id,version,snapshot)
          select 'main',version,public.spc_load_workspace_unchecked() from public.spc_workspaces where id='main';
          delete from public.spc_backups where id in
            (select id from public.spc_backups where workspace_id='main' order by created_at desc offset 7);$job$
  );
end $$;
