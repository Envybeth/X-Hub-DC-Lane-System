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

  if exists (
    select 1
    from public.shipment_pts sp
    join public.picktickets p
      on p.id = sp.pt_id
    where sp.shipment_id = v_shipment_id
      and coalesce(sp.removed_from_staging, false) = true
      and coalesce(p.status, '') <> 'shipped'
      and btrim(coalesce(p.assigned_lane::text, '')) = v_staging_lane
      and (
        nullif(btrim(coalesce(p.pu_number, '')), '') is null
        or p.pu_date is null
        or btrim(coalesce(p.pu_number, '')) <> btrim(p_pu_number)
        or p.pu_date::text <> p_pu_date
      )
  ) then
    raise exception 'Shipment has stale PT load conflict in staging lane; move the stale PT out before staging more';
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

  update public.shipments
  set updated_at = now()
  where id = v_shipment_id;

  return query
  select
    v_shipment_id,
    v_staging_lane,
    v_pt_status,
    v_insert_pallet_count;
end;
$$;

-- Generates a cross-shipment recommended staging sequence that minimizes depth and lane switching.
-- This is read-only planning logic (no writes).
create or replace function public.plan_shipment_staging_sequence(
  p_max_steps integer default 150,
  p_include_finalized boolean default false,
  p_depth_weight numeric default 1.0,
  p_due_date_weight numeric default 0.35,
  p_source_lane_switch_penalty numeric default 6.0,
  p_staging_lane_switch_penalty numeric default 3.0,
  p_source_lane_distance_weight numeric default 0.15,
  p_lane_batch_bonus numeric default 0.8,
  p_shipment_batch_bonus numeric default 0.25,
  p_max_candidates integer default 500
)
returns table (
  step_no integer,
  shipment_id bigint,
  pu_number text,
  pu_date text,
  staging_lane text,
  source_lane text,
  assignment_id bigint,
  representative_pt_id bigint,
  representative_pt_number text,
  representative_po_number text,
  move_type text,
  pending_member_count integer,
  pending_member_pt_ids bigint[],
  pallets_to_move integer,
  pallets_in_front integer,
  days_until_pu integer,
  base_score numeric,
  transition_score numeric,
  cumulative_score numeric
)
language plpgsql
set search_path = public
as $$
declare
  v_max_steps integer := greatest(1, least(coalesce(p_max_steps, 150), 2000));
  v_max_candidates integer := greatest(1, least(coalesce(p_max_candidates, 500), 4000));
