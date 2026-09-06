# HOPIN Action Log

## E7 Selesai: Gerbang Integrasi Staging + Laporan Akhir (6 Sep 2026)
- Baseline akhir (belum di-commit, menunggu izin): lint LULUS, test 46/46 (14 file) LULUS, build Vite 8 LULUS (JS 412.60 kB/gzip 111.82 kB), diff-check LULUS, pgTAP plan(26) LULUS di staging.
- Staging API nyata via vercel dev terisolasi (.env.local staging terverifikasi, NODE_ENV=test untuk CSRF): investor-denial + init-403 LULUS, logout-revocation (401 pasca-logout + idempoten) LULUS, B04 once-only + payload-400 LULUS, lifecycle claim→opening→movement LULUS (ekspektasi init dimutakhirkan ke B06 setelah temuan 500 pada ekspektasi lama).
- Browser journey desktop LULUS (`staff-journey.spec.ts`): login → 8 interaksi latihan → simpan → claim KITCHEN → check-in GPS terkontrol → Workspace Kitchen, API/RPC staging sungguhan (GPS simulasi browser, bukan perangkat fisik).
- Init baseline nyata: OPERATOR PRIMARY BAR APPROVED (via API) + Supervisor KITCHEN APPROVED → AVAILABLE 6 baris (via API).
- Mobile 360px: login → langsung Workspace Kitchen (B04 skip + sesi desktop masih aktif) + screenshot responsif; header/menu/tabel terpotong scroll horizontal sesuai CSS. Full click-journey mobile belum hijau karena balapan fixture (reset gabungan tak terverifikasi), bukan bug aplikasi — residual tercatat.
- Reset fixture terverifikasi: hapus progress operator2 terkonfirmasi count=0 via query terpisah (hindari multi-statement satu panggilan).
- Restore drill disposable: TERBLOKIR (tidak ada project disposable; hanya staging+production). Eksekusi cron production: TERBLOKIR (mutasi production). Keduanya masuk daftar tunggu izin.
- MENUNGGU IZIN EKSPILISIT: (1) migration production 0020/0021; (2) commit/push/deploy perubahan E0–E7; (3) restore drill disposable; (4) verifikasi cron production; (5) hentikan trigger + hapus project `webapp` + konsolidasi folder; (6) pilot produksi. Tidak ada tindakan tersebut dijalankan tahap ini.

## E6 Selesai: Inventaris Root + Vercel (Tanpa Pindah/Hapus) (6 Sep 2026)
- Root lokal `/Users/harunalrasyid/Projects/HOPIN`: `webapp/` (repo aktif + `.git`), `webapp-fallback/` (demo statis 4 file), `output/pdf/`, `tmp/pdfs/`, `.pnpm-store/`. Tidak ada git repo lain; tidak ada file dipindah/dihapus tahap ini.
- `hopinops` (prj_m2oQefN2N52iuSuaoZU8srtoBHKG): Root Directory `.`, Vite, iad1, Production Ready `hopinops-qdy8hwzhb` (alias `hopinops.vercel.app` + `git-main`), 5 functions termasuk cleanup. Env Production: APP_ALLOWED_ORIGIN, CRON_SECRET, READINESS_SECRET, PAYROLL_EXPORT_BUCKET, SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_SUPABASE_URL (nama + environment dicatat; nilai tidak disalin ke log).
- `webapp` (prj_tNGLAKJxGWAGPJtfvliOBK4C64N0): Root Directory `.`, Vite, iad1, Production Ready `webapp-8xdemd8r7` 10:57:52 WIB + alias `git-main`. Kedua project deploy repo+branch yang sama pada detik yang sama.
- Temuan penting: kedua project membaca `vercel.json` yang sama → cron cleanup berpotensi berjalan ganda. Env/cron/storage/webhook/traffic project `webapp` belum terpetakan (butuh dashboard/API; tidak dilakukan agar tidak mengubah state).
- Menunggu izin eksplisit: pemindahan folder ke root tunggal, penghentian trigger + penghapusan project `webapp`, serta verifikasi domain/env/cron/storage sebelum itu.

