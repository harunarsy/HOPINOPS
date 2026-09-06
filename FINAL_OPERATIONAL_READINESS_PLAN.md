# HOPIN Final Operational Readiness Contract

Tanggal: 6 September 2026
Status: PLAN EKSEKUSI TERPADU AKTIF; BELUM PRODUCTION-READY. Tahap B membaik, blocker operasional dan verifikasi integrasi masih terbuka.
Pemilik keputusan: Harun.
Scope: aplikasi aktif di `webapp`, bukan demo `webapp-fallback` atau prototipe `output`.

## 0. Finalisasi Terpadu Pasca Commit f05e7d2

Bagian ini adalah urutan eksekusi terbaru untuk seluruh temuan pengguna 6 September 2026. Bagian berikut mempertahankan kontrak bisnis dan acceptance criteria; evidence lama bukan status runtime terbaru. CONSOLIDATION_PLAN.md adalah lampiran prosedur, bukan antrean kerja terpisah. Tidak ada perubahan role tersembunyi atau migration/deploy production otomatis sebagai akibat penulisan plan ini.

### Default Eksekusi Pilihan Koordinator

Harun menyerahkan tiga pilihan teknis/UX kepada koordinator pada 6 September 2026. Keputusan berikut menutup pertanyaan tersebut, bukan izin otomatis rollout atau penghapusan project.

1. **Copy B05:** tombol masuk 'Check-out darurat'. Dialog: 'Perlu pulang sebelum tugas selesai?' Penjelasan: 'Gunakan jika Anda harus pulang tetapi tugas shift belum selesai. Waktu pulang akan dicatat dan Supervisor akan meninjau alasannya. Catatan stok dan tugas yang tertunda tetap perlu diselesaikan.' Label 'Alasan check-out darurat', tombol utama 'Catat check-out darurat', sekunder 'Kembali'. Receipt setelah server sukses: 'Check-out tercatat. Menunggu peninjauan Supervisor.' Sesuaikan reviewer menjadi Owner/manajemen bila role target memerlukannya. Jangan menyebutnya logout atau memberi kesan tugas otomatis selesai.
2. **Urutan upgrade E5:** stabilkan E1-E4 lebih dahulu, baru upgrade major secara berurutan pada checkpoint terpisah. Audit advisory boleh lebih awal; patch keamanan mendesak diprioritaskan lewat perubahan terisolasi. Jangan mengubah toolchain bersamaan dengan perbaikan bisnis. Vite/plugin-react satu kelompok kompatibilitas; Vitest/coverage satu kelompok; TypeScript kelompok terpisah. Versi target diverifikasi ulang dari registry/release notes, tidak dipaksakan berdasarkan angka snapshot lama. Tiap kelompok harus lolos gates sebelum kelompok berikutnya.
3. **Pilot E7:** rehearsal end-to-end pada staging disposable dahulu, lalu pilot terawasi pada satu outlet selama satu hari operasional yang mencakup Siang -> handover -> Malam -> closing -> laporan stok/keuangan gabungan dan check-out. Cakup BAR/KITCHEN dan role yang relevan; Supervisor mendampingi dan tersedia prosedur pencatatan cadangan jika ada blocker. Kegagalan integritas, transaksi ganda/hilang atau alur buntu menghentikan ekspansi pilot. Edge cases destruktif/error injection hanya staging, bukan data operasional nyata. Payroll periodik dan seluruh fitur lain tetap diuji terpisah; satu hari pilot tidak membuktikan payroll bulanan. Pilot produksi tetap setelah gate dan izin rollout eksplisit.

Koreksi wajib ringkasan pelaksana E0-E7:

- E1 tidak membatasi katalog/reorder hanya pada Supervisor/Owner. PRIMARY juga berwenang sesuai B07 dalam area tugasnya, dengan audit/snapshot/versioning. First baseline hanya dalam kondisi B06.
- E3 wajib mempertahankan backlog payroll: stale-period guard, evidence/snapshot reconciliation, tanggal akhir bulan valid, export idempotent dan recovery upload/receipt. Judul 'payroll' saja bukan acceptance criteria.
- E2 membedakan item antrean yang sukses terkirim (hapus setelah receipt) dan discard konflik oleh pengguna (konfirmasi eksplisit setelah data terbaru berhasil dimuat). Discard bukan receipt sukses dan tidak boleh dilaporkan sebagai transaksi tersimpan.
- E6 Root Directory Vercel adalah `.` (satu titik) bila package.json tetap di root Git; bukan `..`. Memindahkan folder lokal tidak mengubah root relatif repository.

