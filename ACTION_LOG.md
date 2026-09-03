# HOPIN Action Log

Tanggal: 4 September 2026
Dasar: `PRODUCTION_PLAN.md`, `REMEDIATION_IMPLEMENTATION_PLAN_PART_2.md`
Branch: `remediation/part2` (dari `main` @ `92b51d8`)
Status: **PHASE 0 + PHASE 1 VERIFIED — PHASE 2 BELUM DIMULAI**

## Phase 0 — Stabilization and Preflight: VERIFIED

- Branch remediation `remediation/part2` dibuat; tidak ada hotfix langsung ke `main`.
- Backup production (pg_dump 17.6, koneksi pooler Supabase):
  - `backups/production_schema_20260903.sql` (schema-only, 9.481 baris).
  - `backups/production_data_20260903.sql` (data-only 45 tabel operasional, tanpa tabel credential).
  - Direktori `backups/` di-gitignore; tidak akan masuk repository.
- Migration remote & lokal identik: `0001`–`0009`. Tidak ada drift.
- Preflight data (read-only, terdokumentasi di `backups/PHASE0_PREFLIGHT_20260903.md`):
  - 1 cycle stuck terkonfirmasi: `4ac92535-2f18-4eee-8b96-ad51914e02a1` (2026-09-03 MALAM KITCHEN, ACTIVE) — korban `REFERENCE_NOT_FOUND`, plus assignment & attendance terkait.
  - Row counts semua tabel operasional tercatat.
- Environment Vercel: `PAYROLL_EXPORT_BUCKET` **belum ada** (export payroll fail-closed).
- Security headers production: hanya HSTS; CSP/frame-ancestors/nosniff/referrer/permissions **belum ada**; `/api/health` `Cache-Control: public`.
- Tidak ada mutasi production selama fase ini.

## Phase 1 — Test Harness: VERIFIED

- `@playwright/test@1.62.1` + Chromium terpasang.
- `playwright.config.ts`: desktop-chromium + mobile-chromium (360x800), webServer `vite preview`.
- `pnpm test:e2e` ditambahkan ke `package.json`.
- Vitest di-exclude dari `tests/e2e/**` (tidak saling mem-pickup).
- E2E read-only smoke (`tests/e2e/smoke.spec.ts`) — 10 PASSED:
  - Login page render (picker + 6 kotak PIN + tombol masuk) di desktop & mobile.
  - Urutan fokus kotak PIN & numeric-only di desktop & mobile.
  - `/api/app?action=bootstrap` tanpa sesi → 401 `AUTH_REQUIRED` (deployed API).
  - Unknown action tanpa sesi → 401 (auth mendahului dispatch).
  - Failed login generik tanpa kebocoran user existence.
- Mutating tests (`tests/e2e/authenticated.spec.ts`) berupa guard `E2E_USERNAME/E2E_PASSWORD` + `test.fixme` untuk Phase 2+; otomatis skip tanpa kredensial staging (10 skipped).

## Gate Terakhir (dieksekusi di branch ini)

- `pnpm lint`: LULUS.
- `pnpm test`: LULUS (18 tests, 7 files).
- `pnpm build`: LULUS (bundle 284 kB).
- `pnpm test:e2e`: LULUS (10 passed, 10 skipped-staging-only).
- `git diff --check`: LULUS.
- `pnpm test:db`: **MASIH TERBLOKIR** — Docker/Podman tidak tersedia di mesin ini (prasyarat `supabase db reset`). pgTAP harness sudah ada di `supabase/tests/database.test.sql` dan siap dijalankan begitu Docker/staging tersedia.

## Berikutnya (sesuai plan Part 2)

1. Phase 2: migration `0010_stock_reference_initialization.sql` (zero-reference manager-approved initialization + variance policy: kategori wajib, catatan opsional) — **jangan mulai sebelum `test:db` bisa dieksekusi** di staging/lokal.
2. Recovery cycle stuck `4ac92535…` dilakukan lewat UI/RPC initialization setelah Phase 2 live di Preview, bukan backfill data.
3. Phase 4: `0011_auth_device_and_lockout.sql` (3x/60 detik server-authoritative + device binding fix).

## Larangan

- Jangan push/merge ke `main` sebelum `test:db` lulus di environment yang bisa menjalankannya.
- Jangan menulis migration `0010` sebelum Phase 1 acceptance lengkap (termasuk `test:db`).
- Jangan mengubah data production untuk "memperbaiki" cycle stuck secara manual.
