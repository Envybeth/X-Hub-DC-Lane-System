-- Run in Supabase SQL editor.
-- Creates a lightweight audit trail for data-changing actions on operational tables.
-- Note: this tracks INSERT/UPDATE/DELETE actions (not read-only page views).

create table if not exists public.user_action_logs (
  id bigserial primary key,
  user_id uuid null references public.user_profiles(id) on delete set null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  target_table text not null,
  target_id text,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_action_logs_created_at
  on public.user_action_logs (created_at desc);

create index if not exists idx_user_action_logs_user_id_created_at
  on public.user_action_logs (user_id, created_at desc);

create or replace function public.log_user_action()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  row_data jsonb;
  resolved_target_id text;
begin
  if tg_op = 'DELETE' then
    row_data := to_jsonb(old);
  else
    row_data := to_jsonb(new);
  end if;

  resolved_target_id := coalesce(
    row_data->>'id',
    row_data->>'pt_id',
    row_data->>'shipment_id',
    row_data->>'lane_number',
    row_data->>'container_number',
    row_data->>'pt_number'
  );

  insert into public.user_action_logs (
    user_id,
    action,
    target_table,
    target_id,
    details
  )
  values (
    actor_id,
    tg_op,
    tg_table_name,
    resolved_target_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'lane_number', row_data->>'lane_number',
        'pt_id', row_data->>'pt_id',
        'pt_number', row_data->>'pt_number',
        'shipment_id', row_data->>'shipment_id',
        'pu_number', row_data->>'pu_number',
        'container_number', row_data->>'container_number',
        'status', row_data->>'status'
      )
    )
  );

  -- Keep only the most recent 60 days of logs.
  delete from public.user_action_logs
  where created_at < now() - interval '60 days';

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

do $$
declare
  table_name text;
  trigger_name text;
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
    'stale_shipment_snapshots',
    'user_profiles'
  ];
begin
  foreach table_name in array table_names
  loop
    trigger_name := format('trg_log_%s_changes', table_name);
    execute format('drop trigger if exists %I on public.%I;', trigger_name, table_name);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.log_user_action();',
      trigger_name,
      table_name
    );
  end loop;
end $$;

alter table public.user_action_logs enable row level security;

drop policy if exists user_action_logs_select_admin on public.user_action_logs;
create policy user_action_logs_select_admin
on public.user_action_logs
for select
to authenticated
using (public.is_admin());

drop policy if exists user_action_logs_insert_self_or_system on public.user_action_logs;
create policy user_action_logs_insert_self_or_system
on public.user_action_logs
for insert
to authenticated
with check (user_id is null or user_id = auth.uid());
