# HOPIN Execution Plan

Tanggal: 9 September 2026  
Status: aktif. Dokumen ini adalah urutan kerja dan gate keputusan untuk reliability, katalog, deployment, dan konsolidasi proyek.

## Progress implementasi

- [x] Partial failure `Atur Jadwal`: roster tetap tampil jika daftar petugas gagal dimuat.
- [x] Katalog manajemen: varian dapat ditambah, diubah, diarsipkan, dan susunan ditempatkan pada mode khusus.
- [x] Workspace operator: tab `Varian & Checklist` dikunci pada area assignment; HELPER hanya baca dan PRIMARY memakai endpoint terpisah.
- [x] Terminologi UI: baseline fisik diganti menjadi stok patokan pada alur operator.
- [x] Migration sumber ditambahkan untuk update metadata oleh PRIMARY dengan guard area assignment dan pending catalog snapshot.
- [x] Database regression mencakup PRIMARY own-area, HELPER/unassigned denial, cross-area denial, current-cycle freeze, dan promotion setelah cycle terminal.
- [x] Validasi aplikasi: `pnpm lint`, `pnpm test` (81 test), `pnpm build`, diagnostics, dan `git diff --check` lulus.
- [x] Staging E2E disposable melalui `vercel dev` lokal dan Supabase staging lulus 22/22, dengan provision dan teardown 2 outlet serta 8 profil bersih. Runner sekarang membuat `.env` sementara berizin `0600`, menolak menimpa `.env` pengguna, lalu menghapusnya saat teardown.
- [ ] Root cause production `Atur Jadwal`, audit Vercel, rotasi credential staging, konsolidasi folder, dan pensiun project Vercel menunggu bukti atau approval gate yang tercantum di bawah.

## Target akhir

```text
GitHub repository HOPINOPS
└── satu root aplikasi: HOPIN/
    ├── api/
    ├── src/
    ├── supabase/
    ├── package.json
    └── konfigurasi aplikasi

main
  → Vercel project hopinops
  → https://hopinops.vercel.app

Supabase
├── production: data operasional
└── staging: fixture, E2E, dan validasi perubahan
```

Production dan staging tetap dua database terpisah. Yang disatukan adalah source, migration, dokumentasi, dan jalur deploy.

## Guardrail

- Tidak ada hard delete katalog, histori, deployment, atau project Vercel.
- Tidak ada relink atau pemindahan database production.
- Tidak ada schema migration irreversible tanpa checkpoint dan backup/rollback yang sesuai.
- Credential tidak pernah dicetak pada terminal, log, atau dokumentasi.
- Permission mutasi katalog diputuskan di backend/RPC, bukan frontend.
- Unit, movement, dan snapshot stok historis tidak boleh berubah karena katalog diedit.
- Konsolidasi folder dan pensiun project Vercel memerlukan approval eksplisit sebelum dieksekusi.

## Fase 1: Perbaikan production Atur Jadwal

1. Reproduksi dari production dan identifikasi request gagal antara `roster.list` dan `users.list`.
2. Catat action, status HTTP, dan `request_id` yang aman bila tersedia.
3. Cocokkan dengan Vercel Function Logs untuk error Supabase/PostgREST yang sebenarnya.
4. Audit schema production: `roster_entries`, `profile_outlet_scopes`, `profiles`, foreign key ke profile, dan kolom yang dipakai query.
5. Terapkan root fix berdasarkan bukti: migration, query, relation, atau refresh schema cache.
6. Ubah `ManagementView` agar roster tetap tampil bila `users.list` gagal. Form tambah jadwal dikunci dan menjelaskan bahwa daftar petugas belum dapat dimuat.
7. Pastikan respons klien tidak membocorkan SQL, schema, atau detail provider.

Gate: `Atur Jadwal` dapat dibuka di production, roster dan pengguna berhasil dimuat atau partial failure ditangani dengan aman.

## Fase 2: Deployment production

1. Audit Vercel project `hopinops` untuk Git integration, production branch, root directory, build, domains, aliases, cron, hooks, integrations, redirects, dan protection.
2. Tetapkan release contract:

```text
push main
→ build hopinops
→ deployment SHA sama dengan main
→ hopinops.vercel.app menuju deployment tersebut
→ smoke test
```

3. Verifikasi alias canonical sesudah setiap deploy. `vercel --prod` saja bukan bukti alias berpindah.
4. Audit project `webapp` hanya untuk dependency aktif. Jangan hapus sebelum audit selesai dan approval diberikan.
5. Sebelum migration production, lakukan `supabase db push --project-ref naanarmoktmsumkxmjvj --dry-run` dan cocokkan hanya migration yang disetujui.

Gate: `main` terbukti menjadi sumber deployment `hopinops.vercel.app`.

## Fase 3: PIC dan responsibility summary

1. Audit hubungan `roster_entries.expected_area`, assignment shift, `PRIMARY`, `HELPER`, dan work-cycle aktif.
2. Tambahkan data contract read-only per tanggal dan area untuk PRIMARY, HELPERS, dan state `ASSIGNED`, `HELPER_ONLY`, atau `UNASSIGNED`.
3. Tampilkan state berikut secara jujur:
   - PRIMARY: PIC dan shift ditampilkan.
   - HELPER only: katalog dibaca, perubahan dikunci.
   - Unassigned: katalog dibaca, perubahan dikunci.
   - Error: gagal memuat data PIC, bukan empty state.

