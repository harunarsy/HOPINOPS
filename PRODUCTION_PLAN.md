# HOPIN One-Shot Production Plan

Status: **normatif dan siap dieksekusi**
Target: membawa prototype saat ini menjadi sistem production satu outlet yang aman, dapat diaudit, mobile-friendly, dan mempunyai sumber data server tunggal.
Zona waktu bisnis: **Asia/Jakarta (WIB)**.

## 0. Kontrak Eksekusi untuk AI

Dokumen ini adalah sumber keputusan implementasi. AI eksekutor tidak boleh menebak atau mengganti aturan bisnis yang sudah ditetapkan di sini.

1. Baca seluruh dokumen sebelum mengubah kode.
2. Periksa `git status`, diff, migration remote, dan isi database sebelum bekerja.
3. Jangan menghapus, me-reset, atau menimpa perubahan user/agent lain.
4. Gunakan `apply_patch` untuk edit manual dan perbarui `ACTION_LOG.md` setiap fase berubah.
5. Jangan menaruh PIN, service-role key, koordinat pribadi, data kontrak personal, atau secret lain di source, fixture, log, screenshot, maupun commit.
6. Jangan melakukan `git add`, commit, push, migration production, atau deploy production kecuali perintah eksekusi yang diberikan memang mengizinkannya.
7. Setelah gate lokal lulus, lanjutkan fase berikutnya tanpa meminta keputusan desain baru.
8. Hentikan eksekusi hanya jika ada secret/akses yang tidak tersedia, data legacy operasional ternyata berisi data nyata, konflik destruktif, konfigurasi runtime wajib belum diisi, atau verification gate gagal dan tidak dapat diperbaiki dengan aman.
9. Jika tabel operasional legacy berisi data, hentikan migration, ekspor data tersebut, laporkan jumlah dan relasinya, lalu minta keputusan migrasi data. Jangan drop atau mengubah datanya.
10. Implementasi wajib server-first. Jangan mempertahankan `localStorage` sebagai fallback data operasional.
11. Semua perubahan database harus additive sampai cutover berhasil. Penghapusan tabel/kolom legacy ditunda ke release terpisah.
12. Hasil akhir wajib menyertakan `EXECUTION_REPORT.md` sesuai format pada bagian terakhir dokumen ini.

## 1. Current State Terverifikasi

### 1.1 Aplikasi

- React 19 + Vite + TypeScript; scripts saat ini berada di `package.json`.
- `src/App.tsx` masih monolitik dan memuat tipe, state, command bisnis, persistence, routing role, dan seluruh komponen UI.
- Assignment, opening, movement, closing, report, dashboard, dan lease tab masih disimpan di `localStorage`/`sessionStorage`.
- Data seed pada `src/App.tsx` adalah demo. Data itu tidak boleh diimpor sebagai transaksi production.
- Dashboard role saat ini memberi akses langsung kepada `OWNER`, `INVESTOR`, dan `ADMIN`, tetapi belum kepada `SUPERVISOR`.
- Status laporan UI saat ini memakai `SENT`; target production memakai `SUBMITTED`.

### 1.2 Authentication

- Custom username + PIN dan session server sudah berjalan di `api/auth.ts`.
- PIN saat ini enam digit, PBKDF2-SHA256 310.000 iterasi, lock 15 menit setelah lima kegagalan.
- Session saat ini maksimum 12 jam dan idle timeout 30 menit.
- Session disimpan sebagai hash token di `app_sessions`; cookie HttpOnly sudah digunakan.
- Login options saat ini masih mengirim `job_title`; target hanya `username` internal dan `display_name` untuk tampilan.
- Lockout gagal-login saat ini read-then-update dan belum atomic/distributed.
- Belum ada change PIN, forced initial PIN change, reset PIN scoped, CSRF/origin validation, per-IP rate limit, atau audit auth lengkap.

### 1.3 Database dan Deployment

- Migration `0001_initial_schema.sql`, `0002_role_scopes.sql`, dan `0003_custom_auth.sql` sudah diterapkan.
- `0001` memakai policy `auth.uid()`, sedangkan `0003` memutus profile dari Supabase Auth dan API memakai `service_role`.
- `service_role` melewati RLS. Karena itu seluruh authorization wajib dilakukan ulang di API dan transactional RPC; RLS tidak boleh dianggap cukup.
- Tabel operational legacy belum terhubung ke UI production dan diperkirakan kosong, tetapi eksekutor wajib membuktikannya.
- Satu profil `OWNER` aktif sudah ada. Profil, credential, dan session yang sah harus dipertahankan.
- Production berjalan di Vercel. Shared relative imports pada serverless function pernah menimbulkan `FUNCTION_INVOCATION_FAILED`; jangan mengulang pola itu tanpa canary deploy.
- Docker image saat ini hanya menghidangkan frontend statis dan tidak membawa `/api`; image itu bukan deployment production lengkap.
- `pnpm test` saat ini hanya menjalankan TypeScript check. Belum ada unit, integration, database, atau E2E test nyata.

## 2. Sasaran, Prinsip, dan Non-Goals

### 2.1 Sasaran Release

- Server menjadi source of truth untuk user, roster, assignment, attendance, stok, laporan, bonus, dan payroll.
- Setiap perubahan penting dapat ditelusuri ke actor, waktu server, request, alasan, dan revision.
- Staff dapat menyelesaikan shift dari ponsel; management dapat memantau dan menangani exception dari desktop maupun ponsel.
- Sistem tahan retry, multi-device, koneksi putus, race condition, dan double-submit.
- Laporan bulanan dapat diekspor menjadi XLSX yang dapat dipertanggungjawabkan kepada staff.
- Investor hanya menerima informasi outlet yang memang telah dikirim, tanpa data HR atau draft.

### 2.2 Prinsip Wajib

- Server time adalah waktu kanonik; client time hanya metadata risiko.
- Semua business date dihitung di `Asia/Jakarta`, bukan timezone browser atau timezone database default.
- Raw facts bersifat append-only. Koreksi dibuat sebagai record baru, bukan menimpa bukti lama.
- Draft boleh berubah dengan optimistic version; revision submitted/finalized tidak boleh berubah.
- Semua command mutasi memiliki idempotency key.
- Permission dicek server-side pada setiap command dan dicek lagi di RPC transaksi kritis.
- Penolakan role/state memakai kode error stabil, bukan hanya pesan teks.
- UI tidak pernah menjadi satu-satunya penjaga aturan bisnis.
- Satu outlet digunakan sekarang, tetapi semua aggregate/top-level domain tables memakai `outlet_id`; child rows mewarisi scope melalui FK parent.

### 2.3 Non-Goals Release Ini

- Menulis ulang atau mengesahkan kontrak kerja.
- Mengotomatisasi hukuman, ganti rugi, atau potongan berat 50-100%.
- Menjamin GPS browser mustahil dispoof.
- Aplikasi native, device attestation native, rotating QR, atau NFC.
- Tracking lokasi kontinu.
- Foto selfie absensi atau lampiran foto izin/sakit.
- WhatsApp Business API otomatis.
- PDF payroll; XLSX wajib, PDF ditunda.
- Import transaksi demo dari `localStorage`.

## 3. Keputusan Bisnis Final

### 3.1 Role dan Privasi

| Kemampuan | OWNER | SUPERVISOR | OPERATOR | INVESTOR |
|---|---:|---:|---:|---:|
| Dashboard seluruh operasi | Ya | Ya | Tidak | Ringkasan report saja |
| Bekerja dalam shift | Ya | Ya | Ya | Tidak |
| Buat/revisi roster | Ya | Ya | Tidak | Tidak |
| Reset assignment | Ya | Ya, staff | Tidak | Tidak |
| Review attendance/GPS/overtime | Ya | Ya, bukan milik sendiri | Tidak | Tidak |
| Draft payroll dan XLSX | Ya | Ya | Tidak | Tidak |
| Finalize payroll | Ya | Tidak | Tidak | Tidak |
| Kelola item/settings | Ya | Terbatas operasional | Tidak | Tidak |
| Kelola seluruh user/role/rate | Ya | Tidak | Tidak | Tidak |
| Reset PIN | Semua | OPERATOR saja | PIN sendiri | PIN sendiri |
| Lihat report `SUBMITTED`/`APPROVED` | Ya | Ya | Milik shift | Ya |
| Lihat draft report | Ya | Ya | Sesuai tugas | Tidak |
| Lihat data HR/GPS/payroll orang lain | Ya | Ya untuk tugas HR | Tidak | Tidak |

- `ADMIN` deprecated. Preflight harus memastikan tidak ada akun aktif `ADMIN`; jika ada, owner memetakan ke `OWNER` atau `SUPERVISOR` sebelum API production diaktifkan.
- Approver tidak boleh menyetujui attendance correction, GPS exception, overtime, leave exception, atau payroll adjustment miliknya sendiri.
- Investor tidak boleh menerima nama staff, detail attendance, koordinat, payroll, PIN state, roster draft, atau report draft.

### 3.2 Login, PIN, dan Session

- Login picker menampilkan nama lengkap saja. Role/jabatan tidak ditampilkan.
- `username` tetap internal untuk request login dan uniqueness, tetapi UI menampilkan `display_name`.
- Setiap orang memakai akun dan PIN pribadi; berbagi PIN dilarang.
- PIN tepat enam digit. PIN awal bersifat sementara dan memaksa change PIN sebelum fitur lain.
- Change PIN normal meminta PIN lama, PIN baru, dan konfirmasi.
- Tolak PIN yang seluruh digit sama, sequence naik/turun, tanggal umum, atau masuk denylist konfigurasi.
- Reset PIN mencabut semua session user tersebut dan mengaktifkan kembali `force_pin_change`.
- Multi-device diizinkan. Setiap browser mendapat token session dan random device ID berbeda.
- Logout hanya mencabut session aktif; logout tidak menyelesaikan assignment atau attendance.
- Login ulang harus memulihkan assignment/attendance aktif dari server.

### 3.3 Jadwal, Shift, dan Assignment

- Shift `SIANG`: 11.00-17.00 WIB, durasi terjadwal 6 jam.
- Shift `MALAM`: 17.00-23.00 WIB, durasi terjadwal 6 jam.
- Shift `FULL`: 11.00-23.00 WIB, durasi terjadwal 12 jam.
- Selasa adalah default hari libur outlet; supervisor tetap dapat membuat roster override dengan alasan.
- Istirahat sekitar 30 menit/fleksibel dilakukan dengan handoff verbal ke rekan. Tidak ada clock break dan tidak ada pengurangan durasi otomatis.
- Supervisor membuat roster. Staff dapat meminta dan menerima swap antarstaff tanpa approval supervisor; supervisor tetap melihat event dan hasil swap.
- Supervisor boleh mengisi shift kosong dan tercatat sebagai pekerja.
- Pada hari kerja, user tetap memilih shift, area `BAR|KITCHEN`, dan duty `PRIMARY|HELPER`.
- Perbedaan pilihan dengan roster tidak diblokir, tetapi menghasilkan `SCHEDULE_DEVIATION` untuk review.
- Tepat satu `PRIMARY` aktif per outlet/tanggal/shift/area. Claim bersamaan wajib di-serialize di database.
- Jika primary telah terisi, API mengembalikan HTTP 409 `PRIMARY_TAKEN` dan UI menawarkan `HELPER`.
- Helper terkunci pada area yang dipilih. Helper boleh menyimpan count draft dan movement, tetapi tidak boleh confirm opening, complete handover, submit closing, atau submit daily report.
- Reset/reassign hanya `OWNER|SUPERVISOR`, wajib alasan, dan tidak menghapus history.