### Evidence Baseline Audit

- HEAD f05e7d2, implementasi 3ed63dc; worktree bersih sebelum audit ini. Commit benar-benar ada, bukan lagi perubahan Part 3 seluruhnya uncommitted.
- pnpm lint LULUS; tsconfig include src/api/tests/playwright.config.ts. pnpm test 36/36 dalam 11 file LULUS; pnpm build LULUS. Bundle JS 400.82 kB, gzip 110.43 kB. Ini bukan bukti semua journey browser.
- Query ledger read-only dengan project-ref eksplisit mengonfirmasi 0019, 0018, 0017 tercatat pada staging ibzlxdmnuszcmdzuocwu DAN production naanarmoktmsumkxmjvj. Ledger bukan pembuktian perilaku fungsi atau provenance penerapan.
- Vercel hopinops-qdy8hwzhb dan webapp-8xdemd8r7 sama-sama Ready, production, dibuat 6 September 10:57:52 WIB, keduanya mempunyai alias git-main dan lima serverless entrypoints termasuk cleanup. Dua deployment bukan dua commit; mapping Git integration dan metadata SHA harus diperiksa sebelum menyimpulkan trigger yang sama secara definitif.
- pnpm audit --prod: no known vulnerabilities found pada registry saat audit. Bukan jaminan bebas kerentanan atau audit dev dependencies.
- pnpm outdated: Supabase 2.114.0 -> 2.115.0; Playwright 1.62.1 -> 1.63.0; happy-dom 20.13.0 -> 20.14.0; @types/react-dom 19.2.6 -> 19.2.7; plugin-react 5.2.0 -> 6.1.1; Vite 6.4.3 -> 8.2.2; Vitest/coverage 4.1.11 -> 5.0.0; TypeScript 5.8.3 -> 7.0.2. Versi adalah snapshot registry, wajib cek ulang saat upgrade.
- Smoke health production 200, satu sampel TTFB 0.98 s. Tidak cukup untuk atribusi latency. Vercel inspect menunjukkan functions iad1; lokasi Supabase aktual, RTT server-ke-DB, cold/warm dan p95 perlu diukur.
- Tidak menjalankan pgTAP/concurrency mutation suite pada audit ini. Klaim 21 pgTAP dan concurrency lulus masih evidence laporan pelaksana, belum rerun independen. Tidak mengklaim screenshot/browser visual telah diperiksa.

### Penilaian Tahap B yang Akurat

Lifetime completion, mandatory steps, error logout, PIN transient masking, navigation back, timeout/non-JSON sudah nyata di source. Jangan mengulang klaim lama bahwa semuanya belum dibuat. Namun:

1. Lock RPC aktual profiles -> outlet_settings -> onboarding_progress, bukan urutan yang tertulis pada laporan pelaksana. Otorisasi dilakukan sebelum lock tanpa revalidasi status; uji interleaving perubahan role/active/scope sebelum mengklaim race aman.
2. Script concurrency menerima sembarang SUPABASE_URL/service key, membuat fixture dan tidak membersihkan di finally dengan verifikasi error. Pasang allowlist staging, opt-in mutation, serta cleanup terverifikasi sebelum menjalankannya lagi.
3. Dua Supabase client dengan Promise.all membuktikan request paralel, bukan transaksi DB pasti overlap. Tambahkan barrier/lock terkontrol dua koneksi, periksa row/audit sesudah seluruh replay.
4. Tes logout tanpa cookie atau dengan cookie jar yang sudah dibersihkan tidak membuktikan token lama revoked. Simpan token disposable pra-logout di memori, replay sesudah logout dan wajib 401; jangan cetak token.
5. Browser sampai workspace, initialization nyata, dan rekonsiliasi response-loss tetap harus dibuktikan. Tidak boleh menutup berdasarkan 36 mock/unit tests saja.

