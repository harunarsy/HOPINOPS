-- Disposable PostgreSQL regression. Run with psql -v ON_ERROR_STOP=1.
begin;
do $$
begin
  if current_database() <> 'hopin_test' or current_setting('port') <> '55432' then
    raise exception 'This fixture may only run in hopin_test on port 55432';
  end if;
end $$;

insert into public.profiles (id, display_name, role, active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'Disposable emergency operator', 'OPERATOR', true);
insert into public.profile_outlet_scopes (profile_id, outlet_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', '11111111-1111-1111-1111-111111111111');
insert into public.profiles (id, display_name, role, active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1', 'Disposable emergency already-pending', 'OPERATOR', true),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2', 'Disposable emergency stale-assignment', 'OPERATOR', true);
insert into public.profile_outlet_scopes (profile_id, outlet_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1', '11111111-1111-1111-1111-111111111111'),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2', '11111111-1111-1111-1111-111111111111');
insert into public.work_cycles (id, outlet_id, work_date, shift_code, area_code, status)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbe1', '11111111-1111-1111-1111-111111111111',
  current_date, 'SIANG', 'BAR', 'ACTIVE'),
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbe2', '11111111-1111-1111-1111-111111111111',
  current_date, 'MALAM', 'BAR', 'ACTIVE');
insert into public.work_assignments (id, cycle_id, work_date, profile_id, duty_role, status)
values ('cccccccc-cccc-4ccc-8ccc-ccccccccce01', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbe1',
  current_date, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1', 'PRIMARY', 'PENDING_TASKS'),
       ('cccccccc-cccc-4ccc-8ccc-ccccccccce02', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbe2',
  current_date, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2', 'PRIMARY', 'COMPLETED');
insert into public.attendance_records (
  id, outlet_id, work_date, profile_id, work_assignment_id, status, version
) values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01', '11111111-1111-1111-1111-111111111111',
  current_date, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1',
  'cccccccc-cccc-4ccc-8ccc-ccccccccce01', 'CHECKED_IN', 1
), (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02', '11111111-1111-1111-1111-111111111111',
  current_date, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2',
  'cccccccc-cccc-4ccc-8ccc-ccccccccce02', 'CHECKED_IN', 1
);
insert into public.attendance_events (
  id, attendance_id, event_type, location_status, idempotency_key
) values (
  'ffffffff-ffff-4fff-8fff-ffffffffff01', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01',
  'CHECK_IN', 'VERIFIED', 'fixture-checkin-b1'
), (
  'ffffffff-ffff-4fff-8fff-ffffffffff02', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02',
  'CHECK_IN', 'VERIFIED', 'fixture-checkin-b2'
);
update public.attendance_records
set check_in_event_id = 'ffffffff-ffff-4fff-8fff-ffffffffff01'
where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01';
update public.attendance_records
set check_in_event_id = 'ffffffff-ffff-4fff-8fff-ffffffffff02'
where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02';
insert into public.work_cycles (id, outlet_id, work_date, shift_code, area_code, status)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd', '11111111-1111-1111-1111-111111111111',
  current_date, 'FULL', 'KITCHEN', 'ACTIVE');
insert into public.work_assignments (id, cycle_id, work_date, profile_id, duty_role, status)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccd', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd',
  current_date, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'PRIMARY', 'ACTIVE');
insert into public.attendance_records (
  id, outlet_id, work_date, profile_id, work_assignment_id, status, version
) values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
  current_date, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccd', 'CHECKED_IN', 1
);
insert into public.attendance_events (
  id, attendance_id, event_type, location_status, idempotency_key
) values (
  'ffffffff-ffff-4fff-8fff-ffffffffffff', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'CHECK_IN', 'VERIFIED', 'fixture-checkin'
);
update public.attendance_records
set check_in_event_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

do $$
declare
  actor_id uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac';
  outlet_id uuid := '11111111-1111-1111-1111-111111111111';
  idem uuid := 'dddddddd-dddd-4ddd-8ddd-ddddddddddde';
  first_result jsonb;
  replay_result jsonb;
  rejected boolean := false;
begin
  if has_function_privilege('anon', 'public.rpc_self_emergency_checkout(uuid,uuid,integer,uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rpc_self_emergency_checkout(uuid,uuid,integer,uuid,text)', 'EXECUTE') then
    raise exception 'Self-emergency RPC leaked direct browser privileges';
  end if;

  first_result := public.rpc_self_emergency_checkout(
    actor_id, outlet_id, 1, idem, 'Disposable emergency reason'
  );
  replay_result := public.rpc_self_emergency_checkout(
    actor_id, outlet_id, 1, idem, 'Disposable emergency reason'
  );
  if first_result->>'idempotent_replay' <> 'false'
     or replay_result->>'idempotent_replay' <> 'true'
     or first_result->>'event_id' <> replay_result->>'event_id' then
    raise exception 'Self-emergency replay did not return the original receipt';
  end if;
  if (select status from public.attendance_records where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') <> 'REVIEW_REQUIRED'
     or (select exception_status from public.attendance_records where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') <> 'PENDING_REVIEW'
     or (select status from public.work_assignments where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd') <> 'PENDING_TASKS'
     or (select count(*) from public.attendance_events where attendance_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' and event_type = 'CHECK_OUT') <> 1
     or (select count(*) from public.audit_events where action = 'SELF_EMERGENCY_CHECKOUT' and entity_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') <> 1 then
    raise exception 'Self-emergency did not create exactly one pending-review transition';
  end if;

  begin
    perform public.rpc_self_emergency_checkout(
      actor_id, outlet_id, 1, 'dddddddd-dddd-4ddd-8ddd-dddddddddddf',
      'A different new request'
    );
  exception when sqlstate '55000' then
    rejected := position('NO_OPEN_ATTENDANCE' in sqlerrm) > 0;
  end;
  if not rejected then
    raise exception 'A new key after checkout was not rejected as no open attendance';
  end if;

  first_result := public.rpc_self_emergency_checkout(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1', outlet_id, 1,
    '11111111-1111-4111-8111-111111111111', 'Already pending assignment reason'
  );
  if first_result->>'idempotent_replay' <> 'false'
     or (select status from public.work_assignments where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccce01') <> 'PENDING_TASKS'
     or (select count(*) from public.attendance_events where attendance_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01' and event_type = 'CHECK_OUT') <> 1 then
    raise exception 'Checkout with already-PENDING_TASKS assignment did not proceed exactly once';
  end if;

  begin
    perform public.rpc_self_emergency_checkout(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2', outlet_id, 1,
      '22222222-2222-4222-8222-222222222222', 'Stale assignment reason'
    );
    raise exception 'Checkout with stale COMPLETED assignment was not aborted';
  exception when sqlstate '55000' then
    if position('ASSIGNMENT_STATE_CONFLICT' in sqlerrm) = 0 then raise; end if;
  end;
  if (select status from public.attendance_records where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02') <> 'CHECKED_IN'
     or exists(select 1 from public.attendance_events where attendance_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02' and event_type = 'CHECK_OUT') then
    raise exception 'Aborted stale-assignment checkout left partial attendance writes';
  end if;
  raise notice 'PASS: self-emergency privilege, transition, audit and response-loss replay';
end $$;
rollback;
