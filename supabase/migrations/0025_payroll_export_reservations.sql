-- 0025: atomic payroll evidence snapshots and lease-owned upload coordination.

create table public.payroll_export_reservations (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  run_id uuid not null references public.payroll_runs(id) on delete restrict,
  expected_run_version integer not null check (expected_run_version > 0),
  run_status text not null check (run_status in ('REVIEWED', 'FINALIZED', 'PAID')),
  idempotency_key uuid not null,
  export_label text not null check (export_label in ('DRAFT', 'FINALIZED')),
  file_path text not null,
  evidence_json jsonb not null check (jsonb_typeof(evidence_json) = 'object'),
  evidence_checksum_sha256 text not null check (evidence_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  row_counts jsonb not null check (jsonb_typeof(row_counts) = 'object'),
  final_export_id uuid not null default gen_random_uuid(),
  upload_token uuid,
  upload_lease_expires_at timestamptz,
  pending_artifact_checksum_sha256 text check (pending_artifact_checksum_sha256 is null or pending_artifact_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_checksum_sha256 text check (artifact_checksum_sha256 is null or artifact_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS', 'UPLOAD_UNKNOWN', 'COMMITTED', 'ABANDONED')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (actor_id, outlet_id, idempotency_key),
  unique (idempotency_key, run_id),
  unique (final_export_id),
  unique (file_path),
  check ((status = 'COMMITTED') = (artifact_checksum_sha256 is not null)),
  check ((status in ('IN_PROGRESS', 'UPLOAD_UNKNOWN')) = (upload_token is not null)),
  check ((status = 'IN_PROGRESS') = (upload_lease_expires_at is not null)),
  check ((status = 'UPLOAD_UNKNOWN') = (pending_artifact_checksum_sha256 is not null))
);

alter table public.payroll_export_reservations enable row level security;
revoke all on public.payroll_export_reservations from public, anon, authenticated, service_role;
grant select on public.payroll_export_reservations to service_role;

create index payroll_export_reservations_reconcile_idx
  on public.payroll_export_reservations (status, updated_at)
  where status in ('IN_PROGRESS', 'UPLOAD_UNKNOWN');

create or replace function public.enforce_payroll_export_reservation_state()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'IMMUTABLE_EXPORT_RESERVATION: Reservation tidak dapat dihapus.';
  end if;
  if row(old.id, old.actor_id, old.outlet_id, old.run_id, old.expected_run_version,
         old.run_status, old.idempotency_key, old.export_label, old.file_path,
         old.evidence_json, old.evidence_checksum_sha256, old.row_counts,
         old.final_export_id, old.created_at)
     is distinct from
     row(new.id, new.actor_id, new.outlet_id, new.run_id, new.expected_run_version,
         new.run_status, new.idempotency_key, new.export_label, new.file_path,
         new.evidence_json, new.evidence_checksum_sha256, new.row_counts,
         new.final_export_id, new.created_at) then
    raise exception using errcode = '55000', message = 'IMMUTABLE_EXPORT_RESERVATION: Metadata reservation tidak dapat diubah.';
  end if;
  if new.status = old.status and row(new.upload_token, new.upload_lease_expires_at,
     new.pending_artifact_checksum_sha256, new.artifact_checksum_sha256, new.updated_at) is not distinct from
     row(old.upload_token, old.upload_lease_expires_at, old.pending_artifact_checksum_sha256,
       old.artifact_checksum_sha256, old.updated_at) then
    return new;
  end if;
  if not (
    (old.status = 'IN_PROGRESS' and new.status in ('UPLOAD_UNKNOWN', 'COMMITTED', 'ABANDONED'))
    or (old.status = 'UPLOAD_UNKNOWN' and new.status in ('COMMITTED', 'ABANDONED'))
  ) then
    raise exception using errcode = '55000', message = 'INVALID_EXPORT_RESERVATION_TRANSITION: Transisi status reservation tidak valid.';
  end if;
  if new.status <> 'COMMITTED' and new.artifact_checksum_sha256 is not null then
    raise exception using errcode = '55000', message = 'INVALID_EXPORT_RESERVATION_STATE: Checksum artifact hanya boleh dicatat saat commit.';
  end if;
  if new.status = 'UPLOAD_UNKNOWN' and (new.upload_token is distinct from old.upload_token
     or new.upload_lease_expires_at is not null
     or new.pending_artifact_checksum_sha256 is null
     or new.artifact_checksum_sha256 is distinct from old.artifact_checksum_sha256) then
    raise exception using errcode = '55000', message = 'INVALID_EXPORT_RESERVATION_STATE: UPLOAD_UNKNOWN wajib mempertahankan token dan checksum pending.';
  end if;
  if new.status in ('COMMITTED', 'ABANDONED') and (new.upload_token is not null
     or new.upload_lease_expires_at is not null or new.pending_artifact_checksum_sha256 is not null) then
    raise exception using errcode = '55000', message = 'INVALID_EXPORT_RESERVATION_STATE: Reservation tertutup tidak boleh memiliki lease.';
  end if;
  return new;
end;
$$;

create trigger payroll_export_reservations_enforce_state
before update or delete on public.payroll_export_reservations
for each row execute function public.enforce_payroll_export_reservation_state();

create or replace function public.rpc_reserve_payroll_export(
  p_actor_id uuid, p_run_id uuid, p_expected_run_version integer, p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role public.app_role;
  v_run public.payroll_runs%rowtype;
  v_res public.payroll_export_reservations%rowtype;
  v_evidence jsonb;
  v_counts jsonb;
  v_label text;
  v_expected_entry_status text;
  v_final_export_id uuid := gen_random_uuid();
  v_upload_token uuid := gen_random_uuid();
  v_created_at timestamptz := clock_timestamp();
  v_inserted boolean := false;
begin
  if p_actor_id is null or p_run_id is null or p_expected_run_version is null
     or p_expected_run_version <= 0 or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'INVALID_EXPORT_RESERVATION: Actor, run, version, dan idempotency key wajib valid.';
  end if;

  select * into v_res from public.payroll_export_reservations
    where actor_id = p_actor_id and run_id = p_run_id and idempotency_key = p_idempotency_key;
  if found then
    v_role := public.require_authorized_actor(p_actor_id, v_res.outlet_id);
    if v_role::text not in ('OWNER', 'SUPERVISOR') then
      raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Export payroll hanya boleh dilakukan manager.';
    end if;
    if v_res.run_id <> p_run_id or v_res.expected_run_version <> p_expected_run_version then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payroll berbeda.';
    end if;
    return jsonb_build_object(
      'reservation_id', v_res.id, 'final_export_id', v_res.final_export_id,
      'file_path', v_res.file_path, 'evidence_json', v_res.evidence_json,
      'evidence_checksum_sha256', v_res.evidence_checksum_sha256, 'row_counts', v_res.row_counts,
      'artifact_checksum_sha256', v_res.artifact_checksum_sha256,
      'created_at', v_res.created_at, 'status', v_res.status,
      'upload_token', null, 'can_upload', false, 'idempotent_replay', true
    );
  end if;

  select * into v_run from public.payroll_runs where id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: Payroll run tidak ditemukan.'; end if;
  v_role := public.require_authorized_actor(p_actor_id, v_run.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Export payroll hanya boleh dilakukan manager.';
  end if;
  if v_run.version <> p_expected_run_version then
    raise exception using errcode = '40001', message = 'VERSION_CONFLICT: Versi payroll run sudah berubah.';
  end if;
  if v_run.status not in ('REVIEWED', 'FINALIZED', 'PAID') then
    raise exception using errcode = '55000', message = format('STATE_CONFLICT: Payroll %s tidak dapat diekspor.', v_run.status);
  end if;
  if v_run.period_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception using errcode = '22023', message = 'INVALID_PAYROLL_PERIOD: Bulan periode payroll tidak valid.';
  end if;

  v_label := case when v_run.status = 'REVIEWED' then 'DRAFT' else 'FINALIZED' end;
  v_expected_entry_status := case when v_run.status = 'REVIEWED' then 'REVIEWED' else 'APPROVED' end;
  select jsonb_build_object(
    'run', to_jsonb(v_run),
    'entries', coalesce((select jsonb_agg(to_jsonb(e) || jsonb_build_object('profiles', jsonb_build_object('display_name', p.display_name)) order by e.profile_id, e.id)
      from public.payroll_entries e join public.profiles p on p.id = e.profile_id where e.run_id = v_run.id), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at, a.id)
      from public.payroll_adjustments a join public.payroll_entries e on e.id = a.entry_id where e.run_id = v_run.id), '[]'::jsonb),
    'attendance', coalesce((select jsonb_agg(to_jsonb(ar) || jsonb_build_object(
        'profiles', jsonb_build_object('display_name', p.display_name),
        'attendance_events', coalesce((select jsonb_agg(jsonb_build_object('location_status', ae.location_status)
          order by ae.server_occurred_at, ae.id)
          from public.attendance_events ae where ae.attendance_id = ar.id), '[]'::jsonb)) order by ar.work_date, ar.profile_id, ar.id)
      from public.attendance_records ar join public.profiles p on p.id = ar.profile_id
      where ar.outlet_id = v_run.outlet_id and ar.work_date between (v_run.period_month || '-01')::date
        and ((v_run.period_month || '-01')::date + interval '1 month - 1 day')::date), '[]'::jsonb),
    'bonusRows', coalesce((select jsonb_agg(to_jsonb(ba) || jsonb_build_object('profiles', jsonb_build_object('display_name', p.display_name))
        order by dr.work_date, ba.profile_id, ba.id)
      from public.daily_reports dr
      join public.daily_report_revisions rr on rr.report_id = dr.id
      join public.daily_bonus_pools bp on bp.report_revision_id = rr.id and bp.status = 'FINAL'
      join public.daily_bonus_allocations ba on ba.pool_id = bp.id
      join public.profiles p on p.id = ba.profile_id
      where dr.outlet_id = v_run.outlet_id and dr.work_date between (v_run.period_month || '-01')::date
        and ((v_run.period_month || '-01')::date + interval '1 month - 1 day')::date), '[]'::jsonb),
    'auditEvents', coalesce((select jsonb_agg(to_jsonb(x) order by x.server_occurred_at desc, x.id desc) from (
      select ae.id, ae.server_occurred_at, ae.action, ae.entity_type, ae.entity_id, ae.reason,
        jsonb_build_object('display_name', p.display_name) as profiles
      from public.audit_events ae left join public.profiles p on p.id = ae.actor_user_id
      where ae.outlet_id = v_run.outlet_id
        and ae.server_occurred_at >= ((v_run.period_month || '-01')::date at time zone 'Asia/Jakarta')
        and ae.server_occurred_at < (((v_run.period_month || '-01')::date + interval '1 month') at time zone 'Asia/Jakarta')
      order by ae.server_occurred_at desc, ae.id desc limit 200
    ) x), '[]'::jsonb)
  ) into v_evidence;

  if jsonb_array_length(v_evidence->'entries') = 0
     or exists (select 1 from jsonb_array_elements(v_evidence->'entries') e where e->>'status' <> v_expected_entry_status) then
    raise exception using errcode = '55000', message = format('PAYROLL_ENTRY_STATUS_CONFLICT: Entry payroll wajib berstatus %s.', v_expected_entry_status);
  end if;

  v_counts := jsonb_build_object(
    'summary', jsonb_array_length(v_evidence->'entries'),
    'attendance', jsonb_array_length(v_evidence->'attendance'),
    'overtime', jsonb_array_length(v_evidence->'attendance'),
    'bonus', jsonb_array_length(v_evidence->'bonusRows'),
    'adjustments', jsonb_array_length(v_evidence->'adjustments'),
    'audit', jsonb_array_length(v_evidence->'auditEvents'),
    'evidence', jsonb_array_length(v_evidence->'entries')
  );
  v_evidence := v_evidence || jsonb_build_object('rowCounts', v_counts);

  insert into public.payroll_export_reservations(
    id, actor_id, outlet_id, run_id, expected_run_version, run_status, idempotency_key,
    export_label, file_path, evidence_json, evidence_checksum_sha256, row_counts,
    final_export_id, upload_token, upload_lease_expires_at, created_at, updated_at
  ) values (
    gen_random_uuid(), p_actor_id, v_run.outlet_id, v_run.id, v_run.version, v_run.status, p_idempotency_key,
    v_label, v_run.outlet_id::text || '/' || v_run.id::text || '/' || v_final_export_id::text ||
      '/HOPIN-PAYROLL-' || v_run.period_month || '-' || v_label || '.xlsx',
    v_evidence, encode(extensions.digest(convert_to(v_evidence::text, 'UTF8'), 'sha256'), 'hex'), v_counts,
    v_final_export_id, v_upload_token, v_created_at + interval '15 minutes', v_created_at, v_created_at
  ) on conflict do nothing
  returning true into v_inserted;
  v_inserted := coalesce(v_inserted, false);

  select * into v_res from public.payroll_export_reservations
    where actor_id = p_actor_id and outlet_id = v_run.outlet_id and idempotency_key = p_idempotency_key;
  if not found then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key sudah terikat pada actor atau payroll lain.';
  end if;
  if v_res.run_id <> p_run_id or v_res.expected_run_version <> p_expected_run_version then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payroll berbeda.';
  end if;

  return jsonb_build_object(
    'reservation_id', v_res.id, 'final_export_id', v_res.final_export_id,
    'file_path', v_res.file_path, 'evidence_json', v_res.evidence_json,
    'evidence_checksum_sha256', v_res.evidence_checksum_sha256, 'row_counts', v_res.row_counts,
    'artifact_checksum_sha256', v_res.artifact_checksum_sha256,
    'created_at', v_res.created_at, 'status', v_res.status,
    'upload_token', case when v_inserted then v_res.upload_token else null end,
    'can_upload', v_inserted, 'idempotent_replay', not v_inserted
  );
end;
$$;

create or replace function public.rpc_commit_payroll_export(
  p_actor_id uuid, p_reservation_id uuid, p_upload_token uuid, p_artifact_checksum_sha256 text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res public.payroll_export_reservations%rowtype;
  v_run public.payroll_runs%rowtype;
  v_role public.app_role;
  v_checksum text := lower(btrim(p_artifact_checksum_sha256));
begin
  if p_actor_id is null or p_reservation_id is null or p_upload_token is null
     or v_checksum is null or v_checksum !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_EXPORT_COMMIT: Lease dan checksum artifact wajib valid.';
  end if;
  select * into v_res from public.payroll_export_reservations where id = p_reservation_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: Reservation export tidak ditemukan.'; end if;
  v_role := public.require_authorized_actor(p_actor_id, v_res.outlet_id);
  if v_res.actor_id <> p_actor_id or v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Reservation bukan milik actor.';
  end if;
  if v_res.status = 'COMMITTED' then
    return jsonb_build_object('reservation_id', v_res.id, 'export_id', v_res.final_export_id,
      'checksum_sha256', v_res.artifact_checksum_sha256, 'idempotent_replay', true);
  end if;
  if v_res.status <> 'IN_PROGRESS' or v_res.upload_token <> p_upload_token
     or v_res.upload_lease_expires_at < clock_timestamp() then
    raise exception using errcode = '55000', message = 'UPLOAD_LEASE_MISMATCH: Lease upload tidak aktif atau bukan milik caller.';
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
  perform public.log_audit_event(p_actor_id, 'COMMIT_PAYROLL_EXPORT', 'payroll_exports', v_res.final_export_id::text,
    v_res.outlet_id, null, null, jsonb_build_object('reservation_id', v_res.id, 'run_id', v_res.run_id,
      'evidence_checksum_sha256', v_res.evidence_checksum_sha256));
  return jsonb_build_object('reservation_id', v_res.id, 'export_id', v_res.final_export_id,
    'checksum_sha256', v_checksum, 'idempotent_replay', false);
end;
$$;

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
  else
    if v_checksum is null then
      raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION: Checksum wajib untuk object yang terkonfirmasi ada.';
    end if;
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
  end if;
  select * into v_res from public.payroll_export_reservations where id = v_res.id;
  return jsonb_build_object('reservation_id', v_res.id, 'final_export_id', v_res.final_export_id,
    'status', v_res.status, 'artifact_checksum_sha256', v_res.artifact_checksum_sha256);
end;
$$;

create or replace function public.rpc_get_payroll_export_reservation(
  p_actor_id uuid, p_reservation_id uuid, p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res public.payroll_export_reservations%rowtype; v_role public.app_role;
begin
  if p_actor_id is null or p_reservation_id is null or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_LOOKUP: Parameter lookup wajib valid.';
  end if;
  select * into v_res from public.payroll_export_reservations where id = p_reservation_id;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: Reservation export tidak ditemukan.'; end if;
  v_role := public.require_authorized_actor(p_actor_id, v_res.outlet_id);
  if v_res.actor_id <> p_actor_id or v_res.idempotency_key <> p_idempotency_key
     or v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Reservation bukan milik actor.';
  end if;
  return jsonb_build_object('reservation_id', v_res.id, 'final_export_id', v_res.final_export_id,
    'file_path', v_res.file_path, 'status', v_res.status,
    'artifact_checksum_sha256', v_res.artifact_checksum_sha256);
end;
$$;

revoke execute on function public.enforce_payroll_export_reservation_state() from public, anon, authenticated;
revoke execute on function public.rpc_reserve_payroll_export(uuid, uuid, integer, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_commit_payroll_export(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.rpc_reconcile_payroll_export(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_get_payroll_export_reservation(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_record_payroll_export(uuid, uuid, integer, text, text, text, jsonb) from public, anon, authenticated, service_role;

grant execute on function public.rpc_reserve_payroll_export(uuid, uuid, integer, uuid) to service_role;
grant execute on function public.rpc_commit_payroll_export(uuid, uuid, uuid, text) to service_role;
grant execute on function public.rpc_reconcile_payroll_export(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_get_payroll_export_reservation(uuid, uuid, uuid) to service_role;

comment on table public.payroll_export_reservations is
  'Immutable atomic evidence snapshots with lease-owned upload state. payroll_exports is inserted only at commit.';
