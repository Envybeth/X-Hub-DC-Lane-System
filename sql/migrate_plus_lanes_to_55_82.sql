-- Run once in Supabase SQL Editor.
-- Renames mini lanes like "1+", "2+", ... to "55"..."82" and updates
-- all lane reference columns so data stays consistent.

begin;

create temporary table lane_rename_map (
  old_lane text primary key,
  new_lane text not null unique
) on commit drop;

insert into lane_rename_map (old_lane, new_lane)
select
  lane_number as old_lane,
  (54 + row_number() over (
    order by regexp_replace(lane_number, '\+$', '')::int, lane_number
  ))::text as new_lane
from public.lanes
where lane_number ~ '^[0-9]+\+$';

do $$
declare
  plus_lane_count int;
  expected_new_lane_count int;
  conflict_count int;
begin
  select count(*) into plus_lane_count from lane_rename_map;
  select count(*) into expected_new_lane_count from lane_rename_map where new_lane::int between 55 and 82;

  if plus_lane_count = 0 then
    raise exception 'No plus mini lanes found (expected lanes like "1+").';
  end if;

  if plus_lane_count <> 28 then
    raise exception 'Expected 28 plus mini lanes to map to 55-82, found %.', plus_lane_count;
  end if;

  if expected_new_lane_count <> 28 then
    raise exception 'Mapping did not resolve to exactly lanes 55-82.';
  end if;

  select count(*)
  into conflict_count
  from public.lanes l
  join lane_rename_map m on l.lane_number = m.new_lane
  where l.lane_number not in (select old_lane from lane_rename_map);

  if conflict_count > 0 then
    raise exception 'Conflict: some target lane numbers 55-82 already exist as non-plus lanes.';
  end if;
end $$;

-- Update all known lane-reference text columns across public schema.
do $$
declare
  col record;
begin
  for col in
    select table_schema, table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and column_name in ('lane_number', 'assigned_lane', 'staging_lane', 'original_lane')
      and data_type in ('text', 'character varying')
  loop
    execute format(
      'update %I.%I t
       set %I = m.new_lane
       from lane_rename_map m
       where t.%I = m.old_lane',
      col.table_schema,
      col.table_name,
      col.column_name,
      col.column_name
    );
  end loop;
end $$;

-- Keep historical log details aligned for lane display.
update public.user_action_logs l
set details = jsonb_set(l.details, '{lane_number}', to_jsonb(m.new_lane::text), false)
from lane_rename_map m
where l.details ? 'lane_number'
  and l.details->>'lane_number' = m.old_lane;

update public.user_action_logs l
set target_id = m.new_lane
from lane_rename_map m
where l.target_table = 'lanes'
  and l.target_id = m.old_lane;

-- Final safety checks to guarantee finished state is correct.
do $$
declare
  remaining_plus_count int;
  mini_55_82_count int;
begin
  select count(*)
  into remaining_plus_count
  from public.lanes
  where lane_number ~ '^[0-9]+\+$';

  if remaining_plus_count > 0 then
    raise exception 'Migration incomplete: % plus lanes still remain.', remaining_plus_count;
  end if;

  select count(*)
  into mini_55_82_count
  from public.lanes
  where max_capacity = 4
    and lane_number ~ '^[0-9]+$'
    and lane_number::int between 55 and 82;

  if mini_55_82_count <> 28 then
    raise exception 'Expected 28 mini lanes between 55-82 after migration, found %.', mini_55_82_count;
  end if;
end $$;

commit;

-- Optional verification after run:
-- select lane_number, max_capacity from public.lanes where max_capacity = 4 order by lane_number::int;
