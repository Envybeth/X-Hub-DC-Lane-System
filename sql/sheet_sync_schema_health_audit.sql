-- Run in Supabase SQL editor.
-- Read-only system health audit for the lane system schema + sheet-synced data.
--
-- Important:
-- 1) This does NOT compare against the live Google Sheet contents directly.
--    SQL in Supabase cannot verify the external sheet by itself.
-- 2) It DOES verify that the imported data is internally consistent with:
--    - the sheet sync contract in lib/googleSheets.ts
--    - shipment/staging truth
--    - compiled pallet truth
--    - storage / snapshot / schema guardrails
--
-- Healthy result:
-- Every section below should return zero rows.

-- ------------------------------------------------------------------
-- 1) Missing required public tables (must be zero rows)
-- ------------------------------------------------------------------
with required_tables(table_name) as (
  values
    ('compiled_pallet_pts'),
    ('compiled_pallets'),
    ('container_storage_assignments'),
    ('containers'),
    ('lane_assignments'),
    ('lanes'),
    ('picktickets'),
    ('shipment_pts'),
    ('shipments'),
    ('stale_shipment_snapshots')
)
select
  rt.table_name as missing_table
from required_tables rt
left join information_schema.tables t
  on t.table_schema = 'public'
 and t.table_name = rt.table_name
where t.table_name is null
order by rt.table_name;

-- ------------------------------------------------------------------
-- 2) Missing required columns used by the app/sync (must be zero rows)
-- ------------------------------------------------------------------
with required_columns(table_name, column_name) as (
  values
    ('picktickets', 'id'),
    ('picktickets', 'pt_number'),
    ('picktickets', 'po_number'),
    ('picktickets', 'customer'),
    ('picktickets', 'status'),
    ('picktickets', 'assigned_lane'),
    ('picktickets', 'actual_pallet_count'),
    ('picktickets', 'container_number'),
    ('picktickets', 'carrier'),
    ('picktickets', 'pu_number'),
    ('picktickets', 'pu_date'),
    ('picktickets', 'last_synced_at'),
    ('picktickets', 'compiled_pallet_id'),
    ('shipments', 'id'),
    ('shipments', 'pu_number'),
    ('shipments', 'pu_date'),
    ('shipments', 'staging_lane'),
    ('shipments', 'status'),
    ('shipments', 'carrier'),
    ('shipments', 'archived'),
    ('shipments', 'updated_at'),
    ('shipment_pts', 'shipment_id'),
    ('shipment_pts', 'pt_id'),
    ('shipment_pts', 'original_lane'),
    ('shipment_pts', 'removed_from_staging'),
    ('lane_assignments', 'id'),
    ('lane_assignments', 'lane_number'),
    ('lane_assignments', 'pt_id'),
    ('lane_assignments', 'pallet_count'),
    ('lane_assignments', 'order_position'),
    ('lane_assignments', 'compiled_pallet_id'),
    ('compiled_pallets', 'id'),
    ('compiled_pallets', 'compiled_pallet_count'),
    ('compiled_pallet_pts', 'compiled_pallet_id'),
    ('compiled_pallet_pts', 'pt_id'),
    ('compiled_pallet_pts', 'display_order'),
    ('containers', 'container_number'),
    ('container_storage_assignments', 'container_number'),
    ('container_storage_assignments', 'customer'),
    ('container_storage_assignments', 'lane_number'),
    ('container_storage_assignments', 'active'),
    ('stale_shipment_snapshots', 'pu_number'),
    ('stale_shipment_snapshots', 'pu_date'),
    ('stale_shipment_snapshots', 'snapshot'),
    ('lanes', 'lane_number')
)
select
  rc.table_name,
  rc.column_name as missing_column
from required_columns rc
left join information_schema.columns c
  on c.table_schema = 'public'
 and c.table_name = rc.table_name
 and c.column_name = rc.column_name
