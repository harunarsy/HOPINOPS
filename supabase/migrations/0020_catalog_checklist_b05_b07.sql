-- 0020_catalog_checklist_b05_b07.sql
-- E1: B01/B06/B07 — katalog Supervisor + PRIMARY scoped, checklist lokasi server-owned,
-- first-count baseline PRIMARY, tanpa auto-nol fiktif dan tanpa rewrite histori.

-- 1. B01: Supervisor boleh mengelola katalog (sebelumnya Owner-only).
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
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat membuat item.';
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
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat mengubah item.';
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
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat mengarsipkan item.';
  end if;
  lock table public.outlets in share mode;
  lock table public.work_cycles in share mode;
  if v_reason is null or length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Alasan arsip wajib diisi.';
  end if;

  select * into v_item from public.items where id = btrim(p_item_id) for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Item tidak ditemukan.';
  end if;
  if not v_item.active then
    return to_jsonb(v_item) || jsonb_build_object('idempotent_replay', true);
  end if;
  v_before := to_jsonb(v_item);

  update public.items set active = false, updated_at = clock_timestamp()
  where id = v_item.id returning * into v_item;

  perform public.log_audit_event(
    p_actor_id, 'ARCHIVE_ITEM', 'items', v_item.id, p_outlet_id,
    null, v_before, to_jsonb(v_item) || jsonb_build_object('archive_reason', v_reason)
  );
  return to_jsonb(v_item) || jsonb_build_object('idempotent_replay', false);
end;
$$;

-- 2. B06: PRIMARY boleh inisialisasi baseline pertama (first physical count).
-- Menggantikan guard manager-only; Supervisor/Owner tetap boleh.
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
  v_is_primary boolean := false;
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

  select exists (
    select 1 from public.work_assignments
    where cycle_id = p_cycle_id
      and profile_id = p_actor_id
      and duty_role = 'PRIMARY'
      and status = 'ACTIVE'
  ) into v_is_primary;

  if v_role::text not in ('OWNER', 'SUPERVISOR') and not (v_role::text = 'OPERATOR' and v_is_primary) then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner, Supervisor, atau PRIMARY cycle yang dapat membuat referensi stok awal.';
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
    jsonb_build_object('cycle_id', p_cycle_id, 'area_code', v_cycle.area_code, 'work_date', v_cycle.work_date, 'initiated_by_role', v_role::text)
  );

  return jsonb_build_object(
    'initialization_id', v_init_id,
    'status', 'APPROVED',
    'duplicate', false
  );
end;
$$;

