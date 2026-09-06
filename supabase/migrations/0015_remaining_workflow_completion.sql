-- HOPIN Production Migration 0015: Remaining Transactional Workflow Completion
--
-- Browser roles remain unable to read/write operational tables or execute these
-- commands. The trusted API must authenticate its caller before passing actor IDs.
-- Every actor-bound mutation re-authorizes through require_authorized_actor(),
-- serializes its aggregate, uses an expected version, is idempotent, and audits.

-- ---------------------------------------------------------------------------
-- 1. Additive private workflow metadata
-- ---------------------------------------------------------------------------

-- app_sessions intentionally retains token/IP hashes for runtime validation, but
-- session-management RPCs below expose neither hashes nor device identifiers.
alter table public.app_sessions
  add column if not exists version integer not null default 1
    check (version > 0);

-- Existing payroll_adjustments lacked review concurrency and a review note.
alter table public.payroll_adjustments
  add column if not exists version integer not null default 1
    check (version > 0),
  add column if not exists review_note text;

-- Stores completed-command responses only. A reused key with a changed payload
-- fails closed; an in-flight row rolls back with its failed transaction.
create table if not exists public.workflow_idempotency (
  actor_user_id uuid not null references public.profiles(id) on delete restrict,
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  action text not null check (action ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  idempotency_key uuid not null,
  request_json jsonb not null,
  response_json jsonb,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  primary key (actor_user_id, outlet_id, action, idempotency_key)
);

-- These are editable client working copies, deliberately separate from immutable
-- stock snapshots. A cycle has one owner-bound draft at a time.
create table if not exists public.stock_opening_drafts (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null unique references public.work_cycles(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  lines_json jsonb not null default '[]'::jsonb check (jsonb_typeof(lines_json) = 'array'),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.stock_closing_drafts (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null unique references public.work_cycles(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  lines_json jsonb not null default '[]'::jsonb check (jsonb_typeof(lines_json) = 'array'),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

-- Finance may be drafted before an immutable daily-report revision exists.
create table if not exists public.daily_report_finance_drafts (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  work_date date not null,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  finance_json jsonb not null check (jsonb_typeof(finance_json) = 'object'),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (outlet_id, work_date)
);

-- Sharing records authorization, not a bearer link. Access still requires an
-- active recipient profile and outlet scope at read time.
create table if not exists public.daily_report_shares (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.daily_report_revisions(id) on delete restrict,
  recipient_id uuid not null references public.profiles(id) on delete restrict,
  shared_by uuid not null references public.profiles(id) on delete restrict,
  reason text,
  shared_at timestamptz not null default clock_timestamp(),
  check (recipient_id <> shared_by),
  unique (revision_id, recipient_id)
);

-- This records a successful authorization. It stores no signed URL, bearer token,
-- IP address, or payment artifact; the API creates a short-lived URL after return.
create table if not exists public.payroll_export_download_authorizations (
  id uuid primary key default gen_random_uuid(),
  export_id uuid not null references public.payroll_exports(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  idempotency_key uuid not null,
  authorized_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  unique (requested_by, idempotency_key)
);

alter table public.workflow_idempotency enable row level security;
alter table public.stock_opening_drafts enable row level security;
alter table public.stock_closing_drafts enable row level security;
alter table public.daily_report_finance_drafts enable row level security;
alter table public.daily_report_shares enable row level security;
alter table public.payroll_export_download_authorizations enable row level security;

revoke all on table
  public.workflow_idempotency,
  public.stock_opening_drafts,
  public.stock_closing_drafts,
  public.daily_report_finance_drafts,
  public.daily_report_shares,
  public.payroll_export_download_authorizations
from public, anon, authenticated;

grant all on table
  public.workflow_idempotency,
  public.stock_opening_drafts,
  public.stock_closing_drafts,
  public.daily_report_finance_drafts,
  public.daily_report_shares,
  public.payroll_export_download_authorizations
to service_role;

create index if not exists workflow_idempotency_completed_cleanup_idx
  on public.workflow_idempotency (completed_at)
  where completed_at is not null;
create index if not exists app_sessions_owner_active_seen_idx
  on public.app_sessions (profile_id, last_seen_at desc)
  where revoked_at is null;
create index if not exists stock_opening_drafts_owner_updated_idx
  on public.stock_opening_drafts (owner_id, updated_at desc);
create index if not exists stock_closing_drafts_owner_updated_idx
  on public.stock_closing_drafts (owner_id, updated_at desc);
create index if not exists daily_report_finance_drafts_owner_updated_idx
  on public.daily_report_finance_drafts (owner_id, updated_at desc);
create index if not exists daily_report_shares_recipient_idx
  on public.daily_report_shares (recipient_id, revision_id);
create index if not exists payroll_export_download_auth_export_actor_idx
  on public.payroll_export_download_authorizations (export_id, requested_by, authorized_at desc);
create index if not exists payroll_adjustments_entry_pending_review_idx
  on public.payroll_adjustments (entry_id, version)
  where status = 'PENDING';

-- ---------------------------------------------------------------------------
-- 2. Session management: self-only, no token/IP/device identifier disclosure
-- ---------------------------------------------------------------------------

create or replace function public.rpc_list_sessions(
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
  v_sessions jsonb;
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'session_id', session.id,
        'created_at', session.created_at,
        'last_seen_at', session.last_seen_at,
        'expires_at', least(session.expires_at, coalesce(session.absolute_expires_at, session.expires_at)),
        'version', session.version
      )
      order by session.last_seen_at desc, session.id
    ),
    '[]'::jsonb
  ) into v_sessions
  from public.app_sessions session
  where session.profile_id = p_actor_id
    and session.revoked_at is null
    and session.expires_at > clock_timestamp()
    and (session.absolute_expires_at is null or session.absolute_expires_at > clock_timestamp());

  perform public.log_audit_event(
    p_actor_id, 'LIST_SESSIONS', 'app_sessions', p_actor_id::text,
    p_outlet_id, p_actor_id, null,
    jsonb_build_object('active_session_count', jsonb_array_length(v_sessions))
  );

  return jsonb_build_object('sessions', v_sessions);
end;
$$;

create or replace function public.rpc_revoke_sessions(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_session_ids uuid[],
  p_expected_versions integer[],
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_session public.app_sessions%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_requested_session_id uuid;
  v_requested_version integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_idempotency_key is null
     or coalesce(cardinality(p_session_ids), 0) not between 1 and 20
     or cardinality(p_session_ids) <> cardinality(p_expected_versions)
     or exists (select 1 from unnest(p_session_ids) as session_id where session_id is null)
     or exists (select 1 from unnest(p_expected_versions) as version where version is null or version <= 0)
     or (select count(distinct session_id) from unnest(p_session_ids) as session_id)
          <> cardinality(p_session_ids) then
    raise exception using errcode = '22023', message = 'INVALID_SESSIONS: Session IDs, expected versions, dan idempotency key wajib valid.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  v_request := jsonb_build_object(
    'session_ids', to_jsonb(p_session_ids),
    'expected_versions', to_jsonb(p_expected_versions)
  );

  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, p_outlet_id, 'REVOKE_SESSIONS', p_idempotency_key, v_request
  ) on conflict do nothing;

  select * into v_idempotency
  from public.workflow_idempotency
  where actor_user_id = p_actor_id
    and outlet_id = p_outlet_id
    and action = 'REVOKE_SESSIONS'
    and idempotency_key = p_idempotency_key
  for update;

  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  -- Deterministic ordering prevents two self-revocation batches deadlocking.
  for v_requested_session_id, v_requested_version in
    select requested.session_id, requested.expected_version
    from unnest(p_session_ids, p_expected_versions) as requested(session_id, expected_version)
    order by requested.session_id
  loop
    select * into v_session
    from public.app_sessions
    where id = v_requested_session_id
    for update;

    if not found or v_session.profile_id <> p_actor_id then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND: Session milik actor tidak ditemukan.';
    end if;
    if v_session.version <> v_requested_version then
      raise exception using
        errcode = '40001',
        message = format('VERSION_CONFLICT: Expected session version %s, current version %s.', v_requested_version, v_session.version),
        detail = format('expected_version=%s,current_version=%s', v_requested_version, v_session.version);
    end if;
    if v_session.revoked_at is not null then
      raise exception using errcode = '55000', message = 'SESSION_REVOKED: Session sudah direvoke.';
    end if;
  end loop;

  update public.app_sessions
  set revoked_at = v_now,
      version = version + 1
  where id = any(p_session_ids)
    and profile_id = p_actor_id
    and revoked_at is null;

  v_response := jsonb_build_object('revoked_count', cardinality(p_session_ids));
  update public.workflow_idempotency
  set response_json = v_response, completed_at = v_now
  where actor_user_id = p_actor_id
    and outlet_id = p_outlet_id
    and action = 'REVOKE_SESSIONS'
    and idempotency_key = p_idempotency_key;

  perform public.log_audit_event(
    p_actor_id, 'REVOKE_SESSIONS', 'app_sessions', p_actor_id::text,
    p_outlet_id, p_actor_id, null, v_response
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Versioned, owner-bound stock drafts
-- ---------------------------------------------------------------------------

create or replace function public.rpc_save_opening_draft(
  p_actor_id uuid,
  p_cycle_id uuid,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle public.work_cycles%rowtype;
  v_role public.app_role;
  v_draft public.stock_opening_drafts%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_before jsonb;
begin
  if p_cycle_id is null or p_idempotency_key is null
     or jsonb_typeof(p_lines) is distinct from 'array'
     or pg_column_size(p_lines) > 32768
     or jsonb_array_length(p_lines) > 200
     or exists (
       select 1 from jsonb_array_elements(p_lines) as line(value)
       where jsonb_typeof(line.value) <> 'object'
          or not (line.value ?& array['item_id', 'counted_qty'])
          or jsonb_typeof(line.value->'item_id') <> 'string'
          or jsonb_typeof(line.value->'counted_qty') <> 'number'
          or (line.value ? 'reason_code' and jsonb_typeof(line.value->'reason_code') not in ('string', 'null'))
          or (line.value ? 'notes' and jsonb_typeof(line.value->'notes') not in ('string', 'null'))
          or (line.value->>'counted_qty')::numeric < 0
          or (line.value->>'counted_qty')::numeric > 9999999999.9999
     )
     or exists (
       select 1
       from jsonb_array_elements(p_lines) as line(value)
       cross join lateral jsonb_object_keys(
         case when jsonb_typeof(line.value) = 'object' then line.value else '{}'::jsonb end
       ) as key(name)
       where jsonb_typeof(line.value) = 'object'
         and key.name not in ('item_id', 'counted_qty', 'reason_code', 'notes')
     )
     or (select count(distinct line.value->>'item_id') from jsonb_array_elements(p_lines) as line(value))
          <> jsonb_array_length(p_lines) then
    raise exception using errcode = '22023', message = 'INVALID_DRAFT_LINES: Lines draft opening tidak valid.';
  end if;

  select * into v_cycle from public.work_cycles where id = p_cycle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, v_cycle.outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan menyimpan draft opening.';
  end if;
  if v_cycle.status <> 'ACTIVE' then
    raise exception using errcode = '55000', message = 'INVALID_CYCLE_STATE: Draft opening hanya dapat disimpan pada cycle ACTIVE.';
  end if;
  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1 from public.work_assignments assignment
    where assignment.cycle_id = p_cycle_id
      and assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY'
      and assignment.status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Draft opening memerlukan primary cycle atau manager.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as line(value)
    left join public.items item on item.id = line.value->>'item_id'
    where item.id is null or item.active is not true or item.area_code <> v_cycle.area_code
  ) then
    raise exception using errcode = '22023', message = 'INVALID_DRAFT_ITEM: Semua item draft wajib aktif dan berada pada area cycle.';
  end if;

  v_request := jsonb_build_object('cycle_id', p_cycle_id, 'expected_version', p_expected_version, 'lines', p_lines);
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, v_cycle.outlet_id, 'SAVE_OPENING_DRAFT', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency
  from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = v_cycle.outlet_id
    and action = 'SAVE_OPENING_DRAFT' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  select * into v_draft from public.stock_opening_drafts where cycle_id = p_cycle_id for update;
  if found then
    if v_draft.owner_id <> p_actor_id then
      raise exception using errcode = '42501', message = 'DRAFT_OWNED_BY_OTHER: Draft opening hanya dapat diubah pemiliknya.';
    end if;
    if p_expected_version is null or v_draft.version <> p_expected_version then
      raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected draft version %s, current version %s.', coalesce(p_expected_version::text, 'NULL'), v_draft.version);
    end if;
    v_before := jsonb_build_object('version', v_draft.version, 'line_count', jsonb_array_length(v_draft.lines_json));
    update public.stock_opening_drafts
    set lines_json = p_lines, version = version + 1, updated_at = clock_timestamp()
    where id = v_draft.id
    returning * into v_draft;
  else
    if p_expected_version is not null then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT: Draft opening belum ada; expected_version harus NULL.';
    end if;
    insert into public.stock_opening_drafts (cycle_id, owner_id, lines_json)
    values (p_cycle_id, p_actor_id, p_lines)
    returning * into v_draft;
  end if;

  v_response := jsonb_build_object(
    'draft_id', v_draft.id, 'cycle_id', v_draft.cycle_id,
    'owner_id', v_draft.owner_id, 'version', v_draft.version,
    'line_count', jsonb_array_length(v_draft.lines_json), 'updated_at', v_draft.updated_at
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = clock_timestamp()
  where actor_user_id = p_actor_id and outlet_id = v_cycle.outlet_id
    and action = 'SAVE_OPENING_DRAFT' and idempotency_key = p_idempotency_key;
  perform public.log_audit_event(
    p_actor_id, 'SAVE_OPENING_DRAFT', 'stock_opening_drafts', v_draft.id::text,
    v_cycle.outlet_id, p_actor_id, v_before, v_response
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

create or replace function public.rpc_save_closing_draft(
  p_actor_id uuid,
  p_cycle_id uuid,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle public.work_cycles%rowtype;
  v_role public.app_role;
  v_draft public.stock_closing_drafts%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_before jsonb;
begin
  if p_cycle_id is null or p_idempotency_key is null
     or jsonb_typeof(p_lines) is distinct from 'array'
     or pg_column_size(p_lines) > 32768
     or jsonb_array_length(p_lines) > 200
     or exists (
       select 1 from jsonb_array_elements(p_lines) as line(value)
       where jsonb_typeof(line.value) <> 'object'
          or not (line.value ?& array['item_id', 'counted_qty'])
          or jsonb_typeof(line.value->'item_id') <> 'string'
          or jsonb_typeof(line.value->'counted_qty') <> 'number'
          or (line.value ? 'reason_code' and jsonb_typeof(line.value->'reason_code') not in ('string', 'null'))
          or (line.value ? 'notes' and jsonb_typeof(line.value->'notes') not in ('string', 'null'))
          or (line.value->>'counted_qty')::numeric < 0
          or (line.value->>'counted_qty')::numeric > 9999999999.9999
     )
     or exists (
       select 1
       from jsonb_array_elements(p_lines) as line(value)
       cross join lateral jsonb_object_keys(
         case when jsonb_typeof(line.value) = 'object' then line.value else '{}'::jsonb end
       ) as key(name)
       where jsonb_typeof(line.value) = 'object'
         and key.name not in ('item_id', 'counted_qty', 'reason_code', 'notes')
     )
     or (select count(distinct line.value->>'item_id') from jsonb_array_elements(p_lines) as line(value))
          <> jsonb_array_length(p_lines) then
    raise exception using errcode = '22023', message = 'INVALID_DRAFT_LINES: Lines draft closing tidak valid.';
  end if;

  select * into v_cycle from public.work_cycles where id = p_cycle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, v_cycle.outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan menyimpan draft closing.';
  end if;
  if v_cycle.shift_code not in ('MALAM', 'FULL')
     or v_cycle.status <> 'OPEN'
     or v_cycle.movement_cutoff_at is not null then
    raise exception using errcode = '55000', message = 'INVALID_CYCLE_STATE: Draft closing hanya dapat disimpan pada cycle MALAM/FULL yang OPEN.';
  end if;
  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1 from public.work_assignments assignment
    where assignment.cycle_id = p_cycle_id
      and assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY'
      and assignment.status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Draft closing memerlukan primary cycle atau manager.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as line(value)
    left join public.items item on item.id = line.value->>'item_id'
    where item.id is null or item.active is not true or item.area_code <> v_cycle.area_code
  ) then
    raise exception using errcode = '22023', message = 'INVALID_DRAFT_ITEM: Semua item draft wajib aktif dan berada pada area cycle.';
  end if;

  v_request := jsonb_build_object('cycle_id', p_cycle_id, 'expected_version', p_expected_version, 'lines', p_lines);
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, v_cycle.outlet_id, 'SAVE_CLOSING_DRAFT', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency
  from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = v_cycle.outlet_id
    and action = 'SAVE_CLOSING_DRAFT' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  select * into v_draft from public.stock_closing_drafts where cycle_id = p_cycle_id for update;
  if found then
    if v_draft.owner_id <> p_actor_id then
      raise exception using errcode = '42501', message = 'DRAFT_OWNED_BY_OTHER: Draft closing hanya dapat diubah pemiliknya.';
    end if;
    if p_expected_version is null or v_draft.version <> p_expected_version then
      raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected draft version %s, current version %s.', coalesce(p_expected_version::text, 'NULL'), v_draft.version);
    end if;
    v_before := jsonb_build_object('version', v_draft.version, 'line_count', jsonb_array_length(v_draft.lines_json));
    update public.stock_closing_drafts
    set lines_json = p_lines, version = version + 1, updated_at = clock_timestamp()
    where id = v_draft.id
    returning * into v_draft;
  else
    if p_expected_version is not null then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT: Draft closing belum ada; expected_version harus NULL.';
    end if;
    insert into public.stock_closing_drafts (cycle_id, owner_id, lines_json)
    values (p_cycle_id, p_actor_id, p_lines)
    returning * into v_draft;
  end if;

  v_response := jsonb_build_object(
    'draft_id', v_draft.id, 'cycle_id', v_draft.cycle_id,
    'owner_id', v_draft.owner_id, 'version', v_draft.version,
    'line_count', jsonb_array_length(v_draft.lines_json), 'updated_at', v_draft.updated_at
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = clock_timestamp()
  where actor_user_id = p_actor_id and outlet_id = v_cycle.outlet_id
    and action = 'SAVE_CLOSING_DRAFT' and idempotency_key = p_idempotency_key;
  perform public.log_audit_event(
    p_actor_id, 'SAVE_CLOSING_DRAFT', 'stock_closing_drafts', v_draft.id::text,
    v_cycle.outlet_id, p_actor_id, v_before, v_response
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Finance drafts, controlled report reads, and non-bearer report sharing
-- ---------------------------------------------------------------------------

create or replace function public.rpc_save_report_finance(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_work_date date,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_finance jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_report public.daily_reports%rowtype;
  v_draft public.daily_report_finance_drafts%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_before jsonb;
  v_cash_real numeric;
  v_cash_app numeric;
  v_qris numeric;
  v_debit numeric;
begin
  if p_work_date is null or p_idempotency_key is null
     or jsonb_typeof(p_finance) is distinct from 'object'
     or pg_column_size(p_finance) > 8192
     or not (p_finance ?& array['cash_real', 'cash_app', 'qris_mandiri', 'debit_mandiri'])
     or exists (
       select 1 from jsonb_object_keys(p_finance) as key(name)
       where key.name not in ('cash_real', 'cash_app', 'qris_mandiri', 'debit_mandiri')
     )
     or exists (
       select 1 from jsonb_each(p_finance) as value_pair(name, value)
       where jsonb_typeof(value_pair.value) <> 'number'
     ) then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE: Empat field finance numerik wajib diisi tanpa field tambahan.';
  end if;

  v_cash_real := (p_finance->>'cash_real')::numeric;
  v_cash_app := (p_finance->>'cash_app')::numeric;
  v_qris := (p_finance->>'qris_mandiri')::numeric;
  v_debit := (p_finance->>'debit_mandiri')::numeric;
  if v_cash_real < 0 or v_cash_app < 0 or v_qris < 0 or v_debit < 0
     or v_cash_real > 99999999999999 or v_cash_app > 99999999999999
     or v_qris > 99999999999999 or v_debit > 99999999999999
     or trunc(v_cash_real) <> v_cash_real or trunc(v_cash_app) <> v_cash_app
     or trunc(v_qris) <> v_qris or trunc(v_debit) <> v_debit
     or v_cash_real::text in ('NaN', 'Infinity', '-Infinity')
     or v_cash_app::text in ('NaN', 'Infinity', '-Infinity')
     or v_qris::text in ('NaN', 'Infinity', '-Infinity')
     or v_debit::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE: Semua nilai finance wajib whole dan nonnegative.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan menyimpan finance laporan.';
  end if;
  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY'
      and assignment.status = 'ACTIVE'
      and cycle.outlet_id = p_outlet_id
      and cycle.work_date = p_work_date
      and cycle.area_code = 'BAR'
      and cycle.shift_code in ('MALAM', 'FULL')
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Finance laporan memerlukan primary BAR MALAM/FULL atau manager.';
  end if;

  -- Serialize the no-parent-yet path without taking a global table lock.
  perform pg_advisory_xact_lock(hashtextextended(p_outlet_id::text || ':' || p_work_date::text, 0));
  v_request := jsonb_build_object('work_date', p_work_date, 'expected_version', p_expected_version, 'finance', p_finance);
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, p_outlet_id, 'SAVE_REPORT_FINANCE', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency
  from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = p_outlet_id
    and action = 'SAVE_REPORT_FINANCE' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  -- Materialize and lock the parent before the draft. Existing submission locks
  -- this same row, so finance cannot commit after the report becomes immutable.
  insert into public.daily_reports (outlet_id, work_date, status, current_revision)
  values (p_outlet_id, p_work_date, 'DRAFT', 0)
  on conflict (outlet_id, work_date) do nothing;
  select * into v_report
  from public.daily_reports
  where outlet_id = p_outlet_id and work_date = p_work_date
  for update;
  if found and v_report.status not in ('DRAFT', 'NEEDS_CLARIFICATION') then
    raise exception using errcode = '55000', message = 'REPORT_IMMUTABLE: Finance draft tidak dapat diubah setelah laporan dikirim atau disetujui.';
  end if;

  select * into v_draft
  from public.daily_report_finance_drafts
  where outlet_id = p_outlet_id and work_date = p_work_date
  for update;
  if found then
    if v_draft.owner_id <> p_actor_id then
      raise exception using errcode = '42501', message = 'DRAFT_OWNED_BY_OTHER: Draft finance hanya dapat diubah pemiliknya.';
    end if;
    if p_expected_version is null or v_draft.version <> p_expected_version then
      raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected finance draft version %s, current version %s.', coalesce(p_expected_version::text, 'NULL'), v_draft.version);
    end if;
    v_before := jsonb_build_object('version', v_draft.version);
    update public.daily_report_finance_drafts
    set finance_json = p_finance, version = version + 1, updated_at = clock_timestamp()
    where id = v_draft.id
    returning * into v_draft;
  else
    if p_expected_version is not null then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT: Draft finance belum ada; expected_version harus NULL.';
    end if;
    insert into public.daily_report_finance_drafts (outlet_id, work_date, owner_id, finance_json)
    values (p_outlet_id, p_work_date, p_actor_id, p_finance)
    returning * into v_draft;
  end if;

  v_response := jsonb_build_object(
    'draft_id', v_draft.id, 'outlet_id', v_draft.outlet_id,
    'work_date', v_draft.work_date, 'owner_id', v_draft.owner_id,
    'version', v_draft.version, 'updated_at', v_draft.updated_at
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = clock_timestamp()
  where actor_user_id = p_actor_id and outlet_id = p_outlet_id
    and action = 'SAVE_REPORT_FINANCE' and idempotency_key = p_idempotency_key;
  perform public.log_audit_event(
    p_actor_id, 'SAVE_REPORT_FINANCE', 'daily_report_finance_drafts', v_draft.id::text,
    p_outlet_id, p_actor_id, v_before, v_response
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

create or replace function public.rpc_get_report(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_work_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_report public.daily_reports%rowtype;
  v_revision public.daily_report_revisions%rowtype;
  v_draft public.daily_report_finance_drafts%rowtype;
  v_allowed boolean := false;
  v_result jsonb;
begin
  if p_work_date is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Work date wajib diisi.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);

  select * into v_report
  from public.daily_reports
  where outlet_id = p_outlet_id and work_date = p_work_date;
  if found and v_report.current_revision > 0 then
    select * into v_revision
    from public.daily_report_revisions
    where report_id = v_report.id and revision = v_report.current_revision;
  end if;

  if v_role::text in ('OWNER', 'SUPERVISOR') then
    v_allowed := true;
  elsif v_revision.id is not null and (
    v_revision.submitted_by = p_actor_id
    or exists (
      select 1 from public.daily_report_shares share
      where share.revision_id = v_revision.id and share.recipient_id = p_actor_id
    )
  ) then
    v_allowed := true;
  elsif exists (
    select 1
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY'
      and assignment.status <> 'RESET'
      and cycle.outlet_id = p_outlet_id
      and cycle.work_date = p_work_date
      and cycle.shift_code in ('MALAM', 'FULL')
  ) then
    v_allowed := true;
  end if;

  select * into v_draft
  from public.daily_report_finance_drafts
  where outlet_id = p_outlet_id and work_date = p_work_date;

  if not v_allowed and (v_draft.id is null or v_draft.owner_id <> p_actor_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Actor tidak berhak membaca laporan ini.';
  end if;
  if v_report.id is null and v_draft.id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Laporan dan draft finance tidak ditemukan.';
  end if;

  v_result := jsonb_build_object(
    'report', case when v_report.id is null then null else to_jsonb(v_report) end,
    'revision', case when v_revision.id is null then null else to_jsonb(v_revision) end,
    'finance', case when v_revision.id is null then null else (
      select to_jsonb(finance) from public.daily_report_finance finance where finance.revision_id = v_revision.id
    ) end,
    'stock_lines', case when v_revision.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(to_jsonb(line) order by line.area_code, line.item_id)
      from public.daily_report_stock_lines line where line.revision_id = v_revision.id
    ), '[]'::jsonb) end,
    'finance_draft', case
      when v_draft.id is not null and (v_draft.owner_id = p_actor_id or v_role::text in ('OWNER', 'SUPERVISOR'))
      then to_jsonb(v_draft)
      else null
    end
  );
  perform public.log_audit_event(
    p_actor_id, 'VIEW_REPORT', 'daily_reports', coalesce(v_report.id::text, v_draft.id::text),
    p_outlet_id, null, null,
    jsonb_build_object('revision_id', v_revision.id, 'has_finance_draft', v_draft.id is not null)
  );
  return v_result;
end;
$$;

create or replace function public.rpc_share_report(
  p_actor_id uuid,
  p_revision_id uuid,
  p_expected_report_version integer,
  p_recipient_id uuid,
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
  v_report public.daily_reports%rowtype;
  v_revision public.daily_report_revisions%rowtype;
  v_share public.daily_report_shares%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_reason text := nullif(btrim(p_reason), '');
  v_existing boolean := false;
begin
  if p_revision_id is null or p_recipient_id is null or p_recipient_id = p_actor_id
     or p_expected_report_version is null or p_expected_report_version <= 0
     or p_idempotency_key is null or length(coalesce(v_reason, '')) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_SHARE: Revision, recipient lain, version, reason, dan idempotency key wajib valid.';
  end if;

  select * into v_revision from public.daily_report_revisions where id = p_revision_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Revisi laporan tidak ditemukan.';
  end if;
  select * into v_report from public.daily_reports where id = v_revision.report_id for update;
  v_role := public.require_authorized_actor(p_actor_id, v_report.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya manager dapat membagikan laporan.';
  end if;

  v_request := jsonb_build_object(
    'revision_id', p_revision_id, 'expected_report_version', p_expected_report_version,
    'recipient_id', p_recipient_id, 'reason', v_reason
  );
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, v_report.outlet_id, 'SHARE_REPORT', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = v_report.outlet_id
    and action = 'SHARE_REPORT' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  if v_report.version <> p_expected_report_version then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected report version %s, current version %s.', p_expected_report_version, v_report.version);
  end if;
  if v_report.status <> 'APPROVED'
     or v_revision.status <> 'APPROVED'
     or v_report.current_revision <> v_revision.revision then
    raise exception using errcode = '55000', message = 'REPORT_NOT_APPROVED: Hanya revisi laporan terkini yang APPROVED dapat dibagikan.';
  end if;
  if not exists (
    select 1
    from public.profiles profile
    join public.profile_outlet_scopes scope
      on scope.profile_id = profile.id and scope.outlet_id = v_report.outlet_id and scope.active is true
    where profile.id = p_recipient_id
      and profile.active is true and profile.deactivated_at is null and profile.force_pin_change is false
      and profile.role::text = 'INVESTOR'
  ) then
    raise exception using errcode = '42501', message = 'INVALID_RECIPIENT: Recipient harus manager/investor aktif dengan scope outlet.';
  end if;

  select * into v_share
  from public.daily_report_shares
  where revision_id = p_revision_id and recipient_id = p_recipient_id
  for update;
  if found then
    v_existing := true;
  else
    insert into public.daily_report_shares (revision_id, recipient_id, shared_by, reason)
    values (p_revision_id, p_recipient_id, p_actor_id, v_reason)
    returning * into v_share;
  end if;

  v_response := jsonb_build_object(
    'share_id', v_share.id, 'revision_id', v_share.revision_id,
    'recipient_id', v_share.recipient_id, 'shared_at', v_share.shared_at,
    'already_shared', v_existing
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = clock_timestamp()
  where actor_user_id = p_actor_id and outlet_id = v_report.outlet_id
    and action = 'SHARE_REPORT' and idempotency_key = p_idempotency_key;
  if not v_existing then
    perform public.log_audit_event(
      p_actor_id, 'SHARE_REPORT', 'daily_report_shares', v_share.id::text,
      v_report.outlet_id, p_recipient_id, null, v_response, v_reason
    );
  end if;
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Payroll adjustment proposal/review, no automatic legal calculation
-- ---------------------------------------------------------------------------

create or replace function public.enforce_payroll_adjustment_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_status text;
begin
  if tg_op = 'UPDATE' and new.entry_id is distinct from old.entry_id then
    raise exception using errcode = '55000', message = 'IMMUTABLE_PARENT: Payroll adjustment tidak boleh dipindahkan antar-entry.';
  end if;

  select run.status into v_run_status
  from public.payroll_entries entry
  join public.payroll_runs run on run.id = entry.run_id
  where entry.id = case when tg_op = 'INSERT' then new.entry_id else old.entry_id end;
  if v_run_status is null then
    raise exception using errcode = '23503', message = 'PARENT_NOT_FOUND: Payroll entry tidak ditemukan.';
  end if;
  if v_run_status <> 'DRAFT' then
    raise exception using errcode = '55000', message = 'IMMUTABLE_PAYROLL: Adjustment hanya dapat dimutasi saat run DRAFT.';
  end if;

  -- Keep the pre-existing DRAFT-entry cascade path working for rpc_preview_payroll.
  if tg_op = 'DELETE' then
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'PENDING' or new.version <> 1
       or new.proposed_by is null or new.reviewed_by is not null
       or new.reviewed_at is not null or new.review_note is not null
       or nullif(btrim(new.adjustment_type), '') is null
       or length(new.adjustment_type) > 64
       or nullif(btrim(new.reason), '') is null
       or length(new.reason) > 1000
       or new.quantity <= 0 or new.quantity::text in ('NaN', 'Infinity', '-Infinity')
       or new.rate::text in ('NaN', 'Infinity', '-Infinity')
       or new.amount::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception using errcode = '23514', message = 'INVALID_PAYROLL_ADJUSTMENT: Proposal adjustment tidak valid.';
    end if;
    return new;
  end if;

  if old.status <> 'PENDING'
     or new.status not in ('APPROVED', 'REJECTED')
     or new.reviewed_by is null or new.reviewed_at is null
     or new.reviewed_by = old.proposed_by
     or nullif(btrim(new.review_note), '') is null or length(new.review_note) > 1000
     or new.version <> old.version + 1
     or current_setting('hopin.payroll_adjustment_review_id', true) is distinct from old.id::text
     or (to_jsonb(new) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note' - 'version')
          is distinct from
        (to_jsonb(old) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note' - 'version') then
    raise exception using errcode = '55000', message = 'INVALID_PAYROLL_ADJUSTMENT_REVIEW: Hanya satu review RPC untuk proposal PENDING yang diizinkan.';
  end if;
  return new;
end;
$$;

create or replace function public.rpc_adjust_payroll_entry(
  p_actor_id uuid,
  p_entry_id uuid,
  p_expected_entry_version integer,
  p_adjustment_type text,
  p_amount numeric,
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
  v_subject_role public.app_role;
  v_run public.payroll_runs%rowtype;
  v_entry public.payroll_entries%rowtype;
  v_adjustment public.payroll_adjustments%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_type text := upper(nullif(btrim(p_adjustment_type), ''));
  v_reason text := nullif(btrim(p_reason), '');
begin
  if p_entry_id is null or p_expected_entry_version is null or p_expected_entry_version <= 0
     or p_idempotency_key is null or v_type is null or v_type !~ '^[A-Z][A-Z0-9_]{0,63}$'
     or v_reason is null or length(v_reason) > 1000
     or p_amount is null or p_amount = 0 or trunc(p_amount) <> p_amount
     or abs(p_amount) > 99999999999999
     or p_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = '22023', message = 'INVALID_ADJUSTMENT: Entry, version, type, amount whole nonzero, reason, dan idempotency key wajib valid.';
  end if;

  select run.* into v_run
  from public.payroll_entries entry
  join public.payroll_runs run on run.id = entry.run_id
  where entry.id = p_entry_id
  for update of run;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Payroll entry tidak ditemukan.';
  end if;
  select * into v_entry from public.payroll_entries where id = p_entry_id for update;
  v_role := public.require_authorized_actor(p_actor_id, v_run.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Proposal adjustment payroll memerlukan manager.';
  end if;
  select role into v_subject_role from public.profiles where id = v_entry.profile_id;
  if p_actor_id = v_entry.profile_id
     or (v_role::text = 'SUPERVISOR' and v_subject_role::text <> 'OPERATOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Manager tidak dapat mengajukan adjustment untuk diri sendiri atau target manager.';
  end if;

  v_request := jsonb_build_object(
    'entry_id', p_entry_id, 'expected_entry_version', p_expected_entry_version,
    'adjustment_type', v_type, 'amount', p_amount, 'reason', v_reason
  );
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, v_run.outlet_id, 'ADJUST_PAYROLL_ENTRY', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = v_run.outlet_id
    and action = 'ADJUST_PAYROLL_ENTRY' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  if v_run.status <> 'DRAFT' or v_entry.status <> 'DRAFT' then
    raise exception using errcode = '55000', message = 'PAYROLL_NOT_DRAFT: Adjustment hanya dapat diajukan pada entry dan run DRAFT.';
  end if;
  if v_entry.version <> p_expected_entry_version then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected entry version %s, current version %s.', p_expected_entry_version, v_entry.version);
  end if;

  -- Amount is an explicit reviewed business decision. Quantity/rate are inert
  -- schema-required fields, never used here to infer wages, tax, or entitlement.
  insert into public.payroll_adjustments (
    entry_id, adjustment_type, quantity, rate, amount, source_entity_type,
    source_entity_id, reason, status, proposed_by, version
  ) values (
    p_entry_id, v_type, 1, 0, p_amount, 'MANUAL', null,
    v_reason, 'PENDING', p_actor_id, 1
  ) returning * into v_adjustment;

  update public.payroll_entries
  set version = version + 1
  where id = v_entry.id
  returning * into v_entry;

  v_response := jsonb_build_object(
    'adjustment_id', v_adjustment.id, 'entry_id', v_adjustment.entry_id,
    'status', v_adjustment.status, 'version', v_adjustment.version,
    'adjustment_type', v_adjustment.adjustment_type, 'amount', v_adjustment.amount,
    'entry_version', v_entry.version
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = clock_timestamp()
  where actor_user_id = p_actor_id and outlet_id = v_run.outlet_id
    and action = 'ADJUST_PAYROLL_ENTRY' and idempotency_key = p_idempotency_key;
  perform public.log_audit_event(
    p_actor_id, 'ADJUST_PAYROLL_ENTRY', 'payroll_adjustments', v_adjustment.id::text,
    v_run.outlet_id, v_entry.profile_id, null, v_response, v_reason
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

create or replace function public.rpc_review_payroll_adjustment(
  p_actor_id uuid,
  p_adjustment_id uuid,
  p_expected_adjustment_version integer,
  p_expected_entry_version integer,
  p_status text,
  p_note text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_subject_role public.app_role;
  v_run public.payroll_runs%rowtype;
  v_entry public.payroll_entries%rowtype;
  v_adjustment public.payroll_adjustments%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_before jsonb;
  v_status text := upper(nullif(btrim(p_status), ''));
  v_note text := nullif(btrim(p_note), '');
  v_now timestamptz := clock_timestamp();
begin
  if p_adjustment_id is null or p_expected_adjustment_version is null or p_expected_adjustment_version <= 0
     or p_expected_entry_version is null or p_expected_entry_version <= 0
     or p_idempotency_key is null or v_status not in ('APPROVED', 'REJECTED')
     or v_note is null or length(v_note) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_ADJUSTMENT_REVIEW: Adjustment/entry version, status, note, dan idempotency key wajib valid.';
  end if;

  select * into v_adjustment from public.payroll_adjustments where id = p_adjustment_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Payroll adjustment tidak ditemukan.';
  end if;
  select * into v_entry from public.payroll_entries where id = v_adjustment.entry_id for update;
  select * into v_run from public.payroll_runs where id = v_entry.run_id for update;
  v_role := public.require_authorized_actor(p_actor_id, v_run.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Review adjustment payroll memerlukan manager.';
  end if;
  select role into v_subject_role from public.profiles where id = v_entry.profile_id;
  if p_actor_id = v_adjustment.proposed_by or p_actor_id = v_entry.profile_id
     or (v_role::text = 'SUPERVISOR' and v_subject_role::text <> 'OPERATOR') then
    raise exception using errcode = '42501', message = 'SELF_REVIEW_FORBIDDEN: Reviewer harus berbeda dari pengaju/subjek dan berwenang atas target.';
  end if;

  v_request := jsonb_build_object(
    'adjustment_id', p_adjustment_id, 'expected_adjustment_version', p_expected_adjustment_version,
    'expected_entry_version', p_expected_entry_version,
    'status', v_status, 'note', v_note
  );
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, v_run.outlet_id, 'REVIEW_PAYROLL_ADJUSTMENT', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = v_run.outlet_id
    and action = 'REVIEW_PAYROLL_ADJUSTMENT' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  if v_run.status <> 'DRAFT' or v_adjustment.status <> 'PENDING' then
    raise exception using errcode = '55000', message = 'PAYROLL_ADJUSTMENT_NOT_PENDING: Hanya adjustment PENDING pada run DRAFT dapat direview.';
  end if;
  if v_adjustment.version <> p_expected_adjustment_version then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected adjustment version %s, current version %s.', p_expected_adjustment_version, v_adjustment.version);
  end if;
  if v_entry.version <> p_expected_entry_version then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected entry version %s, current version %s.', p_expected_entry_version, v_entry.version);
  end if;
  if v_status = 'APPROVED' and v_entry.proposed_gross + v_adjustment.amount < 0 then
    raise exception using errcode = '55000', message = 'NEGATIVE_PAYROLL_GROSS: Approval adjustment akan membuat proposed gross negatif.';
  end if;

  v_before := jsonb_build_object('status', v_adjustment.status, 'version', v_adjustment.version);
  perform set_config('hopin.payroll_adjustment_review_id', p_adjustment_id::text, true);
  update public.payroll_adjustments
  set status = v_status,
      reviewed_by = p_actor_id,
      reviewed_at = v_now,
      review_note = v_note,
      version = version + 1
  where id = p_adjustment_id
  returning * into v_adjustment;

  if v_status = 'APPROVED' then
    -- Apply only the separately reviewed explicit amount. No tax, rate, overtime,
    -- leave, or statutory calculation is inferred by this workflow.
    update public.payroll_entries
    set manual_adjustment_amount = manual_adjustment_amount + v_adjustment.amount,
        proposed_gross = proposed_gross + v_adjustment.amount,
        version = version + 1
    where id = v_entry.id
    returning * into v_entry;
  else
    update public.payroll_entries
    set version = version + 1
    where id = v_entry.id
    returning * into v_entry;
  end if;

  v_response := jsonb_build_object(
    'adjustment_id', v_adjustment.id, 'entry_id', v_adjustment.entry_id,
    'status', v_adjustment.status, 'version', v_adjustment.version,
    'reviewed_at', v_adjustment.reviewed_at,
    'entry_version', v_entry.version
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = v_now
  where actor_user_id = p_actor_id and outlet_id = v_run.outlet_id
    and action = 'REVIEW_PAYROLL_ADJUSTMENT' and idempotency_key = p_idempotency_key;
  perform public.log_audit_event(
    p_actor_id, 'REVIEW_PAYROLL_ADJUSTMENT', 'payroll_adjustments', v_adjustment.id::text,
    v_run.outlet_id, v_entry.profile_id, v_before, v_response, v_note
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Manager-only emergency checkout: append evidence, force later review
-- ---------------------------------------------------------------------------

create or replace function public.rpc_emergency_checkout(
  p_actor_id uuid,
  p_attendance_id uuid,
  p_expected_attendance_version integer,
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
  v_subject_role public.app_role;
  v_attendance public.attendance_records%rowtype;
  v_event public.attendance_events%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_before jsonb;
  v_reason text := nullif(btrim(p_reason), '');
  v_now timestamptz := clock_timestamp();
begin
  if p_attendance_id is null or p_expected_attendance_version is null or p_expected_attendance_version <= 0
     or p_idempotency_key is null or v_reason is null or length(v_reason) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_EMERGENCY_CHECKOUT: Attendance, version, reason, dan idempotency key wajib valid.';
  end if;

  select * into v_attendance from public.attendance_records where id = p_attendance_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Attendance tidak ditemukan.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, v_attendance.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Emergency checkout memerlukan manager.';
  end if;
  select role into v_subject_role from public.profiles where id = v_attendance.profile_id;
  if p_actor_id = v_attendance.profile_id
     or (v_role::text = 'SUPERVISOR' and v_subject_role::text <> 'OPERATOR') then
    raise exception using errcode = '42501', message = 'SELF_REVIEW_FORBIDDEN: Manager tidak dapat emergency checkout diri sendiri atau manager lain.';
  end if;

  v_request := jsonb_build_object(
    'attendance_id', p_attendance_id, 'expected_attendance_version', p_expected_attendance_version,
    'reason', v_reason
  );
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, v_attendance.outlet_id, 'EMERGENCY_CHECKOUT', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = v_attendance.outlet_id
    and action = 'EMERGENCY_CHECKOUT' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  if v_attendance.version <> p_expected_attendance_version then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected attendance version %s, current version %s.', p_expected_attendance_version, v_attendance.version);
  end if;
  if v_attendance.status not in ('CHECKED_IN', 'REVIEW_REQUIRED')
     or v_attendance.check_in_event_id is null
     or v_attendance.check_out_event_id is not null then
    raise exception using errcode = '55000', message = 'INVALID_ATTENDANCE_STATE: Emergency checkout memerlukan check-in terbuka.';
  end if;

  v_before := jsonb_build_object('status', v_attendance.status, 'version', v_attendance.version);
  insert into public.attendance_events (
    attendance_id, event_type, server_occurred_at, client_occurred_at,
    challenge_id, device_id, ip_country, location_status,
    selected_distance_m, selected_accuracy_m, risk_score, risk_reasons,
    note, idempotency_key, created_at
  ) values (
    v_attendance.id, 'CHECK_OUT', v_now, null,
    null, null, null, 'UNAVAILABLE',
    null, null, 100, jsonb_build_array('EMERGENCY_CHECKOUT'),
    v_reason, p_idempotency_key::text, v_now
  ) returning * into v_event;

  update public.attendance_records
  set status = 'REVIEW_REQUIRED',
      check_out_event_id = v_event.id,
      exception_status = 'PENDING_REVIEW',
      version = version + 1,
      updated_at = v_now
  where id = v_attendance.id
  returning * into v_attendance;

  v_response := jsonb_build_object(
    'attendance_id', v_attendance.id, 'event_id', v_event.id,
    'status', v_attendance.status, 'exception_status', v_attendance.exception_status,
    'version', v_attendance.version
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = v_now
  where actor_user_id = p_actor_id and outlet_id = v_attendance.outlet_id
    and action = 'EMERGENCY_CHECKOUT' and idempotency_key = p_idempotency_key;
  perform public.log_audit_event(
    p_actor_id, 'EMERGENCY_CHECKOUT', 'attendance_records', v_attendance.id::text,
    v_attendance.outlet_id, v_attendance.profile_id, v_before, v_response, v_reason
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Payroll export download authorization and public options throttling
-- ---------------------------------------------------------------------------

create or replace function public.rpc_get_payroll_export_download(
  p_actor_id uuid,
  p_export_id uuid,
  p_expected_run_version integer,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_export public.payroll_exports%rowtype;
  v_run public.payroll_runs%rowtype;
  v_authorization public.payroll_export_download_authorizations%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_export_id is null or p_expected_run_version is null or p_expected_run_version <= 0
     or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'INVALID_EXPORT_DOWNLOAD: Export, run version, dan idempotency key wajib valid.';
  end if;

  select * into v_export from public.payroll_exports where id = p_export_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Payroll export tidak ditemukan.';
  end if;
  select * into v_run from public.payroll_runs where id = v_export.run_id for update;
  v_role := public.require_authorized_actor(p_actor_id, v_run.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Download export payroll memerlukan manager.';
  end if;

  v_request := jsonb_build_object('export_id', p_export_id, 'expected_run_version', p_expected_run_version);
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, v_run.outlet_id, 'GET_PAYROLL_EXPORT_DOWNLOAD', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = v_run.outlet_id
    and action = 'GET_PAYROLL_EXPORT_DOWNLOAD' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  if v_run.version <> p_expected_run_version then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected payroll version %s, current version %s.', p_expected_run_version, v_run.version);
  end if;
  if v_run.status not in ('REVIEWED', 'FINALIZED', 'PAID') then
    raise exception using errcode = '55000', message = 'EXPORT_DOWNLOAD_FORBIDDEN: Export pada payroll ini tidak lagi dapat diunduh.';
  end if;

  insert into public.payroll_export_download_authorizations (
    export_id, requested_by, idempotency_key, authorized_at, expires_at
  ) values (
    p_export_id, p_actor_id, p_idempotency_key, v_now, v_now + interval '5 minutes'
  ) returning * into v_authorization;

  v_response := jsonb_build_object(
    'authorization_id', v_authorization.id,
    'export_id', v_export.id,
    'file_path', v_export.file_path,
    'format', v_export.format,
    'checksum_sha256', v_export.checksum_sha256,
    'expires_at', v_authorization.expires_at
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = v_now
  where actor_user_id = p_actor_id and outlet_id = v_run.outlet_id
    and action = 'GET_PAYROLL_EXPORT_DOWNLOAD' and idempotency_key = p_idempotency_key;
  perform public.log_audit_event(
    p_actor_id, 'AUTHORIZE_PAYROLL_EXPORT_DOWNLOAD', 'payroll_exports', v_export.id::text,
    v_run.outlet_id, p_actor_id, null,
    jsonb_build_object('authorization_id', v_authorization.id, 'expires_at', v_authorization.expires_at)
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

-- This protects the public login-options endpoint through its trusted API. The
-- input is an API-generated HMAC/SHA-256 scope, never a raw IP or device value.
create or replace function public.rpc_rate_limit_public_options(
  p_scope_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit public.auth_rate_limits%rowtype;
  v_now timestamptz := clock_timestamp();
  v_attempts integer;
  v_blocked_until timestamptz;
  v_allowed boolean;
  v_inserted boolean := false;
begin
  if p_scope_key is null or p_scope_key !~ '^public_options:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_PUBLIC_OPTIONS_SCOPE: Wajib HMAC/SHA-256 scope public_options.';
  end if;

  insert into public.auth_rate_limits (
    scope_key, window_started_at, attempts, blocked_until, updated_at
  ) values (
    p_scope_key, v_now, 1, null, v_now
  ) on conflict (scope_key) do nothing
  returning true into v_inserted;
  v_inserted := coalesce(v_inserted, false);

  select * into v_limit
  from public.auth_rate_limits
  where scope_key = p_scope_key
  for update;

  if v_limit.blocked_until is not null and v_limit.blocked_until > v_now then
    v_attempts := v_limit.attempts;
    v_blocked_until := v_limit.blocked_until;
    v_allowed := false;
  elsif v_limit.window_started_at <= v_now - interval '60 seconds' then
    v_attempts := 1;
    v_blocked_until := null;
    v_allowed := true;
  elsif v_inserted then
    -- A newly inserted row already represents this request.
    v_attempts := 1;
    v_blocked_until := null;
    v_allowed := true;
  else
    v_attempts := v_limit.attempts + 1;
    v_blocked_until := case
      when v_attempts > 30 then v_limit.window_started_at + interval '60 seconds'
      else null
    end;
    v_allowed := v_blocked_until is null;
  end if;

  update public.auth_rate_limits
  set window_started_at = case
        when v_limit.window_started_at <= v_now - interval '60 seconds' then v_now
        else v_limit.window_started_at
      end,
      attempts = v_attempts,
      blocked_until = v_blocked_until,
      updated_at = v_now
  where scope_key = p_scope_key;

  -- Do not audit every unauthenticated request: that becomes an audit-amplification
  -- vector. A denied request is retained as a token/IP-free security audit event.
  if not v_allowed then
    perform public.log_audit_event(
      null, 'PUBLIC_OPTIONS_RATE_LIMITED', 'auth_rate_limits', 'public_options',
      null, null, null,
      jsonb_build_object('blocked_until', v_blocked_until)
    );
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'retry_after_seconds', case
      when v_blocked_until is null then null
      else greatest(1, ceil(extract(epoch from (v_blocked_until - v_now)))::integer)
    end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Privileges and residual constraints
-- ---------------------------------------------------------------------------

revoke execute on function public.enforce_payroll_adjustment_state() from public, anon, authenticated;
revoke execute on function public.rpc_list_sessions(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_revoke_sessions(uuid, uuid, uuid[], integer[], uuid) from public, anon, authenticated;
revoke execute on function public.rpc_save_opening_draft(uuid, uuid, integer, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.rpc_save_closing_draft(uuid, uuid, integer, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.rpc_get_report(uuid, uuid, date) from public, anon, authenticated;
revoke execute on function public.rpc_save_report_finance(uuid, uuid, date, integer, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.rpc_share_report(uuid, uuid, integer, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_adjust_payroll_entry(uuid, uuid, integer, text, numeric, text, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_review_payroll_adjustment(uuid, uuid, integer, integer, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_emergency_checkout(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
revoke execute on function public.rpc_get_payroll_export_download(uuid, uuid, integer, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_rate_limit_public_options(text) from public, anon, authenticated;

grant execute on function public.enforce_payroll_adjustment_state() to service_role;
grant execute on function public.rpc_list_sessions(uuid, uuid) to service_role;
grant execute on function public.rpc_revoke_sessions(uuid, uuid, uuid[], integer[], uuid) to service_role;
grant execute on function public.rpc_save_opening_draft(uuid, uuid, integer, uuid, jsonb) to service_role;
grant execute on function public.rpc_save_closing_draft(uuid, uuid, integer, uuid, jsonb) to service_role;
grant execute on function public.rpc_get_report(uuid, uuid, date) to service_role;
grant execute on function public.rpc_save_report_finance(uuid, uuid, date, integer, uuid, jsonb) to service_role;
grant execute on function public.rpc_share_report(uuid, uuid, integer, uuid, text, uuid) to service_role;
grant execute on function public.rpc_adjust_payroll_entry(uuid, uuid, integer, text, numeric, text, uuid) to service_role;
grant execute on function public.rpc_review_payroll_adjustment(uuid, uuid, integer, integer, text, text, uuid) to service_role;
grant execute on function public.rpc_emergency_checkout(uuid, uuid, integer, uuid, text) to service_role;
grant execute on function public.rpc_get_payroll_export_download(uuid, uuid, integer, uuid) to service_role;
grant execute on function public.rpc_rate_limit_public_options(text) to service_role;

comment on table public.workflow_idempotency is
  'Completed workflow responses. Retain long enough for API retry windows; add an audited retention job before deleting rows.';
comment on table public.daily_report_shares is
  'Authorization metadata only; an active scoped INVESTOR receives read access after sharing. Revocation workflow remains intentionally unmodeled.';
comment on table public.payroll_export_download_authorizations is
  'Metadata only. API must create the signed URL after authorization and enforce the returned five-minute expiry.';
comment on function public.rpc_adjust_payroll_entry(uuid, uuid, integer, text, numeric, text, uuid) is
  'Creates a pending explicit manual adjustment only; it does not calculate legal payroll, tax, entitlement, or deductions.';

-- Residuals: stock/finance drafts are not auto-consumed by confirmation/submission;
-- the API must explicitly pass their validated payload to existing immutable RPCs.
-- Payment evidence has no file schema, so no payment-download metadata is added.
-- Public options callers must HMAC the remote identifier server-side before calling
-- rpc_rate_limit_public_options; do not expose that RPC directly to browsers.
