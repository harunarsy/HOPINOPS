-- ---------------------------------------------------------------------------
-- 0039. Kategori alasan selisih pada closing stok menjadi opsional.
--
-- Sebelumnya rpc_confirm_closing menolak baris yang memiliki selisih
-- (variance_qty <> 0) tanpa reason_code lewat VARIANCE_CATEGORY_REQUIRED.
-- Operasional meminta kategori alasan tidak lagi wajib diisi saat stok akhir
-- sehingga penanggung jawab dapat mengonfirmasi closing walau kategori kosong.
--
-- reason_code dan notes tetap tersimpan apa adanya (nullable); hanya gerbang
-- wajib-isi untuk reason_code yang dilepas. Tidak ada perubahan skema tabel.
--
-- Fungsi diambil dari 0010_stock_reference_initialization.sql dan hanya
-- menghapus blok:
--   if v_variance_qty <> 0 and v_reason is null then
--     raise exception using errcode = '22023', message = format('VARIANCE_CATEGORY_REQUIRED: ...');
--   end if;
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

revoke execute on function public.rpc_confirm_closing(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.rpc_confirm_closing(uuid, uuid, jsonb) to service_role;
