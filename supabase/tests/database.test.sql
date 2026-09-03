begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

create temporary table required_functions (signature text primary key) on commit drop;
insert into required_functions values
  ('public.is_manager()'),
  ('public.can_access_assignment(uuid)'),
  ('public.can_view_finance()'),
  ('public.require_authorized_actor(uuid,uuid)'),
  ('public.log_audit_event(uuid,text,text,text,uuid,uuid,jsonb,jsonb,text,text)'),
  ('public.enforce_append_only()'),
  ('public.enforce_stock_snapshot_parent()'),
  ('public.enforce_stock_snapshot_line_state()'),
  ('public.enforce_report_revision_immutable()'),
  ('public.enforce_report_line_state()'),
  ('public.enforce_bonus_pool_state()'),
  ('public.enforce_bonus_allocation_state()'),
  ('public.enforce_payroll_entry_state()'),
  ('public.enforce_payroll_run_state()'),
  ('public.enforce_payroll_export_state()'),
  ('public.haversine_distance_m(double precision,double precision,double precision,double precision)'),
  ('public.rpc_record_auth_failure(uuid,text[])'),
  ('public.rpc_reset_auth_failures(uuid,text[])'),
  ('public.rpc_check_auth_limits(uuid,text[])'),
  ('public.rpc_create_attendance_challenge(uuid,uuid,uuid,uuid,text,text)'),
  ('public.rpc_record_attendance_event(uuid,uuid,uuid,uuid,uuid,text,text,uuid,uuid,jsonb,text,text,text)'),
  ('public.rpc_request_shift_swap(uuid,uuid,uuid,uuid,integer)'),
  ('public.rpc_respond_shift_swap(uuid,uuid,uuid,boolean,integer)'),
  ('public.rpc_cancel_shift_swap(uuid,uuid,uuid,integer)'),
  ('public.rpc_reset_assignment(uuid,uuid,uuid,integer,text)'),
  ('public.rpc_create_user(uuid,uuid,text,text,public.app_role,text,text,text)'),
  ('public.rpc_change_pin(uuid,uuid,uuid,integer,text,text,boolean)'),
  ('public.rpc_claim_assignment(uuid,date,text,public.area_code,uuid,text)'),
  ('public.rpc_confirm_opening(uuid,uuid,jsonb)'),
  ('public.rpc_create_stock_movement(uuid,uuid,integer,text,public.movement_direction,text,numeric,timestamp with time zone,uuid,uuid,text)'),
  ('public.rpc_complete_handover(uuid,uuid)'),
  ('public.rpc_confirm_closing(uuid,uuid,jsonb)'),
  ('public.rpc_submit_daily_report(uuid,date,uuid,jsonb,text)'),
  ('public.rpc_review_daily_report(uuid,uuid,text,text)'),
  ('public.rpc_finalize_daily_bonus(uuid,uuid,numeric)'),
  ('public.rpc_record_payroll_export(uuid,uuid,integer,text,text,text,jsonb)'),
  ('public.rpc_reset_pin(uuid,uuid,text,text,text,integer)'),
  ('public.rpc_preview_payroll(uuid,uuid,text,integer)'),
  ('public.rpc_review_payroll(uuid,uuid,integer)'),
  ('public.rpc_finalize_payroll(uuid,uuid,integer)'),
  ('public.rpc_mark_payroll_paid(uuid,uuid,integer,text,text)'),
  ('public.rpc_void_payroll(uuid,uuid,integer,text)');

select ok(
  bool_and(to_regprocedure(signature) is not null),
  'protected functions resolve by exact regprocedure signature'
)
from required_functions;