where c.column_name is null
order by rc.table_name, rc.column_name;

-- ------------------------------------------------------------------
-- 3) Missing required SQL functions / RPCs (must be zero rows)
-- ------------------------------------------------------------------
with required_functions(function_name) as (
  values
    ('move_lane_assignment_transactional'),
    ('plan_shipment_staging_sequence'),
    ('stage_assignment_into_shipment_transactional'),
    ('stage_pickticket_into_shipment_lane')
)
select
  rf.function_name as missing_function
from required_functions rf
left join pg_proc p
  on p.proname = rf.function_name
left join pg_namespace n
  on n.oid = p.pronamespace
 and n.nspname = 'public'
where n.nspname is null
order by rf.function_name;

-- ------------------------------------------------------------------
-- 4) Missing required named indexes / guardrails (must be zero rows)
-- ------------------------------------------------------------------
with required_indexes(index_name) as (
  values
    ('idx_container_storage_assignments_active_container'),
    ('idx_container_storage_assignments_active_lane'),
    ('idx_lane_assignments_lane_pt_unique'),
    ('idx_picktickets_pu_number_pu_date'),
    ('idx_shipment_pts_active_shipment_pt'),
    ('idx_shipments_pu_number_pu_date'),
    ('idx_stale_shipment_snapshots_pu_date'),
    ('shipments_active_staging_lane_unique')
)
select
  ri.index_name as missing_index
from required_indexes ri
left join pg_indexes i
  on i.schemaname = 'public'
 and i.indexname = ri.index_name
where i.indexname is null
order by ri.index_name;

-- ------------------------------------------------------------------
-- 5) Missing required unique business-key indexes/constraints (must be zero rows)
-- ------------------------------------------------------------------
with expected_unique(schema_name, table_name, column_names) as (
  values
    ('public'::text, 'containers'::text, array['container_number']::text[]),
    ('public'::text, 'picktickets'::text, array['pt_number', 'po_number']::text[]),
    ('public'::text, 'shipment_pts'::text, array['shipment_id', 'pt_id']::text[]),
    ('public'::text, 'stale_shipment_snapshots'::text, array['pu_number', 'pu_date']::text[])
)
select
  eu.table_name,
  eu.column_names as expected_unique_columns
from expected_unique eu
where not exists (
  select 1
  from pg_index i
  join pg_class c
    on c.oid = i.indrelid
  join pg_namespace n
    on n.oid = c.relnamespace
  cross join lateral (
    select array_agg(a.attname::text order by ord.ordinality)::text[] as indexed_columns
    from unnest(i.indkey) with ordinality ord(attnum, ordinality)
    join pg_attribute a
      on a.attrelid = c.oid
     and a.attnum = ord.attnum
  ) idx_cols
  where i.indisunique = true
    and n.nspname = eu.schema_name
    and c.relname = eu.table_name
    and idx_cols.indexed_columns = eu.column_names
)
order by eu.table_name;

-- ------------------------------------------------------------------
-- 6) Duplicate pickticket business keys from sheet sync (must be zero rows)
-- ------------------------------------------------------------------
select
  btrim(p.pt_number) as pt_number,
  btrim(p.po_number) as po_number,
  count(*) as row_count,
  array_agg(p.id order by p.id) as pt_ids
from public.picktickets p
where nullif(btrim(coalesce(p.pt_number, '')), '') is not null
  and nullif(btrim(coalesce(p.po_number, '')), '') is not null
group by btrim(p.pt_number), btrim(p.po_number)
having count(*) > 1
order by row_count desc, pt_number, po_number;

-- ------------------------------------------------------------------
-- 7) Non-PAPER PTs missing PT or PO business keys (must be zero rows)
-- ------------------------------------------------------------------
select
  p.id as pt_id,
  p.customer,
  p.pt_number,
  p.po_number,
  p.status
