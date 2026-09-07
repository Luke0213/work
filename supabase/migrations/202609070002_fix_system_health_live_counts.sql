create or replace function public.spc_system_health()
returns jsonb language sql stable security definer set search_path=public,storage as $$
  select jsonb_build_object(
    'projects',(select count(*) from public.spc_projects where coalesce((data->>'_deleted')::boolean, false) = false),
    'units',(
      select count(*)
      from public.spc_units u
      join public.spc_projects p on p.id = u.project_id
      where coalesce((u.data->>'_deleted')::boolean, false) = false
      and coalesce((p.data->>'_deleted')::boolean, false) = false
    ),
    'errors24h',(select count(*) from public.spc_error_logs where created_at>now()-interval '24 hours'),
    'backups',(select count(*) from public.spc_backups),
    'latestBackup',(select max(created_at) from public.spc_backups),
    'storageFiles',(select count(*) from storage.objects where bucket_id='spc-photos'),
    'storageBytes',coalesce((select sum(coalesce((metadata->>'size')::bigint,0)) from storage.objects where bucket_id='spc-photos'),0)
  );
$$;
