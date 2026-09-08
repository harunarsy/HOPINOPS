-- 0024: reserve the self-service command before looking up mutable attendance.
-- The unique workflow row is also the serialization point for concurrent retries.

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
begin
  if p_actor_id is null or p_outlet_id is null or p_expected_attendance_version is null
     or p_expected_attendance_version <= 0 or p_idempotency_key is null
     or v_reason is null or length(v_reason) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_EMERGENCY_CHECKOUT: Version, reason, dan idempotency key wajib valid.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Check-out darurat mandiri hanya untuk Operator.';
  end if;

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

revoke execute on function public.rpc_self_emergency_checkout(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.rpc_self_emergency_checkout(uuid, uuid, integer, uuid, text) to service_role;
