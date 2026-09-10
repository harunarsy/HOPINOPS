# HOPIN deployment

## Jalur resmi

`main` adalah branch release. GitHub Actions menjalankan gate aplikasi, lalu job `Deploy production` hanya berjalan setelah gate tersebut lulus dan hanya untuk push ke `main`.

Job deploy memakai project Vercel canonical `hopinops`. Bila secret Vercel tersedia, job menarik setting production, membangun artifact dari commit yang sama, mengirim prebuilt artifact, dan mempromosikan alias. Bila secret belum tersedia, job menunggu Git Integration Vercel yang terhubung ke `main` menyelesaikan deployment otomatis. Kedua jalur memeriksa `/build-info.json`, `/api/health`, dan smoke production read-only sebelum dianggap lulus.

Project Vercel lain tidak boleh dipakai sebagai jalur production. Pertahankan automatic Production Deployments dari Git bila memakai fallback Git Integration. Jika nanti secret Vercel ditambahkan dan jalur CLI dipilih sebagai satu-satunya promoter, auto production deploy dapat dimatikan setelah jalur CLI terbukti.

## Secret GitHub untuk jalur CLI (opsional)

Tambahkan tiga secret pada GitHub Environment `production` atau repository bila ingin artifact dipromosikan langsung oleh GitHub Actions:

| Secret | Isi |
|---|---|
| `VERCEL_TOKEN` | Token Vercel untuk deploy |
| `VERCEL_ORG_ID` | ID team/account Vercel yang memiliki project |
| `VERCEL_PROJECT_ID` | ID project `hopinops`, bukan project duplikat |

Nilai tidak boleh ditulis di repository, workflow output, atau file `.env` yang di-commit. Workflow hanya mencetak status dan hostname deployment.

## One-time setup

1. Pastikan project Vercel `hopinops` terhubung ke repository `HOPINOPS`, branch `main`, dan environment production memiliki seluruh variable runtime yang dibutuhkan aplikasi. Ini adalah jalur default tanpa secret.
2. Jalankan satu push perubahan kecil ke `main`. Job `deploy_production` akan menunggu SHA baru muncul pada `https://hopinops.vercel.app` lalu memeriksa health dan smoke.
3. Jika memilih jalur CLI, buat GitHub Environment `production`, tambahkan secret di atas, lalu jalankan push berikutnya. Approval manual boleh diaktifkan sebagai pengaman tambahan.
4. Setelah salah satu jalur terbukti, pastikan `build-info.json` berisi commit workflow terbaru dan `/api/health` mengembalikan `ok`.

Migration database tetap dilakukan sebagai langkah release terpisah dan terkontrol sebelum deploy aplikasi yang memerlukannya. Workflow ini tidak menjalankan migration, seed, backup, atau mutating test terhadap production.

## Rollback

Jika verifikasi SHA, alias, health, atau smoke gagal, job menjadi merah dan release dianggap gagal. Deployment sebelumnya tetap menjadi kandidat rollback di dashboard Vercel. Jangan memperbaiki kegagalan dengan mengarahkan workflow ke project lain atau menjalankan smoke mutasi production.
