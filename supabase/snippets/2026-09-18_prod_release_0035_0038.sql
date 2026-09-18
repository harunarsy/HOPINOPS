-- HOPIN production release — 18 Sep 2026
-- Tempel SELURUH file ini ke Supabase SQL Editor project production (naanarmoktmsumkxmjvj),
-- jalankan sekali sebagai satu transaksi. Isi: migrasi 0035-0038 + sinkronisasi
-- jadwal operasional 17 Sep 2026 dan setelahnya (claim tanpa jadwal).
-- Setelah sukses, deploy aplikasi (push main) akan otomatis memakai jalur baru ini.

begin;

-- Pengaman database: hanya boleh jalan di PRODUCTION.
do $$
begin
  if not exists (select 1 from public.profiles where username = 'harun' and active is true)
     or not exists (select 1 from public.profiles where username = 'jezy' and active is true) then
    raise exception 'SALAH DATABASE: user harun/jezy tidak ditemukan — ini bukan production. Tidak ada perubahan dijalankan.';
  end if;
end $$;

-- ==================== MIGRASI 0035_roster_operational_sync.sql ====================
-- HOPIN Production Migration 0035: Operational roster auto-sync.
--
-- Ketika operator/manajemen mengklaim shift tanpa jadwal (roster entry) yang
-- direncanakan, sistem sekarang membuat roster entry otomatis bertanda
-- source='OPERASIONAL' sehingga:
--   * "Atur Jadwal" langsung menampilkan siapa yang benar-benar masuk,
--   * schedule_deviation tidak lagi menyala untuk kerja tanpa rencana,
--   * baseline roster payroll bulanan (pay_treatment BASE) terisi dari
--     operasional nyata, bukan hanya input manual.
-- Perilaku claim lain tidak berubah: plan yang ada tetap dipakai dan tetap
-- dianggap deviasi bila shift/area berbeda.

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
  v_role public.app_role;
  v_cycle public.work_cycles%rowtype;
  v_assignment public.work_assignments%rowtype;
  v_other_assignment_id uuid;
  v_primary_id uuid;
  v_roster_id uuid;
  v_roster_shift text;
  v_roster_area public.area_code;
  v_roster_auto_created boolean := false;
  v_schedule_deviation boolean;