## E5 Selesai: Upgrade Bertahap + Gate per Batch (6 Sep 2026)
- Batch aman LULUS: supabase-js 2.115.0, playwright 1.63.0, happy-dom 20.14.0, types/react-dom 19.2.7.
- Batch kompatibilitas LULUS: vitest+coverage 5.0.0, vite 8.2.2 + plugin-react 6.1.1 (vite/plugin dikembalikan ke `dependencies` agar build Vercel aman).
- TypeScript 7.0.2 GAGAL gate (lint: `global`/`process` tak dikenali di api_client tes + e2e fixtures) → revert ke ~5.8.3 sesuai kontrak (catat blocker, bukan paksakan). Pinned Node 24 + pnpm 11.23 runtime lokal.
- Audit prod: tidak ada kerentanan dikenal. Build: JS 412.60 kB (gzip 111.82 kB).
- Gates: `pnpm lint` LULUS, `pnpm test` 46/46 (14 file) LULUS, `pnpm build` (Vite 8) LULUS, `git diff --check` LULUS.
- Blocker tercatat: TS 7 butuh penyesuaian types config; Playwright 1.63 butuh unduh browser sebelum e2e (masuk E7).

## E4 Selesai: Copy Awam + A11y + Layout + Ukur Awal (6 Sep 2026)
- Copy terkunci diterapkan: hapus `Otomatis terselubung`; latihan sinkronisasi → `Saat internet terputus`/`Coba tanpa internet`/`Sambungkan internet`/`Periksa catatan yang perlu diperbaiki`/`Catatan sudah diperiksa. Anda bisa melanjutkan.`; patokan → `Patokan stok awal belum disiapkan. Supervisor dapat menyiapkannya dari dashboard...`; darurat B05 sudah di E3.
- Ulangi latihan dipisah sekunder two-tap (`Ulangi latihan dari awal` → `Ketuk lagi...`) + catatan bantuan; navigasi membatalkan arm. Pilihan aktif: border tegas + centang ✓ + `aria-pressed` + sr-only `(dipilih)`.
- Header workspace: aksi sekunder (Kelola/Laporan/Check-out darurat/Keluar) masuk menu akun `<details>`; avatar sebagai summary berlabel. Escape menutup dialog konfirmasi logout + darurat (non-submit).
- CSS: `.table-responsive{overflow-x:auto}` + menu akun + min 560px tabel mobile. Fondasi responsif/fokus (focus-visible, target ≥44px, breakpoint 650px) sudah ada dan dipertahankan.
- Ukur jujur (sampel tunggal, bukan benchmark): build JS 416.80 kB (gzip 114.73 kB), CSS 37.46 kB (gzip 8.21 kB); production `/api/health` 200 dalam 0.89s, bootstrap-tanpa-sesi 401 dalam 1.14s. p50/p95, cold/warm, RTT server–DB, metrik browser masuk E7 Playwright.
- Gates: `pnpm lint` LULUS, `pnpm test` 46/46 (14 file; replay two-tap + Escape + copy) LULUS, `pnpm build` LULUS, `git diff --check` LULUS.
- Belum dibuktikan: audit keyboard penuh per dialog, kontras terukur, metrik browser nyata (E7).

## E3 Selesai: Darurat Mandiri + Laporan Gabungan + Payroll Guard (6 Sep 2026)
- Migration `0021_self_emergency_checkout_b05.sql` applied ke staging. `rpc_self_emergency_checkout` khusus OPERATOR, target dari sesi server (tanpa ID arbitrary), idempoten via `workflow_idempotency`, audit atomik. RPC manager tidak diubah. Production belum disentuh.
- API `attendance.selfEmergencyCheckout` (OPERATOR-only, tanpa attendance_id) + klien `api.selfEmergencyCheckout`. UI pribadi App dialihkan ke jalur mandiri dengan copy terkunci (`Check-out darurat`, alasan, `Catat check-out darurat`/`Kembali`, receipt menunggu peninjauan). Error checkout-tercatat diarahkan ke pemulihan completion, bukan emergency ulang.
- Laporan: seksi `Ringkasan Stok Area` dari snapshot server per BAR/KITCHEN + catatan kesiapan diperiksa server; non-finalizer ditegaskan hanya melihat (submit terkunci + alasan).
- Payroll: F05 stale-guard requestId (respons basi dibuang, reload tab unifikasi); F06 validasi bulan kalender nyata + tolak export run tanpa entri (409); F07 pre-check receipt existing (replay tanpa file ganda, konflik checksum → 409) + toast replay di UI.
- Gates: `pnpm lint` LULUS, `pnpm test` 45/45 (14 file; baru `reports_summary.test.tsx`) LULUS, `pnpm build` LULUS, `git diff --check` LULUS, pgTAP `plan(26)` LULUS (2 assertion B05 baru).
- Belum dibuktikan: journey check-in→emergency→review→recovery lintas hari di browser staging + payroll periodik penuh (masuk E7).