### 3.4 Attendance dan Keterlambatan

Urutan check-in wajib:

1. Login.
2. Pilih/restore assignment.
3. Swipe check-in.
4. Ambil one-use challenge dari server.
5. Selesaikan upaya GPS: maksimum tiga sample dalam 15 detik.
6. Kirim challenge, sample, device metadata minimum, dan catatan jika lokasi tidak valid.
7. Server memvalidasi dan baru membuat attendance event.
8. Workspace terbuka setelah server menerima event.

- Check-out memakai flow challenge dan GPS yang sama.
- Tidak boleh ada attendance fact setengah jadi sebelum upaya lokasi selesai.
- GPS denied, timeout, poor accuracy, atau outside radius tetap dapat dicatat sebagai `UNVERIFIED/REVIEW_REQUIRED` dengan catatan wajib; kondisi tersebut tidak hard-block operasional.
- Waktu event selalu waktu server.
- Grace keterlambatan 15 menit: check-in sampai 11.15 untuk SIANG/FULL dan 17.15 untuk MALAM adalah `ON_TIME`; setelah itu `LATE`, tetapi tetap boleh check-in.
- `LATE` adalah fakta, bukan potongan otomatis.
- Check-out yang hilang menjadi `MISSING_CHECKOUT`; tidak menghasilkan jam kerja final atau overtime otomatis.
- Koreksi attendance adalah append-only, membutuhkan nilai pengganti, alasan, actor, waktu, dan approval manager lain jika menyangkut manager.

### 3.5 GPS Web Berlapis

- Radius geofence awal 100 meter dan dapat diubah owner.
- Akurasi maksimum untuk status verified awal 50 meter dan dapat diubah owner.
- Browser meminta high accuracy dan mengumpulkan maksimal tiga sample selama maksimal 15 detik.
- Server memilih sample terbaik, menghitung Haversine, dan tidak mempercayai hasil jarak dari client.
- Challenge acak berlaku maksimum dua menit, terikat ke session, device, action, dan hanya dapat dipakai sekali.
- Risk signals: lokasi di luar radius, akurasi buruk, timestamp client aneh, country header di luar konfigurasi, impossible travel, event duplikat, dua check-in bersamaan, pergantian device tidak biasa, dan koordinat identik berulang yang mencurigakan.
- Random device ID bukan device attestation dan tidak boleh dipasarkan sebagai bukti anti-spoof.
- Browser GPS tetap dapat dimanipulasi. Sistem hanya membuat spoofing lebih sulit dan meninggalkan bukti untuk review.
- Event berisiko tinggi tetap tercatat, tetapi attendance/payroll terkait tidak boleh finalized sebelum review.
- Lokasi hanya diminta saat check-in/check-out.
- Raw GPS sample disimpan maksimum 90 hari secara default; status turunan, jarak, risiko, dan audit disimpan sesuai retention HR yang dikonfigurasi.
- Hanya owner dan supervisor dengan kebutuhan review yang dapat melihat detail GPS; log aplikasi tidak boleh mencetak koordinat.

### 3.6 Stok dan Shift Cycle

- Satu work cycle mewakili satu outlet, work date, shift, dan area.
- Ledger Bar dan Kitchen independen. User area Bar tidak boleh menulis data Kitchen dan sebaliknya.
- Primary semua shift mengonfirmasi physical opening; helper dapat mengisi draft.
- Referensi opening SIANG/FULL berasal dari closing approved terbaru area tersebut.
- Referensi opening MALAM berasal dari handover snapshot SIANG pada work date yang sama; jika tidak ada, gunakan closing approved terbaru dan beri warning.
- System balance per item: `opening_confirmed + incoming - outgoing` sampai movement cutoff.
- Movement append-only. Kesalahan dibalik/dikoreksi oleh movement baru yang menunjuk `correction_of_id`, bukan update/delete.
- Semua movement mempunyai UUID idempotency key dan snapshot unit.
- SIANG diselesaikan tanpa physical closing: server mengunci movement cutoff dan membuat handover snapshot system balance.
- MALAM/FULL melakukan physical closing.
- Closing variance adalah `physical_closing - system_balance`; variance nonzero mewajibkan reason dan note.
- Setelah handover/closing submitted, movement sebelum cutoff tidak dapat ditambah atau diubah. Late movement menjadi correction/revision melalui manager.

### 3.7 Daily Report dan Finance

- Finalizer normal adalah `PRIMARY BAR` pada shift MALAM atau FULL.
- `OWNER|SUPERVISOR` dapat menjadi fallback finalizer dengan alasan audit.
- Submit hanya boleh jika Bar dan Kitchen siap, seluruh item wajib terisi, variance mempunyai alasan, dan offline queue sudah kosong.
- Input finance: Cash Real, Cash App/POS, QRIS Mandiri, dan Debit Mandiri. Nilai channel merupakan nilai net setelah void/refund.
- Server menghitung:
  - `recorded_total = cash_app + qris_mandiri + debit_mandiri`
  - `received_total = cash_real + qris_mandiri + debit_mandiri`
  - `cash_difference = cash_real - cash_app`
- Daftar stok kritis dibuat server dari closing snapshot: `HABIS` jika `qty <= 0`, `HAMPIR_HABIS` jika `0 < qty <= low_threshold`.
- Public identifier revision: `HOP-YYYYMMDD-RNN`, dimulai `R01`.
- Draft dapat disunting sesuai version; revision `SUBMITTED` atau `APPROVED` immutable.
- Investor melihat `SUBMITTED` dengan label **Belum ditinjau**, `NEEDS_CLARIFICATION` sebagai revision terkirim yang perlu perbaikan, dan `APPROVED`.
- Saat clarification diminta, revision lama tetap ada dan draft revision baru dibuat.
- WhatsApp share memakai Web Share/clipboard dan hanya berisi ID, status, ringkasan finance/stok, serta authenticated link. Jangan kirim foto atau daftar manual.

### 3.8 Bonus Omzet

- Dasar bonus adalah `recorded_total` dari report approved.
- Tier:
  - `< Rp600.000`: 0%.
  - `Rp600.000 sampai < Rp1.000.000`: 5%.
  - `Rp1.000.000 sampai < Rp1.200.000`: 6%.
  - `>= Rp1.200.000`: 7%.
- Aturan terbaru adalah pembagian rata, bukan bobot shift lama.
- Eligible participant adalah profile unik yang memiliki assignment dan attendance sah pada tanggal itu, termasuk helper dan supervisor pengganti.
- Attendance `REVIEW_REQUIRED` harus selesai direview sebelum alokasi final.
- Pool dan bagian dihitung server setelah report approved.
- Pembagian dalam rupiah bulat. Sisa pembagian dialokasikan satu rupiah secara deterministik berdasarkan UUID profile terurut dan dicatat di audit.

### 3.9 Payroll Evidence-First

- Payroll release pertama menghasilkan draft dan bukti, bukan keputusan hukum otomatis.
- Compensation disimpan per employee dengan effective date; nama/rate individu tidak boleh di-hardcode di migration atau source.
- Monthly base tetap penuh jika kewajiban roster terpenuhi. Dua puluh empat hari terjadwal yang dipenuhi tetap mendapat monthly base penuh walaupun komposisi shift 6/12 jam berbeda.
- Komposisi shift terjadwal sendiri tidak menambah atau mengurangi base.
- Daily/hourly rate dipakai untuk adjustment yang telah direview.
- Scheduled 6 jam tetapi actual/approved menjadi 12 jam menghasilkan usulan `+6 jam`.
- Scheduled 12 jam tetapi actual/approved menjadi 6 jam menghasilkan usulan `-6 jam`.
- Hari roster di atas baseline 24 diberi flag. Supervisor memilih treatment `BASE|EXTRA|MAKEUP`; owner menyelesaikan dampak uang sebelum finalize.
- Sakit valid sampai dua workday per bulan dan izin lain sampai satu workday per bulan tidak menghasilkan usulan potongan.
- Kelebihan allowance atau `ALPHA` menghasilkan usulan satu daily-rate deduction per workday, selalu melalui review.
- Jangan double-count deduction hari tidak hadir dan shortage hours untuk kejadian yang sama.
- Late setelah grace hanya flag; tidak ada potongan otomatis.
- Overtime candidate hanya jika checkout lebih dari 30 menit setelah scheduled end.
- Rounding overtime strict nearest hour: 0-30 menit = 0; 31-90 = 1 jam; 91-150 = 2 jam; pola berlanjut per 60 menit.
- Overtime dibayar hanya setelah approval owner/supervisor; actor tidak boleh approve miliknya sendiri.
- Early check-in tidak menghasilkan overtime tanpa approval eksplisit.
- Missing checkout tidak menghasilkan overtime.
- Break full shift termasuk durasi karena break tidak dicatat/dipotong.
- Supervisor menyiapkan roster, exception review, overtime, payroll draft, dan XLSX. Owner melakukan finalize payroll.
- Staff hanya dapat melihat recap miliknya sendiri.

### 3.10 Onboarding

- Hanya OPERATOR yang menerima guided onboarding.
- Forced PIN change selesai lebih dahulu.
- Onboarding tampil sekali per `onboarding_version`, tersimpan server per user.
- Materi: assignment, check-in GPS, primary/helper, opening, movement/correction, handover/closing, check-out, offline queue, dan bantuan.
- Tutorial memakai data simulasi terisolasi dan tidak boleh menulis transaksi production.
- User dapat replay melalui menu Bantuan tanpa mengubah status bisnis.

## 4. Arsitektur Target

### 4.1 Runtime

- Pertahankan React/Vite frontend, Vercel serverless API, dan Supabase PostgreSQL.
- Browser hanya berbicara ke same-origin `/api/auth` dan `/api/app`.
- Browser tidak memegang `SUPABASE_SERVICE_ROLE_KEY` dan tidak melakukan write langsung ke Supabase.
- Pertahankan `api/auth.ts` self-contained.
- Buat satu `api/app.ts` self-contained dengan dispatcher `?action=...` untuk business API. Ini sengaja menghindari masalah bundling shared relative import yang pernah terjadi.
- Jangan memecah shared server modules sampai deployment canary membuktikan import tersebut stabil di Vercel Production dan Preview.
- Frontend boleh dipecah menjadi feature modules karena bundling frontend sudah stabil.

### 4.2 Trust Boundary

Setiap mutating request harus melalui urutan berikut:

