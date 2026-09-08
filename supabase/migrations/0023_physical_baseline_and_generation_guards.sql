-- 0023: immutable per-cycle opening references and physical baseline guards.

create table if not exists public.cycle_opening_references (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  cycle_id uuid not null unique references public.work_cycles(id) on delete restrict,
  area_code public.area_code not null,
  source_type text not null check (source_type in ('HANDOVER', 'CLOSING', 'PHYSICAL_BASELINE')),
  source_id uuid not null,
  warning_code text,
  frozen_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.cycle_opening_reference_lines (
  reference_id uuid not null references public.cycle_opening_references(id) on delete cascade,
  item_id text not null references public.items(id) on delete restrict,
  reference_qty numeric(14,4) not null check (reference_qty >= 0 and reference_qty <= 9999999999.9999),
  source_type text not null check (source_type in ('HANDOVER', 'CLOSING', 'PHYSICAL_BASELINE')),
  source_id uuid not null,
  primary key (reference_id, item_id)
);

create or replace function public.reject_cycle_opening_reference_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE'
     and old.frozen_at is null
     and new.frozen_at is not null
     and (to_jsonb(new) - 'frozen_at') is not distinct from (to_jsonb(old) - 'frozen_at') then
    return new;
  end if;
  raise exception using errcode = '55000', message = 'IMMUTABLE_REFERENCE: Referensi opening cycle tidak dapat diubah atau dihapus.';
end;
$$;

create or replace function public.reject_frozen_cycle_opening_reference_line_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_frozen_at timestamptz;
begin
  if tg_op = 'INSERT' then
    select frozen_at into v_frozen_at
    from public.cycle_opening_references
    where id = new.reference_id;
    if v_frozen_at is null then
      return new;
    end if;
  end if;
  raise exception using errcode = '55000', message = 'IMMUTABLE_REFERENCE: Baris referensi opening cycle tidak dapat dimutasi setelah dibekukan.';
end;
$$;

drop trigger if exists cycle_opening_references_immutable on public.cycle_opening_references;
create trigger cycle_opening_references_immutable
before update or delete on public.cycle_opening_references
for each row execute function public.reject_cycle_opening_reference_change();

drop trigger if exists cycle_opening_reference_lines_immutable on public.cycle_opening_reference_lines;
create trigger cycle_opening_reference_lines_immutable
before insert or update or delete on public.cycle_opening_reference_lines
for each row execute function public.reject_frozen_cycle_opening_reference_line_change();

alter table public.cycle_opening_references enable row level security;
alter table public.cycle_opening_reference_lines enable row level security;
revoke all on public.cycle_opening_references, public.cycle_opening_reference_lines from public, anon, authenticated;
grant all on public.cycle_opening_references, public.cycle_opening_reference_lines to service_role;

create table if not exists public.cycle_physical_baselines (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  cycle_id uuid not null unique references public.work_cycles(id) on delete restrict,
  area_code public.area_code not null,
  reason text not null check (length(reason) between 1 and 1000),
  recorded_by uuid not null references public.profiles(id),
  idempotency_key uuid not null unique,
  payload_fingerprint text not null,
  response_json jsonb not null,
  status text not null default 'RECORDED' check (status = 'RECORDED'),
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.cycle_physical_baseline_lines (
  baseline_id uuid not null references public.cycle_physical_baselines(id) on delete cascade,
  item_id text not null references public.items(id) on delete restrict,
  counted_qty numeric(14,4) not null check (counted_qty >= 0 and counted_qty <= 9999999999.9999),
  primary key (baseline_id, item_id)
);

alter table public.cycle_physical_baselines enable row level security;
alter table public.cycle_physical_baseline_lines enable row level security;
revoke all on public.cycle_physical_baselines, public.cycle_physical_baseline_lines from public, anon, authenticated;
grant all on public.cycle_physical_baselines, public.cycle_physical_baseline_lines to service_role;

drop trigger if exists cycle_physical_baselines_append_only on public.cycle_physical_baselines;
create trigger cycle_physical_baselines_append_only
before update or delete on public.cycle_physical_baselines
for each row execute function public.enforce_append_only();

drop trigger if exists cycle_physical_baseline_lines_append_only on public.cycle_physical_baseline_lines;
create trigger cycle_physical_baseline_lines_append_only
before update or delete on public.cycle_physical_baseline_lines
for each row execute function public.enforce_append_only();

create or replace function public.physical_baseline_fingerprint(
  p_actor_id uuid, p_outlet_id uuid, p_reason text, p_cycle_id uuid,
  p_expected_version integer, p_lines jsonb
)
returns text language sql immutable security definer set search_path=public,pg_temp as $$
  select encode(extensions.digest(jsonb_build_object(
    'actor_id', p_actor_id,
    'outlet_id', p_outlet_id,
    'reason', nullif(btrim(p_reason), ''),
    'cycle_id', p_cycle_id,
    'expected_version', p_expected_version,
    'lines', coalesce((select jsonb_agg(
      jsonb_build_object(
        'item_id', value->>'item_id',
        'counted_qty', (value->>'counted_qty')::numeric
      ) order by value->>'item_id', (value->>'counted_qty')::numeric
    ) from jsonb_array_elements(p_lines)), '[]'::jsonb)
  )::text, 'sha256'), 'hex')
$$;

create or replace function public.resolve_cycle_opening_reference(p_cycle_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.work_cycles%rowtype;
  r public.cycle_opening_references%rowtype;
  v_source_id uuid;
  v_baseline_id uuid;
  v_source_type text;
  v_warning_code text;
  v_lines jsonb;
  v_missing_item_ids jsonb;
begin
  select * into c from public.work_cycles where id = p_cycle_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;

  select * into r
  from public.cycle_opening_references
  where cycle_id = p_cycle_id and frozen_at is not null
  for share;
  if found then
    select coalesce(jsonb_agg(jsonb_build_object(
      'item_id', item_id, 'reference_qty', reference_qty,
      'source_type', source_type, 'source_id', source_id
    ) order by item_id), '[]'::jsonb)
    into v_lines from public.cycle_opening_reference_lines where reference_id = r.id;
    return jsonb_build_object('state','AVAILABLE','reference_id',r.id,
      'source_type',r.source_type,'source_id',r.source_id,'warning_code',r.warning_code,
      'missing_item_ids','[]'::jsonb,'lines',v_lines);
  end if;

  if c.shift_code = 'MALAM' then
    select handover.id into v_source_id
    from public.stock_handovers handover
    join public.work_cycles source_cycle on source_cycle.id = handover.cycle_id
    where source_cycle.outlet_id = c.outlet_id and source_cycle.work_date = c.work_date
      and source_cycle.shift_code = 'SIANG' and source_cycle.area_code = c.area_code
      and handover.status = 'CONFIRMED'
    order by handover.confirmed_at desc, handover.id desc
    limit 1 for share of handover;
    if v_source_id is not null then v_source_type := 'HANDOVER'; end if;
  end if;

  if v_source_id is null then
    select closing.id into v_source_id
    from public.stock_closings closing
    join public.work_cycles source_cycle on source_cycle.id = closing.cycle_id
    where source_cycle.outlet_id = c.outlet_id and source_cycle.work_date < c.work_date
      and source_cycle.area_code = c.area_code and closing.status = 'CONFIRMED'
    order by source_cycle.work_date desc, closing.confirmed_at desc, closing.id desc
    limit 1 for share of closing;
    if v_source_id is not null then
      v_source_type := 'CLOSING';
      if c.shift_code = 'MALAM' then v_warning_code := 'HANDOVER_MISSING_USING_PRIOR_CLOSING'; end if;
    end if;
  end if;

  select b.id into v_baseline_id
  from public.cycle_physical_baselines b
  where b.cycle_id = p_cycle_id
  for share;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'item_id', item.id,
      'reference_qty', coalesce(source_line.reference_qty, baseline_line.counted_qty),
      'source_type', case
        when source_line.reference_qty is not null then v_source_type
        when baseline_line.counted_qty is not null then 'PHYSICAL_BASELINE'
        else null
      end,
      'source_id', case
        when source_line.reference_qty is not null then v_source_id
        when baseline_line.counted_qty is not null then v_baseline_id
        else null
      end
    ) order by item.id), '[]'::jsonb),
    coalesce(jsonb_agg(to_jsonb(item.id) order by item.id)
      filter (where source_line.reference_qty is null and baseline_line.counted_qty is null), '[]'::jsonb)
  into v_lines, v_missing_item_ids
  from public.items item
  left join lateral (
    select handover_line.system_qty as reference_qty
    from public.stock_handover_lines handover_line
    where v_source_type = 'HANDOVER'
      and handover_line.handover_id = v_source_id
      and handover_line.item_id = item.id
    union all
    select closing_line.counted_qty
    from public.stock_closing_lines closing_line
    where v_source_type = 'CLOSING'
      and closing_line.closing_id = v_source_id
      and closing_line.item_id = item.id
  ) source_line on true
  left join public.cycle_physical_baseline_lines baseline_line
    on baseline_line.baseline_id = v_baseline_id and baseline_line.item_id = item.id
  where item.area_code = c.area_code and item.active is true;

  if v_source_id is null and v_baseline_id is not null then
    v_source_type := 'PHYSICAL_BASELINE';
    v_source_id := v_baseline_id;
  end if;
  return jsonb_build_object(
    'state', case when jsonb_array_length(v_missing_item_ids) > 0 then 'INITIALIZATION_REQUIRED' else 'AVAILABLE' end,
    'reference_id', null,
    'source_type', v_source_type,
    'source_id', v_source_id,
    'warning_code', v_warning_code,
    'missing_item_ids', v_missing_item_ids,
    'lines', v_lines
  );
