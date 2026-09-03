# HOPIN Production Plan Audit Handoff

Tanggal audit: 3 September 2026
Target commit: `c4e5b6b44856b62c12ab70eddc68b8e10c44c5c8`
Verdict: **REJECTED / NOT PRODUCTION-READY**

Dokumen normatif: `PRODUCTION_PLAN.md`.

## Bukti Verifikasi

| Pemeriksaan | Hasil |
|---|---|
| `pnpm lint` | Lulus |
| `pnpm test` | Lulus, 14 test dalam 6 file |
| `pnpm build` | Lulus |
| `git diff --check` | Lulus |
| `pnpm audit --prod` | Gagal bersih: 1 kerentanan moderate pada `exceljs > uuid` |
| `supabase migration list` | Remote hanya `0001`-`0003`; `0004`-`0008` belum applied |
| Production `/api/health` | HTTP 200 |
| Production `/api/auth?action=me` | HTTP 200, `{ "user": null }` |
| Production `/api/app?action=bootstrap` | HTTP 500 `FUNCTION_INVOCATION_FAILED` |

Test TypeScript/Vitest/build yang hijau tidak memvalidasi SQL, transaksi database, deployed serverless function, atau E2E browser.

## Temuan P0

### P0-1: Business API production crash

- Bukti: `api/app.ts:3` mengimpor `./auth`, dan `api/app.ts:1300` memakai dynamic import `./auth`.
- Bukti live: `GET https://hopinops.vercel.app/api/app?action=bootstrap` menghasilkan HTTP 500 dengan `x-vercel-error: FUNCTION_INVOCATION_FAILED`.
- Plan: `PRODUCTION_PLAN.md:52,266-268,990,995,1296`.
- Dampak: seluruh business API tidak dapat digunakan di production.
- Fix: jadikan function benar-benar self-contained atau ubah bundling/runtime Vercel dan buktikan lewat Preview canary. Jangan hanya mengandalkan Vite build karena Vite tidak membundle Vercel function.

### P0-2: Migration `0008` invalid dan belum pernah dibuktikan berjalan

- `supabase/migrations/0008_commands_privileges_audit.sql:105-107,196` mendeklarasikan `language/security definer/search_path` dua kali pada function yang sama.
- `supabase/migrations/0008_commands_privileges_audit.sql:213,217` mereferensikan `prevent_update_or_delete()`, padahal function yang dibuat bernama `enforce_append_only()` pada baris 11.
- `supabase/migrations/0008_commands_privileges_audit.sql:214-215,218-219` memakai signature yang tidak sama dengan function pada baris 45-56 dan 96-103.
- Remote migration list membuktikan hanya `0001`-`0003` applied.
- Plan: `PRODUCTION_PLAN.md:450-460,968-981,1294`.
- Dampak: revoke/grant, trigger, index, dan RPC tidak aktif di production; source migration juga sangat mungkin gagal saat dieksekusi.
- Fix: perbaiki DDL/signature lalu jalankan fresh local reset dan upgrade-path test. Jika migration ini pernah applied di environment lain, buat migration additive baru, jangan edit migration applied.

### P0-3: Critical commands bukan transactional RPC dan authorization dapat dilewati

- Hanya ada satu command RPC, `rpc_claim_assignment`, pada `0008_commands_privileges_audit.sql:96-196`.
- RPC menerima `p_outlet_id` dan `p_profile_id` tanpa membaca ulang actor aktif, role, outlet scope, forced-PIN state, atau authorization pada `0008_commands_privileges_audit.sql:115-187`.
- `api/app.ts:372-460` fallback ke pre-check dan raw DML ketika RPC error, sehingga row lock/audit atomic hilang.
- Swap, attendance, opening, movement, closing, report, bonus, payroll, dan user creation memakai beberapa query/DML terpisah; contoh `api/app.ts:338-352,588-644,726-758,811-847,884-956,1021-1052,1219-1254,1302-1324`.
- Audit adalah best-effort dan error ditelan pada `api/app.ts:84-117`.
- Plan: `PRODUCTION_PLAN.md:49,73-75,273-285,454-457,729-735,1226`.
- Dampak: partial write, race, actor spoofing di RPC, state corruption, dan mutation sukses tanpa audit.
- Fix: buat transactional command RPC per aggregate/critical transition. Setiap RPC wajib lock aggregate, re-read actor/role/outlet/state, cek ownership/self-approval/idempotency/version, mutate, dan audit dalam transaksi yang sama. Hapus seluruh fallback raw DML.

