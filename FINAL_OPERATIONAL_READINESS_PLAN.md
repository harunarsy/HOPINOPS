# HOPIN Final Operational Readiness Contract

Tanggal: 6 September 2026
Status: PLAN AKTIF; BELUM PRODUCTION-READY; implementasi Tahap B parsial, belum memenuhi gate akhir.
Pemilik keputusan: Harun.
Scope: aplikasi aktif di `webapp`, bukan demo `webapp-fallback` atau prototipe `output`.

## 1. Aturan Eksekusi Tetap

Dokumen ini adalah kontrak finalisasi, bukan klaim bahwa requirement telah diimplementasikan. AI tidak boleh mengubah keputusan bisnis atau menurunkan acceptance criteria tanpa persetujuan eksplisit Harun. Perubahan keputusan harus mencatat tanggal, alasan, keputusan lama/baru, dan persetujuan. Markdown bukan proteksi teknis; CODEOWNERS, review, dan branch protection perlu dipasang melalui mekanisme repository yang tersedia.

1. Dokumen ini mengungguli rencana lama hanya pada keputusan yang disebut eksplisit. Requirement lama yang tidak diganti tetap berlaku. Konflik lain harus ditanyakan, bukan ditebak.
2. Jangan menghapus requirement, melemahkan assertion, menerima error sebagai sukses, atau melewati lifecycle untuk membuat gate hijau.
3. Bedakan status `BELUM DIPERIKSA`, `TERBUKTI DI SOURCE`, `TERREPRODUKSI`, `DIPERBAIKI`, `TERUJI`. Tidak ada status selesai tanpa evidence.
4. Source server adalah sumber kebenaran. Otorisasi role/outlet dan invariants harus ditegakkan server/RPC, bukan hanya tombol UI. Mutasi penting transactional dengan audit atomik.
5. Pertahankan data nyata, histori, perubahan worktree pihak lain, dan migration yang sudah applied. Perubahan skema berikutnya additive dengan nomor baru setelah memeriksa migration terbaru.
6. Dilarang test mutasi, fixture provisioning, reset, atau restore drill pada production. Verifikasi target staging/disposable sebelum setiap operasi database.
7. Tidak ada commit, push, merge, penghapusan project, rotasi secret, migration production, atau deploy production tanpa izin eksplisit yang sesuai tahap ini. Persetujuan rollout lama bukan izin tanpa batas.
8. Jangan mencetak secret, PIN, token, raw GPS, atau data pribadi ke laporan/artefak. Gunakan akun disposable dan artefak tersanitasi.
9. Perbarui ACTION_LOG.md setelah setiap tahap, termasuk blocker, hasil nyata, scope tes, dan perubahan belum di-commit.
10. Jangan menjanjikan nol bug. Release mensyaratkan nol blocker diketahui, pengujian risiko utama, observability, dan recovery yang terbukti.

## 2. Keputusan Bisnis Disetujui

| ID | Kontrak |
|---|---|
| B01 | Supervisor bertanggung jawab penuh operasional dan boleh langsung tambah, ubah, serta arsip barang dalam scope outlet. Owner mempunyai akses yang sama dan fungsi pengawasan. Tidak perlu approval Owner untuk perubahan katalog biasa. Semua perubahan diaudit. |
| B02 | Perubahan katalog berlaku mulai cycle berikutnya. Cycle berjalan mempertahankan item-set dan metadata snapshotnya. Laporan berikutnya memakai katalog yang berlaku bagi cycle sumbernya, bukan melakukan join buta ke katalog aktif hari ini. Histori tidak berubah. |
| B03 | Investor default hanya melihat revision approved yang dibagikan eksplisit kepadanya. Ada kebutuhan pengecualian laporan sementara berlabel 'Belum ditinjau'; tidak boleh membuka akses otomatis ke draft, HR, payroll, raw GPS, atau seluruh laporan outlet. Detail pengecualian harus diputuskan sebelum diaktifkan. |
| B04 | Latihan inti wajib diselesaikan satu kali per pengguna. Setelah selesai, login atau perubahan versi materi tidak boleh memaksa latihan ulang. Tidak perlu fitur pengulangan otomatis. Progres completion yang sah harus dipertahankan saat migrasi. |

### Keputusan Teknis yang Perlu Ditetapkan Sebelum Fitur Terkait