## E2 Selesai: Refresh Aman, Antrean Terjaga, Logout Konfirmasi (6 Sep 2026)
- U04 ditutup di source: `loadBootstrap(background)` mengembalikan boolean; refresh latar tidak pernah melempar dan tidak pernah mengganti layar (tanpa `BOOTING`/takeover). Banner non-blokir `Data mungkin belum terbaru` + tombol `Muat ulang` bila refresh latar gagal.
- `handleResolveConflict` hanya menghapus antrean setelah refresh terbukti sukses; gagal = antrean utuh + pesan `tetap tersimpan`. Discard eksplisit dibedakan dari receipt sukses. Handover/init/correction/closing/opening-confirm ikut cek boolean (sukses server + warning refresh, bukan sukses palsu).
- Logout tidak membuang kerja diam-diam: workspace melaporkan antrean tak-tersinkron + hitungan belum-konfirmasi; dialog `Tetap keluar akun?` menjelaskan antrean tetap di perangkat tak-terlihat pengguna berikut vs hitungan bisa hilang. `handleLogout` tanpa argumen agar click-event tak terbaca sebagai konfirmasi (bug event-as-force diperbaiki sebelum merge).
- `ReportsView.onRefresh` boolean; gagal = warning `Workspace gagal diperbarui`, layar laporan tetap.
- Gates: `pnpm lint` LULUS, `pnpm test` 42/42 (13 file; baru `queue_conflict.test.tsx` 2 skenario + 1 skenario dirty-logout di staff_flow) LULUS, `pnpm build` LULUS, `git diff --check` LULUS.
- Belum dibuktikan: skenario offline/reconnect browser nyata + response-loss retry tanpa ganda (masuk E7 staging journey).

## E1 Selesai: Katalog + Checklist Server + Baseline PRIMARY (6 Sep 2026)
- Migration `0020_catalog_checklist_b05_b07.sql` applied ke staging `ibzlxdmnuszcmdzuocwu`. Production belum disentuh (menunggu izin).
- B01: `rpc_create/update/archive_item` kini Owner+Supervisor (dulu Owner-only); cycle-lock B02 dipertahankan. B07: `rpc_operator_create/archive_item` scoped PRIMARY area tugas aktif. B06: `rpc_initialize_stock_reference` boleh PRIMARY cycle (+Owner/Supervisor tetap).
- Checklist server: tabel `checklist_sections/layouts/item_placements/layout_ops` + RPC get/upsert/move (expected_version + idempotency + audit). Investor ditolak di semua RPC checklist.
- API: gate items.* dibuka untuk Supervisor; aksi baru `items.operatorCreate/operatorArchive`, `checklist.layout/get`, `checklist.section.upsert`, `checklist.item.move`; `opening.initialize` API dibuka untuk Operator (RPC menegakkan PRIMARY; HELPER/Investor ditolak).
- UI: tab Katalog di ManagementView (Owner/Supervisor; Investor tidak ada tab) + tombol `Siapkan patokan cycle` per cycle ACTIVE di dashboard + workspace urut server per bagian dengan label bagian (fallback urutan prop bila layout gagal).
- Gates: `pnpm lint` LULUS, `pnpm test` 39/39 (12 file, termasuk `catalog.test.tsx` baru) LULUS, `pnpm build` LULUS, `git diff --check` LULUS, pgTAP `plan(24)` LULUS (3 assertion investor-denial B01/B07 baru).
- Belum dibuktikan: dua-perangkat snapshot-identik browser + init baseline nyata end-to-end (masuk E7); production migration 0020 (menunggu izin).