from public.picktickets p
where upper(coalesce(p.customer, '')) <> 'PAPER'
  and (
    nullif(btrim(coalesce(p.pt_number, '')), '') is null
    or nullif(btrim(coalesce(p.po_number, '')), '') is null
  )
order by p.id;

-- ------------------------------------------------------------------
-- 8) Non-PAPER PTs missing last_synced_at (must be zero rows)
-- ------------------------------------------------------------------
select
  p.id as pt_id,
  p.pt_number,
  p.po_number,
  p.customer,
  p.status
from public.picktickets p
where upper(coalesce(p.customer, '')) <> 'PAPER'
  and p.last_synced_at is null
order by p.id;

-- ------------------------------------------------------------------
-- 9) PTs operationally tied to shipment/staging with half-filled load identity
-- (must be zero rows)
-- Note: a PT that is simply unlabeled/labeled with no active shipment link may
-- legitimately have partial sheet load info. That is not treated as drift here.
-- ------------------------------------------------------------------
select
  p.id as pt_id,
  p.pt_number,
  p.po_number,
  p.pu_number,
  p.pu_date,
  p.status,
  sp.shipment_id,
  s.staging_lane
from public.picktickets p
left join public.shipment_pts sp
  on sp.pt_id = p.id
 and coalesce(sp.removed_from_staging, false) = false
left join public.shipments s
  on s.id = sp.shipment_id
 and coalesce(s.archived, false) = false
where upper(coalesce(p.customer, '')) <> 'PAPER'
  and (
    (nullif(btrim(coalesce(p.pu_number, '')), '') is null and p.pu_date is not null)
    or (nullif(btrim(coalesce(p.pu_number, '')), '') is not null and p.pu_date is null)
  )
  and (
    coalesce(p.status, '') in ('staged', 'ready_to_ship')
    or sp.shipment_id is not null
  )
order by p.id, sp.shipment_id nulls last;

-- ------------------------------------------------------------------
-- 10) PT rows with last_synced_at in the future (must be zero rows)
-- ------------------------------------------------------------------
select
  p.id as pt_id,
  p.pt_number,
  p.po_number,
  p.last_synced_at
from public.picktickets p
where p.last_synced_at is not null
  and p.last_synced_at > now()
order by p.last_synced_at desc, p.id;

-- ------------------------------------------------------------------
-- 11) PT container references missing a container row (must be zero rows)
-- ------------------------------------------------------------------
select
  p.id as pt_id,
  p.pt_number,
  p.po_number,
  p.container_number
from public.picktickets p
left join public.containers c
  on c.container_number = p.container_number
where nullif(btrim(coalesce(p.container_number, '')), '') is not null
  and c.container_number is null
order by p.id;

-- ------------------------------------------------------------------
-- 12) Duplicate container numbers (must be zero rows)
-- ------------------------------------------------------------------
select
  c.container_number,
  count(*) as row_count
from public.containers c
group by c.container_number
having count(*) > 1
order by row_count desc, c.container_number;

-- ------------------------------------------------------------------
-- 13) Active sheet loads with multiple carriers across member PTs (must be zero rows)
-- ------------------------------------------------------------------
select
  btrim(p.pu_number) as pu_number,
  p.pu_date,
  count(distinct btrim(p.carrier)) filter (
    where nullif(btrim(coalesce(p.carrier, '')), '') is not null
  ) as distinct_carrier_count,
  array_agg(distinct btrim(p.carrier) order by btrim(p.carrier)) filter (
    where nullif(btrim(coalesce(p.carrier, '')), '') is not null
  ) as carriers,
  count(*) as pt_count
from public.picktickets p
where upper(coalesce(p.customer, '')) <> 'PAPER'
  and nullif(btrim(coalesce(p.pu_number, '')), '') is not null
  and p.pu_date is not null
  and coalesce(p.status, '') <> 'shipped'
group by btrim(p.pu_number), p.pu_date
having count(distinct btrim(p.carrier)) filter (
         where nullif(btrim(coalesce(p.carrier, '')), '') is not null
       ) > 1