begin
  if p_work_date is null
     or p_shift_code is null
     or p_shift_code not in ('SIANG', 'MALAM', 'FULL')
     or p_area_code is null
     or p_duty_role is null
     or p_duty_role not in ('PRIMARY', 'HELPER') then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Tanggal, shift, area, dan duty role tidak valid.';
  end if;

  v_role := public.require_authorized_actor(p_profile_id, p_outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan mengklaim assignment.';
  end if;

  if not exists (
    select 1 from public.shift_templates
    where outlet_id = p_outlet_id and code = p_shift_code and active is true
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SHIFT: Shift outlet tidak ditemukan atau tidak aktif.';
  end if;

  insert into public.work_cycles (outlet_id, work_date, shift_code, area_code, status)
  values (p_outlet_id, p_work_date, p_shift_code, p_area_code, 'AVAILABLE')
  on conflict (outlet_id, work_date, shift_code, area_code) do nothing;

  select * into v_cycle
  from public.work_cycles
  where outlet_id = p_outlet_id
    and work_date = p_work_date
    and shift_code = p_shift_code
    and area_code = p_area_code
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'CYCLE_CREATE_FAILED: Work cycle tidak dapat dibuat.';
  end if;

  if v_cycle.status not in ('AVAILABLE', 'ACTIVE') then
    raise exception using errcode = '55000', message = 'INVALID_CYCLE_STATE: Cycle yang sudah dimulai atau terminal tidak dapat diklaim ulang.';
  end if;

  select * into v_assignment
  from public.work_assignments
  where cycle_id = v_cycle.id and profile_id = p_profile_id
  for update;

  if found and v_assignment.status <> 'ACTIVE' then
    raise exception using errcode = '55000', message = 'TERMINAL_ASSIGNMENT: Assignment nonaktif tidak dapat dihidupkan kembali.';
  end if;

  select id into v_other_assignment_id
  from public.work_assignments
  where profile_id = p_profile_id
    and work_date = p_work_date
    and status = 'ACTIVE'
    and cycle_id <> v_cycle.id
  limit 1
  for update;

  if v_other_assignment_id is not null then
    raise exception using errcode = '23505', message = 'ACTIVE_ASSIGNMENT_EXISTS: Actor sudah memiliki assignment aktif pada tanggal tersebut.';
  end if;

  if p_duty_role = 'PRIMARY' then
    select profile_id into v_primary_id
    from public.work_assignments
    where cycle_id = v_cycle.id
      and duty_role = 'PRIMARY'
      and status = 'ACTIVE'
      and profile_id <> p_profile_id
    limit 1;

    if v_primary_id is not null then
      raise exception using errcode = '23505', message = 'PRIMARY_TAKEN: Primary cycle sudah terisi.';
    end if;
  end if;

  select id, shift_code, expected_area
    into v_roster_id, v_roster_shift, v_roster_area
  from public.roster_entries
  where outlet_id = p_outlet_id
    and profile_id = p_profile_id
    and work_date = p_work_date
    and status = 'SCHEDULED'
  limit 1;

  -- 0035: tanpa jadwal terencana, catat realisasi operasional sebagai roster.
  if v_roster_id is null and v_role::text in ('OPERATOR', 'SUPERVISOR') then
    insert into public.roster_entries (
      outlet_id, work_date, shift_code, profile_id, expected_area, status,
      pay_treatment, override_reason, created_by, source
    ) values (
      p_outlet_id, p_work_date, p_shift_code, p_profile_id, p_area_code, 'SCHEDULED',
      'BASE', null, p_profile_id, 'OPERASIONAL'
    )
    on conflict (profile_id, work_date) where status = 'SCHEDULED' do nothing
    returning id, shift_code, expected_area into v_roster_id, v_roster_shift, v_roster_area;

    if v_roster_id is null then
      -- Balapan dengan claim lain: pakai baris yang sudah ada.
      select id, shift_code, expected_area
        into v_roster_id, v_roster_shift, v_roster_area
      from public.roster_entries
      where outlet_id = p_outlet_id
        and profile_id = p_profile_id
        and work_date = p_work_date
        and status = 'SCHEDULED'
      limit 1;
    else
      v_roster_auto_created := true;
    end if;
  end if;

  v_schedule_deviation := v_roster_id is null
    or v_roster_shift is distinct from p_shift_code
    or (v_roster_area is not null and v_roster_area is distinct from p_area_code);

  if v_assignment.id is null then
    insert into public.work_assignments (
      cycle_id, work_date, profile_id, duty_role, status, roster_entry_id,
      schedule_deviation, assigned_at
    ) values (
      v_cycle.id, p_work_date, p_profile_id, p_duty_role, 'ACTIVE', v_roster_id,
      v_schedule_deviation, clock_timestamp()
    )
    returning * into v_assignment;
  else
    update public.work_assignments
    set duty_role = p_duty_role,
        roster_entry_id = v_roster_id,
        schedule_deviation = v_schedule_deviation,
        version = version + 1
    where id = v_assignment.id
    returning * into v_assignment;
  end if;

  if v_cycle.status = 'AVAILABLE' then
    update public.work_cycles
    set status = 'ACTIVE', version = version + 1, updated_at = clock_timestamp()
    where id = v_cycle.id;
  end if;

  perform public.log_audit_event(
    p_profile_id, 'CLAIM_ASSIGNMENT', 'work_assignments', v_assignment.id::text,
    p_outlet_id, p_profile_id, null,
    jsonb_build_object(
      'cycle_id', v_cycle.id,
      'shift_code', p_shift_code,
      'area_code', p_area_code,
      'duty_role', p_duty_role,
      'schedule_deviation', v_schedule_deviation,
      'roster_entry_id', v_roster_id,
      'roster_auto_created', v_roster_auto_created
    )
  );

  return jsonb_build_object(
    'assignment_id', v_assignment.id,
    'cycle_id', v_cycle.id,
    'duty_role', v_assignment.duty_role,
    'schedule_deviation', v_assignment.schedule_deviation
  );
end;
$$;

revoke execute on function public.rpc_claim_assignment(uuid, date, text, public.area_code, uuid, text) from public, anon, authenticated;
grant execute on function public.rpc_claim_assignment(uuid, date, text, public.area_code, uuid, text) to service_role;

-- ==================== MIGRASI 0036_payroll_draft_warnings.sql ====================
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

-- ==================== MIGRASI 0037_management_stock_history.sql ====================
-- HOPIN Production Migration 0037: Management stock history.
--
-- Dua RPC read-only untuk tab "Stok Area":
--   * rpc_get_management_stock_history  -> daftar tanggal/periode berisi cycle
--     beserta ringkasan closing (jumlah item, jumlah selisih, siapa menutup).
--   * rpc_get_management_stock_closing_detail -> rincian per item untuk satu
--     cycle (patokan/opening, masuk, keluar, sistem, hitung fisik, selisih).
-- Dipakai untuk riwayat stok + ekspor PDF dari dashboard manajemen.

create or replace function public.rpc_get_management_stock_history(
  p_actor_id uuid, p_outlet_id uuid, p_from date, p_to date
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_role public.app_role;
  v_rows jsonb := '[]'::jsonb;
  c record;
begin
  if p_actor_id is null or p_outlet_id is null or p_from is null or p_to is null or p_from > p_to
     or (p_to - p_from) > 92 then
    raise exception using errcode='22023', message='INVALID_ARGUMENT: Rentang riwayat stok wajib valid (maksimal 92 hari).';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER','SUPERVISOR') then
    raise exception using errcode='42501', message='FORBIDDEN: Manajemen diperlukan.';
  end if;
  for c in
    select cycle.id, cycle.work_date, cycle.shift_code, cycle.area_code, cycle.status,
           closing.id as closing_id, closing.status as closing_status,
           closing.confirmed_at, closing.movement_cutoff_at,
           confirmer.display_name as confirmed_by_name
    from public.work_cycles cycle
    left join public.stock_closings closing on closing.cycle_id = cycle.id
    left join public.profiles confirmer on confirmer.id = closing.confirmed_by
    where cycle.outlet_id = p_outlet_id
      and cycle.work_date between p_from and p_to
      and cycle.area_code in ('BAR','KITCHEN')
    order by cycle.work_date desc, cycle.area_code, cycle.shift_code
  loop
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'cycle_id', c.id,
      'work_date', c.work_date,
      'shift_code', c.shift_code,
      'area_code', c.area_code,
      'cycle_status', c.status,
      'primary_name', (select profile.display_name
        from public.work_assignments assignment
        join public.profiles profile on profile.id = assignment.profile_id
        where assignment.cycle_id = c.id and assignment.duty_role = 'PRIMARY'
        order by assignment.assigned_at limit 1),
      'closing_id', c.closing_id,
      'closing_status', c.closing_status,
      'confirmed_by_name', c.confirmed_by_name,
      'confirmed_at', c.confirmed_at,
      'movement_cutoff_at', c.movement_cutoff_at,
      'line_count', case when c.closing_id is null then 0
        else (select count(*) from public.stock_closing_lines line where line.closing_id = c.closing_id) end,
      'variance_count', case when c.closing_id is null then 0
        else (select count(*) from public.stock_closing_lines line where line.closing_id = c.closing_id and line.variance_qty <> 0) end,
      'total_items', (select count(*) from public.items item where item.area_code = c.area_code and item.active)
    ));
  end loop;
  return jsonb_build_object('from', p_from, 'to', p_to, 'rows', v_rows);
end;
$$;

create or replace function public.rpc_get_management_stock_closing_detail(
  p_actor_id uuid, p_outlet_id uuid, p_cycle_id uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_role public.app_role;
  v_cycle public.work_cycles%rowtype;
  v_closing public.stock_closings%rowtype;
  v_confirmed_by_name text;
  v_lines jsonb;
begin
  if p_actor_id is null or p_outlet_id is null or p_cycle_id is null then
    raise exception using errcode='22023', message='INVALID_ARGUMENT: Cycle wajib valid.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER','SUPERVISOR') then
    raise exception using errcode='42501', message='FORBIDDEN: Manajemen diperlukan.';
  end if;
  select * into v_cycle from public.work_cycles where id = p_cycle_id and outlet_id = p_outlet_id;
  if not found then
    raise exception using errcode='P0002', message='NOT_FOUND: Cycle tidak ditemukan pada outlet.';
  end if;
  select * into v_closing from public.stock_closings where cycle_id = v_cycle.id;
  if found then
    select display_name into v_confirmed_by_name from public.profiles where id = v_closing.confirmed_by;
    select coalesce(jsonb_agg(jsonb_build_object(
      'item_id', line.item_id,
      'item_name', coalesce(line.item_name_snapshot, item.name),
      'unit_code', coalesce(line.unit_code_snapshot, item.unit_code),
      'opening_qty', line.opening_qty,
      'incoming_qty', line.incoming_qty,
      'outgoing_qty', line.outgoing_qty,
      'system_qty', line.system_qty,
      'counted_qty', line.counted_qty,
      'variance_qty', line.variance_qty,
      'reason_code', line.reason_code,
      'notes', line.notes
    ) order by coalesce(line.item_name_snapshot, item.name)), '[]'::jsonb)
    into v_lines
    from public.stock_closing_lines line
    left join public.items item on item.id = line.item_id
    where line.closing_id = v_closing.id;
  else
    v_lines := '[]'::jsonb;
  end if;
  return jsonb_build_object(
    'cycle', jsonb_build_object(
      'id', v_cycle.id, 'work_date', v_cycle.work_date, 'shift_code', v_cycle.shift_code,
      'area_code', v_cycle.area_code, 'status', v_cycle.status),
    'closing', case when v_closing.id is null then null else jsonb_build_object(
      'id', v_closing.id, 'status', v_closing.status, 'confirmed_at', v_closing.confirmed_at,
      'confirmed_by_name', v_confirmed_by_name, 'movement_cutoff_at', v_closing.movement_cutoff_at) end,
    'lines', v_lines
  );
end;
$$;

revoke execute on function public.rpc_get_management_stock_history(uuid, uuid, date, date) from public, anon, authenticated;
revoke execute on function public.rpc_get_management_stock_closing_detail(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.rpc_get_management_stock_history(uuid, uuid, date, date) to service_role;
grant execute on function public.rpc_get_management_stock_closing_detail(uuid, uuid, uuid) to service_role;

-- ==================== MIGRASI 0038_payroll_compensation_management.sql ====================
-- HOPIN Production Migration 0038: Employee compensation management.
--
-- Sebelum ini tidak ada jalur input kompensasi sama sekali sehingga payroll
-- tidak pernah bisa dibangun (employee_compensations selalu kosong).
-- Dua RPC berikut memberi manajemen jalur resmi:
--   * rpc_get_payroll_compensations  -> daftar staff operasional + kompensasi aktif.
--   * rpc_save_employee_compensation -> set/ubah kompensasi (version-safe, audit).
-- Satu kompensasi aktif (effective_to null) per profile+policy; perubahan
-- berikutnya memakai expected_version dari baris yang ada.

create or replace function public.rpc_get_payroll_compensations(
  p_actor_id uuid, p_outlet_id uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_role public.app_role;
  v_policy public.compensation_policies%rowtype;
  v_profiles jsonb;
begin
  if p_actor_id is null or p_outlet_id is null then
    raise exception using errcode='22023', message='INVALID_ARGUMENT: Actor dan outlet wajib valid.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER','SUPERVISOR') then
    raise exception using errcode='42501', message='FORBIDDEN: Manajemen diperlukan.';
  end if;
  select * into v_policy from public.compensation_policies policy
  where policy.outlet_id = p_outlet_id and policy.status = 'ACTIVE'
  order by policy.effective_from desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object(
    'profile_id', profile.id,
    'display_name', profile.display_name,
    'role', profile.role,
    'job_title', profile.job_title,
    'compensation', (
      select jsonb_build_object(
        'id', compensation.id,
        'monthly_base', compensation.monthly_base,
        'daily_rate', compensation.daily_rate,
        'hourly_rate', compensation.hourly_rate,
        'effective_from', compensation.effective_from,
        'effective_to', compensation.effective_to,
        'version', compensation.version)
      from public.employee_compensations compensation
      where compensation.profile_id = profile.id
        and compensation.policy_id = v_policy.id
        and compensation.effective_to is null
      order by compensation.effective_from desc limit 1
    )
  ) order by profile.display_name), '[]'::jsonb) into v_profiles
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
  where profile.active is true and profile.deactivated_at is null
    and profile.role::text in ('OPERATOR','SUPERVISOR');
  return jsonb_build_object(
    'policy', case when v_policy.id is null then null else jsonb_build_object(
      'id', v_policy.id, 'name', v_policy.name, 'minimum_workdays', v_policy.minimum_workdays) end,
    'profiles', v_profiles);
