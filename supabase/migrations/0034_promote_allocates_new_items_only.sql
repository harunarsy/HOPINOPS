-- 0034: Promote katalog tidak lagi "menghanguskan" nomor kode item.
--
-- Masalah: pending_catalog_promote() menulis seluruh snapshot katalog dengan
-- INSERT ... ON CONFLICT (id) DO UPDATE. Trigger BEFORE INSERT
-- trg_items_display_code mengalokasikan kode untuk SETIAP baris INSERT —
-- termasuk baris item lama yang akhirnya berakhir sebagai konflik/update.
-- Akibatnya setiap promote menaikkan sequence sebesar jumlah item dalam
-- snapshot (mis. tambah 1 item di KITCHEN yang berisi 75 item menaikkan
-- sequence +75), sehingga kode item berikutnya melompat jauh.
--
-- Perbaikan: item yang sudah ada di-update langsung (tanpa melewati trigger
-- alokasi); hanya item benar-benar baru yang di-INSERT dan mendapat kode.
-- Semantik lain (validasi, penonaktifan item yang hilang, sections,
-- placements, audit, versi) tidak berubah.

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
    if exists (
      select 1 from public.items where id = (v_value->>'item_id')
    ) then
      -- Item lama: update langsung agar trigger alokasi kode tidak berjalan.
      update public.items
      set area_code = p_area,
          name = btrim(v_value->>'name'),
          unit_code = btrim(v_value->>'unit_code'),
          decimal_scale = (v_value->>'decimal_scale')::smallint,
          low_threshold = (v_value->>'low_threshold')::numeric,
          active = (v_value->>'active')::boolean,
          updated_at = clock_timestamp()
      where id = (v_value->>'item_id');
    else
      -- Item baru: satu-satunya baris yang boleh mengalokasikan kode.
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
      );
    end if;
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
