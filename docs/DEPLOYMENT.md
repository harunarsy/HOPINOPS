# HOPIN deployment

## Jalur resmi

`main` adalah branch release. GitHub Actions menjalankan gate aplikasi, lalu job `Deploy production` hanya berjalan setelah gate tersebut lulus dan hanya untuk push ke `main`.

Job deploy memakai project Vercel canonical `hopinops`. Ia menarik setting production, membangun artifact dari commit yang sama, mengirim prebuilt artifact, memastikan alias `hopinops.vercel.app` menunjuk ke deployment tersebut, lalu memeriksa `/build-info.json` dan `/api/health`. Smoke production hanya read-only.

Project Vercel lain tidak boleh dipakai sebagai jalur production. Untuk menghindari dua deployment berebut alias, matikan automatic Production Deployments dari Git pada project `hopinops` setelah workflow ini aktif. Preview deployment tetap boleh dipertahankan bila memang dibutuhkan.

## Secret GitHub yang dibutuhkan

Tambahkan tiga secret pada GitHub Environment `production` atau repository:

| Secret | Isi |
|---|---|
| `VERCEL_TOKEN` | Token Vercel untuk deploy |
| `VERCEL_ORG_ID` | ID team/account Vercel yang memiliki project |
| `VERCEL_PROJECT_ID` | ID project `hopinops`, bukan project duplikat |

Nilai tidak boleh ditulis di repository, workflow output, atau file `.env` yang di-commit. Workflow hanya mencetak status dan hostname deployment.

## One-time setup

1. Pastikan `VERCEL_PROJECT_ID` mengarah ke project `hopinops` dan environment production memiliki seluruh variable runtime yang dibutuhkan aplikasi.
2. Buat GitHub Environment bernama `production`. Tambahkan secret di atas. Approval manual boleh diaktifkan sebagai pengaman tambahan, tetapi bukan bagian dari aplikasi.
3. Jalankan satu push perubahan kecil ke `main` setelah secret tersedia.
4. Pastikan job `application` lulus sebelum `deploy_production` dimulai.
5. Pastikan `build-info.json` pada `https://hopinops.vercel.app` berisi commit workflow terbaru, lalu `/api/health` mengembalikan `ok`.
6. Setelah pipeline terbukti, nonaktifkan auto production deploy Git di dashboard Vercel agar hanya GitHub Actions yang mempromosikan production.

Migration database tetap dilakukan sebagai langkah release terpisah dan terkontrol sebelum deploy aplikasi yang memerlukannya. Workflow ini tidak menjalankan migration, seed, backup, atau mutating test terhadap production.

## Rollback

Jika verifikasi SHA, alias, health, atau smoke gagal, job menjadi merah dan release dianggap gagal. Deployment sebelumnya tetap menjadi kandidat rollback di dashboard Vercel. Jangan memperbaiki kegagalan dengan mengarahkan workflow ke project lain atau menjalankan smoke mutasi production.
