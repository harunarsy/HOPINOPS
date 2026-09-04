# HOPIN Action Log

Tanggal: 4 September 2026
Dasar: `PRODUCTION_PLAN.md`, `REMEDIATION_IMPLEMENTATION_PLAN_PART_2.md`
Branch: `remediation/part2`
Status: **PHASE 0-4 & 8-9 TERVERIFIKASI/PARAMETER; PHASE 5/6/7/10 BELUM**

## Terverifikasi penuh (gates lint + unit + build + e2e)
- Phase 0: backup production, migration parity, 1 stuck cycle, env/headers audit.
- Phase 1: Playwright harness, `pnpm test:e2e` 10 passed.

## DB migrations — DIVERIFIKASI DI STAGING
Staging Supabase dibuat: project `ibzlxdmnuszcmdzuocwu` (`hopinops-staging`, region Singapore). CLI link kini menunjuk ke staging (bukan production).
- Migration `0001`-`0011` **diterapkan dari nol di staging** dan **17 pgTAP assertion lulus** (lewat psql langsung ke pooler staging karena Docker tidak tersedia).
- Phase 2 `0010_stock_reference_initialization.sql` — valid (applied).
- Phase 4 `0011_auth_lockout_3x_60s.sql` — diawali gagal karena `v_scope_key` tidak dideklarasikan di `rpc_check_auth_limits`; diperbaiki (tambah deklarasi) lalu applied sukses.
- Harness `supabase/tests/database.test.sql` mencakup fungsi/table baru.

## Implementasi kode tambahan (fase ini)
- Phase 3: Opening/Closing UX — tombol `Sesuai`/`0`, bulk "sesuai patokan", `INITIAL_STOCK_COUNT`, catatan opsional.
- Phase 4: Lockout 3x/60s server-authoritative (migration 0011 + `api/auth.ts` 429/Retry-After + `Login.tsx`/`App.tsx` tanpa counter client + guard dobel submit; `api.ts` baca `Retry-After`).
- Phase 8: `payroll.export.xlsx` kini menghasilkan 7 sheet (Summary, Adjustments, Exceptions, Attendance, Overtime, Bonus, Audit); supportive reads best-effort (tidak memecah export bila bonus/audit kosong).
- Phase 9: `api/health.ts` no-store; `jsonResponse` API nosniff + referrer-policy; `vercel.json` CSP/frame/permissions.

## Gate terakhir (semua dijalankan)
- `pnpm lint`: LULUS
- `pnpm test`: LULUS (18/18)
- `pnpm build`: LULUS
- `pnpm test:e2e`: LULUS (10 passed)
- `pnpm test:db` equivalent: pgTAP 17 assertions LULUS via staging psql
- `git diff --check`: LULUS

## Masih belum (Phase 5/6/7/10)
- Phase 5: memperluas ~25 action API (roster self-view, izin/cuti/lembur/koreksi, emergency checkout, draft stock, koreksi movement, dst.).
- Phase 6/7: arsitektur UI (AppShell/route/capability shell) + onboarding interaktif.
- Phase 10: sinkronisasi penuh `PRODUCTION_PLAN.md`/`README`/`UX-CONTRACT` dengan keputusan final.

## Catatan deployment
- Production TIDAK diubah; CLI kini ter-link ke staging.
- Untuk kembali ke production: `supabase link --project-ref naanarmoktmsumkxmjvj`.
- Migrations 0010/0011 belum di-push ke production.

## Larangan
- Jangan push/merge ke `main` sebelum UI/API fase tersisa selesai dan diuji; gunakan staging untuk verifikasi.
- Untuk akses staging: password DB tersimpan di `/tmp/hopin_staging_pw.txt` (lokal, tidak di-commit).
