-- Run in Supabase SQL editor.
-- Purpose: transactional stage/move helpers to reduce client-side multi-query race windows.
-- Safe: logic-equivalent writes wrapped in a single DB transaction per RPC call.

create or replace function public.stage_pickticket_into_shipment_lane(
  p_pu_number text,
  p_pu_date text,
  p_pt_id bigint,
  p_original_lane text default null
)
returns table (
  shipment_id bigint,
  staging_lane text,
  pt_status text,
  pallet_count integer
)
language plpgsql
set search_path = public
as $$
declare
  v_shipment_id bigint;
  v_shipment_status text;
  v_staging_lane text;
  v_pickticket_assigned_lane text;
  v_pickticket_pallet_count integer;
  v_pt_status text;
  v_deleted_pallet_sum integer := 0;
  v_insert_pallet_count integer := 0;
begin
  if p_pu_number is null or btrim(p_pu_number) = '' then
    raise exception 'PU number is required';
  end if;

  if p_pu_date is null or btrim(p_pu_date) = '' then
    raise exception 'PU date is required';
  end if;

  select
    s.id,
    s.status,
    btrim(s.staging_lane::text)
  into
    v_shipment_id,
    v_shipment_status,
    v_staging_lane
  from public.shipments s
  where s.pu_number = p_pu_number
    and s.pu_date::text = p_pu_date
  order by s.id desc
  limit 1
  for update;

  if v_shipment_id is null then
    raise exception 'Shipment not found for PU % / %', p_pu_number, p_pu_date;
  end if;

  if v_staging_lane is null or v_staging_lane = '' then
    raise exception 'Shipment has no staging lane';
  end if;

  select
    p.assigned_lane,
    coalesce(p.actual_pallet_count, 0)::integer
  into
    v_pickticket_assigned_lane,
    v_pickticket_pallet_count
  from public.picktickets p
  where p.id = p_pt_id
  for update;

  if not found then
    raise exception 'Pickticket % not found', p_pt_id;
  end if;

  with deleted_rows as (
    delete from public.lane_assignments la
    where la.pt_id = p_pt_id
    returning coalesce(la.pallet_count, 0)::integer as pallet_count
  )
  select coalesce(sum(deleted_rows.pallet_count), 0)::integer
  into v_deleted_pallet_sum
  from deleted_rows;

  update public.lane_assignments
  set order_position = coalesce(order_position, 0) + 1
  where lane_number::text = v_staging_lane;

  v_insert_pallet_count := greatest(
    coalesce(nullif(v_pickticket_pallet_count, 0), v_deleted_pallet_sum, 0),
    0
  );

  insert into public.lane_assignments (
    lane_number,
    pt_id,
    pallet_count,
    order_position
  )
  values (
    v_staging_lane,
    p_pt_id,
    v_insert_pallet_count,
    1
  );

  -- Avoid ambiguous variable/column resolution with RETURNS TABLE output names.
  -- (e.g. output variable "shipment_id" vs table column "shipment_id")
  update public.shipment_pts sp
  set
    original_lane = nullif(btrim(coalesce(p_original_lane, v_pickticket_assigned_lane)), ''),
    removed_from_staging = false
  where sp.shipment_id = v_shipment_id
    and sp.pt_id = p_pt_id;

  if not found then
    begin
      insert into public.shipment_pts (
        shipment_id,
        pt_id,
        original_lane,
        removed_from_staging
      )
      values (
        v_shipment_id,
        p_pt_id,
        nullif(btrim(coalesce(p_original_lane, v_pickticket_assigned_lane)), ''),
        false
      );
    exception
      when unique_violation then
        -- Concurrent stage call raced this insert; reconcile to desired state.
        update public.shipment_pts sp
        set
          original_lane = nullif(btrim(coalesce(p_original_lane, v_pickticket_assigned_lane)), ''),
          removed_from_staging = false
        where sp.shipment_id = v_shipment_id
          and sp.pt_id = p_pt_id;
    end;
  end if;

  v_pt_status := case
    when coalesce(v_shipment_status, '') = 'finalized' then 'ready_to_ship'
    else 'staged'
  end;

  update public.picktickets
  set
    assigned_lane = v_staging_lane,
    actual_pallet_count = v_insert_pallet_count,
    status = v_pt_status
  where id = p_pt_id;

  return query
  select
    v_shipment_id,
    v_staging_lane,
    v_pt_status,
    v_insert_pallet_count;
