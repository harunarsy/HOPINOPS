# HOPIN Folder and Vercel Consolidation Plan

Tanggal: 6 September 2026
Status: PLAN; belum ada pemindahan, relink, perubahan environment/domain, atau penghapusan project.
Kontrak bisnis tetap mengikuti FINAL_OPERATIONAL_READINESS_PLAN.md. Konsolidasi tidak menutup blocker operasional Tahap B.

## Target

- Root aplikasi aktif: /Users/harunalrasyid/Projects/HOPIN, bukan HOPIN/webapp.
- Satu project produksi HOPIN: hopinops; pertahankan ID dan domain produksi yang sudah dipakai.
- Demo/prototipe tidak dicampurkan ke dependency/data produksi; arsip di luar root aktif sesuai persetujuan pengguna.
- Project Vercel lain yang bukan HOPIN di luar scope. Tidak disentuh.

## Evidence Terverifikasi

Koordinator memverifikasi hasil agent dengan read .vercel/repo.json serta CLI read-only:

| Perintah | Hasil |
|---|---|
| pnpm dlx vercel project ls | Kedua project hopinops dan webapp ada di team harunarsys-projects. |
| pnpm dlx vercel project inspect hopinops | ID prj_m2oQefN2N52iuSuaoZU8srtoBHKG; dibuat 2 September 2026; Root Directory .; Vite; Node 24.x. |
| pnpm dlx vercel project inspect webapp | ID prj_tNGLAKJxGWAGPJtfvliOBK4C64N0; dibuat 4 September 2026; Root Directory .; Vite; Node 24.x. |

Production URL pada project list: https://hopinops.vercel.app dan https://webapp-rose-mu.vercel.app.
Metadata lokal webapp/.vercel/repo.json menunjuk project hopinops dengan directory . dan remote origin.
Agent menemukan root Git webapp, remote https://github.com/harunarsy/HOPINOPS.git, serta perubahan Tahap B masih berjalan termasuk migration 0019 belum terlacak saat pemeriksaan.

pnpm dlx mengunduh tool CLI ke cache; tidak menambahkan dependency aplikasi atau mengubah konfigurasi project cloud. Screenshot pengguna tidak dapat dibaca pada sesi ini.

Belum diketahui: alasan project kedua dibuat, isi deployment webapp, integrasi Git kedua project, daftar lengkap domain, env scopes, webhook, cron aktif, pengguna URL lama, traffic, atau biaya aktual. Dua project tidak otomatis membuktikan biaya dua kali lipat. Jangan menyebut webapp aman dihapus sebelum inventaris selesai.

## Peran Folder Saat Ini

| Folder | Fungsi | Tindakan rencana |
|---|---|---|
| webapp | Repo aplikasi aktif, API, frontend, migrations | Naikkan isinya beserta .git dan file tersembunyi ke root HOPIN setelah checkpoint. |
| webapp-fallback | Demo statis mandiri dengan localStorage | Arsipkan di luar root aktif; bukan backup sistem produksi. |
| output | PDF, screenshot, ZIP, juga source prototipe | Pilah dokumen penting dan prototipe; jangan hapus sebagai output generated seluruhnya. |
| tmp | Artefak render PDF | Hapus hanya setelah kebutuhan dan sumber aslinya diverifikasi serta ada izin. |

Parent juga berisi .pnpm-store dan .DS_Store. Periksa benturan path sebelum pemindahan. Inventaris nested repository/symlink/hidden files diperlukan sebelum arsip; pemeriksaan root bukan bukti semua subfolder bebas Git.

## Tahap 1: Bekukan Checkpoint

1. Tunggu AI Tahap B berhenti pada checkpoint yang jelas. Jangan memindahkan cwd saat agent/server/test masih mengakses webapp.
2. Catat HEAD, branch, status tracked/untracked, diff, dan source artifact yang sebenarnya sedang terdeploy. Backup perubahan uncommitted dan file lokal secara aman, termasuk permission secret.
3. Tentukan lokasi arsip di luar root aktif dengan persetujuan pengguna. Jangan memasukkan env/backup database privat ke ZIP yang dibagikan.
4. Tidak ada git init ulang, reset, force push, atau commit tanpa izin. Preserve seluruh histori dan perubahan pengguna.

## Tahap 2: Inventaris Cloud

Untuk hopinops dan webapp, catat project ID, Git repository/branch/root, deployment produksi/preview, seluruh domain/alias, build/install/output, env NAMES dan target scopes, cron, deployment hooks, integrations/storage, monitoring dan traffic/usage.

