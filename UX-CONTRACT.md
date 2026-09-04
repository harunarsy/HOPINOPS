# HOPIN Stock Operations — UX Contract (Produksi Server-First)

Kontrak ini mencerminkan implementasi saat ini di branch `remediation/part2`: SPA React/Vite yang seluruh alurnya bersumber dari API server (`/api/*` + Supabase RPC), bukan demo localStorage. Kebenaran operasional selalu milik server; browser hanya menyimpan draft offline eksplisit.

## 1. Batas kepercayaan

- Browser tidak memegang kredensial database dan tidak menulis langsung ke tabel Supabase.
- Semua mutasi lewat transactional RPC: server melakukan re-authorization aktor, lock aggregate, validasi state, mutasi, dan audit dalam satu transaksi.
- Timestamp otoritatif, versi aggregate (`expected_version`), dan idempotency (`idempotency_key`) berasal dari server.
- `localStorage`/IndexedDB adalah convenience recovery, bukan security boundary.

## 2. Status aplikasi tingkat atas

`BOOTING | UNAUTHENTICATED | PIN_CHANGE_REQUIRED | ONBOARDING_REQUIRED | READY | SESSION_EXPIRED | SERVICE_UNAVAILABLE`

- Bootstrap gagal **fail-closed**: aplikasi menampilkan layar pemulihan eksplisit (`Sesi berakhir` / `Layanan belum tersedia`) dengan aksi retry — tidak pernah tampil sebagai "tidak ada assignment" atau "tidak ada onboarding", dan tidak pernah fallback ke data kosong yang terlihat valid.

## 3. Alur utama (server-first)

| Operasi | Trigger | Pending | Sukses | Pemulihan |
| --- | --- | --- | --- | --- |
| Login | Pilih user + PIN 6 digit, auto-submit ke-6 digit | Request tunggal, guard dobel-submit | Bootstrap penuh dari server | Error inline tetap, form terpakai; 401 generik mengosongkan PIN |
| Lockout PIN | 3 gagal → 60 detik (server) | Countdown dari server `Retry-After`/`blocked_until` | Reset counter hanya oleh server saat sukses | Refresh tidak menghapus lock; tidak ada counter klien |
| Assignment | Konfirmasi shift/area | `rpc_claim_assignment` | Terkunci untuk tanggal; satu assignment per user/tanggal | Konflik versi → muat ulang state server |
| Attendance | Check-in/check-out dengan GPS + device cookie | Challenge sekali pakai | Event tersimpan server-side, evidence geofence turunan | Tanpa device proof → wajib re-login |
| Opening | Attestation jumlah fisik per item | `rpc_confirm_opening` | Snapshot opening terkunci, sumber patokan tercatat | Error inline per baris; retry aman (idempotency) |
| Movement | Modal setelah opening dikonfirmasi | RPC ledger append-only | Baris ledger + stok berubah | Koreksi hanya lewat movement koreksi, bukan edit/hapus |
| Closing | Hitungan akhir shift MALAM/FULL | `rpc_confirm_closing` | Closing terkunci + laporan | Sama seperti opening; SIANG tidak closing |
| Laporan | Submit di review gate | Validasi server | `Terkirim ke supervisor` + timestamp server | Draft server-backed; revisi append-only |

## 4. Attestation jumlah fisik (opening & closing)

Jumlah sistem yang ditampilkan **tidak pernah** otomatis menjadi hitungan fisik. Setiap item punya tiga aksi eksplisit:

- `Sesuai` — fisik sama dengan patokan server.
- `0` — fisik nol, tanpa perlu mengetik ulang.
- `Ubah jumlah` — input angka custom.

Attestation massal: `Saya Sudah Menghitung: Tandai Semua Sesuai` dengan dialog konfirmasi sebelum dieksekusi. Kosong tetap berstatus `UNCOUNTED` sampai ada aksi eksplisit.

Patokan server selalu ditampilkan sumbernya (`Closing sebelumnya`, `Handover Siang hari ini`, fallback dengan peringatan, atau `belum tersedia; perlu inisialisasi Manager`). Missing reference **tidak pernah** ditampilkan sebagai `0`.

## 5. Variance: kategori wajib, catatan opsional

- Selisih (`fisik ≠ patokan`) wajib punya kategori alasan: `INITIAL_STOCK_COUNT` (khusus sumber inisialisasi), `COUNTING_ERROR`, `SPILLAGE_UNRECORDED`, `WASTE_UNRECORDED`, `OVER_PORTIONING`, `OTHER`.
- Catatan tambahan bersifat opsional (`Catatan tambahan (opsional)`) untuk semua kategori, termasuk `OTHER`.
- Sistem tidak pernah mengisi catatan otomatis atau membuat catatan atas nama operator.
- Tanpa selisih: kategori dan catatan tidak wajib. Database tetap menolak selisih tanpa kategori.

## 6. Error dan feedback

- Error inline persisten sampai kondisinya teratasi; konflik tidak boleh hanya lewat toast.
- Semua dialog (`role="dialog"`, `aria-modal`) untuk: movement, inisialisasi stok, bulk attest, resolusi konflik, koreksi movement — tanpa native `alert`/`confirm`/`prompt`.
- Status teks + bentuk (bukan warna saja), `aria-live` untuk feedback singkat.
- Submit terkunci setelah state `SUBMITTED` server; laporan append-only.

## 7. Offline queue (IndexedDB)

Antrian mutasi (`hopin-ops-idb-v2`) hanya untuk draft eksplisit, dipartisi per **profile / outlet / aggregate (cycle)**:

- State item: `PENDING | SENDING | CONFLICT | SYNCED | FAILED`.
- Setiap item membawa `idempotencyKey` dan `baseVersion`; pengiriman meng-hormati lease 5 menit dan backoff `nextAttemptAt`.
- **Resolusi konflik**: versi aggregate tidak cocok → item masuk `CONFLICT`, dialog eksplisit memilih muat ulang server state atau buang draft; tidak ada auto-heal atau overwrite diam-diam.
- Ringkasan antrian (pending/sending/conflict/failed) terlihat di workspace; item `SYNCED` dibersihkan.

## 8. Portal investor (read-only)

- Investor hanya melihat laporan dan detail laporan.
- Tidak ada akses ke nama staf, attendance, GPS, roster draft, payroll, PIN, atau status session/device — di UI maupun di API (server menolak, bukan hanya menyembunyikan menu).
- Label eksplisit `PORTAL INVESTOR (READ-ONLY)`.

## 9. Aksesibilitas & responsif

Semua aksi tombol native, semua field berlabel, input numerik dengan `inputmode` yang tepat, `focus-visible` global, reduced motion dihormati. Layout 320–430px satu kolom dengan sticky submit bar; tidak ada overflow horizontal; tabel besar memakai kartu responsif.

## 10. Batasan yang masih terbuka

- Fase 6–7 (AppShell navigasi penuh operator/manager + onboarding interaktif 8 langkah) belum selesai; navigasi saat ini masih sederhana.
- Sebagian inventory API fase 5 masih bertambah; kontrak di atas hanya menjamin action yang sudah ada.
- Klaim production-ready menunggu Final Release Gate di `REMEDIATION_IMPLEMENTATION_PLAN_PART_2.md`.
