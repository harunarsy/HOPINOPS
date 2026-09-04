-- HOPIN Production Migration 0012: Remaining Transactional Commands
--
-- Every command below re-authorizes the actor, locks its mutable aggregate,
-- validates state and input, writes the mutation, and appends its audit event in
-- the same transaction. Browser roles receive no EXECUTE privilege.

-- Review notes are command inputs but were not represented in 0006.
alter table public.attendance_corrections
  add column if not exists review_note text;

alter table public.leave_requests
  add column if not exists review_note text;

create or replace function public.enforce_hr_request_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_subject_id uuid;
begin
  if tg_op = 'INSERT' then
    if tg_table_name = 'attendance_corrections' then
      if new.status <> 'PENDING' or new.reviewed_by is not null
         or new.reviewed_at is not null or new.review_note is not null then
        raise exception using errcode = '55000', message = 'INVALID_CORRECTION_INITIAL_STATE: Koreksi baru wajib PENDING tanpa metadata review.';
      end if;
    elsif tg_table_name = 'leave_requests' then
      if new.status <> 'PENDING' or new.reviewed_by is not null
         or new.reviewed_at is not null or new.review_note is not null then
        raise exception using errcode = '55000', message = 'INVALID_LEAVE_INITIAL_STATE: Leave baru wajib PENDING tanpa metadata review.';
      end if;
    elsif tg_table_name = 'overtime_claims' then
      if new.status <> 'CANDIDATE' or new.version <> 1
         or new.reviewed_by is not null or new.reviewed_at is not null then
        raise exception using errcode = '55000', message = 'INVALID_OVERTIME_INITIAL_STATE: Overtime baru wajib CANDIDATE versi 1.';
      end if;
    else
      raise exception using errcode = '55000', message = format('UNSUPPORTED_HR_TABLE: %s.', tg_table_name);
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = format('IMMUTABLE_HR_REQUEST: %s tidak boleh dihapus.', tg_table_name);
  end if;

  if (tg_table_name in ('attendance_corrections', 'leave_requests') and old.status <> 'PENDING')
     or (tg_table_name = 'overtime_claims' and old.status <> 'CANDIDATE') then
    raise exception using errcode = '55000', message = format('IMMUTABLE_HR_REQUEST: %s terminal tidak boleh diubah.', tg_table_name);
  end if;

  if tg_table_name = 'attendance_corrections' then
    select profile_id into v_subject_id
    from public.attendance_records where id = old.attendance_id;
    if new.status not in ('APPROVED', 'REJECTED')
       or new.reviewed_by is null or new.reviewed_at is null
       or new.reviewed_by = old.requested_by or new.reviewed_by = v_subject_id
       or nullif(btrim(new.review_note), '') is null or length(new.review_note) > 1000
       or (to_jsonb(new) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note')
            is distinct from
          (to_jsonb(old) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note') then
      raise exception using errcode = '55000', message = 'INVALID_CORRECTION_TRANSITION: Hanya review PENDING satu kali yang diizinkan.';
    end if;
  elsif tg_table_name = 'leave_requests' then
    if new.status not in ('APPROVED', 'REJECTED', 'CANCELLED')
       or (new.status in ('APPROVED', 'REJECTED') and (
         new.reviewed_by is null or new.reviewed_at is null
         or new.reviewed_by = old.submitted_by or new.reviewed_by = old.profile_id
       ))
       or (new.status in ('APPROVED', 'REJECTED') and (nullif(btrim(new.review_note), '') is null or length(new.review_note) > 1000))
       or (new.status = 'CANCELLED' and (new.reviewed_by is not null or new.reviewed_at is not null or new.review_note is not null))
       or (to_jsonb(new) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note')
            is distinct from
          (to_jsonb(old) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note') then
      raise exception using errcode = '55000', message = 'INVALID_LEAVE_TRANSITION: Hanya review/cancel PENDING satu kali yang diizinkan.';
    end if;
  elsif tg_table_name = 'overtime_claims' then
    select attendance.profile_id into v_subject_id
    from public.attendance_records attendance where attendance.id = old.attendance_id;
    if new.status not in ('APPROVED', 'REJECTED')
       or new.reviewed_by is null or new.reviewed_at is null
       or new.reviewed_by = v_subject_id
       or nullif(btrim(new.reason), '') is null or length(new.reason) > 1000
       or new.version <> old.version + 1
       or (to_jsonb(new) - 'status' - 'reason' - 'reviewed_by' - 'reviewed_at' - 'version')
            is distinct from
          (to_jsonb(old) - 'status' - 'reason' - 'reviewed_by' - 'reviewed_at' - 'version') then
      raise exception using errcode = '55000', message = 'INVALID_OVERTIME_TRANSITION: Hanya review CANDIDATE satu kali yang diizinkan.';
    end if;
  else
    raise exception using errcode = '55000', message = format('UNSUPPORTED_HR_TABLE: %s.', tg_table_name);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_attendance_corrections_state on public.attendance_corrections;
create trigger trg_attendance_corrections_state
before insert or update or delete on public.attendance_corrections
for each row execute function public.enforce_hr_request_state();

drop trigger if exists trg_leave_requests_state on public.leave_requests;
create trigger trg_leave_requests_state
before insert or update or delete on public.leave_requests
for each row execute function public.enforce_hr_request_state();

drop trigger if exists trg_overtime_claims_state on public.overtime_claims;
create trigger trg_overtime_claims_state
before insert or update or delete on public.overtime_claims
for each row execute function public.enforce_hr_request_state();

create or replace function public.rpc_update_settings(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_expected_version integer,
  p_settings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_settings public.outlet_settings%rowtype;
  v_before jsonb;
  v_latitude double precision;
  v_longitude double precision;
  v_geofence_radius_m integer;
  v_max_accuracy_m integer;
  v_gps_sample_limit integer;
  v_gps_timeout_seconds integer;
  v_late_grace_minutes integer;
  v_overtime_threshold_minutes integer;
  v_raw_gps_retention_days integer;
  v_system_mode text;
  v_onboarding_version integer;
begin
  if p_actor_id is null or p_outlet_id is null
     or p_expected_version is null or p_expected_version <= 0
     or jsonb_typeof(p_settings) is distinct from 'object'
     or p_settings = '{}'::jsonb or pg_column_size(p_settings) > 8192 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Actor, outlet, version, dan object settings wajib valid.';
  end if;

  if exists (
    select 1 from jsonb_object_keys(p_settings) as key(name)
    where name not in (
      'latitude', 'longitude', 'geofence_radius_m', 'max_accuracy_m',
      'gps_sample_limit', 'gps_timeout_seconds', 'late_grace_minutes',
      'overtime_threshold_minutes', 'raw_gps_retention_days',
      'system_mode', 'onboarding_version'
    )
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SETTINGS: Settings memuat field yang tidak diizinkan.';
  end if;

  if exists (
    select 1 from jsonb_each(p_settings) as setting(key, value)
    where (key in ('latitude', 'longitude') and jsonb_typeof(value) not in ('number', 'null'))
       or (key in (
         'geofence_radius_m', 'max_accuracy_m', 'gps_sample_limit',
         'gps_timeout_seconds', 'late_grace_minutes',
         'overtime_threshold_minutes', 'raw_gps_retention_days',
         'onboarding_version'
       ) and jsonb_typeof(value) <> 'number')
       or (key = 'system_mode' and jsonb_typeof(value) <> 'string')
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SETTINGS: Tipe field settings tidak valid.';
  end if;

  if exists (
    select 1 from jsonb_each(p_settings) as setting(key, value)
    where key in (
      'geofence_radius_m', 'max_accuracy_m', 'gps_sample_limit',
      'gps_timeout_seconds', 'late_grace_minutes',
      'overtime_threshold_minutes', 'raw_gps_retention_days',
      'onboarding_version'
    )
      and ((value #>> '{}')::numeric <> trunc((value #>> '{}')::numeric)
        or abs((value #>> '{}')::numeric) > 2147483647)
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SETTINGS: Field integer tidak boleh memiliki pecahan.';
  end if;

  if exists (
    select 1 from jsonb_each(p_settings) as setting(key, value)
    where (key = 'latitude' and jsonb_typeof(value) = 'number'
      and (value #>> '{}')::numeric not between -90 and 90)
       or (key = 'longitude' and jsonb_typeof(value) = 'number'
      and (value #>> '{}')::numeric not between -180 and 180)
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SETTINGS: Koordinat berada di luar batas yang diizinkan.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OWNER' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER yang dapat mengubah settings.';
  end if;

  select * into v_settings
  from public.outlet_settings
  where outlet_id = p_outlet_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Settings outlet tidak ditemukan.';
  end if;
  if v_settings.version <> p_expected_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected settings version %s, current version %s.', p_expected_version, v_settings.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_version, v_settings.version);
  end if;

  v_latitude := case when p_settings ? 'latitude' then (p_settings->>'latitude')::double precision else v_settings.latitude end;
  v_longitude := case when p_settings ? 'longitude' then (p_settings->>'longitude')::double precision else v_settings.longitude end;
  v_geofence_radius_m := coalesce((p_settings->>'geofence_radius_m')::integer, v_settings.geofence_radius_m);
  v_max_accuracy_m := coalesce((p_settings->>'max_accuracy_m')::integer, v_settings.max_accuracy_m);
  v_gps_sample_limit := coalesce((p_settings->>'gps_sample_limit')::integer, v_settings.gps_sample_limit);
  v_gps_timeout_seconds := coalesce((p_settings->>'gps_timeout_seconds')::integer, v_settings.gps_timeout_seconds);
  v_late_grace_minutes := coalesce((p_settings->>'late_grace_minutes')::integer, v_settings.late_grace_minutes);
  v_overtime_threshold_minutes := coalesce((p_settings->>'overtime_threshold_minutes')::integer, v_settings.overtime_threshold_minutes);
  v_raw_gps_retention_days := coalesce((p_settings->>'raw_gps_retention_days')::integer, v_settings.raw_gps_retention_days);
  v_system_mode := coalesce(nullif(btrim(p_settings->>'system_mode'), ''), v_settings.system_mode);
  v_onboarding_version := coalesce((p_settings->>'onboarding_version')::integer, v_settings.onboarding_version);

  if (v_latitude is null) <> (v_longitude is null)
     or (v_latitude is not null and (v_latitude::text in ('NaN', 'Infinity', '-Infinity') or v_latitude not between -90 and 90))
     or (v_longitude is not null and (v_longitude::text in ('NaN', 'Infinity', '-Infinity') or v_longitude not between -180 and 180))
     or v_geofence_radius_m not between 10 and 10000
     or v_max_accuracy_m not between 5 and 500
     or v_gps_sample_limit not between 1 and 10
     or v_gps_timeout_seconds not between 5 and 60
     or v_late_grace_minutes not between 0 and 1440
     or v_overtime_threshold_minutes not between 0 and 1440
     or v_raw_gps_retention_days not between 7 and 365
     or v_system_mode not in ('PRODUCTION', 'PILOT', 'MAINTENANCE')
     or v_onboarding_version <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_SETTINGS: Nilai settings berada di luar batas yang diizinkan.';
  end if;

  v_before := to_jsonb(v_settings) - 'latitude' - 'longitude';
  update public.outlet_settings
  set latitude = v_latitude,
      longitude = v_longitude,
      geofence_radius_m = v_geofence_radius_m,
      max_accuracy_m = v_max_accuracy_m,
      gps_sample_limit = v_gps_sample_limit,
      gps_timeout_seconds = v_gps_timeout_seconds,
      late_grace_minutes = v_late_grace_minutes,
      overtime_threshold_minutes = v_overtime_threshold_minutes,
      raw_gps_retention_days = v_raw_gps_retention_days,
      system_mode = v_system_mode,
      onboarding_version = v_onboarding_version,
      version = version + 1,
      updated_by = p_actor_id,
      updated_at = clock_timestamp()
  where outlet_id = p_outlet_id
  returning * into v_settings;

  perform public.log_audit_event(
    p_actor_id, 'UPDATE_SETTINGS', 'outlet_settings', p_outlet_id::text,
    p_outlet_id, null, v_before,
    (to_jsonb(v_settings) - 'latitude' - 'longitude') || jsonb_build_object(
      'coordinates_configured', v_settings.latitude is not null,
      'coordinates_changed', (p_settings ? 'latitude') or (p_settings ? 'longitude')
    )
  );
  return to_jsonb(v_settings);
end;
$$;

create or replace function public.rpc_create_item(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_item_id text,
  p_area_code public.area_code,
  p_name text,
  p_unit_code text,
  p_decimal_scale smallint,
  p_low_threshold numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_item public.items%rowtype;
  v_item_id text := btrim(p_item_id);
  v_name text := nullif(btrim(p_name), '');
  v_unit_code text := nullif(btrim(p_unit_code), '');
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OWNER' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER yang dapat membuat item.';
  end if;
  lock table public.outlets in share mode;
  lock table public.work_cycles in share mode;
  if exists (select 1 from public.outlets where active is true and id <> p_outlet_id) then
    raise exception using errcode = '55000', message = 'GLOBAL_ITEM_SCHEMA: Item tidak memiliki outlet_id; mutasi ditolak saat ada outlet aktif lain.';
  end if;
  if v_item_id is null or v_item_id !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
     or p_area_code is null or v_name is null or length(v_name) > 150
     or v_unit_code is null or length(v_unit_code) > 32
     or p_decimal_scale is null or p_decimal_scale not between 0 and 4
     or p_low_threshold is null or p_low_threshold < 0
     or p_low_threshold::text in ('NaN', 'Infinity', '-Infinity')
     or p_low_threshold > 9999999999.9999 then
    raise exception using errcode = '22023', message = 'INVALID_ITEM: ID, area, nama, unit, scale, atau threshold tidak valid.';
  end if;
  if exists (
    select 1 from public.work_cycles
    where outlet_id = p_outlet_id and area_code = p_area_code and status in ('ACTIVE', 'OPEN')
  ) then
    raise exception using errcode = '55000', message = 'ITEM_SET_LOCKED: Area item memiliki cycle aktif.';
  end if;

  perform 1 from public.items where id = v_item_id for update;
  if found then
    raise exception using errcode = '23505', message = 'ITEM_EXISTS: ID item sudah digunakan.';
  end if;

  insert into public.items (id, area_code, name, unit_code, decimal_scale, low_threshold, active)
  values (v_item_id, p_area_code, v_name, v_unit_code, p_decimal_scale, p_low_threshold, true)
  returning * into v_item;

  perform public.log_audit_event(
    p_actor_id, 'CREATE_ITEM', 'items', v_item.id, p_outlet_id,
    null, null, to_jsonb(v_item)
  );
  return to_jsonb(v_item);
end;
$$;

-- items has no version column in 0001-0011, so this command intentionally uses
-- a pessimistic row lock and has no misleading expected_version argument.
create or replace function public.rpc_update_item(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_item_id text,
  p_name text,
  p_unit_code text,
  p_decimal_scale smallint,
  p_low_threshold numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_item public.items%rowtype;
  v_before jsonb;
  v_name text := nullif(btrim(p_name), '');
  v_unit_code text := nullif(btrim(p_unit_code), '');
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OWNER' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER yang dapat mengubah item.';
  end if;
  lock table public.outlets in share mode;
  lock table public.work_cycles in share mode;
  if exists (select 1 from public.outlets where active is true and id <> p_outlet_id) then
    raise exception using errcode = '55000', message = 'GLOBAL_ITEM_SCHEMA: Item tidak memiliki outlet_id; mutasi ditolak saat ada outlet aktif lain.';
  end if;
  if nullif(btrim(p_item_id), '') is null
     or v_name is null or length(v_name) > 150
     or v_unit_code is null or length(v_unit_code) > 32
     or p_decimal_scale is null or p_decimal_scale not between 0 and 4
     or p_low_threshold is null or p_low_threshold < 0
     or p_low_threshold::text in ('NaN', 'Infinity', '-Infinity')
     or p_low_threshold > 9999999999.9999 then
    raise exception using errcode = '22023', message = 'INVALID_ITEM: Payload item tidak valid.';
  end if;

  select * into v_item from public.items where id = btrim(p_item_id) for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Item tidak ditemukan.';
  end if;
  if not v_item.active then
    raise exception using errcode = '55000', message = 'ITEM_ARCHIVED: Item terarsip tidak dapat diubah.';
  end if;
  if exists (
    select 1 from public.work_cycles
    where outlet_id = p_outlet_id and area_code = v_item.area_code and status in ('ACTIVE', 'OPEN')
  ) then
    raise exception using errcode = '55000', message = 'ITEM_IN_ACTIVE_CYCLE: Area item masih memiliki cycle aktif.';
  end if;
  v_before := to_jsonb(v_item);

  update public.items
  set name = v_name,
      unit_code = v_unit_code,
      decimal_scale = p_decimal_scale,
      low_threshold = p_low_threshold,
      updated_at = clock_timestamp()
  where id = v_item.id
  returning * into v_item;

  perform public.log_audit_event(
    p_actor_id, 'UPDATE_ITEM', 'items', v_item.id, p_outlet_id,
    null, v_before, to_jsonb(v_item)
  );
  return to_jsonb(v_item);
end;
$$;

create or replace function public.rpc_archive_item(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_item_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_item public.items%rowtype;
  v_before jsonb;
  v_reason text := nullif(btrim(p_reason), '');
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OWNER' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER yang dapat mengarsipkan item.';
  end if;
  lock table public.outlets in share mode;
  lock table public.work_cycles in share mode;
  if exists (select 1 from public.outlets where active is true and id <> p_outlet_id) then
    raise exception using errcode = '55000', message = 'GLOBAL_ITEM_SCHEMA: Item tidak memiliki outlet_id; mutasi ditolak saat ada outlet aktif lain.';
  end if;
  if nullif(btrim(p_item_id), '') is null or v_reason is null or length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Item dan alasan arsip wajib valid.';
  end if;

  select * into v_item from public.items where id = btrim(p_item_id) for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Item tidak ditemukan.';
  end if;
  if not v_item.active then
    raise exception using errcode = '55000', message = 'ITEM_ARCHIVED: Item sudah terarsip.';
  end if;
  if exists (
    select 1
    from public.work_cycles cycle
    where cycle.outlet_id = p_outlet_id
      and cycle.area_code = v_item.area_code
      and cycle.status in ('ACTIVE', 'OPEN')
  ) then
    raise exception using errcode = '55000', message = 'ITEM_IN_ACTIVE_CYCLE: Area item masih memiliki cycle aktif.';
  end if;

  v_before := to_jsonb(v_item);
  update public.items
  set active = false, updated_at = clock_timestamp()
  where id = v_item.id
  returning * into v_item;

  perform public.log_audit_event(
    p_actor_id, 'ARCHIVE_ITEM', 'items', v_item.id, p_outlet_id,
    null, v_before, to_jsonb(v_item), v_reason
  );
  return to_jsonb(v_item);
end;
$$;

create or replace function public.rpc_save_roster(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_work_date date,
  p_shift_code text,
  p_profile_id uuid,
  p_expected_area public.area_code,
  p_pay_treatment text,
  p_override_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_target public.profiles%rowtype;
  v_existing_target_role public.app_role;
  v_roster public.roster_entries%rowtype;
  v_before jsonb;
  v_shift_code text := upper(btrim(p_shift_code));
  v_pay_treatment text := upper(btrim(p_pay_treatment));
  v_override_reason text := nullif(btrim(p_override_reason), '');
begin
  if p_actor_id is null or p_outlet_id is null or p_work_date is null or p_profile_id is null
     or (p_entry_id is null and p_expected_version is not null)
     or (p_entry_id is not null and (p_expected_version is null or p_expected_version <= 0))
     or v_shift_code is null or v_shift_code not in ('SIANG', 'MALAM', 'FULL')
     or v_pay_treatment is null or v_pay_treatment not in ('BASE', 'EXTRA', 'MAKEUP')
     or length(coalesce(v_override_reason, '')) > 500
     or (extract(isodow from p_work_date) = 2 and v_override_reason is null) then
    raise exception using errcode = '22023', message = 'INVALID_ROSTER: Payload, version, atau alasan override roster tidak valid.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER atau SUPERVISOR yang dapat mengatur roster.';
  end if;

  select profile.* into v_target
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
  where profile.id = p_profile_id
    and profile.active is true and profile.deactivated_at is null
    and profile.force_pin_change is false
  for update of profile;
  if not found or v_target.role::text not in ('OPERATOR', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'INVALID_ROSTER_TARGET: Target harus staff operational aktif pada outlet.';
  end if;
  if v_role::text = 'SUPERVISOR' and v_target.role::text <> 'OPERATOR' and v_target.id <> p_actor_id then
    raise exception using errcode = '42501', message = 'FORBIDDEN: SUPERVISOR hanya dapat mengatur roster OPERATOR atau roster sendiri.';
  end if;
  if not exists (
    select 1 from public.shift_templates
    where outlet_id = p_outlet_id and code = v_shift_code and active is true
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SHIFT: Template shift outlet tidak aktif.';
  end if;

  if p_entry_id is not null then
    select * into v_roster from public.roster_entries where id = p_entry_id for update;
    if not found or v_roster.outlet_id <> p_outlet_id then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND: Roster entry pada outlet tidak ditemukan.';
    end if;
    if v_roster.version <> p_expected_version then
      raise exception using
        errcode = '40001',
        message = format('VERSION_CONFLICT: Expected roster version %s, current version %s.', p_expected_version, v_roster.version),
        detail = format('expected_version=%s,current_version=%s', p_expected_version, v_roster.version);
    end if;
    select role into v_existing_target_role from public.profiles where id = v_roster.profile_id;
    if v_role::text = 'SUPERVISOR'
       and v_existing_target_role::text <> 'OPERATOR'
       and v_roster.profile_id <> p_actor_id then
      raise exception using errcode = '42501', message = 'FORBIDDEN: SUPERVISOR tidak dapat mengubah roster manager lain.';
    end if;
    if v_roster.status <> 'SCHEDULED'
       or exists (select 1 from public.work_assignments where roster_entry_id = v_roster.id and status <> 'RESET')
       or exists (select 1 from public.attendance_records where roster_entry_id = v_roster.id) then
      raise exception using errcode = '55000', message = 'ROSTER_LOCKED: Roster yang sudah dipakai operasional tidak dapat diubah.';
    end if;
    v_before := to_jsonb(v_roster);
  end if;

  perform 1
  from public.roster_entries
  where profile_id = p_profile_id and work_date = p_work_date
    and status = 'SCHEDULED' and (p_entry_id is null or id <> p_entry_id)
  for update;
  if found then
    raise exception using errcode = '23505', message = 'ROSTER_CONFLICT: Target sudah memiliki roster aktif pada tanggal tersebut.';
  end if;

  if p_entry_id is null then
    insert into public.roster_entries (
      outlet_id, work_date, shift_code, profile_id, expected_area, status,
      pay_treatment, override_reason, created_by, source
    ) values (
      p_outlet_id, p_work_date, v_shift_code, p_profile_id, p_expected_area, 'SCHEDULED',
      v_pay_treatment, v_override_reason, p_actor_id, 'MANUAL'
    ) returning * into v_roster;
  else
    update public.roster_entries
    set work_date = p_work_date,
        shift_code = v_shift_code,
        profile_id = p_profile_id,
        expected_area = p_expected_area,
        pay_treatment = v_pay_treatment,
        override_reason = v_override_reason,
        version = version + 1,
        updated_at = clock_timestamp()
    where id = p_entry_id
    returning * into v_roster;
  end if;

  perform public.log_audit_event(
    p_actor_id, 'SAVE_ROSTER', 'roster_entries', v_roster.id::text,
    p_outlet_id, v_roster.profile_id, v_before, to_jsonb(v_roster), v_override_reason
  );
  return to_jsonb(v_roster);
end;
$$;

-- Re-declared here so the remaining command inventory has one audited,
-- service-role-only implementation with the requested exact signature.
create or replace function public.rpc_cancel_shift_swap(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_swap_id uuid,
  p_expected_swap_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_swap public.shift_swap_requests%rowtype;
  v_roster public.roster_entries%rowtype;
  v_before jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_swap_id is null or p_expected_swap_version is null or p_expected_swap_version <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Swap dan expected version wajib valid.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OPERATOR', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan membatalkan swap.';
  end if;

  select * into v_swap from public.shift_swap_requests where id = p_swap_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Permintaan swap tidak ditemukan.';
  end if;
  select * into v_roster from public.roster_entries where id = v_swap.roster_entry_id for update;
  if not found or v_roster.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Roster swap pada outlet tidak ditemukan.';
  end if;
  if v_swap.requested_by <> p_actor_id then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Hanya requester yang dapat membatalkan swap.';
  end if;
  if v_swap.version <> p_expected_swap_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected swap version %s, current version %s.', p_expected_swap_version, v_swap.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_swap_version, v_swap.version);
  end if;
  if v_swap.status <> 'PENDING' then
    raise exception using errcode = '55000', message = format('STATE_CONFLICT: Swap sudah terminal dengan status %s.', v_swap.status);
  end if;

  v_before := to_jsonb(v_swap);
  update public.shift_swap_requests
  set status = case when expires_at <= v_now then 'EXPIRED' else 'CANCELLED' end,
      responded_at = v_now,
      version = version + 1
  where id = p_swap_id
  returning * into v_swap;

  perform public.log_audit_event(
    p_actor_id,
    case when v_swap.status = 'EXPIRED' then 'EXPIRE_SHIFT_SWAP' else 'CANCEL_SHIFT_SWAP' end,
    'shift_swap_requests', v_swap.id::text, p_outlet_id, v_swap.offered_to,
    v_before, to_jsonb(v_swap)
  );
  return to_jsonb(v_swap);
end;
$$;

create or replace function public.rpc_complete_assignment(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_assignment_id uuid,
  p_expected_assignment_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_target_role public.app_role;
  v_cycle public.work_cycles%rowtype;
  v_assignment public.work_assignments%rowtype;
  v_attendance public.attendance_records%rowtype;
  v_before jsonb;
  v_cycle_completed boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if p_assignment_id is null or p_expected_assignment_version is null or p_expected_assignment_version <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Assignment dan expected version wajib valid.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);

  select cycle.* into v_cycle
  from public.work_assignments assignment
  join public.work_cycles cycle on cycle.id = assignment.cycle_id
  where assignment.id = p_assignment_id
  for update of cycle;
  if not found or v_cycle.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Assignment pada outlet tidak ditemukan.';
  end if;
  select * into v_assignment from public.work_assignments where id = p_assignment_id for update;
  if not found or v_assignment.cycle_id <> v_cycle.id then
    raise exception using errcode = '55000', message = 'STATE_CONFLICT: Assignment berubah selama penyelesaian.';
  end if;

  select role into v_target_role from public.profiles where id = v_assignment.profile_id;
  if v_assignment.profile_id <> p_actor_id then
    if v_role::text not in ('OWNER', 'SUPERVISOR') then
      raise exception using errcode = '42501', message = 'FORBIDDEN: Assignment hanya dapat diselesaikan worker atau manager.';
    end if;
    if v_role::text = 'SUPERVISOR' and v_target_role::text <> 'OPERATOR' then
      raise exception using errcode = '42501', message = 'FORBIDDEN: SUPERVISOR hanya dapat menyelesaikan assignment OPERATOR.';
    end if;
  elsif v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan menyelesaikan assignment.';
  end if;
  if v_assignment.version <> p_expected_assignment_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected assignment version %s, current version %s.', p_expected_assignment_version, v_assignment.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_assignment_version, v_assignment.version);
  end if;
  if v_assignment.status not in ('ACTIVE', 'PENDING_TASKS') then
    raise exception using errcode = '55000', message = format('STATE_CONFLICT: Assignment %s tidak dapat diselesaikan.', v_assignment.status);
  end if;
  if v_assignment.duty_role = 'PRIMARY' and v_cycle.status not in ('HANDOVER_READY', 'CLOSING_READY', 'COMPLETED') then
    raise exception using errcode = '55000', message = 'CYCLE_NOT_READY: Primary wajib menyelesaikan handover/closing sebelum assignment.';
  end if;

  select * into v_attendance
  from public.attendance_records
  where work_assignment_id = p_assignment_id and profile_id = v_assignment.profile_id
  for update;
  if not found or v_attendance.status not in ('CHECKED_OUT', 'APPROVED')
     or v_attendance.exception_status not in ('NONE', 'RESOLVED')
     or v_attendance.check_out_event_id is null then
    raise exception using errcode = '55000', message = 'ATTENDANCE_NOT_FINAL: Checkout dan seluruh exception wajib final.';
  end if;

  v_before := to_jsonb(v_assignment);
  update public.work_assignments
  set status = 'COMPLETED', completed_at = v_now, version = version + 1
  where id = p_assignment_id
  returning * into v_assignment;

  if v_assignment.roster_entry_id is not null then
    update public.roster_entries
    set status = 'COMPLETED', version = version + 1, updated_at = v_now
    where id = v_assignment.roster_entry_id and status = 'SCHEDULED';
  end if;

  if v_cycle.status in ('HANDOVER_READY', 'CLOSING_READY')
     and not exists (
       select 1 from public.work_assignments
       where cycle_id = v_cycle.id and status in ('ACTIVE', 'PENDING_TASKS')
     ) then
    update public.work_cycles
    set status = 'COMPLETED', version = version + 1, updated_at = v_now
    where id = v_cycle.id;
    v_cycle_completed := true;
  end if;

  perform public.log_audit_event(
    p_actor_id, 'COMPLETE_ASSIGNMENT', 'work_assignments', v_assignment.id::text,
    p_outlet_id, v_assignment.profile_id, v_before,
    to_jsonb(v_assignment) || jsonb_build_object('cycle_completed', v_cycle_completed)
  );
  return to_jsonb(v_assignment) || jsonb_build_object('cycle_completed', v_cycle_completed);
end;
$$;

create or replace function public.rpc_update_user(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_target_id uuid,
  p_expected_version integer,
  p_display_name text,
  p_role public.app_role,
  p_job_title text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role public.app_role;
  v_target public.profiles%rowtype;
  v_before jsonb;
  v_display_name text := nullif(btrim(p_display_name), '');
  v_job_title text := nullif(btrim(p_job_title), '');
begin
  v_actor_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_actor_role::text <> 'OWNER' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER yang dapat mengubah user.';
  end if;
  if p_target_id is null or p_expected_version is null or p_expected_version <= 0
     or v_display_name is null or length(v_display_name) > 100
     or v_job_title is null or length(v_job_title) > 100
     or p_role is null or p_role::text not in ('OPERATOR', 'SUPERVISOR', 'OWNER', 'INVESTOR') then
    raise exception using errcode = '22023', message = 'INVALID_USER: Target, version, nama, role, atau jabatan tidak valid.';
  end if;

  -- Serialize last-owner decisions for this outlet.
  lock table public.profile_outlet_scopes in share mode;
  perform 1 from public.outlets where id = p_outlet_id for update;

  select profile.* into v_target
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
  where profile.id = p_target_id
  for update of profile;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: User pada outlet tidak ditemukan.';
  end if;
  if exists (
    select 1 from public.profile_outlet_scopes
    where profile_id = p_target_id and active is true and outlet_id <> p_outlet_id
  ) then
    raise exception using errcode = '55000', message = 'SHARED_PROFILE_SCOPE: Profile multi-outlet tidak dapat diubah melalui command outlet tunggal.';
  end if;
  if not v_target.active or v_target.deactivated_at is not null then
    raise exception using errcode = '55000', message = 'USER_INACTIVE: User nonaktif tidak dapat diubah.';
  end if;
  if v_target.version <> p_expected_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected user version %s, current version %s.', p_expected_version, v_target.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_version, v_target.version);
  end if;
  if p_role is distinct from v_target.role and (
    exists (
      select 1 from public.work_assignments
      where profile_id = p_target_id and status in ('ACTIVE', 'PENDING_TASKS')
    ) or exists (
      select 1 from public.attendance_records
      where profile_id = p_target_id and check_in_event_id is not null and check_out_event_id is null
    ) or exists (
      select 1 from public.roster_entries
      where outlet_id = p_outlet_id and profile_id = p_target_id and status = 'SCHEDULED'
        and work_date >= (clock_timestamp() at time zone 'Asia/Jakarta')::date
    )
  ) then
    raise exception using errcode = '55000', message = 'ROLE_CHANGE_BLOCKED: Selesaikan assignment, attendance, dan roster aktif sebelum mengubah role.';
  end if;
  if p_target_id = p_actor_id and p_role is distinct from v_target.role then
    raise exception using errcode = '42501', message = 'SELF_ROLE_CHANGE_FORBIDDEN: OWNER tidak dapat mengubah role sendiri.';
  end if;
  if v_target.role::text = 'OWNER' and p_role::text <> 'OWNER' and not exists (
    select 1
    from public.profiles profile
    join public.profile_outlet_scopes scope
      on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
    where profile.id <> v_target.id and profile.role::text = 'OWNER'
      and profile.active is true and profile.deactivated_at is null
  ) then
    raise exception using errcode = '55000', message = 'LAST_OWNER: Outlet wajib mempertahankan setidaknya satu OWNER aktif.';
  end if;

  v_before := to_jsonb(v_target) - 'username';
  update public.profiles
  set display_name = v_display_name,
      role = p_role,
      job_title = v_job_title,
      version = version + 1,
      updated_at = clock_timestamp()
  where id = p_target_id
  returning * into v_target;

  perform public.log_audit_event(
    p_actor_id, 'UPDATE_USER', 'profiles', v_target.id::text,
    p_outlet_id, v_target.id, v_before, to_jsonb(v_target) - 'username'
  );
  return jsonb_build_object(
    'id', v_target.id, 'username', v_target.username,
    'display_name', v_target.display_name, 'role', v_target.role,
    'job_title', v_target.job_title, 'active', v_target.active,
    'force_pin_change', v_target.force_pin_change, 'version', v_target.version
  );
end;
$$;

create or replace function public.rpc_deactivate_user(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_target_id uuid,
  p_expected_version integer,
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
  v_before jsonb;
  v_reason text := nullif(btrim(p_reason), '');
  v_revoked_sessions integer;
  v_revoked_devices integer;
  v_cancelled_rosters integer;
  v_cancelled_swaps integer;
  v_now timestamptz := clock_timestamp();
begin
  v_actor_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_actor_role::text <> 'OWNER' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER yang dapat menonaktifkan user.';
  end if;
  if p_target_id is null or p_target_id = p_actor_id
     or p_expected_version is null or p_expected_version <= 0
     or v_reason is null or length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Target lain, version, dan alasan deaktivasi wajib valid.';
  end if;

  -- Serialize last-owner decisions for this outlet.
  lock table public.profile_outlet_scopes in share mode;
  perform 1 from public.outlets where id = p_outlet_id for update;

  select profile.* into v_target
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
  where profile.id = p_target_id
  for update of profile;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: User pada outlet tidak ditemukan.';
  end if;
  if exists (
    select 1 from public.profile_outlet_scopes
    where profile_id = p_target_id and active is true and outlet_id <> p_outlet_id
  ) then
    raise exception using errcode = '55000', message = 'SHARED_PROFILE_SCOPE: Profile multi-outlet tidak dapat dinonaktifkan melalui command outlet tunggal.';
  end if;
  if not v_target.active or v_target.deactivated_at is not null then
    raise exception using errcode = '55000', message = 'USER_INACTIVE: User sudah nonaktif.';
  end if;
  if v_target.version <> p_expected_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected user version %s, current version %s.', p_expected_version, v_target.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_version, v_target.version);
  end if;
  if v_target.role::text = 'OWNER' and not exists (
    select 1
    from public.profiles profile
    join public.profile_outlet_scopes scope
      on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
    where profile.id <> v_target.id and profile.role::text = 'OWNER'
      and profile.active is true and profile.deactivated_at is null
  ) then
    raise exception using errcode = '55000', message = 'LAST_OWNER: Outlet wajib mempertahankan setidaknya satu OWNER aktif.';
  end if;
  if exists (
    select 1 from public.work_assignments
    where profile_id = p_target_id and status in ('ACTIVE', 'PENDING_TASKS')
  ) or exists (
    select 1 from public.attendance_records
    where profile_id = p_target_id and check_in_event_id is not null and check_out_event_id is null
  ) then
    raise exception using errcode = '55000', message = 'ACTIVE_WORK_BLOCKER: Assignment atau attendance aktif wajib diselesaikan/reset lebih dahulu.';
  end if;

  v_before := to_jsonb(v_target) - 'username';
  update public.shift_swap_requests swap
  set status = 'CANCELLED', responded_at = v_now, version = version + 1
  from public.roster_entries roster
  where roster.id = swap.roster_entry_id and roster.outlet_id = p_outlet_id
    and swap.status = 'PENDING'
    and (swap.requested_by = p_target_id or swap.offered_to = p_target_id);
  get diagnostics v_cancelled_swaps = row_count;

  update public.roster_entries
  set status = 'CANCELLED', version = version + 1, updated_at = v_now
  where outlet_id = p_outlet_id and profile_id = p_target_id
    and status = 'SCHEDULED' and work_date >= (v_now at time zone 'Asia/Jakarta')::date;
  get diagnostics v_cancelled_rosters = row_count;

  update public.app_sessions set revoked_at = v_now
  where profile_id = p_target_id and revoked_at is null;
  get diagnostics v_revoked_sessions = row_count;
  update public.app_devices set revoked_at = v_now
  where profile_id = p_target_id and revoked_at is null;
  get diagnostics v_revoked_devices = row_count;

  update public.profiles
  set active = false, deactivated_at = v_now, deactivated_by = p_actor_id,
      version = version + 1, updated_at = v_now
  where id = p_target_id
  returning * into v_target;

  perform public.log_audit_event(
    p_actor_id, 'DEACTIVATE_USER', 'profiles', v_target.id::text,
    p_outlet_id, v_target.id, v_before,
    (to_jsonb(v_target) - 'username') || jsonb_build_object(
      'revoked_sessions', v_revoked_sessions,
      'revoked_devices', v_revoked_devices,
      'cancelled_rosters', v_cancelled_rosters,
      'cancelled_swaps', v_cancelled_swaps
    ),
    v_reason
  );
  return jsonb_build_object(
    'id', v_target.id, 'active', v_target.active,
    'deactivated_at', v_target.deactivated_at, 'version', v_target.version,
    'revoked_sessions', v_revoked_sessions, 'revoked_devices', v_revoked_devices,
    'cancelled_rosters', v_cancelled_rosters, 'cancelled_swaps', v_cancelled_swaps
  );
end;
$$;

create or replace function public.rpc_request_attendance_correction(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_attendance_id uuid,
  p_correction_type text,
  p_proposed jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_target_role public.app_role;
  v_attendance public.attendance_records%rowtype;
  v_correction public.attendance_corrections%rowtype;
  v_type text := upper(btrim(p_correction_type));
  v_reason text := nullif(btrim(p_reason), '');
  v_proposed_at timestamptz;
begin
  if p_attendance_id is null or v_type is null
     or v_type not in ('CHECK_IN_TIME', 'CHECK_OUT_TIME', 'STATUS', 'LATENESS', 'EXCEPTION')
     or jsonb_typeof(p_proposed) is distinct from 'object' or p_proposed = '{}'::jsonb
     or pg_column_size(p_proposed) > 8192
     or v_reason is null or length(v_reason) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_CORRECTION: Attendance, type, proposed object, dan reason wajib valid.';
  end if;
  if (v_type in ('CHECK_IN_TIME', 'CHECK_OUT_TIME') and (
        not (p_proposed ? 'occurred_at')
        or exists (select 1 from jsonb_object_keys(p_proposed) as key(name) where name <> 'occurred_at')
        or jsonb_typeof(p_proposed->'occurred_at') <> 'string'
        or length(p_proposed->>'occurred_at') > 64
        or (p_proposed->>'occurred_at') !~ '^\d{4}-\d{2}-\d{2}T'
      ))
     or (v_type = 'STATUS' and (
        not (p_proposed ? 'status')
        or exists (select 1 from jsonb_object_keys(p_proposed) as key(name) where name <> 'status')
        or p_proposed->>'status' not in ('CHECKED_OUT', 'APPROVED')
      ))
     or (v_type = 'LATENESS' and (
        not (p_proposed ? 'lateness_status')
        or exists (select 1 from jsonb_object_keys(p_proposed) as key(name) where name <> 'lateness_status')
        or p_proposed->>'lateness_status' not in ('ON_TIME', 'LATE', 'EXCUSED')
      ))
     or (v_type = 'EXCEPTION' and (
        not (p_proposed ? 'exception_status')
        or exists (select 1 from jsonb_object_keys(p_proposed) as key(name) where name <> 'exception_status')
        or p_proposed->>'exception_status' <> 'RESOLVED'
      )) then
    raise exception using errcode = '22023', message = 'INVALID_PROPOSED_CORRECTION: Proposed payload tidak sesuai correction type.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  select * into v_attendance
  from public.attendance_records where id = p_attendance_id for update;
  if not found or v_attendance.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Attendance pada outlet tidak ditemukan.';
  end if;
  if v_type in ('CHECK_IN_TIME', 'CHECK_OUT_TIME') then
    begin
      v_proposed_at := (p_proposed->>'occurred_at')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'INVALID_PROPOSED_TIME: Timestamp koreksi tidak valid.';
    end;
    if not isfinite(v_proposed_at)
       or v_proposed_at < ((v_attendance.work_date::timestamp at time zone 'Asia/Jakarta') - interval '1 day')
       or v_proposed_at > ((v_attendance.work_date::timestamp at time zone 'Asia/Jakarta') + interval '2 days') then
      raise exception using errcode = '22023', message = 'INVALID_PROPOSED_TIME: Timestamp koreksi di luar jendela work date.';
    end if;
  end if;
  select role into v_target_role from public.profiles where id = v_attendance.profile_id;
  if v_attendance.profile_id <> p_actor_id then
    if v_role::text not in ('OWNER', 'SUPERVISOR')
       or (v_role::text = 'SUPERVISOR' and v_target_role::text <> 'OPERATOR') then
      raise exception using errcode = '42501', message = 'FORBIDDEN: Actor tidak dapat meminta koreksi attendance target.';
    end if;
  elsif v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak dapat meminta koreksi attendance.';
  end if;
  if exists (select 1 from public.attendance_corrections where attendance_id = p_attendance_id and status = 'PENDING') then
    raise exception using errcode = '55000', message = 'CORRECTION_PENDING: Attendance sudah memiliki koreksi PENDING.';
  end if;

  insert into public.attendance_corrections (
    attendance_id, correction_type, proposed_json, reason, requested_by, status
  ) values (
    p_attendance_id, v_type, p_proposed, v_reason, p_actor_id, 'PENDING'
  ) returning * into v_correction;

  perform public.log_audit_event(
    p_actor_id, 'REQUEST_ATTENDANCE_CORRECTION', 'attendance_corrections', v_correction.id::text,
    p_outlet_id, v_attendance.profile_id, null, to_jsonb(v_correction), v_reason
  );
  return to_jsonb(v_correction);
end;
$$;

create or replace function public.rpc_review_attendance_correction(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_correction_id uuid,
  p_status text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_target_role public.app_role;
  v_correction public.attendance_corrections%rowtype;
  v_attendance public.attendance_records%rowtype;
  v_before jsonb;
  v_status text := upper(btrim(p_status));
  v_note text := nullif(btrim(p_note), '');
  v_now timestamptz := clock_timestamp();
begin
  if p_correction_id is null or v_status is null or v_status not in ('APPROVED', 'REJECTED')
     or v_note is null or length(v_note) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW: Correction, status, dan note wajib valid.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Review koreksi attendance memerlukan manager.';
  end if;

  select * into v_correction
  from public.attendance_corrections where id = p_correction_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Koreksi attendance tidak ditemukan.';
  end if;
  select * into v_attendance
  from public.attendance_records where id = v_correction.attendance_id for update;
  if not found or v_attendance.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Attendance koreksi pada outlet tidak ditemukan.';
  end if;
  select role into v_target_role from public.profiles where id = v_attendance.profile_id;
  if p_actor_id = v_attendance.profile_id or p_actor_id = v_correction.requested_by then
    raise exception using errcode = '42501', message = 'SELF_APPROVAL_FORBIDDEN: Reviewer tidak boleh mereview koreksi milik/diajukan sendiri.';
  end if;
  if v_role::text = 'SUPERVISOR' and v_target_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN: SUPERVISOR hanya dapat mereview attendance OPERATOR.';
  end if;
  if v_correction.status <> 'PENDING' then
    raise exception using errcode = '55000', message = format('STATE_CONFLICT: Koreksi sudah %s.', v_correction.status);
  end if;
  if v_status = 'APPROVED'
     and v_correction.correction_type = 'STATUS'
     and v_attendance.check_out_event_id is null then
    raise exception using errcode = '55000', message = 'CHECKOUT_EVIDENCE_REQUIRED: Status final tidak dapat dibuat tanpa checkout event immutable.';
  end if;

  v_before := to_jsonb(v_correction);
  update public.attendance_corrections
  set status = v_status, reviewed_by = p_actor_id, reviewed_at = v_now, review_note = v_note
  where id = p_correction_id
  returning * into v_correction;

  if v_status = 'APPROVED' then
    -- Timestamp proposals remain an approved overlay in attendance_corrections;
    -- append-only attendance_events are never rewritten or fabricated.
    update public.attendance_records
    set status = case
          when v_correction.correction_type = 'STATUS' then v_correction.proposed_json->>'status'
          when check_out_event_id is not null then 'APPROVED'
          else status
        end,
        lateness_status = case
          when v_correction.correction_type = 'LATENESS' then v_correction.proposed_json->>'lateness_status'
          else lateness_status
        end,
        exception_status = case
          when v_correction.correction_type = 'EXCEPTION' then v_correction.proposed_json->>'exception_status'
          else 'RESOLVED'
        end,
        version = version + 1,
        updated_at = v_now
    where id = v_attendance.id
    returning * into v_attendance;
  else
    -- Rejection leaves the original attendance fact unchanged. The immutable
    -- correction decision remains the evidence for the rejected proposal.
    null;
  end if;

  perform public.log_audit_event(
    p_actor_id, 'REVIEW_ATTENDANCE_CORRECTION', 'attendance_corrections', v_correction.id::text,
    p_outlet_id, v_attendance.profile_id, v_before, to_jsonb(v_correction), v_note
  );
  return jsonb_build_object('correction', to_jsonb(v_correction), 'attendance', to_jsonb(v_attendance));
end;
$$;

create or replace function public.rpc_request_leave(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_target_id uuid,
  p_start_date date,
  p_end_date date,
  p_leave_type text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_target public.profiles%rowtype;
  v_leave public.leave_requests%rowtype;
  v_type text := upper(btrim(p_leave_type));
  v_reason text := nullif(btrim(p_reason), '');
begin
  if p_target_id is null or p_start_date is null or p_end_date is null
     or p_end_date < p_start_date or p_end_date > p_start_date + 366
     or v_type is null or v_type not in ('SICK', 'OTHER', 'UNPAID', 'OTHER_EXCEPTION')
     or v_reason is null or length(v_reason) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_LEAVE: Target, tanggal, type, dan reason wajib valid.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);

  select profile.* into v_target
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
  where profile.id = p_target_id
    and profile.active is true and profile.deactivated_at is null
  for update of profile;
  if not found or v_target.role::text not in ('OPERATOR', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'INVALID_LEAVE_TARGET: Target harus staff operational aktif pada outlet.';
  end if;
  if p_target_id <> p_actor_id then
    if v_role::text not in ('OWNER', 'SUPERVISOR')
       or (v_role::text = 'SUPERVISOR' and v_target.role::text <> 'OPERATOR') then
      raise exception using errcode = '42501', message = 'FORBIDDEN: Actor tidak dapat membuat leave untuk target.';
    end if;
  elsif v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak dapat meminta leave.';
  end if;

  perform 1
  from public.leave_requests
  where outlet_id = p_outlet_id and profile_id = p_target_id
    and status in ('PENDING', 'APPROVED')
    and start_date <= p_end_date and end_date >= p_start_date
  for update;
  if found then
    raise exception using errcode = '55000', message = 'LEAVE_OVERLAP: Target memiliki leave PENDING/APPROVED yang bertumpang tindih.';
  end if;

  insert into public.leave_requests (
    outlet_id, profile_id, start_date, end_date, leave_type, reason, submitted_by, status
  ) values (
    p_outlet_id, p_target_id, p_start_date, p_end_date, v_type, v_reason, p_actor_id, 'PENDING'
  ) returning * into v_leave;

  perform public.log_audit_event(
    p_actor_id, 'REQUEST_LEAVE', 'leave_requests', v_leave.id::text,
    p_outlet_id, p_target_id, null, to_jsonb(v_leave), v_reason
  );
  return to_jsonb(v_leave);
end;
$$;

-- leave_requests has no version column in 0006; row locking serializes cancel/review.
create or replace function public.rpc_cancel_leave(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_leave_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_target_role public.app_role;
  v_leave public.leave_requests%rowtype;
  v_before jsonb;
begin
  if p_leave_id is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Leave ID wajib diisi.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  select * into v_leave from public.leave_requests where id = p_leave_id for update;
  if not found or v_leave.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Leave pada outlet tidak ditemukan.';
  end if;
  select role into v_target_role from public.profiles where id = v_leave.profile_id;
  if p_actor_id not in (v_leave.profile_id, v_leave.submitted_by) then
    if v_role::text not in ('OWNER', 'SUPERVISOR')
       or (v_role::text = 'SUPERVISOR' and v_target_role::text <> 'OPERATOR') then
      raise exception using errcode = '42501', message = 'FORBIDDEN: Actor tidak dapat membatalkan leave target.';
    end if;
  end if;
  if v_leave.status <> 'PENDING' then
    raise exception using errcode = '55000', message = format('STATE_CONFLICT: Leave %s tidak dapat dibatalkan.', v_leave.status);
  end if;

  v_before := to_jsonb(v_leave);
  update public.leave_requests set status = 'CANCELLED' where id = p_leave_id returning * into v_leave;
  perform public.log_audit_event(
    p_actor_id, 'CANCEL_LEAVE', 'leave_requests', v_leave.id::text,
    p_outlet_id, v_leave.profile_id, v_before, to_jsonb(v_leave)
  );
  return to_jsonb(v_leave);
end;
$$;

create or replace function public.rpc_review_leave(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_leave_id uuid,
  p_status text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_target_role public.app_role;
  v_leave public.leave_requests%rowtype;
  v_before jsonb;
  v_status text := upper(btrim(p_status));
  v_note text := nullif(btrim(p_note), '');
begin
  if p_leave_id is null or v_status is null or v_status not in ('APPROVED', 'REJECTED')
     or v_note is null or length(v_note) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW: Leave, status, dan note wajib valid.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Review leave memerlukan manager.';
  end if;

  select * into v_leave from public.leave_requests where id = p_leave_id for update;
  if not found or v_leave.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Leave pada outlet tidak ditemukan.';
  end if;
  select role into v_target_role from public.profiles where id = v_leave.profile_id;
  if p_actor_id = v_leave.profile_id or p_actor_id = v_leave.submitted_by then
    raise exception using errcode = '42501', message = 'SELF_APPROVAL_FORBIDDEN: Reviewer tidak boleh mereview leave milik/diajukan sendiri.';
  end if;
  if v_role::text = 'SUPERVISOR' and v_target_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN: SUPERVISOR hanya dapat mereview leave OPERATOR.';
  end if;
  if v_leave.status <> 'PENDING' then
    raise exception using errcode = '55000', message = format('STATE_CONFLICT: Leave sudah %s.', v_leave.status);
  end if;

  v_before := to_jsonb(v_leave);
  update public.leave_requests
  set status = v_status, reviewed_by = p_actor_id,
      reviewed_at = clock_timestamp(), review_note = v_note
  where id = p_leave_id
  returning * into v_leave;

  perform public.log_audit_event(
    p_actor_id, 'REVIEW_LEAVE', 'leave_requests', v_leave.id::text,
    p_outlet_id, v_leave.profile_id, v_before, to_jsonb(v_leave), v_note
  );
  return to_jsonb(v_leave);
end;
$$;

create or replace function public.rpc_review_overtime(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_claim_id uuid,
  p_expected_version integer,
  p_status text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_target_role public.app_role;
  v_claim public.overtime_claims%rowtype;
  v_attendance public.attendance_records%rowtype;
  v_before jsonb;
  v_status text := upper(btrim(p_status));
  v_reason text := nullif(btrim(p_reason), '');
begin
  if p_claim_id is null or p_expected_version is null or p_expected_version <= 0
     or v_status is null or v_status not in ('APPROVED', 'REJECTED')
     or v_reason is null or length(v_reason) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW: Claim, version, status, dan reason wajib valid.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Review overtime memerlukan manager.';
  end if;

  select * into v_claim from public.overtime_claims where id = p_claim_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Overtime claim tidak ditemukan.';
  end if;
  select * into v_attendance from public.attendance_records where id = v_claim.attendance_id for update;
  if not found or v_attendance.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Attendance claim pada outlet tidak ditemukan.';
  end if;
  select role into v_target_role from public.profiles where id = v_attendance.profile_id;
  if p_actor_id = v_attendance.profile_id then
    raise exception using errcode = '42501', message = 'SELF_APPROVAL_FORBIDDEN: Reviewer tidak boleh mereview overtime sendiri.';
  end if;
  if v_role::text = 'SUPERVISOR' and v_target_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN: SUPERVISOR hanya dapat mereview overtime OPERATOR.';
  end if;
  if v_claim.version <> p_expected_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected overtime version %s, current version %s.', p_expected_version, v_claim.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_version, v_claim.version);
  end if;
  if v_claim.status <> 'CANDIDATE' then
    raise exception using errcode = '55000', message = format('STATE_CONFLICT: Overtime sudah %s.', v_claim.status);
  end if;
  if v_status = 'APPROVED' and (
    v_attendance.status not in ('CHECKED_OUT', 'APPROVED')
    or v_attendance.exception_status not in ('NONE', 'RESOLVED')
    or v_attendance.check_out_event_id is null
  ) then
    raise exception using errcode = '55000', message = 'ATTENDANCE_NOT_FINAL: Overtime hanya dapat disetujui dari attendance final.';
  end if;

  v_before := to_jsonb(v_claim);
  update public.overtime_claims
  set status = v_status, reason = v_reason, reviewed_by = p_actor_id,
      reviewed_at = clock_timestamp(), version = version + 1
  where id = p_claim_id
  returning * into v_claim;

  perform public.log_audit_event(
    p_actor_id, 'REVIEW_OVERTIME', 'overtime_claims', v_claim.id::text,
    p_outlet_id, v_attendance.profile_id, v_before, to_jsonb(v_claim), v_reason
  );
  return to_jsonb(v_claim);
end;
$$;

create or replace function public.rpc_correct_stock_movement(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_cycle_id uuid,
  p_expected_cycle_version integer,
  p_original_movement_id uuid,
  p_direction public.movement_direction,
  p_category text,
  p_quantity numeric,
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
  v_cycle public.work_cycles%rowtype;
  v_original public.stock_movements%rowtype;
  v_existing public.stock_movements%rowtype;
  v_movement public.stock_movements%rowtype;
  v_category text := upper(btrim(p_category));
  v_reason text := nullif(btrim(p_reason), '');
  v_cycle_version integer;
begin
  if p_cycle_id is null or p_expected_cycle_version is null or p_expected_cycle_version <= 0
     or p_original_movement_id is null or p_direction is null
     or v_category is null or p_quantity is null or p_quantity <= 0
     or p_quantity::text in ('NaN', 'Infinity', '-Infinity')
     or p_idempotency_key is null or v_reason is null or length(v_reason) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_CORRECTION: Cycle, version, movement, quantity, key, dan reason wajib valid.';
  end if;

  select * into v_cycle from public.work_cycles where id = p_cycle_id for update;
  if not found or v_cycle.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Cycle pada outlet tidak ditemukan.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak dapat mengoreksi stock movement.';
  end if;

  select * into v_existing
  from public.stock_movements
  where cycle_id = p_cycle_id and idempotency_key = p_idempotency_key::text
  for share;
  if found then
    if v_existing.created_by = p_actor_id
       and v_existing.correction_of_id = p_original_movement_id
       and v_existing.direction = p_direction
       and v_existing.category = v_category
       and v_existing.quantity = p_quantity
       and v_existing.correction_reason = v_reason then
      return to_jsonb(v_existing) || jsonb_build_object(
        'cycle_version', v_cycle.version, 'idempotent_replay', true
      );
    end if;
    raise exception using errcode = '23505', message = 'IDEMPOTENCY_CONFLICT: Key correction sudah digunakan dengan payload berbeda.';
  end if;

  if v_cycle.version <> p_expected_cycle_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected cycle version %s, current version %s.', p_expected_cycle_version, v_cycle.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_cycle_version, v_cycle.version);
  end if;
  if v_cycle.status <> 'OPEN' or v_cycle.movement_cutoff_at is not null
     or exists (select 1 from public.stock_handovers where cycle_id = p_cycle_id)
     or exists (select 1 from public.stock_closings where cycle_id = p_cycle_id) then
    raise exception using errcode = '55000', message = 'MOVEMENT_CUTOFF: Correction memerlukan cycle OPEN sebelum cutoff.';
  end if;

  select * into v_original
  from public.stock_movements
  where id = p_original_movement_id and cycle_id = p_cycle_id
  for share;
  if not found or v_original.correction_of_id is not null then
    raise exception using errcode = '22023', message = 'INVALID_ORIGINAL: Movement asal tidak ditemukan atau merupakan correction.';
  end if;
  if v_original.created_by <> p_actor_id and v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Hanya creator atau manager yang dapat mengoreksi movement.';
  end if;
  if v_role::text = 'OPERATOR' and not exists (
    select 1 from public.work_assignments
    where cycle_id = p_cycle_id and profile_id = p_actor_id and status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: OPERATOR memerlukan assignment aktif pada cycle.';
  end if;
  if exists (select 1 from public.stock_movements where correction_of_id = p_original_movement_id) then
    raise exception using errcode = '55000', message = 'MOVEMENT_ALREADY_CORRECTED: Movement asal sudah memiliki correction.';
  end if;
  if p_direction = v_original.direction or p_quantity <> v_original.quantity then
    raise exception using errcode = '22023', message = 'NON_NETTING_CORRECTION: Correction wajib berlawanan arah dan sama dengan quantity asal.';
  end if;
  if (p_direction = 'IN' and v_category not in ('PURCHASE', 'RETURN_IN', 'TRANSFER_IN'))
     or (p_direction = 'OUT' and v_category not in ('USAGE', 'INTERNAL', 'TRANSFER_OUT', 'WASTE')) then
    raise exception using errcode = '22023', message = 'INVALID_CATEGORY: Category tidak sesuai direction correction.';
  end if;

  insert into public.stock_movements (
    cycle_id, item_id, direction, category, quantity, unit_code_snapshot,
    client_occurred_at, server_occurred_at, created_by, idempotency_key,
    correction_of_id, correction_reason
  ) values (
    p_cycle_id, v_original.item_id, p_direction, v_category, p_quantity,
    v_original.unit_code_snapshot, null, clock_timestamp(), p_actor_id,
    p_idempotency_key::text, p_original_movement_id, v_reason
  ) returning * into v_movement;

  update public.work_cycles
  set version = version + 1, updated_at = clock_timestamp()
  where id = p_cycle_id
  returning version into v_cycle_version;

  perform public.log_audit_event(
    p_actor_id, 'CORRECT_STOCK_MOVEMENT', 'stock_movements', v_movement.id::text,
    p_outlet_id, null, to_jsonb(v_original), to_jsonb(v_movement), v_reason
  );
  return to_jsonb(v_movement) || jsonb_build_object(
    'cycle_version', v_cycle_version, 'idempotent_replay', false
  );
end;
$$;

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
  v_before jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_onboarding_version is null or p_onboarding_version <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Onboarding version wajib positif.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Guided onboarding hanya untuk OPERATOR.';
  end if;

  perform 1 from public.profiles where id = p_actor_id for update;
  select onboarding_version into v_current_version
  from public.outlet_settings where outlet_id = p_outlet_id for share;
  if not found or v_current_version <> p_onboarding_version then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Current onboarding version is %s.', coalesce(v_current_version::text, 'missing'));
  end if;

  select * into v_progress
  from public.onboarding_progress
  where profile_id = p_actor_id and onboarding_version = p_onboarding_version
  for update;
  if found and v_progress.completed_at is not null then
    return to_jsonb(v_progress) || jsonb_build_object('idempotent_replay', true);
  end if;
  v_before := case when found then to_jsonb(v_progress) else null end;

  if v_progress.profile_id is null then
    insert into public.onboarding_progress (
      profile_id, onboarding_version, started_at, completed_at, replay_count, updated_at
    ) values (
      p_actor_id, p_onboarding_version, v_now, v_now, 0, v_now
    ) returning * into v_progress;
  else
    update public.onboarding_progress
    set completed_at = v_now, updated_at = v_now
    where profile_id = p_actor_id and onboarding_version = p_onboarding_version
    returning * into v_progress;
  end if;

  perform public.log_audit_event(
    p_actor_id, 'COMPLETE_ONBOARDING', 'onboarding_progress',
    p_actor_id::text || ':' || p_onboarding_version::text,
    p_outlet_id, p_actor_id, v_before, to_jsonb(v_progress)
  );
  return to_jsonb(v_progress) || jsonb_build_object('idempotent_replay', false);
end;
$$;

create or replace function public.rpc_replay_onboarding(
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
  v_before jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_onboarding_version is null or p_onboarding_version <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Onboarding version wajib positif.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Replay onboarding hanya untuk OPERATOR.';
  end if;

  perform 1 from public.profiles where id = p_actor_id for update;
  select onboarding_version into v_current_version
  from public.outlet_settings where outlet_id = p_outlet_id for share;
  if not found or v_current_version <> p_onboarding_version then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Current onboarding version is %s.', coalesce(v_current_version::text, 'missing'));
  end if;

  select * into v_progress
  from public.onboarding_progress
  where profile_id = p_actor_id and onboarding_version = p_onboarding_version
  for update;
  v_before := case when found then to_jsonb(v_progress) else null end;

  if v_progress.profile_id is null then
    insert into public.onboarding_progress (
      profile_id, onboarding_version, started_at, completed_at, replay_count, updated_at
    ) values (
      p_actor_id, p_onboarding_version, v_now, null, 1, v_now
    ) returning * into v_progress;
  else
    update public.onboarding_progress
    set replay_count = replay_count + 1, updated_at = v_now
    where profile_id = p_actor_id and onboarding_version = p_onboarding_version
    returning * into v_progress;
  end if;

  perform public.log_audit_event(
    p_actor_id, 'REPLAY_ONBOARDING', 'onboarding_progress',
    p_actor_id::text || ':' || p_onboarding_version::text,
    p_outlet_id, p_actor_id, v_before, to_jsonb(v_progress)
  );
  return to_jsonb(v_progress);
end;
$$;

-- Opening/closing draft commands are intentionally omitted. The 0005 tables do
-- have DRAFT states, but they have no command idempotency key, draft owner, or
-- line-level/versioned draft concurrency contract. Adding APIs without those
-- facts would create overwrite races; confirmation RPCs remain the safe path.

create index if not exists leave_requests_profile_dates_state_idx
  on public.leave_requests (outlet_id, profile_id, start_date, end_date, status);

-- Exact signatures: browser roles receive none; only the trusted backend does.
revoke execute on function public.enforce_hr_request_state() from public, anon, authenticated;
revoke execute on function public.rpc_update_settings(uuid, uuid, integer, jsonb) from public, anon, authenticated;
revoke execute on function public.rpc_create_item(uuid, uuid, text, public.area_code, text, text, smallint, numeric) from public, anon, authenticated;
revoke execute on function public.rpc_update_item(uuid, uuid, text, text, text, smallint, numeric) from public, anon, authenticated;
revoke execute on function public.rpc_archive_item(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_save_roster(uuid, uuid, uuid, integer, date, text, uuid, public.area_code, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_cancel_shift_swap(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.rpc_complete_assignment(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.rpc_update_user(uuid, uuid, uuid, integer, text, public.app_role, text) from public, anon, authenticated;
revoke execute on function public.rpc_deactivate_user(uuid, uuid, uuid, integer, text) from public, anon, authenticated;
revoke execute on function public.rpc_request_attendance_correction(uuid, uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.rpc_review_attendance_correction(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_request_leave(uuid, uuid, uuid, date, date, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_cancel_leave(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_review_leave(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_review_overtime(uuid, uuid, uuid, integer, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_correct_stock_movement(uuid, uuid, uuid, integer, uuid, public.movement_direction, text, numeric, uuid, text) from public, anon, authenticated;
revoke execute on function public.rpc_complete_onboarding(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.rpc_replay_onboarding(uuid, uuid, integer) from public, anon, authenticated;

grant execute on function public.enforce_hr_request_state() to service_role;
grant execute on function public.rpc_update_settings(uuid, uuid, integer, jsonb) to service_role;
grant execute on function public.rpc_create_item(uuid, uuid, text, public.area_code, text, text, smallint, numeric) to service_role;
grant execute on function public.rpc_update_item(uuid, uuid, text, text, text, smallint, numeric) to service_role;
grant execute on function public.rpc_archive_item(uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_save_roster(uuid, uuid, uuid, integer, date, text, uuid, public.area_code, text, text) to service_role;
grant execute on function public.rpc_cancel_shift_swap(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.rpc_complete_assignment(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.rpc_update_user(uuid, uuid, uuid, integer, text, public.app_role, text) to service_role;
grant execute on function public.rpc_deactivate_user(uuid, uuid, uuid, integer, text) to service_role;
grant execute on function public.rpc_request_attendance_correction(uuid, uuid, uuid, text, jsonb, text) to service_role;
grant execute on function public.rpc_review_attendance_correction(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_request_leave(uuid, uuid, uuid, date, date, text, text) to service_role;
grant execute on function public.rpc_cancel_leave(uuid, uuid, uuid) to service_role;
grant execute on function public.rpc_review_leave(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_review_overtime(uuid, uuid, uuid, integer, text, text) to service_role;
grant execute on function public.rpc_correct_stock_movement(uuid, uuid, uuid, integer, uuid, public.movement_direction, text, numeric, uuid, text) to service_role;
grant execute on function public.rpc_complete_onboarding(uuid, uuid, integer) to service_role;
grant execute on function public.rpc_replay_onboarding(uuid, uuid, integer) to service_role;