order by p.pu_date, pu_number;

-- ------------------------------------------------------------------
-- 14) Active shipment rows duplicated by PU load id (must be zero rows)
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

-- ------------------------------------------------------------------
-- 15) Shipment carrier mismatch vs PT carrier when the load has one clear carrier (must be zero rows)
-- ------------------------------------------------------------------
with load_carriers as (
  select
    btrim(p.pu_number) as pu_number,
    p.pu_date,
    array_agg(distinct btrim(p.carrier) order by btrim(p.carrier)) filter (
      where nullif(btrim(coalesce(p.carrier, '')), '') is not null
    ) as carriers
  from public.picktickets p
  where upper(coalesce(p.customer, '')) <> 'PAPER'
    and nullif(btrim(coalesce(p.pu_number, '')), '') is not null
    and p.pu_date is not null
    and coalesce(p.status, '') <> 'shipped'
  group by btrim(p.pu_number), p.pu_date
)
select
  s.id as shipment_id,
  s.pu_number,
  s.pu_date,
  s.carrier as shipment_carrier,
  lc.carriers as expected_carriers
from public.shipments s
join load_carriers lc
  on lc.pu_number = btrim(s.pu_number)
 and lc.pu_date = s.pu_date
where coalesce(s.archived, false) = false
  and coalesce(array_length(lc.carriers, 1), 0) = 1
  and btrim(coalesce(s.carrier, '')) is distinct from lc.carriers[1]
order by s.id;

-- ------------------------------------------------------------------
-- 16) Active shipment membership with PT load mismatch (must be zero rows)
-- ------------------------------------------------------------------
select
  sp.shipment_id,
  s.pu_number as shipment_pu_number,
  s.pu_date as shipment_pu_date,
  sp.pt_id,
  p.pt_number,
  p.po_number,
  p.pu_number as pt_pu_number,
  p.pu_date as pt_pu_date
from public.shipment_pts sp
join public.shipments s
  on s.id = sp.shipment_id
join public.picktickets p
  on p.id = sp.pt_id
where coalesce(sp.removed_from_staging, false) = false
  and coalesce(s.archived, false) = false
  and (
    btrim(coalesce(s.pu_number, '')) <> btrim(coalesce(p.pu_number, ''))
    or s.pu_date is distinct from p.pu_date
  )
order by sp.shipment_id, sp.pt_id;

-- ------------------------------------------------------------------
-- 17) Unresolved stale PT load conflicts in staging lanes (must be zero rows)
-- ------------------------------------------------------------------
select
  sp.shipment_id,
  s.pu_number as shipment_pu_number,
  s.pu_date as shipment_pu_date,
  s.staging_lane,
  sp.pt_id,
  p.pt_number,
  p.po_number,
  p.assigned_lane,
  p.status,
  p.pu_number as pt_pu_number,
  p.pu_date as pt_pu_date
from public.shipment_pts sp
join public.shipments s
  on s.id = sp.shipment_id
join public.picktickets p
  on p.id = sp.pt_id
where coalesce(sp.removed_from_staging, false) = true
  and coalesce(s.archived, false) = false
  and nullif(btrim(coalesce(s.staging_lane::text, '')), '') is not null
  and coalesce(p.status, '') <> 'shipped'
  and btrim(coalesce(p.assigned_lane::text, '')) = btrim(coalesce(s.staging_lane::text, ''))
  and (
    nullif(btrim(coalesce(p.pu_number, '')), '') is null
    or btrim(coalesce(p.pu_number, '')) <> btrim(coalesce(s.pu_number, ''))
    or p.pu_date is null
  )
order by sp.shipment_id, sp.pt_id;

-- ------------------------------------------------------------------
-- 18) Orphan active shipment rows with no PTs on that load and no shipment links (must be zero rows)
-- ------------------------------------------------------------------
select
  s.id as shipment_id,
  s.pu_number,
  s.pu_date,
  s.status,
  s.staging_lane