begin
  return query
  with recursive
  active_load_keys as (
    select distinct
      btrim(p.pu_number) as pu_number,
      p.pu_date::text as pu_date
    from public.picktickets p
    where nullif(btrim(p.pu_number), '') is not null
      and p.pu_date is not null
      and coalesce(p.status, '') <> 'shipped'
  ),
  latest_shipment_rows as (
    select distinct on (btrim(s.pu_number), s.pu_date::text)
      s.id::bigint as shipment_id,
      btrim(s.pu_number) as pu_number,
      s.pu_date::text as pu_date,
      nullif(btrim(s.staging_lane::text), '') as staging_lane,
      coalesce(s.status, '') as shipment_status,
      coalesce(s.archived, false) as archived
    from public.shipments s
    where nullif(btrim(s.pu_number), '') is not null
      and s.pu_date is not null
    order by btrim(s.pu_number), s.pu_date::text, s.id desc
  ),
  active_shipments as (
    select
      coalesce(
        ls.shipment_id,
        -dense_rank() over (order by alk.pu_number, alk.pu_date)::bigint
      ) as shipment_id,
      alk.pu_number,
      alk.pu_date,
      ls.staging_lane,
      case
        when alk.pu_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then left(alk.pu_date, 10)::date
        else null
      end as pu_date_value
    from active_load_keys alk
    left join latest_shipment_rows ls
      on ls.pu_number = alk.pu_number
      and ls.pu_date = alk.pu_date
    where coalesce(ls.archived, false) = false
      and (
        p_include_finalized
        or coalesce(ls.shipment_status, '') <> 'finalized'
      )
  ),
  lane_rows as (
    select
      la.id::bigint as assignment_id,
      btrim(la.lane_number::text) as lane_number,
      la.pt_id::bigint as pt_id,
      la.compiled_pallet_id,
      coalesce(la.pallet_count, 0)::integer as pallet_count,
      coalesce(la.order_position, 2147483647) as order_position,
      coalesce(
        sum(coalesce(la.pallet_count, 0)) over (
          partition by btrim(la.lane_number::text)
          order by coalesce(la.order_position, 2147483647), la.id
          rows between unbounded preceding and 1 preceding
        ),
        0
      )::integer as pallets_in_front
    from public.lane_assignments la
    where nullif(btrim(la.lane_number::text), '') is not null
  ),
  non_compiled_rows as (
    select
      concat('pt:', p.id::text) as unit_key,
      'single_pt'::text as move_type,
      s.shipment_id,
      s.pu_number,
      s.pu_date,
      s.staging_lane,
      s.pu_date_value,
      lr.assignment_id,
      lr.pt_id as representative_pt_id,
      p.pt_number as representative_pt_number,
      p.po_number as representative_po_number,
      lr.lane_number as source_lane,
      lr.pallet_count as assignment_pallet_count,
      lr.pallets_in_front as assignment_pallets_in_front,
      lr.order_position,
      p.id::bigint as member_pt_id,
      case
        when sp.shipment_id is not null then true
        when btrim(coalesce(p.assigned_lane::text, '')) = s.staging_lane
          and coalesce(p.status, '') in ('staged', 'ready_to_ship') then true
        else false
      end as member_is_staged
    from active_shipments s
    join public.picktickets p
      on p.pu_number = s.pu_number
      and p.pu_date::text = s.pu_date
      and coalesce(p.status, '') <> 'shipped'
      and p.compiled_pallet_id is null
    join lane_rows lr
      on lr.pt_id = p.id
      and lr.compiled_pallet_id is null
    left join public.shipment_pts sp
      on sp.shipment_id = s.shipment_id
      and sp.pt_id = p.id
      and coalesce(sp.removed_from_staging, false) = false
  ),
  non_compiled_units as (
    select
      n.unit_key,
      n.move_type,
      n.shipment_id,
      n.pu_number,
      n.pu_date,
      n.staging_lane,
      n.pu_date_value,
      (array_agg(n.assignment_id order by n.assignment_pallets_in_front, n.order_position, n.assignment_id))[1] as assignment_id,
      n.representative_pt_id,
      max(n.representative_pt_number)::text as representative_pt_number,
      max(n.representative_po_number)::text as representative_po_number,
      (array_agg(n.source_lane order by n.assignment_pallets_in_front, n.order_position, n.assignment_id))[1] as source_lane,
      coalesce(sum(n.assignment_pallet_count), 0)::integer as pallets_to_move,
      coalesce(sum(n.assignment_pallets_in_front), 0)::integer as pallets_in_front,
      coalesce(count(distinct n.member_pt_id) filter (where not n.member_is_staged), 0)::integer as pending_member_count,
      array_agg(distinct n.member_pt_id order by n.member_pt_id) filter (where not n.member_is_staged) as pending_member_pt_ids
    from non_compiled_rows n
    group by
      n.unit_key,
      n.move_type,
      n.shipment_id,
      n.pu_number,
      n.pu_date,
      n.staging_lane,
      n.pu_date_value,
      n.representative_pt_id
    having coalesce(count(distinct n.member_pt_id) filter (where not n.member_is_staged), 0) > 0
  ),
  compiled_single_shipment as (
    select
      cpp.compiled_pallet_id,
      min(p.pu_number)::text as pu_number,
      min(p.pu_date::text) as pu_date
    from public.compiled_pallet_pts cpp
    join public.picktickets p
      on p.id = cpp.pt_id
    group by cpp.compiled_pallet_id
    having count(distinct concat_ws('|', p.pu_number, p.pu_date::text)) = 1
  ),
  compiled_rows as (
    select
      concat('cp:', lr.compiled_pallet_id::text) as unit_key,
      'compiled_group'::text as move_type,
      s.shipment_id,
      s.pu_number,
      s.pu_date,
      s.staging_lane,
      s.pu_date_value,
      lr.assignment_id,
      lr.pt_id as representative_pt_id,
      rep.pt_number as representative_pt_number,
      rep.po_number as representative_po_number,
      lr.lane_number as source_lane,
      lr.pallet_count as assignment_pallet_count,
      lr.pallets_in_front as assignment_pallets_in_front,
      cpp.pt_id::bigint as member_pt_id,
      case
        when sp.shipment_id is not null then true
        when btrim(coalesce(member_pt.assigned_lane::text, '')) = s.staging_lane
          and coalesce(member_pt.status, '') in ('staged', 'ready_to_ship') then true
        else false
      end as member_is_staged
    from lane_rows lr
    join compiled_single_shipment css
      on css.compiled_pallet_id = lr.compiled_pallet_id
    join active_shipments s
      on s.pu_number = css.pu_number
      and s.pu_date = css.pu_date
    join public.picktickets rep
      on rep.id = lr.pt_id
    join public.compiled_pallet_pts cpp
      on cpp.compiled_pallet_id = lr.compiled_pallet_id
    join public.picktickets member_pt
      on member_pt.id = cpp.pt_id
      and coalesce(member_pt.status, '') <> 'shipped'
    left join public.shipment_pts sp
      on sp.shipment_id = s.shipment_id
      and sp.pt_id = member_pt.id
      and coalesce(sp.removed_from_staging, false) = false
    where lr.compiled_pallet_id is not null
  ),
  compiled_units as (
    select
      c.unit_key,
      c.move_type,
      c.shipment_id,
      c.pu_number,
      c.pu_date,
      c.staging_lane,
      c.pu_date_value,
      max(c.assignment_id)::bigint as assignment_id,
      max(c.representative_pt_id)::bigint as representative_pt_id,
      max(c.representative_pt_number)::text as representative_pt_number,
      max(c.representative_po_number)::text as representative_po_number,
      max(c.source_lane)::text as source_lane,
      coalesce(max(c.assignment_pallet_count), 0)::integer as pallets_to_move,
      coalesce(max(c.assignment_pallets_in_front), 0)::integer as pallets_in_front,
      coalesce(count(distinct c.member_pt_id) filter (where not c.member_is_staged), 0)::integer as pending_member_count,
      array_agg(distinct c.member_pt_id order by c.member_pt_id) filter (where not c.member_is_staged) as pending_member_pt_ids
    from compiled_rows c
    group by
      c.unit_key,
      c.move_type,
      c.shipment_id,
      c.pu_number,
      c.pu_date,
      c.staging_lane,
      c.pu_date_value
    having coalesce(count(distinct c.member_pt_id) filter (where not c.member_is_staged), 0) > 0
  ),
  candidate_units as (
    select * from non_compiled_units
    union all
    select * from compiled_units
  ),
  candidate_with_counts as (
    select
      cu.*,
      count(*) over (partition by cu.source_lane)::integer as source_lane_candidate_count,
      count(*) over (partition by cu.shipment_id)::integer as shipment_candidate_count,
      case
        when cu.pu_date_value is null then 9999
        else (cu.pu_date_value - current_date)
      end::integer as days_until_pu,
      case
        when cu.source_lane ~ '^[0-9]+$' then cu.source_lane::numeric
        else null
      end as source_lane_num,
      case
        when cu.staging_lane ~ '^[0-9]+$' then cu.staging_lane::numeric
        else null
      end as staging_lane_num
    from candidate_units cu
  ),
  scored_candidates as (
    select
      cwc.*,
      (
        greatest(cwc.pallets_in_front, 0)::numeric * p_depth_weight
        + least(greatest(cwc.days_until_pu, -30), 180)::numeric * p_due_date_weight
        + case
            when cwc.source_lane_num is not null and cwc.staging_lane_num is not null then
              abs(cwc.source_lane_num - cwc.staging_lane_num) * p_source_lane_distance_weight
            else 0::numeric
          end
        - greatest(cwc.source_lane_candidate_count - 1, 0)::numeric * p_lane_batch_bonus
        - greatest(cwc.shipment_candidate_count - 1, 0)::numeric * p_shipment_batch_bonus
      )::numeric as base_score
    from candidate_with_counts cwc
  ),
  ranked_pool as (
    select
      sc.*,
      row_number() over (
        order by
          sc.base_score,
          sc.pallets_in_front,
          sc.days_until_pu,
          sc.source_lane,
          sc.representative_pt_id
      ) as candidate_rank
    from scored_candidates sc
  ),
  candidate_pool as (
    select *
    from ranked_pool rp
    where rp.candidate_rank <= v_max_candidates
  ),
  pool_size as (
    select count(*)::integer as total_candidates
    from candidate_pool
  ),
  start_move as (
    select
      cp.unit_key,
      cp.move_type,
      cp.shipment_id,
      cp.pu_number,
      cp.pu_date,
      cp.staging_lane,
      cp.source_lane,
      cp.assignment_id,
      cp.representative_pt_id,
      cp.representative_pt_number,
      cp.representative_po_number,
      cp.pending_member_count,
      cp.pending_member_pt_ids,
      cp.pallets_to_move,
      cp.pallets_in_front,
      cp.days_until_pu,
      cp.base_score,
      cp.source_lane_num,
      cp.staging_lane_num
    from candidate_pool cp
    order by
      cp.base_score,
      cp.pallets_in_front,
      cp.days_until_pu,
      cp.source_lane,
      cp.representative_pt_id
    limit 1
  ),
  ordered_moves as (
    select
      1::integer as step_no,
      sm.unit_key,
      sm.move_type,
      sm.shipment_id,
      sm.pu_number,
      sm.pu_date,
      sm.staging_lane,
      sm.source_lane,
      sm.assignment_id,
      sm.representative_pt_id,
      sm.representative_pt_number,
      sm.representative_po_number,
      sm.pending_member_count,
      sm.pending_member_pt_ids,
      sm.pallets_to_move,
      sm.pallets_in_front,
      sm.days_until_pu,
      sm.base_score,
      sm.base_score::numeric as transition_score,
      sm.base_score::numeric as cumulative_score,
      sm.source_lane_num,
      sm.staging_lane_num,
      array[sm.unit_key]::text[] as picked_keys
    from start_move sm

    union all

    select
      (om.step_no + 1)::integer as step_no,
      nx.unit_key,
      nx.move_type,
      nx.shipment_id,
      nx.pu_number,
      nx.pu_date,
      nx.staging_lane,
      nx.source_lane,
      nx.assignment_id,
      nx.representative_pt_id,
      nx.representative_pt_number,
      nx.representative_po_number,
      nx.pending_member_count,
      nx.pending_member_pt_ids,
      nx.pallets_to_move,
      nx.pallets_in_front,
      nx.days_until_pu,
      nx.base_score,
      nx.transition_score,
      (om.cumulative_score + nx.transition_score)::numeric as cumulative_score,
      nx.source_lane_num,
      nx.staging_lane_num,
      om.picked_keys || nx.unit_key
    from ordered_moves om
    join pool_size ps
      on true
    join lateral (
      select
        cp.*,
        (
          cp.base_score
          + case
              when cp.source_lane = om.source_lane then 0::numeric
              else p_source_lane_switch_penalty
            end
          + case
              when cp.staging_lane is not distinct from om.staging_lane then 0::numeric
              else p_staging_lane_switch_penalty
            end
          + case
              when cp.source_lane_num is not null and om.source_lane_num is not null then
                abs(cp.source_lane_num - om.source_lane_num) * p_source_lane_distance_weight
              else 0::numeric
            end
        )::numeric as transition_score
      from candidate_pool cp
      where not cp.unit_key = any(om.picked_keys)
      order by
        transition_score,
        cp.base_score,
        cp.pallets_in_front,
        cp.days_until_pu,
        cp.source_lane,
        cp.representative_pt_id
      limit 1
    ) nx
      on true
    where om.step_no < least(v_max_steps, ps.total_candidates)
  )
  select
    om.step_no,
    om.shipment_id::bigint,
    om.pu_number,
    om.pu_date,
    om.staging_lane,
    om.source_lane,
    om.assignment_id::bigint,
    om.representative_pt_id::bigint,
    om.representative_pt_number,
    om.representative_po_number,
    om.move_type,
    om.pending_member_count,
    om.pending_member_pt_ids::bigint[],
    om.pallets_to_move,
    om.pallets_in_front,
    om.days_until_pu,
    om.base_score,
    om.transition_score,
    om.cumulative_score
  from ordered_moves om
  order by om.step_no;