### P0-4: Attendance/GPS/check-out tidak memenuhi state machine

- Challenge tidak diikat ke session/device pada `api/app.ts:497-510`.
- Check-in hanya mengecek challenge ID/profile; nonce dan action `CHECK_IN` tidak diverifikasi pada `api/app.ts:522-525`.
- Challenge dikonsumsi sebelum event tersimpan dan bukan transaksi pada `api/app.ts:588-635`.
- Sample tidak dibatasi 1-3 dan tidak divalidasi range/accuracy/timestamp pada `api/app.ts:546-582,624-634`.
- Check-out tidak memvalidasi challenge sama sekali, memilih sample pertama, tidak mewajibkan note untuk unverified, selalu menetapkan `CHECKED_OUT`, dan menulis `scheduled_end_at` sebagai waktu sekarang pada `api/app.ts:649-695`.
- Frontend hanya meminta challenge untuk check-in pada `src/features/attendance/SwipeAttendance.tsx:72-85`; kontrak `checkOut` tidak memiliki challenge pada `src/lib/api.ts:68-73`.
- Tidak ada overtime candidate, missing-checkout derivation, emergency checkout, atau assignment `PENDING_TASKS`.
- Plan: `PRODUCTION_PLAN.md:146-179,420-428,490-495,560-575,624-644,696-705,739-748,1244-1247`.
- Fix: implementasikan RPC atomic challenge consumption + event + samples + audit untuk check-in/out, server-derived schedule/risk/status/overtime, stable error codes, dan semua denied/timeout/unavailable paths.

### P0-5: Stock dan report dapat menghasilkan fakta palsu/tidak konsisten

- Confirmed opening dan closing memakai upsert, sehingga dapat ditimpa pada `api/app.ts:726-748,811-837`.
- Closing mempercayai `opening_qty`, incoming/outgoing, dan `system_qty` dari client pada `api/app.ts:822-835`.
- Cutoff dan closing bukan satu transaksi pada `api/app.ts:811-839`.
- UI menganggap default saldo sistem sebagai physical count walau user tidak pernah mengisi pada `src/features/stock/StockWorkspace.tsx:128-137,206-219,323-326,437-440`.
- Handover SIANG dan movement correction tidak tersedia di API/client; `src/lib/api.ts:75-80` hanya memiliki opening confirm, movement create, dan closing confirm.
- Report membaca closing BAR/KITCHEN tetapi tidak menolak nilai null pada `api/app.ts:880-919`.
- Report snapshot mengisi semua item dengan `closing_qty: 0` dan `stock_status: 'AMAN'` pada `api/app.ts:934-945`.
- Report baru disimpan dengan `current_revision: 1`, lalu dihitung `+1`, sehingga revision pertama menjadi `R02` pada `api/app.ts:884-902`.
- Trigger `0008` melarang update revision `SUBMITTED` pada `0008_commands_privileges_audit.sql:32-37`, sedangkan review mencoba update revision tersebut pada `api/app.ts:961-982`.
- Plan: `PRODUCTION_PLAN.md:181-211,409,497-503,576-599,648-674,1021-1040,1229-1230`.
- Fix: pindahkan reference/balance/cutoff/snapshot ke RPC, wajibkan explicit physical count dan reason/note, implementasikan handover/correction, serta modelkan review metadata/state transition tanpa mengubah payload revision immutable.

### P0-6: Bonus/payroll/XLSX bukan evidence-first