end;
$$;

create or replace function public.rpc_save_employee_compensation(
  p_actor_id uuid, p_outlet_id uuid, p_profile_id uuid,
  p_expected_version integer,
  p_effective_from date,
  p_monthly_base numeric, p_daily_rate numeric, p_hourly_rate numeric
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_role public.app_role;
  v_policy public.compensation_policies%rowtype;
  v_policy_count integer;
  v_compensation public.employee_compensations%rowtype;
  v_before jsonb;
begin
  if p_actor_id is null or p_outlet_id is null or p_profile_id is null or p_effective_from is null
     or p_monthly_base is null or p_daily_rate is null or p_hourly_rate is null
     or p_monthly_base < 0 or p_daily_rate < 0 or p_hourly_rate < 0
     or p_monthly_base <> round(p_monthly_base) or p_daily_rate <> round(p_daily_rate)
     or p_hourly_rate <> round(p_hourly_rate)
     or p_monthly_base > 99999999999999 or p_daily_rate > 99999999999999 or p_hourly_rate > 99999999999999
     or (p_expected_version is not null and p_expected_version <= 0) then
    raise exception using errcode='22023', message='INVALID_ARGUMENT: Kompensasi wajib angka bulat non-negatif dan tanggal valid.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER','SUPERVISOR') then
    raise exception using errcode='42501', message='FORBIDDEN: Manajemen diperlukan.';
  end if;
  if not exists (
    select 1 from public.profiles profile
    join public.profile_outlet_scopes scope
      on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
    where profile.id = p_profile_id and profile.active is true and profile.deactivated_at is null
      and profile.role::text in ('OPERATOR','SUPERVISOR')
  ) then
    raise exception using errcode='42501', message='INVALID_TARGET: Target harus staff operasional aktif pada outlet.';
  end if;

  select count(*) into v_policy_count
  from public.compensation_policies policy
  where policy.outlet_id = p_outlet_id and policy.status = 'ACTIVE'
    and policy.effective_from <= p_effective_from
    and (policy.effective_to is null or policy.effective_to >= p_effective_from);
  if v_policy_count <> 1 then
    raise exception using errcode='55000', message=format('PAYROLL_BLOCKER: Expected satu policy aktif untuk tanggal efektif, ditemukan %s.', v_policy_count);
  end if;
  select * into v_policy from public.compensation_policies policy
  where policy.outlet_id = p_outlet_id and policy.status = 'ACTIVE'
    and policy.effective_from <= p_effective_from
    and (policy.effective_to is null or policy.effective_to >= p_effective_from)
  for share;

  if p_expected_version is null then
    select * into v_compensation from public.employee_compensations
    where profile_id = p_profile_id and policy_id = v_policy.id and effective_to is null
    for update;
    if found then
      raise exception using errcode='23505', message='COMPENSATION_EXISTS: Kompensasi aktif sudah ada; kirim expected_version untuk mengubah.';
    end if;
    insert into public.employee_compensations (
      profile_id, policy_id, effective_from, effective_to,
      monthly_base, daily_rate, hourly_rate, created_by, approved_by
    ) values (
      p_profile_id, v_policy.id, p_effective_from, null,
      p_monthly_base, p_daily_rate, p_hourly_rate, p_actor_id, p_actor_id
    ) returning * into v_compensation;
    v_before := null;
  else
    select * into v_compensation from public.employee_compensations
    where profile_id = p_profile_id and policy_id = v_policy.id and effective_to is null
    for update;
    if not found then
      raise exception using errcode='P0002', message='NOT_FOUND: Kompensasi aktif belum ada; kirim expected_version null untuk membuat.';
    end if;
    if v_compensation.version <> p_expected_version then
      raise exception using errcode='40001', message=format('VERSION_CONFLICT: Expected compensation version %s, current version %s.', p_expected_version, v_compensation.version),
        detail = format('expected_version=%s,current_version=%s', p_expected_version, v_compensation.version);
    end if;
    v_before := to_jsonb(v_compensation);
    update public.employee_compensations
    set effective_from = p_effective_from,
        monthly_base = p_monthly_base,
        daily_rate = p_daily_rate,
        hourly_rate = p_hourly_rate,
        approved_by = p_actor_id,
        version = version + 1
    where id = v_compensation.id
    returning * into v_compensation;
  end if;

  perform public.log_audit_event(
    p_actor_id, 'SAVE_COMPENSATION', 'employee_compensations', v_compensation.id::text,
    p_outlet_id, p_profile_id, v_before, to_jsonb(v_compensation), null
  );
  return to_jsonb(v_compensation);