from public.shipments s
where coalesce(s.archived, false) = false
  and not exists (
    select 1
    from public.picktickets p
    where upper(coalesce(p.customer, '')) <> 'PAPER'
      and coalesce(p.status, '') <> 'shipped'
      and btrim(coalesce(p.pu_number, '')) = btrim(coalesce(s.pu_number, ''))
      and p.pu_date is not distinct from s.pu_date
  )
  and not exists (
    select 1
    from public.shipment_pts sp
    where sp.shipment_id = s.id
  )
order by s.id;

-- ------------------------------------------------------------------
-- 19) Duplicate lane assignment rows for same lane/PT (must be zero rows)
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
-- 20) PTs staged/ready_to_ship but missing active shipment mapping (must be zero rows)
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
    join public.shipments s
      on s.id = sp.shipment_id
    where sp.pt_id = p.id
      and coalesce(sp.removed_from_staging, false) = false
      and s.staging_lane is not null
      and coalesce(s.archived, false) = false
  )
order by p.id;

-- ------------------------------------------------------------------
-- 21) Active shipment links whose PT status is not staged/ready_to_ship (must be zero rows)
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
join public.shipments s
  on s.id = sp.shipment_id
join public.picktickets p
  on p.id = sp.pt_id
where coalesce(sp.removed_from_staging, false) = false
  and s.staging_lane is not null
  and coalesce(s.archived, false) = false
  and coalesce(p.status, '') not in ('staged', 'ready_to_ship')
order by sp.shipment_id, sp.pt_id;

-- ------------------------------------------------------------------
-- 22) Active staged PTs not physically assigned to shipment staging lane (must be zero rows)
-- ------------------------------------------------------------------
select
  sp.shipment_id,
  sp.pt_id,
  p.pt_number,
  p.assigned_lane as pt_assigned_lane,
  s.staging_lane as expected_staging_lane,
  p.status
from public.shipment_pts sp
join public.shipments s
  on s.id = sp.shipment_id
join public.picktickets p
  on p.id = sp.pt_id
where coalesce(sp.removed_from_staging, false) = false
  and s.staging_lane is not null
  and coalesce(s.archived, false) = false
  and coalesce(p.status, '') in ('staged', 'ready_to_ship')
  and btrim(coalesce(p.assigned_lane, '')) <> btrim(coalesce(s.staging_lane::text, ''))
order by sp.shipment_id, sp.pt_id;

-- ------------------------------------------------------------------
-- 23) Non-compiled PT has assigned lane but no lane assignment row (must be zero rows)
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
-- 24) Non-compiled PT summary mismatch vs lane assignment aggregate (must be zero rows)
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
join assignment_agg aa
  on aa.pt_id = p.id
join primary_lane_ranked pr
  on pr.pt_id = p.id
 and pr.lane_rank = 1
where p.compiled_pallet_id is null
  and (
    coalesce(p.actual_pallet_count, -1) <> aa.total_pallets
    or btrim(coalesce(p.assigned_lane, '')) <> btrim(coalesce(pr.lane_number, ''))
  )
order by p.id;

-- ------------------------------------------------------------------
-- 25) Active staging lanes shared by different PU load ids (must be zero rows)
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
-- 26) PTs linked to multiple compiled pallets (must be zero rows)
-- ------------------------------------------------------------------
select
  cpp.pt_id,
  count(distinct cpp.compiled_pallet_id) as compiled_pallet_count,
  array_agg(distinct cpp.compiled_pallet_id order by cpp.compiled_pallet_id) as compiled_pallet_ids
from public.compiled_pallet_pts cpp
group by cpp.pt_id
having count(distinct cpp.compiled_pallet_id) > 1
order by compiled_pallet_count desc, cpp.pt_id;

