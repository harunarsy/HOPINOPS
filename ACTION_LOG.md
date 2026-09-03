# HOPIN Action Log

Tanggal: 4 September 2026
Dasar: `PRODUCTION_PLAN.md`, `REMEDIATION_IMPLEMENTATION_PLAN_PART_2.md`
Branch: `remediation/part2`
Status: **PHASE 0-1 VERIFIED; PHASE 2/3/4/9 DIIMPLEMENTASI (kode), MIGRASI 0010/0011 BELUM DI-VERIFIKASI DB**

## Fase yang sudah terverifikasi penuh (lint + unit + build + e2e)
- Phase 0: backup production, branch, preflight, tanpa mutasi production.
- Phase 1: Playwright + E2E smoke (10 passed).

## Implementasi kode tambahan (fase ini)

### Phase 2 — Migration 0010 (BELUM dieksekusi DB)
- File `supabase/migrations/0010_stock_reference_initialization.sql` ditulis:
  - Tabel `stock_reference_initializations` + `stock_reference_initialization_lines` (zero-baseline, append-only).
  - `rpc_initialize_stock_reference` (Owner/Supervisor, idempotent, zero-reference).
  - `rpc_get_opening_reference` (server-owned reference resolution).
  - `rpc_confirm_opening` diperbarui: MALAM fallback ke prior closing, inisialisasi, variance kategori-wajib/notes-opsional.
  - `rpc_confirm_closing` diperbarui: variance kategori-wajib/notes-opsional.
- pgTAP `database.test.sql` diperbarui: tambah signature `rpc_initialize_stock_reference`, `rpc_get_opening_reference`, tabel baru.
- **Blocker: `test:db` butuh Docker → belum dieksekusi.**

### Phase 3 — Opening/Closing UX (kode, terverifikasi lint/build)
- `StockWorkspace.tsx`: tombol `Sesuai`/`0` per item, tombol bulk "semua sesuai patokan", kategori `INITIAL_STOCK_COUNT`, catatan menjadi opsional, validasi variance hanya wajib kategori.
- `handleConfirmOpening`/`handleConfirmClosing`: hanya cek `reason_code`, catatan opsional.

### Phase 4 — Lockout 3x/60s server-authoritative (kode + migration, DB belum diverifikasi)
- Migration `0011_auth_lockout_3x_60s.sql`: RPC `rpc_record_auth_failure`/`rpc_reset_auth_failures`/`rpc_check_auth_limits` diubah ke threshold 3 & lock 60 detik.
- `api/auth.ts`: handler login mengembalikan 429 + `Retry-After` saat terkunci; tipe `AuthLimitResult` + `retry_after_seconds`.
- `src/lib/api.ts`: `request()` membaca header `Retry-After`.
- `src/features/auth/Login.tsx`: lockout dari prop server (`lockoutSeconds`), hapus counter client-side, guard anti dobel submit.
- `src/App.tsx`: state `loginLockSeconds` + countdown dari server, `handleLogin` memetakan 429.

### Phase 9 — Security headers (kode, terverifikasi lint/build)
- `api/health.ts`: `Cache-Control: no-store`.
- `api/auth.ts` & `api/app.ts` `jsonResponse`: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- `vercel.json`: security headers (CSP, X-Frame-Options DENY, nosniff, referrer, permissions policy).

## Gate terakhir
- `pnpm lint` LULUS
- `pnpm test` LULUS (18/18)
- `pnpm build` LULUS
- `pnpm test:e2e` LULUS (10 passed)
- `git diff --check` LULUS
- `pnpm test:db` MASIH TERBLOKIR (Docker)

## Blocker utama
1. `test:db` tidak bisa dijalankan tanpa Docker/staging → migration 0010/0011 BELUM terverifikasi.
2. Migration 0010/0011 BELUM di-push ke production.
3. Production tetap di `92b51d8`; tidak ada deploy dari branch ini.
4. Staging Supabase belum ada.

## Larangan
- Jangan merge/push ke `main` sebelum `test:db` lulus dan migration 0010/0011 terverifikasi.
- Jangan `supabase db push` 0010/0011 ke production.
