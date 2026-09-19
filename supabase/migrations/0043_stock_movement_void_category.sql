-- Stok bergerak harus bisa dibatalkan dengan jujur.
--
-- Sebelumnya koreksi wajib memakai kategori nyata (PURCHASE / USAGE / WASTE / ...),
-- sehingga membatalkan salah input tercatat sebagai pembelian atau pemakaian
-- palsu dan mengotori laporan kategori. Akibatnya operator mencari akal lain,
-- misalnya memasukkan stok keluar manual, yang justru menambah data salah.
--
-- Tambahkan kategori VOID untuk kedua arah, sehingga pembatalan terlihat jelas
-- sebagai pembatalan: movement asal tetap ada untuk audit, dan penyeimbangnya
-- ditandai VOID.

alter table public.stock_movements drop constraint if exists stock_movements_check;
alter table public.stock_movements add constraint stock_movements_check check (
  (direction = 'IN' and category in ('PURCHASE', 'RETURN_IN', 'TRANSFER_IN', 'VOID'))
  or (direction = 'OUT' and category in ('USAGE', 'INTERNAL', 'TRANSFER_OUT', 'WASTE', 'VOID'))
);

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
    raise exception using errcode = '55000', message = 'MOVEMENT_CUTOFF: Pembatalan memerlukan cycle OPEN sebelum cutoff. Bila shift sudah difinalisasi, catat penyesuaian pada cycle berikutnya.';
  end if;

  select * into v_original
  from public.stock_movements
  where id = p_original_movement_id and cycle_id = p_cycle_id
  for share;
  if not found or v_original.correction_of_id is not null then
    raise exception using errcode = '22023', message = 'INVALID_ORIGINAL: Movement asal tidak ditemukan atau merupakan correction.';
  end if;
  if v_original.created_by <> p_actor_id and v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Hanya creator atau manager yang dapat membatalkan movement.';
  end if;
  if v_role::text = 'OPERATOR' and not exists (
    select 1 from public.work_assignments
    where cycle_id = p_cycle_id and profile_id = p_actor_id and status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: OPERATOR memerlukan assignment aktif pada cycle.';
  end if;
  if exists (select 1 from public.stock_movements where correction_of_id = p_original_movement_id) then
    raise exception using errcode = '55000', message = 'MOVEMENT_ALREADY_CORRECTED: Movement asal sudah dibatalkan.';
  end if;
  if p_direction = v_original.direction or p_quantity <> v_original.quantity then
    raise exception using errcode = '22023', message = 'NON_NETTING_CORRECTION: Pembatalan wajib berlawanan arah dan sama dengan quantity asal.';
  end if;
  if (p_direction = 'IN' and v_category not in ('PURCHASE', 'RETURN_IN', 'TRANSFER_IN', 'VOID'))
     or (p_direction = 'OUT' and v_category not in ('USAGE', 'INTERNAL', 'TRANSFER_OUT', 'WASTE', 'VOID')) then
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