-- ------------------------------------------------------------------
-- 27) Duplicate compiled pallet member rows (must be zero rows)
-- ------------------------------------------------------------------
select
  cpp.compiled_pallet_id,
  cpp.pt_id,
  count(*) as row_count
from public.compiled_pallet_pts cpp
group by cpp.compiled_pallet_id, cpp.pt_id
having count(*) > 1
order by row_count desc, cpp.compiled_pallet_id, cpp.pt_id;

-- ------------------------------------------------------------------
-- 28) picktickets.compiled_pallet_id mismatch vs compiled_pallet_pts (must be zero rows)
-- ------------------------------------------------------------------
select
  p.id as pt_id,
  p.pt_number,
  p.compiled_pallet_id as pickticket_compiled_pallet_id,
  cpp.compiled_pallet_id as link_compiled_pallet_id
from public.picktickets p
full outer join public.compiled_pallet_pts cpp
  on cpp.pt_id = p.id
where coalesce(p.compiled_pallet_id, -1) <> coalesce(cpp.compiled_pallet_id, -1)
order by coalesce(p.id, cpp.pt_id);

-- ------------------------------------------------------------------
-- 29) Duplicate display_order inside one compiled pallet (must be zero rows)
-- ------------------------------------------------------------------
select
  cpp.compiled_pallet_id,
  cpp.display_order,
  count(*) as row_count,
  array_agg(cpp.pt_id order by cpp.pt_id) as pt_ids
from public.compiled_pallet_pts cpp
group by cpp.compiled_pallet_id, cpp.display_order
having count(*) > 1
order by cpp.compiled_pallet_id, cpp.display_order;

-- ------------------------------------------------------------------
-- 30) Compiled pallets spanning multiple active load keys (must be zero rows)
-- ------------------------------------------------------------------
select
  cpp.compiled_pallet_id,
  count(distinct concat_ws('|', btrim(coalesce(p.pu_number, '')), coalesce(p.pu_date::text, ''))) as load_key_count,
  array_agg(
    distinct format(
      'PT %s -> PU %s (%s)',
      coalesce(p.pt_number, p.id::text),
      coalesce(nullif(btrim(p.pu_number), ''), 'N/A'),
      coalesce(p.pu_date::text, 'N/A')
    )
    order by format(
      'PT %s -> PU %s (%s)',
      coalesce(p.pt_number, p.id::text),
      coalesce(nullif(btrim(p.pu_number), ''), 'N/A'),
      coalesce(p.pu_date::text, 'N/A')
    )
  ) as member_loads
from public.compiled_pallet_pts cpp
join public.picktickets p
  on p.id = cpp.pt_id
where coalesce(p.status, '') <> 'shipped'
group by cpp.compiled_pallet_id
having count(distinct concat_ws('|', btrim(coalesce(p.pu_number, '')), coalesce(p.pu_date::text, ''))) > 1
order by cpp.compiled_pallet_id;

-- ------------------------------------------------------------------
-- 31) Compiled pallets split across multiple assigned lanes or statuses (must be zero rows)
-- ------------------------------------------------------------------
select
  p.compiled_pallet_id,
  count(distinct btrim(coalesce(p.assigned_lane, ''))) as distinct_lane_count,
  count(distinct coalesce(p.status, '')) as distinct_status_count,
  array_agg(
    format(
      'PT %s | lane=%s | status=%s',
      coalesce(p.pt_number, p.id::text),
      coalesce(nullif(btrim(p.assigned_lane), ''), 'null'),
      coalesce(nullif(btrim(p.status), ''), 'null')
    )
    order by coalesce(p.pt_number, p.id::text)
  ) as member_state
from public.picktickets p
where p.compiled_pallet_id is not null
  and coalesce(p.status, '') <> 'shipped'
group by p.compiled_pallet_id
having count(distinct btrim(coalesce(p.assigned_lane, ''))) > 1
   or count(distinct coalesce(p.status, '')) > 1
order by p.compiled_pallet_id;