## E0 Selesai: Evidence Dibekukan, Docs Diselaraskan, Pagar Skrip (6 Sep 2026)
- HEAD `f05e7d2`, worktree: 2 file docs pengguna (ACTION_LOG, FINAL plan) dipertahankan + 2 file E0 saya (DESIGN.md, concurrency guard). Tidak ada commit/push pada tahap ini.
- Deploy: `hopinops-qdy8hwzhb` Production Ready 10:57:52 WIB, alias `hopinops.vercel.app` + `git-main`, 5 functions termasuk cleanup, iad1. `webapp-8xdemd8r7` juga Ready — mapping trigger tetap wajib dicek di E6 sebelum simpulkan.
- Migration ledger staging (linked `ibzlxdmnuszcmdzuocwu`): 0001–0019 sinkron. Production 0019 sesuai laporan audit sebelumnya, belum re-query mandiri tahap ini (butuh link switch; ditunda agar tidak kotor worktree).
- DESIGN.md:97-102 diperbaiki minimal — FINAL plan dinyatakan sumber kebenaran server-first; baris demo lokal ditandai historis. Identitas visual tidak diubah.
- Skrip concurrency dipagar: allowlist staging + `E2E_ALLOW_MUTATION=1` + cleanup deactivate terverifikasi. Tidak dijalankan ulang tahap ini.
- Gates: `pnpm lint` LULUS, `pnpm test` 36/36 (11 file) LULUS, `pnpm build` LULUS (400.82 kB / gzip 110.43 kB), `git diff --check` LULUS, pgTAP `plan(21)` LULUS via `supabase db query --linked` (rollback, tanpa mutasi persisten).
- Blocker E0 tersisa: parity fungsi staging vs production belum re-query mandiri; mapping Git integration kedua project belum inventaris (masuk E6).

## Default Eksekusi Ditetapkan Koordinator

- Harun meminta opsi terbaik untuk tiga pertanyaan pelaksana: gunakan 'Check-out darurat' dengan penjelasan tugas tetap pending; upgrade major setelah alur E1-E4 stabil dalam batch kompatibilitas berurutan; rehearsal staging lalu pilot satu outlet satu hari Siang-Malam lengkap dan terawasi.
- Keputusan dan acceptance tambahan dicatat pada FINAL_OPERATIONAL_READINESS_PLAN.md: jangan menghilangkan hak katalog PRIMARY B07, backlog payroll E3, distinction discard vs receipt pada E2, atau salah mengisi Vercel Root Directory menjadi dua titik (yang benar satu titik).
- Tahap ini hanya menyelaraskan plan dan log, bukan implementasi aplikasi/upgrade/deploy atau pelaksanaan pilot. Izin rollout/delete tetap terpisah.

## Keputusan Final B05-B07: 6 September 2026

- Tambahan Harun: susunan barang/bagian adalah konfigurasi bersama server-owned, tidak hardcoded atau lokal per browser. Supervisor melihat susunan dan versi yang sama dengan staf untuk cycle yang sama; susunan pending shift berikutnya dibedakan. RPC reorder transactional dengan version check/idempotency/audit dan tes dua perangkat diwajibkan dalam plan; belum diimplementasikan pada tahap dokumentasi ini.
- Harun menyetujui Operator check-out darurat untuk dirinya sendiri, dengan reason/review/tugas pending; manager-on-behalf tetap jalur berbeda. Tidak otomatis approval atau menyelesaikan stok/payroll.
- Harun menyetujui PRIMARY menyiapkan stok fisik pertama serta tambah/archive dan urutkan daftar barang per bagian lemari/lokasi dalam area tugas. Checklist server-owned, identitas barang dan histori tetap utuh. Helper tidak otomatis dinaikkan kewenangannya.
- Kontrak lengkap, pengecualian setup pertama terhadap cycle freeze, scope/replay/concurrency dan acceptance ada di FINAL_OPERATIONAL_READINESS_PLAN.md bagian B05-B07. Keputusan ini menggantikan pertanyaan pending dan aturan manager-only baseline lama.
- Plan E0-E7 sudah final untuk eksekusi dengan B05-B07; detail share sementara investor tetap deferred, approved-only berjalan. Folder/Vercel tetap bagian E6 dan bukan izin delete/deploy.
- Tahap ini hanya finalisasi dokumen; implementasi B05-B07 belum dikerjakan dan status aplikasi tetap BELUM SIAP OPERASIONAL PENUH.

## Status Aktif: Audit Terpadu 6 September 2026, Pasca f05e7d2

