-- HOPIN Production Migration 0036: Payroll draft mode + operational evidence.
--
-- rpc_preview_payroll kini menerima p_allow_incomplete:
--   * false (default, perilaku lama): kelengkapan data wajib; blocker pertama
--     diangkat sebagai exception persis seperti sebelumnya.
--   * true (dipakai tombol "Buat Draft Payroll"): draft tetap dihitung dan
--     setiap blocker dilaporkan sebagai warning terstruktur supaya manajemen
--     bisa melihat draft berjalan sambil melengkapi data. Review/finalisasi
--     tetap strict (rpc_review_payroll tidak berubah).
--
-- attendance_summary juga diperkaya dengan bukti operasional: worked_days,
-- worked_hours, dan daftar shift (tanggal, shift, area, jam masuk/keluar)
-- sehingga payroll menarik langsung dari review kehadiran.

create or replace function public.rpc_preview_payroll(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_period_month text,
  p_expected_run_version integer default null,
  p_allow_incomplete boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_period_start date;
  v_period_end date;
  v_policy public.compensation_policies%rowtype;
  v_run public.payroll_runs%rowtype;
  v_policy_count integer;
  v_profile_count integer;
  v_entry_count integer;
  v_count integer;
  v_blockers jsonb := '[]'::jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor_id is null or p_outlet_id is null
     or p_period_month is null or p_period_month !~ '^\d{4}-(0[1-9]|1[0-2])$'
     or (p_expected_run_version is not null and p_expected_run_version <= 0)
     or p_allow_incomplete is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Outlet, periode, atau expected version tidak valid.';
  end if;
  v_period_start := (p_period_month || '-01')::date;
  v_period_end := (v_period_start + interval '1 month - 1 day')::date;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Preview payroll hanya boleh dibuat manager.';
  end if;

  select count(*) into v_policy_count
  from public.compensation_policies policy
  where policy.outlet_id = p_outlet_id
    and policy.status = 'ACTIVE'
    and policy.effective_from <= v_period_end
    and (policy.effective_to is null or policy.effective_to >= v_period_end);
  if v_policy_count <> 1 then
    raise exception using errcode = '55000', message = format('PAYROLL_BLOCKER: Expected satu policy aktif pada period end, ditemukan %s.', v_policy_count);
  end if;
  select * into v_policy
  from public.compensation_policies policy
  where policy.outlet_id = p_outlet_id
    and policy.status = 'ACTIVE'
    and policy.effective_from <= v_period_end
    and (policy.effective_to is null or policy.effective_to >= v_period_end)
  for share;

  select * into v_run
  from public.payroll_runs
  where outlet_id = p_outlet_id and period_month = p_period_month and status <> 'VOID'
  for update;
  if found then
    if v_run.status <> 'DRAFT' then
      raise exception using errcode = '55000', message = format('STATE_CONFLICT: Payroll run %s tidak dapat dibangun ulang.', v_run.status);
    end if;
    if p_expected_run_version is null or v_run.version <> p_expected_run_version then
      raise exception using
        errcode = '40001',
        message = format('VERSION_CONFLICT: Expected payroll version %s, current version %s.', coalesce(p_expected_run_version::text, 'NULL'), v_run.version),
        detail = format('expected_version=%s,current_version=%s', coalesce(p_expected_run_version::text, 'NULL'), v_run.version);
    end if;
    if v_run.policy_id <> v_policy.id then
      raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Policy aktif berubah; void/replacement diperlukan.';
    end if;
  else
    if p_expected_run_version is not null then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT: Payroll run belum ada; expected version harus NULL.';
    end if;
    insert into public.payroll_runs (outlet_id, period_month, status, policy_id, created_by)
    values (p_outlet_id, p_period_month, 'DRAFT', v_policy.id, p_actor_id)
    returning * into v_run;
  end if;

  select count(*) into v_profile_count
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
  where profile.active is true and profile.deactivated_at is null
    and profile.role::text in ('OPERATOR', 'SUPERVISOR');
  if v_profile_count = 0 then
    raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Tidak ada profile operational aktif pada outlet.';
  end if;

  if exists (
    select 1
    from public.profiles profile
    join public.profile_outlet_scopes scope
      on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
    where profile.active is true and profile.deactivated_at is null
      and profile.role::text in ('OPERATOR', 'SUPERVISOR')
      and (select count(*) from public.employee_compensations compensation
           where compensation.profile_id = profile.id
             and compensation.policy_id = v_policy.id
             and compensation.effective_from <= v_period_end
             and (compensation.effective_to is null or compensation.effective_to >= v_period_end)) <> 1
  ) then
    raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Compensation period-end hilang atau overlap.';
  end if;

  -- Kelengkapan data: strict = exception; draft = warning terstruktur.
  select count(*) into v_count
  from public.attendance_corrections correction
  join public.attendance_records attendance on attendance.id = correction.attendance_id
  where attendance.outlet_id = p_outlet_id and attendance.work_date between v_period_start and v_period_end
    and correction.status = 'PENDING';
  if v_count > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'ATTENDANCE_CORRECTION_PENDING', 'count', v_count,
      'message', 'PAYROLL_BLOCKER: Attendance correction PENDING.'));
  end if;

  select count(*) into v_count
  from public.attendance_records attendance
  where attendance.outlet_id = p_outlet_id and attendance.work_date between v_period_start and v_period_end
    and (attendance.status in ('MISSING_CHECKOUT', 'REVIEW_REQUIRED')
      or attendance.exception_status not in ('NONE', 'RESOLVED'));
  if v_count > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'ATTENDANCE_EXCEPTION_UNRESOLVED', 'count', v_count,
      'message', 'PAYROLL_BLOCKER: Attendance exception belum resolved.'));
  end if;

  select count(*) into v_count
  from public.overtime_claims overtime
  join public.attendance_records attendance on attendance.id = overtime.attendance_id
  where attendance.outlet_id = p_outlet_id and attendance.work_date between v_period_start and v_period_end
    and overtime.status = 'CANDIDATE';
  if v_count > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'OVERTIME_CANDIDATE_PENDING', 'count', v_count,
      'message', 'PAYROLL_BLOCKER: Overtime CANDIDATE belum direview.'));
  end if;

  select count(*) into v_count
  from public.leave_requests leave_request
  where leave_request.outlet_id = p_outlet_id
    and leave_request.start_date <= v_period_end and leave_request.end_date >= v_period_start
    and leave_request.status = 'PENDING';
  if v_count > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'LEAVE_REQUEST_PENDING', 'count', v_count,
      'message', 'PAYROLL_BLOCKER: Leave request PENDING.'));
  end if;

  select count(*) into v_count
  from public.roster_entries roster
  where roster.outlet_id = p_outlet_id and roster.work_date between v_period_start and v_period_end
    and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment in ('EXTRA', 'MAKEUP');
  if v_count > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'ROSTER_TREATMENT_DECISION_MISSING', 'count', v_count,
      'message', 'PAYROLL_BLOCKER: Roster EXTRA/MAKEUP belum memiliki keputusan uang tersimpan.'));
  end if;

  select count(*) into v_count
  from public.work_assignments assignment
  join public.work_cycles cycle on cycle.id = assignment.cycle_id
  where cycle.outlet_id = p_outlet_id and cycle.work_date between v_period_start and v_period_end
    and assignment.status <> 'RESET' and assignment.schedule_deviation is true;
  if v_count > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'SCHEDULE_DEVIATION_UNRESOLVED', 'count', v_count,
      'message', 'PAYROLL_BLOCKER: Schedule deviation belum memiliki approval payroll tersimpan.'));
  end if;

  select count(*) into v_count
  from public.payroll_adjustments adjustment
  join public.payroll_entries entry on entry.id = adjustment.entry_id
  where entry.run_id = v_run.id and adjustment.status = 'PENDING';
  if v_count > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'PAYROLL_ADJUSTMENT_PENDING', 'count', v_count,
      'message', 'PAYROLL_BLOCKER: Payroll adjustment PENDING.'));
  end if;

  select count(*) into v_count
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
  where profile.active is true and profile.deactivated_at is null
    and profile.role::text in ('OPERATOR', 'SUPERVISOR')
    and (select count(*) from public.roster_entries roster
         where roster.profile_id = profile.id and roster.outlet_id = p_outlet_id
           and roster.work_date between v_period_start and v_period_end
           and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE') <> v_policy.minimum_workdays;
  if v_count > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'ROSTER_BASE_COUNT_MISMATCH', 'count', v_count,
      'message', 'PAYROLL_BLOCKER: Jumlah roster BASE berbeda dari baseline policy.'));
  end if;

  select count(*) into v_count
  from public.leave_requests leave_request
  where leave_request.outlet_id = p_outlet_id
    and leave_request.start_date <= v_period_end and leave_request.end_date >= v_period_start
    and leave_request.status = 'APPROVED' and leave_request.leave_type in ('UNPAID', 'OTHER_EXCEPTION');
  if v_count > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'LEAVE_DEDUCTION_REVIEW_MISSING', 'count', v_count,
      'message', 'PAYROLL_BLOCKER: Leave unpaid/exception memerlukan deduction review yang belum dimodelkan.'));
  end if;

  select count(*) into v_count
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
  where profile.active is true and profile.deactivated_at is null
    and profile.role::text in ('OPERATOR', 'SUPERVISOR')
    and ((select count(distinct roster.work_date) from public.roster_entries roster
          where roster.profile_id = profile.id and roster.outlet_id = p_outlet_id
            and roster.work_date between v_period_start and v_period_end
            and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE'
            and exists (select 1 from public.leave_requests leave_request
              where leave_request.profile_id = profile.id and leave_request.outlet_id = p_outlet_id
                and leave_request.status = 'APPROVED' and leave_request.leave_type = 'SICK'
                and roster.work_date between leave_request.start_date and leave_request.end_date)) > v_policy.sick_allowance
      or (select count(distinct roster.work_date) from public.roster_entries roster
          where roster.profile_id = profile.id and roster.outlet_id = p_outlet_id
            and roster.work_date between v_period_start and v_period_end
            and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE'
            and exists (select 1 from public.leave_requests leave_request
              where leave_request.profile_id = profile.id and leave_request.outlet_id = p_outlet_id
                and leave_request.status = 'APPROVED' and leave_request.leave_type = 'OTHER'
                and roster.work_date between leave_request.start_date and leave_request.end_date)) > v_policy.other_leave_allowance);
  if v_count > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'LEAVE_ALLOWANCE_EXCEEDED', 'count', v_count,
      'message', 'PAYROLL_BLOCKER: Paid leave melebihi allowance; deduction review belum dimodelkan.'));
  end if;

  select count(*) into v_count
  from public.roster_entries roster
  where roster.outlet_id = p_outlet_id and roster.work_date between v_period_start and v_period_end
    and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE'
    and not exists (select 1 from public.attendance_records attendance
      where attendance.roster_entry_id = roster.id and attendance.profile_id = roster.profile_id
        and attendance.outlet_id = p_outlet_id and attendance.work_date = roster.work_date
        and attendance.status in ('CHECKED_OUT', 'APPROVED') and attendance.exception_status in ('NONE', 'RESOLVED'))
    and not exists (select 1 from public.leave_requests leave_request
      where leave_request.profile_id = roster.profile_id and leave_request.outlet_id = p_outlet_id
        and leave_request.status = 'APPROVED' and leave_request.leave_type in ('SICK', 'OTHER')
        and roster.work_date between leave_request.start_date and leave_request.end_date);
  if v_count > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'ROSTER_BASE_ATTENDANCE_GAP', 'count', v_count,
      'message', 'PAYROLL_BLOCKER: Roster BASE tidak terpenuhi; ALPHA/deduction review belum dimodelkan.'));
  end if;

  if jsonb_array_length(v_blockers) > 0 and not p_allow_incomplete then
    raise exception using errcode = '55000', message = v_blockers->0->>'message';
  end if;

  if exists (
    select 1 from public.payroll_entries entry
    where entry.run_id = v_run.id
      and not exists (select 1 from public.profiles profile
        join public.profile_outlet_scopes scope on scope.profile_id = profile.id
          and scope.outlet_id = p_outlet_id and scope.active is true
        where profile.id = entry.profile_id and profile.active is true
          and profile.deactivated_at is null and profile.role::text in ('OPERATOR', 'SUPERVISOR'))
      and exists (select 1 from public.payroll_adjustments adjustment where adjustment.entry_id = entry.id)
  ) then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Adjustment tersimpan untuk profile yang tidak lagi eligible.'; end if;

  delete from public.payroll_entries entry
  where entry.run_id = v_run.id
    and not exists (select 1 from public.profiles profile
      join public.profile_outlet_scopes scope on scope.profile_id = profile.id
        and scope.outlet_id = p_outlet_id and scope.active is true
      where profile.id = entry.profile_id and profile.active is true
        and profile.deactivated_at is null and profile.role::text in ('OPERATOR', 'SUPERVISOR'));

  insert into public.payroll_entries (
    run_id, profile_id, base_amount, attendance_summary, approved_overtime_amount,
    approved_shortage_amount, absence_deduction, bonus_amount,
    manual_adjustment_amount, proposed_gross, final_gross, status, version
  )
  select
    v_run.id,
    profile.id,
    compensation.monthly_base,
    jsonb_build_object(
      'period_start', v_period_start, 'period_end', v_period_end,
      'policy_id', v_policy.id, 'policy_version', v_policy.version,
      'minimum_workdays', v_policy.minimum_workdays,
      'sick_allowance', v_policy.sick_allowance,
      'other_leave_allowance', v_policy.other_leave_allowance,
      'compensation_id', compensation.id, 'compensation_version', compensation.version,
      'compensation_effective_from', compensation.effective_from,
      'compensation_effective_to', compensation.effective_to,
      'monthly_base', compensation.monthly_base,
      'daily_rate', compensation.daily_rate, 'hourly_rate', compensation.hourly_rate,
      'base_roster_days', (select count(*) from public.roster_entries roster
        where roster.profile_id = profile.id and roster.outlet_id = p_outlet_id
          and roster.work_date between v_period_start and v_period_end
          and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE'),
      'valid_attendance_ids', coalesce((select jsonb_agg(attendance.id order by attendance.work_date)
        from public.attendance_records attendance where attendance.profile_id = profile.id
          and attendance.outlet_id = p_outlet_id and attendance.work_date between v_period_start and v_period_end
          and attendance.status in ('CHECKED_OUT', 'APPROVED')
          and attendance.exception_status in ('NONE', 'RESOLVED')), '[]'::jsonb),
      'worked_days', (select count(distinct attendance.work_date)
        from public.attendance_records attendance where attendance.profile_id = profile.id
          and attendance.outlet_id = p_outlet_id and attendance.work_date between v_period_start and v_period_end
          and attendance.status in ('CHECKED_OUT', 'APPROVED')
          and attendance.exception_status in ('NONE', 'RESOLVED')),
      'worked_hours', coalesce((select round(sum(extract(epoch from (coalesce(checkout.server_occurred_at, checkin.server_occurred_at) - checkin.server_occurred_at)) / 3600.0)::numeric, 2)
        from public.attendance_records attendance
        join public.attendance_events checkin on checkin.id = attendance.check_in_event_id
        left join public.attendance_events checkout on checkout.id = attendance.check_out_event_id
        where attendance.profile_id = profile.id
          and attendance.outlet_id = p_outlet_id and attendance.work_date between v_period_start and v_period_end
          and attendance.status in ('CHECKED_OUT', 'APPROVED')
          and attendance.exception_status in ('NONE', 'RESOLVED')), 0),
      'shifts', coalesce((select jsonb_agg(jsonb_build_object(
            'work_date', cycle.work_date,
            'shift_code', cycle.shift_code,
            'area_code', cycle.area_code,
            'duty_role', assignment.duty_role,
            'attendance_status', attendance.status,
            'check_in_at', checkin.server_occurred_at,
            'check_out_at', checkout.server_occurred_at) order by cycle.work_date)
        from public.work_assignments assignment
        join public.work_cycles cycle on cycle.id = assignment.cycle_id
        left join public.attendance_records attendance on attendance.work_assignment_id = assignment.id
        left join public.attendance_events checkin on checkin.id = attendance.check_in_event_id
        left join public.attendance_events checkout on checkout.id = attendance.check_out_event_id
        where assignment.profile_id = profile.id and cycle.outlet_id = p_outlet_id
          and cycle.work_date between v_period_start and v_period_end
          and assignment.status <> 'RESET'), '[]'::jsonb),
      'approved_paid_leave_ids', coalesce((select jsonb_agg(leave_request.id order by leave_request.created_at)
        from public.leave_requests leave_request where leave_request.profile_id = profile.id
          and leave_request.outlet_id = p_outlet_id and leave_request.status = 'APPROVED'
          and leave_request.leave_type in ('SICK', 'OTHER')
          and leave_request.start_date <= v_period_end and leave_request.end_date >= v_period_start), '[]'::jsonb),
      'approved_overtime_ids', coalesce((select jsonb_agg(overtime.id order by attendance.work_date)
        from public.overtime_claims overtime join public.attendance_records attendance on attendance.id = overtime.attendance_id
        where attendance.profile_id = profile.id and attendance.outlet_id = p_outlet_id
          and attendance.work_date between v_period_start and v_period_end and overtime.status = 'APPROVED'), '[]'::jsonb),
      'final_bonus_allocation_ids', coalesce((select jsonb_agg(allocation.id order by report.work_date)
        from public.daily_bonus_allocations allocation
        join public.daily_bonus_pools pool on pool.id = allocation.pool_id and pool.status = 'FINAL'
        join public.daily_report_revisions revision on revision.id = pool.report_revision_id
        join public.daily_reports report on report.id = revision.report_id
        where allocation.profile_id = profile.id and report.outlet_id = p_outlet_id
          and report.work_date between v_period_start and v_period_end), '[]'::jsonb),
      'approved_adjustment_ids', coalesce((select jsonb_agg(adjustment.id order by adjustment.created_at)
        from public.payroll_adjustments adjustment join public.payroll_entries current_entry on current_entry.id = adjustment.entry_id
        where current_entry.run_id = v_run.id and current_entry.profile_id = profile.id
          and adjustment.status = 'APPROVED'), '[]'::jsonb),
      'absence_deduction_rule', 'ZERO_ONLY_ALL_BASE_FULFILLED',
      'approved_shortage_rule', 'ZERO_NO_APPROVED_SHORTAGE_SCHEMA'
    ),
    coalesce((select sum(overtime.credited_hours * compensation.hourly_rate)
      from public.overtime_claims overtime join public.attendance_records attendance on attendance.id = overtime.attendance_id
      where attendance.profile_id = profile.id and attendance.outlet_id = p_outlet_id
        and attendance.work_date between v_period_start and v_period_end and overtime.status = 'APPROVED'), 0),
    0,
    0,
    coalesce((select sum(allocation.amount)
      from public.daily_bonus_allocations allocation
      join public.daily_bonus_pools pool on pool.id = allocation.pool_id and pool.status = 'FINAL'
      join public.daily_report_revisions revision on revision.id = pool.report_revision_id
      join public.daily_reports report on report.id = revision.report_id
      where allocation.profile_id = profile.id and report.outlet_id = p_outlet_id
        and report.work_date between v_period_start and v_period_end), 0),
    coalesce((select sum(adjustment.amount)
      from public.payroll_adjustments adjustment join public.payroll_entries current_entry on current_entry.id = adjustment.entry_id
      where current_entry.run_id = v_run.id and current_entry.profile_id = profile.id
        and adjustment.status = 'APPROVED'), 0),
    compensation.monthly_base
      + coalesce((select sum(overtime.credited_hours * compensation.hourly_rate)
        from public.overtime_claims overtime join public.attendance_records attendance on attendance.id = overtime.attendance_id
        where attendance.profile_id = profile.id and attendance.outlet_id = p_outlet_id
          and attendance.work_date between v_period_start and v_period_end and overtime.status = 'APPROVED'), 0)
      + coalesce((select sum(allocation.amount)
        from public.daily_bonus_allocations allocation
        join public.daily_bonus_pools pool on pool.id = allocation.pool_id and pool.status = 'FINAL'
        join public.daily_report_revisions revision on revision.id = pool.report_revision_id
        join public.daily_reports report on report.id = revision.report_id
        where allocation.profile_id = profile.id and report.outlet_id = p_outlet_id
          and report.work_date between v_period_start and v_period_end), 0)
      + coalesce((select sum(adjustment.amount)
        from public.payroll_adjustments adjustment join public.payroll_entries current_entry on current_entry.id = adjustment.entry_id
        where current_entry.run_id = v_run.id and current_entry.profile_id = profile.id
          and adjustment.status = 'APPROVED'), 0),
    0, 'DRAFT', 1
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
  join public.employee_compensations compensation
    on compensation.profile_id = profile.id and compensation.policy_id = v_policy.id
   and compensation.effective_from <= v_period_end
   and (compensation.effective_to is null or compensation.effective_to >= v_period_end)
  where profile.active is true and profile.deactivated_at is null
    and profile.role::text in ('OPERATOR', 'SUPERVISOR')
  on conflict (run_id, profile_id) do update set
    base_amount = excluded.base_amount,
    attendance_summary = excluded.attendance_summary,
    approved_overtime_amount = excluded.approved_overtime_amount,
    approved_shortage_amount = excluded.approved_shortage_amount,
    absence_deduction = excluded.absence_deduction,
    bonus_amount = excluded.bonus_amount,
    manual_adjustment_amount = excluded.manual_adjustment_amount,
    proposed_gross = excluded.proposed_gross,
    final_gross = 0,
    status = 'DRAFT',
    version = public.payroll_entries.version + 1;

  select count(*) into v_entry_count from public.payroll_entries where run_id = v_run.id;
  if v_entry_count <> v_profile_count then
    raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Snapshot entry tidak lengkap.';
  end if;

  if p_expected_run_version is not null then
    update public.payroll_runs set version = version + 1 where id = v_run.id returning * into v_run;
  end if;

  perform public.log_audit_event(
    p_actor_id, 'PREVIEW_PAYROLL', 'payroll_runs', v_run.id::text,
    p_outlet_id, null, null,
    jsonb_build_object('period_month', p_period_month, 'policy_id', v_policy.id,
      'policy_version', v_policy.version, 'entry_count', v_entry_count, 'version', v_run.version,
      'allow_incomplete', p_allow_incomplete, 'warning_count', jsonb_array_length(v_blockers))
  );
  return jsonb_build_object('run_id', v_run.id, 'status', v_run.status,
    'version', v_run.version, 'entry_count', v_entry_count,
    'blockers', v_blockers, 'warnings', v_blockers);
end;
$$;

revoke execute on function public.rpc_preview_payroll(uuid, uuid, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.rpc_preview_payroll(uuid, uuid, text, integer, boolean) to service_role;

-- Signature lama digantikan; pemanggil 4 argumen kini memakai default strict.
drop function if exists public.rpc_preview_payroll(uuid, uuid, text, integer);