end;
$$;

-- Executes one planned move row by lane assignment id.
-- For compiled pallets, this stages all remaining group members together.
create or replace function public.stage_assignment_into_shipment_transactional(
  p_assignment_id bigint,
  p_pu_number text,
  p_pu_date text
)
returns table (
  shipment_id bigint,
  staging_lane text,
  pt_status text,
  representative_pt_id bigint,
  compiled_pallet_id bigint,
  staged_member_count integer,
  pallet_count integer
)
language plpgsql
set search_path = public
as $$
declare
  v_representative_pt_id bigint;
  v_compiled_pallet_id bigint;
  v_source_lane text;
  v_representative_assigned_lane text;
  v_stage_row record;
  v_member record;
  v_member_ids bigint[] := '{}';
  v_member_count integer := 0;
begin
  if p_assignment_id is null then
    raise exception 'Assignment id is required';
  end if;

  if p_pu_number is null or btrim(p_pu_number) = '' then
    raise exception 'PU number is required';
  end if;

  if p_pu_date is null or btrim(p_pu_date) = '' then
    raise exception 'PU date is required';
  end if;

  select
    la.pt_id,
    la.compiled_pallet_id,
    btrim(la.lane_number::text)
  into
    v_representative_pt_id,
    v_compiled_pallet_id,
    v_source_lane
  from public.lane_assignments la
  where la.id = p_assignment_id
  for update;

  if v_representative_pt_id is null then
    raise exception 'Lane assignment % not found', p_assignment_id;
  end if;

  select
    p.assigned_lane
  into
    v_representative_assigned_lane
  from public.picktickets p
  where p.id = v_representative_pt_id
  for update;

  if not found then
    raise exception 'Representative pickticket % not found', v_representative_pt_id;
  end if;

  select *
  into v_stage_row
  from public.stage_pickticket_into_shipment_lane(
    p_pu_number,
    p_pu_date,
    v_representative_pt_id,
    coalesce(v_representative_assigned_lane, v_source_lane)
  )
  limit 1;

  if v_stage_row.shipment_id is null then
    raise exception 'Failed to stage representative PT % into shipment % / %', v_representative_pt_id, p_pu_number, p_pu_date;
  end if;

  if v_compiled_pallet_id is not null then
    update public.lane_assignments la
    set compiled_pallet_id = v_compiled_pallet_id
    where la.pt_id = v_representative_pt_id
      and btrim(coalesce(la.lane_number::text, '')) = btrim(coalesce(v_stage_row.staging_lane::text, ''));

    for v_member in
      select
        p.id as pt_id,
        nullif(btrim(coalesce(p.assigned_lane::text, v_source_lane)), '') as original_lane
      from public.compiled_pallet_pts cpp
      join public.picktickets p
        on p.id = cpp.pt_id
      where cpp.compiled_pallet_id = v_compiled_pallet_id
        and p.id <> v_representative_pt_id
        and coalesce(p.status, '') <> 'shipped'
      for update of p
    loop
      v_member_ids := array_append(v_member_ids, v_member.pt_id);
      v_member_count := v_member_count + 1;

      -- Avoid ambiguous variable/column resolution with RETURNS TABLE output names
      -- (e.g. output variable "shipment_id" vs table column "shipment_id").
      update public.shipment_pts sp
      set
        original_lane = v_member.original_lane,
        removed_from_staging = false
      where sp.shipment_id = v_stage_row.shipment_id
        and sp.pt_id = v_member.pt_id;

      if not found then
        begin
          insert into public.shipment_pts (
            shipment_id,
            pt_id,
            original_lane,
            removed_from_staging
          )
          values (
            v_stage_row.shipment_id,
            v_member.pt_id,
            v_member.original_lane,
            false
          );
        exception
          when unique_violation then
            update public.shipment_pts sp
            set
              original_lane = v_member.original_lane,
              removed_from_staging = false
            where sp.shipment_id = v_stage_row.shipment_id
              and sp.pt_id = v_member.pt_id;
        end;
      end if;
    end loop;

    if v_member_count > 0 then
      delete from public.lane_assignments
      where pt_id = any(v_member_ids);

      update public.picktickets
      set
        assigned_lane = v_stage_row.staging_lane,
        actual_pallet_count = v_stage_row.pallet_count,
        status = v_stage_row.pt_status
      where id = any(v_member_ids)
        and coalesce(status, '') <> 'shipped';
    end if;
  end if;

  update public.shipments
  set updated_at = now()
  where id = v_stage_row.shipment_id;

  return query
  select
    v_stage_row.shipment_id::bigint,
    v_stage_row.staging_lane::text,
    v_stage_row.pt_status::text,
    v_representative_pt_id::bigint,
    v_compiled_pallet_id::bigint,
    (1 + v_member_count)::integer,
    coalesce(v_stage_row.pallet_count, 0)::integer;
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
  v_target_staging_shipment_id bigint;
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

  select s.id
  into v_target_staging_shipment_id
  from public.shipments s
  where btrim(coalesce(s.staging_lane::text, '')) = v_target_lane
    and coalesce(s.archived, false) = false
  order by s.updated_at desc nulls last, s.id desc
  limit 1;

  if v_target_staging_shipment_id is not null then
    raise exception 'Target lane % is active staging lane; use shipment stage flow', v_target_lane;
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
    set
      assigned_lane = v_target_lane,
      status = case
        when coalesce(status, '') = 'shipped' then status
        else 'labeled'
      end
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
        actual_pallet_count = null,
        status = case
          when coalesce(status, '') = 'shipped' then status
          else 'unlabeled'
        end
      where id = v_pt_id;
    else
      update public.picktickets
      set
        assigned_lane = v_primary_lane,
        actual_pallet_count = v_total_pallets,
        status = case
          when coalesce(status, '') = 'shipped' then status
          else 'labeled'
        end
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
