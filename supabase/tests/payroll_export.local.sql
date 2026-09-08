-- Disposable PostgreSQL regression. Run with psql -v ON_ERROR_STOP=1.
begin;
do $$
begin
  if current_database() <> 'hopin_test' or current_setting('port') <> '55432' then
    raise exception 'This fixture may only run in hopin_test on port 55432';
  end if;
end $$;

insert into public.profiles (id, display_name, role, active)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad', 'Disposable payroll owner', 'OWNER', true),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae', 'Disposable payroll employee', 'OPERATOR', true);
insert into public.profile_outlet_scopes (profile_id, outlet_id)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae', '11111111-1111-1111-1111-111111111111');
insert into public.compensation_policies (
  id, outlet_id, name, effective_from, status
) values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbe', '11111111-1111-1111-1111-111111111111',
  'Disposable payroll policy', current_date - 365, 'ACTIVE'
);

-- Seed an already-reviewed immutable snapshot. RPC behavior below runs with
-- every trigger enabled again.
set local session_replication_role = replica;
insert into public.payroll_runs (
  id, outlet_id, period_month, status, policy_id, version, created_by, reviewed_by, reviewed_at
) values (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccce', '11111111-1111-1111-1111-111111111111',
  to_char(current_date, 'YYYY-MM'), 'REVIEWED', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbe',
  2, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad', now()
);
insert into public.payroll_entries (
  id, run_id, profile_id, base_amount, proposed_gross, final_gross, status, version
) values (
  'dddddddd-dddd-4ddd-8ddd-ddddddddddda', 'cccccccc-cccc-4ccc-8ccc-ccccccccccce',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae', 1000000, 1000000, 0, 'REVIEWED', 2
);
set local session_replication_role = origin;

do $$
<<fixture>>
declare
  actor_id uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad';
  run_id uuid := 'cccccccc-cccc-4ccc-8ccc-ccccccccccce';
  idem uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  first_reservation jsonb;
  replay_reservation jsonb;
  commit_result jsonb;
  replay_commit jsonb;
  unknown_reservation jsonb;
  unknown_result jsonb;
  recovered_result jsonb;
  null_reservation jsonb;
  null_result jsonb;
  empty_reservation jsonb;
  empty_result jsonb;
  reservation_id uuid;
  final_export_id uuid;
  upload_token uuid;
  checksum text := repeat('a', 64);
begin
  if has_function_privilege('anon', 'public.rpc_reserve_payroll_export(uuid,uuid,integer,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rpc_commit_payroll_export(uuid,uuid,uuid,text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.rpc_record_payroll_export(uuid,uuid,integer,text,text,text,jsonb)', 'EXECUTE') then
    raise exception 'Payroll reservation privileges or legacy bypass are incorrect';
  end if;

  first_reservation := public.rpc_reserve_payroll_export(actor_id, run_id, 2, idem);
  replay_reservation := public.rpc_reserve_payroll_export(actor_id, run_id, 2, idem);
  reservation_id := (first_reservation->>'reservation_id')::uuid;
  final_export_id := (first_reservation->>'final_export_id')::uuid;
  upload_token := (first_reservation->>'upload_token')::uuid;
  if first_reservation->>'can_upload' <> 'true'
     or replay_reservation->>'can_upload' <> 'false'
     or replay_reservation->>'reservation_id' <> reservation_id::text
     or position(final_export_id::text in first_reservation->>'file_path') = 0
     or (select count(*) from public.payroll_exports export where export.run_id = fixture.run_id) <> 0 then
    raise exception 'Reservation did not provide one lease without pre-creating export evidence';
  end if;

  commit_result := public.rpc_commit_payroll_export(actor_id, reservation_id, upload_token, checksum);
  replay_commit := public.rpc_commit_payroll_export(actor_id, reservation_id, upload_token, checksum);
  if commit_result->>'idempotent_replay' <> 'false'
     or replay_commit->>'idempotent_replay' <> 'true'
     or commit_result->>'export_id' <> final_export_id::text
     or replay_commit->>'export_id' <> final_export_id::text
     or (select count(*) from public.payroll_exports where id = final_export_id) <> 1
     or (select status from public.payroll_export_reservations where id = reservation_id) <> 'COMMITTED' then
    raise exception 'Commit/replay did not preserve exactly one export receipt';
  end if;

  unknown_reservation := public.rpc_reserve_payroll_export(
    actor_id, run_id, 2, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef'
  );
  unknown_result := public.rpc_reconcile_payroll_export(
    actor_id,
    (unknown_reservation->>'reservation_id')::uuid,
    (unknown_reservation->>'upload_token')::uuid,
    'UNKNOWN', repeat('b', 64)
  );
  if unknown_result->>'status' <> 'UPLOAD_UNKNOWN'
     or exists(select 1 from public.payroll_exports
       where id = (unknown_reservation->>'final_export_id')::uuid) then
    raise exception 'Ambiguous upload was not retained without false export evidence';
  end if;
  recovered_result := public.rpc_reconcile_payroll_export(
    actor_id,
    (unknown_reservation->>'reservation_id')::uuid,
    (unknown_reservation->>'upload_token')::uuid,
    'PRESENT', repeat('b', 64)
  );
  if recovered_result->>'status' <> 'COMMITTED'
     or not exists(select 1 from public.payroll_exports
       where id = (unknown_reservation->>'final_export_id')::uuid
         and checksum_sha256 = repeat('b', 64)) then
    raise exception 'Confirmed ambiguous object was not reconciled into one export';
  end if;
  null_reservation := public.rpc_reserve_payroll_export(
    actor_id, run_id, 2, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeef0'
  );
  begin
    null_result := public.rpc_reconcile_payroll_export(
      actor_id,
      (null_reservation->>'reservation_id')::uuid,
      (null_reservation->>'upload_token')::uuid,
      null, repeat('c', 64)
    );
    raise exception 'NULL observed_state was accepted without error (must reject)';
  exception when others then
    if sqlerrm = 'NULL observed_state was accepted without error (must reject)' then
      raise;
    end if;
    if exists(select 1 from public.payroll_exports
      where id = (null_reservation->>'final_export_id')::uuid) then
      raise exception 'NULL observed_state created export evidence (must reject)';
    end if;
  end;

  empty_reservation := public.rpc_reserve_payroll_export(
    actor_id, run_id, 2, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeef1'
  );
  begin
    empty_result := public.rpc_reconcile_payroll_export(
      actor_id,
      (empty_reservation->>'reservation_id')::uuid,
      (empty_reservation->>'upload_token')::uuid,
      '', repeat('d', 64)
    );
    raise exception 'Empty observed_state was accepted without error (must reject)';
  exception when others then
    if sqlerrm = 'Empty observed_state was accepted without error (must reject)' then
      raise;
    end if;
    if exists(select 1 from public.payroll_exports
      where id = (empty_reservation->>'final_export_id')::uuid) then
      raise exception 'Empty observed_state created export evidence (must reject)';
    end if;
  end;
  raise notice 'PASS: payroll privilege, evidence reservation, lease, unique path, commit, replay and unknown recovery';
end $$;
rollback;
