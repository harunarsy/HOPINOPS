# HOPIN Remediation Implementation Plan Part 3

## Status Awal

- Repository: `/Users/harunalrasyid/Projects/HOPIN/webapp`
- Branch awal: `main` @ `e2f0983`
- Production migrations: `0001`-`0014` sinkron dengan local.
- Production API hidup: health 200, unauthenticated bootstrap 401, readiness secret-gated.
- Core lint/unit/build lulus; E2E default hanya 6 pass / 10 skipped.
- Historical audit: `AUDIT_REMEDIATION_HANDOFF.md`.
- Prior remediation plan: `REMEDIATION_IMPLEMENTATION_PLAN_PART_2.md`; status snapshot di dalamnya sudah historis/basi.

## Status Berjalan 5 September 2026

- Branch aktif: `remediation/part3`.
- Staging dan production: migration `0001`-`0018` applied.
- `0017` memperbaiki pesan share investor-only dan assignment emergency `PENDING_TASKS`; `0018` menghapus trigger payroll duplikat sehingga satu trigger asli tetap aktif.
- Static gates: lint/test 20/build/diff lulus; pgTAP 18/18 dan authenticated E2E 16/16 desktop/mobile lulus pada staging.
- Production deployment `hopinops-ghll0kzhf-harunarsys-projects.vercel.app` telah dialiaskan ke `https://hopinops.vercel.app`; health/auth/secret-gating/header smoke lulus.
- Belum: restore drill environment disposable, pilot operasional satu hari, dan observability Cron pertama.

## Objective

Menutup requirement yang masih benar-benar belum ada atau belum terbukti dari `PRODUCTION_PLAN.md`, serta menghapus klaim dokumentasi yang tidak sesuai source/runtime.

## Rule

1. Semua migration baru additive mulai `0015`.
2. Tidak ada `db push` production sebelum migration lulus di staging dan pgTAP.
3. Tidak ada merge ke `main` sebelum lint, unit, build, staging DB test, authenticated E2E, dan diff check lulus.
4. Semua mutation baru transactional RPC, audit atomik, browser role tanpa EXECUTE/table access.
5. Tidak ada test yang menulis production data.

## Phase 1: Truth Sync

- Update `ACTION_LOG.md` dengan branch/commit/migration/deploy/gate aktual.
- Update Part 2 menjadi `historical execution record`, bukan active plan.
- Koreksi `PRODUCTION_PLAN.md` section current state dan API inventory agar action tidak diberi `[implemented]` sebelum handler/RPC/UI/test tersedia.

## Phase 2: Migration 0015

Tambahkan secara transaksional:

- `sessions.list`, `sessions.revoke` (self/owner scope, no raw token/IP).
- `opening.saveDraft`, `closing.saveDraft` dengan owner/line/version/idempotency metadata.
- `report.get`, `report.finance.save`, `report.share` dengan draft version, server totals, receipt-only share text.
- `payroll.entry.adjust` dengan source/reason, no self-approval, review state.
- `attendance.checkOut` emergency mode: reason wajib, `REVIEW_REQUIRED`, assignment `PENDING_TASKS`.
- `assignment.complete` dipanggil server-side setelah normal checkout jika task/cycle state sesuai.
- `rpc_get_payroll_export_download` / authorization metadata untuk signed URL endpoint.
- `rpc_rate_limit_public_options` atau equivalent keyed IP rate limit.

## Phase 3: API, Client, UI

- Tambahkan API action dan strict schemas untuk seluruh RPC Phase 2.
- Tambahkan wrapper `src/lib/api.ts`.
- Report screen menggunakan server draft/receipt/share, bukan finance browser sebagai source of truth.
- Stock screen menyimpan draft, manager init reference, dan conflict UI persisten.
- Account/session management di management view.
- Payroll adjustment + signed download UI.
- Emergency checkout UI dengan dampak jelas.

## Phase 4: Runtime Operations

- `api/cron/cleanup.ts` dengan bearer `CRON_SECRET` menjalankan `rpc_cleanup_runtime_data`.
- `api/payroll/download.ts` mengotorisasi actor lalu mengembalikan signed URL TTL <= 5 menit.
- Atur Vercel cron schedule dan environment requirements.
- Pastikan public options rate-limited tanpa identity leak.

## Phase 5: Test Evidence

Tambah pgTAP:

- Session list/revoke scope.
- Opening/closing draft permissions/version/idempotency.
- Report draft/save/share/revision.
- Payroll adjustment/self-review denial.
- Emergency checkout assignment state.
- Public options rate limit.
- Retention cleanup idempotency.

Tambah E2E staging:

- OWNER init reference + operator opening.
- SIANG handover -> MALAM fallback/opening.
- Emergency checkout.
- Supervisor correction/leave/overtime review (no self-review).
- Report draft/save/submit/review/share.
- Payroll adjustment/review/finalize/export/download.
- Session revoke and refresh-proof 3x/60s lockout.

## Phase 6: Rollout

1. Apply `0015` to staging.
2. Run pgTAP, lint, unit, build, authenticated E2E.
3. Deploy Preview and run smoke with deployment protection bypass if needed.
4. Take production backup and preflight query via valid DB credential.
5. Apply production migration, deploy `main`, verify live health/readiness/headers/auth/role smoke.
6. Run restore drill and one-day pilot.

## Definition Of Done

- No stale active documentation status.
- All listed missing actions have RPC + API + client/UI + DB/E2E test.
- `pnpm test:db` runs against staging/local without Docker-only manual workaround.
- E2E has no skipped core role/lifecycle tests in release mode.
- Payroll seven-sheet export has authorized signed download.
- Cleanup schedule exists and is auditable.
- Production status can truthfully be marked fully ready against the revised plan.
