-- Management stock workflow: direct Bar/Kitchen readiness plus auditable pre-opening corrections.

create table if not exists public.cycle_physical_baseline_corrections (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  cycle_id uuid not null references public.work_cycles(id) on delete restrict,
  baseline_id uuid not null references public.cycle_physical_baselines(id) on delete restrict,
  corrected_by uuid not null references public.profiles(id) on delete restrict,
  reason text not null check (nullif(btrim(reason), '') is not null and length(reason) <= 1000),
  idempotency_key uuid not null unique,
  payload_fingerprint text not null,
  before_lines jsonb not null,
  after_lines jsonb not null,
  response_json jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.cycle_physical_baseline_corrections enable row level security;
revoke all on public.cycle_physical_baseline_corrections from public, anon, authenticated;
grant all on public.cycle_physical_baseline_corrections to service_role;
drop trigger if exists cycle_physical_baseline_corrections_append_only on public.cycle_physical_baseline_corrections;
create trigger cycle_physical_baseline_corrections_append_only
before update or delete on public.cycle_physical_baseline_corrections
for each row execute function public.enforce_append_only();

create or replace function public.reject_frozen_cycle_opening_reference_line_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_frozen_at timestamptz;
begin
  if current_setting('app.allow_baseline_correction', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    select frozen_at into v_frozen_at from public.cycle_opening_references where id = new.reference_id;
    if v_frozen_at is null then return new; end if;
  end if;
  raise exception using errcode='55000', message='IMMUTABLE_REFERENCE: Baris referensi opening cycle tidak dapat dimutasi setelah dibekukan.';
end;
$$;

create or replace function public.reject_cycle_baseline_line_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if current_setting('app.allow_baseline_correction', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception using errcode='55000', message='APPEND_ONLY: cycle_physical_baseline_lines tidak boleh diubah atau dihapus.';
end;
$$;
drop trigger if exists cycle_physical_baseline_lines_append_only on public.cycle_physical_baseline_lines;
create trigger cycle_physical_baseline_lines_append_only
before update or delete on public.cycle_physical_baseline_lines
for each row execute function public.reject_cycle_baseline_line_change();

create or replace function public.rpc_get_management_stock_readiness(
  p_actor_id uuid, p_outlet_id uuid, p_work_date date
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  role public.app_role;
  c record;
  resolved jsonb;
  rows jsonb := '[]'::jsonb;
  primary_name text;
  opening_exists boolean;
  physical_baseline_id uuid;
begin
  role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if role::text not in ('OWNER','SUPERVISOR') then
    raise exception using errcode='42501', message='FORBIDDEN: Manajemen diperlukan.';
  end if;
  for c in
    select * from public.work_cycles
    where outlet_id=p_outlet_id and work_date=p_work_date and area_code in ('BAR','KITCHEN')
    order by area_code, shift_code
  loop
    select p.display_name into primary_name
    from public.work_assignments a join public.profiles p on p.id=a.profile_id
    where a.cycle_id=c.id and a.duty_role='PRIMARY' and a.status='ACTIVE'
    order by a.assigned_at limit 1;
    select exists(select 1 from public.stock_openings where cycle_id=c.id) into opening_exists;
    select id into physical_baseline_id from public.cycle_physical_baselines where cycle_id=c.id;
    resolved := public.resolve_cycle_opening_reference(c.id);
    rows := rows || jsonb_build_array(jsonb_build_object(
      'cycle_id', c.id,
      'work_date', c.work_date,
      'shift_code', c.shift_code,
      'area_code', c.area_code,
      'cycle_status', c.status,
      'version', c.version,
      'primary_name', primary_name,
      'opening_exists', opening_exists,
      'physical_baseline_id', physical_baseline_id,
      'reference_state', resolved->>'state',
      'reference_source_type', resolved->>'source_type',
      'missing_item_ids', coalesce(resolved->'missing_item_ids','[]'::jsonb),
      'lines', coalesce((
              select jsonb_agg(line.value || jsonb_build_object('item_name',item.name,'unit_code',item.unit_code,'low_threshold',item.low_threshold) order by item.name)
              from jsonb_array_elements(resolved->'lines') line
              join public.items item on item.id=line.value->>'item_id'
            ),'[]'::jsonb)
    ));
  end loop;
  return jsonb_build_object('work_date',p_work_date,'cycles',rows);
end;
$$;

create or replace function public.rpc_correct_cycle_physical_baseline(
  p_actor_id uuid, p_outlet_id uuid, p_cycle_id uuid, p_expected_version integer,
  p_lines jsonb, p_reason text, p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  c public.work_cycles%rowtype;
  role public.app_role;
  b public.cycle_physical_baselines%rowtype;
  previous_lines jsonb;
  fp text;
  existing public.cycle_physical_baseline_corrections%rowtype;
  x jsonb;
  expected integer;
  seen integer;
  scale smallint;
  response jsonb;
begin
  if p_cycle_id is null or p_actor_id is null or p_outlet_id is null or p_expected_version is null
    or p_expected_version <= 0 or p_idempotency_key is null or nullif(btrim(p_reason),'') is null
    or length(btrim(p_reason)) > 1000 or jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception using errcode='22023',message='INVALID_ARGUMENT: Cycle, version, lines, reason, dan key wajib valid.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) line where jsonb_typeof(line) <> 'object'
    or not (line ?& array['item_id','counted_qty']) or jsonb_typeof(line->'item_id') <> 'string'
    or jsonb_typeof(line->'counted_qty') <> 'number' or (line->>'counted_qty')::numeric < 0
    or (line->>'counted_qty')::numeric > 9999999999.9999)
    or exists (select 1 from jsonb_array_elements(p_lines) line cross join lateral jsonb_object_keys(line) k(name) where k.name not in ('item_id','counted_qty')) then
    raise exception using errcode='22023',message='INVALID_LINES: counted_qty finite dan non-negatif wajib.';
  end if;
  role := public.require_authorized_actor(p_actor_id,p_outlet_id);
  if role::text not in ('OWNER','SUPERVISOR') then raise exception using errcode='42501',message='FORBIDDEN: Manajemen diperlukan.'; end if;
  select * into c from public.work_cycles where id=p_cycle_id and outlet_id=p_outlet_id for update;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND: Cycle tidak ditemukan.'; end if;
  if c.version <> p_expected_version then raise exception using errcode='40001',message='VERSION_CONFLICT: Versi cycle sudah berubah.'; end if;
  if exists(select 1 from public.stock_openings where cycle_id=p_cycle_id) then
    raise exception using errcode='55000',message='OPENING_EXISTS: Baseline tidak dapat dikoreksi setelah opening dikonfirmasi. Gunakan koreksi ledger.';
  end if;
  select * into b from public.cycle_physical_baselines where cycle_id=p_cycle_id for update;
  if not found then raise exception using errcode='P0002',message='BASELINE_NOT_FOUND: Baseline fisik belum ada.'; end if;
  fp := public.physical_baseline_fingerprint(p_actor_id,p_outlet_id,btrim(p_reason),p_cycle_id,p_expected_version,p_lines);
  select * into existing from public.cycle_physical_baseline_corrections where idempotency_key=p_idempotency_key for share;
  if found then
    if existing.payload_fingerprint <> fp then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT: Key koreksi berbeda payload.'; end if;
    return existing.response_json || jsonb_build_object('idempotent_replay',true);
  end if;
  select count(*) into expected from public.items where area_code=c.area_code and active;
  select count(distinct value->>'item_id') into seen from jsonb_array_elements(p_lines);
  if jsonb_array_length(p_lines) <> expected or seen <> expected or exists(select 1 from jsonb_array_elements(p_lines) line where not exists(select 1 from public.items i where i.id=line->>'item_id' and i.area_code=c.area_code and i.active)) then
    raise exception using errcode='22023',message='INCOMPLETE_ITEMS: Koreksi wajib memuat tepat satu baris untuk setiap item aktif area cycle.';
  end if;
  for x in select value from jsonb_array_elements(p_lines) loop
    select decimal_scale into scale from public.items where id=x->>'item_id';
    if (x->>'counted_qty')::numeric <> round((x->>'counted_qty')::numeric,scale) then raise exception using errcode='22023',message='INVALID_SCALE: Jumlah tidak sesuai ketelitian item.'; end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('item_id',item_id,'counted_qty',counted_qty) order by item_id),'[]'::jsonb) into previous_lines from public.cycle_physical_baseline_lines where baseline_id=b.id;
  response := jsonb_build_object('cycle_id',p_cycle_id,'baseline_id',b.id,'version',c.version);
  insert into public.cycle_physical_baseline_corrections(outlet_id,cycle_id,baseline_id,corrected_by,reason,idempotency_key,payload_fingerprint,before_lines,after_lines,response_json)
  values(p_outlet_id,p_cycle_id,b.id,p_actor_id,btrim(p_reason),p_idempotency_key,fp,previous_lines,p_lines,response);
  perform set_config('app.allow_baseline_correction','on',true);
  delete from public.cycle_physical_baseline_lines where baseline_id=b.id;
  for x in select value from jsonb_array_elements(p_lines) loop
    insert into public.cycle_physical_baseline_lines(baseline_id,item_id,counted_qty) values(b.id,x->>'item_id',(x->>'counted_qty')::numeric);
  end loop;
  update public.cycle_opening_reference_lines ref
  set reference_qty=line.value::numeric
  from public.cycle_opening_references r,
    jsonb_each_text((select jsonb_object_agg(value->>'item_id',value->>'counted_qty') from jsonb_array_elements(p_lines))) line
  where r.id=ref.reference_id and r.cycle_id=p_cycle_id
    and ref.item_id=line.key and ref.source_type='PHYSICAL_BASELINE';
  perform public.log_audit_event(p_actor_id,'CORRECT_PHYSICAL_BASELINE','cycle_physical_baseline_corrections',p_idempotency_key::text,p_outlet_id,null,previous_lines,p_lines,btrim(p_reason));
  return response || jsonb_build_object('idempotent_replay',false);
end;
$$;

revoke execute on function public.reject_frozen_cycle_opening_reference_line_change() from public, anon, authenticated;
revoke execute on function public.reject_cycle_baseline_line_change() from public, anon, authenticated;
revoke execute on function public.rpc_get_management_stock_readiness(uuid,uuid,date) from public, anon, authenticated;
revoke execute on function public.rpc_correct_cycle_physical_baseline(uuid,uuid,uuid,integer,jsonb,text,uuid) from public, anon,authenticated;
grant execute on function public.reject_frozen_cycle_opening_reference_line_change() to service_role;
grant execute on function public.reject_cycle_baseline_line_change() to service_role;
grant execute on function public.rpc_get_management_stock_readiness(uuid,uuid,date) to service_role;
grant execute on function public.rpc_correct_cycle_physical_baseline(uuid,uuid,uuid,integer,jsonb,text,uuid) to service_role;
