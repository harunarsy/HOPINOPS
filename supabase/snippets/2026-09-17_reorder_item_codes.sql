-- HOPIN production — 17 Sep 2026 (urutan final sesuai daftar tim)
-- Urutkan ulang kode item katalog asli:
--   BAR     : 53 item aktif  -> BAR-009 .. BAR-061
--   KITCHEN : 75 item aktif  -> KIT-007 .. KIT-081
-- Item dummy lama yang sudah diarsipkan (BAR-001..008, KIT-001..006) tidak diubah.
-- Kode item normalnya permanen; koreksi satu kali ini memakai trigger bypass.
-- Aman & transaksional: hanya mengubah kolom display_code + sequence. Bisa dijalankan ulang.

begin;

-- 0) Pengaman: hanya untuk database PRODUCTION.
do $$
begin
  if not exists (select 1 from public.profiles where username = 'harun' and active is true)
     or not exists (select 1 from public.profiles where username = 'jezy' and active is true) then
    raise exception 'SALAH DATABASE: user harun/jezy tidak ditemukan — ini bukan production. Tidak ada perubahan dijalankan.';
  end if;
end $$;

-- 1) Peta urutan final (nama item -> kode baru)
create temporary table _reorder_map (
  area_code text not null,
  position integer not null,
  item_name text not null,
  new_code text not null
) on commit drop;

