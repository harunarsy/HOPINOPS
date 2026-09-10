-- HOPIN Catalog v0.2
-- Server-owned item identifiers, controlled units, append-only master history,
-- and reversible catalog archival. Existing item IDs remain untouched because
-- stock, report, and audit rows reference them.

alter table public.items
  add column if not exists display_code text;

alter table public.items
  add column if not exists archived_section_id uuid;

-- New items are server-owned records. Legacy text IDs remain unchanged, while
-- future direct inserts receive an opaque database-generated ID.
alter table public.items
  alter column id set default (gen_random_uuid()::text);

create table if not exists public.item_code_sequences (
  area_code public.area_code primary key,
  next_value integer not null check (next_value > 0)
);

insert into public.item_code_sequences (area_code, next_value)
values ('BAR', 1), ('KITCHEN', 1)
on conflict (area_code) do nothing;

do $$
declare
  v_item record;
  v_next integer;
  v_prefix text;
begin
  -- Backfill stable, human-readable codes without changing legacy primary keys.
  for v_item in
    select id, area_code
    from public.items
    where display_code is null
    order by area_code, id
  loop
    select next_value into v_next
    from public.item_code_sequences
    where area_code = v_item.area_code
    for update;

    v_prefix := case when v_item.area_code = 'BAR' then 'BAR' else 'KIT' end;
    update public.items
    set display_code = v_prefix || '-' || lpad(v_next::text, 3, '0')
    where id = v_item.id;

    update public.item_code_sequences
    set next_value = v_next + 1
    where area_code = v_item.area_code;
  end loop;
end;
$$;

update public.item_code_sequences sequence_row
set next_value = greatest(
  sequence_row.next_value,
  coalesce((
    select max((substring(item.display_code from '[0-9]+$'))::integer) + 1
    from public.items item
    where item.area_code = sequence_row.area_code
      and item.display_code ~ '[0-9]+$'
  ),
  1
));

alter table public.items
  alter column display_code set not null;

create unique index if not exists items_display_code_key
  on public.items (display_code);

