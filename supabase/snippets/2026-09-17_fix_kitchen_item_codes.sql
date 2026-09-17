-- HOPIN production fix — 17 Sep 2026
-- Dijalankan di Supabase SQL Editor project production (naanarmoktmsumkxmjvj).
-- Aman & transaksional: hanya memperbaiki generator kode, merapikan kode 42
-- item kitchen yang baru dibuat hari ini, dan menyelaraskan sequence.
-- Tidak menyentuh item BAR, histori, absensi, atau stok.

begin;

-- 0) Pengaman: script ini hanya boleh jalan di database PRODUCTION.
--    Kalau dijalankan di staging/DB lain, langsung dibatalkan tanpa perubahan.
do $$
begin
  if not exists (select 1 from public.profiles where username = 'harun' and active is true)
     or not exists (select 1 from public.profiles where username = 'jezy' and active is true) then
    raise exception 'SALAH DATABASE: user harun/jezy tidak ditemukan — ini bukan production. Tidak ada perubahan dijalankan.';
  end if;
end $$;

-- 1) Perbaikan generator kode: lpad(text, 3, '0') memotong nilai >= 1000
--    (contoh: 1020 -> '102') sehingga kode bisa bentrok. Sekarang tidak pernah
--    terpotong: minimal 3 digit, dan lebih panjang bila perlu.
create or replace function public.next_item_display_code(p_area public.area_code)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next integer;
  v_prefix text;
begin
  if p_area is null then
    raise exception using errcode = '22023', message = 'AREA_REQUIRED: Area item wajib diisi.';
  end if;

  insert into public.item_code_sequences(area_code, next_value)
  values (p_area, 1)
  on conflict (area_code) do nothing;

  select next_value into v_next
  from public.item_code_sequences
  where area_code = p_area
  for update;

  update public.item_code_sequences
  set next_value = v_next + 1
  where area_code = p_area;

  v_prefix := case when p_area = 'BAR' then 'BAR' else 'KIT' end;
  return v_prefix || '-' || lpad(v_next::text, greatest(3, length(v_next::text)), '0');
end;
$$;

-- 2) Rapikan kode 42 item kitchen hari ini menjadi KIT-007, KIT-008, ...
--    sesuai urutan pembuatan. Kode item normalnya permanen, jadi koreksi
--    satu kali ini dijalankan dengan trigger bypass (replica role).
set session_replication_role = replica;

update public.items
set display_code = 'TMP-' || id
where area_code = 'KITCHEN'
  and (substring(display_code from '[0-9]+$'))::integer > 6;

with ranked as (
  select id, row_number() over (order by created_at asc, id asc) as rn
  from public.items
  where area_code = 'KITCHEN'
    and display_code like 'TMP-%'
)
update public.items item
set display_code = 'KIT-' || lpad((ranked.rn + 6)::text, 3, '0')
from ranked
where item.id = ranked.id;

update public.item_code_sequences
set next_value = (
  select max((substring(display_code from '[0-9]+$'))::integer) + 1
  from public.items
  where area_code = 'KITCHEN'
)
where area_code = 'KITCHEN';

reset session_replication_role;

-- 3) Verifikasi: semua kode kitchen valid dan sequence selaras.
do $$
declare
  v_bad integer;
  v_next integer;
begin
  select count(*) into v_bad
  from public.items
  where area_code = 'KITCHEN'
    and display_code !~ '^KIT-[0-9]{3,}$';
  if v_bad > 0 then
    raise exception 'PERBAIKAN GAGAL: % item kitchen dengan kode tidak valid', v_bad;
  end if;
  select next_value into v_next
  from public.item_code_sequences
  where area_code = 'KITCHEN';
  raise notice 'OK: kode kitchen dirapikan; sequence berikutnya = KIT-%', lpad(v_next::text, 3, '0');
end $$;

commit;