Gate: UI tidak memakai nama/fakta PIC yang dibuat-buat dan authority berasal dari server.

## Fase 4: Permission varian dan audit katalog

| Aksi | PRIMARY area sendiri | HELPER | Owner/Supervisor |
|---|---:|---:|---:|
| Lihat katalog | Ya | Ya | Ya |
| Tambah, edit, susun, archive varian | Ya | Tidak | Ya |
| Kelola area lain | Tidak | Tidak | Ya |
| Hard delete | Tidak | Tidak | Tidak |

1. Audit endpoint/RPC create/archive operator yang sudah ada dan aturan active-cycle lock.
2. Tambahkan mutation update item yang memvalidasi PRIMARY aktif, area sendiri, expected version, dan audit before/after.
3. Izinkan perubahan metadata yang relevan: nama, unit, threshold, section, dan urutan.
4. Archive bersifat soft delete dengan alasan, actor, dan waktu.

Gate: HELPER dan PRIMARY lintas area ditolak oleh backend, bukan cuma tombol yang disembunyikan.

Catatan staging: catalog global saat ini tidak memiliki `outlet_id`, sehingga RPC snapshot menolak semua mutasi katalog ketika lebih dari satu outlet aktif (`GLOBAL_ITEM_SCHEMA`). Fixture browser E2E sengaja memakai dua outlet aktif untuk isolasi desktop/mobile dan tidak dapat menjadi bukti endpoint katalog sampai skema item menjadi outlet-scoped. Regression SQL disposable single-outlet mencakup endpoint PRIMARY tersebut.

## Fase 5: Integritas stok dan unit

- Varian: nama, unit, section, active/archive.
- Stok shift: kuantitas fisik awal, perubahan, dan akhir.
- Stok patokan: referensi fisik pertama yang tepercaya, bukan pekerjaan stok harian.
- Histori: immutable.

Perubahan unit tidak boleh mengubah movement atau snapshot lama. Sebelum implementasi, audit apakah item yang terkunci dalam cycle aktif harus menolak perubahan unit. Default aman: perubahan unit berlaku pada cycle berikutnya.

## Fase 6: Redesign katalog dan workspace

Arah desain: cafe ledger, forest green, paper, amber. Dial: `ENERGY 1 / RHYTHM 2 / MOTION 1`.

### Management Catalog

- Area Bar/Kitchen sebagai konteks.
- Header area dengan PIC nyata dan shift.
- Varian aktif dikelompokkan berdasarkan checklist section.
- Unit dekat dengan nama item.
- Tambah/edit/archive tersedia sesuai role.
- Mode khusus `Atur susunan`, bukan kontrol naik/turun selalu terbuka.
- Raw item ID dan jargon server tidak tampil sebagai konten utama.

### Operator Workspace

```text
Workspace area assignment
├── Ringkasan
├── Stok Awal
├── Perubahan
├── Stok Akhir
└── Varian & Checklist
```

- Operator tidak bebas memilih area di luar assignment.
- PRIMARY dapat mengelola varian area sendiri.
- HELPER hanya melihat katalog dengan penjelasan lock.
- `Simpan baseline fisik` diganti menjadi `Tetapkan stok patokan` dan hanya muncul saat referensi belum tersedia.

Implementasi UI dimulai setelah mode anti-slop dikonfirmasi: selama pengerjaan atau audit setelah selesai.

## Fase 7: Pengujian dan release

Backend:
- PRIMARY own-area allow.
- HELPER, unassigned, dan cross-area deny.
- Owner/Supervisor cross-area allow.
- Archive dan unit tidak merusak histori.

Frontend:
- isolasi data Bar/Kitchen;
- PRIMARY, HELPER-only, unassigned, loading, empty, dan error state;
- partial failure roster/users;
- keyboard, focus, mobile, dan semua aksi fungsional.

Jalankan:

```sh
pnpm lint
pnpm test
pnpm build
git diff --check
```

Release:
1. Push ke `main`.
2. Verifikasi deployment SHA.
3. Verifikasi alias `hopinops.vercel.app`.
4. Smoke test role dan alur penting di production.

## Fase 8: Konsolidasi repository dan cleanup

### Konsolidasi folder

Target:

```text
HOPIN/webapp/* → HOPIN/
```

Sebelum eksekusi, buat checkpoint khusus dan verifikasi Git history, package scripts, Supabase CLI, CI, `.gitignore`, editor workspace, serta Vercel Root Directory. Perubahan ini memerlukan approval eksplisit tepat sebelum pemindahan.

### Credential staging

Rotasi service-role key staging yang pernah terekspos, perbarui environment terkait, lalu cabut credential lama tanpa menampilkan nilainya.

### Pensiun project Vercel webapp

Baru diajukan setelah domain, alias, traffic, cron, hooks, integrations, dan deployment dependency terbukti kosong. Penghapusan memerlukan approval eksplisit terpisah.