Periksa pemakai domain lama: bookmark/QR staf, callback, allowlist origin, webhook, CI dan layanan eksternal. Konfirmasi apakah kedua project berbagi Supabase dan apakah cleanup cron berjalan ganda. Jangan membaca nilai secret ke laporan, menyalin seluruh env secara buta, atau menjalankan endpoint mutasi untuk sekadar inspeksi.

Gate: webapp diklasifikasikan berbukti sebagai duplikat tak dipakai atau mempunyai fungsi/dependensi yang harus dipindahkan. Jika tidak cukup bukti, tetap pertahankan project dan tandai blocker.

## Tahap 3: Konsolidasi Root Lokal

1. Inventaris benturan nama di parent; arsipkan folder nonaktif sesuai izin tanpa overwrite.
2. Pindahkan seluruh isi repository webapp termasuk .git, .github, .vercel, env lokal dan ignore files ke HOPIN. Jangan menggabungkan node_modules/dependency prototipe.
3. Pertahankan remote Git dan ID project hopinops. Karena isi repository tidak berubah secara relatif, Root Directory Vercel . tetap tepat bila package.json tetap di root Git; jangan ubah menjadi HOPIN hanya karena nama folder lokal.
4. Periksa path absolut pada scripts/editor/workspace/CI/test runner. Catatan historis cukup diberi pemetaan old root -> new root, bukan search-replace seluruh histori.
5. Verifikasi hash/isi tracked serta untracked, branch/HEAD/diff, ignore rules dan permissions. Pastikan tidak ada artefak/secret yang tiba-tiba menjadi tracked.
6. Rapikan satu perintah dev full-stack berdasarkan pola project yang sudah ada. pnpm dev saat ini hanya Vite; jangan mengklaim endpoint API tersedia sebelum smoke full-stack. Perubahan script diuji terpisah dari pemindahan fisik.
7. Jalankan lint, unit, backend type-check, build, dan smoke lokal/staging dari root baru. Jangan memakai production sebagai target test mutasi.

Gate: aplikasi dapat dikerjakan langsung dari HOPIN tanpa webapp wrapper, histori/data utuh, backend bekerja, dan project cloud tidak berubah tanpa alasan.

## Tahap 4: Retire Project webapp

1. Setelah inventaris, tentukan tindakan per dependensi: pertahankan pada hopinops, migrasikan dengan izin, atau hentikan bila terbukti tidak dipakai.
2. Jika domain lama dipakai, sepakati strategi perpindahan/redirect dan konsekuensi penghapusan project. Jangan menjanjikan domain platform lama tetap tersedia setelah project dihapus.
3. Minta izin perubahan domain/env/Git integration/cron jika diperlukan. Hindari cron ganda; menonaktifkan job tetap perubahan produksi dan harus dikoordinasikan.
4. Verifikasi hopinops melayani seluruh fungsi yang diperlukan; observasi periode yang disepakati dan siapkan rollback konfigurasi non-secret serta akses secret melalui penyimpanan aman.
5. Minta persetujuan eksplisit penghapusan project webapp dengan menyebut ID prj_tNGLAKJxGWAGPJtfvliOBK4C64N0 dan domain terdampak. Permintaan membuat plan bukan izin delete.
6. Setelah diizinkan, hapus hanya project tersebut. Jangan hapus resource Supabase/storage/shared integration secara ikut-ikutan.
7. Verifikasi project list hanya menyisakan hopinops untuk HOPIN; domain produksi, readiness terautentikasi, security headers, cron dan smoke sesuai scope tetap sehat.

## Rollback dan Handoff

- Lokal: pemetaan path dan backup checkpoint memungkinkan repository dikembalikan tanpa menimpa perubahan baru. Hentikan seluruh writer terlebih dahulu.
- Cloud: jangan mengandalkan recreate project sebagai rollback identik; ID, histori deployment, URL dan integrations mungkin tidak kembali. Itu alasan delete dilakukan terakhir.
- Update ACTION_LOG.md dan README setelah eksekusi, bukan saat AI lain masih aktif menulis file yang sama tanpa koordinasi.
- Definition of done: satu root aktif HOPIN, satu project HOPIN hopinops, tidak ada data/histori hilang, tidak ada dependensi domain lama yang terlantar, dan bukti verifikasi tercatat. Ini bukan deklarasi seluruh produk production-ready.
