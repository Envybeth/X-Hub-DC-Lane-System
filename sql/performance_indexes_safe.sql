-- Run in Supabase SQL editor.
-- Purpose: improve query speed for high-traffic reads without changing behavior.
-- Safe: adds indexes only (no table/row modifications).

create index if not exists idx_lane_assignments_lane_number
  on public.lane_assignments (lane_number);

create index if not exists idx_lane_assignments_pt_id
  on public.lane_assignments (pt_id);

create index if not exists idx_lane_assignments_lane_order_position_id
  on public.lane_assignments (lane_number, order_position, id);

create index if not exists idx_shipments_archived_staging_lane
  on public.shipments (archived, staging_lane);

create index if not exists idx_shipments_pu_number_pu_date
  on public.shipments (pu_number, pu_date);

create index if not exists idx_shipment_pts_shipment_id
  on public.shipment_pts (shipment_id);

create index if not exists idx_shipment_pts_pt_id
  on public.shipment_pts (pt_id);

create index if not exists idx_shipment_pts_active_shipment_pt
  on public.shipment_pts (shipment_id, pt_id)
  where removed_from_staging = false;

create index if not exists idx_picktickets_assigned_lane
  on public.picktickets (assigned_lane);

create index if not exists idx_picktickets_pu_number_pu_date
  on public.picktickets (pu_number, pu_date);

create index if not exists idx_picktickets_container_number
  on public.picktickets (container_number);

create index if not exists idx_picktickets_status
  on public.picktickets (status);

create index if not exists idx_container_storage_assignments_active_lane
  on public.container_storage_assignments (active, lane_number);

create index if not exists idx_container_storage_assignments_active_container
  on public.container_storage_assignments (active, container_number);

create index if not exists idx_compiled_pallet_pts_pt_id
  on public.compiled_pallet_pts (pt_id);