-- ------------------------------------------------------------------
-- 32) Half-staged compiled pallets (must be zero rows)
-- ------------------------------------------------------------------
with member_state as (
  select
    cpp.compiled_pallet_id,
    cpp.pt_id,
    p.pt_number,
    case
      when sp.shipment_id is not null
       and coalesce(sp.removed_from_staging, false) = false
       and s.staging_lane is not null
       and coalesce(s.archived, false) = false
       and coalesce(p.status, '') in ('staged', 'ready_to_ship')
      then true
      else false
    end as actively_staged
  from public.compiled_pallet_pts cpp
  join public.picktickets p
    on p.id = cpp.pt_id
  left join public.shipment_pts sp
    on sp.pt_id = cpp.pt_id
  left join public.shipments s
    on s.id = sp.shipment_id
)
select
  compiled_pallet_id,
  count(*) as member_count,
  count(*) filter (where actively_staged) as staged_member_count,
  array_agg(pt_number order by pt_number) filter (where actively_staged) as staged_pts,
  array_agg(pt_number order by pt_number) filter (where not actively_staged) as unstaged_pts
from member_state
group by compiled_pallet_id
having count(*) filter (where actively_staged) > 0
   and count(*) filter (where actively_staged) < count(*)
order by compiled_pallet_id;

-- ------------------------------------------------------------------
-- 33) Staged compiled pallets with representative-row drift (must be zero rows)
-- ------------------------------------------------------------------
with active_compiled_stage as (
  select distinct
    cpp.compiled_pallet_id,
    s.id as shipment_id,
    btrim(s.staging_lane::text) as staging_lane
  from public.shipment_pts sp
  join public.shipments s
    on s.id = sp.shipment_id
  join public.compiled_pallet_pts cpp
    on cpp.pt_id = sp.pt_id
  join public.picktickets p
    on p.id = sp.pt_id
  where coalesce(sp.removed_from_staging, false) = false
    and s.staging_lane is not null
    and coalesce(s.archived, false) = false
    and coalesce(p.status, '') in ('staged', 'ready_to_ship')
)
select
  acs.compiled_pallet_id,
  acs.shipment_id,
  acs.staging_lane,
  array_agg(distinct btrim(coalesce(la.lane_number::text, '')) order by btrim(coalesce(la.lane_number::text, '')))
    filter (where la.id is not null) as lanes_with_rows,
  count(*) filter (
    where btrim(coalesce(la.lane_number::text, '')) = acs.staging_lane
  ) as rows_in_staging_lane,
  count(*) filter (
    where la.id is not null
      and btrim(coalesce(la.lane_number::text, '')) <> acs.staging_lane
  ) as rows_outside_staging_lane,
  count(*) filter (
    where btrim(coalesce(la.lane_number::text, '')) = acs.staging_lane
      and la.compiled_pallet_id is distinct from acs.compiled_pallet_id
  ) as staging_rows_with_bad_compiled_marker
from active_compiled_stage acs
join public.compiled_pallet_pts cpp
  on cpp.compiled_pallet_id = acs.compiled_pallet_id
left join public.lane_assignments la
  on la.pt_id = cpp.pt_id
group by acs.compiled_pallet_id, acs.shipment_id, acs.staging_lane
having count(*) filter (
         where btrim(coalesce(la.lane_number::text, '')) = acs.staging_lane
       ) <> 1
    or count(*) filter (
         where la.id is not null
           and btrim(coalesce(la.lane_number::text, '')) <> acs.staging_lane
       ) > 0
    or count(*) filter (
         where btrim(coalesce(la.lane_number::text, '')) = acs.staging_lane
           and la.compiled_pallet_id is distinct from acs.compiled_pallet_id
       ) > 0
order by acs.compiled_pallet_id;

-- ------------------------------------------------------------------
-- 34) shipment_pts rows referencing missing shipment or PT (must be zero rows)
-- ------------------------------------------------------------------
select
  sp.shipment_id,
  sp.pt_id,
  s.id as resolved_shipment_id,
  p.id as resolved_pt_id
