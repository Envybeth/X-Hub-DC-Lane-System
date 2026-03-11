-- Run in Supabase SQL editor.
-- Purpose:
-- 1) Diagnose duplicate lane assignments (same lane_number + pt_id)
-- 2) Repair duplicates safely
-- 3) Add a DB-level uniqueness guardrail to prevent recurrence

-- ------------------------------------------------------------------
-- STEP 1: DIAGNOSTICS (read-only)
-- ------------------------------------------------------------------

-- A) Any duplicate lane assignment rows for the same lane/PT pair?
select
  la.lane_number,
  la.pt_id,
  count(*) as row_count,
  array_agg(la.id order by coalesce(la.order_position, 2147483647), la.id) as assignment_ids
from public.lane_assignments la
group by la.lane_number, la.pt_id
having count(*) > 1
order by row_count desc, la.lane_number, la.pt_id;

-- B) For active staging PTs, ensure only one assignment in staging lane and none outside it.
with staged_pts as (
  select distinct
    sp.pt_id,
    s.staging_lane::text as staging_lane
  from public.shipment_pts sp
  join public.shipments s on s.id = sp.shipment_id
  join public.picktickets p on p.id = sp.pt_id
  where sp.removed_from_staging = false
    and s.staging_lane is not null
    and coalesce(s.archived, false) = false
    and coalesce(p.status, '') in ('staged', 'ready_to_ship')
)
select
  sp.pt_id,
  sp.staging_lane,
  count(*) filter (where la.lane_number::text = sp.staging_lane) as in_staging_lane_rows,
  count(*) filter (where la.lane_number::text <> sp.staging_lane) as outside_staging_lane_rows
from staged_pts sp
left join public.lane_assignments la on la.pt_id = sp.pt_id
group by sp.pt_id, sp.staging_lane
having
  count(*) filter (where la.lane_number::text = sp.staging_lane) <> 1
  or count(*) filter (where la.lane_number::text <> sp.staging_lane) > 0
order by sp.pt_id;

-- C) Safety check for compiled pallets: duplicate lane/PT groups should never disagree
-- on compiled_pallet_id. If this returns rows, stop and inspect manually.
select
  la.lane_number,
  la.pt_id,
  count(*) as row_count,
  count(distinct la.compiled_pallet_id) filter (where la.compiled_pallet_id is not null) as distinct_compiled_ids,
  array_agg(distinct la.compiled_pallet_id) filter (where la.compiled_pallet_id is not null) as compiled_ids
from public.lane_assignments la
group by la.lane_number, la.pt_id
having count(*) > 1
   and count(distinct la.compiled_pallet_id) filter (where la.compiled_pallet_id is not null) > 1
order by la.lane_number, la.pt_id;

-- ------------------------------------------------------------------
-- STEP 2: REPAIR DUPLICATES
-- ------------------------------------------------------------------
-- Keeps one canonical row per (lane_number, pt_id), drops extras.
-- Canonical pallet_count is set to MAX(pallet_count) within that duplicate set.

begin;

-- Abort dedupe if compiled_pallet_id conflicts are present for same lane/PT duplicates.
do $$
declare
  v_conflict_count integer;
begin
  select count(*)
  into v_conflict_count
  from (
    select
      la.lane_number,
      la.pt_id
    from public.lane_assignments la
    group by la.lane_number, la.pt_id
    having count(*) > 1
       and count(distinct la.compiled_pallet_id) filter (where la.compiled_pallet_id is not null) > 1
  ) conflicts;

  if v_conflict_count > 0 then
    raise exception
      'Aborting dedupe: % duplicate lane/PT group(s) have conflicting compiled_pallet_id values. Inspect diagnostics first.',
      v_conflict_count;
  end if;
end $$;

with ranked as (
  select
    la.id,
    la.lane_number,
    la.pt_id,
    row_number() over (
      partition by la.lane_number, la.pt_id
      order by coalesce(la.order_position, 2147483647), la.id
    ) as row_rank,
    max(coalesce(la.pallet_count, 0)) over (
      partition by la.lane_number, la.pt_id
    ) as canonical_pallet_count,
    max(la.compiled_pallet_id) over (
      partition by la.lane_number, la.pt_id
    ) as canonical_compiled_pallet_id
  from public.lane_assignments la
),
updated_canonical as (
  update public.lane_assignments la
  set
    pallet_count = r.canonical_pallet_count,
    compiled_pallet_id = coalesce(r.canonical_compiled_pallet_id, la.compiled_pallet_id)
  from ranked r
  where la.id = r.id
    and r.row_rank = 1
  returning la.id
)
delete from public.lane_assignments la
using ranked r
where la.id = r.id
  and r.row_rank > 1;

commit;

-- Optional but recommended after duplicates are fixed:
-- run sql/fix_staged_pt_lane_assignment_drift.sql
-- to reconcile active staged PTs exactly onto the current staging lane.

-- ------------------------------------------------------------------
-- STEP 3: DB-LEVEL PREVENTION
-- ------------------------------------------------------------------
-- Prevents future duplicates for the same lane/PT pair.
-- IMPORTANT: this does NOT block PTs from being in multiple different lanes.
-- It only blocks duplicate rows for the SAME (lane_number, pt_id) pair.
-- NOTE: This will fail if duplicates still exist.

create unique index if not exists idx_lane_assignments_lane_pt_unique
  on public.lane_assignments (lane_number, pt_id);

-- Verification query for prevention index
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'lane_assignments'
  and indexname = 'idx_lane_assignments_lane_pt_unique';

-- Optional verification that multi-lane PTs are still supported and present.
select
  la.pt_id,
  count(distinct la.lane_number) as lane_count
from public.lane_assignments la
group by la.pt_id
having count(distinct la.lane_number) > 1
order by lane_count desc, la.pt_id;