- B03: apakah Supervisor dan Owner keduanya boleh membagikan revision SUBMITTED sementara, serta apakah investor tetap boleh melihat revision terkirim yang kemudian NEEDS_CLARIFICATION? Sampai diputuskan, approved-only tetap fail-closed.
- Item baru membutuhkan baseline eksplisit yang diaudit sebelum opening; jangan diam-diam menafsirkan referensi hilang sebagai nol. Tetapkan UX input baseline dan aturan inventory carry-forward dalam desain tahap katalog.
- Satuan barang berhistori tidak boleh ditimpa sehingga mengubah makna angka. Gunakan item/version baru atau konversi eksplisit yang tervalidasi; pilih pendekatan minimal setelah memeriksa model data.
- Batas BAR/KITCHEN, jam shift, dan kanal pembayaran harus dipetakan terhadap kontrak awal. Tidak semua konstanta adalah bug: konfigurasi operasional harus server-owned, sedangkan enum/domain invariant tidak perlu dijadikan konfigurasi tanpa kebutuhan.

## 3. Baseline dan Batas Evidence

- Catatan rollout menyatakan production/staging sampai migration 0018 dan deployment working tree aktif. Verifikasi kembali sebelum implementasi; jangan mengandalkan log historis sebagai status remote terkini.
- Audit sebelumnya menemukan 52 commit; review lengkap setiap diff belum selesai. HEAD terakhir dilaporkan e2f0983 dengan perubahan Part 3 belum di-commit.
- Hasil historis lint, 20 unit, 18 pgTAP, dan 16 E2E bukan bukti semua fitur. E2E memiliki early return dan cabang bersyarat; judul closing tidak menjalankan closing. pgTAP terutama struktur/grant, belum seluruh perilaku.
- Smoke terbaru read-only: health 200, bootstrap tanpa sesi 401, readiness tanpa bearer 401. Ini bukan bukti authenticated readiness, cron sukses, atau lifecycle user.
- Audit visual lintas perangkat, Lighthouse, dependency vulnerability audit terbaru, inventaris Vercel remote, restore drill dan pilot belum lengkap.

## 4. Backlog Terbukti dan Reproduksi

Referensi relatif terhadap root aplikasi; nomor baris dapat bergeser. Verifikasi source sebelum memperbaiki.

| ID | Prioritas | Bukti awal | Hasil yang wajib dicapai |
|---|---|---|---|
| F01 | P1 | StaffOnboarding.tsx:219 mengirim versi 2; api/app.ts:509 membaca progress tanpa filter/error handling | Completion sekali seumur akun sesuai B04, tidak loop setelah save, error bisa dipulihkan; jangan hanya mengganti hardcode versi lalu memaksa retraining. |
| F02 | P1 | App.tsx:668-680 tidak memasok canManage | Owner/Supervisor dapat menjangkau baseline/opening initialization; operator tidak mendapat privilege tersebut. |
| F03 | P1 | 0010_stock_reference_initialization.sql:428-443 menolak item baru tanpa referensi | Katalog baru, archive, metadata, dan baseline aman lintas cycle menurut B01/B02. |
| F04 | P1 | StockWorkspace.tsx:792-802 menghapus konflik setelah callback yang menelan error di App.tsx:88-92 | Refresh gagal tidak menghapus antrean. Discard eksplisit tidak disamakan dengan transaksi sudah tersimpan. |
| F05 | P1 | ManagementView.tsx:193-199 menerapkan respons payroll tanpa stale guard | Periode, run, dialog, dan target mutasi selalu sama walau respons datang terbalik. |
| F06 | P1 | api/app.ts:1982-2030,2140-2152 | Payroll export berasal dari snapshot/evidence benar, tanggal bulan valid, tidak sukses dengan evidence wajib hilang. |
| F07 | P1 | api/app.ts:2193-2226 upload path tetap sebelum receipt RPC | Export retry-safe, receipt dapat ditemukan setelah respons hilang, orphan dapat direkonsiliasi tanpa menimpa histori. |
| F08 | P2 | StockWorkspace.tsx:633-639,978-985 | Draft parsial menerima item belum diisi; blank bukan nol dan nilai invalid ditolak. |
| F09 | P2 | App.tsx:65-76; StockWorkspace draft restore dan queue refresh | Refresh lokal tidak unmount workspace atau menimpa ketikan baru; respons stale diabaikan. |
| F10 | P2 | App.tsx:149-155 dan early-return onboarding/PIN | Logout tersedia pada semua state; kegagalan pencabutan sesi tidak dinyatakan sukses, dirty/queued work tidak hilang diam-diam. |
| F11 | P2 | Login.tsx input password terpisah dan showPin state | Maksimal digit terakhir terlihat sesaat; digit sebelumnya langsung masked; reset pada submit/error/ganti user/blur; paste/backspace/a11y tetap bekerja. Reproduksi di browser mobile. |
| F12 | P2 | AssignmentScreen/ManagementView modal; table-responsive tanpa CSS | Dialog keyboard lengkap, label terhubung, navigasi balik jelas, tabel dan header tidak overflow dokumen mobile. |
| F13 | P1 | tests/e2e/authenticated.spec.ts:69-71,101-143 | Tes lifecycle tidak lulus lewat early return, error yang tidak diharapkan, atau skip core. Setiap nama test cocok dengan assertion. |
| F14 | P2 | src/lib/api.ts:18-28; bootstrap query serial | Timeout, respons non-JSON, session expiry, request cancellation/stale guards, dan recovery terukur; abort tidak dianggap rollback transaksi server. |

