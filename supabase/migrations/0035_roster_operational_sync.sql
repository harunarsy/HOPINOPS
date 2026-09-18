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
