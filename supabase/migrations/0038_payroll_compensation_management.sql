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