end;
$$;

create or replace function public.move_lane_assignment_transactional(
  p_assignment_id bigint,
  p_target_lane text
)
returns table (
  pt_id bigint,
  target_lane text,
  merged boolean,
  compiled_pallet_id bigint
)
language plpgsql
set search_path = public
as $$
declare
  v_target_lane text := btrim(coalesce(p_target_lane, ''));
  v_source_lane text;
  v_pt_id bigint;
  v_source_pallet_count integer;
  v_compiled_pallet_id bigint;
  v_merge_assignment_id bigint;
  v_merge_pallet_count integer;
  v_merged boolean := false;
  v_total_pallets integer := 0;
  v_primary_lane text;
begin
  if p_assignment_id is null then
    raise exception 'Assignment id is required';
  end if;

  if v_target_lane = '' then
    raise exception 'Target lane is required';
  end if;

  select
    la.lane_number::text,
    la.pt_id,
    coalesce(la.pallet_count, 0)::integer,
    la.compiled_pallet_id
  into
    v_source_lane,
    v_pt_id,
    v_source_pallet_count,
    v_compiled_pallet_id
  from public.lane_assignments la
  where la.id = p_assignment_id
  for update;

  if v_pt_id is null then
    raise exception 'Lane assignment % not found', p_assignment_id;
  end if;

  if btrim(coalesce(v_source_lane, '')) = v_target_lane then
    raise exception 'Already in target lane';
  end if;

  perform 1
  from public.lane_assignments la
  where la.lane_number::text = v_target_lane
  for update;

  if v_compiled_pallet_id is null then
    select
      la.id,
      coalesce(la.pallet_count, 0)::integer
    into
      v_merge_assignment_id,
      v_merge_pallet_count
    from public.lane_assignments la
    where la.lane_number::text = v_target_lane
      and la.pt_id = v_pt_id
      and la.compiled_pallet_id is null
    order by coalesce(la.order_position, 2147483647), la.id
    limit 1
    for update;
  end if;

  update public.lane_assignments
  set order_position = coalesce(order_position, 1) + 1
  where lane_number::text = v_target_lane
    and (v_merge_assignment_id is null or id <> v_merge_assignment_id);

  if v_merge_assignment_id is not null then
    update public.lane_assignments
    set
      pallet_count = coalesce(v_merge_pallet_count, 0) + coalesce(v_source_pallet_count, 0),
      order_position = 1
    where id = v_merge_assignment_id;

    delete from public.lane_assignments
    where id = p_assignment_id;

    v_merged := true;
  else
    update public.lane_assignments
    set
      lane_number = v_target_lane,
      order_position = 1
    where id = p_assignment_id;
  end if;

  if v_compiled_pallet_id is not null then
    update public.picktickets
    set assigned_lane = v_target_lane
    where id in (
      select cpp.pt_id
      from public.compiled_pallet_pts cpp
      where cpp.compiled_pallet_id = v_compiled_pallet_id
    );
  else
    select
      coalesce(sum(coalesce(la.pallet_count, 0)), 0)::integer
    into v_total_pallets
    from public.lane_assignments la
    where la.pt_id = v_pt_id;

    select lane_row.lane_number
    into v_primary_lane
    from (
      select distinct btrim(la.lane_number::text) as lane_number
      from public.lane_assignments la
      where la.pt_id = v_pt_id
    ) lane_row
    order by
      case when lane_row.lane_number ~ '^[0-9]+$' then 0 else 1 end,
      case when lane_row.lane_number ~ '^[0-9]+$' then lane_row.lane_number::numeric else null end,
      lane_row.lane_number
    limit 1;

    if v_primary_lane is null then
      update public.picktickets
      set
        assigned_lane = null,
        actual_pallet_count = null
      where id = v_pt_id;
    else
      update public.picktickets
      set
        assigned_lane = v_primary_lane,
        actual_pallet_count = v_total_pallets
      where id = v_pt_id;
    end if;
  end if;

  return query
  select
    v_pt_id,
    v_target_lane,
    v_merged,
    v_compiled_pallet_id;
end;
$$;