F01 adalah cacat source yang relevan dengan laporan user, tetapi penyebab kejadian spesifik belum direproduksi. Temuan lain harus mempunyai regression reproducer sebelum dinyatakan teratasi. Audit juga harus memeriksa idempotency command di luar movement/emergency/share dan emergency recovery lintas hari.

## 5. Urutan Eksekusi dan Gate

### Tahap A: Lengkapi Baseline Audit

- Baca semua rencana awal/remediation, laporan audit, konfigurasi, dan seluruh commit reachable yang relevan beserta diff. Pisahkan bug historis yang sudah diperbaiki dari bug source terkini.
- Buat matriks requirement -> keputusan -> commit/file -> UI/API/RPC -> test -> evidence -> status. Tandai requirement yang belum diperiksa secara eksplisit.
- Inventaris setiap action API/RPC, tombol/journey tiap role, state/error path, environment names, dependency lockfile, CI, project/domain Vercel dan root folder. Jangan membaca atau menyalin secret ke laporan.
- Siapkan staging disposable terisolasi dan runner yang terbukti tidak menunjuk production. Audit test scripts sebelum menjalankannya; test:db saat ini mengandung db reset.
- Gate: baseline dapat direproduksi; daftar scope tes dan target aman jelas. Tidak ada klaim seluruh commit/fitur selesai tanpa matriks.

### Tahap B: Staf Bisa Mulai Bekerja

- Reproduksi latihan save/next dengan latency, error, completion existing/multiple legacy versions dan sesi expired. Terapkan B04 dengan mempertahankan completion sah, tanpa reset data akun.
- Perbaiki F01/F02/F10/F11/F14 yang menghalangi login -> latihan -> assignment. Lengkapi kembali ke dashboard untuk manager dan pisahkan keluar akun dari check-out shift.
- Gate: browser user baru menyelesaikan latihan sekali lalu memilih shift/posisi; login ulang tidak mengulang; supervisor bisa menyiapkan opening tanpa dead end; seluruh failure menyediakan tindakan lanjut.

### Tahap C: Integritas Stok dan Katalog

- Perbaiki F03/F04/F08/F09; bangun UI katalog Supervisor/Owner dan authorization RPC yang sesuai B01.
- Bekukan item-set/metadata untuk cycle; terapkan perubahan pada cycle berikutnya; sediakan baseline item baru dan archive tanpa merusak histori.
- Audit queue ownership lintas sesi, retained idempotency key untuk retry, payload-conflict, concurrent clients, reconnect, stale version, dan dirty input.
- Gate: tambah/arsip barang sebelum dan sesudah closing, buka cycle berikutnya, submit laporan lama/baru, dan reload histori semuanya konsisten; transaksi tidak hilang atau terduplikasi.

### Tahap D: Tutup Operasi dan Keuangan

- Buktikan roster -> claim -> check-in -> opening -> movement/correction -> handover/closing -> report/review/share -> checkout/complete.
- Buktikan HR leave/swap/overtime/correction dan no-self-review; emergency checkout -> PENDING_TASKS -> reviewer lain -> resolved -> complete, termasuk pergantian hari.
- Perbaiki F05/F06/F07; audit seluruh mutasi untuk replay response identik, payload mismatch, scope dan concurrency. Finalisasi payroll tidak boleh salah periode atau evidence.
- Implementasi pengecualian B03 hanya setelah keputusan rinci tercatat; approved-only tetap default.
- Gate: seluruh perjalanan role selesai dengan receipt/audit, pengujian denial lintas role/outlet, dan rekonsiliasi payroll sampai signed download.

### Tahap E: UX dan Performa