- Sumber eksekusi tunggal: FINAL_OPERATIONAL_READINESS_PLAN.md bagian 0, E0-E7. CONSOLIDATION_PLAN.md adalah lampiran prosedur. Entri di bawah adalah histori, bukan status aktif bila bertentangan.
- HEAD f05e7d2, perubahan Tahap B 3ed63dc sudah committed; worktree bersih sebelum audit ini. Verifikasi ulang lint (termasuk api), 36/36 test 11 file, build semuanya lulus.
- Ledger read-only project-ref eksplisit: staging ibzlxdmnuszcmdzuocwu DAN production naanarmoktmsumkxmjvj mencatat 0019. Tidak menjalankan ulang pgTAP atau concurrency mutating script pada audit ini.
- Vercel hopinops-qdy8hwzhb dan webapp-8xdemd8r7 sama-sama Ready, production, waktu 10:57:52 WIB, alias git-main. Mapping Git integration/SHA dan dependensi cron/domain masih perlu inventaris sebelum memutus trigger project webapp.
- pnpm audit --prod tidak menemukan advisory dikenal; pnpm outdated menemukan update minor dan major, detail baseline/strategi E5 ada di plan. Dependency belum diubah.
- Blocker nyata: self emergency CTA selalu ditolak role/self guard; operator baseline belum diizinkan dan manager belum punya aksi dashboard langsung; katalog Supervisor belum tersedia; global refresh/queue discard dan report sequence belum aman/jelas.
- Penutupan Tahap B belum terbukti penuh: concurrency script tanpa staging guard/finally, Promise.all belum membuktikan overlap transaksi; tes logout belum membuktikan token lama revoked; lock SQL aktual profiles -> outlet_settings -> onboarding_progress, bukan urutan pada laporan lama.
- Impeccable audit menemukan DESIGN.md:97-102 masih mengatur demo lokal/larangan security production; harus diselaraskan sebelum menjadi petunjuk desain. Screenshot tidak dapat dibaca, browser/a11y/performance lengkap belum dijalankan. Health 200 satu sampel 0.98 s bukan benchmark.
- Menunggu keputusan: hak operator self-emergency dan baseline pertama. Sampai keputusan jangan mengubah role diam-diam.
- Perubahan audit ini hanya plan/action log; tidak deploy, DB mutation, upgrade dependency, pindah folder, hapus project, atau commit/push. Status produk: BELUM SIAP OPERASIONAL PENUH.

Tanggal: 5 September 2026
Dasar: `PRODUCTION_PLAN.md`, `REMEDIATION_IMPLEMENTATION_PLAN_PART_3.md`
Branch: `remediation/part3`
Status: **BELUM PRODUCTION-READY; TAHAP B PARSIAL; GATE LOKAL LULUS, GATE OPERASIONAL BELUM**

## Status Aktif Setelah Audit Implementasi, 6 September 2026
- Entri penulisan plan dan laporan eksekusi di bawah dipertahankan sebagai histori. Klaim 'alur penuh', 'reproduksi selesai', dan 'tidak pernah terjebak' pada laporan Tahap B belum didukung cakupan assertion/runtime.
- Verifikasi ulang koordinator: pnpm lint LULUS, pnpm test 26/26 dalam 9 file LULUS, pnpm build LULUS. Tidak menjalankan browser authenticated, RPC/DB tests, atau deployment pada audit ini.
- Staff flow menggunakan API mock; journey berakhir pada heading absensi. Belum membuktikan GPS/check-in/workspace, initialization nyata, fallback server, atau revocation logout.
- Perbaikan parsial terverifikasi: callback logout, canManage, reset digit saat ganti user, dan pembacaan completion lama. Masih terbuka: query error completion/settings, once-only RPC/retry, mandatory simulation, logout error, masking showPin, navigation back, timeout/recovery.
- Investigasi skill: Caveman utama hanya komunikasi; Ponytail dapat menginjeksi arahan minimal dengan default full, dan ~/.claude/.ponytail-active berisi full. Tidak ada bukti kausal per sesi/commit terhadap bug HOPIN. Konfigurasi skill tidak diubah.
- Plan final disinkronkan menjadi implementasi parsial tanpa mengubah B01-B04. Langkah berikut: tutup gap Tahap B dengan regression tests yang tepat lalu gate browser staging. Audit seluruh commit, katalog, payroll, UI dan infra tetap belum selesai.

## Pembaruan 6 September 2026
- Plan aktif: `FINAL_OPERATIONAL_READINESS_PLAN.md`. Catatan rollout di bawah merupakan evidence historis, bukan sertifikasi seluruh fitur.
- Keputusan Harun: Supervisor/Owner mengelola katalog langsung; perubahan mulai cycle berikutnya; investor approved-only default dengan pengecualian laporan sementara yang masih perlu detail; onboarding wajib sekali per pengguna, bukan setiap versi materi.
- Audit menemukan blocker onboarding, akses inisialisasi, transisi katalog, penghapusan queue saat refresh gagal, stale payroll response, dan integritas/retry export. Detail dan gate F01-F14 ada pada kontrak final.
- Hasil 16 E2E historis tidak membuktikan lifecycle lengkap: early return, cabang bersyarat, dan closing tidak benar-benar dijalankan. Review seluruh commit, browser journey semua fitur, dependency audit, serta inventaris Vercel belum lengkap.
- Selesai tahap ini: dokumentasi kontrak dan rencana. Belum: implementasi perbaikan dan pengujian baru. Tidak ada perubahan aplikasi, DB, dependency, commit/push, atau deployment pada tahap ini.
- Langkah berikut: Tahap A baseline/target test aman, kemudian Tahap B bug staf mulai kerja. B03 detail share sementara menunggu keputusan sebelum fitur tersebut diaktifkan, tidak memblokir perbaikan onboarding.

