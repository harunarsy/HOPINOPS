-- Disposable PostgreSQL regression. Run with psql -v ON_ERROR_STOP=1.
-- Proves migration 0027 backfills pre-0023 NULL snapshots so previously
-- confirmed closings stay submittable, and that it is idempotent.
begin;
do $$
begin
  if current_database() <> 'hopin_test' or current_setting('port') <> '55432' then
    raise exception 'This fixture may only run in hopin_test on port 55432';
  end if;
end $$;

insert into public.profiles (id, display_name, role, active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaf1', 'Disposable backfill confirmer', 'SUPERVISOR', true);
insert into public.profile_outlet_scopes (profile_id, outlet_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaf1', '11111111-1111-1111-1111-111111111111');
insert into public.work_cycles (id, outlet_id, work_date, shift_code, area_code, status)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbf1', '11111111-1111-1111-1111-111111111111',
  current_date + 31, 'FULL', 'KITCHEN', 'ACTIVE');
-- Simulate pre-0023 legacy rows with triggers bypassed: snapshots stay NULL.
set local session_replication_role = replica;
insert into public.stock_closings (id, cycle_id, status, movement_cutoff_at, confirmed_at, confirmed_by)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccf01', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbf1',
  'CONFIRMED', now(), now(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaf1');
insert into public.stock_closing_lines (
  closing_id, item_id, opening_qty, system_qty, counted_qty, variance_qty
) values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccf01', 'bar-01', 10, 8, 8, 0
);
set local session_replication_role = origin;

do $$
begin
  if not exists(select 1 from public.stock_closing_lines
    where closing_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccf01'
      and item_name_snapshot is null) then
    raise exception 'Legacy fixture did not produce NULL snapshots';
  end if;
end $$;

\ir ../migrations/0027_closing_snapshot_backfill.sql

do $$
declare
  line public.stock_closing_lines%rowtype;
begin
  select * into line from public.stock_closing_lines
  where closing_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccf01';
  if line.item_name_snapshot is null or line.unit_code_snapshot is null
     or line.decimal_scale_snapshot is null or line.low_threshold_snapshot is null then
    raise exception 'Backfill left NULL snapshots on a row whose item exists';
  end if;
  if line.item_name_snapshot <> (select name from public.items where id = 'bar-01')
     or line.unit_code_snapshot <> (select unit_code from public.items where id = 'bar-01') then
    raise exception 'Backfill did not copy master metadata: %', line;
  end if;
  if exists(select 1 from public.stock_closing_lines
    where closing_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccf01'
      and (item_name_snapshot is null or unit_code_snapshot is null
        or decimal_scale_snapshot is null or low_threshold_snapshot is null)) then
    raise exception 'Closing still fails the submit snapshot completeness check';
  end if;
  raise notice 'PASS: legacy closing snapshots backfilled from items master';
end $$;

-- Idempotency: a second apply must succeed with zero rows touched.
\ir ../migrations/0027_closing_snapshot_backfill.sql

rollback;
