-- PRIMARY may update catalog metadata only inside the area of an active assignment.
-- The pending catalog snapshot protects the active cycle and historical stock units.

create or replace function public.rpc_operator_update_item(
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
  if v_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Jalur ini hanya untuk OPERATOR PRIMARY.';
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
    raise exception using errcode = '42501', message = 'FORBIDDEN_SCOPE: PRIMARY hanya boleh mengubah item pada area tugas aktifnya.';
  end if;

  v_catalog := public.pending_catalog_effective(p_outlet_id, v_area);
  select value into v_item
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
    p_actor_id, p_outlet_id, v_area, (v_catalog->>'version')::integer,
    v_catalog->'items', v_catalog->'sections', v_catalog->'placements',
    'UPDATE_ITEM', 'UPDATE_ITEM', v_key, null
  );
  v_result := jsonb_build_object(
    'id', btrim(p_item_id), 'area_code', v_area, 'name', v_name,
    'unit_code', v_unit_code, 'decimal_scale', p_decimal_scale,
    'low_threshold', p_low_threshold, 'active', true
  ) || v_result;
  update public.pending_catalog_ops set result = v_result where idempotency_key = v_key;
  return v_result;
end;
$$;

revoke execute on function public.rpc_operator_update_item(uuid, uuid, text, text, text, smallint, numeric) from public, anon, authenticated;
grant execute on function public.rpc_operator_update_item(uuid, uuid, text, text, text, smallint, numeric) to service_role;
