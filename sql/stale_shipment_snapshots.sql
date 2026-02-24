create table if not exists public.stale_shipment_snapshots (
  id bigint generated always as identity primary key,
  pu_number text not null,
  pu_date date not null,
  snapshot jsonb not null,
  stale_since timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pu_number, pu_date)
);

create index if not exists idx_stale_shipment_snapshots_pu_date
  on public.stale_shipment_snapshots (pu_date desc);

create or replace function public.set_stale_shipment_snapshots_updated_at()
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
    where tgname = 'trg_set_stale_shipment_snapshots_updated_at'
      and tgrelid = 'public.stale_shipment_snapshots'::regclass
  ) then
    create trigger trg_set_stale_shipment_snapshots_updated_at
    before update on public.stale_shipment_snapshots
    for each row
    execute function public.set_stale_shipment_snapshots_updated_at();
  end if;
end;
$$;