select ok(
  not exists (
    select 1
    from required_functions required
    join pg_proc function on function.oid = to_regprocedure(required.signature)
    cross join lateral aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
    where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC lacks EXECUTE on protected functions'
);

select ok(
  bool_and(not has_function_privilege('anon', to_regprocedure(signature), 'EXECUTE')),
  'anon lacks EXECUTE on protected functions'
)
from required_functions;

select ok(
  bool_and(not has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE')),
  'authenticated lacks EXECUTE on protected functions'
)
from required_functions;

select ok(
  bool_and(has_function_privilege('service_role', to_regprocedure(signature), 'EXECUTE')),
  'service_role has EXECUTE on protected functions'
)
from required_functions;

create temporary table operational_tables (relation regclass primary key) on commit drop;
insert into operational_tables values
  ('public.operator_credentials'), ('public.app_sessions'),
  ('public.outlets'), ('public.outlet_settings'), ('public.profile_outlet_scopes'),
  ('public.pin_history'), ('public.app_devices'), ('public.auth_rate_limits'),
  ('public.shift_templates'), ('public.work_cycles'), ('public.work_assignments'),
  ('public.stock_openings'), ('public.stock_opening_lines'), ('public.stock_movements'),
  ('public.stock_handovers'), ('public.stock_handover_lines'),
  ('public.stock_closings'), ('public.stock_closing_lines'),
  ('public.roster_entries'), ('public.shift_swap_requests'),
  ('public.attendance_challenges'), ('public.attendance_records'),
  ('public.attendance_events'), ('public.attendance_location_samples'),
  ('public.attendance_corrections'), ('public.leave_requests'), ('public.overtime_claims'),
  ('public.daily_reports'), ('public.daily_report_revisions'),
  ('public.daily_report_finance'), ('public.daily_report_stock_lines'),
  ('public.daily_bonus_pools'), ('public.daily_bonus_allocations'),
  ('public.compensation_policies'), ('public.employee_compensations'),
  ('public.payroll_runs'), ('public.payroll_entries'),
  ('public.payroll_adjustments'), ('public.payroll_exports'),
  ('public.onboarding_progress');

select ok(
  bool_and(not has_table_privilege('anon', relation, privilege)),
  'anon has no operational table privileges'
)
from operational_tables
cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege;

select ok(
  bool_and(not has_table_privilege('authenticated', relation, privilege)),
  'authenticated has no operational table privileges'
)
from operational_tables
cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege;

select ok(
  exists (
    select 1
    from pg_index idx
    join pg_class relation on relation.oid = idx.indrelid
    join pg_class index_relation on index_relation.oid = idx.indexrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'payroll_runs'
      and index_relation.relname = 'payroll_runs_outlet_period_nonvoid_uniq'
      and idx.indisunique
      and pg_get_expr(idx.indpred, idx.indrelid) = '(status <> ''VOID''::text)'
  ),
  'payroll period uniqueness is a partial non-VOID unique index'
);

select lives_ok(
  $$insert into public.payroll_runs (outlet_id, period_month, policy_id)
    values ('11111111-1111-1111-1111-111111111111', '2099-01', '22222222-2222-2222-2222-222222222222')$$,
  'first non-VOID payroll run is accepted'
);

select throws_ok(
  $$insert into public.payroll_runs (outlet_id, period_month, policy_id)
    values ('11111111-1111-1111-1111-111111111111', '2099-01', '22222222-2222-2222-2222-222222222222')$$,
  '23505',
  'duplicate key value violates unique constraint "payroll_runs_outlet_period_nonvoid_uniq"',
  'duplicate non-VOID payroll run is rejected'
);

insert into public.audit_events (id, action, entity_type, entity_id)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'TEST', 'test', 'fixture');

select throws_ok(
  $$update public.audit_events set action = 'TAMPERED'
    where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  '55000',
  'APPEND_ONLY: audit_events tidak boleh diubah atau dihapus.',
  'audit update is blocked'
);

select throws_ok(
  $$delete from public.audit_events
    where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  '55000',
  'APPEND_ONLY: audit_events tidak boleh diubah atau dihapus.',
  'audit delete is blocked'
);

select is(
  (public.rpc_record_auth_failure(
    null,
    array['ip:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']
  )->>'attempts')::integer,
  1,
  'first auth failure records one attempt'
);

select is(
  (public.rpc_record_auth_failure(
    null,
    array['ip:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']
  )->>'attempts')::integer,
  2,
  'second auth failure increments the attempt atomically'
);

select is(
  (select attempts from public.auth_rate_limits
   where scope_key = 'ip:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  2,
  'auth failure count persists sequential increments'
);

insert into public.profiles (id, username, display_name, role, job_title)
values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'tap-investor', 'TAP INVESTOR', 'INVESTOR', 'TEST'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'tap-operator', 'TAP OPERATOR', 'OPERATOR', 'TEST');

insert into public.profile_outlet_scopes (profile_id, outlet_id)
values
  ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111');

select throws_ok(
  $$select public.rpc_claim_assignment(
    '11111111-1111-1111-1111-111111111111', '2099-02-01', 'SIANG', 'BAR',
    'bbbbbbbb-0000-0000-0000-000000000001', 'PRIMARY'
  )$$,
  '42501',
  'FORBIDDEN_ROLE: Role tidak diizinkan mengklaim assignment.',
  'INVESTOR cannot claim an assignment'
);

select throws_ok(
  $$select public.rpc_create_user(
    'bbbbbbbb-0000-0000-0000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    'tap-created', 'TAP CREATED', 'OPERATOR', 'TEST',
    'AAAAAAAAAAAAAAAAAAAAAA==',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
  )$$,
  '42501',
  'FORBIDDEN_ROLE: Hanya OWNER yang dapat membuat user.',
  'OPERATOR cannot create a user'
);

select * from finish();
rollback;
