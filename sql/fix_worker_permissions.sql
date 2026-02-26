-- Run in Supabase SQL editor.
-- Purpose: restore worker write permissions for operational tables.
-- Safe to run multiple times.

begin;

-- Ensure role constraint supports worker.
alter table public.user_profiles
  drop constraint if exists user_profiles_role_check;

alter table public.user_profiles
  add constraint user_profiles_role_check
  check (role in ('admin', 'worker', 'guest'));

-- Ensure helper functions exist and include workers.
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.user_profiles
  where id = auth.uid()
    and active = true;
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

-- Keep user profile visibility/admin-write policies correct.
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

-- Rebuild operational table policies so workers can write.
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
    execute format('drop policy if exists %I_modify_staff on public.%I;', table_name, table_name);
    execute format(
      'create policy %I_modify_staff on public.%I for all to authenticated using (public.can_write()) with check (public.can_write());',
      table_name,
      table_name
    );
  end loop;
end $$;

commit;

-- Verify after running:
-- select username, role, active from public.user_profiles order by username;
-- select policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename in ('lane_assignments','picktickets','shipment_pts') order by tablename, policyname;
