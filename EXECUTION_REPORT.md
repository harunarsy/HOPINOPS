# HOPIN Remediation Execution Report — Part 2

Tanggal: 4 September 2026
Branch: `remediation/part2`
Status: **PHASE 0-1 VERIFIED; PHASE 2/3/4/9 CODE-IMPLEMENTED; DB MIGRATIONS 0010/0011 NOT VERIFIED (Docker absent); PRODUCTION NOT DEPLOYED**

## What is verified (ran gates: lint, unit, build, e2e)
- Phase 0: production backup, migration parity (0001-0009), 1 stuck cycle inventoried, PAYROLL_EXPORT_BUCKET missing.
- Phase 1: Playwright harness; `pnpm test:e2e` 10 passed.
- All current code compiles/lints and unit tests 18/18; build OK; git diff --check OK.

## Phase 2 — Stock initialization & variance policy
- Wrote `supabase/migrations/0010_stock_reference_initialization.sql`:
  - zero-baseline initialization tables; `rpc_initialize_stock_reference`, `rpc_get_opening_reference`;
  - `rpc_confirm_opening` + MALAM prior-closing fallback + initialization; variance category-required/notes-optional;
  - `rpc_confirm_closing` variance category-required/notes-optional.
- Updated pgTAP `supabase/tests/database.test.sql` (added function signatures + operational tables).
- NOT applied; NOT `test:db`-verified (no Docker).

## Phase 3 — Opening/Closing UX
- `StockWorkspace.tsx`: per-item `Sesuai`/`0`, bulk "samakan semua dengan patokan", `INITIAL_STOCK_COUNT` category, notes optional, blank = uncounted (no fake system default).
- Verified via lint + build.

## Phase 4 — Lockout 3x/60s (server-authoritative)
- Wrote `supabase/migrations/0011_auth_lockout_3x_60s.sql` (RPC threshold 3, lock 60s).
- `api/auth.ts` returns 429 + Retry-After when locked; `AuthLimitResult` carries `retry_after_seconds`.
- `src/lib/api.ts` reads `Retry-After`.
- `src/features/auth/Login.tsx` consumes server `lockoutSeconds`; removed client-only 3x counter; added double-submit guard.
- `src/App.tsx` holds `loginLockSeconds` countdown derived from server.
- Migration NOT applied/NOT DB-verified.

## Phase 9 — Security headers
- `api/health.ts` no-store; `jsonResponse` (auth + app) nosniff + referrer-policy; `vercel.json` CSP/frame/permissions headers.
- Applied at code level (deploy NOT performed).

## Gates (this session)
- lint: PASS
- test: 18/18 PASS
- build: PASS
- e2e: 10 PASS
- diff --check: PASS
- test:db: BLOCKED (Docker absent) — pgTAP updated, ready to run

## Release blockers
1. test:db not executable locally (Docker). DB migrations 0010/0011 unverified.
2. Staging Supabase not provisioned.
3. Production still `92b51d8`; branch changes NOT deployed.
4. Remaining phases (5-8, 10) not yet started.
