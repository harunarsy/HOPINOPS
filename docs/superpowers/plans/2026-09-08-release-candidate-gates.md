# HOPIN Release Candidate Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membuktikan patch remediasi HOPIN sebagai kandidat release melalui pgTAP staging, E2E desktop/mobile, audit independen, audit UX, dan seluruh regression gate sebelum satu commit lokal dibuat.

**Architecture:** `FINAL_OPERATIONAL_READINESS_PLAN.md` tetap menjadi kontrak. Staging Supabase adalah target integrasi mutating; production tetap pada schema `0019` dan artifact `f05e7d2`. Semua temuan diperbaiki test-first, diverifikasi ulang secara terpusat, dan dicatat di `ACTION_LOG.md`.

**Tech Stack:** React 19, TypeScript, Vite 8, Vitest 5, Playwright 1.63, Vercel CLI, Supabase CLI/PostgreSQL/pgTAP.

**Spec:** `FINAL_OPERATIONAL_READINESS_PLAN.md`

## Global Constraints

- Jangan mencetak, menyalin ke repo, atau menyimpan credential Supabase/Vercel di log.
- Mutasi integrasi hanya boleh menuju staging `ibzlxdmnuszcmdzuocwu` dengan guard eksplisit.
- Production `naanarmoktmsumkxmjvj` tetap schema `0019`; jangan migration, deploy, push, atau mengubah alias production pada tahap ini.
- Jangan menghapus atau memindahkan folder/project Vercel sebelum production stabil dan ada izin terpisah.
- Test blocked/skipped/conditional tidak dihitung lulus.
- Perbaikan behavior wajib melalui reproducer gagal, implementasi minimal, lalu regression hijau.
- Perubahan yang bukan milik task ini tidak boleh direvert.

---

### Task 1: Pulihkan pgTAP Staging

**Files:**
- Verify: `supabase/tests/database.test.sql`
- Update: `ACTION_LOG.md`

**Interfaces:**
- Consumes: linked staging project `ibzlxdmnuszcmdzuocwu` dan Supabase CLI session yang sudah login.
- Produces: TAP plan `32` dengan exit code 0, atau blocker environment yang terbukti dan tersanitasi.

- [ ] **Step 1: Reproduksi query read-only dengan CLI pinned terbaru**

Run: `pnpm dlx supabase@2.117.0 db query --linked --project-ref ibzlxdmnuszcmdzuocwu "select current_database(), current_user"`

Expected: query berhasil tanpa meminta password; jika gagal, hanya simpan error code/role/host tanpa credential.

- [ ] **Step 2: Bandingkan jalur `db query` dan `test db`**

Run: `pnpm dlx supabase@2.117.0 test db --linked --project-ref ibzlxdmnuszcmdzuocwu supabase/tests/database.test.sql`

Expected: keduanya konsisten; perbedaan mengisolasi masalah command runner vs temporary database credential.

- [ ] **Step 3: Jalankan pgTAP lengkap**

Run: `pnpm dlx supabase@2.117.0 db query --linked --project-ref ibzlxdmnuszcmdzuocwu --file supabase/tests/database.test.sql`

Expected: `1..32`, seluruh assertion `ok`, tanpa `not ok`, exit code 0.

- [ ] **Step 4: Catat target, versi CLI, assertion count, dan residual risk**

Update `ACTION_LOG.md`; jangan menyebut gate hijau bila command tidak mengeksekusi seluruh assertion.

### Task 2: Fixture E2E Disposable dan Deterministik

**Files:**
- Modify: `scripts/provision-staging-fixtures.mjs`
- Modify: `tests/e2e/fixtures.ts`
- Modify: `tests/e2e/authenticated.spec.ts`
- Modify: `tests/e2e/staff-journey.spec.ts`
- Test: test fixture/provisioner terkait yang paling dekat; tambah hanya bila gap nyata ditemukan.

**Interfaces:**
- Consumes: `E2E_STAGING_PROJECT_REF=ibzlxdmnuszcmdzuocwu`, `E2E_MUTATIONS=1`, staging URL, disposable credentials.
- Produces: run identity unik, fixture account terisolasi, precondition bersih, dan cleanup terverifikasi tanpa menyentuh production.

- [ ] **Step 1: Audit semua setup/cleanup dan state yang dipakai ulang**
- [ ] **Step 2: Tulis reproducer gagal untuk kebocoran state atau guard yang hilang**
- [ ] **Step 3: Implementasikan reset/cleanup minimal dengan pengecekan target staging**
- [ ] **Step 4: Jalankan test terfokus dan buktikan red-green**
- [ ] **Step 5: Provision fixture lalu verifikasi precondition lewat query/API terpisah**

### Task 3: Browser E2E Desktop dan Mobile

**Files:**
- Verify: `playwright.config.ts`
- Verify/modify jika reproducer gagal: `tests/e2e/*.spec.ts`
- Update: `ACTION_LOG.md`

**Interfaces:**
- Consumes: full-stack `vercel dev`, `.env.local` yang tervalidasi menunjuk staging, fixture Task 2.
- Produces: Playwright report desktop/mobile tanpa skipped/conditional pass dan artefak tersanitasi.