from public.shipment_pts sp
left join public.shipments s
  on s.id = sp.shipment_id
left join public.picktickets p
  on p.id = sp.pt_id
where s.id is null
   or p.id is null
order by sp.shipment_id, sp.pt_id;

-- ------------------------------------------------------------------
-- 35) lane_assignments rows referencing missing PT or lane (must be zero rows)
-- ------------------------------------------------------------------
select
  la.id as assignment_id,
  la.lane_number,
  la.pt_id,
  p.id as resolved_pt_id,
  l.lane_number as resolved_lane_number
from public.lane_assignments la
left join public.picktickets p
  on p.id = la.pt_id
left join public.lanes l
  on btrim(coalesce(l.lane_number::text, '')) = btrim(coalesce(la.lane_number::text, ''))
where p.id is null
   or l.lane_number is null
order by la.id;

-- ------------------------------------------------------------------
-- 36) compiled_pallet_pts rows referencing missing compiled pallet or PT (must be zero rows)
-- ------------------------------------------------------------------
select
  cpp.compiled_pallet_id,
  cpp.pt_id,
  cp.id as resolved_compiled_pallet_id,
  p.id as resolved_pt_id
from public.compiled_pallet_pts cpp
left join public.compiled_pallets cp
  on cp.id = cpp.compiled_pallet_id
left join public.picktickets p
  on p.id = cpp.pt_id
where cp.id is null
   or p.id is null
order by cpp.compiled_pallet_id, cpp.pt_id;

-- ------------------------------------------------------------------
-- 37) Active container storage rows referencing missing container or lane (must be zero rows)
-- ------------------------------------------------------------------
select
  csa.id,
  csa.container_number,
  csa.customer,
  csa.lane_number,
  c.container_number as resolved_container_number,
  l.lane_number as resolved_lane_number
from public.container_storage_assignments csa
left join public.containers c
  on c.container_number = csa.container_number
left join public.lanes l
  on btrim(coalesce(l.lane_number::text, '')) = btrim(coalesce(csa.lane_number::text, ''))
where coalesce(csa.active, false) = true
  and (
    c.container_number is null
    or l.lane_number is null
  )
order by csa.id;

-- ------------------------------------------------------------------
-- 38) Same container/customer has multiple active storage lanes (must be zero rows)
-- ------------------------------------------------------------------
select
  csa.container_number,
  csa.customer,
  count(*) as active_location_count,
  array_agg(btrim(csa.lane_number::text) order by btrim(csa.lane_number::text)) as active_lanes
from public.container_storage_assignments csa
where coalesce(csa.active, false) = true
group by csa.container_number, csa.customer
having count(*) > 1
order by active_location_count desc, csa.container_number, csa.customer;

-- ------------------------------------------------------------------
-- 39) Active container storage assigned onto active staging lanes (must be zero rows)
-- ------------------------------------------------------------------
select
  csa.id,
  csa.container_number,
  csa.customer,
  csa.lane_number,
  s.id as shipment_id,
  s.pu_number,
  s.pu_date
from public.container_storage_assignments csa
join public.shipments s
  on btrim(coalesce(s.staging_lane::text, '')) = btrim(coalesce(csa.lane_number::text, ''))
where coalesce(csa.active, false) = true
  and coalesce(s.archived, false) = false
order by csa.lane_number, csa.container_number, csa.customer;

-- ------------------------------------------------------------------
-- 40) Duplicate stale shipment snapshots by PU load (must be zero rows)
-- ------------------------------------------------------------------
select
  ss.pu_number,
  ss.pu_date,
  count(*) as row_count
from public.stale_shipment_snapshots ss
group by ss.pu_number, ss.pu_date
having count(*) > 1
order by row_count desc, ss.pu_number, ss.pu_date;
