-- HOPIN Production Migration 0008: Commands, Privileges, Audit & Transactional RPCs

-- 1. Enhance audit_events
alter table public.audit_events
  add column if not exists outlet_id uuid references public.outlets(id),
  add column if not exists subject_user_id uuid references public.profiles(id),
  add column if not exists ip_hash text,
  add column if not exists metadata_json jsonb;

-- 2. Append-Only Trigger Functions
create or replace function public.enforce_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'Modification or deletion of historical/audit facts is strictly prohibited.';
end;
$$;

drop trigger if exists trg_audit_events_append_only on public.audit_events;
create trigger trg_audit_events_append_only
before update or delete on public.audit_events
for each row execute function public.enforce_append_only();

drop trigger if exists trg_attendance_events_append_only on public.attendance_events;
create trigger trg_attendance_events_append_only
before update or delete on public.attendance_events
for each row execute function public.enforce_append_only();

drop trigger if exists trg_daily_report_revisions_append_only on public.daily_report_revisions;
create trigger trg_daily_report_revisions_append_only
before update on public.daily_report_revisions
for each row
when (old.status = 'APPROVED' or old.status = 'SUBMITTED')
execute function public.enforce_append_only();

drop trigger if exists trg_payroll_exports_append_only on public.payroll_exports;
create trigger trg_payroll_exports_append_only
before update or delete on public.payroll_exports
for each row execute function public.enforce_append_only();

-- 3. Audit Helper Function
create or replace function public.log_audit_event(
  p_actor_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_outlet_id uuid default null,
  p_subject_id uuid default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null,
  p_ip_hash text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.audit_events (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    outlet_id,
    subject_user_id,
    before_json,
    after_json,
    reason,
    ip_hash,
    server_occurred_at
  ) values (
    p_actor_id,
    p_action,
    p_entity_type,
    p_entity_id,
    p_outlet_id,
    p_subject_id,
    p_before,
    p_after,
    p_reason,
    p_ip_hash,
    now()
  ) returning id into v_id;

  return v_id;
end;
$$;

-- 4. Transactional RPC: Claim Assignment with Row-Level Locking
create or replace function public.rpc_claim_assignment(
  p_outlet_id uuid,
  p_work_date date,
  p_shift_code text,
  p_area_code public.area_code,
  p_profile_id uuid,
  p_duty_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle_id uuid;
  v_assignment_id uuid;
  v_existing_primary uuid;
  v_schedule_deviation boolean := false;
  v_roster_shift text;
begin
  -- 1. Upsert & Lock Cycle
  insert into public.work_cycles (outlet_id, work_date, shift_code, area_code, status)
  values (p_outlet_id, p_work_date, p_shift_code, p_area_code, 'ACTIVE')
  on conflict (outlet_id, work_date, shift_code, area_code) do update
  set updated_at = now()
  returning id into v_cycle_id;

  -- Lock the cycle row for concurrency control
  perform 1 from public.work_cycles where id = v_cycle_id for update;

  -- 2. If claiming PRIMARY, verify no other active PRIMARY exists
  if p_duty_role = 'PRIMARY' then
    select profile_id into v_existing_primary
    from public.work_assignments
    where cycle_id = v_cycle_id
      and duty_role = 'PRIMARY'
      and status = 'ACTIVE'
    limit 1;

    if v_existing_primary is not null and v_existing_primary <> p_profile_id then
      raise exception 'PRIMARY_TAKEN: Penanggung jawab utama area ini sudah terisi.';
    end if;
  end if;

  -- 3. Check Roster Deviation
  select shift_code into v_roster_shift
  from public.roster_entries
  where profile_id = p_profile_id
    and work_date = p_work_date
    and status = 'SCHEDULED'
  limit 1;

  if v_roster_shift is null or v_roster_shift <> p_shift_code then
    v_schedule_deviation := true;
  end if;

  -- 4. Upsert Assignment
  insert into public.work_assignments (
    cycle_id,
    work_date,
    profile_id,
    duty_role,
    status,
    schedule_deviation,
    assigned_at
  ) values (
    v_cycle_id,
    p_work_date,
    p_profile_id,
    p_duty_role,
    'ACTIVE',
    v_schedule_deviation,
    now()
  )
  on conflict (cycle_id, profile_id) do update
  set duty_role = p_duty_role,
      status = 'ACTIVE',
      schedule_deviation = v_schedule_deviation,
      assigned_at = now()
  returning id into v_assignment_id;

  -- 5. Audit Event
  perform public.log_audit_event(
    p_profile_id,
    'CLAIM_ASSIGNMENT',
    'work_assignments',
    v_assignment_id::text,
    p_outlet_id,
    p_profile_id,
    null,
    jsonb_build_object('cycle_id', v_cycle_id, 'duty_role', p_duty_role, 'shift_code', p_shift_code, 'area_code', p_area_code)
  );

  return jsonb_build_object(
    'assignment_id', v_assignment_id,
    'cycle_id', v_cycle_id,
    'duty_role', p_duty_role,
    'schedule_deviation', v_schedule_deviation
  );
end;
$$;

-- 5. Revoke direct operational table access from public, anon, and authenticated
revoke all on public.assignments from anon, authenticated;
revoke all on public.opening_records from anon, authenticated;
revoke all on public.opening_lines from anon, authenticated;
revoke all on public.movements from anon, authenticated;
revoke all on public.closing_reports from anon, authenticated;
revoke all on public.closing_report_revisions from anon, authenticated;
revoke all on public.closing_lines from anon, authenticated;
revoke all on public.audit_events from anon, authenticated;

revoke execute on function public.enforce_append_only from public, anon, authenticated;
revoke execute on function public.log_audit_event from public, anon, authenticated;
revoke execute on function public.rpc_claim_assignment from public, anon, authenticated;

grant all on public.assignments, public.opening_records, public.opening_lines,
  public.movements, public.closing_reports, public.closing_report_revisions,
  public.closing_lines, public.audit_events to service_role;

grant execute on function public.log_audit_event to service_role;
grant execute on function public.rpc_claim_assignment to service_role;

-- 6. Indexes for audit and high-frequency queries
create index if not exists audit_events_composite_idx on public.audit_events (outlet_id, action, server_occurred_at desc);
create index if not exists work_cycles_lookup_idx on public.work_cycles (outlet_id, work_date, shift_code, area_code);
create index if not exists work_assignments_active_idx on public.work_assignments (cycle_id, status);
create index if not exists stock_movements_cycle_idx on public.stock_movements (cycle_id, server_occurred_at desc);
create index if not exists attendance_records_date_idx on public.attendance_records (outlet_id, work_date, status);
create index if not exists daily_reports_lookup_idx on public.daily_reports (outlet_id, work_date, status);
create index if not exists payroll_runs_period_idx on public.payroll_runs (outlet_id, period_month, status);
create index if not exists app_sessions_lookup_idx on public.app_sessions (token_hash) where revoked_at is null;
