-- Satuan item (unit_code + decimal_scale) tidak boleh diubah saat masih ada
-- cycle berjalan yang sudah mencatat opening/closing untuk item tersebut.
--
-- Alasannya konkret: opening dan closing disimpan memakai satuan yang aktif saat
-- masing-masing diisi, dan tidak ada rescale otomatis. Kalau satuan berubah di
-- tengah cycle, sistem lalu membandingkan dua angka dengan satuan berbeda —
-- contoh nyata 18 Sep 2026: Tepung maizena opening 2000 (gram) vs closing 2
-- (kilo), selisih 1998 pada cycle yang sama.
--
-- Cycle yang sudah COMPLETED tidak menghalangi, karena laporan sudah menyimpan
-- snapshot satuannya sendiri.

create or replace function public.guard_item_unit_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle record;
begin
  if new.unit_code is not distinct from old.unit_code
     and new.decimal_scale is not distinct from old.decimal_scale then
    return new;
  end if;

  select wc.work_date, wc.area_code, wc.shift_code
    into v_cycle
  from public.work_cycles wc
  where wc.status <> 'COMPLETED'
    and wc.area_code = new.area_code
    and (
      exists (
        select 1
        from public.stock_opening_lines ol
        join public.stock_openings o on o.id = ol.opening_id
        where o.cycle_id = wc.id and ol.item_id = new.id
      )
      or exists (
        select 1
        from public.stock_closing_lines cl
        join public.stock_closings c on c.id = cl.closing_id
        where c.cycle_id = wc.id and cl.item_id = new.id
      )
    )
  order by wc.work_date desc
  limit 1;

  if found then
    raise exception using
      errcode = '55000',
      message = format(
        'UNIT_LOCKED_BY_CYCLE: Satuan %s tidak dapat diubah karena cycle %s %s %s sudah mencatat opening atau closing. Selesaikan cycle tersebut lebih dulu.',
        new.name,
        v_cycle.work_date,
        v_cycle.area_code,
        v_cycle.shift_code
      );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_items_unit_change_guard on public.items;
create trigger trg_items_unit_change_guard
before update of unit_code, decimal_scale on public.items
for each row execute function public.guard_item_unit_change();