insert into _reorder_map (area_code, position, item_name, new_code) values
  ('BAR', 1, 'Kopi', 'BAR-009'),
  ('BAR', 2, 'Susu Omela', 'BAR-010'),
  ('BAR', 3, 'Gula Pasir', 'BAR-011'),
  ('BAR', 4, 'Creamer', 'BAR-012'),
  ('BAR', 5, 'Chatramue', 'BAR-013'),
  ('BAR', 6, 'Sirup Leci', 'BAR-014'),
  ('BAR', 7, 'Sirup Lemon', 'BAR-015'),
  ('BAR', 8, 'Sirup Caramel', 'BAR-016'),
  ('BAR', 9, 'Sirup Peach', 'BAR-017'),
  ('BAR', 10, 'Sirup Hazelnut', 'BAR-018'),
  ('BAR', 11, 'Sirup Strawberry', 'BAR-019'),
  ('BAR', 12, 'Gula Aren', 'BAR-020'),
  ('BAR', 13, 'Bailyes', 'BAR-021'),
  ('BAR', 14, 'Bubuk Matcha', 'BAR-022'),
  ('BAR', 15, 'Jasmine Green Tea', 'BAR-023'),
  ('BAR', 16, 'Earl Grey Tea', 'BAR-024'),
  ('BAR', 17, 'Vanilla Tea', 'BAR-025'),
  ('BAR', 18, 'Oolong Tea', 'BAR-026'),
  ('BAR', 19, 'Kertas Struk', 'BAR-027'),
  ('BAR', 20, 'Es Batu', 'BAR-028'),
  ('BAR', 21, 'Sedotan', 'BAR-029'),
  ('BAR', 22, 'Galon', 'BAR-030'),
  ('BAR', 23, 'Buah Lemon', 'BAR-031'),
  ('BAR', 24, 'SKM', 'BAR-032'),
  ('BAR', 25, 'Air Mineral', 'BAR-033'),
  ('BAR', 26, 'Cup Takeaway', 'BAR-034'),
  ('BAR', 27, 'Bubuk Coklat', 'BAR-035'),
  ('BAR', 28, 'Kertas v60', 'BAR-036'),
  ('BAR', 29, 'Kantong plastik (Trashbag)', 'BAR-037'),
  ('BAR', 30, 'Tissue', 'BAR-038'),
  ('BAR', 31, 'Tissue toilet', 'BAR-039'),
  ('BAR', 32, 'Sikat gelas', 'BAR-040'),
  ('BAR', 33, 'Botol 1 liter', 'BAR-041'),
  ('BAR', 34, 'Pengharum ruangan Spray', 'BAR-042'),
  ('BAR', 35, 'Pengharum Kamar Mandi', 'BAR-043'),
  ('BAR', 36, 'Kamper kamar mandi', 'BAR-044'),
  ('BAR', 37, 'Soda', 'BAR-045'),
  ('BAR', 38, 'Pembersih lantai', 'BAR-046'),
  ('BAR', 39, 'Plastik bening', 'BAR-047'),
  ('BAR', 40, 'Handwash', 'BAR-048'),
  ('BAR', 41, 'Pembersih kaca', 'BAR-049'),
  ('BAR', 42, 'Spons', 'BAR-050'),
  ('BAR', 43, 'Kopi Arabika', 'BAR-051'),
  ('BAR', 44, 'Sabun Cuci Piring', 'BAR-052'),
  ('BAR', 45, 'Sabun Cuci Tangan', 'BAR-053'),
  ('BAR', 46, 'Karbol Sereh SOS', 'BAR-054'),
  ('BAR', 47, 'Sabun Cuci Kain', 'BAR-055'),
  ('BAR', 48, 'Pembersih Porselen', 'BAR-056'),
  ('BAR', 49, 'WPC Pembersih Toilet', 'BAR-057'),
  ('BAR', 50, 'Trashbag', 'BAR-058'),
  ('BAR', 51, 'Himalaya Salt', 'BAR-059'),
  ('BAR', 52, 'Stipo', 'BAR-060'),
  ('BAR', 53, 'Bulpen', 'BAR-061'),
  ('KITCHEN', 1, 'Beras', 'KIT-007'),
  ('KITCHEN', 2, 'Indomie goreng', 'KIT-008'),
  ('KITCHEN', 3, 'Indomie soto', 'KIT-009'),
  ('KITCHEN', 4, 'Indomie Aceh', 'KIT-010'),
  ('KITCHEN', 5, 'Indomie Kari', 'KIT-011'),
  ('KITCHEN', 6, 'Ayam Fillet', 'KIT-012'),
  ('KITCHEN', 7, 'Bawang putih', 'KIT-013'),
  ('KITCHEN', 8, 'Bawang Bombay', 'KIT-014'),
  ('KITCHEN', 9, 'Saos Jamur', 'KIT-015'),
  ('KITCHEN', 10, 'Telur', 'KIT-016'),
  ('KITCHEN', 11, 'Minyak Goreng', 'KIT-017'),
  ('KITCHEN', 12, 'Saos tomat', 'KIT-018'),
  ('KITCHEN', 13, 'Saos sambal', 'KIT-019'),
  ('KITCHEN', 14, 'Tepung terigu', 'KIT-020'),
  ('KITCHEN', 15, 'Tepung roti', 'KIT-021'),
  ('KITCHEN', 16, 'Tepung maizena', 'KIT-022'),
  ('KITCHEN', 17, 'Mayonaise', 'KIT-023'),
  ('KITCHEN', 18, 'Bubuk ketumbar', 'KIT-024'),
  ('KITCHEN', 19, 'Saos TERIYAKI', 'KIT-025'),
  ('KITCHEN', 20, 'Saos Blackpepper', 'KIT-026'),
  ('KITCHEN', 21, 'Saos KEJU', 'KIT-027'),
  ('KITCHEN', 22, 'Totole', 'KIT-028'),
  ('KITCHEN', 23, 'Garam', 'KIT-029'),
  ('KITCHEN', 24, 'Lada', 'KIT-030'),
  ('KITCHEN', 25, 'Sosis umi ami', 'KIT-031'),
  ('KITCHEN', 26, 'Nugget', 'KIT-032'),
  ('KITCHEN', 27, 'Kentang Frozen', 'KIT-033'),
  ('KITCHEN', 28, 'Kertas platter', 'KIT-034'),
  ('KITCHEN', 29, 'Trash bag dapur', 'KIT-035'),
  ('KITCHEN', 30, 'Tiram', 'KIT-036'),
  ('KITCHEN', 31, 'Kecap Manis', 'KIT-037'),
  ('KITCHEN', 32, 'Kecap Asin', 'KIT-038'),
  ('KITCHEN', 33, 'Cabe rawit', 'KIT-039'),
  ('KITCHEN', 34, 'Tepung Serbaguna', 'KIT-040'),
  ('KITCHEN', 35, 'Paper Tray takeaway', 'KIT-041'),
  ('KITCHEN', 36, 'LPG', 'KIT-042'),
  ('KITCHEN', 37, 'Spons Sabun', 'KIT-043'),
  ('KITCHEN', 38, 'Masako', 'KIT-044'),
  ('KITCHEN', 39, 'BUBUK Lada Hitam', 'KIT-045'),
  ('KITCHEN', 40, 'Kecap Inggris', 'KIT-046'),
  ('KITCHEN', 41, 'Tempe', 'KIT-047'),
  ('KITCHEN', 42, 'Tahu', 'KIT-048'),
  ('KITCHEN', 43, 'Bakso Aci', 'KIT-049'),
  ('KITCHEN', 44, 'Tepung Crispy', 'KIT-050'),
  ('KITCHEN', 45, 'Jahe', 'KIT-051'),
  ('KITCHEN', 46, 'Bawang Goreng', 'KIT-052'),
  ('KITCHEN', 47, 'Bawang Merah', 'KIT-053'),
  ('KITCHEN', 48, 'Kentang', 'KIT-054'),
  ('KITCHEN', 49, 'Wortel', 'KIT-055'),
  ('KITCHEN', 50, 'Minyak Wijen', 'KIT-056'),
  ('KITCHEN', 51, 'Curry Sasa', 'KIT-057'),
  ('KITCHEN', 52, 'Sendok Garpu Takeaway', 'KIT-058'),
  ('KITCHEN', 53, 'Plastik Takeaway', 'KIT-059'),
  ('KITCHEN', 54, 'Kantong Bening Takeaway', 'KIT-060'),
  ('KITCHEN', 55, 'Mika Tray Ganda Saos', 'KIT-061'),
  ('KITCHEN', 56, 'Cup Tray Saos', 'KIT-062'),
  ('KITCHEN', 57, 'Sabut Kawat', 'KIT-063'),
  ('KITCHEN', 58, 'Gula', 'KIT-064'),
  ('KITCHEN', 59, 'T. Gigi', 'KIT-065'),
  ('KITCHEN', 60, 'T. Platter', 'KIT-066'),
  ('KITCHEN', 61, 'Kabel Ties', 'KIT-067'),
  ('KITCHEN', 62, 'Rose Brand', 'KIT-068'),
  ('KITCHEN', 63, 'Daun Salam', 'KIT-069'),
  ('KITCHEN', 64, 'Daun Jeruk', 'KIT-070'),
  ('KITCHEN', 65, 'Sereh', 'KIT-071'),
  ('KITCHEN', 66, 'Racik', 'KIT-072'),
  ('KITCHEN', 67, 'Ayam Pentung', 'KIT-073'),
  ('KITCHEN', 68, 'Donat', 'KIT-074'),
  ('KITCHEN', 69, 'Gula Halus', 'KIT-075'),
  ('KITCHEN', 70, 'Tisu Panjang', 'KIT-076'),
  ('KITCHEN', 71, 'Tofu', 'KIT-077'),
  ('KITCHEN', 72, 'Enoki', 'KIT-078'),
  ('KITCHEN', 73, 'Mentega', 'KIT-079'),
  ('KITCHEN', 74, 'Piscok', 'KIT-080'),
  ('KITCHEN', 75, 'Jeruk Nipis', 'KIT-081');

