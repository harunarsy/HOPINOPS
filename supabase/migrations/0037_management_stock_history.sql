-- HOPIN Production Migration 0037: Management stock history.
--
-- Dua RPC read-only untuk tab "Stok Area":
--   * rpc_get_management_stock_history  -> daftar tanggal/periode berisi cycle
--     beserta ringkasan closing (jumlah item, jumlah selisih, siapa menutup).
--   * rpc_get_management_stock_closing_detail -> rincian per item untuk satu
--     cycle (patokan/opening, masuk, keluar, sistem, hitung fisik, selisih).
-- Dipakai untuk riwayat stok + ekspor PDF dari dashboard manajemen.

create or replace function public.rpc_get_management_stock_history(
  p_actor_id uuid, p_outlet_id uuid, p_from date, p_to date
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_role public.app_role;
  v_rows jsonb := '[]'::jsonb;
  c record;
begin
  if p_actor_id is null or p_outlet_id is null or p_from is null or p_to is null or p_from > p_to
     or (p_to - p_from) > 92 then
    raise exception using errcode='22023', message='INVALID_ARGUMENT: Rentang riwayat stok wajib valid (maksimal 92 hari).';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER','SUPERVISOR') then
    raise exception using errcode='42501', message='FORBIDDEN: Manajemen diperlukan.';
  end if;
  for c in
    select cycle.id, cycle.work_date, cycle.shift_code, cycle.area_code, cycle.status,
           closing.id as closing_id, closing.status as closing_status,
           closing.confirmed_at, closing.movement_cutoff_at,
           confirmer.display_name as confirmed_by_name
    from public.work_cycles cycle
    left join public.stock_closings closing on closing.cycle_id = cycle.id
    left join public.profiles confirmer on confirmer.id = closing.confirmed_by
    where cycle.outlet_id = p_outlet_id
      and cycle.work_date between p_from and p_to
      and cycle.area_code in ('BAR','KITCHEN')
    order by cycle.work_date desc, cycle.area_code, cycle.shift_code
  loop
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'cycle_id', c.id,
      'work_date', c.work_date,
      'shift_code', c.shift_code,
      'area_code', c.area_code,
      'cycle_status', c.status,
      'primary_name', (select profile.display_name
        from public.work_assignments assignment
        join public.profiles profile on profile.id = assignment.profile_id
        where assignment.cycle_id = c.id and assignment.duty_role = 'PRIMARY'
        order by assignment.assigned_at limit 1),
      'closing_id', c.closing_id,
      'closing_status', c.closing_status,
      'confirmed_by_name', c.confirmed_by_name,
      'confirmed_at', c.confirmed_at,
      'movement_cutoff_at', c.movement_cutoff_at,
      'line_count', case when c.closing_id is null then 0
        else (select count(*) from public.stock_closing_lines line where line.closing_id = c.closing_id) end,
      'variance_count', case when c.closing_id is null then 0
        else (select count(*) from public.stock_closing_lines line where line.closing_id = c.closing_id and line.variance_qty <> 0) end,
      'total_items', (select count(*) from public.items item where item.area_code = c.area_code and item.active)
    ));
  end loop;
  return jsonb_build_object('from', p_from, 'to', p_to, 'rows', v_rows);
end;
$$;

create or replace function public.rpc_get_management_stock_closing_detail(
  p_actor_id uuid, p_outlet_id uuid, p_cycle_id uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_role public.app_role;
  v_cycle public.work_cycles%rowtype;
  v_closing public.stock_closings%rowtype;
  v_confirmed_by_name text;
  v_lines jsonb;
begin
  if p_actor_id is null or p_outlet_id is null or p_cycle_id is null then
    raise exception using errcode='22023', message='INVALID_ARGUMENT: Cycle wajib valid.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER','SUPERVISOR') then
    raise exception using errcode='42501', message='FORBIDDEN: Manajemen diperlukan.';
  end if;
  select * into v_cycle from public.work_cycles where id = p_cycle_id and outlet_id = p_outlet_id;
  if not found then
    raise exception using errcode='P0002', message='NOT_FOUND: Cycle tidak ditemukan pada outlet.';
  end if;
  select * into v_closing from public.stock_closings where cycle_id = v_cycle.id;
  if found then
    select display_name into v_confirmed_by_name from public.profiles where id = v_closing.confirmed_by;
    select coalesce(jsonb_agg(jsonb_build_object(
      'item_id', line.item_id,
      'item_name', coalesce(line.item_name_snapshot, item.name),
      'unit_code', coalesce(line.unit_code_snapshot, item.unit_code),
      'opening_qty', line.opening_qty,
      'incoming_qty', line.incoming_qty,
      'outgoing_qty', line.outgoing_qty,
      'system_qty', line.system_qty,
      'counted_qty', line.counted_qty,
      'variance_qty', line.variance_qty,
      'reason_code', line.reason_code,
      'notes', line.notes
    ) order by coalesce(line.item_name_snapshot, item.name)), '[]'::jsonb)
    into v_lines
    from public.stock_closing_lines line
    left join public.items item on item.id = line.item_id
    where line.closing_id = v_closing.id;
  else
    v_lines := '[]'::jsonb;
  end if;
  return jsonb_build_object(
    'cycle', jsonb_build_object(
      'id', v_cycle.id, 'work_date', v_cycle.work_date, 'shift_code', v_cycle.shift_code,
      'area_code', v_cycle.area_code, 'status', v_cycle.status),
    'closing', case when v_closing.id is null then null else jsonb_build_object(
      'id', v_closing.id, 'status', v_closing.status, 'confirmed_at', v_closing.confirmed_at,
      'confirmed_by_name', v_confirmed_by_name, 'movement_cutoff_at', v_closing.movement_cutoff_at) end,
    'lines', v_lines
  );
end;
$$;

revoke execute on function public.rpc_get_management_stock_history(uuid, uuid, date, date) from public, anon, authenticated;
revoke execute on function public.rpc_get_management_stock_closing_detail(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.rpc_get_management_stock_history(uuid, uuid, date, date) to service_role;
grant execute on function public.rpc_get_management_stock_closing_detail(uuid, uuid, uuid) to service_role;
