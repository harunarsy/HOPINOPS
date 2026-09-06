-- HOPIN Production Migration 0017: Missing Enforcement Wiring and Emergency Assignment State
--
-- 0015/0016 are already applied to staging, so corrections are additive here.
-- 1. Attach enforce_payroll_adjustment_state() to payroll_adjustments.
-- 2. Correct rpc_share_report recipient error text to the enforced INVESTOR-only rule.
-- 3. Make rpc_emergency_checkout move a linked ACTIVE assignment to PENDING_TASKS
--    atomically with the emergency CHECK_OUT evidence.

drop trigger if exists trg_payroll_adjustments_state on public.payroll_adjustments;
create trigger trg_payroll_adjustments_state
before insert or update or delete on public.payroll_adjustments
for each row execute function public.enforce_payroll_adjustment_state();

create or replace function public.rpc_share_report(
  p_actor_id uuid,
  p_revision_id uuid,
  p_expected_report_version integer,
  p_recipient_id uuid,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_report public.daily_reports%rowtype;
  v_revision public.daily_report_revisions%rowtype;
  v_share public.daily_report_shares%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_reason text := nullif(btrim(p_reason), '');
  v_existing boolean := false;
begin
  if p_revision_id is null or p_recipient_id is null or p_recipient_id = p_actor_id
     or p_expected_report_version is null or p_expected_report_version <= 0
     or p_idempotency_key is null or length(coalesce(v_reason, '')) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_SHARE: Revision, recipient lain, version, reason, dan idempotency key wajib valid.';
  end if;

  select * into v_revision from public.daily_report_revisions where id = p_revision_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Revisi laporan tidak ditemukan.';
  end if;
  select * into v_report from public.daily_reports where id = v_revision.report_id for update;
  v_role := public.require_authorized_actor(p_actor_id, v_report.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya manager dapat membagikan laporan.';
  end if;

  v_request := jsonb_build_object(
    'revision_id', p_revision_id, 'expected_report_version', p_expected_report_version,
    'recipient_id', p_recipient_id, 'reason', v_reason
  );
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, v_report.outlet_id, 'SHARE_REPORT', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = v_report.outlet_id
    and action = 'SHARE_REPORT' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  if v_report.version <> p_expected_report_version then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected report version %s, current version %s.', p_expected_report_version, v_report.version);
  end if;
  if v_report.status <> 'APPROVED'
     or v_revision.status <> 'APPROVED'
     or v_report.current_revision <> v_revision.revision then
    raise exception using errcode = '55000', message = 'REPORT_NOT_APPROVED: Hanya revisi laporan terkini yang APPROVED dapat dibagikan.';
  end if;
  if not exists (
    select 1
    from public.profiles profile
    join public.profile_outlet_scopes scope
      on scope.profile_id = profile.id and scope.outlet_id = v_report.outlet_id and scope.active is true
    where profile.id = p_recipient_id
      and profile.active is true and profile.deactivated_at is null and profile.force_pin_change is false
      and profile.role::text = 'INVESTOR'
  ) then
    raise exception using errcode = '42501', message = 'INVALID_RECIPIENT: Recipient harus investor aktif dengan scope outlet.';
  end if;

  select * into v_share
  from public.daily_report_shares
  where revision_id = p_revision_id and recipient_id = p_recipient_id
  for update;
  if found then
    v_existing := true;
  else
    insert into public.daily_report_shares (revision_id, recipient_id, shared_by, reason)
    values (p_revision_id, p_recipient_id, p_actor_id, v_reason)
    returning * into v_share;
  end if;

  v_response := jsonb_build_object(
    'share_id', v_share.id, 'revision_id', v_share.revision_id,
    'recipient_id', v_share.recipient_id, 'shared_at', v_share.shared_at,
    'already_shared', v_existing
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = clock_timestamp()
  where actor_user_id = p_actor_id and outlet_id = v_report.outlet_id
    and action = 'SHARE_REPORT' and idempotency_key = p_idempotency_key;
  if not v_existing then
    perform public.log_audit_event(
      p_actor_id, 'SHARE_REPORT', 'daily_report_shares', v_share.id::text,
      v_report.outlet_id, p_recipient_id, null, v_response, v_reason
    );
  end if;
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

create or replace function public.rpc_emergency_checkout(
  p_actor_id uuid,
  p_attendance_id uuid,
  p_expected_attendance_version integer,
  p_idempotency_key uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_subject_role public.app_role;
  v_attendance public.attendance_records%rowtype;
  v_assignment public.work_assignments%rowtype;
  v_event public.attendance_events%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_before jsonb;
  v_reason text := nullif(btrim(p_reason), '');
  v_now timestamptz := clock_timestamp();
begin
  if p_attendance_id is null or p_expected_attendance_version is null or p_expected_attendance_version <= 0
     or p_idempotency_key is null or v_reason is null or length(v_reason) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_EMERGENCY_CHECKOUT: Attendance, version, reason, dan idempotency key wajib valid.';
  end if;

  select * into v_attendance from public.attendance_records where id = p_attendance_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Attendance tidak ditemukan.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, v_attendance.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Emergency checkout memerlukan manager.';
  end if;
  select role into v_subject_role from public.profiles where id = v_attendance.profile_id;
  if p_actor_id = v_attendance.profile_id
     or (v_role::text = 'SUPERVISOR' and v_subject_role::text <> 'OPERATOR') then
    raise exception using errcode = '42501', message = 'SELF_REVIEW_FORBIDDEN: Manager tidak dapat emergency checkout diri sendiri atau manager lain.';
  end if;

  v_request := jsonb_build_object(
    'attendance_id', p_attendance_id, 'expected_attendance_version', p_expected_attendance_version,
    'reason', v_reason
  );
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, v_attendance.outlet_id, 'EMERGENCY_CHECKOUT', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = v_attendance.outlet_id
    and action = 'EMERGENCY_CHECKOUT' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  if v_attendance.version <> p_expected_attendance_version then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected attendance version %s, current version %s.', p_expected_attendance_version, v_attendance.version);
  end if;
  if v_attendance.status not in ('CHECKED_IN', 'REVIEW_REQUIRED')
     or v_attendance.check_in_event_id is null
     or v_attendance.check_out_event_id is not null then
    raise exception using errcode = '55000', message = 'INVALID_ATTENDANCE_STATE: Emergency checkout memerlukan check-in terbuka.';
  end if;

  v_before := jsonb_build_object('status', v_attendance.status, 'version', v_attendance.version);
  insert into public.attendance_events (
    attendance_id, event_type, server_occurred_at, client_occurred_at,
    challenge_id, device_id, ip_country, location_status,
    selected_distance_m, selected_accuracy_m, risk_score, risk_reasons,
    note, idempotency_key, created_at
  ) values (
    v_attendance.id, 'CHECK_OUT', v_now, null,
    null, null, null, 'UNAVAILABLE',
    null, null, 100, jsonb_build_array('EMERGENCY_CHECKOUT'),
    v_reason, p_idempotency_key::text, v_now
  ) returning * into v_event;

  update public.attendance_records
  set status = 'REVIEW_REQUIRED',
      check_out_event_id = v_event.id,
      exception_status = 'PENDING_REVIEW',
      version = version + 1,
      updated_at = v_now
  where id = v_attendance.id
  returning * into v_attendance;

  if v_attendance.work_assignment_id is not null then
    update public.work_assignments
    set status = 'PENDING_TASKS',
        version = version + 1
    where id = v_attendance.work_assignment_id
      and profile_id = v_attendance.profile_id
      and status = 'ACTIVE'
    returning * into v_assignment;
  end if;

  v_response := jsonb_build_object(
    'attendance_id', v_attendance.id, 'event_id', v_event.id,
    'status', v_attendance.status, 'exception_status', v_attendance.exception_status,
    'version', v_attendance.version
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = v_now
  where actor_user_id = p_actor_id and outlet_id = v_attendance.outlet_id
    and action = 'EMERGENCY_CHECKOUT' and idempotency_key = p_idempotency_key;
  perform public.log_audit_event(
    p_actor_id, 'EMERGENCY_CHECKOUT', 'attendance_records', v_attendance.id::text,
    v_attendance.outlet_id, v_attendance.profile_id, v_before,
    v_response || jsonb_build_object(
      'assignment_id', v_assignment.id,
      'assignment_status', v_assignment.status,
      'assignment_version', v_assignment.version
    ),
    v_reason
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

revoke execute on function public.rpc_share_report(uuid, uuid, integer, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_emergency_checkout(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.rpc_share_report(uuid, uuid, integer, uuid, text, uuid) to service_role;
grant execute on function public.rpc_emergency_checkout(uuid, uuid, integer, uuid, text) to service_role;