end;
$$;

create or replace function public.freeze_cycle_opening_reference(p_cycle_id uuid, p_resolved jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.work_cycles%rowtype;
  r_id uuid;
  x jsonb;
  v_expected_count integer;
begin
  select * into c from public.work_cycles where id=p_cycle_id for update;
  if not found then
    raise exception using errcode='P0002', message='NOT_FOUND: Work cycle tidak ditemukan.';
  end if;
  select id into r_id
  from public.cycle_opening_references
  where cycle_id = p_cycle_id and frozen_at is not null
  for share;
  if r_id is not null then
    return r_id;
  end if;
  if jsonb_typeof(p_resolved) is distinct from 'object'
     or p_resolved->>'state' <> 'AVAILABLE'
     or jsonb_typeof(p_resolved->'lines') is distinct from 'array' then
    raise exception using errcode='55000', message='BASELINE_REQUIRED: Semua item aktif harus memiliki referensi sebelum opening dikonfirmasi.';
  end if;
  select count(*) into v_expected_count
  from public.items
  where area_code = c.area_code and active is true;
  if v_expected_count = 0
     or jsonb_array_length(p_resolved->'lines') <> v_expected_count
     or (select count(distinct value->>'item_id') from jsonb_array_elements(p_resolved->'lines')) <> v_expected_count
     or exists (
       select 1
       from jsonb_array_elements(p_resolved->'lines') line
       left join public.items item
         on item.id = line->>'item_id' and item.area_code = c.area_code and item.active is true
       where item.id is null
          or line->>'reference_qty' is null
          or line->>'source_type' not in ('HANDOVER', 'CLOSING', 'PHYSICAL_BASELINE')
          or nullif(line->>'source_id', '') is null
     ) then
    raise exception using errcode='55000', message='INVALID_REFERENCE: Snapshot referensi tidak cocok dengan katalog aktif cycle.';
  end if;
  insert into public.cycle_opening_references(outlet_id,cycle_id,area_code,source_type,source_id,warning_code)
  values(c.outlet_id,p_cycle_id,c.area_code,p_resolved->>'source_type',(p_resolved->>'source_id')::uuid,p_resolved->>'warning_code')
  on conflict(cycle_id) do nothing returning id into r_id;
  if r_id is null then
    raise exception using errcode='55000', message='REFERENCE_CONFLICT: Referensi cycle sedang dibuat oleh transaksi lain.';
  end if;
  for x in select value from jsonb_array_elements(p_resolved->'lines') loop
    insert into public.cycle_opening_reference_lines(reference_id,item_id,reference_qty,source_type,source_id)
    values(r_id,x->>'item_id',(x->>'reference_qty')::numeric,x->>'source_type',(x->>'source_id')::uuid);
  end loop;
  update public.cycle_opening_references
  set frozen_at = clock_timestamp()
  where id = r_id;
  return r_id;
end;
$$;

create or replace function public.rpc_get_cycle_physical_baseline(
  p_actor_id uuid, p_outlet_id uuid, p_cycle_id uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.work_cycles%rowtype; b public.cycle_physical_baselines%rowtype;
begin
  select * into c from public.work_cycles where id=p_cycle_id and outlet_id=p_outlet_id;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND: Cycle tidak ditemukan.'; end if;
  perform public.require_authorized_actor(p_actor_id,p_outlet_id);
  select * into b from public.cycle_physical_baselines where cycle_id=p_cycle_id;
  if not found then return jsonb_build_object('cycle_id',p_cycle_id,'state','REQUIRED','lines','[]'::jsonb); end if;
  return jsonb_build_object('cycle_id',p_cycle_id,'state','AVAILABLE','baseline_id',b.id,
    'lines',coalesce((select jsonb_agg(jsonb_build_object('item_id',item_id,'counted_qty',counted_qty) order by item_id)
      from public.cycle_physical_baseline_lines where baseline_id=b.id),'[]'::jsonb));
end; $$;

create or replace function public.rpc_record_cycle_physical_baseline(
  p_actor_id uuid, p_outlet_id uuid, p_cycle_id uuid, p_expected_version integer,
  p_lines jsonb, p_reason text, p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.work_cycles%rowtype; role public.app_role; b public.cycle_physical_baselines%rowtype;
  x jsonb; resolved jsonb; expected integer; seen integer; fp text; area_scale smallint;
  v_reason text := nullif(btrim(p_reason), '');
  v_response jsonb;
begin
  if p_cycle_id is null or p_actor_id is null or p_outlet_id is null
     or p_expected_version is null or p_expected_version <= 0
     or p_idempotency_key is null or v_reason is null or length(v_reason) > 1000
     or jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception using errcode='22023',message='INVALID_ARGUMENT: Cycle, actor, version, reason, key, dan lines wajib valid.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_lines) line
    where jsonb_typeof(line) <> 'object'
       or not (line ?& array['item_id', 'counted_qty'])
       or jsonb_typeof(line->'item_id') <> 'string'
       or jsonb_typeof(line->'counted_qty') <> 'number'
       or (line->>'counted_qty')::numeric < 0
       or (line->>'counted_qty')::numeric > 9999999999.9999
       or (line->>'counted_qty')::numeric::text in ('NaN','Infinity','-Infinity')
  ) or exists (
    select 1
    from jsonb_array_elements(p_lines) line
    cross join lateral jsonb_object_keys(line) key(name)
    where key.name not in ('item_id', 'counted_qty')
  ) then
    raise exception using errcode='22023',message='INVALID_LINES: counted_qty finite dan non-negatif wajib.';
  end if;
  fp:=public.physical_baseline_fingerprint(
    p_actor_id, p_outlet_id, v_reason, p_cycle_id, p_expected_version, p_lines
  );
  select * into c from public.work_cycles where id=p_cycle_id and outlet_id=p_outlet_id for update;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND: Cycle tidak ditemukan.'; end if;
  role:=public.require_authorized_actor(p_actor_id,p_outlet_id);
  if role::text not in ('OPERATOR','OWNER','SUPERVISOR') then
    raise exception using errcode='42501',message='FORBIDDEN_ROLE: Role tidak diizinkan merekam baseline fisik.';
  end if;
  if role::text not in ('OWNER','SUPERVISOR') and not exists(select 1 from public.work_assignments where cycle_id=p_cycle_id and profile_id=p_actor_id and duty_role='PRIMARY' and status='ACTIVE') then
    raise exception using errcode='42501',message='FORBIDDEN: Owner, Supervisor, atau PRIMARY diperlukan.';
  end if;
  select * into b from public.cycle_physical_baselines where idempotency_key=p_idempotency_key for share;
  if found then
    if b.payload_fingerprint<>fp then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT: Key baseline berbeda payload.'; end if;
    return b.response_json || jsonb_build_object('idempotent_replay',true);
  end if;
  if c.status<>'ACTIVE' then raise exception using errcode='55000',message='INVALID_CYCLE_STATE: Baseline hanya untuk cycle ACTIVE.'; end if;
  if c.version<>p_expected_version then raise exception using errcode='40001',message='VERSION_CONFLICT: Versi cycle sudah berubah.'; end if;
  if exists(select 1 from public.stock_openings where cycle_id=p_cycle_id) then
    raise exception using errcode='55000',message='OPENING_EXISTS: Baseline tidak dapat dibuat setelah opening ada.';
  end if;
  resolved:=public.resolve_cycle_opening_reference(p_cycle_id);
  select count(*) into expected
  from jsonb_array_elements(resolved->'lines') resolved_line
  where resolved_line->>'reference_qty' is null;
  if expected=0 then raise exception using errcode='55000',message='BASELINE_NOT_REQUIRED: Source terpilih sudah memiliki referensi lengkap.'; end if;
  if jsonb_array_length(p_lines)<>expected then raise exception using errcode='22023',message='INCOMPLETE_ITEMS: Baseline wajib memuat tepat item yang belum memiliki referensi.'; end if;
  select count(distinct value->>'item_id') into seen from jsonb_array_elements(p_lines);
  if seen<>expected or exists(
    select 1
    from jsonb_array_elements(p_lines) submitted_line
    where not exists(
      select 1
      from jsonb_array_elements(resolved->'lines') resolved_line
      where resolved_line->>'item_id'=submitted_line->>'item_id'
        and resolved_line->>'reference_qty' is null
    )
  ) then raise exception using errcode='22023',message='INCOMPLETE_ITEMS: Baseline hanya untuk item tanpa referensi dari source terpilih.'; end if;
  for x in select value from jsonb_array_elements(p_lines) loop
    select decimal_scale into area_scale from public.items where id=x->>'item_id';
    if (x->>'counted_qty')::numeric<>round((x->>'counted_qty')::numeric,area_scale) then raise exception using errcode='22023',message=format('INVALID_SCALE: counted_qty item %s tidak sesuai decimal_scale.',x->>'item_id'); end if;
  end loop;
  v_response:=jsonb_build_object(
    'cycle_id',p_cycle_id,
    'baseline_id',gen_random_uuid(),
    'version',c.version
  );
  insert into public.cycle_physical_baselines(
    id,outlet_id,cycle_id,area_code,reason,recorded_by,idempotency_key,payload_fingerprint,response_json
  ) values (
    (v_response->>'baseline_id')::uuid,p_outlet_id,p_cycle_id,c.area_code,v_reason,p_actor_id,
    p_idempotency_key,fp,v_response
  ) returning * into b;
  for x in select value from jsonb_array_elements(p_lines) loop
    insert into public.cycle_physical_baseline_lines(baseline_id,item_id,counted_qty) values(b.id,x->>'item_id',(x->>'counted_qty')::numeric);
  end loop;
  select jsonb_set(
    jsonb_set(
      jsonb_set(
        resolved,
        '{lines}',
        coalesce((
          select jsonb_agg(
            case when line->>'reference_qty' is null then
              jsonb_build_object(
                'item_id', line->>'item_id',
                'reference_qty', baseline_line.value->'counted_qty',
                'source_type', 'PHYSICAL_BASELINE',
                'source_id', b.id
              )
            else line end
            order by line->>'item_id'
          )
          from jsonb_array_elements(resolved->'lines') line
          left join lateral (
            select value
            from jsonb_array_elements(p_lines)
            where value->>'item_id' = line->>'item_id'
          ) baseline_line on true
        ), '[]'::jsonb)
      ),
      '{state}', '"AVAILABLE"'::jsonb
    ),
    '{missing_item_ids}', '[]'::jsonb
  ) into resolved;
  if resolved->>'source_id' is null then
    resolved:=jsonb_set(jsonb_set(resolved,'{source_type}','"PHYSICAL_BASELINE"'::jsonb),'{source_id}',to_jsonb(b.id));
  end if;
  perform public.freeze_cycle_opening_reference(p_cycle_id,resolved);
  perform public.log_audit_event(p_actor_id,'RECORD_PHYSICAL_BASELINE','cycle_physical_baselines',b.id::text,p_outlet_id,null,null,jsonb_build_object('cycle_id',p_cycle_id,'lines_count',expected));
  return v_response || jsonb_build_object('idempotent_replay',false);
end; $$;

-- Current API still calls this legacy five-argument function. Keep the exact
-- signature but fail closed: it cannot receive a physical counted_qty payload.
create or replace function public.rpc_initialize_stock_reference(p_cycle_id uuid,p_actor_id uuid,p_expected_cycle_version integer,p_idempotency_key uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception using errcode='55000',message='BASELINE_REQUIRED: Gunakan physical baseline dengan counted_qty; zero initialization dinonaktifkan.'; end; $$;

-- Opening reference remains the legacy RPC contract. It uses handover/closing
-- first and fills only missing new items from the explicit physical baseline.
create or replace function public.rpc_get_opening_reference(p_cycle_id uuid,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.work_cycles%rowtype; result jsonb;
begin
  select * into c from public.work_cycles where id=p_cycle_id;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND: Work cycle tidak ditemukan.'; end if;
  perform public.require_authorized_actor(p_actor_id,c.outlet_id);
  result:=public.resolve_cycle_opening_reference(p_cycle_id);
  return result;
end; $$;

-- Preserve the 0010 command contract and validation while freezing the one
-- resolved source selection, including per-line baseline provenance.
create or replace function public.rpc_confirm_opening(p_cycle_id uuid,p_actor_id uuid,p_lines jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  c public.work_cycles%rowtype;
  role public.app_role;
  opening_id uuid;
  existing_id uuid;
  expected integer;
  x jsonb;
  v_item_id text;
  qty numeric;
  ref numeric;
  variance numeric;
  reason text;
  notes text;
  line_source_type text;
  resolved jsonb;
  ref_snapshot_id uuid;
  resulting_cycle_version integer;
  item_scale smallint;
begin
  if p_cycle_id is null or p_actor_id is null then
    raise exception using errcode='22023',message='INVALID_ARGUMENT: Cycle dan actor wajib diisi.';
  end if;
  select * into c from public.work_cycles where id=p_cycle_id for update;
  if not found then
    raise exception using errcode='P0002',message='NOT_FOUND: Work cycle tidak ditemukan.';
  end if;
  role:=public.require_authorized_actor(p_actor_id,c.outlet_id);
  if role::text not in ('OPERATOR','OWNER','SUPERVISOR') then
    raise exception using errcode='42501',message='FORBIDDEN_ROLE: Role tidak diizinkan mengonfirmasi opening.';
  end if;
  if c.status<>'ACTIVE' then
    raise exception using errcode='55000',message='INVALID_CYCLE_STATE: Opening hanya dapat dikonfirmasi pada cycle ACTIVE.';
  end if;
  if role::text not in ('OWNER','SUPERVISOR') and not exists(
    select 1 from public.work_assignments
    where cycle_id=p_cycle_id and profile_id=p_actor_id
      and duty_role='PRIMARY' and status='ACTIVE'
  ) then
    raise exception using errcode='42501',message='FORBIDDEN: Opening memerlukan primary cycle atau manager dengan scope outlet.';
  end if;
  select id into existing_id from public.stock_openings where cycle_id=p_cycle_id for update;
  if existing_id is not null then
    raise exception using errcode='55000',message='OPENING_EXISTS: Opening tidak dapat ditimpa.';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception using errcode='22023',message='INVALID_LINES: p_lines wajib berupa array JSON.';
  end if;
  if exists(
    select 1 from jsonb_array_elements(p_lines) line
    where jsonb_typeof(line)<>'object'
       or not(line ? 'item_id') or not(line ? 'counted_qty')
       or jsonb_typeof(line->'item_id')<>'string'
       or jsonb_typeof(line->'counted_qty')<>'number'
       or (line ? 'reason_code' and jsonb_typeof(line->'reason_code') not in ('string','null'))
       or (line ? 'notes' and jsonb_typeof(line->'notes') not in ('string','null'))
       or (line->>'counted_qty')::numeric<0
       or (line->>'counted_qty')::numeric>9999999999.9999
       or (line->>'counted_qty')::numeric::text in ('NaN','Infinity','-Infinity')
       or length(coalesce(nullif(btrim(line->>'reason_code'),''),''))>64
       or length(coalesce(nullif(btrim(line->>'notes'),''),''))>1000
  ) then
    raise exception using errcode='22023',message='INVALID_LINES: Item, counted_qty numeric(14,4), reason, dan notes wajib valid.';
  end if;
  if exists(
    select 1 from jsonb_array_elements(p_lines) line
    cross join lateral jsonb_object_keys(line) as key(key_name)
    where key.key_name not in ('item_id','counted_qty','reason_code','notes')
  ) then
    raise exception using errcode='22023',message='INVALID_LINES: p_lines memuat field yang tidak diizinkan.';
  end if;
  select count(*) into expected from public.items where area_code=c.area_code and active;
  if expected=0
     or jsonb_array_length(p_lines)<>expected
     or (select count(distinct line->>'item_id') from jsonb_array_elements(p_lines) line)<>expected
     or exists(
       select 1 from jsonb_array_elements(p_lines) line
       left join public.items item
         on item.id=line->>'item_id' and item.area_code=c.area_code and item.active
       where item.id is null
     ) then
    raise exception using errcode='22023',message='INCOMPLETE_ITEMS: Wajib tepat satu baris untuk setiap item aktif di area cycle.';
  end if;
  resolved:=public.resolve_cycle_opening_reference(p_cycle_id);
  if resolved->>'state'<>'AVAILABLE' then
    raise exception using errcode='55000',message='REFERENCE_NOT_FOUND: Snapshot referensi opening tidak lengkap; baseline fisik cycle ini diperlukan.';
  end if;
  ref_snapshot_id:=public.freeze_cycle_opening_reference(p_cycle_id,resolved);
  insert into public.stock_openings(cycle_id,status,reference_source_type,reference_source_id) values(p_cycle_id,'DRAFT',resolved->>'source_type',(resolved->>'source_id')::uuid) returning id into opening_id;
  for x in select value from jsonb_array_elements(p_lines) loop
    v_item_id:=x->>'item_id';
    qty:=(x->>'counted_qty')::numeric;
    reason:=nullif(btrim(x->>'reason_code'),'');
    notes:=nullif(btrim(x->>'notes'),'');
    select decimal_scale into item_scale from public.items where id=v_item_id;
    if qty<>round(qty,item_scale) then
      raise exception using errcode='22023',message=format('INVALID_SCALE: counted_qty item %s tidak sesuai decimal_scale.',v_item_id);
    end if;
    select reference_qty,source_type into ref,line_source_type
    from public.cycle_opening_reference_lines reference_line
    where reference_line.reference_id=ref_snapshot_id and reference_line.item_id=v_item_id;
    if ref is null or ref<0 then
      raise exception using errcode='55000',message=format('INVALID_REFERENCE: Referensi item %s hilang atau negatif.',v_item_id);
    end if;
    variance:=qty-ref;
    if variance<>0 and reason is null then
      raise exception using errcode='22023',message=format('VARIANCE_CATEGORY_REQUIRED: Item %s memiliki selisih dan wajib memilih kategori alasan.',v_item_id);
    end if;
    if reason is not null and reason not in (
      'INITIAL_STOCK_COUNT','COUNTING_ERROR','SPILLAGE_UNRECORDED',
      'WASTE_UNRECORDED','OVER_PORTIONING','OTHER'
    ) then
      raise exception using errcode='22023',message=format('INVALID_VARIANCE_CATEGORY: Kategori item %s tidak diizinkan.',v_item_id);
    end if;
    if reason='INITIAL_STOCK_COUNT' and line_source_type<>'PHYSICAL_BASELINE' then
      raise exception using errcode='22023',message=format('INVALID_VARIANCE_CATEGORY: INITIAL_STOCK_COUNT hanya untuk baseline fisik item %s.',v_item_id);
    end if;
    insert into public.stock_opening_lines(opening_id,item_id,reference_qty,counted_qty,variance_qty,reason_code,notes,updated_by) values(opening_id,v_item_id,ref,qty,variance,reason,notes,p_actor_id);
  end loop;
  update public.stock_openings set status='CONFIRMED',confirmed_at=clock_timestamp(),confirmed_by=p_actor_id,version=version+1,updated_at=clock_timestamp() where id=opening_id;
  update public.work_cycles set status='OPEN',version=version+1,updated_at=clock_timestamp()
  where id=p_cycle_id returning version into resulting_cycle_version;
  perform public.log_audit_event(
    p_actor_id,'CONFIRM_OPENING','stock_openings',opening_id::text,c.outlet_id,null,null,
    jsonb_build_object(
      'cycle_id',p_cycle_id,
      'reference_id',ref_snapshot_id,
      'reference_source_type',resolved->>'source_type',
      'reference_source_id',(resolved->>'source_id')::uuid,
      'warning_code',resolved->>'warning_code',
      'lines_count',expected
    )
  );
  return jsonb_build_object(
    'opening_id',opening_id,
    'status','CONFIRMED',
    'reference_id',ref_snapshot_id,
    'reference_source_type',resolved->>'source_type',
    'reference_source_id',(resolved->>'source_id')::uuid,
    'warning_code',resolved->>'warning_code',
    'cycle_version',resulting_cycle_version
  );
end; $$;

-- Closing lines retain the catalog metadata that existed when the physical
-- closing was captured. Nullable columns preserve historical rows.
alter table public.stock_closing_lines
  add column if not exists item_name_snapshot text,
  add column if not exists unit_code_snapshot text,
  add column if not exists decimal_scale_snapshot smallint,
  add column if not exists low_threshold_snapshot numeric(14,4);

comment on column public.stock_closing_lines.item_name_snapshot is
  'Item name captured when the closing line is inserted.';
comment on column public.stock_closing_lines.unit_code_snapshot is
  'Item unit captured when the closing line is inserted.';
comment on column public.stock_closing_lines.decimal_scale_snapshot is
  'Item decimal scale captured when the closing line is inserted.';
comment on column public.stock_closing_lines.low_threshold_snapshot is
  'Item low-stock threshold captured when the closing line is inserted.';

create or replace function public.populate_stock_closing_line_metadata_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select item.name, item.unit_code, item.decimal_scale, item.low_threshold
  into new.item_name_snapshot, new.unit_code_snapshot,
       new.decimal_scale_snapshot, new.low_threshold_snapshot
  from public.items item
  where item.id = new.item_id;
  if not found then
    raise exception using errcode='23503', message=format('ITEM_NOT_FOUND: Item %s tidak ditemukan.',new.item_id);
  end if;
  return new;
end;
$$;

drop trigger if exists stock_closing_lines_metadata_snapshot on public.stock_closing_lines;
create trigger stock_closing_lines_metadata_snapshot
before insert on public.stock_closing_lines
for each row execute function public.populate_stock_closing_line_metadata_snapshot();

-- Daily report stock rows retain the metadata captured by the selected closing
-- lines. Nullable columns preserve the legacy table shape for historical rows.
alter table public.daily_report_stock_lines
  add column if not exists item_name_snapshot text,
  add column if not exists unit_code_snapshot text,
  add column if not exists decimal_scale_snapshot smallint;

comment on column public.daily_report_stock_lines.item_name_snapshot is
  'Item name copied from the immutable closing line snapshot.';
comment on column public.daily_report_stock_lines.unit_code_snapshot is
  'Item unit copied from the immutable closing line snapshot.';
comment on column public.daily_report_stock_lines.decimal_scale_snapshot is
  'Item decimal scale copied from the immutable closing line snapshot.';

-- Preserve the exact legacy report command contract and all authorization,
-- state, idempotency-shaped report, finance, closing, audit, and result rules.
-- The stock source is deliberately limited to the two resolved immutable
-- closings. Archived or newly promoted catalog rows cannot change membership.
create or replace function public.rpc_submit_daily_report(
  p_outlet_id uuid,
  p_work_date date,
  p_actor_id uuid,
  p_finance jsonb,
  p_checksum text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_outlet_code text;
  v_report public.daily_reports%rowtype;
  v_bar_closing_id uuid;
  v_kitchen_closing_id uuid;
  v_bar_cutoff timestamptz;
  v_kitchen_cutoff timestamptz;
  v_closing_count integer;
  v_expected_count integer;
  v_revision integer;
  v_revision_id uuid;
  v_public_id text;
  v_cash_real numeric;
  v_cash_app numeric;
  v_qris numeric;
  v_debit numeric;
  v_recorded_total numeric;
  v_received_total numeric;
  v_cash_difference numeric;
  v_handover_ids jsonb;
  v_total_item_count integer;
  v_inserted_count integer;
begin
  if p_work_date is null or nullif(btrim(p_checksum), '') is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Tanggal dan checksum wajib diisi.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan mengirim laporan.';
  end if;

  select code into v_outlet_code from public.outlets where id = p_outlet_id and active is true;
  if v_outlet_code is null then
    raise exception using errcode = '22023', message = 'INVALID_OUTLET: Outlet tidak aktif atau tidak ditemukan.';
  end if;

  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where cycle.outlet_id = p_outlet_id
      and cycle.work_date = p_work_date
      and cycle.area_code = 'BAR'
      and cycle.shift_code in ('MALAM', 'FULL')
      and assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY'
      and assignment.status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Submit memerlukan primary BAR MALAM/FULL atau manager dengan scope outlet.';
  end if;

  select count(*) into v_closing_count
  from public.stock_closings closing
  join public.work_cycles cycle on cycle.id = closing.cycle_id
  where cycle.outlet_id = p_outlet_id
    and cycle.work_date = p_work_date
    and cycle.shift_code in ('MALAM', 'FULL')
    and cycle.area_code = 'BAR'
    and cycle.status = 'CLOSING_READY'
    and closing.status = 'CONFIRMED';
  if v_closing_count <> 1 then
    raise exception using errcode = '55000', message = 'BAR_CLOSING_INVALID: Wajib tepat satu closing BAR MALAM/FULL terkonfirmasi.';
  end if;

  select closing.id, closing.movement_cutoff_at
    into v_bar_closing_id, v_bar_cutoff
  from public.stock_closings closing
  join public.work_cycles cycle on cycle.id = closing.cycle_id
  where cycle.outlet_id = p_outlet_id
    and cycle.work_date = p_work_date
    and cycle.shift_code in ('MALAM', 'FULL')
    and cycle.area_code = 'BAR'
    and cycle.status = 'CLOSING_READY'
    and closing.status = 'CONFIRMED'
  for share of closing;

  select count(*) into v_closing_count
  from public.stock_closings closing
  join public.work_cycles cycle on cycle.id = closing.cycle_id
  where cycle.outlet_id = p_outlet_id
    and cycle.work_date = p_work_date
    and cycle.shift_code in ('MALAM', 'FULL')
    and cycle.area_code = 'KITCHEN'
    and cycle.status = 'CLOSING_READY'
    and closing.status = 'CONFIRMED';
  if v_closing_count <> 1 then
    raise exception using errcode = '55000', message = 'KITCHEN_CLOSING_INVALID: Wajib tepat satu closing KITCHEN MALAM/FULL terkonfirmasi.';
  end if;

  select closing.id, closing.movement_cutoff_at
    into v_kitchen_closing_id, v_kitchen_cutoff
  from public.stock_closings closing
  join public.work_cycles cycle on cycle.id = closing.cycle_id
  where cycle.outlet_id = p_outlet_id
    and cycle.work_date = p_work_date
    and cycle.shift_code in ('MALAM', 'FULL')
    and cycle.area_code = 'KITCHEN'
    and cycle.status = 'CLOSING_READY'
    and closing.status = 'CONFIRMED'
  for share of closing;

  -- Closing line membership and metadata snapshots are authoritative. Mutable
  -- catalog rows are intentionally not consulted after closing confirmation.
  select count(*) into v_expected_count
  from public.stock_closing_lines
  where closing_id = v_bar_closing_id;
  if v_expected_count = 0
     or exists (
       select 1
       from public.stock_closing_lines line
       where line.closing_id = v_bar_closing_id
         and (line.item_name_snapshot is null
           or line.unit_code_snapshot is null
           or line.decimal_scale_snapshot is null
           or line.low_threshold_snapshot is null)
     ) then
    raise exception using errcode = '55000', message = 'BAR_CLOSING_INCOMPLETE: Closing BAR tidak memuat tepat semua item referensi closing.';
  end if;
  v_total_item_count := v_expected_count;

  select count(*) into v_expected_count
  from public.stock_closing_lines
  where closing_id = v_kitchen_closing_id;
  if v_expected_count = 0
     or exists (
       select 1
       from public.stock_closing_lines line
       where line.closing_id = v_kitchen_closing_id
         and (line.item_name_snapshot is null
           or line.unit_code_snapshot is null
           or line.decimal_scale_snapshot is null
           or line.low_threshold_snapshot is null)
     ) then
    raise exception using errcode = '55000', message = 'KITCHEN_CLOSING_INCOMPLETE: Closing KITCHEN tidak memuat tepat semua item referensi closing.';
  end if;
  v_total_item_count := v_total_item_count + v_expected_count;

  if jsonb_typeof(p_finance) is distinct from 'object'
     or not (p_finance ?& array['cash_real', 'cash_app', 'qris_mandiri', 'debit_mandiri'])
     or exists (
       select 1 from jsonb_object_keys(p_finance) as object_key(key_name)
       where key_name not in ('cash_real', 'cash_app', 'qris_mandiri', 'debit_mandiri')
     )
     or jsonb_typeof(p_finance->'cash_real') <> 'number'
     or jsonb_typeof(p_finance->'cash_app') <> 'number'
     or jsonb_typeof(p_finance->'qris_mandiri') <> 'number'
     or jsonb_typeof(p_finance->'debit_mandiri') <> 'number' then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE: Empat field finance numerik wajib diisi tanpa field tambahan.';
  end if;

  v_cash_real := (p_finance->>'cash_real')::numeric;
  v_cash_app := (p_finance->>'cash_app')::numeric;
  v_qris := (p_finance->>'qris_mandiri')::numeric;
  v_debit := (p_finance->>'debit_mandiri')::numeric;

  if v_cash_real < 0 or v_cash_app < 0 or v_qris < 0 or v_debit < 0
     or trunc(v_cash_real) <> v_cash_real
     or trunc(v_cash_app) <> v_cash_app
     or trunc(v_qris) <> v_qris
     or trunc(v_debit) <> v_debit
     or v_cash_real::text in ('NaN', 'Infinity', '-Infinity')
     or v_cash_app::text in ('NaN', 'Infinity', '-Infinity')
     or v_qris::text in ('NaN', 'Infinity', '-Infinity')
     or v_debit::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE: Semua nilai finance wajib whole dan nonnegative.';
  end if;

  insert into public.daily_reports (outlet_id, work_date, status, current_revision)
  values (p_outlet_id, p_work_date, 'DRAFT', 0)
  on conflict (outlet_id, work_date) do nothing;

  select * into v_report
  from public.daily_reports
  where outlet_id = p_outlet_id and work_date = p_work_date
  for update;

  if v_report.status not in ('DRAFT', 'NEEDS_CLARIFICATION') then
    raise exception using errcode = '55000', message = 'INVALID_REPORT_STATE: Hanya DRAFT atau NEEDS_CLARIFICATION yang dapat disubmit.';
  end if;

  v_revision := v_report.current_revision + 1;
  v_public_id := upper(v_outlet_code) || '-' || to_char(p_work_date, 'YYYYMMDD') || '-R' || lpad(v_revision::text, 2, '0');
  v_recorded_total := v_cash_app + v_qris + v_debit;
  v_received_total := v_cash_real + v_qris + v_debit;
  v_cash_difference := v_cash_real - v_cash_app;

  select coalesce(jsonb_agg(handover.id order by cycle.area_code), '[]'::jsonb)
    into v_handover_ids
  from public.stock_handovers handover
  join public.work_cycles cycle on cycle.id = handover.cycle_id
  where cycle.outlet_id = p_outlet_id
    and cycle.work_date = p_work_date
    and cycle.shift_code = 'SIANG'
    and handover.status = 'CONFIRMED';

  insert into public.daily_report_revisions (
    report_id, revision, public_id, status, bar_closing_id, kitchen_closing_id,
    handover_ids, movement_cutoff_at, submitted_by, submitted_at, payload_checksum
  ) values (
    v_report.id, v_revision, v_public_id, 'SUBMITTED', v_bar_closing_id, v_kitchen_closing_id,
    v_handover_ids, greatest(v_bar_cutoff, v_kitchen_cutoff), p_actor_id, clock_timestamp(), btrim(p_checksum)
  ) returning id into v_revision_id;

  insert into public.daily_report_finance (
    revision_id, cash_real, cash_app, qris_mandiri, debit_mandiri,
    recorded_total, received_total, cash_difference
  ) values (
    v_revision_id, v_cash_real, v_cash_app, v_qris, v_debit,
    v_recorded_total, v_received_total, v_cash_difference
  );

  insert into public.daily_report_stock_lines (
    revision_id, item_id, area_code, closing_qty, low_threshold_snapshot, stock_status,
    item_name_snapshot, unit_code_snapshot, decimal_scale_snapshot
  )
  select
    v_revision_id,
    line.item_id,
    source.area_code,
    line.counted_qty,
    line.low_threshold_snapshot,
    case
      when line.counted_qty = 0 then 'HABIS'
      when line.counted_qty <= line.low_threshold_snapshot then 'HAMPIR_HABIS'
      else 'AMAN'
    end,
    line.item_name_snapshot,
    line.unit_code_snapshot,
    line.decimal_scale_snapshot
  from public.stock_closing_lines line
  join (values
    (v_bar_closing_id, 'BAR'::public.area_code),
    (v_kitchen_closing_id, 'KITCHEN'::public.area_code)
  ) source(closing_id, area_code) on source.closing_id = line.closing_id;

  get diagnostics v_inserted_count = row_count;
  if v_inserted_count <> v_total_item_count then
    raise exception using errcode = '55000', message = 'INCOMPLETE_REPORT_STOCK: Snapshot laporan tidak memuat semua item aktual.';
  end if;

  update public.daily_reports
  set status = 'SUBMITTED', current_revision = v_revision,
      version = version + 1, updated_at = clock_timestamp()
  where id = v_report.id;

  perform public.log_audit_event(
    p_actor_id, 'SUBMIT_DAILY_REPORT', 'daily_report_revisions', v_revision_id::text,
    p_outlet_id, null, null,
    jsonb_build_object(
      'public_id', v_public_id,
      'revision', v_revision,
      'recorded_total', v_recorded_total,
      'received_total', v_received_total,
      'cash_difference', v_cash_difference
    )
  );

  return jsonb_build_object(
    'report_id', v_report.id,
    'revision_id', v_revision_id,
    'public_id', v_public_id,
    'status', 'SUBMITTED'
  );
end;
$$;

revoke execute on function public.reject_cycle_opening_reference_change() from public, anon, authenticated;
revoke execute on function public.reject_frozen_cycle_opening_reference_line_change() from public, anon, authenticated;
revoke execute on function public.physical_baseline_fingerprint(uuid, uuid, text, uuid, integer, jsonb) from public, anon, authenticated;
revoke execute on function public.resolve_cycle_opening_reference(uuid) from public, anon, authenticated;
revoke execute on function public.freeze_cycle_opening_reference(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.rpc_get_cycle_physical_baseline(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_record_cycle_physical_baseline(uuid, uuid, uuid, integer, jsonb, text, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_initialize_stock_reference(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
revoke execute on function public.rpc_get_opening_reference(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_confirm_opening(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.populate_stock_closing_line_metadata_snapshot() from public, anon, authenticated;
revoke execute on function public.rpc_submit_daily_report(uuid, date, uuid, jsonb, text) from public, anon, authenticated;

grant execute on function public.reject_cycle_opening_reference_change() to service_role;
grant execute on function public.reject_frozen_cycle_opening_reference_line_change() to service_role;
grant execute on function public.physical_baseline_fingerprint(uuid, uuid, text, uuid, integer, jsonb) to service_role;
grant execute on function public.resolve_cycle_opening_reference(uuid) to service_role;
grant execute on function public.freeze_cycle_opening_reference(uuid, jsonb) to service_role;
grant execute on function public.rpc_get_cycle_physical_baseline(uuid, uuid, uuid) to service_role;
grant execute on function public.rpc_record_cycle_physical_baseline(uuid, uuid, uuid, integer, jsonb, text, uuid) to service_role;
grant execute on function public.rpc_initialize_stock_reference(uuid, uuid, integer, uuid, text) to service_role;
grant execute on function public.rpc_get_opening_reference(uuid, uuid) to service_role;
grant execute on function public.rpc_confirm_opening(uuid, uuid, jsonb) to service_role;
grant execute on function public.populate_stock_closing_line_metadata_snapshot() to service_role;
grant execute on function public.rpc_submit_daily_report(uuid, date, uuid, jsonb, text) to service_role;