- Bonus tidak memastikan report `APPROVED`, tidak memastikan assignment valid, dan dapat membuat pool `FINAL` saat participant nol pada `api/app.ts:996-1044`.
- Final allocation memakai upsert sehingga tidak immutable pada `api/app.ts:1033-1043`.
- Payroll lifecycle `preview/adjust/review/finalize/paid/void` tidak ada; hanya export pada `api/app.ts:1057-1261`.
- Export menghitung live dari tabel, bonus/adjustment tidak difilter period/outlet, dan gross hanya `base + bonus` pada `api/app.ts:1067-1109`.
- Export mencoba upsert run tanpa `policy_id` yang wajib dan memakai conflict key yang tidak memiliki unique constraint pada `api/app.ts:1219-1226` dibanding `0007_reports_payroll.sql:104-117`.
- XLSX hanya memakai sebagian kecil kolom wajib pada `api/app.ts:1084-1204`.
- File tidak di-upload ke private storage; path hanya dicatat lalu file dikirim base64 pada `api/app.ts:1214-1260`.
- Plan: `PRODUCTION_PLAN.md:213-248,438-448,591-608,676-727,827-849,1059-1072,1253-1262`.
- Fix: implementasikan payroll run snapshot dan lifecycle RPC lengkap, blockers/evidence/no-self-approval, immutable finalization, private bucket + signed URL, exact seven-sheet schema, metadata header/freeze/filter/format/reconciliation.

### P0-7: Offline queue tidak aman dan tidak memenuhi retry contract

- Queue hanya menyimpan `id/action/payload/createdAt/status` pada `src/lib/idb-queue.ts:6-12`; tidak ada profile/outlet, aggregate, base version, attempts, last error, conflict, atau receipt.
- Store global membuat payload user lama dapat dibaca/disinkronkan user berikutnya pada `src/lib/idb-queue.ts:14-51`.
- Replay tidak menjamin FIFO per aggregate, tidak punya exponential backoff/jitter, dan berhenti pada error pertama pada `src/features/stock/StockWorkspace.tsx:64-95`.
- Semua error online, termasuk 400/403/409, dimasukkan queue pada `src/features/stock/StockWorkspace.tsx:166-185`.
- Closing hanya melihat count global; report tidak memeriksa queue terkait cycle pada `src/features/stock/StockWorkspace.tsx:193-202` dan `src/features/reports/ReportsView.tsx:32-43`.
- Plan: `PRODUCTION_PLAN.md:737-778,907,1022-1025,1248`.
- Fix: redesign schema/upgrade IndexedDB, partition per profile+outlet, FIFO per aggregate, retry hanya network/5xx/429, 409 ke state conflict, dan server-side queue blockers untuk finalization.

### P0-8: Mandatory release gates dan cutover evidence tidak ada

- `package.json:6-13` tidak memiliki `test:db` dan `test:e2e`; Playwright/config/DB-test files tidak ada.
- Delapan dari 14 test menduplikasi logic di test, bukan menguji production: `src/test/domain.test.ts:5-32,66-79`, `src/test/excel.test.ts:5-39`, `src/test/timezone.test.ts:21-34`, dan `src/test/smoke.test.ts`.
- Tidak ada bukti fresh DB reset, upgrade path, privilege/RPC tests, concurrent race, deployed E2E, staging terpisah, pilot satu hari, backup/restore, role smoke, reconciliation, atau first-day monitoring.
- Remote migration hanya `0001`-`0003`, dan deployed business API crash.
- Plan: `PRODUCTION_PLAN.md:876-931,937-981,1088-1141,1264-1272,1285-1308`.
- Fix: blokir release; bangun DB integration dan Playwright E2E terlebih dahulu, lalu jalankan seluruh staging/pilot/cutover gate dengan artefak output nyata.

## Temuan P1

### P1-1: Auth hardening hanya parsial

- Lockout credential masih read-then-update dan bukan atomic pada `api/auth.ts:182-201`; IP/device rate limit tidak digunakan.
- Endpoint public options tidak rate-limited pada `api/auth.ts:150-159,496-503`.
- Login hanya mengirim session cookie; `deviceCookie()` tidak pernah dipakai pada `api/auth.ts:473-475,529-532`.
- Device lookup tidak dibatasi profile atau `revoked_at` pada `api/auth.ts:228-240`.
- Reset PIN memakai `Math.random()`, tidak menjaga history/pin_version, dan dapat menghasilkan PIN lemah pada `api/auth.ts:427-438`.
- Change PIN tidak revoke session lain atau rotate current session pada `api/auth.ts:334-406`.
- Response auth tidak mengikuti envelope/request ID/stable error plan pada `api/auth.ts:481-579`.
- Plan: `PRODUCTION_PLAN.md:115-126,273-316,369-385,515-530,851-874`.

