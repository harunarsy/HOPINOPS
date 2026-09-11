-- HOPIN v0.3: per-operator onboarding reset events.
--
-- A reset is an append-only request. It never changes authentication, PIN,
-- device, assignment, attendance, or stock records. When the target is still
-- working, the event remains deferred until the active assignment/attendance
-- is finished.

create table if not exists public.onboarding_reset_events (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  onboarding_version integer not null check (onboarding_version > 0),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  deferred_until_assignment_id uuid references public.work_assignments(id) on delete restrict
);

alter table public.onboarding_reset_events enable row level security;

revoke all on public.onboarding_reset_events from public, anon, authenticated;
grant all on public.onboarding_reset_events to service_role;

create index if not exists onboarding_reset_events_profile_latest_idx
  on public.onboarding_reset_events (outlet_id, profile_id, requested_at desc, id desc);

drop trigger if exists trg_onboarding_reset_events_append_only on public.onboarding_reset_events;
create trigger trg_onboarding_reset_events_append_only
before update or delete on public.onboarding_reset_events
for each row execute function public.enforce_append_only();

-- Only the trusted API may request a reset. The target must be an active
-- operator in the same outlet as the requesting supervisor/owner.
create or replace function public.rpc_request_onboarding_reset(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_target_profile_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role public.app_role;
  v_target public.profiles%rowtype;
  v_onboarding_version integer;
  v_assignment_id uuid;
  v_deferred boolean := false;
  v_event public.onboarding_reset_events%rowtype;
  v_effective text;
  v_now timestamptz := clock_timestamp();
begin
  if p_target_profile_id is null or nullif(btrim(p_reason), '') is null
     or char_length(btrim(p_reason)) > 1000 then
    raise exception using errcode = '22023',
      message = 'INVALID_ARGUMENT: Target operator dan alasan reset wajib diisi.';
  end if;

  v_actor_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_actor_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501',
      message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat mereset tutorial.';
  end if;

  select settings.onboarding_version
    into v_onboarding_version
  from public.outlet_settings settings
  where settings.outlet_id = p_outlet_id
  for share;
  if v_onboarding_version is null then
    raise exception using errcode = 'P0002',
      message = 'NOT_FOUND: Versi onboarding outlet tidak ditemukan.';
  end if;

  select profile.*
    into v_target
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id
   and scope.outlet_id = p_outlet_id
   and scope.active is true
  where profile.id = p_target_profile_id
    and profile.role = 'OPERATOR'
    and profile.active is true
    and profile.deactivated_at is null
  for update of profile;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'NOT_FOUND: Operator aktif pada outlet tidak ditemukan.';
  end if;

  -- Assignment and attendance are checked independently. This protects the
  -- case where a recovery flow has an active attendance without a normal
  -- assignment row, and prevents a tutorial jump during a live shift.
  select assignment.id
    into v_assignment_id
  from public.work_assignments assignment
  join public.work_cycles cycle on cycle.id = assignment.cycle_id
  where assignment.profile_id = p_target_profile_id
    and cycle.outlet_id = p_outlet_id
    and assignment.status in ('ACTIVE', 'PENDING_TASKS')
  order by assignment.assigned_at desc, assignment.id desc
  limit 1;

  v_deferred := v_assignment_id is not null
    or exists (
      select 1
      from public.attendance_records attendance
      where attendance.profile_id = p_target_profile_id
        and attendance.outlet_id = p_outlet_id
        and attendance.check_in_event_id is not null
        and attendance.check_out_event_id is null
    );

  insert into public.onboarding_reset_events (
    outlet_id, profile_id, onboarding_version, requested_by,
    requested_at, reason, deferred_until_assignment_id
  ) values (
    p_outlet_id, p_target_profile_id, v_onboarding_version, p_actor_id,
    v_now, btrim(p_reason), v_assignment_id
  ) returning * into v_event;

  v_effective := case when v_deferred then 'AFTER_SHIFT' else 'NEXT_BOOTSTRAP' end;

  perform public.log_audit_event(
    p_actor_id,
    'REQUEST_ONBOARDING_RESET',
    'onboarding_reset_events',
    v_event.id::text,
    p_outlet_id,
    p_target_profile_id,
    null,
    jsonb_build_object(
      'reset_id', v_event.id,
      'profile_id', p_target_profile_id,
      'onboarding_version', v_onboarding_version,
      'requested_at', v_event.requested_at,
      'effective', v_effective,
      'deferred_until_assignment_id', v_assignment_id
    ),
    btrim(p_reason)
  );

  return jsonb_build_object(
    'reset_id', v_event.id,
    'profile_id', v_event.profile_id,
    'onboarding_version', v_event.onboarding_version,
    'requested_at', v_event.requested_at,
    'effective', v_effective
  );
end;
$$;

-- Return a single server-authoritative projection for operator bootstrap and
-- onboarding.get. A reset is required only after the latest reset event is no
-- longer deferred and is newer than the latest completed tutorial.
create or replace function public.rpc_get_onboarding_state(
  p_actor_id uuid,
  p_outlet_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_onboarding_version integer;
  v_progress public.onboarding_progress%rowtype;
  v_progress_found boolean := false;
  v_latest_reset public.onboarding_reset_events%rowtype;
  v_reset_found boolean := false;
  v_reset_deferred boolean := false;
  v_active_assignment boolean := false;
  v_active_attendance boolean := false;
  v_reset_required boolean := false;
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501',
      message = 'FORBIDDEN_ROLE: Onboarding state hanya untuk OPERATOR.';
  end if;

  select settings.onboarding_version
    into v_onboarding_version
  from public.outlet_settings settings
  where settings.outlet_id = p_outlet_id;
  if v_onboarding_version is null then
    raise exception using errcode = 'P0002',
      message = 'NOT_FOUND: Versi onboarding outlet tidak ditemukan.';
  end if;

  -- B04 is preserved: the latest completed version is the normal projection.
  select * into v_progress
  from public.onboarding_progress progress
  where progress.profile_id = p_actor_id
    and progress.completed_at is not null
  order by progress.completed_at desc, progress.onboarding_version desc
  limit 1;
  v_progress_found := found;
  if not v_progress_found then
    select * into v_progress
    from public.onboarding_progress progress
    where progress.profile_id = p_actor_id
      and progress.onboarding_version = v_onboarding_version
    limit 1;
    v_progress_found := found;
  end if;

  select * into v_latest_reset
  from public.onboarding_reset_events reset_event
  where reset_event.outlet_id = p_outlet_id
    and reset_event.profile_id = p_actor_id
  order by reset_event.requested_at desc, reset_event.id desc
  limit 1;
  v_reset_found := found;

  if v_reset_found then
    select exists (
      select 1
      from public.work_assignments assignment
      join public.work_cycles cycle on cycle.id = assignment.cycle_id
      where assignment.profile_id = p_actor_id
        and cycle.outlet_id = p_outlet_id
        and assignment.status in ('ACTIVE', 'PENDING_TASKS')
    ) into v_active_assignment;

    select exists (
      select 1
      from public.attendance_records attendance
      where attendance.profile_id = p_actor_id
        and attendance.outlet_id = p_outlet_id
        and attendance.check_in_event_id is not null
        and attendance.check_out_event_id is null
    ) into v_active_attendance;

    -- Only a reset newer than the latest completion is pending. An operator
    -- may still be working after completing the replay; that active
    -- assignment must not make an already-applied reset look deferred.
    v_reset_deferred := (not v_progress_found
      or v_progress.completed_at is null
      or v_latest_reset.requested_at > v_progress.completed_at)
      and (v_active_assignment or v_active_attendance);
    v_reset_required := not v_reset_deferred
      and (not v_progress_found
        or v_progress.completed_at is null
        or v_latest_reset.requested_at > v_progress.completed_at);
  end if;

  return jsonb_build_object(
    'onboarding_version', v_onboarding_version,
    'progress', case when v_progress_found then to_jsonb(v_progress) else null end,
    'reset_required', v_reset_required,
    'reset_deferred', v_reset_deferred,
    'reset_requested_at', case when v_reset_found then v_latest_reset.requested_at else null end
  );
end;
$$;

-- Completion remains idempotent until a newer reset event exists. A completion
-- after reset reuses the current version row, increments replay_count, and
-- records before/after state in the audit log.
create or replace function public.rpc_complete_onboarding(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_onboarding_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_current_version integer;
  v_progress public.onboarding_progress%rowtype;
  v_progress_found boolean := false;
  v_last_completed public.onboarding_progress%rowtype;
  v_completion_found boolean := false;
  v_latest_reset public.onboarding_reset_events%rowtype;
  v_reset_found boolean := false;
  v_reset_deferred boolean := false;
  v_active_assignment boolean := false;
  v_active_attendance boolean := false;
  v_reset_applied boolean := false;
  v_before jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_onboarding_version is null or p_onboarding_version <= 0 then
    raise exception using errcode = '22023',
      message = 'INVALID_ARGUMENT: Onboarding version wajib positif.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501',
      message = 'FORBIDDEN_ROLE: Guided onboarding hanya untuk OPERATOR.';
  end if;

  perform 1 from public.profiles where id = p_actor_id for update;

  select settings.onboarding_version
    into v_current_version
  from public.outlet_settings settings
  where settings.outlet_id = p_outlet_id
  for share;
  if v_current_version is null then
    raise exception using errcode = 'P0002',
      message = 'NOT_FOUND: Pengaturan outlet tidak ditemukan.';
  end if;

  select * into v_last_completed
  from public.onboarding_progress progress
  where progress.profile_id = p_actor_id
    and progress.completed_at is not null
  order by progress.completed_at desc, progress.onboarding_version desc
  limit 1;
  v_completion_found := found;

  select * into v_latest_reset
  from public.onboarding_reset_events reset_event
  where reset_event.outlet_id = p_outlet_id
    and reset_event.profile_id = p_actor_id
  order by reset_event.requested_at desc, reset_event.id desc
  limit 1;
  v_reset_found := found;

  if v_reset_found then
    select exists (
      select 1
      from public.work_assignments assignment
      join public.work_cycles cycle on cycle.id = assignment.cycle_id
      where assignment.profile_id = p_actor_id
        and cycle.outlet_id = p_outlet_id
        and assignment.status in ('ACTIVE', 'PENDING_TASKS')
    ) into v_active_assignment;

    select exists (
      select 1
      from public.attendance_records attendance
      where attendance.profile_id = p_actor_id
        and attendance.outlet_id = p_outlet_id
        and attendance.check_in_event_id is not null
        and attendance.check_out_event_id is null
    ) into v_active_attendance;

    v_reset_deferred := v_active_assignment or v_active_attendance;
  end if;

  if v_completion_found
     and (not v_reset_found or v_latest_reset.requested_at <= v_last_completed.completed_at) then
    return to_jsonb(v_last_completed) || jsonb_build_object(
      'idempotent_replay', true,
      'reset_applied', false
    );
  end if;

  -- A deferred reset must never be consumed while the operator is working.
  -- The normal UI keeps this path unreachable, but the RPC also enforces the
  -- boundary for direct or replayed requests.
  if v_reset_found
     and v_reset_deferred
     and v_latest_reset.requested_at > coalesce(v_last_completed.completed_at, '-infinity'::timestamptz) then
    if v_completion_found then
      return to_jsonb(v_last_completed) || jsonb_build_object(
        'idempotent_replay', true,
        'reset_applied', false,
        'reset_deferred', true
      );
    end if;
    raise exception using errcode = '55000',
      message = 'RESET_DEFERRED: Tutorial baru dapat diselesaikan setelah assignment dan absensi aktif selesai.';
  end if;

  if v_current_version <> p_onboarding_version then
    raise exception using errcode = '40001',
      message = format('VERSION_CONFLICT: Current onboarding version is %s.', v_current_version::text);
  end if;

  select * into v_progress
  from public.onboarding_progress progress
  where progress.profile_id = p_actor_id
    and progress.onboarding_version = p_onboarding_version
  for update;
  v_progress_found := found;
  v_before := case when v_progress_found then to_jsonb(v_progress) else null end;

  v_reset_applied := v_reset_found
    and (not v_completion_found or v_latest_reset.requested_at > v_last_completed.completed_at);

  if not v_progress_found then
    insert into public.onboarding_progress (
      profile_id, onboarding_version, started_at, completed_at, replay_count, updated_at
    ) values (
      p_actor_id, p_onboarding_version, v_now, v_now,
      case when v_reset_applied then 1 else 0 end,
      v_now
    ) returning * into v_progress;
  elsif v_reset_applied then
    update public.onboarding_progress
    set started_at = v_now,
        completed_at = v_now,
        replay_count = replay_count + 1,
        updated_at = v_now
    where profile_id = p_actor_id
      and onboarding_version = p_onboarding_version
    returning * into v_progress;
  else
    update public.onboarding_progress
    set completed_at = v_now,
        updated_at = v_now
    where profile_id = p_actor_id
      and onboarding_version = p_onboarding_version
    returning * into v_progress;
  end if;

  perform public.log_audit_event(
    p_actor_id,
    case when v_reset_applied then 'COMPLETE_ONBOARDING_AFTER_RESET' else 'COMPLETE_ONBOARDING' end,
    'onboarding_progress',
    p_actor_id::text || ':' || p_onboarding_version::text,
    p_outlet_id,
    p_actor_id,
    v_before,
    to_jsonb(v_progress),
    case when v_reset_applied then 'Tutorial diselesaikan setelah reset supervisor.' else null end
  );

  return to_jsonb(v_progress) || jsonb_build_object(
    'idempotent_replay', false,
    'reset_applied', v_reset_applied
  );
end;
$$;

revoke execute on function public.rpc_request_onboarding_reset(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.rpc_get_onboarding_state(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_complete_onboarding(uuid, uuid, integer) from public, anon, authenticated;

grant execute on function public.rpc_request_onboarding_reset(uuid, uuid, uuid, text) to service_role;
grant execute on function public.rpc_get_onboarding_state(uuid, uuid) to service_role;
grant execute on function public.rpc_complete_onboarding(uuid, uuid, integer) to service_role;