1. Buat/terima `request_id` UUID.
2. Validasi method, content type, origin, body size, dan schema.
3. Resolve hash session cookie dan active profile.
4. Cek forced PIN state.
5. Cek role, outlet scope, ownership, assignment area, dan self-approval.
6. Cek idempotency key dan optimistic `expected_version`.
7. Panggil RPC transactional menggunakan service role.
8. RPC mengunci row, membaca ulang active actor/role/state, melakukan mutation, dan menulis audit dalam transaksi yang sama.
9. Kembalikan response tanpa PII berlebih dan dengan `Cache-Control: no-store`.

RLS tetap aktif sebagai defense-in-depth, tetapi bukan authorization utama karena service role melewatinya. Revoke seluruh privilege operational dari `anon` dan `authenticated`; hanya `service_role` boleh memanggil command RPC. RPC command juga harus di-revoke dari `public`.

### 4.3 Response Contract

Success:

```json
{
  "ok": true,
  "request_id": "uuid",
  "data": {},
  "version": 2
}
```

Failure:

```json
{
  "ok": false,
  "request_id": "uuid",
  "error": {
    "code": "PRIMARY_TAKEN",
    "message": "Penanggung jawab utama sudah terisi.",
    "details": {}
  }
}
```

Kode minimum: `AUTH_REQUIRED`, `PIN_CHANGE_REQUIRED`, `FORBIDDEN`, `VALIDATION_FAILED`, `ORIGIN_REJECTED`, `RATE_LIMITED`, `STATE_CONFLICT`, `VERSION_CONFLICT`, `PRIMARY_TAKEN`, `IDEMPOTENCY_CONFLICT`, `QUEUE_NOT_SYNCED`, `GPS_CHALLENGE_INVALID`, `GPS_REVIEW_REQUIRED`, `SELF_APPROVAL_FORBIDDEN`, `NOT_FOUND`, `SERVICE_UNAVAILABLE`.

HTTP mapping: validation 400, auth 401, forbidden 403, missing 404, state/version/race/idempotency 409, body too large 413, rate limit 429, dependency error 503.

### 4.4 Frontend Layout Target

```text
src/
  App.tsx
  app/
    routes.tsx
    session.tsx
  domain/
    types.ts
    rules.ts
    money.ts
    time.ts
  lib/
    api.ts
    idb-queue.ts
    request-id.ts
  features/
    auth/
    onboarding/
    assignment/
    attendance/
    stock/
    reports/
    management/
    payroll/
  components/
    feedback/
    forms/
    layout/
```

- `App.tsx` hanya bootstrap session dan role router.
- Domain formulas harus menjadi pure functions dan dites.
- Server state diambil dari API; jangan mirror seluruh database ke global local state.
- IndexedDB hanya untuk stock draft/movement queue yang diizinkan offline.
- `localStorage` hanya boleh menyimpan preferensi visual non-sensitif; hapus semua key demo operational setelah cutover sukses.

## 5. Database dan Migration Plan

### 5.1 Aturan Umum

- Buat migration baru berurutan `0004` sampai `0008`; jangan mengubah migration yang sudah pernah applied.
- Sebelum migration, simpan backup schema/data dan catat row count semua tabel.
- Pastikan tabel legacy `assignments`, `opening_records`, `opening_lines`, `movements`, `closing_reports`, `closing_report_revisions`, dan `closing_lines` kosong. Jika tidak kosong, abort dan ekspor sebelum melanjutkan.
- Reuse `profiles`, `items`, `operator_credentials`, `app_sessions`, dan `audit_events`; buat tabel operational v2 dengan nama baru agar rollback additive.
- Semua tabel domain memakai UUID PK, `outlet_id`, `created_at`, dan FK eksplisit. Gunakan `on delete restrict` untuk fakta bisnis; cascade hanya untuk draft child yang belum submitted.
- Uang disimpan sebagai `numeric(14,0)` rupiah, quantity `numeric(14,4)`, waktu sebagai `timestamptz`, dan business date sebagai `date` hasil WIB.
- Setiap aggregate mutable memiliki `version integer not null default 1 check (version > 0)`.
- Submitted/finalized facts dilindungi trigger yang menolak update/delete. Correction selalu row baru.

### 5.2 `0004_auth_and_tenant_hardening.sql`

Tambahkan:

- `outlets(id, code, name, timezone, active, created_at, updated_at)`; unique lowercase `code`.
- `outlet_settings(outlet_id PK, latitude, longitude, geofence_radius_m default 100, max_accuracy_m default 50, gps_sample_limit default 3, gps_timeout_seconds default 15, late_grace_minutes default 15, overtime_threshold_minutes default 30, raw_gps_retention_days default 90, system_mode, onboarding_version, version, updated_by, updated_at)`.
- `profile_outlet_scopes(profile_id, outlet_id, active, created_at)`; unique pair.
- Tambah ke `profiles`: `force_pin_change boolean default true`, `deactivated_at`, `deactivated_by`, dan `version`.
- Tambah ke `operator_credentials`: `pin_changed_at`, `pin_version`, dan `last_failed_at`.
- `pin_history(id, profile_id, pin_salt, pin_hash, created_at)`; service-role only, pertahankan tiga hash terakhir.
- `app_devices(id, profile_id, device_token_hash, label, first_seen_at, last_seen_at, revoked_at, last_ip_hash, last_user_agent_hash)`.
- Tambah ke `app_sessions`: `device_id`, `ip_hash`, `user_agent_hash`, `absolute_expires_at`.
- `auth_rate_limits(scope_key PK, window_started_at, attempts, blocked_until, updated_at)` untuk credential/IP/device counter atomic.

Auth RPC wajib menggunakan row lock/upsert atomic untuk gagal login. Constant-time hash comparison dilakukan server. Login sukses mereset credential counter tetapi tidak menghapus event audit.

Ubah login options agar hanya memilih `username, display_name`; `job_title` dan `role` tidak boleh keluar dari endpoint publik. Name enumeration diterima sebagai keputusan bisnis, tetapi endpoint tetap rate-limited.

### 5.3 `0005_operations_v2.sql`

Buat enum/status atau equivalent check constraints:

- `duty_role`: `PRIMARY|HELPER`.
- `cycle_status`: `AVAILABLE|ACTIVE|OPEN|HANDOVER_READY|CLOSING_READY|COMPLETED|RESET`.
- `work_assignment_status`: `ACTIVE|PENDING_TASKS|COMPLETED|RESET`.
- `stock_record_status`: `DRAFT|CONFIRMED|LOCKED`.

Buat tabel:

- `shift_templates(id, outlet_id, code, label, start_local, end_local, scheduled_minutes, active, version)`; unique outlet+code; seed SIANG/MALAM/FULL.
- `work_cycles(id, outlet_id, work_date, shift_code, area_code, status, movement_cutoff_at, version, created_at, updated_at)`; unique outlet+date+shift+area.
- `work_assignments(id, cycle_id, work_date, profile_id, duty_role, status, roster_entry_id nullable, schedule_deviation, assigned_at, completed_at, reset_at, reset_by, reset_reason, version)`.
- Partial unique `work_assignments(cycle_id)` where duty=`PRIMARY` and status=`ACTIVE`.
- Unique `work_assignments(cycle_id, profile_id)` dan partial unique `(profile_id, work_date)` untuk assignment aktif, agar satu orang tidak memegang dua area aktif pada hari sama.
- `stock_openings(id, cycle_id unique, status, reference_source_type, reference_source_id, confirmed_at, confirmed_by, version)`.
- `stock_opening_lines(opening_id, item_id, reference_qty, counted_qty, variance_qty, reason_code, notes, updated_by, updated_at)`; PK opening+item.
- `stock_movements(id, cycle_id, item_id, direction, category, quantity, unit_code_snapshot, client_occurred_at, server_occurred_at, created_by, idempotency_key, correction_of_id, correction_reason)`; unique cycle+idempotency key.
- `stock_handovers(id, cycle_id unique, status, movement_cutoff_at, confirmed_at, confirmed_by, version)` dan `stock_handover_lines(handover_id, item_id, opening_qty, incoming_qty, outgoing_qty, system_qty)`.
- `stock_closings(id, cycle_id unique, status, movement_cutoff_at, confirmed_at, confirmed_by, version)` dan `stock_closing_lines(closing_id, item_id, opening_qty, incoming_qty, outgoing_qty, system_qty, counted_qty, variance_qty, reason_code, notes)`.

Checks wajib: quantity movement `> 0`; count `>= 0`; item harus aktif dan area item sama dengan area cycle; SIANG hanya handover; MALAM/FULL boleh closing; hanya primary/manager boleh confirm; helper hanya draft/movement; movement ditolak setelah cutoff.

### 5.4 `0006_roster_attendance.sql`

Buat status: roster `SCHEDULED|SWAPPED|CANCELLED|COMPLETED`; swap `PENDING|ACCEPTED|DECLINED|CANCELLED|EXPIRED`; attendance `NOT_STARTED|CHECKED_IN|CHECKED_OUT|MISSING_CHECKOUT|REVIEW_REQUIRED|APPROVED`; location `VERIFIED|OUTSIDE|POOR_ACCURACY|DENIED|TIMEOUT|UNAVAILABLE|HIGH_RISK`.

Buat tabel:

- `roster_entries(id, outlet_id, work_date, shift_code, profile_id, expected_area nullable, status, pay_treatment BASE|EXTRA|MAKEUP, created_by, source, version, created_at, updated_at)`.
- Partial unique roster aktif per profile+date. Selasa membutuhkan `override_reason`.
- `shift_swap_requests(id, roster_entry_id, requested_by, offered_to, status, expires_at, responded_at, version)`; requester dan target berbeda.
- `attendance_challenges(id, outlet_id, profile_id, session_id, device_id, action CHECK_IN|CHECK_OUT, nonce_hash, expires_at, used_at, created_at)`; unique nonce hash, TTL dua menit.
- `attendance_records(id, outlet_id, work_date, profile_id, roster_entry_id, work_assignment_id, status, scheduled_start_at, scheduled_end_at, check_in_event_id, check_out_event_id, lateness_status, exception_status, version)`; unique profile+work_date.
- `attendance_events(id, attendance_id, event_type CHECK_IN|CHECK_OUT, server_occurred_at, client_occurred_at, challenge_id, device_id, ip_country, location_status, selected_distance_m, selected_accuracy_m, risk_score, risk_reasons jsonb, note, idempotency_key)`; unique attendance+event type dan unique idempotency key.
- `attendance_location_samples(id, event_id, latitude, longitude, accuracy_m, client_sampled_at, sample_order, retained_until)`; no direct client grants.
- `attendance_corrections(id, attendance_id, correction_type, proposed_json, reason, requested_by, status PENDING|APPROVED|REJECTED, reviewed_by, reviewed_at, created_at)`; immutable setelah keputusan.
- `leave_requests(id, outlet_id, profile_id, start_date, end_date, leave_type SICK|OTHER|UNPAID|OTHER_EXCEPTION, reason, submitted_by, status, reviewed_by, reviewed_at, created_at)`.
- `overtime_claims(id, attendance_id, raw_extra_minutes, credited_hours, status CANDIDATE|APPROVED|REJECTED, reason, reviewed_by, reviewed_at, version)`.

Raw attendance events dan location samples tidak boleh di-update/delete oleh application role. Cleanup raw GPS dilakukan RPC terjadwal berdasarkan `retained_until` dan meninggalkan audit jumlah row, bukan koordinat.