### P1-2: API boundary dan action inventory jauh dari lengkap

- `api/app.ts` hanya memiliki 26 branch action pada `api/app.ts:145-1327`; puluhan action wajib di `PRODUCTION_PLAN.md:532-608` tidak ada.
- `roster.list` tidak membatasi self/manager/outlet dan mengembalikan data seluruh roster pada `api/app.ts:272-280`.
- `assignment.claim` menerima semua authenticated role dan memilih outlet pertama, bukan scope user, pada `api/app.ts:367-380`.
- `movement.create` tidak memeriksa assignment/role/area/item-area pada `api/app.ts:763-783`.
- Mutasi memakai `request.json() as any` tanpa method registry, content-type/body limit, strict schema, numeric/string bounds, `expected_version`, atau required client idempotency key.
- Plan: `PRODUCTION_PLAN.md:273-316,511-608,729-735,862`.

### P1-3: Frontend workflow management/roster/report/payroll belum lengkap

- Assignment UI tidak menampilkan roster comparison, deviation warning, atau helper offer; error memakai native `alert` pada `src/App.tsx:102-116`.
- Management nav hanya menyediakan ringkasan, attendance read-only, export, dan reset PIN pada `src/features/management/ManagementView.tsx:120-285`.
- Report UI langsung submit; tidak mempunyai draft/version/readiness/revision/clarification/review dan share berasal dari draft client pada `src/features/reports/ReportsView.tsx:32-57`.
- Payroll UI hanya tombol export pada `src/features/management/ManagementView.tsx:212-235`.
- Bootstrap error ditelan dan dapat fail-open ke state kosong pada `src/App.tsx:33-68`.
- Plan: `PRODUCTION_PLAN.md:780-825,998-1085,1187-1198,1241-1262`.

### P1-4: Security/operations runtime belum lengkap

- Production root hanya menunjukkan HSTS; tidak ada bukti CSP, frame-ancestors, nosniff, referrer policy, atau geolocation permissions policy.
- Production `/api/health` memakai `Cache-Control: public`, dan endpoint readiness tidak ada.
- `.env.example:1-6` tidak mendokumentasikan `APP_ALLOWED_ORIGIN`, `SESSION_HASH_PEPPER`, `VITE_APP_ENV`, atau `CRON_SECRET` bila cleanup digunakan.
- `pnpm audit --prod` menemukan satu advisory moderate pada `exceljs > uuid`.
- Plan: `PRODUCTION_PLAN.md:851-874,1088-1101,1143-1160,1177-1215,1269`.

## Temuan P2

### P2-1: UX/a11y/onboarding dan display WIB belum memenuhi target

- Native `alert/confirm` masih dipakai pada `src/App.tsx:114-116` dan `src/features/management/ManagementView.tsx:78-83`.
- Slider attendance tidak mempunyai accessible name pada `src/features/attendance/SwipeAttendance.tsx:191-206`.
- Beberapa label form tidak terasosiasi dengan input; modal tidak memiliki semantics/focus management yang cukup.
- Timestamp movement memakai timezone browser lalu diberi label WIB pada `src/features/stock/StockWorkspace.tsx:412`.
- Onboarding hardcode version 1, error completion tetap dianggap selesai, dan materi/replay belum lengkap pada `src/features/onboarding/StaffOnboarding.tsx:8-47`.
- Plan: `PRODUCTION_PLAN.md:250-258,780-825,914-916,1074-1085,1249-1251`.

### P2-2: Dokumentasi status bertentangan dengan kenyataan