- Ukur browser nyata 320/375/390/768/1280 px, teks panjang, zoom 200%, keyboard, touch, loading/error/empty/success, session expiry, slow network, offline/reconnect.
- Aksi utama jelas, label Bahasa Indonesia menjelaskan dampak, disabled state menjelaskan prasyarat; logout konsisten di menu akun/header termasuk onboarding dan recovery. Jangan menaruh logout sebagai pengganti check-out.
- Dialog mempunyai accessible name, initial focus, focus containment, Escape sesuai keamanan, dan restore focus. Tabel lebar scroll lokal tanpa document overflow. Target sentuh disarankan >=44 px; verifikasi WCAG AA.
- Hilangkan delay buatan dan global loading untuk refresh lokal. Paralelkan query independen setelah mengukur, hindari request duplikat dan response races. Jangan menambah cache/optimistic mutation yang melemahkan source of truth.
- Target awal: respons visual input/tombol <=100 ms; LCP <=2.5 s, INP <=200 ms, CLS <=0.1 pada profil uji terdokumentasi. Ukur cold/warm, p50/p95 request kritis, jumlah query/request dan waktu save onboarding. Angka satu curl bukan benchmark.
- Gate: laporan Playwright dan audit accessibility/performance mencatat viewport, jaringan, data fixture, hasil dan residual gaps. Lighthouse tidak menggantikan tes authenticated journey.

### Tahap F: Toolchain dan Penyederhanaan

- Audit dependency direct/transitive terhadap advisory terkini. Upgrade security/compatibility secara terarah dan bertahap dengan lockfile serta regression gates; jangan upgrade seluruh major sekaligus tanpa manfaat.
- Patok Node/package manager, selaraskan @types/node, type-check frontend dan seluruh serverless entrypoint, audit overrides serta dependency build/runtime. Pasang CI lint/unit/backend types/build/DB/E2E yang sesuai.
- Target root aktif pengguna: /Users/harunalrasyid/Projects/HOPIN. Inventaris file tersembunyi, Git, output prototipe dan backup; rencanakan pemindahan tanpa overwrite, preserve histori dan rollback. Jangan menggabungkan dependency demo dengan produksi.
- Inventaris project Vercel hopinops/webapp secara remote: domain, alias, env names, Git/root settings, cron, traffic dan billing. Tetapkan hopinops sebagai target utama hanya setelah bukti. Jangan hapus project kedua sebelum migrasi dependensi/domain dan persetujuan.
- Gate: satu entrypoint pengembangan full-stack yang terdokumentasi; pnpm dev tidak boleh diklaim full-stack jika hanya Vite. Root dan project cleanup adalah pekerjaan terpisah, bukan prasyarat memperbaiki bug staf.

### Tahap G: Release Terverifikasi

- Jalankan semua gates sekali pada baseline release yang sama, dengan backend type-check dan test yang tidak mempunyai jalan pintas. Review diff dan dependency/security evidence.
- Restore backup pada disposable environment, verifikasi schema/data/invariants dan rekam langkah recovery serta keterbatasan. Jangan restore ke production.
- Minta izin commit/merge dan rollout saat siap. Catat commit/artifact/deployment/migration identity agar rollback dapat direproduksi.
- Setelah izin: backup segar, migration preflight, staged deployment, authenticated readiness, role smoke terkontrol, observasi cron sukses, logs tersanitasi, dan pilot satu hari operasional termasuk pergantian shift.
- Gate: nol P0/P1 terbuka; P2 yang mempengaruhi integritas/akses/operasi juga harus ditutup. Risiko kosmetik tersisa hanya boleh diterima eksplisit dengan owner. Tidak ada klaim siap penuh sebelum pilot dan recovery evidence selesai.

## 6. Matriks Tes Minimum

