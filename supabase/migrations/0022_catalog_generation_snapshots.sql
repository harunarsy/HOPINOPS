-- 0022: one pending full catalog snapshot per outlet/area.
-- AVAILABLE is not started. Current tables remain unchanged until every
-- started cycle for the outlet/area reaches a terminal state.

create table if not exists public.pending_catalogs (
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  area_code public.area_code not null,
  version integer not null check (version > 0),
  items_json jsonb not null check (jsonb_typeof(items_json) = 'array'),
  sections_json jsonb not null check (jsonb_typeof(sections_json) = 'array'),
  placements_json jsonb not null check (jsonb_typeof(placements_json) = 'array'),
  fingerprint text not null,
  last_idempotency_key uuid not null,
  last_actor_id uuid not null references public.profiles(id),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (outlet_id, area_code)
);

create table if not exists public.pending_catalog_ops (
  idempotency_key uuid primary key,
  actor_id uuid not null references public.profiles(id),
  outlet_id uuid not null references public.outlets(id),
  area_code public.area_code not null,
  fingerprint text not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.pending_catalogs enable row level security;
alter table public.pending_catalog_ops enable row level security;
revoke all on public.pending_catalogs, public.pending_catalog_ops from public, anon, authenticated;
grant all on public.pending_catalogs, public.pending_catalog_ops to service_role;

create or replace function public.pending_catalog_started(
  p_outlet uuid,
  p_area public.area_code
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.work_cycles
    where outlet_id = p_outlet
      and area_code = p_area
      and status in ('ACTIVE', 'OPEN', 'HANDOVER_READY', 'CLOSING_READY')
  )
$$;

create or replace function public.pending_catalog_hash(
  p_actor uuid,
  p_outlet uuid,
  p_area public.area_code,
  p_action text,
  p_reason text,
  p_items jsonb,
  p_sections jsonb,
  p_placements jsonb,
  p_expected integer
)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select encode(
    extensions.digest(
      jsonb_build_object(
        'actor', p_actor,
        'outlet', p_outlet,
        'area', p_area,
        'action', p_action,
        'reason', p_reason,
        'items', p_items,
        'sections', p_sections,
        'placements', p_placements,
        'expected_version', p_expected
      )::text,
      'sha256'
    ),
    'hex'
  )
$$;

create or replace function public.pending_catalog_current(
  p_outlet uuid,
  p_area public.area_code
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'item_id', item.id,
          'area_code', item.area_code,
          'name', item.name,
          'unit_code', item.unit_code,
          'decimal_scale', item.decimal_scale,
          'low_threshold', item.low_threshold,
          'active', item.active
        ) order by item.id
      )
      from public.items item
      where item.area_code = p_area
    ), '[]'::jsonb),
    'sections', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', section.id,
          'name', section.name,
          'position', section.position,
          'active', section.active
        ) order by section.position, section.name, section.id
      )
      from public.checklist_sections section
      where section.outlet_id = p_outlet
        and section.area_code = p_area
    ), '[]'::jsonb),
    'placements', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'item_id', item.id,
          'section_id', placement.section_id,
          'position', placement.position
        ) order by placement.section_id nulls last, placement.position nulls last, item.id
      )
      from public.items item
      left join public.item_placements placement
        on placement.item_id = item.id
       and placement.outlet_id = p_outlet
       and placement.area_code = p_area
      where item.area_code = p_area
        and item.active is true
    ), '[]'::jsonb)
  )
$$;

