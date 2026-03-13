-- Run in Supabase SQL editor.
-- Purpose: detect and prevent multiple active shipments from sharing one staging lane.
-- Step 1 is read-only diagnostics.
-- Step 2 is the schema guardrail. Only run Step 2 after Step 1 returns zero rows.

-- ------------------------------------------------------------------
-- Step 1) Diagnostics: duplicate active staging lanes (must be zero rows)
-- ------------------------------------------------------------------
select
  btrim(s.staging_lane::text) as staging_lane,
  count(*) as active_shipment_count,
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
having count(*) > 1
order by active_shipment_count desc, staging_lane;

-- ------------------------------------------------------------------
-- Step 2) Schema guardrail: one active shipment per staging lane
-- Run only after diagnostics are clean.
-- ------------------------------------------------------------------
create unique index if not exists shipments_active_staging_lane_unique
on public.shipments ((btrim(staging_lane::text)))
where nullif(btrim(coalesce(staging_lane::text, '')), '') is not null
  and coalesce(archived, false) = false;
