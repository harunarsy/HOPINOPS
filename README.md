# HOPIN Stock Operations — Aplikasi Produksi Server-First

Aplikasi operasional stok HOPIN: SPA React/Vite yang hanya berkomunikasi dengan API serverless di `/api/*`, dengan Supabase PostgreSQL sebagai satu-satunya sumber kebenaran production. Seluruh mutasi operasional berjalan lewat transactional RPC di server; local development menggunakan salinan database lokal yang diambil secara read-only dari production.

## Arsitektur

- **Frontend**: React 19 + Vite SPA (`src/`). Browser tidak memakai kredensial database; semua request operasional lewat `/api/*` dengan session cookie.
- **Backend**: Vercel serverless (`api/`): `auth.ts` (login/session), `app.ts` (business commands via RPC), `health.ts` (liveness), `readiness.ts` (dependency check, dilindungi secret).
- **Database**: Supabase PostgreSQL. Skema, RLS, RPC komando, audit, storage `payroll-exports`, dan retention ada di `supabase/migrations/0001`–`0031`.

## Perintah

```bash
pnpm install
pnpm dev         # UI Vite saja
pnpm dev:local   # snapshot production → Supabase lokal → UI + /api
pnpm dev:full    # alias aman ke pnpm dev:local
pnpm db:local:sync   # refresh snapshot production ke database lokal
pnpm db:local:verify # cek target URL lokal tanpa menyentuh database
pnpm test:operator:local # smoke operator, hanya local sandbox (butuh env + ack)
pnpm ops:verify       # satu run: lint, unit, build, smoke read-only, target check
pnpm ops:verify -- --operator # tambah smoke operator lokal yang mutatif
pnpm lint        # tsc --noEmit
pnpm test        # vitest
pnpm build       # vite build
pnpm test:smoke  # smoke UI read-only desktop/mobile, tanpa login
pnpm test:e2e    # alias smoke read-only
```

`pnpm dev` hanya menjalankan UI Vite tanpa endpoint `/api/*`. Gunakan `pnpm dev:local` atau `pnpm dev:full` untuk menjalankan full-stack melalui Vercel Dev. Full-stack lokal membutuhkan Docker Desktop dan Supabase CLI. Runner akan berhenti bila Docker belum aktif; ia tidak pernah fallback ke production.

Jika halaman lokal menampilkan pesan server tidak terjangkau saat login, pastikan Docker aktif lalu jalankan `pnpm dev:full` (alias sandbox, bukan `pnpm dev`) dan buka ulang origin yang sama, biasanya `http://localhost:3000`.

### Local sandbox (production → local, satu arah)

Vercel `hopinops` tetap memakai Supabase production `naanarmoktmsumkxmjvj`. Local full-stack tidak lagi memakai database itu secara langsung. Sebelum server lokal dibuka, runner:

1. memeriksa migration dan schema production secara read-only;
2. membuat dump data bisnis terbaru;
3. memastikan Supabase lokal aktif;
4. membuat backup database lokal;
5. mereset schema lokal ke migration repo;
6. merestore dump ke database lokal dan memverifikasi jumlah baris/fingerprint.

Tabel runtime session, device, rate-limit, challenge, idempotency, dan reservasi export tidak disalin. Profile, credential PIN, katalog, histori, stok, laporan, payroll, dan audit bisnis disalin agar flow lokal bisa diuji. Snapshot dan backup berada di `.local-sandbox/` (ignored, permission terbatas) dan tidak pernah dipush.

Siapkan file `.env.production-snapshot` lokal (file ini otomatis di-ignore) dengan connection string database production khusus read-only:

```dotenv
HOPIN_PROD_DB_URL=postgresql://readonly:<password>@db.<production-ref>.supabase.co:5432/postgres?sslmode=require
```

Jangan memakai `SUPABASE_SERVICE_ROLE_KEY` sebagai `HOPIN_PROD_DB_URL`, jangan menaruh secret di source code, dan jangan mencetak connection string ke terminal. Runner hanya menerima host production yang diizinkan dan memaksa `default_transaction_read_only=on`. Target restore wajib loopback (`127.0.0.1`/`localhost`).

Perintah sync manual:

```bash
pnpm db:local:verify
pnpm db:local:sync
pnpm dev:local
```

`pnpm db:local:sync` membawa konfirmasi target lokal secara eksplisit. Setiap start `dev:local` mengambil state production terbaru lagi. CRUD yang dilakukan setelah server lokal hidup hanya masuk ke database lokal. Tidak ada jalur local → production otomatis. Banner `LOCAL SANDBOX` di UI menjadi tanggung jawab tahap frontend berikutnya; source of truth teknis tetap guard runtime dan target loopback.

Untuk smoke full-stack production tanpa login atau mutasi:

```bash
E2E_BASE_URL=https://hopinops.vercel.app pnpm test:smoke
```

### Smoke operator lokal

Smoke operator tidak boleh diarahkan ke Vercel, staging, atau database remote.
Jalankan setelah `pnpm dev:local` hidup dan snapshot lokal selesai:

```bash
HOPIN_LOCAL_SMOKE_ACK=1 \
HOPIN_LOCAL_SMOKE_USERNAME=<username-snapshot> \
HOPIN_LOCAL_SMOKE_PIN=<pin-6-digit> \
E2E_BASE_URL=http://localhost:3000 \
pnpm test:operator:local
```