### Blocker Operasi dan Rancangan Alur

| ID | Bukti source terkini | Target penutupan |
|---|---|---|
| U01 | App.tsx:255-278 menargetkan attendance sendiri; api/app.ts:1139-1154 manager-only; RPC 0017:159-167 menolak self | Pisahkan bantuan staf dari tindakan manager; hilangkan CTA yang pasti ditolak. Kebijakan self-emergency membutuhkan keputusan eksplisit. |
| U02 | StockWorkspace.tsx:1169-1179 operator diblokir baseline; App.tsx kini sudah mengirim canManage | Supervisor menyiapkan cycle operator langsung dari dashboard tanpa harus mengambil assignment/check-in sendiri. Operator memasukkan stok fisik setelah baseline ada. Hak operator menetapkan baseline menunggu keputusan. |
| U03 | ManagementView.tsx tidak punya katalog; api/app.ts items.create/update/archive masih Owner-only | UI katalog + RPC Supervisor/Owner + snapshot cycle + baseline item baru satu paket sesuai B01/B02, bukan sekadar tambah menu. |
| U04 | StockWorkspace.tsx:792-803 menghapus konflik setelah loadBootstrap menelan error | Refresh gagal tidak pernah menghapus antrean. Refresh tidak membongkar layar/draft. |
| U05 | StockWorkspace.tsx:946-955 langsung ke Reports; ReportsView belum menyajikan stock_lines sebagai ringkasan gabungan | Closing tersimpan -> ringkasan area dan kesiapan BAR/KITCHEN -> finance bagi finalizer -> pratinjau gabungan -> kirim untuk review -> bukti pengiriman. |
| U06 | Onboarding replayHelp reset state tanpa konfirmasi; selected opening button style sama | Bantuan tidak mengulang latihan; aksi ulang dipisah ke menu sekunder dan konfirmasi. Pilihan aktif memakai background/border/centang dan aria state, bukan warna saja. |
| U07 | App.tsx:68-79,457-466 global BOOTING; ReportsView:190-205 meminta current user lagi | Initial-load terpisah dari refresh; panel lokal/skeleton stabil; tidak menampilkan pesan teknis micro-loading dan tidak mengorbankan server validation. |
| U08 | DESIGN.md:97-102 menyatakan local-only demo dan melarang security/attendance production | Selaraskan product/design truth terhadap kontrak server-first sebelum AI memakai instruksi desain; pertahankan identitas visual forest/paper, bukan rewrite brand. |

Kebutuhan pengguna terbaru: laporan harian adalah satu laporan stok + keuangan setelah closing. Tidak mengubah rumus pendapatan atau kewenangan finalizer diam-diam. SIANG tetap handover jika kontrak awal demikian; UI Kitchen menunjukkan ringkasan areanya dan siapa yang menyelesaikan laporan harian, bukan menawarkan submit yang tidak berhak.

### Bahasa dan Tata Letak yang Akan Diterapkan

Skill Impeccable audit dimuat. Skill humanize tidak tersedia dalam daftar tool sesi; jangan mengklaim menjalankannya. Terapkan prinsip bahasa awam melalui review copy Indonesia, lalu uji pemahaman tugas dengan pengguna.

| Saat ini/konteks | Usulan copy dan perilaku |
|---|---|
| Otomatis terselubung | Hapus; perilaku masking cukup terlihat tanpa jargon. |
| Latihan sinkronisasi lokal | Judul: Saat internet terputus. Penjelasan: Catatan yang mendukung penyimpanan offline menunggu dikirim. Jangan masukkan ulang. |
| Simulasikan offline | Coba tanpa internet |
| Sambungkan kembali | Sambungkan internet |
| Tinjau & selesaikan | Periksa catatan yang perlu diperbaiki |
| Konflik diselesaikan | Catatan sudah diperiksa. Anda bisa melanjutkan. Dalam latihan, jangan mengklaim catatan nyata tersimpan. |
| Emergency checkout | Catat pulang dengan pengecualian, khusus tindakan yang benar-benar diizinkan; sebut nama petugas, tugas tertunda dan peninjauan. |
| Staf butuh bantuan | Butuh bantuan untuk pulang? Hubungi Supervisor jika penutupan atau pengiriman catatan belum selesai. Jangan membuat tombol Ajukan seolah ada RPC permintaan jika belum diimplementasikan. |
| Patokan belum tersedia | Patokan stok awal belum disiapkan. Supervisor dapat menyiapkannya dari dashboard. Setelah itu, hitung stok fisik di area Anda. |
| Tombol kirim nonaktif: laporan server dimuat | Skeleton ringkasan saat initial load; tombol Kirim laporan dengan pending state lokal bila relevan. Error permanen tampil dengan tindakan pemulihan, bukan disembunyikan. |

