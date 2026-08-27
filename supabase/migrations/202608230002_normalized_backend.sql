-- SPC normalized backend v2. Run after 202608230001_spc_app_state.sql.
create table if not exists public.spc_workspaces (
  id text primary key,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.spc_projects (
  id text primary key,
  workspace_id text not null references public.spc_workspaces(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.spc_products (
  id text primary key,
  workspace_id text not null references public.spc_workspaces(id) on delete cascade,
  data jsonb not null default '{}'::jsonb
);
create table if not exists public.spc_project_products (
  project_id text not null references public.spc_projects(id) on delete cascade,
  product_id text not null references public.spc_products(id) on delete cascade,
  primary key (project_id, product_id)
);
create table if not exists public.spc_units (
  id text primary key,
  project_id text not null references public.spc_projects(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists spc_units_project_idx on public.spc_units(project_id);
create table if not exists public.spc_surveys (
  id text primary key, unit_id text not null references public.spc_units(id) on delete cascade,
  data jsonb not null default '{}'::jsonb
);
create table if not exists public.spc_works (
  id text primary key, unit_id text not null references public.spc_units(id) on delete cascade,
  data jsonb not null default '{}'::jsonb
);
create table if not exists public.spc_defects (
  id text primary key, unit_id text not null references public.spc_units(id) on delete cascade,
  data jsonb not null default '{}'::jsonb
);
create table if not exists public.spc_acceptances (
  id text primary key, unit_id text not null references public.spc_units(id) on delete cascade,
  data jsonb not null default '{}'::jsonb
);
create table if not exists public.spc_events (
  id text primary key, unit_id text not null references public.spc_units(id) on delete cascade,
  data jsonb not null default '{}'::jsonb
);
create table if not exists public.spc_journals (
  id text primary key, project_id text not null references public.spc_projects(id) on delete cascade,
  data jsonb not null default '{}'::jsonb
);
create table if not exists public.spc_audit_logs (
  id bigint generated always as identity primary key,
  workspace_id text not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists spc_audit_time_idx on public.spc_audit_logs(workspace_id, created_at desc);
create table if not exists public.spc_backups (
  id bigint generated always as identity primary key,
  workspace_id text not null,
  version bigint not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists spc_backups_time_idx on public.spc_backups(workspace_id, created_at desc);

insert into public.spc_workspaces(id) values ('main') on conflict (id) do nothing;

create or replace function public.spc_load_workspace()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', w.version,
    'catalog', coalesce((select jsonb_agg(pr.data || jsonb_build_object('id', pr.id)) from spc_products pr where pr.workspace_id=w.id), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(
      p.data || jsonb_build_object(
        'id', p.id,
        'products', coalesce((select jsonb_agg(pr.data || jsonb_build_object('id',pr.id)) from spc_project_products pp join spc_products pr on pr.id=pp.product_id where pp.project_id=p.id), '[]'::jsonb),
        'journals', coalesce((select jsonb_agg(j.data || jsonb_build_object('id',j.id)) from spc_journals j where j.project_id=p.id), '[]'::jsonb),
        'units', coalesce((select jsonb_agg(
          u.data || jsonb_build_object(
            'id',u.id,
            'surveys',coalesce((select jsonb_agg(x.data || jsonb_build_object('id',x.id)) from spc_surveys x where x.unit_id=u.id),'[]'::jsonb),
            'works',coalesce((select jsonb_agg(x.data || jsonb_build_object('id',x.id)) from spc_works x where x.unit_id=u.id),'[]'::jsonb),
            'defects',coalesce((select jsonb_agg(x.data || jsonb_build_object('id',x.id)) from spc_defects x where x.unit_id=u.id),'[]'::jsonb),
            'acceptances',coalesce((select jsonb_agg(x.data || jsonb_build_object('id',x.id)) from spc_acceptances x where x.unit_id=u.id),'[]'::jsonb),
            'events',coalesce((select jsonb_agg(x.data || jsonb_build_object('id',x.id)) from spc_events x where x.unit_id=u.id),'[]'::jsonb)
          ) order by u.id) from spc_units u where u.project_id=p.id), '[]'::jsonb)
      ) order by p.id) from spc_projects p where p.workspace_id=w.id), '[]'::jsonb)
  ) from spc_workspaces w where w.id='main';
$$;

create or replace function public.spc_save_workspace(p_expected_version bigint, p_projects jsonb, p_catalog jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare new_version bigint; p jsonb; u jsonb; x jsonb; product jsonb;
begin
  if exists(select 1 from spc_projects where workspace_id='main') then
    insert into spc_backups(workspace_id,version,snapshot)
      select 'main',version,spc_load_workspace() from spc_workspaces where id='main';
    delete from spc_backups where id in (
      select id from spc_backups where workspace_id='main' order by created_at desc offset 30
    );
  end if;
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
  insert into spc_audit_logs(workspace_id,action,entity_type,detail) values('main','SAVE','workspace',jsonb_build_object('version',new_version));
  return new_version;
end;
$$;

alter table public.spc_workspaces enable row level security;
alter table public.spc_projects enable row level security;
alter table public.spc_products enable row level security;
alter table public.spc_project_products enable row level security;
alter table public.spc_units enable row level security;
alter table public.spc_surveys enable row level security;
alter table public.spc_works enable row level security;
alter table public.spc_defects enable row level security;
alter table public.spc_acceptances enable row level security;
alter table public.spc_events enable row level security;
alter table public.spc_journals enable row level security;
alter table public.spc_audit_logs enable row level security;
alter table public.spc_backups enable row level security;
grant execute on function public.spc_load_workspace() to anon, authenticated;
grant execute on function public.spc_save_workspace(bigint,jsonb,jsonb) to anon, authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('spc-photos','spc-photos',true,10485760,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=true,file_size_limit=10485760,allowed_mime_types=excluded.allowed_mime_types;
create policy "SPC photos public read" on storage.objects for select to anon,authenticated using(bucket_id='spc-photos');
create policy "SPC photos anonymous upload" on storage.objects for insert to anon,authenticated with check(bucket_id='spc-photos' and (storage.foldername(name))[1]='spc');
create policy "SPC photos anonymous update" on storage.objects for update to anon,authenticated using(bucket_id='spc-photos' and (storage.foldername(name))[1]='spc');
