# HOPIN Stock Operations — Aplikasi Produksi Server-First

Aplikasi operasional stok HOPIN: SPA React/Vite yang hanya berkomunikasi dengan API serverless di `/api/*`, dengan Supabase PostgreSQL sebagai satu-satunya sumber kebenaran. Seluruh mutasi operasional berjalan lewat transactional RPC di server (migrations `0001`–`0014`) — tidak ada penyimpanan data operasional di browser, tidak ada mode demo lokal.

## Arsitektur

- **Frontend**: React 19 + Vite SPA (`src/`). Browser tidak memakai kredensial database; semua request operasional lewat `/api/*` dengan session cookie.
- **Backend**: Vercel serverless (`api/`): `auth.ts` (login/session), `app.ts` (business commands via RPC), `health.ts` (liveness), `readiness.ts` (dependency check, dilindungi secret).
- **Database**: Supabase PostgreSQL. Skema, RLS, RPC komando, audit, storage `payroll-exports`, dan retention ada di `supabase/migrations/0001`–`0014`.

## Perintah

```bash
pnpm install
pnpm lint        # tsc --noEmit
pnpm test        # vitest
pnpm build       # vite build
pnpm test:e2e    # playwright
pnpm test:db     # supabase db reset + pgTAP — BUTUH DOCKER berjalan
```

`pnpm dev` hanya menjalankan UI Vite; endpoint `/api/*` berjalan penuh saat project dijalankan oleh Vercel (production/preview).

## Verifikasi staging (2026-09-04)

- Migration `0001`–`0014` diterapkan dari nol pada staging Supabase disposable (`hopinops-staging`, `ibzlxdmnuszcmdzuocwu`, Singapore) dan **pgTAP 17/17 lulus**.
- Gates terakhir di branch ini: `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:e2e` (10 passed), `git diff --check` — semua lulus.
- Production belum menerima migration remediation; rollout hanya setelah seluruh gate fase lulus. Detail: `REMEDIATION_IMPLEMENTATION_PLAN_PART_2.md`, `EXECUTION_REPORT.md`.

## Environment variables (server-side saja)

| Variabel | Wajib | Keterangan |
|---|---|---|
| `SUPABASE_URL` | Ya | Dipakai `api/auth.ts`, `api/app.ts`, `api/readiness.ts` |
| `SUPABASE_SERVICE_ROLE_KEY` | Ya | Server-only. Simpan sebagai Secret di Vercel; jangan pernah di-`VITE_`, di-commit, atau dibagikan |
| `PAYROLL_EXPORT_BUCKET` | Opsional | Default `payroll-exports` (bucket privat dari migration `0013`) |
| `READINESS_SECRET` atau `CRON_SECRET` | Opsional | Melindungi `/api/readiness` dan endpoint cron/retensi |

Browser tidak membutuhkan variabel environment apa pun: tidak ada key Supabase di bundle klien.

## Ringkasan keamanan

- **Security headers** (`vercel.json`): CSP ketat (`default-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS, COOP/CORP, `Permissions-Policy` dengan `geolocation=(self)`.
- **Login atomik**: issuance session, binding device, reset lockout, dan audit sukses dilakukan dalam satu transaksi `rpc_issue_login_session` (migration `0014`) — tanpa partial write.
- **Lockout PIN 3x/60 detik server-authoritative** (migration `0011`): dihitung server per credential, IP hash, dan device hash; refresh browser tidak menghapus lock; frontend hanya menampilkan countdown dari `Retry-After`/`blocked_until` server; error publik generik.
- **Attendance terikat perangkat**: challenge sekali pakai harus dibuktikan dengan device cookie dari login; tanpa device proof, check-in/check-out ditolak (wajib re-login).
- **Tidak ada paparan GPS mentah**: koordinat mentah hanya tersimpan server-side dengan retensi `raw_gps_retention_days`; klien, laporan, sheet payroll, log, dan audit hanya menerima evidence turunan (status geofence/akurasi).

## Batasan saat ini

Fase 6–7 (app shell + onboarding interaktif) dan rekonsiliasi penuh `PRODUCTION_PLAN.md` masih berjalan. Jangan mengklaim production-ready sebelum Final Release Gate di `REMEDIATION_IMPLEMENTATION_PLAN_PART_2.md` lulus.