Runner menguji health, picker/PIN rail mobile, error login yang sudah disanitasi,
bootstrap, katalog, satuan, kelompok checklist, session, opening, autosave,
movement + replay idempoten, handover/closing, report read, logout, dan
attendance bila akun belum memiliki attendance hari ini. Data mutasi hanya masuk
ke Supabase lokal. Bila dua akun operator disediakan lewat
`HOPIN_LOCAL_SMOKE_SECOND_USERNAME` dan `HOPIN_LOCAL_SMOKE_SECOND_PIN`, runner
juga menguji closing Bar + Kitchen dan submit finance dua area. PIN tidak pernah
ditulis ke output.

`pnpm ops:verify` menjalankan gate kode dan smoke read-only secara berurutan.
Tambahkan `-- --operator` untuk menjalankan smoke lokal mutatif setelah server
local aktif; tambahkan `-- --sync-local` bersama `HOPIN_FULL_CLONE_ACK=1` bila
ingin refresh snapshot terlebih dahulu. Script ini tidak melakukan commit atau
push otomatis.

Lint, unit test, build, dan smoke read-only tetap tersedia. Job CI database dihapus. Runner database, concurrency, provisioning/teardown staging, dan E2E mutating dinonaktifkan; environment opt-in lama tidak mengaktifkannya kembali. SQL test dan source E2E lama disimpan sebagai referensi dan tidak boleh dijalankan langsung pada production.

### Migration dan validasi operasional

Migration SQL yang dibutuhkan harus ditinjau dan diterapkan ke production sebelum aplikasi yang bergantung padanya di-deploy. Hindari perubahan schema yang langsung memutus aplikasi versi lama. Jangan memakai database reset, seed test, atau test SQL mutating sebagai bagian deployment.

Smoke authenticated untuk mengubah atau membatalkan roster memerlukan akun dan roster test yang telah disetujui. Smoke otomatis default tidak login, tidak mengirim PIN, dan tidak membuat fixture.

Catatan staging di bawah adalah hasil historis sebelum konsolidasi, bukan petunjuk menjalankan test saat ini.

## Verifikasi staging (2026-09-05)

- Migration `0001`–`0018` diterapkan pada staging Supabase disposable (`hopinops-staging`, `ibzlxdmnuszcmdzuocwu`, Singapore) dan **pgTAP 18/18 lulus**.
- Gates terakhir: `pnpm lint`, `pnpm test` (20/20), `pnpm build`, authenticated `pnpm test:e2e` (16/16 desktop/mobile), dan `git diff --check` — semua lulus.
- Production `https://hopinops.vercel.app` sudah sinkron pada migration `0001`–`0018` dan smoke live lulus. Restore drill, pilot operasional, dan observability Cron pertama tetap tercatat sebagai tindak lanjut di `ACTION_LOG.md`.

## Environment variables (server-side saja)

| Variabel | Wajib | Keterangan |
|---|---|---|
| `SUPABASE_URL` | Ya | Dipakai `api/auth.ts`, `api/app.ts`, `api/readiness.ts` |
| `SUPABASE_SERVICE_ROLE_KEY` | Ya | Server-only. Simpan sebagai Secret di Vercel; jangan pernah di-`VITE_`, di-commit, atau dibagikan |
| `APP_ALLOWED_ORIGIN` | Ya di production | Exact origin aplikasi production; bukan wildcard |
| `PAYROLL_EXPORT_BUCKET` | Ya di production | Bucket privat `payroll-exports` dari migration `0013` |
| `READINESS_SECRET` | Ya bila readiness probe dipakai | Melindungi `/api/readiness` |
| `CRON_SECRET` | Ya di production | Melindungi endpoint cron/retensi Vercel |
| `HOPIN_PROD_DB_URL` | Ya untuk sync lokal | Connection string database production read-only; hanya dipakai sesaat oleh snapshot runner |
| `HOPIN_LOCAL_DB_URL` | Opsional | Override connection string Supabase lokal; default `127.0.0.1:54322` |
| `HOPIN_LOCAL_SUPABASE_URL` | Opsional | Override API Supabase lokal; default `http://127.0.0.1:54321` |
| `HOPIN_LOCAL_SERVICE_ROLE_KEY` | Opsional | Fallback key lokal bila tidak tersedia dari `supabase status -o env` |
| `HOPIN_RUNTIME` | Diatur otomatis | `local` wajib memakai Supabase loopback; jangan set `local` pada deployment production |

Browser tidak membutuhkan variabel environment apa pun: tidak ada key Supabase di bundle klien.

## Ringkasan keamanan

- **Security headers** (`vercel.json`): CSP ketat (`default-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS, COOP/CORP, `Permissions-Policy` dengan `geolocation=(self)`.
- **Login atomik**: issuance session, binding device, reset lockout, dan audit sukses dilakukan dalam satu transaksi `rpc_issue_login_session` (migration `0014`) — tanpa partial write.
- **Lockout PIN 3x/60 detik server-authoritative** (migration `0011`): dihitung server per credential, IP hash, dan device hash; refresh browser tidak menghapus lock; frontend hanya menampilkan countdown dari `Retry-After`/`blocked_until` server; error publik generik.
- **Attendance terikat perangkat**: challenge sekali pakai harus dibuktikan dengan device cookie dari login; tanpa device proof, check-in/check-out ditolak (wajib re-login).
- **Tidak ada paparan GPS mentah**: koordinat mentah hanya tersimpan server-side dengan retensi `raw_gps_retention_days`; klien, laporan, sheet payroll, log, dan audit hanya menerima evidence turunan (status geofence/akurasi).

## Status rollout

Backup segar, migration parity, deployment, dan smoke live telah selesai pada 5 September 2026. Restore drill, pilot operasional, dan observability Cron pertama masih diperlukan sebelum menyatakan operasional penuh.
