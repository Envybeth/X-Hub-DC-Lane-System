-- Run this once in Supabase SQL Editor.
-- It creates account profiles, role helpers, and enables RLS:
-- - authenticated users: read access
-- - admin users: full write access

create extension if not exists citext;

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username citext not null unique,
  display_name text,
  role text not null check (role in ('admin', 'worker', 'guest')) default 'guest',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_user_profiles_username_unique
  on public.user_profiles (lower(username::text));

create or replace function public.set_user_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_set_user_profiles_updated_at on public.user_profiles;
create trigger trg_set_user_profiles_updated_at
before update on public.user_profiles
for each row
execute function public.set_user_profiles_updated_at();

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.user_profiles
  where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() = 'admin', false);
$$;

create or replace function public.can_write()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() in ('admin', 'worker'), false);
$$;

alter table public.user_profiles enable row level security;

drop policy if exists user_profiles_select_self_or_admin on public.user_profiles;
create policy user_profiles_select_self_or_admin
on public.user_profiles
for select
to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists user_profiles_write_admin on public.user_profiles;
create policy user_profiles_write_admin
on public.user_profiles
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

do $$
declare
  table_name text;
  table_names text[] := array[
    'compiled_pallet_pts',
    'compiled_pallets',
    'container_storage_assignments',
    'containers',
    'lane_assignments',
    'lanes',
    'picktickets',
    'print_history',
    'print_queue',
    'shipment_pts',
    'shipments',
    'stale_shipment_snapshots'
  ];
begin
  foreach table_name in array table_names
  loop
    execute format('alter table public.%I enable row level security;', table_name);

    execute format('drop policy if exists %I_select_authenticated on public.%I;', table_name, table_name);
    execute format(
      'create policy %I_select_authenticated on public.%I for select to authenticated using (true);',
      table_name,
      table_name
    );

    execute format('drop policy if exists %I_modify_admin on public.%I;', table_name, table_name);
    execute format(
      'create policy %I_modify_admin on public.%I for all to authenticated using (public.can_write()) with check (public.can_write());',
      table_name,
      table_name
    );
  end loop;
end $$;

-- Bootstrap your first admin account after creating a user in Authentication > Users:
-- insert into public.user_profiles (id, username, display_name, role, active)
-- values ('<auth_user_uuid>', 'your_username', 'Your Name', 'admin', true)
-- on conflict (id) do update set
--   username = excluded.username,
--   display_name = excluded.display_name,
--   role = excluded.role,
--   active = excluded.active;
