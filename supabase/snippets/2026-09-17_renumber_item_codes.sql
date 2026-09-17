-- HOPIN production — 17 Sep 2026 (langkah terakhir)
-- Rapikan penomoran kode item katalog asli (satu kali):
--   BAR     : 53 item aktif  -> BAR-009 .. BAR-061
--   KITCHEN : 75 item aktif  -> KIT-007 .. KIT-081
-- Item dummy lama yang sudah diarsipkan (BAR-001..008, KIT-001..006) tidak diubah.
-- Kode item normalnya permanen; koreksi satu kali ini memakai trigger bypass.
-- Aman & transaksional: hanya mengubah kolom display_code + sequence.

begin;

-- 0) Pengaman: hanya untuk database PRODUCTION.
do $$
begin
  if not exists (select 1 from public.profiles where username = 'harun' and active is true)
     or not exists (select 1 from public.profiles where username = 'jezy' and active is true) then
    raise exception 'SALAH DATABASE: user harun/jezy tidak ditemukan — ini bukan production. Tidak ada perubahan dijalankan.';
  end if;
end $$;

set session_replication_role = replica;

-- 1) BAR: 53 item aktif dirapikan sesuai urutan pembuatan -> BAR-009..
update public.items set display_code = 'TMP-' || id
where area_code = 'BAR' and active is true;

with ranked as (
  select id, row_number() over (order by created_at asc, id asc) as rn
  from public.items
  where area_code = 'BAR' and display_code like 'TMP-%'
)
update public.items item
set display_code = 'BAR-' || lpad((ranked.rn + 8)::text, 3, '0')
from ranked
where item.id = ranked.id;

update public.item_code_sequences
set next_value = (
  select max((substring(display_code from '[0-9]+$'))::integer) + 1
  from public.items where area_code = 'BAR'
)
where area_code = 'BAR';

-- 2) KITCHEN: 75 item aktif dirapikan sesuai urutan pembuatan -> KIT-007..
update public.items set display_code = 'TMP-' || id
where area_code = 'KITCHEN' and active is true;

with ranked as (
  select id, row_number() over (order by created_at asc, id asc) as rn
  from public.items
  where area_code = 'KITCHEN' and display_code like 'TMP-%'
)
update public.items item
set display_code = 'KIT-' || lpad((ranked.rn + 6)::text, 3, '0')
from ranked
where item.id = ranked.id;

update public.item_code_sequences
set next_value = (
  select max((substring(display_code from '[0-9]+$'))::integer) + 1
  from public.items where area_code = 'KITCHEN'
)
where area_code = 'KITCHEN';

reset session_replication_role;

-- 3) Verifikasi
do $$
declare
  v_bad integer;
  v_bar_active integer;
  v_kit_active integer;
  v_bar_next integer;
  v_kit_next integer;
begin
  select count(*) into v_bad
  from public.items
  where area_code in ('BAR', 'KITCHEN') and active is true
    and display_code !~ '^(BAR|KIT)-[0-9]{3,}$';
  if v_bad > 0 then
    raise exception 'RAPIKAN GAGAL: % item dengan kode tidak valid', v_bad;
  end if;

  select count(*) into v_bar_active from public.items where area_code = 'BAR' and active is true;
  select count(*) into v_kit_active from public.items where area_code = 'KITCHEN' and active is true;
  if v_bar_active <> 53 or v_kit_active <> 75 then
    raise exception 'JUMLAH TIDAK SESUAI: BAR=% (harus 53), KITCHEN=% (harus 75)', v_bar_active, v_kit_active;
  end if;

  select next_value into v_bar_next from public.item_code_sequences where area_code = 'BAR';
  select next_value into v_kit_next from public.item_code_sequences where area_code = 'KITCHEN';
  raise notice 'OK: BAR aktif=53 (berikutnya BAR-%), KITCHEN aktif=75 (berikutnya KIT-%)',
    lpad(v_bar_next::text, 3, '0'), lpad(v_kit_next::text, 3, '0');
end $$;

commit;
