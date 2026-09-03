# HOPIN Action Log

Tanggal: 3 September 2026
Dasar: `PRODUCTION_PLAN.md` dan `AUDIT_REMEDIATION_HANDOFF.md`
Status: **REMEDIASI BERJALAN - REMOTE APPLY/DEPLOY DIBLOKIR**

## Selesai dan Terverifikasi

- Audit codebase dan handoff P0/P1/P2 sudah dibuat.
- `api/app.ts` tidak lagi mengimpor `./auth`; build Vite berhasil.
- Gate cepat terakhir: `pnpm lint`, `pnpm build`, `pnpm test`, dan `git diff --check` lulus.
- RPC operasional, auth rate-limit, and attendance sudah ditulis di migration `0008` dan endpoint terkait sudah diarahkan ke RPC tanpa fallback raw-DML.
- Offline queue sudah dipartisi dengan `profileId`, `outletId`, dan `aggregateId`; closing diblokir saat queue belum selesai.
- Payroll Lifecycle lengkap: RPC `preview`, `review`, `finalize`, `mark_paid`, `void`, dan `export.xlsx` telah diimplementasikan di migration `0008`, di-wire ke `api/app.ts`, client `api.ts`, serta UI manajemen `ManagementView.tsx` dengan kontrol role dan periode bulanan.
- Reset PIN atomik via RPC `rpc_reset_pin` (CSPRNG 6-digit, session revocation) selesai dan tersambung.
- Harness database pgTAP di `supabase/tests/database.test.sql` telah diperbarui dengan 42 signature fungsi terlindungi.

## Sedang Dikerjakan

- Memvalidasi SQL migration `0001`-`0008` pada PostgreSQL nyata.
- Menyelesaikan flow handover, report, bonus, payroll, idempotency, dan conflict handling.
- Mengganti `src/test/db.test.ts` yang hanya membaca teks SQL dengan integration test nyata.
- Memverifikasi auth/session/device, role-negative paths, dan API Preview canary.

## Blocker

- `supabase db reset` belum dapat berjalan karena Docker/Podman tidak tersedia di mesin ini.
- Migration `0008` belum pernah berhasil dieksekusi; validitas SQL dan RPC belum terbukti.
- `pnpm test` saat ini gagal 3 test karena assertions lama mengunci signature/constraint yang sudah berubah; test tersebut bukan DB integration test.
- Remote Supabase terakhir terbukti baru memiliki migration `0001`-`0003`.
- Belum ada Preview deployment, Playwright E2E, staging terpisah, backup/restore drill, atau pilot operasional.

## Larangan Release

- Jangan menjalankan `supabase db push` atau migration remote sebagai pengganti local/staging verification.
- Jangan deploy production, commit, atau push sebelum seluruh gate normatif lulus dan perubahan direview.
- Jangan menganggap `pnpm lint`, unit test, atau build frontend sebagai bukti transaction/privilege SQL benar.

## Berikutnya

1. Sediakan Docker Desktop/Podman atau runner PostgreSQL/Supabase lokal yang setara.
2. Jalankan `supabase db reset`, perbaiki error migration sampai bersih, lalu jalankan pgTAP/integration assertions.
3. Selesaikan residual stock/report/payroll/API dan jalankan lint, test, build, dependency audit, role-negative, concurrency, dan Preview E2E.
4. Lakukan preflight data remote dan backup sebelum mempertimbangkan apply migration.