- `EXECUTION_REPORT.md:4-5,56-79` menyatakan seluruh DoD terpenuhi.
- `ACTION_LOG.md` sebelumnya menyatakan production-ready.
- `README.md:1-3,42-46` dan `UX-CONTRACT.md:1-5,57-63` masih mendeskripsikan local prototype.
- `walkthrough_remediation_hopin.md` yang pernah disebut tidak ada.
- `premium-audit.json:1-13` hanya berisi nol temuan tanpa timestamp, tool, scope, target commit, atau output.
- Plan: `PRODUCTION_PLAN.md:1271-1272,1310-1328`.

## Kontrol yang Sesuai atau Parsial

| Kontrol | Status | Bukti |
|---|---|---|
| Frontend hanya memakai same-origin `/api` | Sesuai | `src/lib/api.ts:13-92` |
| Tidak ada operational `localStorage/sessionStorage` di source aktif | Sesuai | Pencarian source menghasilkan nol penggunaan |
| Login picker payload hanya username/display name | Sesuai | `api/auth.ts:150-159` |
| PBKDF2 310k dan byte-wise constant-time compare | Sesuai | `api/auth.ts:102-133` |
| Session cookie production `__Host-`, Secure, HttpOnly, SameSite=Lax | Sesuai | `api/auth.ts:18-20,463-470` |
| Origin guard dipanggil pada auth/app | Parsial | `api/auth.ts:38-76,488-492`; `api/app.ts:120-125`; exact allowlist/config/test E2E belum lengkap |
| WIB date/minute helper | Sesuai untuk helper | `api/app.ts:53-69`; scheduled timestamp/state masih salah |
| Partial unique PRIMARY dan cycle row lock primitive | Parsial | `0005_operations_v2.sql:56-64`; `0008_commands_privileges_audit.sql:117-137`; migration/RPC tidak valid/authorized |
| Finance formula dasar | Sesuai untuk formula | `api/app.ts:904-907`; transaksi/snapshot belum sesuai |
| Bonus tier dan deterministic remainder | Sesuai untuk formula | `api/app.ts:1004-1010,1029-1043`; eligibility/finalization belum sesuai |
| Tujuh nama sheet, sanitizer, SHA-256 | Parsial | `api/app.ts:71-81,1084-1217`; schema/storage/snapshot belum sesuai |
| Unit lint/build | Sesuai untuk gate yang tersedia | 14 test lulus, TypeScript dan Vite build lulus |
| Auth function production | Live | `/api/auth?action=me` HTTP 200 |
| Business API production | Gagal | `/api/app?action=bootstrap` HTTP 500 |

## Urutan Fix untuk Model Berikutnya

1. Turunkan status release ke `BLOCKED`; jangan migration/deploy ulang sebelum gate lengkap.
2. Perbaiki bundling `api/app.ts` dan buktikan `/api/app?action=bootstrap` tidak crash di Vercel Preview.
3. Perbaiki migration `0008`, lalu tambahkan authorization helper dan transactional RPC lengkap. Jalankan fresh reset serta upgrade-path DB tests.
4. Harden auth secara atomic: credential/IP/device limiter, CSPRNG reset PIN/history, device cookie binding, session rotation, dan auth action inventory.
5. Implement attendance/check-out GPS RPC atomic dan missing/overtime/emergency state machine.
6. Implement stock handover/correction/cutoff dan report snapshot/revision secara transactional.
7. Implement bonus/payroll evidence lifecycle dan private XLSX storage dari immutable run snapshot.
8. Redesign offline queue dengan profile/outlet isolation, FIFO, backoff, conflict UX, dan finalization blockers.
9. Lengkapi API inventory, RBAC negative checks, frontend management/roster/report/payroll/onboarding, dan a11y.
10. Tambahkan `test:db` dan Playwright E2E yang menguji implementation asli, lalu staging, pilot satu hari, backup/restore, role smoke, reconciliation, dan baru production cutover.

## Exit Criteria

Jangan ubah status menjadi production-ready sampai seluruh command di `PRODUCTION_PLAN.md:920-929` tersedia dan lulus, migration remote/staging sesuai, Preview canary lulus, seluruh P0 di atas tertutup oleh test nyata, serta `EXECUTION_REPORT.md` berisi bukti yang diwajibkan pada `PRODUCTION_PLAN.md:1310-1328`.