| Area | Skenario wajib |
|---|---|
| Auth | User baru/lama, PIN salah 3x/60s server-side, paste/backspace/masking, forced change, expired/revoked session, logout error dan sukses, cross-origin denial |
| Onboarding | Langkah inti wajib, save sukses/gagal/lambat, respons hilang/retry, completion legacy, login ulang tidak retraining, jalan keluar tersedia |
| Assignment | Semua role relevan, BAR/KITCHEN, SIANG/MALAM/FULL, Primary/Helper, roster mismatch, primary race, kembali ke dashboard |
| Attendance | GPS sukses/ditolak/timeout/inaccurate, device binding, duplicate submit, checkout prasyarat, emergency dan reviewer berbeda, lintas tengah malam WIB |
| Stock | Fresh baseline, reference handover/fallback, blank vs nol, decimal scale, draft parsial/reload, movement/correction, concurrent version, offline queue konflik dan recovery |
| Catalog | Supervisor/Owner create/update/archive, operator/investor denial, item baru baseline, cycle aktif frozen, archive setelah closing sebelum report, satuan/histori |
| Reports | Finance draft, totals server, BAR/KITCHEN dependencies, submit/review/clarification/revision, explicit share/replay, recipient isolation, approved-only default |
| HR | Roster save/swap/cancel, izin request/review/cancel, lembur approval/reject, attendance correction, no-self-review dan scope outlet |
| Payroll | Generate/get/adjust/review/finalize/pay/void, periode race, February/leap-year/30-day month, snapshot reconciliation, export repeat/lost response/storage error, signed URL scope/TTL |
| Runtime | Authenticated readiness, unauthorized denial, cron auth + actual execution, cache/security headers, no client secrets, redacted logs, restore drill |
| UX | Per-role actual browser clicks, keyboard/focus, mobile tables/header/dialog, slow/offline/5xx/non-JSON, no unexpected unmount/dirty loss, long names and empty states |

## 7. Evidence dan Handoff

Setiap F/requirement memiliki: root cause, affected roles, reproducer, file/commit perbaikan, test name, command dan target, hasil aktual, artefak tersanitasi, serta residual risk. Test yang blocked/skipped tidak dihitung sebagai pass fitur.

Subagent dibagi per berkas, tidak boleh saling menimpa. Tidak boleh commit/push/add, menyentuh DB atau menjalankan build/test; koordinator memverifikasi source dan menjalankan gates terpusat. Model tertentu hanya dipilih bila tool mendukung, jangan mengklaim memakai model yang tidak tersedia.

Status akhir yang boleh dipakai: BELUM SIAP, SIAP PILOT TERBATAS (scope eksplisit), atau SIAP OPERASIONAL (seluruh gate relevan selesai). Update kontrak tidak boleh menghapus catatan evidence atau keputusan lama; gunakan changelog dan review.

## 8. Changelog Keputusan

### Verifikasi Implementasi Tahap B, 6 September 2026

Ini pembaruan evidence, bukan perubahan keputusan bisnis B01-B04. Koordinator menjalankan ulang pnpm lint, pnpm test (26/26, 9 file), dan pnpm build: semuanya lulus. Test staff_flow menggunakan API mock/happy-dom; assertion journey berhenti di layar absensi, bukan GPS/check-in/workspace. Gate browser terintegrasi dan RPC belum terbukti.

- Perbaikan source terkonfirmasi: canManage diteruskan ke workspace, logout tersedia pada onboarding/forced PIN, PIN dikosongkan ketika memilih user, completion lama dapat dipakai UI.
- F01/B04 masih terbuka: error query completion/settings tidak diperiksa; fallback versi memakai snapshot sebelum RPC; RPC completion masih per versi; payload version invalid kini diam-diam memakai activeVersion. Langkah inti dapat dilewati tanpa menyelesaikan simulasi.
- F10 masih terbuka: client/server logout mengabaikan kegagalan revocation; tombol keluar bukan bukti sesi benar-benar dicabut.
- F11 masih terbuka: showPin tetap bisa membuka semua digit dan tidak direset saat ganti user/blur/submit; test baru hanya membuktikan PIN kosong setelah ganti user.
- F02 wiring diperbaiki, tetapi test hanya memastikan tombol muncul; initialize -> reference AVAILABLE -> opening belum diuji melalui UI terintegrasi.
- F12/F14 masih terbuka: kembali ke dashboard dari assignment belum tersedia; timeout request dan recovery loading belum lengkap.
- Definisi Caveman utama mengatur komunikasi, bukan kode. Ponytail mengarahkan implementasi minimal dan memiliki mekanisme default full; flag lokal full ditemukan. Tidak ada provenance yang membuktikan skill tertentu menyebabkan perubahan/bug HOPIN. Jangan mengubah kontrak, merampingkan acceptance criteria, atau menganggap sebuah skill sebagai pengganti audit.
- Prioritas berikutnya: regression test error/race/retry dan mandatory steps, revocation logout, masking lengkap, lalu browser staging end-to-end. Tahap B tidak boleh ditutup hanya berdasarkan 26 test unit yang lulus.

- 2026-09-06: Harun menyetujui Supervisor mengelola katalog langsung, katalog berlaku cycle berikutnya, approved-only sebagai default investor dengan kebutuhan laporan sementara, serta onboarding wajib sekali saja. Kontrak dan rencana dibuat; tidak ada implementasi aplikasi/deploy pada tahap penulisan ini.