end;
$$;

revoke execute on function public.rpc_get_payroll_compensations(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_save_employee_compensation(uuid, uuid, uuid, integer, date, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.rpc_get_payroll_compensations(uuid, uuid) to service_role;
grant execute on function public.rpc_save_employee_compensation(uuid, uuid, uuid, integer, date, numeric, numeric, numeric) to service_role;

-- ==================== SINKRONISASI JADWAL OPERASIONAL ====================
-- HOPIN production fix — 18 Sep 2026
-- Dijalankan di Supabase SQL Editor project production (naanarmoktmsumkxmjvj),
-- SETELAH migrasi 0035-0038 diterapkan.
--
-- Menyelaraskan jadwal operasional (17 Sep 2026 dan setelahnya) dengan realita:
--   * NDARU  — KITCHEN, shift MALAM (cycle 82082e09, closing 42619ff1)
--   * AREL   — BAR,     shift FULL  (cycle 3898c07f, closing 3d47ae9c)
-- Keduanya sebelumnya diklaim tanpa jadwal sehingga berstatus schedule_deviation
-- dan tidak punya roster entry. Snippet ini:
--   1) membuat roster entry operasional (source='OPERASIONAL', pay_treatment BASE,
--      status COMPLETED) — muncul di "Atur Jadwal" sebagai kerja nyata,
--   2) menautkan assignment + attendance record ke roster tersebut,
--   3) mematikan flag schedule_deviation agar tidak lagi memblok payroll,
--   4) mencatat audit event "input susulan manajemen".
-- Idempoten & transaksional: aman dijalankan dua kali, hanya menyentuh claim
-- tanpa jadwal (schedule_deviation) sejak 17 Sep 2026 pada outlet HOPIN Cafe.