Konsep surface: Operate, satu aksi primer per tahap, header identitas area/shift + menu akun/bantuan; tindakan darurat/ulang tidak berdampingan dengan CTA rutin. Selected control mempunyai tint background, border jelas, check dan accessible state. Bedakan hover, focus dan selected. Mobile satu kolom; action bar tidak menutupi input/keyboard; touch target 44 px; tabel scroll lokal; dialog focus management lengkap.

Skeleton hanya untuk konten yang belum tersedia, dimensinya stabil, tidak membuat spinner/skeleton setiap background refresh. Pertahankan data lama dengan status pembaruan yang jujur. Tidak menampilkan sukses sebelum receipt server; loading palsu, delay minimum buatan, dan optimistic financial success dilarang.

### Urutan Eksekusi Terpadu (Menggantikan Antrean Tahap Lama)

1. **E0 - Bekukan evidence dan kontrak.** Verifikasi HEAD/deploy SHA, migration/function parity, perbaiki status docs dan draft product/design truth. Tutup keputusan operator baseline/self-emergency sebelum menambah privilege. Pasang pagar script DB terlebih dahulu. Gate: target test aman dan matriks requirement/test tersedia.
2. **E1 - Buka jalur operasi pertama.** Supervisor dashboard dapat menyiapkan katalog/baseline cycle tanpa mengambil peran staf. Operator menghitung opening -> konfirmasi -> movement. Implementasi katalog dan snapshot harus memenuhi B01/B02 termasuk tambah/archive setelah closing. Jangan isi baseline otomatis nol hanya untuk lolos. Gate fresh outlet dan cycle lanjutan lulus, histori tetap utuh.
3. **E2 - Amankan refresh dan transaksi.** Perbaiki U04, draft parsial/restore stale, dirty state/queue logout, timeout reconciliation/idempotency. Pisahkan initial load/local refresh dan kurangi waterfall query independen. Gate offline/reconnect/5xx/response lost tidak kehilangan data dan tidak menggandakan transaksi.
4. **E3 - Finalisasi laporan dan kehadiran.** Terapkan U01/U05 sesuai keputusan; closing -> summary -> finance -> combined report -> review/share, prasyarat area terlihat. Selesaikan emergency/correction/no-self-review/recovery lintas hari dan payroll/export blockers pada bagian 4/6 dokumen ini. Gate satu hari operasional semua role terbukti sampai selesai.
5. **E4 - Copy, layout dan performa.** Audit seluruh visible strings/status/error/CTA, bukan hanya contoh pengguna. Perbaiki onboarding step7/replay/selected state, header/dialog/mobile dan U08. Ukur first-load, refresh dan mutation p50/p95, request count, browser metrics pada perangkat/jaringan terdokumentasi. Query plan/index hanya diperbaiki berdasar profiling, tanpa EXPLAIN ANALYZE mutasi produksi. Nilai opsi region functions lebih dekat DB setelah ukur RTT; pindah region bukan tebakan atau solusi tunggal. Gate keyboard/mobile + responsive dan performance budget bagian E terpenuhi.
6. **E5 - Upgrade kompatibel terbaru.** Cek release notes/engines/peer deps dari registry aktual. Upgrade patch/minor satu batch kecil; lalu Vite/plugin-react, Vitest/coverage dan TypeScript dalam batch kompatibilitas terpisah. Pin Node/packageManager, frozen lockfile, periksa overrides, test backend/Vercel bundling serta Playwright browser version. Target latest stable yang lolos ecosystem gates; jika major terbaru gagal, catat blocker bukan memaksakan atau diam-diam mengabaikan. Jalankan audit prod DAN dev; nol advisory diketahui bukan bukti aplikasi aman. Tidak perlu mengganti React/Supabase/Vercel stack.
7. **E6 - Satu root dan satu project.** Checkpoint seluruh writer, backup repo/hidden/untracked, arsip output/fallback/tmp di luar root setelah inventaris. Naikkan isi webapp beserta .git ke HOPIN tanpa git init/overwrite. Pertahankan relative repo root . pada Vercel. Audit remote Git integration kedua project; hentikan trigger webapp dengan izin setelah domain/env/cron/storage/webhook/traffic dipetakan. hopinops tetap project kanonik. Observasi dan hapus webapp hanya setelah approval ID spesifik. Prosedur rinci CONSOLIDATION_PLAN.md berlaku. Gate satu dev full-stack command dari HOPIN dan satu pipeline deploy HOPIN, histori/data/URL penting tidak hilang.
8. **E7 - Release dan pilot.** Full gates baseline yang sama, barrier concurrency, token revocation, browser journey real API staging, screenshot desktop/mobile, accessibility dan Lighthouse/profile. Restore disposable, rollback artefak, izin rollout eksplisit, authenticated readiness, cron actual execution, dan pilot. Jangan menandai selesai berdasarkan jumlah test atau status Vercel Ready.

