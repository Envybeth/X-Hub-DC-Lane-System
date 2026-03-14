-- Run in Supabase SQL editor.
-- Read-only integrity audit for shipment/lane assignment consistency.
-- Goal: keep one source of truth and catch drift early.
--
-- Canonical model used by this audit:
-- 1) lane_assignments = lane/pallet placement truth (for non-compiled PTs)
-- 2) shipments + shipment_pts = staging membership truth
-- 3) picktickets.assigned_lane / actual_pallet_count / status are derived mirrors

-- ------------------------------------------------------------------
-- A) Duplicate lane assignment rows for same lane/PT (must be zero rows)
-- ------------------------------------------------------------------
select
  la.lane_number,
  la.pt_id,
  count(*) as row_count,
  array_agg(la.id order by coalesce(la.order_position, 2147483647), la.id) as assignment_ids
from public.lane_assignments la
group by la.lane_number, la.pt_id
having count(*) > 1
order by row_count desc, la.lane_number, la.pt_id;

-- ------------------------------------------------------------------
-- B) PTs marked staged/ready_to_ship but missing active shipment_pts mapping
-- ------------------------------------------------------------------
select
  p.id as pt_id,
  p.pt_number,
  p.pu_number,
  p.pu_date,
  p.status,
  p.assigned_lane
from public.picktickets p
where coalesce(p.status, '') in ('staged', 'ready_to_ship')
  and not exists (
    select 1
    from public.shipment_pts sp
    join public.shipments s on s.id = sp.shipment_id
    where sp.pt_id = p.id
      and sp.removed_from_staging = false
      and s.staging_lane is not null
      and coalesce(s.archived, false) = false
  )
order by p.id;

-- ------------------------------------------------------------------
-- C) Active shipment_pts rows whose PT status is not staged/ready_to_ship
-- ------------------------------------------------------------------
select
  sp.shipment_id,
  sp.pt_id,
  p.pt_number,
  p.status,
  s.pu_number,
  s.pu_date,
  s.staging_lane
from public.shipment_pts sp
join public.shipments s on s.id = sp.shipment_id
join public.picktickets p on p.id = sp.pt_id
where sp.removed_from_staging = false
  and s.staging_lane is not null
  and coalesce(s.archived, false) = false
  and coalesce(p.status, '') not in ('staged', 'ready_to_ship')
order by sp.shipment_id, sp.pt_id;

-- ------------------------------------------------------------------
-- D) Active staged PTs not physically assigned to shipment staging lane
-- ------------------------------------------------------------------
select
  sp.shipment_id,
  sp.pt_id,
  p.pt_number,
  p.assigned_lane as pt_assigned_lane,
  s.staging_lane as expected_staging_lane,
  p.status
from public.shipment_pts sp
join public.shipments s on s.id = sp.shipment_id
join public.picktickets p on p.id = sp.pt_id
where sp.removed_from_staging = false
  and s.staging_lane is not null
  and coalesce(s.archived, false) = false
  and coalesce(p.status, '') in ('staged', 'ready_to_ship')
  and btrim(coalesce(p.assigned_lane, '')) <> btrim(coalesce(s.staging_lane::text, ''))
order by sp.shipment_id, sp.pt_id;

-- ------------------------------------------------------------------
-- E) Non-compiled PT has assigned_lane but no lane_assignments row
-- (ignore shipped PTs because shipped flow intentionally clears assignments
--  while retaining assigned_lane/actual_pallet_count as historical context)
-- ------------------------------------------------------------------
select
  p.id as pt_id,
  p.pt_number,
  p.assigned_lane,
  p.actual_pallet_count,
  p.status
from public.picktickets p
where p.compiled_pallet_id is null
  and coalesce(p.status, '') <> 'shipped'
  and p.assigned_lane is not null
  and not exists (
    select 1
    from public.lane_assignments la
    where la.pt_id = p.id
  )
order by p.id;

-- ------------------------------------------------------------------
-- F) Non-compiled PT summary mismatch vs lane_assignments aggregate
-- ------------------------------------------------------------------
with assignment_agg as (
  select
    la.pt_id,
    sum(coalesce(la.pallet_count, 0))::integer as total_pallets
  from public.lane_assignments la
  group by la.pt_id
),
primary_lane as (
  select
    lane_rows.pt_id,
    lane_rows.lane_number
  from (
    select distinct
      la.pt_id,
      btrim(la.lane_number::text) as lane_number
    from public.lane_assignments la
  ) lane_rows
),
primary_lane_ranked as (
  select
    pl.pt_id,
    pl.lane_number,
    row_number() over (
      partition by pl.pt_id
      order by
        case when pl.lane_number ~ '^[0-9]+$' then 0 else 1 end,
        case when pl.lane_number ~ '^[0-9]+$' then pl.lane_number::numeric else null end,
        pl.lane_number
    ) as lane_rank
  from primary_lane pl
)
select
  p.id as pt_id,
  p.pt_number,
  p.assigned_lane as pt_assigned_lane,
  pr.lane_number as expected_assigned_lane,
  p.actual_pallet_count as pt_actual_pallets,
  aa.total_pallets as expected_pallets
from public.picktickets p
join assignment_agg aa on aa.pt_id = p.id
join primary_lane_ranked pr on pr.pt_id = p.id and pr.lane_rank = 1
where p.compiled_pallet_id is null
  and (
    coalesce(p.actual_pallet_count, -1) <> aa.total_pallets
    or btrim(coalesce(p.assigned_lane, '')) <> btrim(coalesce(pr.lane_number, ''))
  )
order by p.id;

-- ------------------------------------------------------------------
-- G) Active staging lanes shared by different PU load ids (must be zero rows)
-- ------------------------------------------------------------------
select
  btrim(s.staging_lane::text) as staging_lane,
  count(*) as active_shipment_row_count,
  count(distinct btrim(s.pu_number)) as distinct_load_id_count,
  array_agg(
    format(
      'shipment_id=%s | PU %s (%s) | status=%s',
      s.id,
      coalesce(nullif(btrim(s.pu_number), ''), 'N/A'),
      coalesce(s.pu_date::text, 'N/A'),
      coalesce(nullif(btrim(s.status), ''), 'unknown')
    )
    order by s.updated_at desc nulls last, s.id desc
  ) as active_shipments
from public.shipments s
where coalesce(s.archived, false) = false
  and nullif(btrim(coalesce(s.staging_lane::text, '')), '') is not null
group by btrim(s.staging_lane::text)
having count(distinct btrim(s.pu_number)) > 1
order by distinct_load_id_count desc, active_shipment_row_count desc, staging_lane;

-- ------------------------------------------------------------------
-- H) Active shipment rows duplicated for the same PU load id (must be zero rows)
-- ------------------------------------------------------------------
select
  btrim(s.pu_number) as pu_number,
  count(*) as active_shipment_row_count,
  array_agg(
    format(
      'shipment_id=%s | date=%s | lane=%s | status=%s',
      s.id,
      coalesce(s.pu_date::text, 'N/A'),
      coalesce(nullif(btrim(s.staging_lane::text), ''), 'N/A'),
      coalesce(nullif(btrim(s.status), ''), 'unknown')
    )
    order by s.updated_at desc nulls last, s.id desc
  ) as active_shipments
from public.shipments s
where coalesce(s.archived, false) = false
  and nullif(btrim(coalesce(s.pu_number, '')), '') is not null
group by btrim(s.pu_number)
having count(*) > 1
order by active_shipment_row_count desc, pu_number;