-- 3. B07: PRIMARY scoped — tambah/arsip item dalam area tugasnya.
create or replace function public.rpc_operator_create_item(
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
  v_today date;
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Jalur ini hanya untuk OPERATOR PRIMARY.';
  end if;
  v_today := (now() at time zone 'Asia/Jakarta')::date;
  if not exists (
    select 1 from public.work_assignments a
    join public.work_cycles c on c.id = a.cycle_id
    where a.profile_id = p_actor_id
      and a.duty_role = 'PRIMARY'
      and a.status = 'ACTIVE'
      and c.outlet_id = p_outlet_id
      and c.area_code = p_area_code
      and c.work_date = v_today
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN_SCOPE: PRIMARY hanya boleh menambah item pada area tugas aktifnya.';
  end if;
  if exists (
    select 1 from public.work_cycles
    where outlet_id = p_outlet_id and area_code = p_area_code and status in ('ACTIVE', 'OPEN')
      and id not in (
        select a.cycle_id from public.work_assignments a
        where a.profile_id = p_actor_id and a.duty_role = 'PRIMARY' and a.status = 'ACTIVE'
      )
  ) then
    raise exception using errcode = '55000', message = 'ITEM_SET_LOCKED: Area memiliki cycle aktif di luar tugas Anda.';
  end if;
  -- Validasi + insert memakai logika yang sama dengan rpc_create_item (role sudah terbukti PRIMARY scoped).
  if btrim(p_item_id) is null or btrim(p_item_id) !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
     or p_area_code is null or nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 150
     or nullif(btrim(p_unit_code), '') is null or length(btrim(p_unit_code)) > 32
     or p_decimal_scale is null or p_decimal_scale not between 0 and 4
     or p_low_threshold is null or p_low_threshold < 0
     or p_low_threshold::text in ('NaN', 'Infinity', '-Infinity')
     or p_low_threshold > 9999999999.9999 then
    raise exception using errcode = '22023', message = 'INVALID_ITEM: ID, area, nama, unit, scale, atau threshold tidak valid.';
  end if;
  perform 1 from public.items where id = btrim(p_item_id) for update;
  if found then
    raise exception using errcode = '23505', message = 'ITEM_EXISTS: ID item sudah digunakan.';
  end if;
  insert into public.items (id, area_code, name, unit_code, decimal_scale, low_threshold, active)
  values (btrim(p_item_id), p_area_code, btrim(p_name), btrim(p_unit_code), p_decimal_scale, p_low_threshold, true);
  perform public.log_audit_event(
    p_actor_id, 'CREATE_ITEM', 'items', btrim(p_item_id), p_outlet_id,
    null, null, jsonb_build_object('id', btrim(p_item_id), 'area_code', p_area_code, 'by', 'OPERATOR_PRIMARY')
  );
  return (select to_jsonb(i) from public.items i where i.id = btrim(p_item_id));
end;
$$;

create or replace function public.rpc_operator_archive_item(
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
  v_today date;
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Jalur ini hanya untuk OPERATOR PRIMARY.';
  end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Alasan arsip wajib diisi.';
  end if;
  select * into v_item from public.items where id = btrim(p_item_id) for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Item tidak ditemukan.';
  end if;
  v_today := (now() at time zone 'Asia/Jakarta')::date;
  if not exists (
    select 1 from public.work_assignments a
    join public.work_cycles c on c.id = a.cycle_id
    where a.profile_id = p_actor_id
      and a.duty_role = 'PRIMARY'
      and a.status = 'ACTIVE'
      and c.outlet_id = p_outlet_id
      and c.area_code = v_item.area_code
      and c.work_date = v_today
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN_SCOPE: PRIMARY hanya boleh mengarsip item pada area tugas aktifnya.';
  end if;
  if not v_item.active then
    return to_jsonb(v_item) || jsonb_build_object('idempotent_replay', true);
  end if;
  v_before := to_jsonb(v_item);
  update public.items set active = false, updated_at = clock_timestamp()
  where id = v_item.id returning * into v_item;
  perform public.log_audit_event(
    p_actor_id, 'ARCHIVE_ITEM', 'items', v_item.id, p_outlet_id,
    null, v_before, to_jsonb(v_item) || jsonb_build_object('archive_reason', v_reason, 'by', 'OPERATOR_PRIMARY')
  );
  return to_jsonb(v_item) || jsonb_build_object('idempotent_replay', false);
end;
$$;

-- 4. Checklist lokasi server-owned: bagian + penempatan + versi layout per outlet+area.
create table if not exists public.checklist_sections (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets (id),
  area_code public.area_code not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  position integer not null check (position >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, area_code, name)
);

create table if not exists public.checklist_layouts (
  outlet_id uuid not null references public.outlets (id),
  area_code public.area_code not null,
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (outlet_id, area_code)
);

create table if not exists public.item_placements (
  item_id text primary key references public.items (id),
  outlet_id uuid not null references public.outlets (id),
  area_code public.area_code not null,
  section_id uuid not null references public.checklist_sections (id),
  position integer not null check (position >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.checklist_layout_ops (
  idempotency_key uuid primary key,
  outlet_id uuid not null,
  area_code public.area_code not null,
  actor_id uuid not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.checklist_sections enable row level security;
alter table public.checklist_layouts enable row level security;
alter table public.item_placements enable row level security;
alter table public.checklist_layout_ops enable row level security;
revoke all on public.checklist_sections, public.checklist_layouts, public.item_placements, public.checklist_layout_ops from anon, authenticated;
grant all on public.checklist_sections, public.checklist_layouts, public.item_placements, public.checklist_layout_ops to service_role;

create or replace function public.rpc_checklist_layout_get(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_area_code public.area_code
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_version integer;
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text = 'INVESTOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Investor tidak memiliki jalur operasional.';
  end if;
  if p_area_code is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Area wajib diisi.';
  end if;
  select version into v_version from public.checklist_layouts
  where outlet_id = p_outlet_id and area_code = p_area_code;
  if not found then
    v_version := 1;
  end if;
  return jsonb_build_object(
    'version', v_version,
    'sections', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'position', s.position, 'active', s.active) order by s.position, s.name)
      from public.checklist_sections s
      where s.outlet_id = p_outlet_id and s.area_code = p_area_code and s.active is true
    ), '[]'::jsonb),
    'placements', coalesce((
      select jsonb_agg(jsonb_build_object('item_id', p.item_id, 'section_id', p.section_id, 'position', p.position) order by p.position, p.item_id)
      from public.item_placements p
      where p.outlet_id = p_outlet_id and p.area_code = p_area_code
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.rpc_checklist_section_upsert(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_area_code public.area_code,
  p_section_id uuid,
  p_name text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_name text := nullif(btrim(p_name), '');
  v_section public.checklist_sections%rowtype;
  v_existing jsonb;
  v_layout_version integer;
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text = 'INVESTOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Investor tidak memiliki jalur operasional.';
  end if;
  if p_area_code is null or v_name is null or length(v_name) > 80 or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Area, nama bagian, dan idempotency key wajib valid.';
  end if;
  if v_role::text = 'OPERATOR' then
    if not exists (
      select 1 from public.work_assignments a
      join public.work_cycles c on c.id = a.cycle_id
      where a.profile_id = p_actor_id and a.duty_role = 'PRIMARY' and a.status = 'ACTIVE'
        and c.outlet_id = p_outlet_id and c.area_code = p_area_code
        and c.work_date = (now() at time zone 'Asia/Jakarta')::date
    ) then
      raise exception using errcode = '42501', message = 'FORBIDDEN_SCOPE: PRIMARY hanya boleh menata bagian pada area tugas aktifnya.';
    end if;
  elsif v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner, Supervisor, atau PRIMARY yang boleh menata bagian.';
  end if;

  select result into v_existing from public.checklist_layout_ops where idempotency_key = p_idempotency_key;
  if found then
    return v_existing || jsonb_build_object('idempotent_replay', true);
  end if;

  if p_section_id is null then
    insert into public.checklist_sections (outlet_id, area_code, name, position)
    values (p_outlet_id, p_area_code, v_name, coalesce((select max(position) + 1 from public.checklist_sections where outlet_id = p_outlet_id and area_code = p_area_code), 0))
    returning * into v_section;
  else
    update public.checklist_sections set name = v_name, updated_at = clock_timestamp()
    where id = p_section_id and outlet_id = p_outlet_id and area_code = p_area_code
    returning * into v_section;
    if not found then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND: Bagian tidak ditemukan.';
    end if;
  end if;

  insert into public.checklist_layouts (outlet_id, area_code, version)
  values (p_outlet_id, p_area_code, 1)
  on conflict (outlet_id, area_code) do update set version = public.checklist_layouts.version + 1, updated_at = clock_timestamp()
  returning version into v_layout_version;

  perform public.log_audit_event(
    p_actor_id, 'UPSERT_CHECKLIST_SECTION', 'checklist_sections', v_section.id::text, p_outlet_id,
    null, null, to_jsonb(v_section)
  );
  v_existing := jsonb_build_object('section', to_jsonb(v_section), 'idempotent_replay', false);
  insert into public.checklist_layout_ops (idempotency_key, outlet_id, area_code, actor_id, result)
  values (p_idempotency_key, p_outlet_id, p_area_code, p_actor_id, v_existing);
  return v_existing;
end;
$$;

create or replace function public.rpc_checklist_item_move(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_area_code public.area_code,
  p_item_id text,
  p_section_id uuid,
  p_position integer,
  p_expected_layout_version integer,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_item public.items%rowtype;
  v_section public.checklist_sections%rowtype;
  v_layout public.checklist_layouts%rowtype;
  v_existing jsonb;
  v_now timestamptz := clock_timestamp();
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text = 'INVESTOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Investor tidak memiliki jalur operasional.';
  end if;
  if p_area_code is null or nullif(btrim(p_item_id), '') is null or p_section_id is null
     or p_position is null or p_position < 0 or p_expected_layout_version is null
     or p_expected_layout_version <= 0 or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Payload pemindahan wajib valid.';
  end if;
  if v_role::text = 'OPERATOR' then
    if not exists (
      select 1 from public.work_assignments a
      join public.work_cycles c on c.id = a.cycle_id
      where a.profile_id = p_actor_id and a.duty_role = 'PRIMARY' and a.status = 'ACTIVE'
        and c.outlet_id = p_outlet_id and c.area_code = p_area_code
        and c.work_date = (now() at time zone 'Asia/Jakarta')::date
    ) then
      raise exception using errcode = '42501', message = 'FORBIDDEN_SCOPE: PRIMARY hanya boleh menata item pada area tugas aktifnya.';
    end if;
  elsif v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner, Supervisor, atau PRIMARY yang boleh menata item.';
  end if;

  select result into v_existing from public.checklist_layout_ops where idempotency_key = p_idempotency_key;
  if found then
    return v_existing || jsonb_build_object('idempotent_replay', true);
  end if;

  select * into v_item from public.items where id = btrim(p_item_id) for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Item tidak ditemukan.';
  end if;
  if v_item.area_code <> p_area_code then
    raise exception using errcode = '22023', message = 'INVALID_SCOPE: Item beda area tidak boleh dipindah ke area ini.';
  end if;
  select * into v_section from public.checklist_sections
  where id = p_section_id and outlet_id = p_outlet_id and area_code = p_area_code and active is true for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Bagian tidak ditemukan.';
  end if;

  select * into v_layout from public.checklist_layouts
  where outlet_id = p_outlet_id and area_code = p_area_code for update;
  if found and v_layout.version <> p_expected_layout_version then
    raise exception using errcode = '40001',
      message = format('VERSION_CONFLICT: Expected layout version %s, current version %s.', p_expected_layout_version, v_layout.version);
  end if;
  if not found then
    insert into public.checklist_layouts (outlet_id, area_code, version) values (p_outlet_id, p_area_code, 1)
    returning * into v_layout;
    if p_expected_layout_version <> 1 then
      raise exception using errcode = '40001',
        message = format('VERSION_CONFLICT: Expected layout version %s, current version 1.', p_expected_layout_version);
    end if;
  end if;

  insert into public.item_placements (item_id, outlet_id, area_code, section_id, position, updated_at)
  values (v_item.id, p_outlet_id, p_area_code, p_section_id, p_position, v_now)
  on conflict (item_id) do update set section_id = excluded.section_id, position = excluded.position, updated_at = v_now;

  update public.checklist_layouts set version = version + 1, updated_at = v_now
  where outlet_id = p_outlet_id and area_code = p_area_code
  returning * into v_layout;

  perform public.log_audit_event(
    p_actor_id, 'MOVE_CHECKLIST_ITEM', 'item_placements', v_item.id, p_outlet_id,
    null, null, jsonb_build_object('item_id', v_item.id, 'section_id', p_section_id, 'position', p_position, 'layout_version', v_layout.version)
  );
  v_existing := jsonb_build_object('item_id', v_item.id, 'section_id', p_section_id, 'position', p_position, 'layout_version', v_layout.version, 'idempotent_replay', false);
  insert into public.checklist_layout_ops (idempotency_key, outlet_id, area_code, actor_id, result)
  values (p_idempotency_key, p_outlet_id, p_area_code, p_actor_id, v_existing);
  return v_existing;
end;
$$;

revoke execute on function public.rpc_operator_create_item(uuid, uuid, text, public.area_code, text, text, smallint, numeric) from public, anon, authenticated;
revoke execute on function public.rpc_operator_archive_item(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_checklist_layout_get(uuid, uuid, public.area_code) from public, anon, authenticated;
revoke execute on function public.rpc_checklist_section_upsert(uuid, uuid, public.area_code, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_checklist_item_move(uuid, uuid, public.area_code, text, uuid, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.rpc_operator_create_item(uuid, uuid, text, public.area_code, text, text, smallint, numeric) to service_role;
grant execute on function public.rpc_operator_archive_item(uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_checklist_layout_get(uuid, uuid, public.area_code) to service_role;
grant execute on function public.rpc_checklist_section_upsert(uuid, uuid, public.area_code, uuid, text, uuid) to service_role;
grant execute on function public.rpc_checklist_item_move(uuid, uuid, public.area_code, text, uuid, integer, integer, uuid) to service_role;