Tidak ada folder dipindahkan, dependency dinaikkan, Git integration diputus, atau project dihapus dalam tahap audit/penulisan ini. Jangan menggabungkan perubahan besar upgrade, relocation dan bisnis dalam satu diff tanpa checkpoint terpisah.

### Keputusan Final Pengguna: B05-B07

Disetujui Harun pada 6 September 2026 setelah audit. Bagian ini menggantikan larangan operator baseline dan pertanyaan self-emergency dalam rencana/handoff sebelumnya. Evidence source lama tetap historis; izin baru belum diimplementasikan hanya dengan menulis dokumen.

| ID | Kontrak final |
|---|---|
| B05 | Operator boleh check-out darurat untuk dirinya sendiri, dengan alasan wajib, timestamp server, idempotency, audit dan review manajemen. Tidak perlu menunggu manager untuk mencatat permintaan kepulangan. Attendance ditandai membutuhkan review dan assignment/tugas yang belum selesai tetap PENDING_TASKS. Tidak otomatis menyetujui kehadiran, menyelesaikan stok, atau memfinalisasi payroll. |
| B06 | Operator PRIMARY pada area/cycle yang menjadi tugasnya boleh menyiapkan dan mengonfirmasi stok fisik pertama saat referensi benar-benar belum ada. Supervisor/Owner tetap boleh menyiapkan dari dashboard. First count adalah baseline awal eksplisit, bukan nol fiktif dan bukan variance terhadap histori yang tidak ada. |
| B07 | Operator PRIMARY boleh langsung menambah barang, mengarsip barang, menata urutan checklist dan bagian lokasi penyimpanan pada area tugasnya. Supervisor/Owner dapat mengelola seluruh area outlet. HELPER tetap membantu hitung/draft sesuai izin lama, bukan otomatis mendapat finalisasi/katalog. Semua perubahan bersama disimpan server dan diaudit. |

#### Batas Keamanan dan Histori

