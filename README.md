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
pnpm test:e2e    # lifecycle staging disposable: provision → Playwright → teardown
pnpm test:db     # pgTAP + SQL regression pada hosted DB test disposable
pnpm test:db:fresh # push migration + seluruh DB test pada hosted DB test disposable
```

`pnpm dev` hanya menjalankan UI Vite. Gunakan `pnpm dev:full` untuk menjalankan endpoint `/api/*` secara lokal melalui Vercel Dev. Keduanya tidak membutuhkan Docker; backend data tetap memakai hosted Supabase.

### Database test tanpa Docker

Database test wajib memakai project Supabase terpisah yang disposable. Production `naanarmoktmsumkxmjvj` dan staging aplikasi `ibzlxdmnuszcmdzuocwu` ditolak oleh runner, termasuk bila project ref disamarkan lewat connection string.

Set environment berikut hanya pada shell atau secret manager, jangan commit nilainya:

```bash
DB_TEST_PROJECT_REF=<project-test-khusus>
DB_TEST_DATABASE_URL=<postgres-connection-string-project-test>
DB_TEST_DISPOSABLE=1
```

`pnpm test:db` menjalankan pgTAP dan regression SQL transactional. `pnpm test:db:fresh` terlebih dahulu mendorong seluruh migration yang belum ada. Laptop hanya membutuhkan `psql` dan koneksi internet, bukan Docker atau PostgreSQL server lokal. CI database dapat diaktifkan dengan repository variable `DB_TEST_ENABLED=1`, variable `DB_TEST_PROJECT_REF`, dan secret `DB_TEST_DATABASE_URL` setelah project test khusus dibuat.

### E2E mutating staging

Mutating E2E tidak pernah boleh menarget production atau origin remote. Browser wajib menuju root `http://127.0.0.1:<port>` atau `http://localhost:<port>` dari `vercel dev` yang dikonfigurasi dengan environment staging `ibzlxdmnuszcmdzuocwu`; Vite preview tidak menyediakan endpoint `/api/*`.

1. CLI `vercel` sudah menjadi dev dependency. Runner memakai `vercel dev --local`, jadi tidak menarik environment atau memilih project Vercel remote.
2. Set hanya secret server-side staging yang diperlukan (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, dan `E2E_FIXTURE_PIN`), serta `E2E_MUTATIONS=1` dan `E2E_STAGING_PROJECT_REF=ibzlxdmnuszcmdzuocwu`. Runner memverifikasi host Supabase tepat ke staging sebelum provisioning.
3. Jalankan `pnpm test:e2e`. Runner menyalakan `vercel dev` hanya di `127.0.0.1`, menunggu `/api/health`, membuat run ID acak dan fixture disposable, menjalankan Playwright, lalu selalu teardown serta menghentikan server. `E2E_RUN_ID`, `E2E_PORT`, dan `E2E_BASE_URL` hanya untuk investigasi lokal.

`E2E_FIXTURE_MANIFEST` dibuat di direktori temporary dengan permission owner-only. Provisioner menolak run ID, outlet, profile, atau manifest yang sudah ada. Sebelum satu write pun, teardown memastikan dua outlet, delapan profile, username, dan scope aktif benar-benar milik run disposable tersebut. Bila teardown gagal, manifest dipertahankan dan runner gagal agar cleanup dapat dilakukan dengan aman. Histori audit/cycle/attendance/stock tidak dihapus.

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