create or replace function public.pending_catalog_effective(
  p_outlet uuid,
  p_area public.area_code
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pending public.pending_catalogs%rowtype;
  v_current jsonb;
  v_version integer;
begin
  select *
    into v_pending
  from public.pending_catalogs
  where outlet_id = p_outlet
    and area_code = p_area;

  if found then
    return jsonb_build_object(
      'items', v_pending.items_json,
      'sections', v_pending.sections_json,
      'placements', v_pending.placements_json,
      'version', v_pending.version,
      'pending', true
    );
  end if;

  v_current := public.pending_catalog_current(p_outlet, p_area);
  select layout.version
    into v_version
  from public.checklist_layouts layout
  where layout.outlet_id = p_outlet
    and layout.area_code = p_area;

  return v_current || jsonb_build_object(
    'version', coalesce(v_version, 1),
    'pending', false
  );
end;
$$;

create or replace function public.pending_catalog_item_area(
  p_outlet uuid,
  p_item_id text
)
returns public.area_code
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_area public.area_code;
begin
  select pending.area_code
    into v_area
  from public.pending_catalogs pending
  cross join lateral jsonb_array_elements(pending.items_json) item
  where pending.outlet_id = p_outlet
    and item->>'item_id' = btrim(p_item_id)
  order by pending.updated_at desc
  limit 1;

  if found then
    return v_area;
  end if;

  select item.area_code
    into v_area
  from public.items item
  where item.id = btrim(p_item_id);

  return v_area;
end;
$$;

create or replace function public.pending_catalog_validate(
  p_outlet uuid,
  p_area public.area_code,
  p_items jsonb,
  p_sections jsonb,
  p_placements jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active_count integer;
begin
  if p_outlet is null or p_area is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_typeof(p_sections) <> 'array'
     or jsonb_typeof(p_placements) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_CATALOG: Outlet, area, dan payload array wajib valid.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    where jsonb_typeof(item) <> 'object'
       or not (item ?& array['item_id', 'area_code', 'name', 'unit_code', 'decimal_scale', 'low_threshold', 'active'])
       or jsonb_typeof(item->'item_id') <> 'string'
       or jsonb_typeof(item->'area_code') <> 'string'
       or jsonb_typeof(item->'name') <> 'string'
       or jsonb_typeof(item->'unit_code') <> 'string'
       or jsonb_typeof(item->'decimal_scale') <> 'number'
       or jsonb_typeof(item->'low_threshold') <> 'number'
       or jsonb_typeof(item->'active') <> 'boolean'
       or item->>'area_code' <> p_area::text
       or item->>'item_id' !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
       or nullif(btrim(item->>'name'), '') is null
       or length(btrim(item->>'name')) > 150
       or nullif(btrim(item->>'unit_code'), '') is null
       or length(btrim(item->>'unit_code')) > 32
       or (item->>'decimal_scale')::numeric <> trunc((item->>'decimal_scale')::numeric)
       or (item->>'decimal_scale')::numeric not between 0 and 4
       or item->>'low_threshold' in ('NaN', 'Infinity', '-Infinity')
       or (item->>'low_threshold')::numeric < 0
       or (item->>'low_threshold')::numeric > 9999999999.9999
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CATALOG: Metadata item tidak valid.';
  end if;

  if jsonb_array_length(p_items) <> (
    select count(distinct item->>'item_id')
    from jsonb_array_elements(p_items) item
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CATALOG: ID item duplikat.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) payload_item
    join public.items current_item on current_item.id = payload_item->>'item_id'
    where current_item.area_code <> p_area
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SCOPE: ID item sudah dimiliki area lain.';
  end if;

  if exists (
    select 1
    from public.pending_catalogs pending
    cross join lateral jsonb_array_elements(pending.items_json) pending_item
    where (pending.outlet_id, pending.area_code) <> (p_outlet, p_area)
      and pending_item->>'item_id' in (
        select payload_item->>'item_id'
        from jsonb_array_elements(p_items) payload_item
      )
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SCOPE: ID item sudah dipakai snapshot pending lain.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_sections) section
    where jsonb_typeof(section) <> 'object'
       or not (section ?& array['id', 'name', 'position', 'active'])
       or jsonb_typeof(section->'id') <> 'string'
       or jsonb_typeof(section->'name') <> 'string'
       or jsonb_typeof(section->'position') <> 'number'
       or jsonb_typeof(section->'active') <> 'boolean'
       or section->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or nullif(btrim(section->>'name'), '') is null
       or length(btrim(section->>'name')) > 80
       or (section->>'position')::numeric <> trunc((section->>'position')::numeric)
       or (section->>'position')::numeric < 0
       or (section->>'position')::numeric > 2147483647
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CATALOG: Section tidak valid.';
  end if;

  if jsonb_array_length(p_sections) <> (
       select count(distinct section->>'id') from jsonb_array_elements(p_sections) section
     )
     or jsonb_array_length(p_sections) <> (
       select count(distinct lower(btrim(section->>'name'))) from jsonb_array_elements(p_sections) section
     )
     or jsonb_array_length(p_sections) <> (
       select count(distinct (section->>'position')::integer) from jsonb_array_elements(p_sections) section
     )
     or exists (
       select 1
       from jsonb_array_elements(p_sections) section
       where (section->>'position')::integer >= jsonb_array_length(p_sections)
     ) then
    raise exception using errcode = '22023', message = 'INVALID_CATALOG: Section harus unik dan contiguous.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_sections) payload_section
    join public.checklist_sections current_section
      on current_section.id = (payload_section->>'id')::uuid
    where current_section.outlet_id <> p_outlet
       or current_section.area_code <> p_area
  ) or exists (
    select 1
    from jsonb_array_elements(p_sections) payload_section
    join public.checklist_sections current_section
      on current_section.outlet_id = p_outlet
     and current_section.area_code = p_area
     and lower(btrim(current_section.name)) = lower(btrim(payload_section->>'name'))
    where current_section.id <> (payload_section->>'id')::uuid
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SCOPE: Section ID atau nama sudah digunakan.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_placements) placement
    where jsonb_typeof(placement) <> 'object'
       or not (placement ?& array['item_id', 'section_id', 'position'])
       or jsonb_typeof(placement->'item_id') <> 'string'
       or jsonb_typeof(placement->'section_id') not in ('string', 'null')
       or jsonb_typeof(placement->'position') not in ('number', 'null')
       or (
         jsonb_typeof(placement->'section_id') = 'null'
         and jsonb_typeof(placement->'position') <> 'null'
       )
       or (
         jsonb_typeof(placement->'section_id') = 'string'
         and (
           jsonb_typeof(placement->'position') <> 'number'
           or (placement->>'position')::numeric <> trunc((placement->>'position')::numeric)
           or (placement->>'position')::numeric < 0
           or (placement->>'position')::numeric > 2147483647
           or placement->>'section_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         )
       )
       or not exists (
         select 1
         from jsonb_array_elements(p_items) item
         where item->>'item_id' = placement->>'item_id'
           and (item->>'active')::boolean is true
       )
       or (
         jsonb_typeof(placement->'section_id') = 'string'
         and not exists (
           select 1
           from jsonb_array_elements(p_sections) section
           where section->>'id' = placement->>'section_id'
             and (section->>'active')::boolean is true
         )
       )
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CATALOG: Placement tidak valid.';
  end if;

  select count(*)
    into v_active_count
  from jsonb_array_elements(p_items) item
  where (item->>'active')::boolean is true;

  if jsonb_array_length(p_placements) <> v_active_count
     or jsonb_array_length(p_placements) <> (
       select count(distinct placement->>'item_id')
       from jsonb_array_elements(p_placements) placement
     )
     or exists (
       select 1
       from jsonb_array_elements(p_items) item
       where (item->>'active')::boolean is true
         and 1 <> (
           select count(*)
           from jsonb_array_elements(p_placements) placement
           where placement->>'item_id' = item->>'item_id'
         )
     )
     or exists (
       select 1
       from jsonb_array_elements(p_items) item
       where (item->>'active')::boolean is false
         and exists (
           select 1
           from jsonb_array_elements(p_placements) placement
           where placement->>'item_id' = item->>'item_id'
         )
     ) then
    raise exception using errcode = '22023', message = 'INVALID_CATALOG: Item aktif wajib memiliki tepat satu placement; item arsip tidak boleh memiliki placement.';
  end if;

  if exists (
    select 1
    from (
      select
        placement->>'section_id' as section_id,
        count(*) as placement_count,
        count(distinct (placement->>'position')::integer) as distinct_count,
        min((placement->>'position')::integer) as min_position,
        max((placement->>'position')::integer) as max_position
      from jsonb_array_elements(p_placements) placement
      where jsonb_typeof(placement->'section_id') = 'string'
      group by placement->>'section_id'
    ) positions
    where positions.distinct_count <> positions.placement_count
       or positions.min_position <> 0
       or positions.max_position <> positions.placement_count - 1
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CATALOG: Posisi placement harus unik dan contiguous.';
  end if;
end;
$$;

create or replace function public.pending_catalog_promote(
  p_outlet uuid,
  p_area public.area_code,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pending public.pending_catalogs%rowtype;
  v_value jsonb;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('catalog-global-items', 22022)
  );
  lock table public.outlets in share mode;
  if exists (
    select 1 from public.outlets where active is true and id <> p_outlet
  ) then
    raise exception using errcode = '55000', message = 'GLOBAL_ITEM_SCHEMA: Item tidak memiliki outlet_id; mutasi ditolak saat ada outlet aktif lain.';
  end if;

  select *
    into v_pending
  from public.pending_catalogs
  where outlet_id = p_outlet
    and area_code = p_area
  for update;

  if not found then
    return 0;
  end if;

  perform public.pending_catalog_validate(
    p_outlet,
    p_area,
    v_pending.items_json,
    v_pending.sections_json,
    v_pending.placements_json
  );

  for v_value in select value from jsonb_array_elements(v_pending.items_json) loop
    insert into public.items (
      id, area_code, name, unit_code, decimal_scale, low_threshold, active
    ) values (
      v_value->>'item_id',
      p_area,
      btrim(v_value->>'name'),
      btrim(v_value->>'unit_code'),
      (v_value->>'decimal_scale')::smallint,
      (v_value->>'low_threshold')::numeric,
      (v_value->>'active')::boolean
    )
    on conflict (id) do update
      set area_code = excluded.area_code,
          name = excluded.name,
          unit_code = excluded.unit_code,
          decimal_scale = excluded.decimal_scale,
          low_threshold = excluded.low_threshold,
          active = excluded.active,
          updated_at = clock_timestamp();
  end loop;

  update public.items item
  set active = false,
      updated_at = clock_timestamp()
  where item.area_code = p_area
    and not exists (
      select 1
      from jsonb_array_elements(v_pending.items_json) payload_item
      where payload_item->>'item_id' = item.id
    );

  delete from public.item_placements placement
  where placement.outlet_id = p_outlet
    and placement.area_code = p_area;

  for v_value in select value from jsonb_array_elements(v_pending.sections_json) loop
    insert into public.checklist_sections (
      id, outlet_id, area_code, name, position, active
    ) values (
      (v_value->>'id')::uuid,
      p_outlet,
      p_area,
      btrim(v_value->>'name'),
      (v_value->>'position')::integer,
      (v_value->>'active')::boolean
    )
    on conflict (id) do update
      set outlet_id = excluded.outlet_id,
          area_code = excluded.area_code,
          name = excluded.name,
          position = excluded.position,
          active = excluded.active,
          updated_at = clock_timestamp();
  end loop;

  update public.checklist_sections section
  set active = false,
      updated_at = clock_timestamp()
  where section.outlet_id = p_outlet
    and section.area_code = p_area
    and not exists (
      select 1
      from jsonb_array_elements(v_pending.sections_json) payload_section
      where (payload_section->>'id')::uuid = section.id
    );

  for v_value in
    select value
    from jsonb_array_elements(v_pending.placements_json)
    where jsonb_typeof(value->'section_id') = 'string'
  loop
    insert into public.item_placements (
      item_id, outlet_id, area_code, section_id, position
    ) values (
      v_value->>'item_id',
      p_outlet,
      p_area,
      (v_value->>'section_id')::uuid,
      (v_value->>'position')::integer
    )
    on conflict (item_id) do update
      set outlet_id = excluded.outlet_id,
          area_code = excluded.area_code,
          section_id = excluded.section_id,
          position = excluded.position,
          updated_at = clock_timestamp();
  end loop;

  insert into public.checklist_layouts (outlet_id, area_code, version)
  values (p_outlet, p_area, v_pending.version)
  on conflict (outlet_id, area_code) do update
    set version = excluded.version,
        updated_at = clock_timestamp();

  delete from public.pending_catalogs
  where outlet_id = p_outlet
    and area_code = p_area;

  perform public.log_audit_event(
    v_pending.last_actor_id,
    'PROMOTE_PENDING_CATALOG',
    'pending_catalogs',
    p_outlet::text,
    p_outlet,
    null,
    null,
    jsonb_build_object(
      'area_code', p_area,
      'version', v_pending.version,
      'reason', p_reason,
      'fingerprint', v_pending.fingerprint
    )
  );

  return v_pending.version;
end;
$$;

create or replace function public.pending_catalog_apply_internal(
  p_actor uuid,
  p_outlet uuid,
  p_area public.area_code,
  p_expected_version integer,
  p_items jsonb,
  p_sections jsonb,
  p_placements jsonb,
  p_action text,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_pending public.pending_catalogs%rowtype;
  v_existing public.pending_catalog_ops%rowtype;
  v_before jsonb;
  v_fingerprint text;
  v_result jsonb;
  v_current_version integer;
  v_next_version integer;
  v_started boolean;
  v_reason text := nullif(btrim(p_reason), '');
  v_action text := nullif(btrim(p_action), '');
begin
  v_role := public.require_authorized_actor(p_actor, p_outlet);
  if v_role::text not in ('OWNER', 'SUPERVISOR', 'OPERATOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan.';
  end if;
  if v_role::text = 'OPERATOR' and not exists (
    select 1
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where assignment.profile_id = p_actor
      and assignment.duty_role = 'PRIMARY'
      and assignment.status = 'ACTIVE'
      and cycle.outlet_id = p_outlet
      and cycle.area_code = p_area
      and cycle.work_date = (now() at time zone 'Asia/Jakarta')::date
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN_SCOPE: PRIMARY area aktif diperlukan.';
  end if;
  if p_area is null or p_expected_version is null or p_expected_version < 1
     or p_idempotency_key is null or v_action is null or length(v_action) > 80
     or v_reason is null or length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Area, version, action, reason, dan idempotency key wajib valid.';
  end if;

  v_fingerprint := coalesce(
    p_request_fingerprint,
    public.pending_catalog_hash(
      p_actor,
      p_outlet,
      p_area,
      v_action,
      v_reason,
      p_items,
      p_sections,
      p_placements,
      p_expected_version
    )
  );

  select *
    into v_existing
  from public.pending_catalog_ops
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing.fingerprint <> v_fingerprint then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_CONFLICT: Key katalog berbeda action, reason, atau payload.';
    end if;
    return v_existing.result || jsonb_build_object('idempotent_replay', true);
  end if;

  -- Item IDs are global, so cross-area validation must serialize before the
  -- finer outlet/area generation lock.
  perform pg_advisory_xact_lock(
    hashtextextended('catalog-global-items', 22022)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(p_outlet::text || ':' || p_area::text, 22022)
  );

  -- A concurrent replay can have committed while this call waited for the
  -- outlet/area lock, so resolve the key again before checking the version.
  select *
    into v_existing
  from public.pending_catalog_ops
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.fingerprint <> v_fingerprint then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_CONFLICT: Key katalog berbeda action, reason, atau payload.';
    end if;
    return v_existing.result || jsonb_build_object('idempotent_replay', true);
  end if;

  lock table public.outlets in share mode;
  if exists (
    select 1 from public.outlets where active is true and id <> p_outlet
  ) then
    raise exception using errcode = '55000', message = 'GLOBAL_ITEM_SCHEMA: Item tidak memiliki outlet_id; mutasi ditolak saat ada outlet aktif lain.';
  end if;

  select *
    into v_pending
  from public.pending_catalogs
  where outlet_id = p_outlet
    and area_code = p_area
  for update;

  if found then
    v_current_version := v_pending.version;
    v_before := jsonb_build_object(
      'items', v_pending.items_json,
      'sections', v_pending.sections_json,
      'placements', v_pending.placements_json,
      'version', v_pending.version
    );
  else
    select layout.version
      into v_current_version
    from public.checklist_layouts layout
    where layout.outlet_id = p_outlet
      and layout.area_code = p_area;
    v_current_version := coalesce(v_current_version, 1);
    v_before := public.pending_catalog_current(p_outlet, p_area)
      || jsonb_build_object('version', v_current_version);
  end if;

  if v_current_version <> p_expected_version then
    raise exception using
      errcode = '40001',
      message = format(
        'VERSION_CONFLICT: Expected catalog version %s, current version %s.',
        p_expected_version,
        v_current_version
      );
  end if;

  perform public.pending_catalog_validate(
    p_outlet, p_area, p_items, p_sections, p_placements
  );

  v_next_version := v_current_version + 1;
  v_started := public.pending_catalog_started(p_outlet, p_area);

  insert into public.pending_catalogs (
    outlet_id,
    area_code,
    version,
    items_json,
    sections_json,
    placements_json,
    fingerprint,
    last_idempotency_key,
    last_actor_id,
    updated_at
  ) values (
    p_outlet,
    p_area,
    v_next_version,
    p_items,
    p_sections,
    p_placements,
    v_fingerprint,
    p_idempotency_key,
    p_actor,
    clock_timestamp()
  )
  on conflict (outlet_id, area_code) do update
    set version = excluded.version,
        items_json = excluded.items_json,
        sections_json = excluded.sections_json,
        placements_json = excluded.placements_json,
        fingerprint = excluded.fingerprint,
        last_idempotency_key = excluded.last_idempotency_key,
        last_actor_id = excluded.last_actor_id,
        updated_at = excluded.updated_at;

  if v_started then
    v_result := jsonb_build_object(
      'mode', 'PENDING',
      'version', v_next_version,
      'layout_version', v_next_version,
      'pending', true,
      'effective_next_cycle', true,
      'fingerprint', v_fingerprint,
      'idempotent_replay', false
    );
  else
    perform public.pending_catalog_promote(
      p_outlet, p_area, 'IMMEDIATE_CURRENT_APPLY'
    );
    v_result := jsonb_build_object(
      'mode', 'CURRENT',
      'version', v_next_version,
      'layout_version', v_next_version,
      'pending', false,
      'effective_next_cycle', false,
      'fingerprint', v_fingerprint,
      'idempotent_replay', false
    );
  end if;

  insert into public.pending_catalog_ops (
    idempotency_key, actor_id, outlet_id, area_code, fingerprint, result
  ) values (
    p_idempotency_key, p_actor, p_outlet, p_area, v_fingerprint, v_result
  );

  perform public.log_audit_event(
    p_actor,
    v_action,
    'pending_catalogs',
    p_outlet::text,
    p_outlet,
    null,
    v_before,
    v_result,
    v_reason
  );

  return v_result;
end;
$$;

create or replace function public.pending_catalog_cycle_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status is distinct from new.status
     and (
       old.status in ('ACTIVE', 'OPEN', 'HANDOVER_READY', 'CLOSING_READY')
       or new.status in ('ACTIVE', 'OPEN', 'HANDOVER_READY', 'CLOSING_READY')
     ) then
    perform pg_advisory_xact_lock(
      hashtextextended('catalog-global-items', 22022)
    );
    perform pg_advisory_xact_lock(
      hashtextextended(new.outlet_id::text || ':' || new.area_code::text, 22022)
    );

    if old.status in ('ACTIVE', 'OPEN', 'HANDOVER_READY', 'CLOSING_READY')
       and new.status in ('COMPLETED', 'RESET')
       and not exists (
         select 1
         from public.work_cycles cycle
         where cycle.outlet_id = new.outlet_id
           and cycle.area_code = new.area_code
           and cycle.id <> new.id
           and cycle.status in ('ACTIVE', 'OPEN', 'HANDOVER_READY', 'CLOSING_READY')
       ) then
      perform public.pending_catalog_promote(
        new.outlet_id,
        new.area_code,
        'LAST_STARTED_CYCLE_TERMINAL'
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pending_catalog_before_cycle on public.work_cycles;
drop trigger if exists trg_pending_catalog_after_cycle on public.work_cycles;
create trigger trg_pending_catalog_before_cycle
before update of status on public.work_cycles
for each row
execute function public.pending_catalog_cycle_transition();

create or replace function public.rpc_catalog_get(
  p_actor uuid,
  p_outlet uuid,
  p_area public.area_code
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_current jsonb;
  v_pending public.pending_catalogs%rowtype;
  v_current_version integer;
begin
  v_role := public.require_authorized_actor(p_actor, p_outlet);
  if v_role::text = 'INVESTOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Investor tidak memiliki jalur operasional.';
  end if;
  if p_area is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Area wajib diisi.';
  end if;

  v_current := public.pending_catalog_current(p_outlet, p_area);
  select layout.version
    into v_current_version
  from public.checklist_layouts layout
  where layout.outlet_id = p_outlet
    and layout.area_code = p_area;
  v_current_version := coalesce(v_current_version, 1);

  select *
    into v_pending
  from public.pending_catalogs
  where outlet_id = p_outlet
    and area_code = p_area;

  return jsonb_build_object(
    'current', v_current,
    'current_version', v_current_version,
    'pending', case when v_pending.version is null then null else jsonb_build_object(
      'items', v_pending.items_json,
      'sections', v_pending.sections_json,
      'placements', v_pending.placements_json
    ) end,
    'pending_version', v_pending.version,
    'layout_version', coalesce(v_pending.version, v_current_version),
    'effective_next_cycle', v_pending.version is not null
  );
end;
$$;

create or replace function public.rpc_catalog_apply(
  p_actor uuid,
  p_outlet uuid,
  p_area public.area_code,
  p_expected_version integer,
  p_items jsonb,
  p_sections jsonb,
  p_placements jsonb,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.pending_catalog_apply_internal(
    p_actor,
    p_outlet,
    p_area,
    p_expected_version,
    p_items,
    p_sections,
    p_placements,
    'APPLY_CATALOG',
    p_reason,
    p_idempotency_key,
    null
  );
end;
$$;

create or replace function public.pending_catalog_create_item(
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
  v_catalog jsonb;
  v_item jsonb;
  v_result jsonb;
  v_key uuid := gen_random_uuid();
  v_item_id text := btrim(p_item_id);
  v_name text := nullif(btrim(p_name), '');
  v_unit_code text := nullif(btrim(p_unit_code), '');
begin
  if v_item_id is null or v_item_id !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
     or p_area_code is null or v_name is null or length(v_name) > 150
     or v_unit_code is null or length(v_unit_code) > 32
     or p_decimal_scale is null or p_decimal_scale not between 0 and 4
     or p_low_threshold is null or p_low_threshold < 0
     or p_low_threshold::text in ('NaN', 'Infinity', '-Infinity')
     or p_low_threshold > 9999999999.9999 then
    raise exception using errcode = '22023', message = 'INVALID_ITEM: ID, area, nama, unit, scale, atau threshold tidak valid.';
  end if;

  v_catalog := public.pending_catalog_effective(p_outlet_id, p_area_code);
  if exists (select 1 from public.items where id = v_item_id)
     or exists (
       select 1
       from public.pending_catalogs pending
       cross join lateral jsonb_array_elements(pending.items_json) item
       where item->>'item_id' = v_item_id
     ) then
    raise exception using errcode = '23505', message = 'ITEM_EXISTS: ID item sudah digunakan.';
  end if;

  v_item := jsonb_build_object(
    'item_id', v_item_id,
    'area_code', p_area_code,
    'name', v_name,
    'unit_code', v_unit_code,
    'decimal_scale', p_decimal_scale,
    'low_threshold', p_low_threshold,
    'active', true
  );
  v_catalog := jsonb_set(
    v_catalog,
    '{items}',
    (v_catalog->'items') || jsonb_build_array(v_item)
  );
  v_catalog := jsonb_set(
    v_catalog,
    '{placements}',
    (v_catalog->'placements') || jsonb_build_array(jsonb_build_object(
      'item_id', v_item_id,
      'section_id', null,
      'position', null
    ))
  );

  v_result := public.pending_catalog_apply_internal(
    p_actor_id,
    p_outlet_id,
    p_area_code,
    (v_catalog->>'version')::integer,
    v_catalog->'items',
    v_catalog->'sections',
    v_catalog->'placements',
    'CREATE_ITEM',
    'CREATE_ITEM',
    v_key,
    null
  );

  v_result := jsonb_build_object(
    'id', v_item_id,
    'area_code', p_area_code,
    'name', v_name,
    'unit_code', v_unit_code,
    'decimal_scale', p_decimal_scale,
    'low_threshold', p_low_threshold,
    'active', true
  ) || v_result;
  update public.pending_catalog_ops set result = v_result where idempotency_key = v_key;
  return v_result;
end;
$$;

create or replace function public.pending_catalog_archive_item(
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
  v_key uuid := gen_random_uuid();
  v_reason text := nullif(btrim(p_reason), '');
begin
  if nullif(btrim(p_item_id), '') is null
     or v_reason is null or length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: ID item dan alasan arsip wajib valid.';
  end if;

  v_area := public.pending_catalog_item_area(p_outlet_id, p_item_id);
  if v_area is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Item tidak ditemukan.';
  end if;

  v_catalog := public.pending_catalog_effective(p_outlet_id, v_area);
  select value
    into v_item
  from jsonb_array_elements(v_catalog->'items')
  where value->>'item_id' = btrim(p_item_id);

  if v_item is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Item tidak ditemukan.';
  end if;
  if not (v_item->>'active')::boolean then
    return jsonb_build_object(
      'id', v_item->>'item_id',
      'area_code', v_item->>'area_code',
      'name', v_item->>'name',
      'unit_code', v_item->>'unit_code',
      'decimal_scale', (v_item->>'decimal_scale')::smallint,
      'low_threshold', (v_item->>'low_threshold')::numeric,
      'active', false,
      'idempotent_replay', true
    );
  end if;

  v_catalog := jsonb_set(
    v_catalog,
    '{items}',
    (
      select jsonb_agg(
        case
          when value->>'item_id' = btrim(p_item_id)
            then jsonb_set(value, '{active}', 'false'::jsonb)
          else value
        end
        order by value->>'item_id'
      )
      from jsonb_array_elements(v_catalog->'items')
    )
  );
  v_catalog := jsonb_set(
    v_catalog,
    '{placements}',
    coalesce((
      with remaining as (
        select
          placement->>'item_id' as item_id,
          placement->>'section_id' as section_id,
          case
            when jsonb_typeof(placement->'position') = 'number'
              then (placement->>'position')::integer
            else null
          end as old_position
        from jsonb_array_elements(v_catalog->'placements') placement
        where placement->>'item_id' <> btrim(p_item_id)
      ), compacted as (
        select
          item_id,
          section_id,
          case
            when section_id is null then null
            else row_number() over (
              partition by section_id order by old_position, item_id
            )::integer - 1
          end as position
        from remaining
      )
      select jsonb_agg(
        jsonb_build_object(
          'item_id', item_id,
          'section_id', section_id,
          'position', position
        ) order by section_id nulls last, position nulls last, item_id
      )
      from compacted
    ), '[]'::jsonb)
  );

  v_result := public.pending_catalog_apply_internal(
    p_actor_id,
    p_outlet_id,
    v_area,
    (v_catalog->>'version')::integer,
    v_catalog->'items',
    v_catalog->'sections',
    v_catalog->'placements',
    'ARCHIVE_ITEM',
    v_reason,
    v_key,
    null
  );

  v_result := jsonb_build_object(
    'id', v_item->>'item_id',
    'area_code', v_item->>'area_code',
    'name', v_item->>'name',
    'unit_code', v_item->>'unit_code',
    'decimal_scale', (v_item->>'decimal_scale')::smallint,
    'low_threshold', (v_item->>'low_threshold')::numeric,
    'active', false,
    'archive_reason', v_reason
  ) || v_result;
  update public.pending_catalog_ops set result = v_result where idempotency_key = v_key;
  return v_result;
end;
$$;

-- Preserve every 0020 public signature. Metadata stays manager-only; operator
-- entry points below enforce PRIMARY ownership for their active area.
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
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat membuat item.';
  end if;
  return public.pending_catalog_create_item(
    p_actor_id, p_outlet_id, p_item_id, p_area_code, p_name,
    p_unit_code, p_decimal_scale, p_low_threshold
  );
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
  v_area public.area_code;
  v_catalog jsonb;
  v_item jsonb;
  v_result jsonb;
  v_key uuid := gen_random_uuid();
  v_name text := nullif(btrim(p_name), '');
  v_unit_code text := nullif(btrim(p_unit_code), '');
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat mengubah item.';
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

  v_area := public.pending_catalog_item_area(p_outlet_id, p_item_id);
  if v_area is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Item tidak ditemukan.';
  end if;
  v_catalog := public.pending_catalog_effective(p_outlet_id, v_area);
  select value
    into v_item
  from jsonb_array_elements(v_catalog->'items')
  where value->>'item_id' = btrim(p_item_id);
  if v_item is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Item tidak ditemukan.';
  end if;
  if not (v_item->>'active')::boolean then
    raise exception using errcode = '55000', message = 'ITEM_ARCHIVED: Item terarsip tidak dapat diubah.';
  end if;

  v_catalog := jsonb_set(
    v_catalog,
    '{items}',
    (
      select jsonb_agg(
        case when value->>'item_id' = btrim(p_item_id) then jsonb_build_object(
          'item_id', value->>'item_id',
          'area_code', value->>'area_code',
          'name', v_name,
          'unit_code', v_unit_code,
          'decimal_scale', p_decimal_scale,
          'low_threshold', p_low_threshold,
          'active', true
        ) else value end
        order by value->>'item_id'
      )
      from jsonb_array_elements(v_catalog->'items')
    )
  );

  v_result := public.pending_catalog_apply_internal(
    p_actor_id,
    p_outlet_id,
    v_area,
    (v_catalog->>'version')::integer,
    v_catalog->'items',
    v_catalog->'sections',
    v_catalog->'placements',
    'UPDATE_ITEM',
    'UPDATE_ITEM',
    v_key,
    null
  );
  v_result := jsonb_build_object(
    'id', btrim(p_item_id),
    'area_code', v_area,
    'name', v_name,
    'unit_code', v_unit_code,
    'decimal_scale', p_decimal_scale,
    'low_threshold', p_low_threshold,
    'active', true
  ) || v_result;
  update public.pending_catalog_ops set result = v_result where idempotency_key = v_key;
  return v_result;
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
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner atau Supervisor yang dapat mengarsipkan item.';
  end if;
  return public.pending_catalog_archive_item(
    p_actor_id, p_outlet_id, p_item_id, p_reason
  );
end;
$$;

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
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Jalur ini hanya untuk OPERATOR PRIMARY.';
  end if;
  if not exists (
    select 1
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY'
      and assignment.status = 'ACTIVE'
      and cycle.outlet_id = p_outlet_id
      and cycle.area_code = p_area_code
      and cycle.work_date = (now() at time zone 'Asia/Jakarta')::date
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN_SCOPE: PRIMARY hanya boleh menambah item pada area tugas aktifnya.';
  end if;
  return public.pending_catalog_create_item(
    p_actor_id, p_outlet_id, p_item_id, p_area_code, p_name,
    p_unit_code, p_decimal_scale, p_low_threshold
  );
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
  v_area public.area_code;
  v_reason text := nullif(btrim(p_reason), '');
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Jalur ini hanya untuk OPERATOR PRIMARY.';
  end if;
  if nullif(btrim(p_item_id), '') is null
     or v_reason is null or length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: ID item dan alasan arsip wajib valid.';
  end if;
  v_area := public.pending_catalog_item_area(p_outlet_id, p_item_id);
  if v_area is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Item tidak ditemukan.';
  end if;
  if not exists (
    select 1
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY'
      and assignment.status = 'ACTIVE'
      and cycle.outlet_id = p_outlet_id
      and cycle.area_code = v_area
      and cycle.work_date = (now() at time zone 'Asia/Jakarta')::date
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN_SCOPE: PRIMARY hanya boleh mengarsip item pada area tugas aktifnya.';
  end if;
  return public.pending_catalog_archive_item(
    p_actor_id, p_outlet_id, p_item_id, v_reason
  );
end;
$$;

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
  v_catalog jsonb;
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text = 'INVESTOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Investor tidak memiliki jalur operasional.';
  end if;
  if p_area_code is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Area wajib diisi.';
  end if;
  v_catalog := public.pending_catalog_effective(p_outlet_id, p_area_code);
  return jsonb_build_object(
    'version', (v_catalog->>'version')::integer,
    'layout_version', (v_catalog->>'version')::integer,
    'sections', v_catalog->'sections',
    'placements', v_catalog->'placements',
    'pending', (v_catalog->>'pending')::boolean,
    'pending_version', case
      when (v_catalog->>'pending')::boolean then (v_catalog->>'version')::integer
      else null
    end,
    'effective_next_cycle', (v_catalog->>'pending')::boolean
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
  v_catalog jsonb;
  v_section_id uuid;
  v_section jsonb;
  v_result jsonb;
  v_existing public.pending_catalog_ops%rowtype;
  v_fingerprint text;
  v_name text := nullif(btrim(p_name), '');
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text = 'OPERATOR' then
    if not exists (
      select 1
      from public.work_assignments assignment
      join public.work_cycles cycle on cycle.id = assignment.cycle_id
      where assignment.profile_id = p_actor_id
        and assignment.duty_role = 'PRIMARY'
        and assignment.status = 'ACTIVE'
        and cycle.outlet_id = p_outlet_id
        and cycle.area_code = p_area_code
        and cycle.work_date = (now() at time zone 'Asia/Jakarta')::date
    ) then
      raise exception using errcode = '42501', message = 'FORBIDDEN_SCOPE: PRIMARY hanya boleh menata bagian pada area tugas aktifnya.';
    end if;
  elsif v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner, Supervisor, atau PRIMARY yang boleh menata bagian.';
  end if;
  if p_area_code is null or v_name is null or length(v_name) > 80
     or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Area, nama bagian, dan idempotency key wajib valid.';
  end if;

  v_fingerprint := public.pending_catalog_hash(
    p_actor_id,
    p_outlet_id,
    p_area_code,
    'UPSERT_CHECKLIST_SECTION',
    'UPSERT_CHECKLIST_SECTION',
    jsonb_build_object('section_id', p_section_id, 'name', v_name),
    null,
    null,
    null
  );
  select *
    into v_existing
  from public.pending_catalog_ops
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.fingerprint <> v_fingerprint then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_CONFLICT: Key section berbeda action atau payload.';
    end if;
    return v_existing.result || jsonb_build_object('idempotent_replay', true);
  end if;

  v_catalog := public.pending_catalog_effective(p_outlet_id, p_area_code);
  v_section_id := coalesce(
    p_section_id,
    md5(p_outlet_id::text || ':' || p_area_code::text || ':' || p_idempotency_key::text)::uuid
  );

  if exists (
    select 1
    from jsonb_array_elements(v_catalog->'sections') section
    where lower(btrim(section->>'name')) = lower(v_name)
      and section->>'id' <> v_section_id::text
  ) then
    raise exception using errcode = '23505', message = 'SECTION_EXISTS: Nama section sudah digunakan.';
  end if;

  if p_section_id is null then
    v_section := jsonb_build_object(
      'id', v_section_id,
      'name', v_name,
      'position', jsonb_array_length(v_catalog->'sections'),
      'active', true
    );
    v_catalog := jsonb_set(
      v_catalog,
      '{sections}',
      (v_catalog->'sections') || jsonb_build_array(v_section)
    );
  else
    select value
      into v_section
    from jsonb_array_elements(v_catalog->'sections')
    where value->>'id' = v_section_id::text;
    if v_section is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND: Bagian tidak ditemukan.';
    end if;
    v_section := jsonb_build_object(
      'id', v_section_id,
      'name', v_name,
      'position', (v_section->>'position')::integer,
      'active', (v_section->>'active')::boolean
    );
    v_catalog := jsonb_set(
      v_catalog,
      '{sections}',
      (
        select jsonb_agg(
          case when value->>'id' = v_section_id::text then v_section else value end
          order by (value->>'position')::integer, value->>'id'
        )
        from jsonb_array_elements(v_catalog->'sections')
      )
    );
  end if;

  v_result := public.pending_catalog_apply_internal(
    p_actor_id,
    p_outlet_id,
    p_area_code,
    (v_catalog->>'version')::integer,
    v_catalog->'items',
    v_catalog->'sections',
    v_catalog->'placements',
    'UPSERT_CHECKLIST_SECTION',
    'UPSERT_CHECKLIST_SECTION',
    p_idempotency_key,
    v_fingerprint
  );
  v_result := jsonb_build_object('section', v_section) || v_result;
  update public.pending_catalog_ops
  set result = v_result
  where idempotency_key = p_idempotency_key;
  return v_result;
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
  v_catalog jsonb;
  v_result jsonb;
  v_existing public.pending_catalog_ops%rowtype;
  v_fingerprint text;
  v_item_id text := btrim(p_item_id);
  v_destination_count integer;
begin
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text = 'OPERATOR' then
    if not exists (
      select 1
      from public.work_assignments assignment
      join public.work_cycles cycle on cycle.id = assignment.cycle_id
      where assignment.profile_id = p_actor_id
        and assignment.duty_role = 'PRIMARY'
        and assignment.status = 'ACTIVE'
        and cycle.outlet_id = p_outlet_id
        and cycle.area_code = p_area_code
        and cycle.work_date = (now() at time zone 'Asia/Jakarta')::date
    ) then
      raise exception using errcode = '42501', message = 'FORBIDDEN_SCOPE: PRIMARY hanya boleh menata item pada area tugas aktifnya.';
    end if;
  elsif v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya Owner, Supervisor, atau PRIMARY yang boleh menata item.';
  end if;
  if p_area_code is null or nullif(v_item_id, '') is null or p_section_id is null
     or p_position is null or p_position < 0
     or p_expected_layout_version is null or p_expected_layout_version <= 0
     or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Payload pemindahan wajib valid.';
  end if;

  v_fingerprint := public.pending_catalog_hash(
    p_actor_id,
    p_outlet_id,
    p_area_code,
    'MOVE_CHECKLIST_ITEM',
    'MOVE_CHECKLIST_ITEM',
    jsonb_build_object(
      'item_id', v_item_id,
      'section_id', p_section_id,
      'position', p_position
    ),
    null,
    null,
    p_expected_layout_version
  );
  select *
    into v_existing
  from public.pending_catalog_ops
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.fingerprint <> v_fingerprint then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_CONFLICT: Key move berbeda action atau payload.';
    end if;
    return v_existing.result || jsonb_build_object('idempotent_replay', true);
  end if;

  v_catalog := public.pending_catalog_effective(p_outlet_id, p_area_code);
  if (v_catalog->>'version')::integer <> p_expected_layout_version then
    raise exception using
      errcode = '40001',
      message = format(
        'VERSION_CONFLICT: Expected layout version %s, current version %s.',
        p_expected_layout_version,
        (v_catalog->>'version')::integer
      );
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(v_catalog->'items') item
    where item->>'item_id' = v_item_id
      and (item->>'active')::boolean is true
  ) or not exists (
    select 1
    from jsonb_array_elements(v_catalog->'sections') section
    where section->>'id' = p_section_id::text
      and (section->>'active')::boolean is true
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SCOPE: Item atau section tidak sesuai area.';
  end if;

  select count(*)
    into v_destination_count
  from jsonb_array_elements(v_catalog->'placements') placement
  where placement->>'item_id' <> v_item_id
    and placement->>'section_id' = p_section_id::text;
  if p_position > v_destination_count then
    raise exception using errcode = '22023', message = 'INVALID_POSITION: Posisi tujuan melewati akhir section.';
  end if;

  with remaining as (
    select
      placement->>'item_id' as item_id,
      placement->>'section_id' as section_id,
      case
        when jsonb_typeof(placement->'position') = 'number'
          then (placement->>'position')::integer
        else null
      end as old_position
    from jsonb_array_elements(v_catalog->'placements') placement
    where placement->>'item_id' <> v_item_id
  ), ranked as (
    select
      item_id,
      section_id,
      case
        when section_id is null then null
        else row_number() over (
          partition by section_id order by old_position, item_id
        )::integer - 1
      end as compact_position
    from remaining
  ), rebuilt as (
    select
      item_id,
      section_id,
      case
        when section_id is null then null
        when section_id = p_section_id::text and compact_position >= p_position
          then compact_position + 1
        else compact_position
      end as position
    from ranked
    union all
    select v_item_id, p_section_id::text, p_position
  )
  select jsonb_agg(
    jsonb_build_object(
      'item_id', item_id,
      'section_id', section_id,
      'position', position
    ) order by section_id nulls last, position nulls last, item_id
  )
    into v_result
  from rebuilt;

  v_catalog := jsonb_set(v_catalog, '{placements}', coalesce(v_result, '[]'::jsonb));
  v_result := public.pending_catalog_apply_internal(
    p_actor_id,
    p_outlet_id,
    p_area_code,
    p_expected_layout_version,
    v_catalog->'items',
    v_catalog->'sections',
    v_catalog->'placements',
    'MOVE_CHECKLIST_ITEM',
    'MOVE_CHECKLIST_ITEM',
    p_idempotency_key,
    v_fingerprint
  );
  v_result := jsonb_build_object(
    'item_id', v_item_id,
    'section_id', p_section_id,
    'position', p_position,
    'layout_version', (v_result->>'layout_version')::integer
  ) || v_result;
  update public.pending_catalog_ops
  set result = v_result
  where idempotency_key = p_idempotency_key;
  return v_result;
end;
$$;

-- Helpers are trigger/RPC internals. Every externally reachable function is
-- explicitly closed before service_role receives the exact callable surface.
revoke execute on function public.pending_catalog_started(uuid, public.area_code) from public, anon, authenticated;
revoke execute on function public.pending_catalog_hash(uuid, uuid, public.area_code, text, text, jsonb, jsonb, jsonb, integer) from public, anon, authenticated;
revoke execute on function public.pending_catalog_current(uuid, public.area_code) from public, anon, authenticated;
revoke execute on function public.pending_catalog_effective(uuid, public.area_code) from public, anon, authenticated;
revoke execute on function public.pending_catalog_item_area(uuid, text) from public, anon, authenticated;
revoke execute on function public.pending_catalog_validate(uuid, public.area_code, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.pending_catalog_promote(uuid, public.area_code, text) from public, anon, authenticated;
revoke execute on function public.pending_catalog_apply_internal(uuid, uuid, public.area_code, integer, jsonb, jsonb, jsonb, text, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.pending_catalog_create_item(uuid, uuid, text, public.area_code, text, text, smallint, numeric) from public, anon, authenticated;
revoke execute on function public.pending_catalog_archive_item(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.pending_catalog_cycle_transition() from public, anon, authenticated;

revoke execute on function public.rpc_catalog_get(uuid, uuid, public.area_code) from public, anon, authenticated;
revoke execute on function public.rpc_catalog_apply(uuid, uuid, public.area_code, integer, jsonb, jsonb, jsonb, text, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_create_item(uuid, uuid, text, public.area_code, text, text, smallint, numeric) from public, anon, authenticated;
revoke execute on function public.rpc_update_item(uuid, uuid, text, text, text, smallint, numeric) from public, anon, authenticated;
revoke execute on function public.rpc_archive_item(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_operator_create_item(uuid, uuid, text, public.area_code, text, text, smallint, numeric) from public, anon, authenticated;
revoke execute on function public.rpc_operator_archive_item(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_checklist_layout_get(uuid, uuid, public.area_code) from public, anon, authenticated;
revoke execute on function public.rpc_checklist_section_upsert(uuid, uuid, public.area_code, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_checklist_item_move(uuid, uuid, public.area_code, text, uuid, integer, integer, uuid) from public, anon, authenticated;

grant execute on function public.rpc_catalog_get(uuid, uuid, public.area_code) to service_role;
grant execute on function public.rpc_catalog_apply(uuid, uuid, public.area_code, integer, jsonb, jsonb, jsonb, text, uuid) to service_role;
grant execute on function public.rpc_create_item(uuid, uuid, text, public.area_code, text, text, smallint, numeric) to service_role;
grant execute on function public.rpc_update_item(uuid, uuid, text, text, text, smallint, numeric) to service_role;
grant execute on function public.rpc_archive_item(uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_operator_create_item(uuid, uuid, text, public.area_code, text, text, smallint, numeric) to service_role;
grant execute on function public.rpc_operator_archive_item(uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_checklist_layout_get(uuid, uuid, public.area_code) to service_role;
grant execute on function public.rpc_checklist_section_upsert(uuid, uuid, public.area_code, uuid, text, uuid) to service_role;
grant execute on function public.rpc_checklist_item_move(uuid, uuid, public.area_code, text, uuid, integer, integer, uuid) to service_role;