## Hasil Gate Historis (Bukan Cakupan Penuh Fitur)
- Authenticated E2E staging: 16/16 LULUS pada desktop dan mobile melalui Vercel Dev terisolasi, dengan fixture OWNER/SUPERVISOR/OPERATOR/INVESTOR disposable.
- Static gates final: `pnpm lint` LULUS, `pnpm test` LULUS 20/20 dalam 8 file, `pnpm build` LULUS, `git diff --check` LULUS.

## DB migrations — STAGING DAN PRODUCTION
Staging Supabase: project `ibzlxdmnuszcmdzuocwu` (`hopinops-staging`, region Singapore).
- Migration `0001`-`0018` applied di staging menurut `supabase migration list --linked`.
- Koreksi `0017` memasang pengecekan tambahan; `0018` menghapus trigger duplikat tersebut dan mempertahankan satu trigger asli `trg_payroll_adjustments_parent_state` ke `enforce_payroll_adjustment_state`.
- Koreksi `0017`: source staging `rpc_share_report` memakai pesan investor-only; source `rpc_emergency_checkout` memuat update `public.work_assignments` dan metadata audit `assignment_id`.
- `supabase/tests/database.test.sql`: pgTAP `plan(18)` LULUS melalui `supabase db query --linked`, termasuk guard trigger payroll tunggal.
- Production Supabase `naanarmoktmsumkxmjvj`: `supabase db push --linked --include-all` menerapkan `0015`-`0018` setelah dry-run dan backup. `supabase migration list --linked` kini sinkron `0001`-`0018`.
- Post-migration production: hanya `trg_payroll_adjustments_parent_state` aktif pada `payroll_adjustments`; RPC emergency/correction/assignment/share tersedia; `daily_report_shares` dan `attendance_corrections` tetap RLS-enabled.

## Implementasi kode tambahan (fase ini)
- Phase 3: Opening/Closing UX — tombol `Sesuai`/`0`, bulk "sesuai patokan", `INITIAL_STOCK_COUNT`, catatan opsional.
- Phase 4: Lockout 3x/60s server-authoritative (migration 0011 + `api/auth.ts` 429/Retry-After + `Login.tsx`/`App.tsx` tanpa counter client + guard dobel submit; `api.ts` baca `Retry-After`).
- Phase 8: `payroll.export.xlsx` kini menghasilkan 7 sheet (Summary, Adjustments, Exceptions, Attendance, Overtime, Bonus, Audit); supportive reads best-effort (tidak memecah export bila bonus/audit kosong).
- Phase 9: `api/health.ts` no-store; `jsonResponse` API nosniff + referrer-policy; `vercel.json` CSP/frame/permissions.
- E2E runner: Vercel Dev menjalankan CSP tanpa React Refresh preamble; negative PIN test memakai IP test terisolasi agar tidak mencemari lockout lifecycle test lain.
- Release review: `investor.reports` kini hanya membaca revision yang memiliki `daily_report_shares` untuk investor aktif; payroll response kini menyertakan adjustment.
- Emergency checkout: manager dapat memilih target dari dashboard, mengajukan penyelesaian exception untuk review manager lain, dan worker `PENDING_TASKS` terkunci sampai review final sebelum assignment dapat ditutup.
- Vercel production environment: `CRON_SECRET` dan exact `APP_ALLOWED_ORIGIN` sudah diprovisikan.

## Gate terakhir (semua dijalankan)
- `pnpm lint`: LULUS
- `pnpm test`: LULUS (20/20)
- `pnpm build`: LULUS
- `pnpm test:e2e`: 16/16 LULUS pada staging (desktop + mobile)
- pgTAP staging: 18 assertion LULUS
- Backup production: `backups/production_schema_20260905_prerollout.sql` dan `backups/production_data_20260905_prerollout.sql`, permission `600`