### 5.5 `0007_reports_payroll.sql`

Buat tabel:

- `daily_reports(id, outlet_id, work_date, status DRAFT|SUBMITTED|NEEDS_CLARIFICATION|APPROVED, current_revision, version, created_at, updated_at)`; unique outlet+date.
- `daily_report_revisions(id, report_id, revision, public_id, status, bar_closing_id, kitchen_closing_id, handover_ids jsonb, movement_cutoff_at, submitted_by, submitted_at, reviewed_by, reviewed_at, review_note, payload_checksum)`; unique report+revision dan public_id.
- `daily_report_finance(revision_id PK, cash_real, cash_app, qris_mandiri, debit_mandiri, recorded_total, received_total, cash_difference)`.
- `daily_report_stock_lines(revision_id, item_id, area_code, closing_qty, low_threshold_snapshot, stock_status)`; immutable snapshot.
- `daily_bonus_pools(id, report_revision_id unique, recorded_total, tier_percent, pool_amount, status DRAFT|FINAL, calculated_at)`.
- `daily_bonus_allocations(id, pool_id, profile_id, amount, remainder_awarded, attendance_id)`; unique pool+profile.
- `compensation_policies(id, outlet_id, name, minimum_workdays default 24, sick_allowance default 2, other_leave_allowance default 1, effective_from, effective_to, status DRAFT|ACTIVE|RETIRED, version)`.
- `employee_compensations(id, profile_id, policy_id, effective_from, effective_to, monthly_base, daily_rate, hourly_rate, created_by, approved_by, version)`; no overlapping active effective range per profile.
- `payroll_runs(id, outlet_id, period_month, status DRAFT|REVIEWED|FINALIZED|PAID|VOID, policy_id, version, created_by, reviewed_by, finalized_by, finalized_at, payload_checksum)`; unique outlet+month for non-void run.
- `payroll_entries(id, run_id, profile_id, base_amount, attendance_summary jsonb, approved_overtime_amount, approved_shortage_amount, absence_deduction, bonus_amount, manual_adjustment_amount, proposed_gross, final_gross, status, version)`; unique run+profile.
- `payroll_adjustments(id, entry_id, adjustment_type, quantity, rate, amount, source_entity_type, source_entity_id, reason, status, proposed_by, reviewed_by, reviewed_at)`.
- `payroll_exports(id, run_id, format XLSX, file_path, checksum_sha256, generated_by, generated_at, row_counts jsonb)`.
- `onboarding_progress(profile_id, onboarding_version, started_at, completed_at, replay_count, updated_at)`; PK profile+version.

Submitted report revision, final bonus allocation, finalized payroll entry, dan payroll export metadata wajib immutable.

### 5.6 `0008_commands_privileges_audit.sql`

- Tambah `outlet_id`, `subject_user_id`, `ip_hash`, dan `metadata_json` yang telah disanitasi ke `audit_events` bila diperlukan.
- Buat trigger append-only pada `audit_events`, attendance facts, submitted revisions, bonus final, dan payroll final.
- Buat RPC command per aggregate atau per transaksi kritis; semua `security definer`, `set search_path = public, pg_temp`, nama object selalu schema-qualified.
- RPC harus menerima `actor_profile_id`, tetapi selalu membaca ulang actor aktif, role, outlet scope, dan self-approval. Jangan percaya role dari API payload.
- Revoke execute dari `public, anon, authenticated`; grant hanya ke `service_role`.
- Revoke seluruh direct DML operational tables dari `anon, authenticated`.
- Nonaktifkan policy legacy yang memakai `auth.uid()` untuk jalur operational custom-auth. RLS tetap enabled dengan no permissive browser policies.
- Mark tabel legacy deprecated melalui comment dan revoke; jangan drop pada release ini.
- Index minimum: semua FK, outlet+work_date+status, profile+work_date, report status+submitted_at, unresolved exception, active session/challenge expiry, audit entity+time, dan payroll period.

## 6. State Machines

### 6.1 Auth

| Dari | Aksi | Ke | Actor |
|---|---|---|---|
| Temp PIN | Login benar | `PIN_CHANGE_REQUIRED` | User |
| `PIN_CHANGE_REQUIRED` | Change PIN valid | Authenticated | User |
| Authenticated | Logout/expiry/reset/deactivate | Revoked | User/system/manager |
| Active credential | 5 kegagalan atomic | Locked 15 menit | System |

Semua action selain `me/logout/changePin` ditolak dengan `PIN_CHANGE_REQUIRED` selama forced change aktif.

### 6.2 Roster dan Swap

- `SCHEDULED -> SWAPPED` hanya setelah target menerima request `PENDING` yang belum expired.
- `PENDING -> ACCEPTED|DECLINED|CANCELLED|EXPIRED` terminal.
- Accept transaksi mengakhiri entry lama dan membuat/mengalihkan entry target tanpa duplicate roster.
- Supervisor tidak perlu approve, tetapi menerima dashboard event.

### 6.3 Cycle dan Assignment

- Cycle: `AVAILABLE -> ACTIVE -> OPEN -> HANDOVER_READY|CLOSING_READY -> COMPLETED`.
- `RESET` hanya dari state non-final oleh manager dengan alasan; reset membuat successor cycle/version, bukan menghapus fakta.
- Assignment normal: `ACTIVE -> COMPLETED|RESET`; emergency: `ACTIVE -> PENDING_TASKS -> COMPLETED|RESET` setelah review/tugas dibereskan.
- Helper tidak dapat memicu transition cycle.
- Transition di luar urutan mengembalikan `STATE_CONFLICT` beserta current state/version.

### 6.4 Attendance

- `NOT_STARTED -> CHECKED_IN -> CHECKED_OUT` adalah jalur normal.
- Setelah scheduled end tanpa checkout, derived state menjadi `MISSING_CHECKOUT`.
- Event dengan risiko lokasi menjadi `REVIEW_REQUIRED`; review valid mengarah `APPROVED`, koreksi tetap terpisah.
- Check-out sebelum check-in, duplicate event, challenge expired/used, atau event beda user ditolak.

### 6.5 Report

- `DRAFT -> SUBMITTED -> APPROVED`.
- `SUBMITTED -> NEEDS_CLARIFICATION` membuat draft revision berikutnya.
- Draft revision baru dapat `SUBMITTED`; revision sebelumnya tetap immutable.
- Investor tidak pernah menerima payload `DRAFT`.

### 6.6 Leave, Overtime, Payroll

- Leave: `PENDING -> APPROVED|REJECTED|CANCELLED`; approved tidak diedit, perubahan dibuat request baru.
- Overtime: `CANDIDATE -> APPROVED|REJECTED`; missing checkout tidak boleh membuat candidate.
- Payroll: `DRAFT -> REVIEWED -> FINALIZED -> PAID`; `VOID` membutuhkan owner, alasan, dan replacement run.
- Setelah `FINALIZED`, angka entry immutable. Perbaikan dilakukan dengan void/replacement, bukan update.

## 7. API Contract dan Action Inventory

Semua response memakai envelope pada 4.3, session cookie, same-origin, request ID, schema validation, dan `Cache-Control: no-store`. Semua POST mutasi menerima `idempotency_key`; update aggregate juga menerima `expected_version`.

### 7.1 `/api/auth?action=...`

| Action | Method | Actor | Perilaku wajib |
|---|---|---|---|
| `options` | GET | Publik | Nama aktif saja; rate limit; tanpa job title/role |
| `me` | GET | Session/anon | Profile publik, role, forced PIN state, session expiry |
| `login` | POST | Publik | Atomic credential/IP/device limit; generic error; issue secure session/device cookie |
| `logout` | POST | Session | Revoke session aktif; tidak mengubah assignment/attendance |
| `changePin` | POST | Session | Old/new/confirm, denylist/history, revoke session lain, clear force flag |
| `resetPin` | POST | Owner/supervisor | Owner semua; supervisor OPERATOR saja; temp PIN dikembalikan sekali; revoke semua session |
| `sessions.list` | GET | Self/owner | Device label dan last seen tanpa token/IP mentah |
| `sessions.revoke` | POST | Self/owner | Revoke satu/all session sesuai scope |
| `users.list` | GET | Owner; supervisor terbatas | Supervisor hanya staff operational tanpa credential data |
| `users.create/update/deactivate` | POST | Owner | Validate unique username/role/outlet; deactivate mencabut session |

