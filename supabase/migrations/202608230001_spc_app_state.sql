create table if not exists public.spc_app_state (
  id text primary key,
  projects jsonb not null default '[]'::jsonb,
  catalog jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.spc_app_state enable row level security;

create policy "Anonymous users can read SPC data"
  on public.spc_app_state for select
  to anon, authenticated
  using (true);

create policy "Anonymous users can create SPC data"
  on public.spc_app_state for insert
  to anon, authenticated
  with check (id = 'main');

create policy "Anonymous users can update SPC data"
  on public.spc_app_state for update
  to anon, authenticated
  using (id = 'main')
  with check (id = 'main');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists spc_app_state_set_updated_at on public.spc_app_state;
create trigger spc_app_state_set_updated_at
before update on public.spc_app_state
for each row execute function public.set_updated_at();

grant select, insert, update on table public.spc_app_state to anon, authenticated;