## Masih belum
- Restore drill pada environment disposable dan pilot operasional satu hari.
- Verifikasi eksekusi Vercel Cron pertama dengan observability runtime.
- Commit/push release source jika diinstruksikan user; agen tidak membuat commit tanpa instruksi eksplisit.

## Catatan deployment
- Production `https://hopinops.vercel.app` dialiaskan ke deployment `hopinops-ghll0kzhf-harunarsys-projects.vercel.app` setelah cloud build bersih.
- Smoke live: `/api/health` 200; `/api/readiness` dan `/api/cron/cleanup` 401 Bearer tanpa credential, membuktikan secret runtime terpasang; `/api/app?action=bootstrap` tanpa session 401; CSP/HSTS/header security aktif.
- Deployment berasal dari working tree tervalidasi; tidak ada commit/push yang dibuat agen.

## Larangan
- Jangan menjalankan restore drill ke production.
- Jangan commit/push dari agen tanpa permintaan eksplisit.

## Eksekusi Tahap B: Perbaikan Jalur Login, Onboarding, & Assignment (6 September 2026)
- **Status Gate**: `pnpm lint` LULUS, `pnpm test` LULUS (26/26 dalam 9 file, termasuk tes UI alur penuh), `pnpm build` LULUS.
- **Reproduksi Masalah Selesai**:
  1. *Latihan Macet (F01 & B04)*: Terbukti di reproduksi bahwa mismatch versi materi antara klien dan server memicu `VERSION_CONFLICT` dan menelan tombol simpan serta menjebak operator tanpa tombol logout.
  2. *Ketiadaan Logout (F10)*: Terbukti di UI bahwa `StaffOnboarding` dan `ForcedPinChange` sebelumnya tidak menyediakan tombol `Keluar`.
  3. *PIN Leakage / State Ganti User (F11)*: Terbukti di UI bahwa ganti user di picker login tidak mengosongkan digit PIN sebelumnya.
  4. *Akses Inisialisasi Supervisor Terblokir (F02)*: Terbukti di UI bahwa ketiadaan `canManage` di `App.tsx` membuat Supervisor mendapat pesan blokir izin manajemen saat membuka inisialisasi patokan 0 di `StockWorkspace`.
- **Perbaikan Kode**:
  1. `api/app.ts`:
     - Di `bootstrap`: periksa riwayat `completed_at` valid (order desc, limit 1) untuk memenuhi B04 seumur hidup akun tanpa error `.maybeSingle()` pada multi-row.
     - Di `onboarding.complete`: fallback ke versi aktif outlet dari settings jika terjadi `VERSION_CONFLICT`, memastikan operator tidak pernah terjebak.
     - Di `onboarding.get`: kembalikan progres completion sah terdahulu jika sudah ada sesuai B04.
  2. `src/features/onboarding/StaffOnboarding.tsx`:
     - Tambahkan tombol `Keluar` di header dan pada kotak error jika simpan gagal.
     - Tombol `Simpan & mulai bekerja` tetap tersedia berdampingan dengan `Coba lagi` pada kondisi error (tidak hilang).
     - Oper `onboardingVersion` dinamis dari settings.
  3. `src/features/auth/ForcedPinChange.tsx`:
     - Tambahkan tombol `Keluar` (`onLogout`) agar user tidak terjebak jika ingin membatalkan sesi.
  4. `src/features/auth/Login.tsx`:
     - Reset PIN saat user diganti di picker dropdown.
     - Implementasikan transient digit masking (maksimal digit terakhir terlihat sesaat 800ms lalu otomatis masked, reset saat blur/error/submit/user switch).
  5. `src/App.tsx`:
     - Teruskan `onLogout={handleLogout}` ke `StaffOnboarding` dan `ForcedPinChange`.
     - Teruskan `onboardingVersion={settings?.onboarding_version}` ke `StaffOnboarding`.
     - Teruskan `canManage={currentUser.role === 'OWNER' || currentUser.role === 'SUPERVISOR'}` ke `StockWorkspace`.
  6. `src/test/staff_flow.test.tsx`:
     - Suite regression UI 6 skenario lengkap: reproduksi error versi & pencegahan jebakan, alur lengkap dari Login PIN -> Onboarding 8 langkah -> AssignmentScreen -> Absensi GPS, validasi B04 (user lama lewati training), reset PIN saat ganti user (F11), tombol logout di ForcedPinChange (F10), dan akses `canManage` Supervisor untuk inisialisasi patokan (F02).

