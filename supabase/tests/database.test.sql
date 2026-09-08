begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(32);

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
  ('public.enforce_payroll_adjustment_state()'),
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
  ('public.rpc_reserve_payroll_export(uuid,uuid,integer,uuid)'),
  ('public.rpc_commit_payroll_export(uuid,uuid,uuid,text)'),
  ('public.rpc_reconcile_payroll_export(uuid,uuid,uuid,text,text)'),
  ('public.rpc_get_payroll_export_reservation(uuid,uuid,uuid)'),
  ('public.rpc_reset_pin(uuid,uuid,text,text,text,integer)'),
  ('public.rpc_preview_payroll(uuid,uuid,text,integer)'),
  ('public.rpc_review_payroll(uuid,uuid,integer)'),
  ('public.rpc_finalize_payroll(uuid,uuid,integer)'),
  ('public.rpc_mark_payroll_paid(uuid,uuid,integer,text,text)'),
  ('public.rpc_void_payroll(uuid,uuid,integer,text)'),
  ('public.rpc_initialize_stock_reference(uuid,uuid,integer,uuid,text)'),
  ('public.rpc_get_opening_reference(uuid,uuid)'),
  ('public.rpc_update_settings(uuid,uuid,integer,jsonb)'),
  ('public.rpc_create_item(uuid,uuid,text,public.area_code,text,text,smallint,numeric)'),
  ('public.rpc_update_item(uuid,uuid,text,text,text,smallint,numeric)'),
  ('public.rpc_archive_item(uuid,uuid,text,text)'),
  ('public.rpc_save_roster(uuid,uuid,uuid,integer,date,text,uuid,public.area_code,text,text)'),
  ('public.rpc_complete_assignment(uuid,uuid,uuid,integer)'),
  ('public.rpc_update_user(uuid,uuid,uuid,integer,text,public.app_role,text)'),
  ('public.rpc_deactivate_user(uuid,uuid,uuid,integer,text)'),
  ('public.rpc_request_attendance_correction(uuid,uuid,uuid,text,jsonb,text)'),
  ('public.rpc_review_attendance_correction(uuid,uuid,uuid,text,text)'),
  ('public.rpc_request_leave(uuid,uuid,uuid,date,date,text,text)'),
  ('public.rpc_cancel_leave(uuid,uuid,uuid)'),
  ('public.rpc_review_leave(uuid,uuid,uuid,text,text)'),
  ('public.rpc_review_overtime(uuid,uuid,uuid,integer,text,text)'),
  ('public.rpc_correct_stock_movement(uuid,uuid,uuid,integer,uuid,public.movement_direction,text,numeric,uuid,text)'),
  ('public.rpc_complete_onboarding(uuid,uuid,integer)'),
  ('public.rpc_replay_onboarding(uuid,uuid,integer)'),
  ('public.enforce_hr_request_state()'),
  ('public.rpc_cleanup_runtime_data()'),
  ('public.rpc_issue_login_session(uuid,uuid,integer,text,text,timestamp with time zone,timestamp with time zone,text,text,text)'),
  ('public.rpc_list_sessions(uuid,uuid)'),
  ('public.rpc_revoke_sessions(uuid,uuid,uuid[],integer[],uuid)'),
  ('public.rpc_save_opening_draft(uuid,uuid,integer,uuid,jsonb)'),
  ('public.rpc_save_closing_draft(uuid,uuid,integer,uuid,jsonb)'),
  ('public.rpc_get_stock_drafts(uuid,uuid,uuid)'),
  ('public.rpc_get_report(uuid,uuid,date)'),
  ('public.rpc_save_report_finance(uuid,uuid,date,integer,uuid,jsonb)'),
  ('public.rpc_share_report(uuid,uuid,integer,uuid,text,uuid)'),
  ('public.rpc_adjust_payroll_entry(uuid,uuid,integer,text,numeric,text,uuid)'),
  ('public.rpc_review_payroll_adjustment(uuid,uuid,integer,integer,text,text,uuid)'),
  ('public.rpc_emergency_checkout(uuid,uuid,integer,uuid,text)'),
  ('public.rpc_get_payroll_export_download(uuid,uuid,integer,uuid)'),
  ('public.rpc_operator_create_item(uuid,uuid,text,public.area_code,text,text,smallint,numeric)'),
  ('public.rpc_operator_archive_item(uuid,uuid,text,text)'),
  ('public.rpc_checklist_layout_get(uuid,uuid,public.area_code)'),
  ('public.rpc_checklist_section_upsert(uuid,uuid,public.area_code,uuid,text,uuid)'),
  ('public.rpc_checklist_item_move(uuid,uuid,public.area_code,text,uuid,integer,integer,uuid)'),
  ('public.rpc_self_emergency_checkout(uuid,uuid,integer,uuid,text)'),
  ('public.rpc_rate_limit_public_options(text)'),
  ('public.rpc_catalog_get(uuid,uuid,public.area_code)'),
  ('public.rpc_catalog_apply(uuid,uuid,public.area_code,integer,jsonb,jsonb,jsonb,text,uuid)'),
  ('public.rpc_get_cycle_physical_baseline(uuid,uuid,uuid)'),
  ('public.rpc_record_cycle_physical_baseline(uuid,uuid,uuid,integer,jsonb,text,uuid)');

select ok(
  bool_and(to_regprocedure(signature) is not null),
  'protected functions resolve by exact regprocedure signature'
)
from required_functions;

select ok(
  exists (select 1 from pg_class where oid = 'public.pending_catalogs'::regclass and relrowsecurity)
  and exists (select 1 from pg_class where oid = 'public.pending_catalog_ops'::regclass and relrowsecurity),
  'pending catalog tables are RLS protected'
);