Cookie target production: `__Host-hopin_session`, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`; host-only tanpa `Domain`. Saat cutover, revoke cookie/session format lama secara eksplisit.

### 7.2 `/api/app?action=...`: Bootstrap dan Management

| Action | Method | Actor | Perilaku/kegagalan utama |
|---|---|---|---|
| `bootstrap` | GET | Semua session | Profile, outlet, settings aman, role capabilities, active roster/assignment/attendance, onboarding state |
| `dashboard.get` | GET | Owner/supervisor | Status cycle, queue blockers, missing checkout, GPS review, report/payroll progress |
| `investor.reports` | GET | Investor/owner | Hanya submitted/approved projection; tidak join HR |
| `settings.get` | GET | Owner/supervisor | Supervisor read operational; koordinat hanya owner atau masked untuk supervisor |
| `settings.update` | POST | Owner | Validate ranges, version conflict, audit before/after tanpa raw secret |
| `items.list` | GET | Session | Active items sesuai role/area; investor hanya stock snapshot report |
| `items.create/update/archive` | POST | Owner | Tidak boleh hard-delete item yang pernah dipakai |

### 7.3 Roster, Swap, dan Assignment

| Action | Method | Actor | Perilaku/kegagalan utama |
|---|---|---|---|
| `roster.list` | GET | Owner/supervisor/self | Self hanya roster sendiri; manager dapat outlet/month |
| `roster.save` | POST | Owner/supervisor | Upsert transaction, Tuesday override reason, treatment BASE/EXTRA/MAKEUP |
| `swap.request` | POST | Operator/supervisor | Hanya entry sendiri yang aktif; target berbeda; expiry wajib |
| `swap.respond` | POST | Target | Accept/decline atomic; 409 jika roster target bentrok |
| `swap.cancel` | POST | Requester | Hanya PENDING |
| `assignment.claim` | POST | Worker | Pilih date/shift/area/duty; compare roster; primary race row lock + partial unique |
| `assignment.active` | GET | Worker/manager | Restore server state setelah login/refresh |
| `assignment.reset` | POST | Owner/supervisor | Reason wajib; supervisor hanya operational staff; successor/audit |
| `assignment.complete` | POST | Assigned worker/manager | Menutup assignment pribadi setelah checkout; primary cycle completion tetap hanya melalui handover/closing |

`assignment.claim` yang kalah race mengembalikan 409 `PRIMARY_TAKEN` dengan `can_join_as_helper: true`, tanpa membocorkan data yang tidak diperlukan.

### 7.4 Attendance dan HR Exceptions

| Action | Method | Actor | Perilaku/kegagalan utama |
|---|---|---|---|
| `attendance.challenge` | POST | Worker | Issue nonce untuk CHECK_IN/OUT terikat session/device, TTL 2 menit |
| `attendance.checkIn` | POST | Worker | Validate challenge/samples/assignment, compute GPS risk, create event atomic |
| `attendance.checkOut` | POST | Worker | Derive duration/overtime; normal mode cek queue, emergency mode wajib reason dan menghasilkan `PENDING_TASKS/REVIEW_REQUIRED` |
| `attendance.mine` | GET | Self | Recap sendiri tanpa raw coordinate setelah retention |
| `attendance.exceptions` | GET | Owner/supervisor | Filter unresolved late/GPS/missing/deviation |
| `attendance.correction.request` | POST | Self/manager | Append proposed correction dan reason |
| `attendance.correction.review` | POST | Owner/supervisor | No self-approval; approve/reject immutable |
| `leave.request/cancel` | POST | Self/manager | Manager dapat input atas nama staff dengan audit |
| `leave.review` | POST | Owner/supervisor | No self-approval; quota menghasilkan warning, bukan silent reject |
| `overtime.list` | GET | Owner/supervisor/self | Self hanya milik sendiri |
| `overtime.review` | POST | Owner/supervisor | No self-approval; credited hours server-calculated |

### 7.5 Stock Operations

| Action | Method | Actor | Perilaku/kegagalan utama |
|---|---|---|---|
| `cycle.get` | GET | Assigned/manager | Snapshot cycle, opening, movements, balances, permissions, version |
| `opening.saveDraft` | POST | Primary/helper/manager | Area-bound; version/idempotency; count nonnegative |
| `opening.confirm` | POST | Primary/manager | Semua item lengkap; variance reason+note; immutable confirm |
| `movement.create` | POST | Primary/helper/manager | Opening confirmed, sebelum cutoff, area item match, UUID idempotency |
| `movement.correct` | POST | Creator/manager | Append reversal/correction, reference original, reason wajib |
| `handover.complete` | POST | Primary SIANG/manager | Queue sync, lock cutoff, generate system snapshot transactionally |
| `closing.saveDraft` | POST | Primary/helper/manager | MALAM/FULL; helper draft only |
| `closing.confirm` | POST | Primary/manager | Count lengkap, variance reason+note, lock cutoff/snapshot |

Duplicate idempotency dengan payload identik mengembalikan hasil asli; key sama dengan payload berbeda mengembalikan 409 `IDEMPOTENCY_CONFLICT`.

### 7.6 Daily Report, Bonus, Payroll, dan Export

| Action | Method | Actor | Perilaku/kegagalan utama |
|---|---|---|---|
| `report.get/list` | GET | Scoped role | Projection berdasarkan role/status; investor tidak pernah draft |
| `report.finance.save` | POST | Bar primary/manager | Simpan draft channel net; server totals; optimistic version |
| `report.submit` | POST | Bar primary MALAM/FULL/manager | Kedua area ready, queue empty, snapshot+checksum+revision atomic |
| `report.review` | POST | Owner/supervisor | Approve atau clarification; no self-approval untuk fallback submit milik sendiri |
| `report.share` | GET | Scoped role | Bangun text/link; link tetap meminta login |
| `bonus.preview` | GET | Owner/supervisor | Server tier + eligible participant; blocker attendance terlihat |
| `bonus.finalize` | POST | Owner/supervisor | Hanya approved report dan reviewed attendance; immutable allocation |
| `payroll.preview` | POST | Owner/supervisor | Build/rebuild DRAFT dari facts dan policy version |
| `payroll.entry.adjust` | POST | Owner/supervisor | Source/reason wajib; no self-approval |
| `payroll.review` | POST | Supervisor/owner | DRAFT ke REVIEWED jika semua blocker selesai |
| `payroll.finalize` | POST | Owner | REVIEWED ke FINALIZED, checksum immutable |
| `payroll.markPaid/void` | POST | Owner | Reason/reference pembayaran; void membuat replacement path |
| `payroll.export.xlsx` | POST | Owner/supervisor | Generate snapshot file, checksum, audit; finalized atau jelas berlabel DRAFT |
| `onboarding.get/complete/replay` | GET/POST | Operator | Versioned; tutorial tidak menyentuh domain production |

## 8. Domain Algorithms

### 8.1 WIB Business Time

```text
instant = server now()
local = instant converted with IANA zone Asia/Jakarta
work_date = local calendar date
scheduled_start/end = work_date + shift template local times converted to timestamptz
never derive work_date from browser timezone or ISO UTC substring
```

Tests wajib mencakup sebelum/sesudah tengah malam WIB dan UTC date yang berbeda.

### 8.2 GPS Verification dan Risk

```text
assert challenge belongs to session + device + action and is unused/unexpired
validate 1..3 samples, numeric ranges, accuracy > 0, payload size
for each sample:
  distance = server_haversine(sample.latlng, outlet.latlng)
best = sample with lowest accuracy, then lowest distance
location_status = VERIFIED only when
  best.distance <= geofence_radius_m AND best.accuracy <= max_accuracy_m
otherwise map to OUTSIDE or POOR_ACCURACY

risk = 0; reasons = []
add configured points for outside, poor accuracy, impossible travel,
country mismatch, duplicate/concurrent event, abnormal device change,
client/server timestamp anomaly, suspicious repeated coordinates
if permission denied/timeout/unavailable: explicit status, not fabricated coordinates
if non-verified: note is mandatory
if risk >= review threshold: attendance status REVIEW_REQUIRED
consume challenge and insert event/samples/audit in one transaction
```

Do not inspect or claim detection of browser developer tools. Do not trust client-calculated distance, timezone, risk, or status.

### 8.3 Stock Reference dan Balance

```text
reference(opening MALAM) = SIANG handover snapshot same date/area
reference(opening SIANG or FULL) = latest approved closing before work_date/area
if source absent = zero only with manager-approved initialization event

incoming = sum(valid IN movements through cutoff)
outgoing = sum(valid OUT movements through cutoff)
system_qty = confirmed_opening_qty + incoming - outgoing
variance = physical_count - system_qty
```

Correction movement must net the original explicitly; never mutate aggregate caches without rebuilding from ledger inside the same transaction.

### 8.4 Report Finance dan Stock Status

```text
recorded_total = cash_app + qris_mandiri + debit_mandiri
received_total = cash_real + qris_mandiri + debit_mandiri
cash_difference = cash_real - cash_app
stock_status = HABIS if closing <= 0
             = HAMPIR_HABIS if closing <= threshold
             = AMAN otherwise
```

All inputs must be whole rupiah and nonnegative. Negative cash difference is allowed. Computed fields are never accepted from client.

### 8.5 Bonus

```text
if recorded_total < 600000: rate = 0
else if recorded_total < 1000000: rate = 0.05
else if recorded_total < 1200000: rate = 0.06
else: rate = 0.07

pool = round_to_whole_rupiah(recorded_total * rate)
participants = unique profiles with active/completed assignment
               and reviewed-valid attendance on work_date
base_share = floor(pool / participant_count)
remainder = pool - base_share * participant_count
sort participants by profile UUID
give +1 rupiah to first `remainder` participants
assert sum(allocations) == pool
```

Jika participant count nol atau masih ada attendance blocker, bonus tidak boleh final.

### 8.6 Attendance, Overtime, dan Payroll Evidence

```text
late = check_in_server > scheduled_start + 15 minutes
raw_extra = max(0, check_out_server - scheduled_end)
credited_overtime_hours = 0 when raw_extra <= 30 minutes
credited_overtime_hours = floor((raw_extra_minutes + 29) / 60) otherwise
```

Boundary wajib: 30 -> 0, 31 -> 1, 90 -> 1, 91 -> 2. Overtime tetap nol sampai claim approved.

Payroll draft per employee:

```text
base = effective monthly_base
fulfilled = roster BASE days satisfied by valid attendance or approved paid leave
schedule_delta = sum approved(actual scheduled-equivalent hours - roster hours)
overtime_amount = approved credited hours * effective hourly_rate
shortage_amount = approved shortage hours * effective hourly_rate
absence_deduction = reviewed ALPHA/excess-leave days * effective daily_rate
bonus_amount = sum finalized daily bonus allocations in period
manual_adjustment = sum approved auditable adjustments
proposed_gross = base + overtime_amount - shortage_amount
                 - absence_deduction + bonus_amount + manual_adjustment