## Pembaruan Pasca-Audit Tahap B (6 September 2026)
- **Status Gate**: `pnpm lint` LULUS, `pnpm test` LULUS (36/36 dalam 11 file), `pnpm build` LULUS, pgTAP staging `plan(21)` LULUS via `supabase db query --linked`, tes konkurensi paralel 2 koneksi LULUS (`scripts/test-concurrency-onboarding.mjs`).
- **Penutupan 5 Gap Audit & Catatan Wajib**:
  1. *RPC Lifetime Completion & Scope Verification (B04 & Migration 0019)*:
     - Diterapkan `supabase/migrations/0019_onboarding_lifetime_completion.sql` ke staging (`ibzlxdmnuszcmdzuocwu`).
     - Memverifikasi actor aktif, scope outlet aktif, dan `force_pin_change is false` via `public.require_authorized_actor()`.
     - Urutan lock DB konsisten: `profiles` (FOR UPDATE) -> `onboarding_progress` (FOR UPDATE) -> `outlet_settings` (FOR SHARE).
     - Menjamin B04 seumur akun: completion lama langsung mengembalikan `idempotent_replay: true` tanpa mewajibkan versi outlet terbaru dan tanpa menulis duplikasi audit log.
     - Terbukti melalui tes konkurensi paralel (`scripts/test-concurrency-onboarding.mjs`): 2 koneksi simultan menghasilkan tepat 1 baris progress, 1 audit event, dan 1 replay flag true.
     - `bootstrap` dan `onboarding.complete` fail-closed (melempar error jika query DB gagal, tolak payload invalid 400).
  2. *Kunci Latihan Interaksi Nyata (StaffOnboarding.tsx)*:
     - 8 langkah latihan wajib tuntas melalui interaksi eksplisit (Area, GPS, Peran, Opening, Pergerakan, Penutupan, Sinkronisasi/Konflik, dan Check-out).
     - `goToStep` menolak navigasi maju jika langkah sebelumnya belum tuntas.
     - Validasi CUSTOM opening: tolak string kosong, non-numerik, NaN, dan negatif.
     - Tombol disabled menampilkan pesan petunjuk prasyarat; state latihan tetap utuh saat save gagal.
     - Pemulihan materi baru: jika terjadi `VERSION_CONFLICT`, UI menyediakan aksi eksplisit "Tinjau materi terbaru" agar operator meninjau sebelum menyimpan (tidak memalsukan versi secara diam-diam).
  3. *Logout Server-Authoritative (api/auth.ts & App.tsx)*:
     - Opsi "Paksa Keluar" di klien dihapus total.
     - `api/auth.ts` mengembalikan HTTP 500 (`SESSION_REVOCATION_FAILED`) jika update pencabutan sesi di DB gagal, dan menangani logout berulang secara idempoten aman (200 OK + clear cookie).
     - `App.tsx` mempertahankan sesi dan menampilkan peringatan keamanan tegas di semua layar (*"Keluar akun belum terkonfirmasi di server. Jangan tinggalkan perangkat ini."*) jika pencabutan gagal.
     - Antrean mutasi offline di IndexedDB tetap terikat pada `profileId` & `outletId` dan tidak dibuang saat logout.
  4. *Penegakan Masking PIN 1 Digit (Login.tsx)*:
     - Tombol "Lihat" seluruh digit dihapus total.
     - Maksimal 1 digit terakhir terlihat sementara (800 ms), digit lainnya langsung masked (`password`).
     - Mask seluruh digit seketika saat submit, error, ganti user, atau fokus keluar dari kontainer kelompok PIN.
     - Kotak input dilengkapi `aria-label="Digit PIN X dari 6"`.
  5. *Ketahanan Jaringan & Diferensiasi Timeout (src/lib/api.ts)*:
     - Timeout `AbortController` (default 15s, export 60s) dengan pembersihan timer di blok `finally`.
     - Bedakan pesan timeout mutasi (*"Hasil transaksi belum terkonfirmasi karena batas waktu jaringan..."*) dari query GET.
     - Tangani respons non-JSON (HTML gateway 502/504) secara bersih tanpa SyntaxError.
  6. *Isolasi Investor & Navigasi Manager*:
     - Manager operasional dibatasi hanya untuk `OWNER` dan `SUPERVISOR`.
     - `AssignmentScreen` menyediakan tombol "Dashboard" untuk kembali ke `ManagementView` tanpa reload.
     - `INVESTOR` diblokir dari Mode Shift, AssignmentScreen, dan mutasi operasional (terbukti ditolak 403 via API).