-- 1) Roster operasional dari assignment yang masih deviasi (tanpa jadwal).
insert into public.roster_entries (
  outlet_id, work_date, shift_code, profile_id, expected_area, status,
  pay_treatment, override_reason, created_by, source
)
select c.outlet_id, c.work_date, c.shift_code, wa.profile_id, c.area_code,
       case when wa.status = 'COMPLETED' then 'COMPLETED' else 'SCHEDULED' end,
       'BASE', null, wa.profile_id, 'OPERASIONAL'
from public.work_assignments wa
join public.work_cycles c on c.id = wa.cycle_id
where c.outlet_id = '11111111-1111-1111-1111-111111111111'
  and c.work_date >= '2026-09-17'
  and wa.status <> 'RESET'
  and wa.schedule_deviation is true
  and not exists (
    select 1 from public.roster_entries r
    where r.profile_id = wa.profile_id and r.work_date = c.work_date
  );

-- 1b) Selaraskan status roster operasional dengan status assignment: shift yang
--     masih berjalan tetap SCHEDULED, hanya assignment COMPLETED yang COMPLETED.
update public.roster_entries r
set status = case when wa.status = 'COMPLETED' then 'COMPLETED' else 'SCHEDULED' end,
    version = r.version + 1,
    updated_at = now()
