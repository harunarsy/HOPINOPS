# HOPIN Stock Operations — Aplikasi Produksi Server-First

Aplikasi operasional stok HOPIN: SPA React/Vite yang hanya berkomunikasi dengan API serverless di `/api/*`, dengan Supabase PostgreSQL sebagai satu-satunya sumber kebenaran. Seluruh mutasi operasional berjalan lewat transactional RPC di server (migrations `0001`–`0018`) — tidak ada penyimpanan data operasional di browser, tidak ada mode demo lokal.

## Arsitektur

- **Frontend**: React 19 + Vite SPA (`src/`). Browser tidak memakai kredensial database; semua request operasional lewat `/api/*` dengan session cookie.
- **Backend**: Vercel serverless (`api/`): `auth.ts` (login/session), `app.ts` (business commands via RPC), `health.ts` (liveness), `readiness.ts` (dependency check, dilindungi secret).
- **Database**: Supabase PostgreSQL. Skema, RLS, RPC komando, audit, storage `payroll-exports`, dan retention ada di `supabase/migrations/0001`–`0018`.

## Perintah

```bash
pnpm install
pnpm dev         # UI Vite saja
pnpm dev:full    # UI + /api lewat Vercel Dev, memakai hosted Supabase
pnpm lint        # tsc --noEmit
pnpm test        # vitest
pnpm build       # vite build
pnpm test:smoke  # smoke UI read-only desktop/mobile, tanpa login
pnpm test:e2e    # alias smoke read-only
```

`pnpm dev` hanya menjalankan UI Vite. Gunakan `pnpm dev:full` untuk menjalankan endpoint `/api/*` secara lokal melalui Vercel Dev. Keduanya tidak membutuhkan Docker; backend data tetap memakai hosted Supabase.

Jika halaman lokal menampilkan pesan server tidak terjangkau saat login, jalankan `pnpm dev:full` (bukan `pnpm dev`) lalu buka ulang origin yang sama, biasanya `http://localhost:3000`.

### Satu database production (9 September 2026)

Local full-stack dan Vercel `hopinops` menggunakan Supabase production `naanarmoktmsumkxmjvj`. Perubahan data dari aplikasi lokal juga mengubah data production. `.env.local` memakai kredensial server-only project tersebut, origin localhost, serta secret readiness/cron khusus lokal; file ini tidak boleh di-commit.

Untuk smoke full-stack production tanpa login atau mutasi:

```bash
E2E_BASE_URL=https://hopinops.vercel.app pnpm test:smoke
```

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

Browser tidak membutuhkan variabel environment apa pun: tidak ada key Supabase di bundle klien.

## Ringkasan keamanan

- **Security headers** (`vercel.json`): CSP ketat (`default-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS, COOP/CORP, `Permissions-Policy` dengan `geolocation=(self)`.
- **Login atomik**: issuance session, binding device, reset lockout, dan audit sukses dilakukan dalam satu transaksi `rpc_issue_login_session` (migration `0014`) — tanpa partial write.
- **Lockout PIN 3x/60 detik server-authoritative** (migration `0011`): dihitung server per credential, IP hash, dan device hash; refresh browser tidak menghapus lock; frontend hanya menampilkan countdown dari `Retry-After`/`blocked_until` server; error publik generik.
- **Attendance terikat perangkat**: challenge sekali pakai harus dibuktikan dengan device cookie dari login; tanpa device proof, check-in/check-out ditolak (wajib re-login).
- **Tidak ada paparan GPS mentah**: koordinat mentah hanya tersimpan server-side dengan retensi `raw_gps_retention_days`; klien, laporan, sheet payroll, log, dan audit hanya menerima evidence turunan (status geofence/akurasi).

## Status rollout

Backup segar, migration parity, deployment, dan smoke live telah selesai pada 5 September 2026. Restore drill, pilot operasional, dan observability Cron pertama masih diperlukan sebelum menyatakan operasional penuh.