create table if not exists public.unit_options (
  code text primary key check (code = lower(btrim(code)) and code ~ '^[a-z][a-z0-9._-]{0,31}$'),
  label text not null check (char_length(btrim(label)) between 1 and 40),
  decimal_scale smallint not null default 2 check (decimal_scale between 0 and 4),
  active boolean not null default true,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.unit_options (code, label, decimal_scale, sort_order)
values
  ('gram', 'gram', 2, 10),
  ('ml', 'ml', 2, 20),
  ('pcs', 'pcs', 0, 30),
  ('pack', 'pack', 0, 40),
  ('roll', 'roll', 0, 50),
  ('liter', 'liter', 2, 60)
on conflict (code) do nothing;

insert into public.unit_options (code, label, decimal_scale, sort_order)
select distinct lower(btrim(unit_code)), lower(btrim(unit_code)), 2, 90
from public.items
where unit_code is not null
  and btrim(unit_code) <> ''
on conflict (code) do nothing;

create table if not exists public.item_master_revisions (
  id uuid primary key default gen_random_uuid(),
  item_id text not null,
  display_code text not null,
  area_code public.area_code not null,
  action text not null check (action in ('CREATE', 'UPDATE', 'ARCHIVE', 'RESTORE')),
  before_json jsonb,
  after_json jsonb,
  reason text,
  changed_by uuid references public.profiles(id),
  effective_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists item_master_revisions_item_idx
  on public.item_master_revisions (item_id, effective_at desc);

create table if not exists public.unit_option_revisions (
  id uuid primary key default gen_random_uuid(),
  unit_code text not null,
  action text not null check (action in ('CREATE', 'UPDATE', 'ARCHIVE', 'RESTORE')),
  before_json jsonb,
  after_json jsonb,
  reason text,
  changed_by uuid references public.profiles(id),
  effective_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists unit_option_revisions_code_idx
  on public.unit_option_revisions (unit_code, effective_at desc);

create or replace function public.next_item_display_code(p_area public.area_code)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next integer;
  v_prefix text;
begin
  if p_area is null then
    raise exception using errcode = '22023', message = 'AREA_REQUIRED: Area item wajib diisi.';
  end if;

  insert into public.item_code_sequences(area_code, next_value)
  values (p_area, 1)
  on conflict (area_code) do nothing;

  select next_value into v_next
  from public.item_code_sequences
  where area_code = p_area
  for update;

  update public.item_code_sequences
  set next_value = v_next + 1
  where area_code = p_area;

  v_prefix := case when p_area = 'BAR' then 'BAR' else 'KIT' end;
  return v_prefix || '-' || lpad(v_next::text, 3, '0');
end;
$$;

create or replace function public.ensure_item_display_code()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.area_code is distinct from old.area_code then
      raise exception using errcode = '22023', message = 'AREA_IMMUTABLE: Area item tidak dapat dipindahkan setelah dibuat.';
    end if;
    -- Display codes are permanent, even when an item is edited or restored.
    new.display_code := old.display_code;
  else
    new.display_code := public.next_item_display_code(new.area_code);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_items_display_code on public.items;
create trigger trg_items_display_code
before insert or update of area_code, display_code on public.items
for each row execute function public.ensure_item_display_code();

create or replace function public.enforce_item_unit_option()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.unit_options
    where code = lower(btrim(new.unit_code)) and active is true
  ) then
    raise exception using errcode = '23514', message = 'UNIT_INACTIVE: Satuan tidak tersedia atau sudah diarsipkan.';
  end if;
  new.unit_code := lower(btrim(new.unit_code));
  return new;
end;
$$;

drop trigger if exists trg_items_unit_option on public.items;
create trigger trg_items_unit_option
before insert or update of unit_code on public.items
for each row execute function public.enforce_item_unit_option();

create or replace function public.capture_item_master_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_changed_by uuid;
  v_reason text;
begin
  if tg_op = 'INSERT' then
    v_action := 'CREATE';
  elsif old.active is true and new.active is false then
    v_action := 'ARCHIVE';
  elsif old.active is false and new.active is true then
    v_action := 'RESTORE';
  elsif old.name is distinct from new.name
     or old.unit_code is distinct from new.unit_code
     or old.decimal_scale is distinct from new.decimal_scale
     or old.low_threshold is distinct from new.low_threshold
     or old.display_code is distinct from new.display_code then
    v_action := 'UPDATE';
  else
    return new;
  end if;

  v_changed_by := nullif(current_setting('hopin.catalog_actor_id', true), '')::uuid;
  v_reason := nullif(current_setting('hopin.catalog_change_reason', true), '');

  insert into public.item_master_revisions (
    item_id, display_code, area_code, action, before_json, after_json, reason, changed_by
  ) values (
    new.id,
    new.display_code,
    new.area_code,
    v_action,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    to_jsonb(new),
    v_reason,
    v_changed_by
  );
  return new;
end;
$$;

drop trigger if exists trg_items_master_revision on public.items;
create trigger trg_items_master_revision
after insert or update on public.items
for each row execute function public.capture_item_master_revision();

-- Seed a baseline entry so the history view is complete for legacy items too.
insert into public.item_master_revisions (
  item_id, display_code, area_code, action, before_json, after_json, reason, effective_at, created_at
)
select
  item.id,
  item.display_code,
  item.area_code,
  'CREATE',
  null,
  to_jsonb(item),
  'INITIAL_CATALOG_IMPORT',
  coalesce(item.created_at, clock_timestamp()),
  coalesce(item.created_at, clock_timestamp())
from public.items item
where not exists (
  select 1 from public.item_master_revisions revision
  where revision.item_id = item.id and revision.action = 'CREATE'
);

create or replace function public.capture_unit_option_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_changed_by uuid;
  v_reason text;
begin
  if tg_op = 'INSERT' then
    v_action := 'CREATE';
  elsif old.active is true and new.active is false then
    v_action := 'ARCHIVE';
  elsif old.active is false and new.active is true then
    v_action := 'RESTORE';
  elsif old.label is distinct from new.label
     or old.decimal_scale is distinct from new.decimal_scale
     or old.sort_order is distinct from new.sort_order then
    v_action := 'UPDATE';
  else
    return new;
  end if;

  v_changed_by := nullif(current_setting('hopin.catalog_actor_id', true), '')::uuid;
  v_reason := nullif(current_setting('hopin.catalog_change_reason', true), '');

  insert into public.unit_option_revisions (unit_code, action, before_json, after_json, reason, changed_by)
  values (
    new.code,
    v_action,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    to_jsonb(new),
    v_reason,
    v_changed_by
  );
  return new;
end;
$$;

drop trigger if exists trg_unit_options_revision on public.unit_options;
create trigger trg_unit_options_revision
after insert or update on public.unit_options
for each row execute function public.capture_unit_option_revision();

insert into public.unit_option_revisions (
  unit_code, action, before_json, after_json, reason, effective_at, created_at
)
select
  unit.code,
  'CREATE',
  null,
  to_jsonb(unit),
  'INITIAL_CATALOG_IMPORT',
  coalesce(unit.created_at, clock_timestamp()),
  coalesce(unit.created_at, clock_timestamp())
from public.unit_options unit
where not exists (
  select 1 from public.unit_option_revisions revision
  where revision.unit_code = unit.code and revision.action = 'CREATE'
);

create or replace function public.pending_catalog_create_item_auto(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_area_code public.area_code,
  p_name text,
  p_unit_code text,
  p_low_threshold numeric,
  p_section_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_catalog jsonb;
  v_item_id text := gen_random_uuid()::text;
  v_name text := nullif(btrim(p_name), '');
  v_unit_code text := nullif(lower(btrim(p_unit_code)), '');
  v_scale smallint;
  v_position integer := 0;
  v_result jsonb;
begin
  select decimal_scale into v_scale
  from public.unit_options
  where code = v_unit_code and active is true;
  if p_area_code is null or v_name is null or length(v_name) > 150
     or v_scale is null or p_low_threshold is null or p_low_threshold < 0
     or p_low_threshold::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = '22023', message = 'INVALID_ITEM: Area, nama, satuan, dan batas stok wajib valid.';
  end if;

  v_catalog := public.pending_catalog_effective(p_outlet_id, p_area_code);
  if p_section_id is not null then
    if not exists (
      select 1 from jsonb_array_elements(v_catalog->'sections') section
      where section->>'id' = p_section_id::text
        and (section->>'active')::boolean is true
    ) then
      raise exception using errcode = 'P0002', message = 'SECTION_NOT_FOUND: Kelompok checklist tidak ditemukan.';
    end if;
    select coalesce(max((placement->>'position')::integer) + 1, 0)
      into v_position
    from jsonb_array_elements(v_catalog->'placements') placement
    where placement->>'section_id' = p_section_id::text;
  end if;

  v_catalog := jsonb_set(
    v_catalog,
    '{items}',
    (v_catalog->'items') || jsonb_build_array(jsonb_build_object(
      'item_id', v_item_id,
      'area_code', p_area_code,
      'name', v_name,
      'unit_code', v_unit_code,
      'decimal_scale', v_scale,
      'low_threshold', p_low_threshold,
      'active', true
    ))
  );
  v_catalog := jsonb_set(
    v_catalog,
    '{placements}',
    (v_catalog->'placements') || jsonb_build_array(jsonb_build_object(
      'item_id', v_item_id,
      'section_id', p_section_id,
      'position', case when p_section_id is null then null else v_position end
    ))
  );

  perform set_config('hopin.catalog_actor_id', p_actor_id::text, true);
  perform set_config('hopin.catalog_change_reason', 'CREATE_ITEM', true);
  v_result := public.pending_catalog_apply_internal(
    p_actor_id, p_outlet_id, p_area_code,
    (v_catalog->>'version')::integer,
    v_catalog->'items', v_catalog->'sections', v_catalog->'placements',
    'CREATE_ITEM', 'CREATE_ITEM', gen_random_uuid(), null
  );
  return jsonb_build_object(
    'id', v_item_id,
    'area_code', p_area_code,
    'name', v_name,
    'unit_code', v_unit_code,
    'decimal_scale', v_scale,
    'low_threshold', p_low_threshold,
    'active', true
  ) || v_result;
end;
$$;

create or replace function public.rpc_create_item_auto(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_area_code public.area_code,
  p_name text,
  p_unit_code text,
  p_low_threshold numeric,
  p_section_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat membuat item.';
  end if;
  return public.pending_catalog_create_item_auto(
    p_actor_id, p_outlet_id, p_area_code, p_name, p_unit_code, p_low_threshold, p_section_id
  );
end;
$$;

create or replace function public.rpc_operator_create_item_auto(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_area_code public.area_code,
  p_name text,
  p_unit_code text,
  p_low_threshold numeric,
  p_section_id uuid default null
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
    select 1
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY'
      and assignment.status = 'ACTIVE'
      and cycle.outlet_id = p_outlet_id
      and cycle.area_code = p_area_code
      and cycle.work_date = v_today
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN_SCOPE: PRIMARY area aktif diperlukan.';
  end if;
  return public.pending_catalog_create_item_auto(
    p_actor_id, p_outlet_id, p_area_code, p_name, p_unit_code, p_low_threshold, p_section_id
  );
end;
$$;

create or replace function public.rpc_update_item_auto(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_item_id text,
  p_name text,
  p_unit_code text,
  p_low_threshold numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_scale smallint;
begin
  select decimal_scale into v_scale from public.unit_options where code = lower(btrim(p_unit_code)) and active is true;
  if v_scale is null then
    raise exception using errcode = '23514', message = 'UNIT_INACTIVE: Satuan tidak tersedia atau sudah diarsipkan.';
  end if;
  perform set_config('hopin.catalog_actor_id', p_actor_id::text, true);
  perform set_config('hopin.catalog_change_reason', 'UPDATE_ITEM', true);
  return public.rpc_update_item(p_actor_id, p_outlet_id, p_item_id, p_name, p_unit_code, v_scale, p_low_threshold);
end;
$$;

create or replace function public.rpc_operator_update_item_auto(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_item_id text,
  p_name text,
  p_unit_code text,
  p_low_threshold numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_scale smallint;
begin
  select decimal_scale into v_scale from public.unit_options where code = lower(btrim(p_unit_code)) and active is true;
  if v_scale is null then
    raise exception using errcode = '23514', message = 'UNIT_INACTIVE: Satuan tidak tersedia atau sudah diarsipkan.';
  end if;
  perform set_config('hopin.catalog_actor_id', p_actor_id::text, true);
  perform set_config('hopin.catalog_change_reason', 'UPDATE_ITEM', true);
  return public.rpc_operator_update_item(p_actor_id, p_outlet_id, p_item_id, p_name, p_unit_code, v_scale, p_low_threshold);
end;
$$;

create or replace function public.pending_catalog_restore_item(
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
  v_area public.area_code;
  v_catalog jsonb;
  v_item jsonb;
  v_result jsonb;
  v_restore_section uuid;
  v_section_id uuid;
  v_position integer := 0;
begin
  if nullif(btrim(p_item_id), '') is null or nullif(btrim(p_reason), '') is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: ID item dan alasan pemulihan wajib valid.';
  end if;
  v_area := public.pending_catalog_item_area(p_outlet_id, p_item_id);
  if v_area is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Item tidak ditemukan.';
  end if;
  v_catalog := public.pending_catalog_effective(p_outlet_id, v_area);
  select value into v_item from jsonb_array_elements(v_catalog->'items') where value->>'item_id' = btrim(p_item_id);
  if v_item is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Item tidak ditemukan.';
  end if;
  if (v_item->>'active')::boolean then
    return v_item || jsonb_build_object('idempotent_replay', true);
  end if;
  if not exists (
    select 1
    from public.unit_options
    where code = v_item->>'unit_code' and active is true
  ) then
    raise exception using errcode = '23514', message = 'UNIT_INACTIVE: Pulihkan satuan item terlebih dahulu.';
  end if;

  select archived_section_id into v_restore_section
  from public.items
  where id = btrim(p_item_id);
  if v_restore_section is not null and exists (
    select 1 from jsonb_array_elements(v_catalog->'sections') section
    where section->>'id' = v_restore_section::text and (section->>'active')::boolean is true
  ) then
    v_section_id := v_restore_section;
    select coalesce(max((placement->>'position')::integer) + 1, 0)
      into v_position
    from jsonb_array_elements(v_catalog->'placements') placement
    where placement->>'section_id' = v_section_id::text;
  end if;

  v_catalog := jsonb_set(
    v_catalog,
    '{items}',
    (select jsonb_agg(case when value->>'item_id' = btrim(p_item_id)
      then jsonb_set(value, '{active}', 'true'::jsonb) else value end order by value->>'item_id')
     from jsonb_array_elements(v_catalog->'items'))
  );
  v_catalog := jsonb_set(
    v_catalog,
    '{placements}',
    (v_catalog->'placements') || jsonb_build_array(jsonb_build_object(
      'item_id', btrim(p_item_id),
      'section_id', v_section_id,
      'position', case when v_section_id is null then null else v_position end
    ))
  );
  perform set_config('hopin.catalog_actor_id', p_actor_id::text, true);
  perform set_config('hopin.catalog_change_reason', btrim(p_reason), true);
  v_result := public.pending_catalog_apply_internal(
    p_actor_id, p_outlet_id, v_area,
    (v_catalog->>'version')::integer,
    v_catalog->'items', v_catalog->'sections', v_catalog->'placements',
    'RESTORE_ITEM', btrim(p_reason), gen_random_uuid(), null
  );
  return jsonb_build_object(
    'id', v_item->>'item_id', 'area_code', v_area, 'name', v_item->>'name',
    'unit_code', v_item->>'unit_code', 'decimal_scale', (v_item->>'decimal_scale')::smallint,
    'low_threshold', (v_item->>'low_threshold')::numeric, 'active', true
  ) || v_result;
end;
$$;

create or replace function public.rpc_restore_item(
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
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat memulihkan item.';
  end if;
  return public.pending_catalog_restore_item(p_actor_id, p_outlet_id, p_item_id, p_reason);
end;
$$;

create or replace function public.rpc_archive_item_auto(
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
  v_area public.area_code;
  v_section_id uuid;
  v_result jsonb;
begin
  v_area := public.pending_catalog_item_area(p_outlet_id, p_item_id);
  if v_area is not null then
    select nullif(placement->>'section_id', '')::uuid into v_section_id
    from jsonb_array_elements(public.pending_catalog_effective(p_outlet_id, v_area)->'placements') placement
    where placement->>'item_id' = btrim(p_item_id)
    limit 1;
  end if;
  perform set_config('hopin.catalog_actor_id', p_actor_id::text, true);
  perform set_config('hopin.catalog_change_reason', btrim(p_reason), true);
  v_result := public.rpc_archive_item(p_actor_id, p_outlet_id, p_item_id, p_reason);
  update public.items set archived_section_id = v_section_id where id = btrim(p_item_id);
  return v_result;
end;
$$;

create or replace function public.rpc_operator_archive_item_auto(
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
  v_area public.area_code;
  v_section_id uuid;
  v_result jsonb;
begin
  v_area := public.pending_catalog_item_area(p_outlet_id, p_item_id);
  if v_area is not null then
    select nullif(placement->>'section_id', '')::uuid into v_section_id
    from jsonb_array_elements(public.pending_catalog_effective(p_outlet_id, v_area)->'placements') placement
    where placement->>'item_id' = btrim(p_item_id)
    limit 1;
  end if;
  perform set_config('hopin.catalog_actor_id', p_actor_id::text, true);
  perform set_config('hopin.catalog_change_reason', btrim(p_reason), true);
  v_result := public.rpc_operator_archive_item(p_actor_id, p_outlet_id, p_item_id, p_reason);
  update public.items set archived_section_id = v_section_id where id = btrim(p_item_id);
  return v_result;
end;
$$;

create or replace function public.rpc_create_unit_option(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_code text,
  p_label text,
  p_decimal_scale smallint,
  p_sort_order integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_code text := lower(btrim(p_code));
  v_unit public.unit_options%rowtype;
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat mengelola satuan.';
  end if;
  if v_code !~ '^[a-z][a-z0-9._-]{0,31}$' or nullif(btrim(p_label), '') is null
     or p_decimal_scale not between 0 and 4 or p_sort_order < 0 then
    raise exception using errcode = '22023', message = 'INVALID_UNIT: Kode, nama, skala, dan urutan satuan wajib valid.';
  end if;
  perform set_config('hopin.catalog_actor_id', p_actor_id::text, true);
  perform set_config('hopin.catalog_change_reason', 'CREATE_UNIT', true);
  insert into public.unit_options(code, label, decimal_scale, sort_order)
  values (v_code, btrim(p_label), p_decimal_scale, p_sort_order)
  returning * into v_unit;
  return to_jsonb(v_unit);
end;
$$;

create or replace function public.rpc_archive_unit_option(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_code text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_unit public.unit_options%rowtype;
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat mengelola satuan.';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Alasan arsip satuan wajib diisi.';
  end if;
  perform set_config('hopin.catalog_actor_id', p_actor_id::text, true);
  perform set_config('hopin.catalog_change_reason', btrim(p_reason), true);
  select * into v_unit from public.unit_options where code = lower(btrim(p_code)) for update;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: Satuan tidak ditemukan.'; end if;
  if exists (select 1 from public.items where active is true and unit_code = v_unit.code)
     or exists (
       select 1
       from public.pending_catalogs pending
       cross join lateral jsonb_array_elements(pending.items_json) item
       where (item->>'active')::boolean is true
         and item->>'unit_code' = v_unit.code
     ) then
    raise exception using errcode = 'UNIT_IN_USE: Satuan masih dipakai item aktif.';
  end if;
  update public.unit_options set active = false, updated_at = clock_timestamp() where code = v_unit.code returning * into v_unit;
  return to_jsonb(v_unit);
end;
$$;

create or replace function public.rpc_restore_unit_option(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_unit public.unit_options%rowtype;
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat mengelola satuan.';
  end if;
  perform set_config('hopin.catalog_actor_id', p_actor_id::text, true);
  perform set_config('hopin.catalog_change_reason', 'RESTORE_UNIT', true);
  update public.unit_options set active = true, updated_at = clock_timestamp()
  where code = lower(btrim(p_code)) returning * into v_unit;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: Satuan tidak ditemukan.'; end if;
  return to_jsonb(v_unit);
end;
$$;

alter table public.unit_options enable row level security;
alter table public.item_code_sequences enable row level security;
alter table public.item_master_revisions enable row level security;
alter table public.unit_option_revisions enable row level security;

revoke all on public.unit_options, public.item_code_sequences, public.item_master_revisions, public.unit_option_revisions from public, anon, authenticated;
grant all on public.unit_options, public.item_code_sequences, public.item_master_revisions, public.unit_option_revisions to service_role;

revoke execute on function public.next_item_display_code(public.area_code) from public, anon, authenticated;
revoke execute on function public.pending_catalog_create_item_auto(uuid, uuid, public.area_code, text, text, numeric, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_create_item_auto(uuid, uuid, public.area_code, text, text, numeric, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_operator_create_item_auto(uuid, uuid, public.area_code, text, text, numeric, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_update_item_auto(uuid, uuid, text, text, text, numeric) from public, anon, authenticated;
revoke execute on function public.rpc_operator_update_item_auto(uuid, uuid, text, text, text, numeric) from public, anon, authenticated;
revoke execute on function public.rpc_archive_item_auto(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_operator_archive_item_auto(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.pending_catalog_restore_item(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_restore_item(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_create_unit_option(uuid, uuid, text, text, smallint, integer) from public, anon, authenticated;
revoke execute on function public.rpc_archive_unit_option(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_restore_unit_option(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.rpc_create_item_auto(uuid, uuid, public.area_code, text, text, numeric, uuid) to service_role;
grant execute on function public.rpc_operator_create_item_auto(uuid, uuid, public.area_code, text, text, numeric, uuid) to service_role;
grant execute on function public.rpc_update_item_auto(uuid, uuid, text, text, text, numeric) to service_role;
grant execute on function public.rpc_operator_update_item_auto(uuid, uuid, text, text, text, numeric) to service_role;
grant execute on function public.rpc_archive_item_auto(uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_operator_archive_item_auto(uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_restore_item(uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_create_unit_option(uuid, uuid, text, text, smallint, integer) to service_role;
grant execute on function public.rpc_archive_unit_option(uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_restore_unit_option(uuid, uuid, text) to service_role;