- [ ] **Step 1: Validasi hanya project ref dan keberadaan key, tanpa mencetak nilai**
- [ ] **Step 2: Jalankan `vercel dev` pada port test terisolasi**
- [ ] **Step 3: Jalankan seluruh Playwright desktop dan mobile dengan mutation guards**
- [ ] **Step 4: Untuk setiap kegagalan, simpan reproducer dan identifikasi root cause sebelum edit**
- [ ] **Step 5: Ulangi suite penuh sampai exit 0 tanpa skip**

### Task 4: Audit Independen Patch Final

**Files:**
- Review: `supabase/migrations/0022_catalog_generation_snapshots.sql`
- Review: `supabase/migrations/0023_physical_baseline_and_generation_guards.sql`
- Review: `supabase/migrations/0024_self_emergency_replay_first.sql`
- Review: `supabase/migrations/0025_payroll_export_reservations.sql`
- Review: `api/app.ts`
- Review: `src/lib/api.ts`
- Review: `src/features/management/CatalogManager.tsx`
- Review: `src/features/management/ManagementView.tsx`
- Review: `src/features/stock/StockWorkspace.tsx`
- Review: `src/features/reports/ReportsView.tsx`

**Interfaces:**
- Consumes: kontrak B01-B07 dan diff uncommitted terhadap `HEAD`.
- Produces: findings kokoh dengan `file:line`, severity, reproducer, dan status resolved/rejected.

- [ ] **Step 1: Bagi audit per berkas agar reviewer tidak saling menimpa**
- [ ] **Step 2: Audit invariants DB/concurrency/idempotency/grants**
- [ ] **Step 3: Audit API authorization, stale response, export reconciliation, dan error mapping**
- [ ] **Step 4: Audit UI role isolation, cycle freeze, baseline, closing/report, dan state recovery**
- [ ] **Step 5: Verifikasi setiap finding secara mandiri sebelum menerima atau menolak**
- [ ] **Step 6: Perbaiki finding Critical/Important secara test-first**

### Task 5: UX, Accessibility, Responsive, dan Copy

**Files:**
- Review/modify: `src/App.tsx`
- Review/modify: `src/features/assignment/AssignmentScreen.tsx`
- Review/modify: `src/features/management/CatalogManager.tsx`
- Review/modify: `src/features/management/ManagementView.tsx`
- Review/modify: `src/features/reports/ReportsView.tsx`
- Review/modify: `src/features/stock/StockWorkspace.tsx`
- Review/modify: `src/index.css`
- Test: `src/test/*.test.tsx` dan Playwright journeys terkait.

**Interfaces:**
- Consumes: rendered staging UI pada viewport desktop dan mobile.
- Produces: keyboard/focus/dialog/selected-state/contrast/tap-target/reflow/copy evidence serta daftar residual risk.

- [ ] **Step 1: Audit source untuk semantic HTML, ARIA, focus, visible strings, dan loading states**
- [ ] **Step 2: Audit browser desktop/mobile untuk keyboard, focus, overflow, target 44px, dan kontras WCAG AA**
- [ ] **Step 3: Tulis reproducer gagal untuk setiap issue yang akan diperbaiki**
- [ ] **Step 4: Terapkan perbaikan minimal dan jalankan test terfokus**
- [ ] **Step 5: Ulangi audit browser dan dokumentasikan skor/evidence final**

### Task 6: Full Regression dan Commit Kandidat Release

**Files:**
- Verify: seluruh patch.
- Update: `ACTION_LOG.md`

**Interfaces:**
- Consumes: hasil Task 1-5 tanpa blocker Critical/Important.
- Produces: satu commit lokal kandidat release; tidak ada push/deploy production.

- [ ] **Step 1: Fresh apply migration `0001`-`0025` pada database disposable**
- [ ] **Step 2: Jalankan `sh scripts/test-local-db-regressions.sh`**
- [ ] **Step 3: Jalankan `sh scripts/test-local-db-concurrency.sh`**
- [ ] **Step 4: Jalankan `pnpm lint`**
- [ ] **Step 5: Jalankan `pnpm test`**
- [ ] **Step 6: Jalankan `pnpm build`**
- [ ] **Step 7: Jalankan `git diff --check`**
- [ ] **Step 8: Review `git status`, seluruh diff, recent log, dan pastikan tidak ada secret/artefak test**
- [ ] **Step 9: Commit hanya file patch yang telah diverifikasi dengan pesan mengikuti style repo**
- [ ] **Step 10: Catat SHA dan evidence; berhenti untuk meminta izin migration/deploy production**

### Task 7: Rollout dan Konsolidasi Berizin

**Files:**
- Follow: `CONSOLIDATION_PLAN.md`
- Update: `ACTION_LOG.md`

**Interfaces:**
- Consumes: izin eksplisit rollout dan kandidat release Task 6.
- Produces: production migration/deployment yang terobservasi, kemudian konsolidasi terpisah setelah stabil.

- [ ] **Step 1: Minta izin eksplisit migration/deploy production**
- [ ] **Step 2: Setelah diizinkan, backup, dry-run, migration, deploy, smoke, dan observasi sesuai kontrak**
- [ ] **Step 3: Setelah production stabil, inventaris ulang domain/env/cron/storage/webhook/traffic**
- [ ] **Step 4: Minta izin terpisah untuk konsolidasi folder dan pensiun project `webapp`**
- [ ] **Step 5: Jalankan konsolidasi dengan rollback evidence**
