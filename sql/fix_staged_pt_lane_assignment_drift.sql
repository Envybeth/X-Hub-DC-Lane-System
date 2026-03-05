-- Run in Supabase SQL editor.
-- Purpose: repair staged PTs that still have lane_assignments outside their shipment staging lane.
-- Scope: only PTs currently in active staging flow (shipment_pts.removed_from_staging = false).

begin;

with staged_pts as (
  select distinct
    sp.pt_id,
    s.staging_lane::text as staging_lane,
    coalesce(p.actual_pallet_count, 0) as pallet_count
  from public.shipment_pts sp
  join public.shipments s
    on s.id = sp.shipment_id
  join public.picktickets p
    on p.id = sp.pt_id
  where sp.removed_from_staging = false
    and s.staging_lane is not null
    and coalesce(s.archived, false) = false
    and coalesce(p.status, '') in ('staged', 'ready_to_ship')
),
deleted_non_staging as (
  delete from public.lane_assignments la
  using staged_pts sp
  where la.pt_id = sp.pt_id
    and la.lane_number::text <> sp.staging_lane
  returning la.id
),
ranked_staging as (
  select
    la.id,
    la.pt_id,
    row_number() over (
      partition by la.pt_id
      order by coalesce(la.order_position, 2147483647), la.id
    ) as row_rank
  from public.lane_assignments la
  join staged_pts sp
    on sp.pt_id = la.pt_id
   and la.lane_number::text = sp.staging_lane
),
deleted_duplicate_staging as (
  delete from public.lane_assignments la
  using ranked_staging rs
  where la.id = rs.id
    and rs.row_rank > 1
  returning la.id
),
updated_staging as (
  update public.lane_assignments la
  set
    lane_number = sp.staging_lane,
    pallet_count = sp.pallet_count
  from staged_pts sp
  where la.pt_id = sp.pt_id
    and la.lane_number::text = sp.staging_lane
  returning la.id
)
insert into public.lane_assignments (lane_number, pt_id, pallet_count, order_position)
select
  sp.staging_lane,
  sp.pt_id,
  sp.pallet_count,
  1
from staged_pts sp
where not exists (
  select 1
  from public.lane_assignments la
  where la.pt_id = sp.pt_id
    and la.lane_number::text = sp.staging_lane
);

commit;