- B05 memakai jalur self-service yang menurunkan actor dari sesi server dan memeriksa attendance milik sendiri; jangan menerima target arbitrary atau membuka RPC manager existing ke semua operator. Manager-on-behalf tetap terpisah. Investor tidak memiliki jalur operasional. Reviewer tidak boleh menyetujui tindakan sendiri.
- Emergency tersedia untuk attendance yang masih terbuka, tidak membuat checkout event kedua jika checkout sudah tercatat. Jika hanya assignment completion yang gagal setelah checkout sukses, tampilkan pemulihan completion, bukan emergency lagi. GPS gagal tidak boleh menghasilkan klaim lokasi valid. Receipt menjelaskan kepulangan tercatat, status menunggu review dan tugas tersisa.
- B06 hanya boleh dipakai bila sumber histori sah tidak tersedia. Setelah opening dikonfirmasi, baseline immutable; koreksi melalui command audited, bukan edit referensi agar selisih hilang. Request initialization bersamaan harus menghasilkan satu baseline sah atau konflik yang bisa dipulihkan. Validasi scope, duty, state cycle, decimal scale dan angka finite/nonnegatif server-side.
- B06 secara eksplisit menggantikan aturan zero-reference manager-only pada PRODUCTION_PLAN bagian 191/594 dan rencana Part 2. Migration baru harus mempertahankan snapshot INITIALIZATION lama dan membedakan first physical count baru; jangan menulis ulang histori atau menerapkan data demo ke production.
- B07 mengartikan 'kurangi daftar barang' sebagai archive, bukan delete histori atau pengurangan kuantitas stok. Pemakaian/penambahan jumlah stok tetap melalui movement atau physical count yang sah. Ganti satuan barang berhistori membutuhkan versi/konversi eksplisit, bukan overwrite makna angka.
- B02 tetap berlaku: perubahan item-set pada cycle aktif berlaku cycle berikutnya. Khusus setup perdana tanpa referensi dan sebelum opening immutable, PRIMARY boleh menyiapkan daftar awal sebelum membekukan snapshot opening pertama. Ini pengecualian eksplisit bootstrap pertama, bukan izin mengganti katalog cycle berjalan setelah opening.

#### Checklist Berdasarkan Lokasi Fisik

- Keputusan tambahan Harun: urutan checklist adalah konfigurasi bersama yang authoritative di server, bukan pengaturan lokal per pengguna. Dashboard Supervisor/Owner wajib menampilkan bagian dan urutan yang sama dengan versi checklist staf; jangan melakukan sort nama/default frontend yang menimpa urutan tersimpan.
- Server menyimpan identitas bagian, penempatan item, urutan bagian, urutan item dan versi konfigurasi dalam scope outlet/area. Nilai urutan/nama bagian tidak hardcoded. Mutasi reorder/move berjalan melalui RPC transactional, authorization, expected_version, idempotency dan audit; client tidak mempunyai akses tulis tabel langsung.
- 'Terkunci sistem' berarti integritas/versioning dijaga server, bukan checklist tidak bisa diedit lagi: pengguna berwenang tetap dapat mengatur urutan. Dua editor dengan versi sama tidak boleh saling overwrite; perubahan kedua yang stale harus mendapat konflik dan pilihan memuat versi terbaru tanpa membuang edit diam-diam.
- Dashboard membedakan 'Checklist shift ini' (snapshot cycle yang sedang dikerjakan) dan 'Susunan untuk shift berikutnya' bila ada perubahan pending. Untuk cycle yang sama, staf dan Supervisor harus melihat urutan/snapshot identik. Perubahan konfigurasi terbaru terlihat setelah refresh/refetch terkontrol, tanpa mengacak layar hitung aktif atau me-reset ketikan.
- Struktur: outlet -> area BAR/KITCHEN -> bagian lokasi (misalnya Lemari depan, Rak atas, Laci bawah) -> daftar barang berurutan. Nama bagian dan urutan dapat diatur pengguna, bukan hardcoded ke contoh lemari.
- Setiap barang mempunyai identitas stabil; memindahkan bagian/urutan tidak mengganti item_id, satuan, jumlah atau transaksi. Awalnya satu penempatan per barang per area; multi-location stock bukan fitur tersirat dan jangan menduplikasi jumlah satu barang menjadi beberapa baris tanpa model alokasi.
- Sediakan bagian default 'Belum dikelompokkan'; barang tidak boleh hilang dari checklist karena belum punya bagian. Mengarsip bagian harus memindahkan barang aktif ke bagian lain/default, bukan menghapus barangnya.
- Tampilkan checklist hitung per bagian dengan progres '3 dari 8 barang diisi'; kosong berbeda dari nol. Dukungan keyboard angka/next input, Simpan sementara, serta lanjut hitung setelah reload. Pilihan 'Sesuai patokan' tidak boleh tercentang otomatis.
- Penataan menggunakan mode khusus 'Atur checklist', tombol pindah atas/bawah dan pilih bagian yang aksesibel; drag-and-drop opsional, bukan satu-satunya kontrol. Simpan pengurutan secara atomik dengan expected_version dan penanganan konflik.
- Urutan bersama/default berlaku pada checklist baru/cycle berikutnya. Jangan menyusun ulang layar petugas lain yang sedang menghitung; draft aktif mempertahankan urutan stabil. Snapshot laporan historis tetap dapat dibaca walaupun nama bagian/urutan terbaru berubah.
- Pisahkan CTA 'Tambah barang', 'Catat barang masuk/terpakai', dan 'Arsipkan dari daftar berikutnya'. Tampilkan kapan perubahan berlaku. Jangan membuat pengguna mengira archive menghapus sisa stok.

