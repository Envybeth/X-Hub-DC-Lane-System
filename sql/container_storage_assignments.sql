create table if not exists public.container_storage_assignments (
  id bigint generated always as identity primary key,
  container_number text not null,
  customer text not null,
  lane_number text not null,
  active boolean not null default true,
  organized_to_label boolean not null default false,
  organized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (container_number, customer, lane_number)
);

create index if not exists idx_container_storage_assignments_active
  on public.container_storage_assignments (active);

create index if not exists idx_container_storage_assignments_lane
  on public.container_storage_assignments (lane_number)
  where active = true;

create index if not exists idx_container_storage_assignments_container
  on public.container_storage_assignments (container_number)
  where active = true;

create or replace function public.set_container_storage_assignments_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'trg_set_container_storage_assignments_updated_at'
      and tgrelid = 'public.container_storage_assignments'::regclass
  ) then
    create trigger trg_set_container_storage_assignments_updated_at
    before update on public.container_storage_assignments
    for each row
    execute function public.set_container_storage_assignments_updated_at();
  end if;
end;
$$;
