-- HOPIN production fix — 18 Sep 2026
-- Dijalankan di Supabase SQL Editor project production (naanarmoktmsumkxmjvj),
-- SETELAH migrasi 0035-0038 diterapkan.
--
-- Menyelaraskan jadwal operasional (17 Sep 2026 dan setelahnya) dengan realita:
--   * NDARU  — KITCHEN, shift MALAM (cycle 82082e09, closing 42619ff1)
--   * AREL   — BAR,     shift FULL  (cycle 3898c07f, closing 3d47ae9c)
-- Keduanya sebelumnya diklaim tanpa jadwal sehingga berstatus schedule_deviation
-- dan tidak punya roster entry. Snippet ini:
--   1) membuat roster entry operasional (source='OPERASIONAL', pay_treatment BASE,
--      status COMPLETED) — muncul di "Atur Jadwal" sebagai kerja nyata,
--   2) menautkan assignment + attendance record ke roster tersebut,
--   3) mematikan flag schedule_deviation agar tidak lagi memblok payroll,
--   4) mencatat audit event "input susulan manajemen".
-- Idempoten & transaksional: aman dijalankan dua kali, hanya menyentuh claim
-- tanpa jadwal (schedule_deviation) sejak 17 Sep 2026 pada outlet HOPIN Cafe.

begin;

-- 0) Pengaman database: script hanya boleh jalan di PRODUCTION.
do $$
begin
  if not exists (select 1 from public.profiles where username = 'harun' and active is true)
     or not exists (select 1 from public.profiles where username = 'jezy' and active is true) then
    raise exception 'SALAH DATABASE: user harun/jezy tidak ditemukan — ini bukan production. Tidak ada perubahan dijalankan.';
  end if;
end $$;

-- 1) Roster operasional dari assignment yang masih deviasi (tanpa jadwal).
insert into public.roster_entries (
  outlet_id, work_date, shift_code, profile_id, expected_area, status,
  pay_treatment, override_reason, created_by, source
)
select c.outlet_id, c.work_date, c.shift_code, wa.profile_id, c.area_code,
       case when wa.status = 'COMPLETED' then 'COMPLETED' else 'SCHEDULED' end,
       'BASE', null, wa.profile_id, 'OPERASIONAL'
from public.work_assignments wa
join public.work_cycles c on c.id = wa.cycle_id
where c.outlet_id = '11111111-1111-1111-1111-111111111111'
  and c.work_date >= '2026-09-17'
  and wa.status <> 'RESET'
  and wa.schedule_deviation is true
  and not exists (
    select 1 from public.roster_entries r
    where r.profile_id = wa.profile_id and r.work_date = c.work_date
  );

-- 1b) Selaraskan status roster operasional dengan status assignment: shift yang
--     masih berjalan tetap SCHEDULED, hanya assignment COMPLETED yang COMPLETED.
update public.roster_entries r
set status = case when wa.status = 'COMPLETED' then 'COMPLETED' else 'SCHEDULED' end,
    version = r.version + 1,
    updated_at = now()
from public.work_assignments wa
where wa.roster_entry_id = r.id
  and r.outlet_id = '11111111-1111-1111-1111-111111111111'
  and r.work_date >= '2026-09-17'
  and r.source = 'OPERASIONAL'
  and r.status is distinct from case when wa.status = 'COMPLETED' then 'COMPLETED' else 'SCHEDULED' end;

-- 2) Tautkan assignment ke roster + matikan deviasi.
update public.work_assignments wa
set roster_entry_id = r.id,
    schedule_deviation = false,
    version = wa.version + 1
from public.work_cycles c, public.roster_entries r
where c.id = wa.cycle_id
  and c.outlet_id = '11111111-1111-1111-1111-111111111111'
  and c.work_date >= '2026-09-17'
  and wa.status <> 'RESET'
  and r.profile_id = wa.profile_id
  and r.work_date = c.work_date
  and r.source = 'OPERASIONAL'
  and (wa.roster_entry_id is distinct from r.id or wa.schedule_deviation is true);

-- 3) Tautkan attendance record ke roster yang sama.
update public.attendance_records a
set roster_entry_id = r.id,
    version = a.version + 1,
    updated_at = now()
from public.roster_entries r
where r.outlet_id = '11111111-1111-1111-1111-111111111111'
  and r.work_date >= '2026-09-17'
  and r.source = 'OPERASIONAL'
  and a.profile_id = r.profile_id
  and a.work_date = r.work_date
  and a.roster_entry_id is distinct from r.id;

-- 4) Audit: catat sebagai input susulan manajemen (idempoten).
do $$
declare
  r record;
begin
  for r in
    select id, profile_id, work_date from public.roster_entries
    where outlet_id = '11111111-1111-1111-1111-111111111111'
      and work_date >= '2026-09-17' and source = 'OPERASIONAL'
      and not exists (
        select 1 from public.audit_events event
        where event.action = 'BACKFILL_OPERATIONAL_ROSTER' and event.entity_id = id::text
      )
  loop
    perform public.log_audit_event(
      r.profile_id, 'BACKFILL_OPERATIONAL_ROSTER', 'roster_entries', r.id::text,
      '11111111-1111-1111-1111-111111111111', r.profile_id, null,
      jsonb_build_object('work_date', r.work_date, 'source', 'OPERASIONAL',
        'note', 'Input susulan manajemen: sinkronisasi jadwal dari operasional/closing')
    );
  end loop;
end $$;

-- 5) Ringkasan hasil.
select r.work_date, r.profile_id, p.display_name, r.shift_code, r.expected_area,
       r.status, r.source
from public.roster_entries r
join public.profiles p on p.id = r.profile_id
where r.outlet_id = '11111111-1111-1111-1111-111111111111'
  and r.work_date >= '2026-09-17'
order by r.work_date, r.shift_code;

commit;