from public.work_assignments wa
where wa.roster_entry_id = r.id
  and r.outlet_id = '11111111-1111-1111-1111-111111111111'
  and r.work_date >= '2026-09-17'
  and r.source = 'OPERASIONAL'
  and r.status is distinct from case when wa.status = 'COMPLETED' then 'COMPLETED' else 'SCHEDULED' end;

-- 2) Tautkan assignment ke roster + matikan deviasi.
update public.work_assignments wa
set roster_entry_id = r.id,
    schedule_deviation = false,
    version = wa.version + 1
from public.work_cycles c, public.roster_entries r
where c.id = wa.cycle_id
  and c.outlet_id = '11111111-1111-1111-1111-111111111111'
  and c.work_date >= '2026-09-17'
  and wa.status <> 'RESET'
  and r.profile_id = wa.profile_id
  and r.work_date = c.work_date
  and r.source = 'OPERASIONAL'
  and (wa.roster_entry_id is distinct from r.id or wa.schedule_deviation is true);

-- 3) Tautkan attendance record ke roster yang sama.
update public.attendance_records a
set roster_entry_id = r.id,
    version = a.version + 1,
    updated_at = now()
from public.roster_entries r
where r.outlet_id = '11111111-1111-1111-1111-111111111111'
  and r.work_date >= '2026-09-17'
  and r.source = 'OPERASIONAL'
  and a.profile_id = r.profile_id
  and a.work_date = r.work_date
  and a.roster_entry_id is distinct from r.id;

