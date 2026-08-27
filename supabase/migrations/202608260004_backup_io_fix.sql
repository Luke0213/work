-- Stop write-amplified snapshots and retain seven daily restore points.
-- Apply after 202608260003_collaborative_workspace.sql.

create or replace function public.spc_save_workspace_unchecked(p_expected_version bigint, p_projects jsonb, p_catalog jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare new_version bigint; p jsonb; u jsonb; x jsonb; product jsonb;
begin
  update spc_workspaces set version=version+1, updated_at=now()
    where id='main' and version=p_expected_version returning version into new_version;
  if new_version is null then raise exception 'SPC_VERSION_CONFLICT' using errcode='40001'; end if;
  delete from spc_projects where workspace_id='main';
  delete from spc_products where workspace_id='main';
  for product in select * from jsonb_array_elements(coalesce(p_catalog,'[]'::jsonb)) loop
    insert into spc_products(id,workspace_id,data) values(product->>'id','main',product-'id');
  end loop;
  for p in select * from jsonb_array_elements(coalesce(p_projects,'[]'::jsonb)) loop
    insert into spc_projects(id,workspace_id,data) values(p->>'id','main',p-'id'-'units'-'products'-'journals');
    for product in select * from jsonb_array_elements(coalesce(p->'products','[]'::jsonb)) loop
      insert into spc_project_products(project_id,product_id) values(p->>'id',product->>'id') on conflict do nothing;
    end loop;
    for x in select * from jsonb_array_elements(coalesce(p->'journals','[]'::jsonb)) loop
      insert into spc_journals(id,project_id,data) values(x->>'id',p->>'id',x-'id');
    end loop;
    for u in select * from jsonb_array_elements(coalesce(p->'units','[]'::jsonb)) loop
      insert into spc_units(id,project_id,data) values(u->>'id',p->>'id',u-'id'-'surveys'-'works'-'defects'-'acceptances'-'events');
      for x in select * from jsonb_array_elements(coalesce(u->'surveys','[]'::jsonb)) loop insert into spc_surveys values(x->>'id',u->>'id',x-'id'); end loop;
      for x in select * from jsonb_array_elements(coalesce(u->'works','[]'::jsonb)) loop insert into spc_works values(x->>'id',u->>'id',x-'id'); end loop;
      for x in select * from jsonb_array_elements(coalesce(u->'defects','[]'::jsonb)) loop insert into spc_defects values(x->>'id',u->>'id',x-'id'); end loop;
      for x in select * from jsonb_array_elements(coalesce(u->'acceptances','[]'::jsonb)) loop insert into spc_acceptances values(x->>'id',u->>'id',x-'id'); end loop;
      for x in select * from jsonb_array_elements(coalesce(u->'events','[]'::jsonb)) loop insert into spc_events values(x->>'id',u->>'id',x-'id'); end loop;
    end loop;
  end loop;
  insert into spc_audit_logs(workspace_id,action,entity_type,detail)
    values('main','SAVE','workspace',jsonb_build_object('version',new_version,'role',public.spc_current_role()));
  return new_version;
end;
$$;

do $$
declare existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname='spc-daily-snapshot';
  if existing_job is not null then perform cron.unschedule(existing_job); end if;
  perform cron.schedule(
    'spc-daily-snapshot',
    '0 18 * * *',
    $job$insert into public.spc_backups(workspace_id,version,snapshot)
          select 'main',version,public.spc_load_workspace() from public.spc_workspaces where id='main';
          delete from public.spc_backups where id in
            (select id from public.spc_backups where workspace_id='main' order by created_at desc offset 7);$job$
  );
end $$;

-- Keep the seven newest existing restore points. VACUUM FULL must be run separately.
delete from public.spc_backups
where id in (
  select id from public.spc_backups
  where workspace_id='main'
  order by created_at desc
  offset 7
);