```

- Normal roster mix 6/12 tidak menjadi `schedule_delta`.
- Roster 6 yang benar-benar dikonversi dan disetujui menjadi 12 memberi delta +6.
- Roster 12 yang disetujui menjadi 6 memberi delta -6.
- BASE day di atas/bawah 24, paid leave, allowance, dan treatment EXTRA/MAKEUP harus terlihat sebagai evidence dan blocker sampai direview.
- Satu kejadian tidak boleh menghasilkan sekaligus full-day absence deduction dan shortage deduction.
- Formula menghasilkan usulan; hanya owner finalize yang menjadikannya payroll final.

### 8.7 Concurrency dan Optimistic Version

- RPC membaca aggregate `for update`, membandingkan `expected_version`, lalu increment tepat sekali.
- Primary claim mengandalkan row lock cycle dan partial unique index; jangan memakai pre-check client.
- Report number dibuat di transaksi dengan unique outlet/date/revision.
- Retry network memakai idempotency key yang sama.
- 409 version conflict mengembalikan current version dan safe current projection; UI meminta refresh/review, bukan overwrite otomatis.

## 9. Offline dan Sinkronisasi

### 9.1 Yang Wajib Online

- Login/change PIN/reset PIN.
- Claim/reset assignment.
- Attendance challenge, check-in, dan server-accepted check-out.
- Confirm opening, handover, closing, report submit/review, bonus finalize, dan payroll finalize.

Jika check-out dilakukan saat offline, UI boleh menyimpan **pending intent** agar input tidak hilang, tetapi belum boleh menyatakan user telah check-out. Setelah online, GPS/challenge baru harus diambil ulang; server time saat acceptance menjadi fakta. Jelaskan ini secara eksplisit kepada user.

Saat online tetapi queue/tugas belum selesai, user boleh memilih emergency checkout. Server tetap mencatat GPS checkout dan attendance `REVIEW_REQUIRED`, mengubah assignment pribadi menjadi `PENDING_TASKS`, serta membiarkan cycle/report terkunci sampai primary/manager menyelesaikan atau mengoreksi tugas. Helper tidak boleh terjebak dalam assignment aktif hanya karena ia tidak berwenang menyelesaikan cycle.

### 9.2 Yang Boleh Offline

- Draft count opening/closing yang belum dikonfirmasi.
- Movement stock setelah opening server-confirmed dan sebelum server cutoff yang terakhir diketahui.
- Catatan/reason draft non-final.

Gunakan IndexedDB, bukan `localStorage`, dengan record:

```text
queue_id UUID
idempotency_key UUID
action
aggregate_id
base_version
payload
created_at_client
attempt_count
last_error_code
state PENDING|SENDING|CONFLICT|SYNCED
```

- Replay FIFO per aggregate; aggregate berbeda dapat berjalan paralel secara terbatas.
- Retry hanya error network/5xx/429 dengan exponential backoff + jitter.
- Jangan retry otomatis 400/403/409.
- Payload 409 masuk layar conflict; user memilih refresh, re-enter, atau manager correction. Jangan last-write-wins.
- Response sukses menghapus payload sensitif dari queue dan menyimpan receipt minimum.
- Report/handover/closing submit dikunci selama queue cycle terkait belum `SYNCED`.
- Queue harus dipisahkan per authenticated profile dan outlet; logout tidak menghapus queue, tetapi user lain tidak dapat membacanya.
- Setelah server bootstrap production pertama berhasil, hapus key demo `hopin-stock-demo-*`, `hopin-assignment-demo-*`, dan `hopin-stock-local-lease-*`. Jangan pernah fallback ke data demo saat API gagal.

## 10. UI dan UX Production

Pertahankan visual language yang sudah ada, tetapi ubah data source dan navigasinya. Semua layar wajib usable pada 360 px mobile dan desktop, keyboard accessible, mempunyai focus visible, label form, status text selain warna, live-region yang tidak berisik, serta reduced-motion support.

### 10.1 Routing Berdasarkan Role

- Unauthenticated: Login.
- Forced PIN: Change PIN; route lain terkunci.
- OPERATOR tanpa onboarding current: Tutorial.
- OPERATOR/SUPERVISOR/OWNER yang memilih bekerja: Assignment -> Check-in -> Workspace -> Check-out.
- OWNER: Management dashboard default, dengan tombol masuk mode kerja.
- SUPERVISOR: Operations/HR dashboard default, dengan tombol isi shift kosong.
- INVESTOR: Submitted reports dashboard; tidak pernah melihat assignment picker.
- Login/refresh selalu memanggil `bootstrap` dan melanjutkan active server state.

### 10.2 Staff Screens

1. Login picker nama lengkap + PIN.
2. Forced PIN change.
3. Staff onboarding versioned.
4. Roster hari ini dan swap status.
5. Assignment picker dengan roster comparison, area, PRIMARY/HELPER, dan confirmation sheet.
6. Swipe check-in dengan progress `Meminta lokasi -> Mengukur -> Memverifikasi -> Tercatat`.
7. GPS exception note jika unverified; jangan tampilkan sukses sebelum server acceptance.
8. Workspace area locked: Overview, Opening, Movement, Handover/Closing, Report status.
9. Offline queue drawer dengan pending/conflict detail.
10. Swipe check-out dengan preflight pending movement dan location flow.
11. Own attendance/payroll recap dan menu Bantuan/replay tutorial.

Helper melihat badge jelas dan action confirm disabled dengan alasan. Primary race menampilkan pilihan menjadi helper. Schedule mismatch menampilkan warning yang tidak menghalangi claim.

### 10.3 Management Screens

- Dashboard outlet: cycle per area/shift, siapa primary/helper, check-in state, stale/missing checkout, unsynced blocker, report state.
- User management: create/deactivate/role/outlet scope/temp PIN reset; PIN hanya ditampilkan satu kali setelah reset.
- Item management: area/unit/decimal scale/low threshold/archive.
- Roster calendar: shift, swaps, gap, Tuesday override, BASE/EXTRA/MAKEUP.
- Attendance exceptions: late, GPS risk, missing checkout, schedule deviation, correction review.
- Daily reports: draft for management, submitted/clarification/approved revisions, finance, stock snapshot, share link.
- Payroll: period blockers, per-user evidence, adjustments, review, owner finalize, XLSX export.
- Settings owner: outlet location captured while physically on site, radius/accuracy, policy effective dates, system mode.
- Audit viewer: filter actor/action/entity/date tanpa menampilkan PIN/hash/raw coordinate.

### 10.4 Required UI States

Setiap fetch/mutation harus memiliki loading, empty, permission-denied, validation, offline, timeout, stale-version, retryable server error, dan success state. Destructive/irreversible action memakai confirmation dengan dampak dan reason. Jangan memakai generic `alert()`.

## 11. XLSX Payroll Specification

Gunakan library server-side yang terawat seperti `exceljs`. File dibuat dari payroll run snapshot, bukan query live setelah finalize. Nama: `HOPIN-PAYROLL-YYYY-MM-<RUN_ID_SHORT>.xlsx`.

Simpan file pada private Supabase Storage bucket `payroll-exports`. Download hanya melalui authorization API dan signed URL maksimum lima menit; bucket tidak boleh public.

### 11.1 Sheet `Summary`

Kolom: Employee ID internal, Nama, Periode, Policy Version, Compensation Effective Date, Monthly Base, Roster BASE Days, Fulfilled Days, Sick Paid Days, Other Leave Paid Days, Alpha/Excess Days, EXTRA Days, MAKEUP Days, Approved Overtime Hours, Approved Shortage Hours, Overtime Amount, Shortage Amount, Absence Deduction, Bonus Amount, Manual Adjustment, Proposed Gross, Final Gross, Status, Reviewer, Finalized At.

### 11.2 Sheet `Attendance`

Kolom: Tanggal WIB, Nama, Roster Shift, Selected Shift, Area, Duty, Scheduled Start/End, Server Check-in/Out, Status, Late Flag, Location In/Out Status, Distance/Accuracy turunan, Schedule Deviation, Actual Duration, Correction Status. Jangan ekspor lat/lng mentah.

### 11.3 Sheet Lain

- `Exceptions`: tanggal, user, jenis, source ID, fakta, usulan, status, reason, reviewer, review time.
- `Overtime`: tanggal, scheduled end, checkout, raw minutes, credited hours, rate, amount, status, reviewer.
- `Bonus`: report ID, tanggal, recorded total, tier, pool, participant count, user, allocation, remainder flag.
- `Adjustments`: employee, type, quantity, rate, amount, source, reason, proposer, reviewer.
- `Audit`: event time, actor display, action, entity type/ID, request ID, reason; data sensitif disensor.

Baris atas setiap sheet memuat run ID, generated at, status `DRAFT|FINALIZED`, timezone, dan checksum source. Freeze header, aktifkan filter, format rupiah/tanggal, cegah formula injection dengan prefix apostrophe untuk cell text yang dimulai `=,+,-,@`. Simpan SHA-256 file, row count per sheet, generator, dan timestamp ke `payroll_exports`.

## 12. Security dan Privacy Checklist

- [ ] Atomic failed-attempt counter dan lockout credential/IP/device.
- [ ] Generic login failure; tidak membedakan user tidak ada, PIN salah, atau locked.
- [ ] Constant-time compare untuk derived PIN hash.
- [ ] Enam-digit PIN dilindungi rate limit; PIN lemah/history ditolak.
- [ ] Secure `__Host-hopin_session`, HttpOnly, SameSite=Lax, host-only, no-store.
- [ ] Session rotation saat login/change PIN; reset/deactivate revoke semua session.
- [ ] Cleanup expired sessions/challenges/rate-limit windows terjadwal.
- [ ] Same-origin allowlist dan CSRF/origin check pada seluruh POST.
- [ ] CORS tidak memakai wildcard credentialed origin.
- [ ] Strict schema validation, body limit, numeric bound, string length, dan enum allowlist.
- [ ] CSP, HSTS, frame-ancestors, nosniff, referrer policy, dan permissions policy untuk geolocation same-origin.
- [ ] Service-role hanya server runtime; tidak pernah memakai prefix `VITE_`.
- [ ] Direct grants anon/authenticated pada operational/auth/HR tables dicabut.
- [ ] RPC security-definer memakai fixed search path dan explicit authorization.
- [ ] Audit tidak menyimpan PIN, hash, cookie, full IP, user agent mentah, atau raw GPS.
- [ ] IP disimpan sebagai keyed hash/short-lived risk evidence, bukan plaintext permanen.
- [ ] Raw coordinate hanya di tabel terbatas, tidak di log/export/investor payload.
- [ ] Retention cleanup GPS dites dan diaudit.
- [ ] Investor projection tidak join profiles/attendance/payroll.
- [ ] Dependency audit dan lockfile review dilakukan sebelum release.
- [ ] Error production tidak mengembalikan stack trace/schema/internal query.
- [ ] Nama aktif pada login options adalah account enumeration yang diterima secara sadar; endpoint tetap rate-limited.

## 13. Test Strategy dan Gates

### 13.1 Tooling

Tambahkan:

- Vitest untuk pure domain/API unit tests.
- React Testing Library + user-event untuk component/flow tests.
- Local Supabase CLI reset + SQL assertion/integration tests untuk constraints/RPC.
- Playwright untuk E2E desktop dan mobile viewport.
- Test clock/fake timers dan deterministic WIB fixtures.

Ubah scripts sehingga `pnpm test` menjalankan test nyata, bukan alias lint. Target scripts:

```json
{
  "lint": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:db": "supabase db reset && vitest run --config vitest.db.config.ts",
  "test:e2e": "playwright test",
  "build": "vite build"
}
```

### 13.2 Wajib Dites

- Auth: options tanpa title/role, login generic error, attempts 4/5, concurrent failures, locked expiry, forced PIN, weak/history PIN, change/revoke, reset scope, deactivated user, multi-device.
- RBAC: setiap forbidden action per role; cross-user/cross-area/cross-outlet denial; investor draft/HR denial; self-approval denial.
- Assignment: primary simultaneous race hanya satu menang, loser 409 helper offer, duplicate retry, schedule deviation, manager reset history.
- Stock: reference prior closing/handover, missing reference initialization, helper confirm denial, area mismatch, duplicate movement idempotency, conflicting payload, correction ledger, cutoff rejection, variance requirements.
- Offline: ordered replay, retryable/non-retryable error, logout isolation, stale version conflict, queue blocks finalization, no localStorage fallback.
- GPS: verified, outside, 50m boundary, poor accuracy, denied, timeout, expired/used challenge, impossible travel, duplicate/concurrent device, required note, no raw coordinate in logs.
- Attendance: grace at 11:15/17:15, late one second later, duplicate swipe, checkout before checkin, missing checkout, append-only correction.
- Overtime: 30=0, 31=1, 90=1, 91=2, missing checkout=0, self-approval denial.
- Payroll: 24 fulfilled mixed 6/12 retains full base; 6->12 +6h; 12->6 -6h; sick 2, sick 3, leave 1/2, alpha, no double-count, EXTRA/MAKEUP blocker, effective rate boundary, final immutability.
- Bonus: exact tier boundaries 599999/600000/999999/1000000/1199999/1200000, equal unique participants, helper/supervisor, remainder, unresolved attendance blocker.
- Report: server totals, negative cash difference, both-area precondition, immutable revision, clarification new draft, investor visibility.
- Time: UTC/WIB date difference, midnight, Tuesday override, month boundary/effective compensation.
- XLSX: sheets/columns/formats, totals reconcile, formula-injection defense, checksum, draft label, no raw coordinates.
- UI: keyboard/focus, screen-reader labels/live regions, reduced motion, 360px mobile, desktop, loading/empty/error/offline/conflict.

### 13.3 Release Gate

Jalankan dan wajib lulus:

```bash
pnpm lint
pnpm test
pnpm build
pnpm test:db
pnpm test:e2e
git diff --check
```

Tidak boleh deploy production bila satu gate gagal, test diskip, migration drift, atau smoke staging belum lulus.

## 14. Execution Phases

Setiap fase wajib mengubah `ACTION_LOG.md` dari pending -> active -> verified. Jalankan gate relevan sebelum melanjutkan. File paths berikut adalah target; eksekutor boleh menambah file test kecil yang jelas, tetapi tidak boleh mengubah aturan domain.

### Phase 0 - Baseline dan Preflight

Target files: `ACTION_LOG.md`, dokumentasi hasil inspeksi sementara bila diperlukan.

Tasks:

1. Catat branch, HEAD, `git status`, remote tracking, Node/pnpm/Supabase CLI version.
2. Jalankan baseline `pnpm install --frozen-lockfile`, lint, current test, dan build.
3. Verifikasi migration remote `0001-0003` applied dan tidak ada drift.
4. Ambil backup production sebelum perubahan schema.
5. Query row count seluruh tabel legacy operational dan auth. Jangan tampilkan credential data.
6. Verifikasi tidak ada active `ADMIN`; jika ada, stop untuk role mapping owner.
7. Verifikasi environment server tersedia tanpa mencetak nilainya.

Acceptance: baseline terdokumentasi, backup ada, legacy operational kosong, profile/auth utuh.
Stop/rollback: tidak ada mutation pada fase ini; stop jika data legacy nonempty atau drift.

### Phase 1 - Test Harness

Target files: `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `playwright.config.ts`, `src/test/*`, `tests/*`.