-- 4) Audit: catat sebagai input susulan manajemen (idempoten).
do $$
declare
  r record;
begin
  for r in
    select id, profile_id, work_date from public.roster_entries
    where outlet_id = '11111111-1111-1111-1111-111111111111'
      and work_date >= '2026-09-17' and source = 'OPERASIONAL'
      and not exists (
        select 1 from public.audit_events event
        where event.action = 'BACKFILL_OPERATIONAL_ROSTER' and event.entity_id = id::text
      )
  loop
    perform public.log_audit_event(
      r.profile_id, 'BACKFILL_OPERATIONAL_ROSTER', 'roster_entries', r.id::text,
      '11111111-1111-1111-1111-111111111111', r.profile_id, null,
      jsonb_build_object('work_date', r.work_date, 'source', 'OPERASIONAL',
        'note', 'Input susulan manajemen: sinkronisasi jadwal dari operasional/closing')
    );
  end loop;
end $$;

-- 5) Ringkasan hasil.
select r.work_date, r.profile_id, p.display_name, r.shift_code, r.expected_area,
       r.status, r.source
from public.roster_entries r
join public.profiles p on p.id = r.profile_id
where r.outlet_id = '11111111-1111-1111-1111-111111111111'
  and r.work_date >= '2026-09-17'
order by r.work_date, r.shift_code;

commit;

-- Verifikasi cepat
select p.proname, pg_get_function_arguments(p.oid) as args
from pg_proc p
where p.proname in ('rpc_preview_payroll','rpc_get_management_stock_history','rpc_get_management_stock_closing_detail','rpc_get_payroll_compensations','rpc_save_employee_compensation')
order by 1;
select work_date, profile_id, shift_code, expected_area, status, source
from public.roster_entries
where outlet_id = '11111111-1111-1111-1111-111111111111' and work_date >= '2026-09-17'
order by work_date, shift_code;