select ok(
  exists (select 1 from pg_class where oid = 'public.cycle_physical_baselines'::regclass and relrowsecurity)
  and exists (select 1 from pg_class where oid = 'public.cycle_physical_baseline_lines'::regclass and relrowsecurity)
  and exists (select 1 from pg_class where oid = 'public.cycle_opening_references'::regclass and relrowsecurity),
  'physical baseline and frozen reference tables are RLS protected'
);

select ok(
  exists (select 1 from pg_class where oid = 'public.payroll_export_reservations'::regclass and relrowsecurity)
  and exists (select 1 from pg_index where indexrelid = 'public.payroll_export_reservations_reconcile_idx'::regclass),
  'payroll export reservation table is private and indexed for reconciliation'
);

select ok(
  not has_function_privilege('anon', 'public.rpc_record_cycle_physical_baseline(uuid,uuid,uuid,integer,jsonb,text,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.rpc_record_cycle_physical_baseline(uuid,uuid,uuid,integer,jsonb,text,uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.rpc_record_cycle_physical_baseline(uuid,uuid,uuid,integer,jsonb,text,uuid)', 'EXECUTE'),
  'physical baseline recorder is callable only by service_role'
);

select ok(
  pg_get_functiondef('public.rpc_self_emergency_checkout(uuid,uuid,integer,uuid,text)'::regprocedure)
    like '%request is canonical before attendance lookup%',
  'self emergency resolves completed idempotency receipts before attendance lookup'
);

select ok(
  not has_function_privilege('anon', 'public.rpc_catalog_get(uuid,uuid,public.area_code)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.rpc_catalog_apply(uuid,uuid,public.area_code,integer,jsonb,jsonb,jsonb,text,uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.rpc_catalog_apply(uuid,uuid,public.area_code,integer,jsonb,jsonb,jsonb,text,uuid)', 'EXECUTE'),
  'catalog RPCs are callable only by service_role'
);

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
  ('public.onboarding_progress'),
  ('public.stock_reference_initializations'), ('public.stock_reference_initialization_lines'),
  ('public.workflow_idempotency'), ('public.stock_opening_drafts'),
  ('public.stock_closing_drafts'), ('public.daily_report_finance_drafts'),
  ('public.daily_report_shares'), ('public.payroll_export_download_authorizations'),
   ('public.pending_catalogs'), ('public.pending_catalog_ops'),
   ('public.cycle_opening_references'), ('public.cycle_opening_reference_lines'),
   ('public.cycle_physical_baselines'), ('public.cycle_physical_baseline_lines'),
   ('public.payroll_export_reservations');

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
  coalesce((
    select count(*) = 1
      and bool_and(
        trigger.tgname = 'trg_payroll_adjustments_parent_state'
        and trigger.tgenabled = 'O'
        and function.proname = 'enforce_payroll_adjustment_state'
      )
    from pg_trigger trigger
    join pg_proc function on function.oid = trigger.tgfoid
    where trigger.tgrelid = 'public.payroll_adjustments'::regclass
      and not trigger.tgisinternal
  ), false),
  'payroll adjustments has one enabled state trigger'
);

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

select throws_ok(
  $$select public.rpc_complete_onboarding(
    'bbbbbbbb-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    1
  )$$,
  '42501',
  'FORBIDDEN_ROLE: Guided onboarding hanya untuk OPERATOR.',
  'INVESTOR cannot complete onboarding'
);

select is(
  (public.rpc_complete_onboarding(
    'bbbbbbbb-0000-0000-0000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    1
  )->>'idempotent_replay')::boolean,
  false,
  'OPERATOR completes onboarding for the first time with idempotent_replay: false'
);

select is(
  (public.rpc_complete_onboarding(
    'bbbbbbbb-0000-0000-0000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    99
  )->>'idempotent_replay')::boolean,
  true,
  'B04 Lifetime: OPERATOR receives idempotent_replay: true even with different version'
);

select throws_ok(
  $$select public.rpc_create_item(
    'bbbbbbbb-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'tap-item-x', 'BAR'::public.area_code, 'Tap Item', 'pcs', 2::smallint, 0::numeric
  )$$,
  '42501',
  'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat membuat item.',
  'INVESTOR cannot create catalog items (B01)'
);

select throws_ok(
  $$select public.rpc_checklist_layout_get(
    'bbbbbbbb-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'BAR'
  )$$,
  '42501',
  'FORBIDDEN_ROLE: Investor tidak memiliki jalur operasional.',
  'INVESTOR cannot read checklist layout'
);

select throws_ok(
  $$select public.rpc_operator_archive_item(
    'bbbbbbbb-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'tap-item-x', 'tap reason'
  )$$,
  '42501',
  'FORBIDDEN_ROLE: Jalur ini hanya untuk OPERATOR PRIMARY.',
  'INVESTOR cannot use PRIMARY-scoped archive (B07)'
);

select throws_ok(
  $$select public.rpc_self_emergency_checkout(
    'bbbbbbbb-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    1, 'aaaaaaaa-0000-0000-0000-000000000001', 'tap reason'
  )$$,
  '42501',
  'FORBIDDEN_ROLE: Check-out darurat mandiri hanya untuk Operator.',
  'INVESTOR cannot use self emergency checkout (B05)'
);

select throws_ok(
  $$select public.rpc_self_emergency_checkout(
    'bbbbbbbb-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    0, 'aaaaaaaa-0000-0000-0000-000000000001', 'tap reason'
  )$$,
  '22023',
  'INVALID_EMERGENCY_CHECKOUT: Version, reason, dan idempotency key wajib valid.',
  'Self emergency checkout rejects invalid version payload (B05)'
);

select * from finish();
rollback;