Tasks:

1. Tambahkan Vitest, RTL, Playwright, dan setup DOM.
2. Pisahkan pure rules awal dari `App.tsx` tanpa mengubah behavior.
3. Buat smoke unit dan E2E login-page test.
4. Buat scripts final pada 13.1.

Acceptance: lint, unit smoke, build, dan Playwright smoke lulus lokal.
Rollback: revert hanya file fase ini bila tooling tidak dapat berjalan; jangan lanjut tanpa test harness.

### Phase 2 - Schema dan Auth Hardening

Target files: `supabase/migrations/0004_auth_and_tenant_hardening.sql` sampai `0008_commands_privileges_audit.sql`, `scripts/provision-user.mjs`, DB tests.

Tasks:

1. Implement migration 0004-0008 sesuai bagian 5 dengan migration additive.
2. Seed satu outlet, settings non-secret, dan shift templates; koordinat tetap nullable sampai owner setup.
3. Harden auth RPC/counter, force PIN, device/session metadata, privileges, append-only triggers.
4. Buat SQL tests untuk constraints, privileges, immutability, primary race, state transitions, dan self-approval.
5. Jalankan local `supabase db reset` dari nol serta upgrade-path test dari 0001-0003.

Acceptance: fresh reset dan upgrade path identik; anon/authenticated tidak dapat direct DML; service RPC success/denial tests lulus.
Rollback: migration belum masuk production; perbaiki dengan migration baru jika sudah applied pada staging, jangan edit migration applied.

### Phase 3 - Auth API dan Business API Foundation

Target files: `api/auth.ts`, `api/app.ts`, `api/health.ts`, API tests, env docs.

Tasks:

1. Harden `api/auth.ts`; hilangkan job title dari options; implement PIN/session/user actions.
2. Buat self-contained `api/app.ts` dengan dispatcher, session validation, origin check, schema/body limits, role checks, request ID, error envelope.
3. Implement bootstrap/settings/items primitives dan RPC adapter.
4. Health hanya liveness; readiness melakukan query aman tanpa secret/data.
5. Tambahkan structured logging redacted.

Acceptance: API integration tests untuk auth/RBAC/error/no-store lulus; canary Preview membuktikan kedua function tidak crash.
Rollback: rollback deployment API; schema additive tetap aman.

### Phase 4 - Frontend Server Cutover

Target files: `src/App.tsx`, `src/app/*`, `src/domain/*`, `src/lib/api.ts`, feature auth/management shell, CSS terkait.

Tasks:

1. Pecah App sesuai 4.4 tanpa redesign visual menyeluruh.
2. Implement bootstrap/session/role routing dan forced PIN flow.
3. Ganti dashboard seed/localStorage dengan server projections.
4. Tambahkan global loading/offline/error/version-conflict handling.
5. Jangan hapus local demo keys sampai server bootstrap sukses; setelah itu hapus dan jangan fallback.

Acceptance: semua role route benar, refresh restore server state, API failure tidak menampilkan demo data, mobile/a11y smoke lulus.
Rollback: matikan feature pada staging; jangan dual-write atau menghidupkan fallback production.

### Phase 5 - Roster, Assignment, dan Stock

Target files: feature `assignment`, `stock`, management roster; `src/lib/idb-queue.ts`; API actions/RPC/tests.

Tasks:

1. Implement roster calendar, swap peer-to-peer, gap/Tuesday override/treatment.
2. Implement self-selection dan primary/helper race.
3. Implement opening, movement/correction, SIANG handover, MALAM/FULL closing.
4. Implement IndexedDB queue hanya untuk draft/movement dan conflict UX.
5. Enforce cross-area/helper/cutoff rules server-side.

Acceptance: two-device primary race, helper denial, full SIANG->MALAM handover, correction, offline replay, and queue-block finalization E2E pass.
Rollback: disable operational feature in staging; keep additive rows, never return to dual-write.

### Phase 6 - Daily Report, Investor, dan Bonus

Target files: features `reports`, investor dashboard, finance forms, share helper; API/RPC/tests.

Tasks:

1. Implement finance draft and server totals.
2. Generate immutable area snapshots/report revision/public ID.
3. Implement submit, clarification, resubmit, approve, and share text.
4. Implement investor projection strictly by status.
5. Implement bonus preview/final equal allocation and blockers.

Acceptance: report cannot submit until both areas/queue ready; revision immutable; investor sees submitted/approved only; all bonus boundaries reconcile.
Rollback: hide feature flag on staging; preserve revisions.

### Phase 7 - Attendance, GPS, dan HR Exceptions

Target files: features `attendance`, GPS service, exception dashboard; challenge/event API/RPC; retention job/tests.

Tasks:

1. Implement swipe state machine and server challenge.
2. Implement browser geolocation sampling and all non-success statuses.
3. Implement server Haversine/risk and required note.
4. Connect attendance to assignment/workspace and check-out preflight.
5. Implement late grace, missing checkout, correction, leave, overtime, and no-self-approval.
6. Implement retention cleanup and privacy text.

Acceptance: all GPS/attendance/overtime boundaries pass; raw coordinate absent from logs/export; denied GPS remains operable but review-gated.
Rollback: maintenance mode prevents new attendance while preserving existing facts; do not delete events.

### Phase 8 - Payroll dan Excel

Target files: feature `payroll`, payroll API/RPC, XLSX generator, storage adapter, tests.

Tasks:

1. Implement policy/employee compensation owner UI with effective dates.
2. Implement evidence aggregation, blockers, adjustments, review, finalize, paid/void.
3. Implement seven-sheet XLSX and checksum metadata.
4. Implement staff own recap.
5. Ensure rates are entered via owner UI and never fixtures/source.

Acceptance: payroll scenarios in 13.2 pass; XLSX totals equal database snapshot; finalized run immutable; investor denied.
Rollback: keep run DRAFT/REVIEWED; never finalize uncertain output. Finalized correction uses VOID/replacement.

### Phase 9 - Onboarding dan Admin Completion

Target files: features `onboarding`, user/items/settings/audit management; tests.

Tasks:

1. Implement staff-only isolated tutorial and replay.
2. Complete user lifecycle/temp PIN/reset scope.
3. Complete item/settings/audit screens.
4. Add owner GPS setup flow that captures proposed outlet coordinate and requires explicit confirmation.

Acceptance: tutorial creates no domain rows, version persists, admin scope tests pass, no secret/rate/GPS leak.
Rollback: tutorial/admin routes can be hidden independently without affecting domain facts.

### Phase 10 - Hardening dan Full Verification

Target files: headers/deployment config, all tests, documentation.

Tasks:

1. Apply security headers/CSP/permissions policy and dependency fixes.
2. Run complete lint/unit/build/DB/E2E/diff gate.
3. Test mobile real browser for camera-independent GPS permission, denied path, and reconnect.
4. Run accessibility checks and keyboard walkthrough.
5. Review every API action against RBAC matrix.

Acceptance: zero failing/skipped critical test, no high/critical dependency finding without documented mitigation, all P0 rules server-enforced.
Rollback: no production deploy; fix findings.

### Phase 11 - Staging dan Pilot

Target: separate Vercel Preview/Staging and separate Supabase project.

Tasks:

1. Apply migrations to staging and provision test roles with non-production data.
2. Configure outlet coordinates/rates/policies through UI.
3. Run complete smoke and concurrency tests against deployed functions.
4. Pilot satu full business day: SIANG opening/handover, MALAM opening/closing/report, attendance, review, bonus, payroll preview/XLSX.
5. Reconcile stock, finance formulas, attendance, and export manually.

Acceptance: zero unresolved data discrepancy and owner sign-off recorded.
Rollback: reset staging only; production untouched.

### Phase 12 - Production Cutover

Tasks:

1. Announce maintenance window; take fresh backup and row counts.
2. Apply verified migrations in order; verify migration checksums.
3. Preserve profiles/credentials, map exact roles, provision missing personal accounts with temp PIN.
4. Configure server env, outlet/settings/coordinates/compensation through secure paths.
5. Deploy API/frontend, enable maintenance smoke, then enable production mode.
6. Run owner, supervisor, operator, and investor smoke without creating fake permanent finance data.
7. Confirm no client direct Supabase write, no local demo data, and no secret in bundle/log.

Acceptance: health/readiness, auth, role routes, one controlled attendance/assignment lifecycle, report projection, audit, and backup all verified.
Rollback: return system to maintenance, roll back Vercel deployment, preserve additive schema/facts, revoke new sessions if cookie/auth regression. Never drop production rows.

### Phase 13 - Post-Deploy

1. Monitor error/rate-limit/exception metrics intensively for 24 hours.
2. Reconcile first real SIANG/MALAM report and first XLSX manually.
3. Verify GPS retention schedule and session/challenge cleanup.
4. Conduct backup restore drill to isolated environment.
5. Finish `EXECUTION_REPORT.md` and update `ACTION_LOG.md` with residual risks/uncommitted work.

Acceptance: first-day reconciliation signed by owner; no silent queue, permission, or payroll discrepancy.

## 15. Environment dan Runtime Configuration

| Variable/config | Scope | Wajib | Catatan |
|---|---|---:|---|
| `SUPABASE_URL` | Server | Ya | Project sesuai environment |
| `SUPABASE_SERVICE_ROLE_KEY` | Server secret | Ya | Tidak boleh `VITE_`, browser, log, atau repo |
| `APP_ALLOWED_ORIGIN` | Server | Ya | Exact production/preview origin, bukan wildcard |
| `SESSION_HASH_PEPPER` | Server secret | Ya | Untuk keyed hash metadata; rotate melalui runbook |
| `CRON_SECRET` | Server secret | Jika cron | Lindungi cleanup endpoint |
| `VERCEL_ENV` | Server | Otomatis | Cookie/behavior production |
| `VITE_APP_ENV` | Public | Ya | Label environment saja |

