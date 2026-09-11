# HOPIN Stock Operations

Aplikasi operasional HOPIN berbasis React/Vite dan API serverless. Browser hanya
berkomunikasi dengan `/api/*`; kredensial database tetap di server. Supabase
production adalah sumber data operasional, sedangkan pengembangan lokal memakai
project Supabase staging yang terpisah.

## Jalur environment

| Jalur | Database | Kegunaan |
|---|---|---|
| `pnpm dev` | tidak ada API | Preview UI saja |
| `pnpm dev:staging` | Supabase staging remote | Pengembangan dan CRUD aman |
| `https://hopinops.vercel.app` | Supabase production | Operasional |

Data production tidak disalin ke laptop. Setiap perubahan dari aplikasi lokal
masuk ke staging, bukan production.

## Perintah utama

```bash
pnpm install
pnpm dev                 # preview UI saja
pnpm dev:staging         # full-stack lokal dengan Supabase staging
pnpm db:staging:migrate  # terapkan migration ke staging yang di-allowlist
pnpm ops:staging-smoke   # fixture disposable, API/browser smoke, cleanup
pnpm lint
pnpm test
pnpm build
pnpm test:smoke          # smoke read-only desktop dan mobile
pnpm ops:verify          # lint, unit, build, smoke read-only, diff check
```

Jika login pada preview UI menampilkan server tidak terjangkau, jalankan
`pnpm dev:staging`, bukan `pnpm dev`, lalu buka origin yang sama.

## Menyiapkan staging

Buat file lokal `.env.staging.local` dari `.env.example`. File ini di-ignore Git
dan tidak boleh ditempelkan ke chat, screenshot, log, atau issue. Isi URL,
project reference 20 karakter, service key server-only, dan connection string
database dari project Supabase staging yang memang dibuat untuk HOPIN.

```dotenv
HOPIN_RUNTIME=staging
HOPIN_STAGING_PROJECT_REF=<project-ref-staging>
SUPABASE_URL=https://<project-ref-staging>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only-key>
HOPIN_STAGING_DB_URL=postgresql://postgres:<password>@db.<project-ref-staging>.supabase.co:5432/postgres?sslmode=require
APP_ALLOWED_ORIGIN=http://localhost:3000
```

`HOPIN_STAGING_PROJECT_REF` harus sama dengan host `SUPABASE_URL`. Runtime akan
menolak project production, URL HTTP, host yang tidak cocok, dan connection
string yang tidak menunjuk ke project staging tersebut. Service key hanya dibaca
oleh API lokal dan tidak pernah masuk bundle browser.

Jalankan migration setelah project aktif:

```bash
HOPIN_STAGING_MIGRATE_ACK=1 pnpm db:staging:migrate
pnpm dev:staging
```

Validasi tanpa menyentuh database dapat dijalankan dengan
`pnpm db:staging:migrate -- --dry-run`. Migration hanya menerima target
staging yang dikonfigurasi dan berhenti sebelum menjalankan CLI bila ack tidak
ada; tidak ada fallback ke production.

## Smoke operator staging

`pnpm ops:staging-smoke` membuat dua outlet dan akun operator/supervisor sintetis
dengan PIN acak, menjalankan login, sanitasi error, status koneksi, assignment,
opening, autosave, movement, handover/closing, handover tanpa movement, attendance,
katalog, laporan, reset tutorial immediate/deferred, dan logout, lalu menonaktifkan
fixture pada blok `finally`. Manifest hanya berada di direktori temporer dan tidak
memuat PIN di output. Tidak ada akun operator production atau data production yang
dipakai.

Perintah ini sengaja memerlukan kredensial staging lokal. Jika project belum ada,
secret tidak cocok, atau target meragukan, command berhenti sebelum mutation.

## Release production

`main` adalah branch release. Jalur resmi:

```text
push main
→ GitHub Actions lint, test, build, diff check
→ Vercel project hopinops membangun commit yang sama
→ verifikasi build-info SHA dan alias hopinops.vercel.app
→ GET /api/health = ok
→ Playwright smoke production read-only
```

Migration production tetap langkah terpisah dan harus selesai sebelum kode yang
membutuhkannya dirilis. Workflow tidak melakukan seed, fixture, backup, atau
mutation ke production. Project Vercel duplikat tidak digunakan.

Untuk verifikasi manual read-only:

```bash
E2E_BASE_URL=https://hopinops.vercel.app pnpm test:smoke
```

Lihat [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) untuk setup secret GitHub,
verifikasi SHA, alias, health, dan rollback.

## Environment variables

| Variabel | Keterangan |
|---|---|
| `SUPABASE_URL` | URL project yang dipakai API; staging lokal atau production Vercel |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only; jangan pernah memakai prefix `VITE_` |
| `HOPIN_RUNTIME` | `staging` untuk full-stack lokal; production dibiarkan dari Vercel |
| `HOPIN_STAGING_PROJECT_REF` | Allowlist project staging lokal |
| `HOPIN_STAGING_DB_URL` | Connection string migration staging; tidak dicetak |
| `APP_ALLOWED_ORIGIN` | Origin exact untuk validasi CSRF |
| `PAYROLL_EXPORT_BUCKET` | Bucket privat export payroll |
| `READINESS_SECRET` | Secret probe readiness opsional |
| `CRON_SECRET` | Secret endpoint cron production |

Browser tidak membutuhkan environment variable database apa pun.

## Keamanan dan audit

- Login memakai session cookie, lockout PIN server-authoritative, dan single-device binding.
- Error API internal tidak dirender ke pengguna. Login gagal selalu berbunyi
  `Nama pengguna atau PIN salah.` dan muncul pada slot animasi di bawah rail PIN.
- Shift siang wajib menyelesaikan opening dan handover; movement boleh kosong.
  Shift malam/full membaca handover area yang sama sebelum opening dan dapat lanjut
  ke closing tanpa membuat transaksi movement palsu.
- Supervisor/Owner dapat memakai `Reset tutorial` per operator dengan alasan wajib.
  Reset tidak mencabut login, PIN, perangkat, assignment, absensi, atau data stok;
  reset yang diminta saat shift aktif ditunda sampai shift selesai dan seluruh event
  tetap tercatat append-only.
- Timestamp server dan nomor revisi dipertahankan untuk opening, movement,
  closing, attendance, laporan, dan perubahan katalog.
- Arsip menggantikan hard delete; histori master dan transaksi tetap immutable.
- Geolokasi mentah tetap server-side sesuai retensi, sementara UI hanya menerima
  status evidence yang diperlukan.
- Touch target minimal, focus ring, keyboard navigation, reduced motion, dan
  layout tanpa overflow diuji pada viewport desktop, tablet, dan smartphone.

## Status

Migration, deployment, dan smoke production yang sudah ada tetap dicatat di
`ACTION_LOG.md`. Untuk pekerjaan baru, jalur lokal resmi adalah remote staging;
tidak ada database lokal atau snapshot production.
