# HOPIN Remediation Execution Report — Part 2

Tanggal: 4 September 2026
Branch: `remediation/part2`
Status: **PHASE 0-4 & 8-9 VERIFIED/IMPLEMENTED; STAGING PROVISIONED; PRODUCTION NOT DEPLOYED; PHASE 5/6/7/10 REMAINING**

## Database verification (staging, not production)
- Created disposable Supabase project `hopinops-staging` (`ibzlxdmnuszcmdzuocwu`, Singapore).
- Applied migrations `0001`-`0011` from scratch; **17/17 pgTAP assertions passed** via psql to staging pooler (Docker unavailable locally).
- Migration `0011` bug found & fixed: `v_scope_key` undeclared in `rpc_check_auth_limits`.
- CLI `supabase` is currently linked to staging. Production untouched.

## Implemented & gated (lint/test/build/e2e)
- Phase 2: `0010` stock reference initialization + variance policy (category-required, notes-optional).
- Phase 3: Opening/Closing UX quick actions (`Sesuai`/`0`, bulk match), `INITIAL_STOCK_COUNT`, optional notes.
- Phase 4: `0011` server-authoritative lockout 3x/60s; login returns 429+Retry-After; frontend uses server lockout; double-submit guard.
- Phase 8: payroll XLSX 7-sheet export (Summary, Adjustments, Exceptions, Attendance, Overtime, Bonus, Audit).
- Phase 9: health no-store; API nosniff/referrer headers; vercel.json security headers.

## Gates
- lint PASS, unit 18/18 PASS, build PASS, e2e 10 PASS, pgTAP 17/17 (staging), diff --check PASS.

## Remaining
- Phase 5 (~25 API actions), Phase 6/7 (UX shell + interactive onboarding), Phase 10 (full doc reconciliation).
- Apply `0010`/`0011` to production only after remaining UI/API phases pass staging review.

## Note
- To target production again: `supabase link --project-ref naanarmoktmsumkxmjvj`.