#### Acceptance Tambahan B05-B07

1. Operator check-in -> emergency sendiri -> receipt pending review -> reviewer lain -> recovery tugas -> complete; double click, response loss/retry dan lintas hari tidak menggandakan event/audit. Menargetkan attendance orang lain ditolak.
2. Fresh outlet: PRIMARY menyiapkan bagian dan barang, mengisi stok fisik awal termasuk nol eksplisit, mengonfirmasi sekali lalu masuk movement tanpa menunggu manager. Existing-history cycle tetap menggunakan referensi sah, tidak mengizinkan reset baseline arbitrer.
3. PRIMARY menambah/archive/reorder dalam area tugasnya, reload mempertahankan perubahan; area lain, Helper dan Investor ditolak sesuai scope. Supervisor/Owner dapat mengelola outlet tanpa claim tugas staf.
4. Cycle aktif/draft tidak berubah diam-diam ketika checklist diedit perangkat lain; cycle berikutnya memakai versi baru; laporan lama, item archive, total dan satuan tetap benar.
5. Dua editor melakukan reorder/move/archive bersamaan: tidak ada item hilang/duplikat dan konflik dapat dipulihkan. Penghapusan bagian tidak menyembunyikan item aktif.
6. Staf menyimpan susunan di perangkat A, Supervisor membuka dashboard di perangkat B: versi, bagian dan urutan sama untuk checklist yang dipilih; reload/login ulang mempertahankan susunan. Susunan pending ditandai jelas, snapshot cycle aktif tidak berubah. Verifikasi lewat dua sesi browser dengan API nyata, bukan hanya mock/localStorage.

#### Penyesuaian Urutan E0-E7

E0 tidak lagi menunggu keputusan baseline/self-emergency; implementasikan B05-B07 sebagai kontrak resmi. E1 mencakup UI checklist lokasi + otorisasi Primary + katalog snapshot + first-count setup. E3 mencakup self-emergency terpisah dari manager-on-behalf dan combined report. Semua gate lain, consolidation folder/Vercel, upgrade terarah dan larangan rollout tanpa izin tetap berlaku. Pengecualian share investor sementara B03 belum diaktifkan sebelum detailnya diputuskan; tidak memblokir operasi approved-only.

### Batas Audit UX

Impeccable context menemukan desain historis bertentangan dan tidak ada PRODUCT.md. Penilaian source menunjukkan integritas alur gagal (U01/U04), responsif/accessibility belum diuji browser dan kontras belum diukur; jangan membuat skor visual/WCAG seolah sudah diuji dari screenshot yang tidak terbaca. Visual detector dan browser batch menjadi gate E4/E7, bukan evidence yang telah selesai.

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
| F02 | P1 | Temuan wiring historis, kini diperbaiki | Owner/Supervisor dan Operator PRIMARY sesuai B06 dapat menyiapkan baseline pertama melalui jalur UI yang benar; tidak membuka reset histori. |
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
| Catalog | Supervisor/Owner outlet dan PRIMARY scoped create/update/archive/checklist menurut B07; Helper/Investor dan cross-area denial; item baru baseline, cycle aktif frozen, archive setelah closing sebelum report, satuan/histori |
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
