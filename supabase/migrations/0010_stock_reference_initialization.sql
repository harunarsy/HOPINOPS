-- HOPIN Production Migration 0010: Stock Reference Initialization & Variance Policy
--
-- Authorized product decisions (see REMEDIATION_IMPLEMENTATION_PLAN_PART_2.md):
--   * First-run opening (no prior closing and no same-day SIANG handover) requires
--     a manager-approved zero-reference initialization event.
--   * Variance (physical != reference) requires a reason category; notes are optional.
--
-- This migration is additive. It does not edit migrations 0001-0009.

-- ---------------------------------------------------------------------------
-- 1. Initialization aggregate (immutable, manager-approved zero reference)
-- ---------------------------------------------------------------------------

create table if not exists public.stock_reference_initializations (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  cycle_id uuid not null unique references public.work_cycles(id) on delete restrict,
  area_code public.area_code not null,
  work_date date not null,
  reason text not null,
  initialized_by uuid not null references public.profiles(id),
  approved_by uuid not null references public.profiles(id),
  approved_at timestamptz not null default clock_timestamp(),
  idempotency_key uuid not null unique,
  status text not null default 'APPROVED' check (status = 'APPROVED'),
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.stock_reference_initialization_lines (
  initialization_id uuid not null references public.stock_reference_initializations(id) on delete cascade,
  item_id text not null references public.items(id) on delete restrict,
  baseline_qty numeric(14, 4) not null default 0 check (baseline_qty = 0),
  primary key (initialization_id, item_id)
);

alter table public.stock_reference_initializations enable row level security;
alter table public.stock_reference_initialization_lines enable row level security;

revoke all on public.stock_reference_initializations, public.stock_reference_initialization_lines from anon, authenticated;
grant all on public.stock_reference_initializations, public.stock_reference_initialization_lines to service_role;

create index if not exists stock_ref_init_outlet_area_date_idx
  on public.stock_reference_initializations (outlet_id, area_code, work_date);

-- ---------------------------------------------------------------------------
-- 2. Manager-approved zero-reference initialization
-- ---------------------------------------------------------------------------

create or replace function public.rpc_initialize_stock_reference(
  p_cycle_id uuid,
  p_actor_id uuid,
  p_expected_cycle_version integer,
  p_idempotency_key uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle public.work_cycles%rowtype;
  v_role public.app_role;
  v_reason text := nullif(btrim(p_reason), '');
  v_init_id uuid;
  v_existing_id uuid;
  v_opening_id uuid;
begin
  if p_cycle_id is null or p_actor_id is null
     or p_expected_cycle_version is null or p_expected_cycle_version <= 0
     or p_idempotency_key is null or v_reason is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Cycle, actor, version, idempotency key, dan reason wajib diisi.';
  end if;

  select * into v_cycle from public.work_cycles where id = p_cycle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, v_cycle.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat membuat referensi stok awal.';
  end if;

  if v_cycle.status <> 'ACTIVE' then
    raise exception using errcode = '55000', message = 'INVALID_CYCLE_STATE: Inisialisasi hanya untuk cycle ACTIVE.';
  end if;

  if v_cycle.version <> p_expected_cycle_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected cycle version %s, current version %s.', p_expected_cycle_version, v_cycle.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_cycle_version, v_cycle.version);
  end if;

  select id into v_existing_id from public.stock_reference_initializations where idempotency_key = p_idempotency_key;
  if v_existing_id is not null then
    return jsonb_build_object(
      'initialization_id', v_existing_id,
      'status', 'APPROVED',
      'duplicate', true
    );
  end if;

  select id into v_opening_id from public.stock_openings where cycle_id = p_cycle_id;
  if v_opening_id is not null then
    raise exception using errcode = '55000', message = 'OPENING_EXISTS: Opening sudah dikonfirmasi; inisialisasi tidak diperlukan.';
  end if;

  if exists (select 1 from public.stock_reference_initializations where cycle_id = p_cycle_id) then
    raise exception using errcode = '55000', message = 'INITIALIZATION_EXISTS: Referensi stok awal sudah dibuat.';
  end if;

  insert into public.stock_reference_initializations (
    outlet_id, cycle_id, area_code, work_date, reason,
    initialized_by, approved_by, idempotency_key, status
  ) values (
    v_cycle.outlet_id, p_cycle_id, v_cycle.area_code, v_cycle.work_date, v_reason,
    p_actor_id, p_actor_id, p_idempotency_key, 'APPROVED'
  ) returning id into v_init_id;

  insert into public.stock_reference_initialization_lines (initialization_id, item_id, baseline_qty)
  select v_init_id, item.id, 0
  from public.items item
  where item.active is true and item.area_code = v_cycle.area_code;

  perform public.log_audit_event(
    p_actor_id, 'INITIALIZE_STOCK_REFERENCE', 'stock_reference_initializations', v_init_id::text,
    v_cycle.outlet_id, null, null,
    jsonb_build_object('cycle_id', p_cycle_id, 'area_code', v_cycle.area_code, 'work_date', v_cycle.work_date)
  );

  return jsonb_build_object(
    'initialization_id', v_init_id,
    'status', 'APPROVED',
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Server-owned opening reference resolution
-- ---------------------------------------------------------------------------

create or replace function public.rpc_get_opening_reference(
  p_cycle_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle public.work_cycles%rowtype;
  v_role public.app_role;
  v_source_type text;
  v_source_id uuid;
  v_warning_code text;
  v_lines jsonb := '[]'::jsonb;
begin
  if p_cycle_id is null or p_actor_id is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Cycle dan actor wajib diisi.';
  end if;

  select * into v_cycle from public.work_cycles where id = p_cycle_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, v_cycle.outlet_id);

  if v_cycle.shift_code = 'MALAM' then
    select handover.id into v_source_id
    from public.stock_handovers handover
    join public.work_cycles source_cycle on source_cycle.id = handover.cycle_id
    where source_cycle.outlet_id = v_cycle.outlet_id
      and source_cycle.work_date = v_cycle.work_date
      and source_cycle.shift_code = 'SIANG'
      and source_cycle.area_code = v_cycle.area_code
      and handover.status = 'CONFIRMED';
    if v_source_id is not null then
      v_source_type := 'HANDOVER';
    else
      select closing.id into v_source_id
      from public.stock_closings closing
      join public.work_cycles source_cycle on source_cycle.id = closing.cycle_id
      where source_cycle.outlet_id = v_cycle.outlet_id
        and source_cycle.work_date < v_cycle.work_date
        and source_cycle.area_code = v_cycle.area_code
        and closing.status = 'CONFIRMED'
      order by source_cycle.work_date desc, closing.confirmed_at desc, closing.id desc
      limit 1;
      if v_source_id is not null then
        v_source_type := 'CLOSING';
        v_warning_code := 'HANDOVER_MISSING_USING_PRIOR_CLOSING';
      end if;
    end if;
  else
    select closing.id into v_source_id
    from public.stock_closings closing
    join public.work_cycles source_cycle on source_cycle.id = closing.cycle_id
    where source_cycle.outlet_id = v_cycle.outlet_id
      and source_cycle.work_date < v_cycle.work_date
      and source_cycle.area_code = v_cycle.area_code
      and closing.status = 'CONFIRMED'
    order by source_cycle.work_date desc, closing.confirmed_at desc, closing.id desc
    limit 1;
    if v_source_id is not null then
      v_source_type := 'CLOSING';
    end if;
  end if;

  if v_source_id is null then
    select id into v_source_id
    from public.stock_reference_initializations
    where cycle_id = p_cycle_id and status = 'APPROVED';
    if v_source_id is not null then
      v_source_type := 'INITIALIZATION';
    end if;
  end if;

  if v_source_type = 'HANDOVER' then
    select coalesce(jsonb_agg(jsonb_build_object('item_id', item_id, 'reference_qty', system_qty) order by item_id), '[]'::jsonb)
      into v_lines
    from public.stock_handover_lines
    where handover_id = v_source_id;
  elsif v_source_type = 'CLOSING' then
    select coalesce(jsonb_agg(jsonb_build_object('item_id', item_id, 'reference_qty', counted_qty) order by item_id), '[]'::jsonb)
      into v_lines
    from public.stock_closing_lines
    where closing_id = v_source_id;
  elsif v_source_type = 'INITIALIZATION' then
    select coalesce(jsonb_agg(jsonb_build_object('item_id', item_id, 'reference_qty', baseline_qty) order by item_id), '[]'::jsonb)
      into v_lines
    from public.stock_reference_initialization_lines
    where initialization_id = v_source_id;
  end if;

  return jsonb_build_object(
    'state', case when v_source_type is null then 'INITIALIZATION_REQUIRED' else 'AVAILABLE' end,
    'source_type', v_source_type,
    'source_id', v_source_id,
    'warning_code', v_warning_code,
    'lines', v_lines
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Opening confirmation (variance: category required, notes optional)
-- ---------------------------------------------------------------------------

create or replace function public.rpc_confirm_opening(
  p_cycle_id uuid,
  p_actor_id uuid,
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
  v_opening_id uuid;
  v_existing_id uuid;
  v_source_type text;
  v_source_id uuid;
  v_warning_code text;
  v_expected_count integer;
  v_line jsonb;
  v_item_id text;
  v_counted_qty numeric;
  v_reference_qty numeric;
  v_variance_qty numeric;
  v_reason text;
  v_notes text;
begin
  if p_cycle_id is null or p_actor_id is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Cycle dan actor wajib diisi.';
  end if;

  select * into v_cycle from public.work_cycles where id = p_cycle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, v_cycle.outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan mengonfirmasi opening.';
  end if;

  if v_cycle.status <> 'ACTIVE' then
    raise exception using errcode = '55000', message = 'INVALID_CYCLE_STATE: Opening hanya dapat dikonfirmasi pada cycle ACTIVE.';
  end if;

  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1 from public.work_assignments
    where cycle_id = p_cycle_id
      and profile_id = p_actor_id
      and duty_role = 'PRIMARY'
      and status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Opening memerlukan primary cycle atau manager dengan scope outlet.';
  end if;

  select id into v_existing_id from public.stock_openings where cycle_id = p_cycle_id for update;
  if v_existing_id is not null then
    raise exception using errcode = '55000', message = 'OPENING_EXISTS: Opening tidak dapat ditimpa.';
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'INVALID_LINES: p_lines wajib berupa array JSON.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_lines) line
    where jsonb_typeof(line) <> 'object'
       or not (line ? 'item_id')
       or not (line ? 'counted_qty')
       or jsonb_typeof(line->'item_id') <> 'string'
       or jsonb_typeof(line->'counted_qty') <> 'number'
       or (line ? 'reason_code' and jsonb_typeof(line->'reason_code') not in ('string', 'null'))
       or (line ? 'notes' and jsonb_typeof(line->'notes') not in ('string', 'null'))
       or (line->>'counted_qty')::numeric < 0
       or (line->>'counted_qty')::numeric::text in ('NaN', 'Infinity', '-Infinity')
  ) then
    raise exception using errcode = '22023', message = 'INVALID_LINES: Item dan counted_qty finite nonnegative wajib eksplisit.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) line
    cross join lateral jsonb_object_keys(line) as object_key(key_name)
    where key_name not in ('item_id', 'counted_qty', 'reason_code', 'notes')
  ) then
    raise exception using errcode = '22023', message = 'INVALID_LINES: p_lines memuat field yang tidak diizinkan.';
  end if;

  select count(*) into v_expected_count
  from public.items
  where active is true and area_code = v_cycle.area_code;

  if v_expected_count = 0
     or jsonb_array_length(p_lines) <> v_expected_count
     or (select count(distinct line->>'item_id') from jsonb_array_elements(p_lines) line) <> v_expected_count
     or exists (
       select 1 from jsonb_array_elements(p_lines) line
       left join public.items item on item.id = line->>'item_id'
       where item.id is null or item.active is not true or item.area_code <> v_cycle.area_code
     ) then
    raise exception using errcode = '22023', message = 'INCOMPLETE_ITEMS: Wajib tepat satu baris untuk setiap item aktif di area cycle.';
  end if;

  -- Resolve reference source (handover -> prior closing fallback -> initialization)
  if v_cycle.shift_code = 'MALAM' then
    select handover.id into v_source_id
    from public.stock_handovers handover
    join public.work_cycles source_cycle on source_cycle.id = handover.cycle_id
    where source_cycle.outlet_id = v_cycle.outlet_id
      and source_cycle.work_date = v_cycle.work_date
      and source_cycle.shift_code = 'SIANG'
      and source_cycle.area_code = v_cycle.area_code
      and handover.status = 'CONFIRMED'
    for share of handover;
    if v_source_id is not null then
      v_source_type := 'HANDOVER';
    else
      select closing.id into v_source_id
      from public.stock_closings closing
      join public.work_cycles source_cycle on source_cycle.id = closing.cycle_id
      where source_cycle.outlet_id = v_cycle.outlet_id
        and source_cycle.work_date < v_cycle.work_date
        and source_cycle.area_code = v_cycle.area_code
        and closing.status = 'CONFIRMED'
      order by source_cycle.work_date desc, closing.confirmed_at desc, closing.id desc
      limit 1
      for share of closing;
      if v_source_id is not null then
        v_source_type := 'CLOSING';
        v_warning_code := 'HANDOVER_MISSING_USING_PRIOR_CLOSING';
      end if;
    end if;
  else
    select closing.id into v_source_id
    from public.stock_closings closing
    join public.work_cycles source_cycle on source_cycle.id = closing.cycle_id
    where source_cycle.outlet_id = v_cycle.outlet_id
      and source_cycle.work_date < v_cycle.work_date
      and source_cycle.area_code = v_cycle.area_code
      and closing.status = 'CONFIRMED'
    order by source_cycle.work_date desc, closing.confirmed_at desc, closing.id desc
    limit 1
    for share of closing;
    if v_source_id is not null then
      v_source_type := 'CLOSING';
    end if;
  end if;

  if v_source_id is null then
    select id into v_source_id
    from public.stock_reference_initializations
    where cycle_id = p_cycle_id and status = 'APPROVED'
    for share;
    if v_source_id is not null then
      v_source_type := 'INITIALIZATION';
    end if;
  end if;

  if v_source_id is null then
    raise exception using errcode = '55000', message = 'REFERENCE_NOT_FOUND: Snapshot referensi opening tidak ditemukan. Dibutuhkan inisialisasi referensi oleh Owner/Supervisor.';
  end if;

  insert into public.stock_openings (
    cycle_id, status, reference_source_type, reference_source_id
  ) values (
    p_cycle_id, 'DRAFT', v_source_type, v_source_id
  ) returning id into v_opening_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_item_id := v_line->>'item_id';
    v_counted_qty := (v_line->>'counted_qty')::numeric;
    v_reason := nullif(btrim(v_line->>'reason_code'), '');
    v_notes := nullif(btrim(v_line->>'notes'), '');

    if v_source_type = 'HANDOVER' then
      select system_qty into v_reference_qty
      from public.stock_handover_lines
      where handover_id = v_source_id and item_id = v_item_id;
    elsif v_source_type = 'CLOSING' then
      select counted_qty into v_reference_qty
      from public.stock_closing_lines
      where closing_id = v_source_id and item_id = v_item_id;
    else
      select baseline_qty into v_reference_qty
      from public.stock_reference_initialization_lines
      where initialization_id = v_source_id and item_id = v_item_id;
    end if;

    if v_reference_qty is null or v_reference_qty < 0 then
      raise exception using errcode = '55000', message = format('INVALID_REFERENCE: Referensi item %s hilang atau negatif.', v_item_id);
    end if;

    v_variance_qty := v_counted_qty - v_reference_qty;
    if v_variance_qty <> 0 and v_reason is null then
      raise exception using errcode = '22023', message = format('VARIANCE_CATEGORY_REQUIRED: Item %s memiliki selisih dan wajib memilih kategori alasan.', v_item_id);
    end if;

    insert into public.stock_opening_lines (
      opening_id, item_id, reference_qty, counted_qty, variance_qty,
      reason_code, notes, updated_by
    ) values (
      v_opening_id, v_item_id, v_reference_qty, v_counted_qty, v_variance_qty,
      v_reason, v_notes, p_actor_id
    );
  end loop;

  update public.stock_openings
  set status = 'CONFIRMED', confirmed_at = clock_timestamp(), confirmed_by = p_actor_id,
      version = version + 1, updated_at = clock_timestamp()
  where id = v_opening_id;

  update public.work_cycles
  set status = 'OPEN', version = version + 1, updated_at = clock_timestamp()
  where id = p_cycle_id;

  perform public.log_audit_event(
    p_actor_id, 'CONFIRM_OPENING', 'stock_openings', v_opening_id::text,
    v_cycle.outlet_id, null, null,
    jsonb_build_object(
      'cycle_id', p_cycle_id,
      'reference_source_type', v_source_type,
      'reference_source_id', v_source_id,
      'lines_count', v_expected_count
    )
  );

  return jsonb_build_object(
    'opening_id', v_opening_id,
    'status', 'CONFIRMED',
    'reference_source_type', v_source_type,
    'reference_source_id', v_source_id,
    'warning_code', v_warning_code
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Closing confirmation (variance: category required, notes optional)
-- ---------------------------------------------------------------------------

create or replace function public.rpc_confirm_closing(
  p_cycle_id uuid,
  p_actor_id uuid,
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
  v_opening_id uuid;
  v_closing_id uuid;
  v_cutoff_at timestamptz;
  v_expected_count integer;
  v_line jsonb;
  v_item_id text;
  v_opening_qty numeric;
  v_incoming_qty numeric;
  v_outgoing_qty numeric;
  v_system_qty numeric;
  v_counted_qty numeric;
  v_variance_qty numeric;
  v_reason text;
  v_notes text;
begin
  select * into v_cycle from public.work_cycles where id = p_cycle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, v_cycle.outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan mengonfirmasi closing.';
  end if;

  if v_cycle.shift_code not in ('MALAM', 'FULL')
     or v_cycle.status <> 'OPEN'
     or v_cycle.movement_cutoff_at is not null then
    raise exception using errcode = '55000', message = 'INVALID_CYCLE_STATE: Closing hanya untuk cycle MALAM/FULL yang masih OPEN.';
  end if;

  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1 from public.work_assignments
    where cycle_id = p_cycle_id
      and profile_id = p_actor_id
      and duty_role = 'PRIMARY'
      and status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Closing memerlukan primary cycle atau manager dengan scope outlet.';
  end if;

  if exists (select 1 from public.stock_closings where cycle_id = p_cycle_id) then
    raise exception using errcode = '55000', message = 'CLOSING_EXISTS: Closing tidak dapat ditimpa.';
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'INVALID_LINES: p_lines wajib berupa array JSON.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_lines) line
    where jsonb_typeof(line) <> 'object'
       or not (line ? 'item_id')
       or not (line ? 'counted_qty')
       or jsonb_typeof(line->'item_id') <> 'string'
       or jsonb_typeof(line->'counted_qty') <> 'number'
       or (line ? 'reason_code' and jsonb_typeof(line->'reason_code') not in ('string', 'null'))
       or (line ? 'notes' and jsonb_typeof(line->'notes') not in ('string', 'null'))
       or (line->>'counted_qty')::numeric < 0
       or (line->>'counted_qty')::numeric::text in ('NaN', 'Infinity', '-Infinity')
  ) then
    raise exception using errcode = '22023', message = 'INVALID_LINES: Item dan counted_qty finite nonnegative wajib eksplisit.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) line
    cross join lateral jsonb_object_keys(line) as object_key(key_name)
    where key_name not in ('item_id', 'counted_qty', 'reason_code', 'notes')
  ) then
    raise exception using errcode = '22023', message = 'INVALID_LINES: p_lines memuat field yang tidak diizinkan.';
  end if;

  select count(*) into v_expected_count
  from public.items where active is true and area_code = v_cycle.area_code;

  if v_expected_count = 0
     or jsonb_array_length(p_lines) <> v_expected_count
     or (select count(distinct line->>'item_id') from jsonb_array_elements(p_lines) line) <> v_expected_count
     or exists (
       select 1 from jsonb_array_elements(p_lines) line
       left join public.items item on item.id = line->>'item_id'
       where item.id is null or item.active is not true or item.area_code <> v_cycle.area_code
     ) then
    raise exception using errcode = '22023', message = 'INCOMPLETE_ITEMS: Wajib tepat satu baris untuk setiap item aktif di area cycle.';
  end if;

  select id into v_opening_id
  from public.stock_openings
  where cycle_id = p_cycle_id and status = 'CONFIRMED'
  for share;
  if v_opening_id is null
     or (select count(*) from public.stock_opening_lines where opening_id = v_opening_id) <> v_expected_count then
    raise exception using errcode = '55000', message = 'INCOMPLETE_OPENING: Opening terkonfirmasi dan lengkap wajib ada.';
  end if;

  v_cutoff_at := clock_timestamp();

  insert into public.stock_closings (
    cycle_id, status, movement_cutoff_at, confirmed_at, confirmed_by
  ) values (
    p_cycle_id, 'DRAFT', v_cutoff_at, v_cutoff_at, p_actor_id
  ) returning id into v_closing_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_item_id := v_line->>'item_id';
    v_counted_qty := (v_line->>'counted_qty')::numeric;
    v_reason := nullif(btrim(v_line->>'reason_code'), '');
    v_notes := nullif(btrim(v_line->>'notes'), '');

    select counted_qty into v_opening_qty
    from public.stock_opening_lines
    where opening_id = v_opening_id and item_id = v_item_id;
    if v_opening_qty is null then
      raise exception using errcode = '55000', message = format('INCOMPLETE_OPENING: Item %s tidak memiliki opening eksplisit.', v_item_id);
    end if;

    select
      coalesce(sum(quantity) filter (where direction = 'IN'), 0),
      coalesce(sum(quantity) filter (where direction = 'OUT'), 0)
      into v_incoming_qty, v_outgoing_qty
    from public.stock_movements
    where cycle_id = p_cycle_id
      and item_id = v_item_id
      and server_occurred_at <= v_cutoff_at;

    v_system_qty := v_opening_qty + v_incoming_qty - v_outgoing_qty;
    v_variance_qty := v_counted_qty - v_system_qty;
    if v_variance_qty <> 0 and v_reason is null then
      raise exception using errcode = '22023', message = format('VARIANCE_CATEGORY_REQUIRED: Item %s memiliki selisih dan wajib memilih kategori alasan.', v_item_id);
    end if;

    insert into public.stock_closing_lines (
      closing_id, item_id, opening_qty, incoming_qty, outgoing_qty,
      system_qty, counted_qty, variance_qty, reason_code, notes
    ) values (
      v_closing_id, v_item_id, v_opening_qty, v_incoming_qty, v_outgoing_qty,
      v_system_qty, v_counted_qty, v_variance_qty, v_reason, v_notes
    );
  end loop;

  update public.stock_closings set status = 'CONFIRMED', version = version + 1 where id = v_closing_id;

  update public.work_cycles
  set status = 'CLOSING_READY', movement_cutoff_at = v_cutoff_at,
      version = version + 1, updated_at = clock_timestamp()
  where id = p_cycle_id;

  perform public.log_audit_event(
    p_actor_id, 'CONFIRM_CLOSING', 'stock_closings', v_closing_id::text,
    v_cycle.outlet_id, null, null,
    jsonb_build_object('cycle_id', p_cycle_id, 'movement_cutoff_at', v_cutoff_at, 'lines_count', v_expected_count)
  );

  return jsonb_build_object(
    'closing_id', v_closing_id,
    'status', 'CONFIRMED',
    'movement_cutoff_at', v_cutoff_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------

revoke execute on function public.rpc_initialize_stock_reference(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
revoke execute on function public.rpc_get_opening_reference(uuid, uuid) from public, anon, authenticated;
grant execute on function public.rpc_initialize_stock_reference(uuid, uuid, integer, uuid, text) to service_role;
grant execute on function public.rpc_get_opening_reference(uuid, uuid) to service_role;