- Production dan Preview/Development wajib memakai project Supabase berbeda.
- API browser selalu same-origin `/api`; jangan menambahkan public override yang dapat mengarah ke origin lain.
- Jangan memakai data pegawai production di staging.
- Outlet latitude/longitude, radius, accuracy, shift, allowance, dan compensation disimpan di database melalui owner UI, bukan environment/source.
- Jika koordinat outlet belum dikonfirmasi, attendance production tetap dalam maintenance/read-only; jangan memakai koordinat tebakan.
- Tambahkan `.env.example` hanya dengan nama variable dan placeholder aman.

## 16. Bootstrap, Seed, dan Data Cutover

1. Seed satu outlet dengan timezone `Asia/Jakarta`, tanpa koordinat palsu.
2. Seed shift SIANG/MALAM/FULL dan Tuesday default-off policy.
3. Migrasikan existing `items` ke outlet seed; pertahankan ID/unit/threshold, lalu owner review.
4. Pertahankan existing profile/credential/session sampai auth cutover; kemudian revoke session lama saat cookie format baru aktif.
5. Jangan seed nama staff, PIN, compensation, attendance, finance, report, atau GPS.
6. Owner membuat/mengoreksi akun dan rate melalui UI/provisioner aman. Supervisor harus role `SUPERVISOR`, bukan `OWNER`; investor harus `INVESTOR`.
7. Akun baru mendapat temp PIN dan `force_pin_change=true`.
8. Owner mengatur koordinat outlet saat berada di lokasi, memeriksa peta/jarak, lalu confirm.
9. Jangan import `localStorage` demo. Setelah bootstrap server sukses, hapus key demo dari browser.
10. Jangan melakukan dual-write server+legacy/localStorage.

Pre-cutover reconciliation record wajib memuat migration versions, row counts, active user count per role, active item count per area, settings version, dan backup identifier tanpa menyalin data sensitif.

## 17. Observability dan Operations Runbook

### 17.1 Health dan Metrics

- `/api/health`: liveness process tanpa query data.
- `/api/readiness`: authenticated/secret-protected dependency check sederhana ke database.
- Structured log: timestamp, request_id, action, status code, duration, environment, error code, actor ID pseudonymous, outlet ID.
- Jangan log body penuh, PIN, cookie, token, hash credential, raw IP, user-agent penuh, note HR, atau coordinate.
- Metrics minimum: auth failures/lockouts, API 4xx/5xx, latency p95, primary conflicts, version conflicts, unsynced queue count, GPS status/risk, missing checkout, unresolved exceptions, report blockers, payroll blockers, cron cleanup result.

### 17.2 Dashboard Operasional

Owner/supervisor harus melihat:

- Cycle belum memiliki primary.
- User roster belum check-in.
- GPS/attendance perlu review.
- Missing checkout.
- Queue conflict yang dilaporkan client.
- Area belum handover/closing.
- Daily report belum submitted/reviewed.
- Payroll blockers dan export terakhir.

### 17.3 Scheduled Maintenance

- Revoke/delete expired sessions sesuai retention.
- Delete used/expired challenges setelah audit minimum tercatat.
- Delete raw GPS samples setelah `retained_until`; jangan menghapus derived evidence.
- Expire pending swap yang melewati TTL.
- Mark missing checkout derived exception setelah batas operasional.
- Verify backup schedule dan lakukan restore drill berkala ke environment isolasi.

### 17.4 Incident Modes

- `PRODUCTION`: semua feature aktif.
- `PILOT`: hanya akun/outlet yang diizinkan; banner terlihat.
- `MAINTENANCE`: login management/read-only tetap ada, mutating operation ditolak dengan pesan jelas.

Incident runbook minimum: revoke sessions, rotate service secret, disable mutation, inspect request IDs, preserve audit, restore deployment, verify database integrity, communicate affected window, dan document corrective action. Jangan memperbaiki fakta dengan direct SQL tanpa correction/audit procedure.

## 18. Definition of Done

Release hanya selesai jika seluruh poin berikut benar:

### Data dan Domain

- [ ] Tidak ada read/write operational production melalui `localStorage`.
- [ ] Browser tidak melakukan direct Supabase operational write.
- [ ] Legacy tables revoked/deprecated dan terbukti tidak mengandung data yang terabaikan.
- [ ] Semua critical command transactional, idempotent, versioned, dan audited.
- [ ] Primary race dijaga database dan teruji concurrent.
- [ ] Helper/cross-area/state restrictions dijaga server/RPC.
- [ ] SIANG handover dan MALAM/FULL closing/reference chain dapat direkonsiliasi.
- [ ] Submitted report, attendance fact, final bonus, dan finalized payroll immutable.

### Auth dan Security

- [ ] Login picker hanya nama lengkap.
- [ ] Temp/change/reset PIN, weak/history validation, atomic lockout, dan session revocation berfungsi.
- [ ] Multi-device berfungsi tanpa shared token.
- [ ] Origin/CSRF, body validation, security headers, no-store, dan secure cookie aktif.
- [ ] Direct DB privileges, investor projection, no-self-approval, dan role matrix lulus negative tests.
- [ ] Bundle/log/audit/export tidak mengandung secret, PIN, raw token, atau raw coordinates.

### Operations dan UX

- [ ] Roster, swap, gap fill, self-selection, deviation, primary/helper, reset, dan restore login bekerja.
- [ ] Check-in/check-out mengikuti swipe -> challenge -> completed GPS attempt -> server fact.
- [ ] Grace 15 menit dan missing checkout sesuai keputusan.
- [ ] Emergency checkout online menghasilkan review/pending tasks tanpa memberi kewenangan helper untuk menyelesaikan cycle.
- [ ] GPS verified/unverified/risk/review berjalan dan UI tidak menjanjikan anti-spoof mutlak.
- [ ] Offline stock queue tahan retry, conflict terlihat, dan finalization terkunci sampai sync.
- [ ] Semua role mempunyai loading/empty/error/offline/forbidden state yang jelas.
- [ ] Mobile 360px, desktop, keyboard, screen reader basics, focus, dan reduced motion lulus.
- [ ] Staff onboarding versioned dan tidak menulis data production.

### Finance, Bonus, dan Payroll

- [ ] Finance totals hanya dihitung server dan snapshot revision dapat direkonsiliasi.
- [ ] Investor hanya melihat submitted/approved projection dan label review yang benar.
- [ ] Bonus tier boundary, equal participant allocation, dan remainder tepat.
- [ ] Payroll mempertahankan base untuk 24 fulfilled scheduled days dengan mix 6/12.
- [ ] Schedule delta, leave allowance, alpha, overtime rounding, dan no-double-count teruji.
- [ ] Semua deduction/adjustment terlihat sebagai evidence dan membutuhkan review yang tepat.
- [ ] XLSX tujuh sheet reconcile, aman dari formula injection, memiliki run ID/checksum, dan tidak memuat raw GPS.
- [ ] Hanya owner dapat finalize payroll; finalized run immutable.

### Release dan Operasi

- [ ] Full test gate lulus tanpa skip critical case.
- [ ] Staging terpisah dan one-business-day pilot telah direkonsiliasi.
- [ ] Backup sebelum cutover dan restore drill tersedia.
- [ ] Health/readiness/log/metrics/exception dashboard/maintenance mode berfungsi.
- [ ] First production day stock, report, attendance, bonus, dan export direkonsiliasi.
- [ ] `README.md`, `UX-CONTRACT.md`, dan `ACTION_LOG.md` sesuai implementation final.
- [ ] `EXECUTION_REPORT.md` selesai dan residual risk dinyatakan jujur.

## 19. Explicitly Deferred

- Native mobile app dan Play Integrity/App Attest.
- Rotating outlet QR, NFC, Wi-Fi/Bluetooth presence proof.
- Continuous/background GPS dan selfie/photo attendance.
- Attachment surat sakit/izin; release ini memakai reason dan review saja.
- WhatsApp Business API/automatic delivery; release ini share/clipboard manual.
- PDF payroll; XLSX adalah output wajib.
- Automatic legal penalty, contract rewrite, termination calculation, atau ganti rugi 50-100%.
- Penghapusan schema legacy; dilakukan pada release terpisah setelah retention dan sign-off.

## 20. Final Executor Checklist

Eksekutor wajib mengikuti urutan ini dan mencentang di `EXECUTION_REPORT.md`:

- [ ] Membaca seluruh `PRODUCTION_PLAN.md` dan existing project instructions.
- [ ] Memeriksa git status/diff/log tanpa mengubah work milik pihak lain.
- [ ] Memperbarui `ACTION_LOG.md` dan mencatat baseline.
- [ ] Memastikan backup, migration state, legacy row counts, dan role preflight.
- [ ] Membuat test harness lebih dahulu.
- [ ] Mengimplementasikan dan mengetes migration `0004-0008` fresh serta upgrade path.
- [ ] Mengimplementasikan auth hardening dan self-contained business API.
- [ ] Membuktikan Vercel Preview canary tidak mengalami function import crash.
- [ ] Memotong frontend dari localStorage ke server tanpa dual-write/fallback.
- [ ] Menyelesaikan roster/assignment/stock/offline.
- [ ] Menyelesaikan report/investor/bonus.
- [ ] Menyelesaikan attendance/GPS/HR exceptions.
- [ ] Menyelesaikan payroll/XLSX.
- [ ] Menyelesaikan onboarding/admin/security/a11y.
- [ ] Menjalankan semua test gate dan menyimpan ringkasan output.
- [ ] Menjalankan staging pilot satu full business day dan reconciliation.
- [ ] Meminta/mengecek otorisasi sebelum production migration/deploy.
- [ ] Menjalankan backup, production cutover, smoke, dan first-day monitoring.
- [ ] Memperbarui README/UX contract/action log sesuai kenyataan.
- [ ] Menulis `EXECUTION_REPORT.md` dan melaporkan semua file yang belum committed.

## 21. Required `EXECUTION_REPORT.md`

Laporan akhir minimal berisi:

1. Waktu mulai/selesai, branch, base HEAD, final HEAD, dan status worktree.
2. Ringkasan perubahan per phase dan daftar file.
3. Migration local/staging/production yang applied beserta checksum/status, tanpa secret.
4. Legacy preflight row counts dan keputusan migrasi.
5. Commands test yang dijalankan, exit status, jumlah test pass/fail/skip.
6. Vercel/Supabase environment yang dipakai dan URL smoke, tanpa credential.
7. Smoke matrix per role dan hasil deny checks.
8. Reconciliation stock, finance, bonus, attendance, payroll, dan XLSX.
9. Backup identifier serta hasil restore drill.
10. Security/privacy checks, dependency findings, dan mitigasi.
11. Known residual risks. Wajib tetap menyebut bahwa GPS web dapat dispoof.
12. Runtime configuration yang masih harus diisi owner, khususnya outlet coordinate dan employee compensation.
13. Rollback procedure yang telah diuji atau diverifikasi.
14. Uncommitted/untracked files dan alasan.
15. Pernyataan eksplisit apakah seluruh Definition of Done terpenuhi; jika tidak, release tidak boleh disebut production-ready.