-- 2) Validasi peta vs isi database (batal kalau tidak 1:1)
do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad
  from public.items i
  where i.area_code in ('BAR', 'KITCHEN') and i.active is true
    and not exists (
      select 1 from _reorder_map m
      where m.area_code = i.area_code::text and lower(btrim(m.item_name)) = lower(btrim(i.name))
    );
  if v_bad > 0 then
    raise exception 'PETA TIDAK LENGKAP: % item aktif tidak ada di peta urutan.', v_bad;
  end if;

  select count(*) into v_bad
  from _reorder_map m
  where not exists (
    select 1 from public.items i
    where i.area_code::text = m.area_code and i.active is true
      and lower(btrim(i.name)) = lower(btrim(m.item_name))
  );
  if v_bad > 0 then
    raise exception 'PETA BERLEBIH: % nama di peta tidak cocok dengan item aktif.', v_bad;
  end if;
end $$;

-- 3) Terapkan (dua fase supaya tidak bentrok unique; trigger kode permanen di-bypass)
set session_replication_role = replica;

update public.items
set display_code = 'TMP-' || id
where area_code in ('BAR', 'KITCHEN') and active is true;

update public.items i
set display_code = m.new_code
from _reorder_map m
where i.area_code::text = m.area_code
  and i.active is true
  and lower(btrim(i.name)) = lower(btrim(m.item_name));

update public.item_code_sequences seq
set next_value = sub.max_next
from (
  select area_code::text as ac,
         max((substring(display_code from '[0-9]+$'))::integer) + 1 as max_next
  from public.items
  where area_code in ('BAR', 'KITCHEN')
  group by area_code
) sub
where seq.area_code::text = sub.ac;

reset session_replication_role;

-- 4) Verifikasi
do $$
declare
  v_bad integer;
  v_bar integer;
  v_kit integer;
begin
  select count(*) into v_bad
  from public.items
  where area_code in ('BAR', 'KITCHEN') and active is true
    and display_code !~ '^(BAR|KIT)-[0-9]{3,}$';
  if v_bad > 0 then
    raise exception 'URUTKAN GAGAL: % item dengan kode tidak valid', v_bad;
  end if;

  select count(*) into v_bar from public.items where area_code = 'BAR' and active is true;
  select count(*) into v_kit from public.items where area_code = 'KITCHEN' and active is true;
  if v_bar <> 53 or v_kit <> 75 then
    raise exception 'JUMLAH TIDAK SESUAI: BAR=% (harus 53), KITCHEN=% (harus 75)', v_bar, v_kit;
  end if;

  select count(*) into v_bad
  from public.items i
  join _reorder_map m
    on m.area_code = i.area_code::text
   and lower(btrim(m.item_name)) = lower(btrim(i.name))
  where i.active is true and i.display_code is distinct from m.new_code;
  if v_bad > 0 then
    raise exception 'URUTKAN GAGAL: % item tidak sesuai peta', v_bad;
  end if;

  raise notice 'OK: BAR aktif=53 (BAR-009..BAR-061, berikutnya 62), KITCHEN aktif=75 (KIT-007..KIT-081, berikutnya 82)';
end $$;

commit;
