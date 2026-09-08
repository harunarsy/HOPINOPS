-- 0026: audit hardening for 0022-0025 (no signature changes, no data rewrite).
-- 1. rpc_reconcile_payroll_export: reject NULL/empty observed_state explicitly and
--    only treat an explicit 'PRESENT' as confirmed upload (0025 audit CRITICAL).
-- 2. rpc_catalog_apply: full-catalog apply is Owner/Supervisor-only; PRIMARY keeps
--    the scoped checklist RPCs (B01/B07).
-- 3. rpc_get_cycle_physical_baseline / rpc_get_opening_reference: Owner, Supervisor,
--    or ACTIVE PRIMARY of the same cycle; Investor/HELPER have no read path (B07).
-- 4. rpc_self_emergency_checkout: replay lookup before command role check, and abort
--    when the assignment cannot reach PENDING_TASKS (B05).
-- 5. pending_catalogs: reject snapshots with zero active items so the next cycle
--    can always be opened (dead-end guard).

-- 1. Reconcile: explicit state handling.
create or replace function public.rpc_reconcile_payroll_export(
  p_actor_id uuid, p_reservation_id uuid, p_upload_token uuid,
  p_observed_state text, p_artifact_checksum_sha256 text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res public.payroll_export_reservations%rowtype;
  v_role public.app_role;
  v_run public.payroll_runs%rowtype;
  v_state text := upper(nullif(btrim(p_observed_state), ''));
  v_checksum text := lower(nullif(btrim(p_artifact_checksum_sha256), ''));
begin
  if p_actor_id is null or p_reservation_id is null or p_upload_token is null
     or v_state is null
     or v_state not in ('UNKNOWN', 'ABSENT', 'PRESENT')
     or (v_state in ('UNKNOWN', 'PRESENT') and v_checksum is null)
     or (v_checksum is not null and v_checksum !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION: Lease, state, dan checksum wajib valid.';
  end if;
  select * into v_res from public.payroll_export_reservations where id = p_reservation_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: Reservation export tidak ditemukan.'; end if;
  v_role := public.require_authorized_actor(p_actor_id, v_res.outlet_id);
  if v_res.actor_id <> p_actor_id or v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Reservation bukan milik actor.';
  end if;
  if v_res.status = 'COMMITTED' then
    return jsonb_build_object('reservation_id', v_res.id, 'final_export_id', v_res.final_export_id,
      'status', v_res.status, 'artifact_checksum_sha256', v_res.artifact_checksum_sha256);
  end if;
  if v_res.status not in ('IN_PROGRESS', 'UPLOAD_UNKNOWN') or v_res.upload_token <> p_upload_token then
    raise exception using errcode = '55000', message = 'UPLOAD_LEASE_MISMATCH: Caller tidak memiliki lease reservation.';
  end if;
  if v_state = 'UNKNOWN' then
    if v_res.status <> 'IN_PROGRESS' then
      return jsonb_build_object('reservation_id', v_res.id, 'final_export_id', v_res.final_export_id, 'status', v_res.status);
    end if;
    update public.payroll_export_reservations set status = 'UPLOAD_UNKNOWN',
      pending_artifact_checksum_sha256 = v_checksum, upload_lease_expires_at = null,
      updated_at = clock_timestamp() where id = v_res.id;
  elsif v_state = 'ABSENT' then
    update public.payroll_export_reservations set status = 'ABANDONED', upload_token = null,
      upload_lease_expires_at = null, pending_artifact_checksum_sha256 = null,
      updated_at = clock_timestamp() where id = v_res.id;
  elsif v_state = 'PRESENT' then
    if v_res.pending_artifact_checksum_sha256 is not null
       and v_res.pending_artifact_checksum_sha256 <> v_checksum then
      raise exception using errcode = '55000', message = 'ARTIFACT_CHECKSUM_MISMATCH: Object tidak cocok dengan artifact reservation.';
    end if;
    select * into v_run from public.payroll_runs where id = v_res.run_id for update;
    if v_run.version <> v_res.expected_run_version or v_run.status <> v_res.run_status then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT: Payroll run berubah sejak reservation.';
    end if;
    insert into public.payroll_exports(id, run_id, format, file_path, checksum_sha256, generated_by, row_counts)
      values (v_res.final_export_id, v_res.run_id, 'XLSX', v_res.file_path, v_checksum, p_actor_id, v_res.row_counts);
    update public.payroll_export_reservations set status = 'COMMITTED', artifact_checksum_sha256 = v_checksum,
      pending_artifact_checksum_sha256 = null, upload_token = null, upload_lease_expires_at = null,
      updated_at = clock_timestamp() where id = v_res.id;
    perform public.log_audit_event(p_actor_id, 'RECONCILE_PAYROLL_EXPORT', 'payroll_exports', v_res.final_export_id::text,
      v_res.outlet_id, null, null, jsonb_build_object('reservation_id', v_res.id, 'run_id', v_res.run_id,
        'evidence_checksum_sha256', v_res.evidence_checksum_sha256));
  else
    raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION: Status observasi tidak dikenali.';
  end if;
  select * into v_res from public.payroll_export_reservations where id = v_res.id;
  return jsonb_build_object('reservation_id', v_res.id, 'final_export_id', v_res.final_export_id,
    'status', v_res.status, 'artifact_checksum_sha256', v_res.artifact_checksum_sha256);
end;
$$;

-- 2. Full-catalog apply: Owner/Supervisor-only.
create or replace function public.rpc_catalog_apply(
  p_actor uuid,
  p_outlet uuid,
  p_area public.area_code,
  p_expected_version integer,
  p_items jsonb,
  p_sections jsonb,
  p_placements jsonb,
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
begin
  v_role := public.require_authorized_actor(p_actor, p_outlet);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Katalog penuh hanya untuk Owner atau Supervisor; PRIMARY memakai jalur checklist area tugas.';
  end if;
  return public.pending_catalog_apply_internal(
    p_actor,
    p_outlet,
    p_area,
    p_expected_version,
    p_items,
    p_sections,
    p_placements,
    'APPLY_CATALOG',
    p_reason,
    p_idempotency_key,
    null
  );
end;
$$;

-- 3a. Physical baseline read: Owner/Supervisor or ACTIVE PRIMARY of the cycle.
create or replace function public.rpc_get_cycle_physical_baseline(
  p_actor_id uuid, p_outlet_id uuid, p_cycle_id uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.work_cycles%rowtype; b public.cycle_physical_baselines%rowtype;
  v_role public.app_role;
begin
  select * into c from public.work_cycles where id=p_cycle_id and outlet_id=p_outlet_id;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND: Cycle tidak ditemukan.'; end if;
  v_role := public.require_authorized_actor(p_actor_id,p_outlet_id);
  if v_role::text not in ('OWNER','SUPERVISOR') and not exists(
    select 1 from public.work_assignments assignment
    where assignment.cycle_id = p_cycle_id and assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY' and assignment.status = 'ACTIVE'
  ) then
    raise exception using errcode='42501',message='FORBIDDEN: Baseline fisik hanya untuk Owner, Supervisor, atau PRIMARY cycle.';
  end if;
  select * into b from public.cycle_physical_baselines where cycle_id=p_cycle_id;
  if not found then return jsonb_build_object('cycle_id',p_cycle_id,'state','REQUIRED','lines','[]'::jsonb); end if;
  return jsonb_build_object('cycle_id',p_cycle_id,'state','AVAILABLE','baseline_id',b.id,
    'lines',coalesce((select jsonb_agg(jsonb_build_object('item_id',item_id,'counted_qty',counted_qty) order by item_id)
      from public.cycle_physical_baseline_lines where baseline_id=b.id),'[]'::jsonb));
end; $$;

-- 3b. Opening reference read: same scope as the baseline it may expose.
create or replace function public.rpc_get_opening_reference(p_cycle_id uuid,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.work_cycles%rowtype; result jsonb; v_role public.app_role;
begin
  select * into c from public.work_cycles where id=p_cycle_id;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND: Work cycle tidak ditemukan.'; end if;
  v_role := public.require_authorized_actor(p_actor_id,c.outlet_id);
  if v_role::text not in ('OWNER','SUPERVISOR') and not exists(
    select 1 from public.work_assignments assignment
    where assignment.cycle_id = p_cycle_id and assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY' and assignment.status = 'ACTIVE'
  ) then
    raise exception using errcode='42501',message='FORBIDDEN: Referensi opening hanya untuk Owner, Supervisor, atau PRIMARY cycle.';
  end if;
  result:=public.resolve_cycle_opening_reference(p_cycle_id);
  return result;
end; $$;

-- 4. Self emergency: replay before command role check; assignment must land PENDING_TASKS.
create or replace function public.rpc_self_emergency_checkout(
  p_actor_id uuid, p_outlet_id uuid, p_expected_attendance_version integer,
  p_idempotency_key uuid, p_reason text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role public.app_role; v_attendance public.attendance_records%rowtype;
  v_event public.attendance_events%rowtype; v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb; v_response jsonb; v_before jsonb;
  v_reason text := nullif(btrim(p_reason), ''); v_now timestamptz := clock_timestamp();
  v_today date := (v_now at time zone 'Asia/Jakarta')::date;
  v_rows integer; v_assignment_status text;
begin
  if p_actor_id is null or p_outlet_id is null or p_expected_attendance_version is null
     or p_expected_attendance_version <= 0 or p_idempotency_key is null
     or v_reason is null or length(v_reason) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_EMERGENCY_CHECKOUT: Version, reason, dan idempotency key wajib valid.';
  end if;
  -- Authenticate actor and outlet access first. The command-specific OPERATOR
  -- role is enforced after the replay lookup so a completed receipt stays
  -- retrievable even if the actor role changed afterwards.
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);

  -- The request is canonical before attendance lookup; attendance_id is mutable
  -- lookup output and is intentionally not part of the new request payload.
  v_request := jsonb_build_object(
    'expected_attendance_version', p_expected_attendance_version,
    'reason', v_reason
  );
  insert into public.workflow_idempotency(actor_user_id, outlet_id, action, idempotency_key, request_json)
  values (p_actor_id, p_outlet_id, 'SELF_EMERGENCY_CHECKOUT', p_idempotency_key,
          v_request)
  on conflict (actor_user_id, outlet_id, action, idempotency_key) do nothing;
  select * into v_idempotency from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = p_outlet_id
    and action = 'SELF_EMERGENCY_CHECKOUT' and idempotency_key = p_idempotency_key
  for update;
  -- Existing 0021 rows may contain attendance_id. Allow that one legacy field,
  -- while rejecting unknown fields and mismatched known values.
  if (v_idempotency.request_json - 'attendance_id') is distinct from v_request
     or v_idempotency.request_json->>'expected_attendance_version' is distinct from p_expected_attendance_version::text
     or v_idempotency.request_json->>'reason' is distinct from v_reason then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  if v_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Check-out darurat mandiri hanya untuk Operator.';
  end if;

  select * into v_attendance from public.attendance_records
  where profile_id = p_actor_id and outlet_id = p_outlet_id and work_date = v_today
    and check_out_event_id is null order by created_at desc, id desc limit 1 for update;
  if not found then
    raise exception using errcode = '55000', message = 'NO_OPEN_ATTENDANCE: Tidak ada check-in terbuka hari ini. Bila check-out sudah tercatat tetapi assignment belum selesai, gunakan pemulihan penyelesaian assignment.';
  end if;
  if v_attendance.version <> p_expected_attendance_version then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected attendance version %s, current version %s.', p_expected_attendance_version, v_attendance.version);
  end if;
  if v_attendance.status not in ('CHECKED_IN', 'REVIEW_REQUIRED') or v_attendance.check_in_event_id is null then
    raise exception using errcode = '55000', message = 'INVALID_ATTENDANCE_STATE: Check-out darurat mandiri memerlukan check-in terbuka.';
  end if;

  v_before := jsonb_build_object('status', v_attendance.status, 'version', v_attendance.version);
  insert into public.attendance_events(
    attendance_id, event_type, server_occurred_at, challenge_id, device_id, ip_country,
    location_status, selected_distance_m, selected_accuracy_m, risk_score, risk_reasons,
    note, idempotency_key, created_at
  ) values (v_attendance.id, 'CHECK_OUT', v_now, null, null, null, 'UNAVAILABLE', null, null,
    100, jsonb_build_array('SELF_EMERGENCY_CHECKOUT'), v_reason, p_idempotency_key::text, v_now)
  returning * into v_event;
  update public.attendance_records
  set status = 'REVIEW_REQUIRED', check_out_event_id = v_event.id, exception_status = 'PENDING_REVIEW',
      version = version + 1, updated_at = v_now
  where id = v_attendance.id returning * into v_attendance;
  if v_attendance.work_assignment_id is not null then
    update public.work_assignments set status = 'PENDING_TASKS', version = version + 1
    where id = v_attendance.work_assignment_id and profile_id = p_actor_id and status = 'ACTIVE';
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      select status into v_assignment_status from public.work_assignments
      where id = v_attendance.work_assignment_id;
      if v_assignment_status is distinct from 'PENDING_TASKS' then
        raise exception using errcode = '55000', message = 'ASSIGNMENT_STATE_CONFLICT: Assignment tidak lagi aktif dan belum PENDING_TASKS; check-out darurat dibatalkan.';
      end if;
    end if;
  end if;
  v_response := jsonb_build_object('attendance_id', v_attendance.id, 'event_id', v_event.id,
    'status', v_attendance.status, 'exception_status', v_attendance.exception_status, 'version', v_attendance.version);
  update public.workflow_idempotency set response_json = v_response, completed_at = v_now
  where actor_user_id = p_actor_id and outlet_id = p_outlet_id
    and action = 'SELF_EMERGENCY_CHECKOUT' and idempotency_key = p_idempotency_key;
  perform public.log_audit_event(p_actor_id, 'SELF_EMERGENCY_CHECKOUT', 'attendance_records', v_attendance.id::text,
    p_outlet_id, p_actor_id, v_before, v_response, v_reason);
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

-- 5. Dead-end guard: a pending snapshot must keep at least one active item.
create or replace function public.enforce_pending_catalog_nonempty()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_active integer;
begin
  select count(*) into v_active
  from jsonb_array_elements(new.items_json) item
  where (item->>'active')::boolean is true;
  if coalesce(v_active, 0) < 1 then
    raise exception using errcode = '22023', message = 'INVALID_CATALOG: Katalog wajib memiliki minimal satu item aktif agar cycle berikutnya dapat dibuka.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pending_catalogs_nonempty on public.pending_catalogs;
create trigger trg_pending_catalogs_nonempty
before insert or update of items_json on public.pending_catalogs
for each row execute function public.enforce_pending_catalog_nonempty();

-- Preserve service_role-only execution on touched RPCs.
revoke all on function public.rpc_reconcile_payroll_export(uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.rpc_reconcile_payroll_export(uuid,uuid,uuid,text,text) to service_role;
revoke all on function public.rpc_catalog_apply(uuid,uuid,public.area_code,integer,jsonb,jsonb,jsonb,text,uuid) from public, anon, authenticated;
grant execute on function public.rpc_catalog_apply(uuid,uuid,public.area_code,integer,jsonb,jsonb,jsonb,text,uuid) to service_role;
revoke all on function public.rpc_get_cycle_physical_baseline(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.rpc_get_cycle_physical_baseline(uuid,uuid,uuid) to service_role;
revoke all on function public.rpc_get_opening_reference(uuid,uuid) from public, anon, authenticated;
grant execute on function public.rpc_get_opening_reference(uuid,uuid) to service_role;
revoke all on function public.rpc_self_emergency_checkout(uuid,uuid,integer,uuid,text) from public, anon, authenticated;
grant execute on function public.rpc_self_emergency_checkout(uuid,uuid,integer,uuid,text) to service_role;
