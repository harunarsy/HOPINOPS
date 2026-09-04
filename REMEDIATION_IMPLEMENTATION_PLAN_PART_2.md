# HOPIN Production Remediation Implementation Plan Part 2

## 1. Document Status

- Repository: `/Users/harunalrasyid/Projects/HOPIN/webapp`
- Production: `https://hopinops.vercel.app`
- GitHub: `https://github.com/harunarsy/HOPINOPS.git`
- Supabase project ref: `naanarmoktmsumkxmjvj`
- Current production migrations: `0001` through `0009`
- Current known Git HEAD at plan time: `92b51d8`
- Status: **PRODUCTION ACTIVE, FUNCTIONALLY INCOMPLETE, REMEDIATION REQUIRED**

This document does not replace `PRODUCTION_PLAN.md`. It records current production reality, authorized product decisions that supersede two older rules, remaining defects, implementation sequence, acceptance criteria, and release gates.

The HEAD and production observations above are a point-in-time snapshot. The next executor must re-record HEAD, migration state, deployment state, and worktree before doing any work. If they differ, update the evidence and reassess affected findings instead of assuming this snapshot is current.

### Execution status note (2026-09-04)

Work continues on branch `remediation/part2`. Verified so far:

- Phase 0-1 done (backup + Playwright harness; `pnpm test:e2e` 10 passed).
- Phase 2 migration `0010` and Phase 4 migration `0011` **applied from scratch and pgTAP-verified on a disposable Supabase staging project** (`ibzlxdmnuszcmdzuocwu`, link is currently pointed there). Fix: `v_scope_key` declared in `rpc_check_auth_limits`.
- Phase 3 (opening/closing UX) and Phase 8 (7-sheet payroll XLSX) code implemented and gated (lint/test/build pass).
- Phase 9 security headers implemented (health no-store; API nosniff/referrer; `vercel.json` CSP).

Remaining: Phase 5 (extend API action inventory), Phase 6-7 (UX architecture + interactive onboarding), Phase 10 (full documentation reconciliation). Migrations `0010`/`0011` are NOT yet applied to production.

## 2. Execution Rules

1. Do not edit migrations `0001` through `0009`. They are already applied to production.
2. All new database work starts at migration `0010`.
3. Do not hotfix directly to production without Preview and tests.
4. Do not push to `main` until the relevant phase gates pass.
5. Do not use the production database for integration tests that create data.
6. Use local Supabase or a disposable staging/Supabase branch.
7. Every mutating API must use a transactional RPC.
8. Audit events must be written in the same transaction as the mutation.
9. Do not add raw-DML fallbacks if an RPC is missing or fails.
10. Do not treat lint, unit tests, or frontend build as proof that SQL, privileges, or migrations are correct.
11. Do not auto-heal, transfer, or rewrite device/session identity during ordinary business requests.
12. Do not fabricate evidence, including auto-generated variance notes attributed to operators.
13. Preserve unrelated worktree changes.
14. Update `ACTION_LOG.md` per phase: `PENDING -> ACTIVE -> VERIFIED`.
15. Update `EXECUTION_REPORT.md` only with evidence that was actually run.
16. Start with Phase 0 and Phase 1. Do not write `0010` or deploy until preflight, backup, staging, and test harness exist.

## 3. Authorized Product Decisions

These two decisions override older `PRODUCTION_PLAN.md` rules. Implementers must also update `PRODUCTION_PLAN.md` in Phase 10 so the two documents stay aligned.

### 3.1 PIN Lockout

Final decision:

```text
3 failed PIN attempts
-> lock for 60 seconds
-> counted and enforced server-side
-> applies to credential, IP hash, and device hash
```

Rules:

- Browser refresh must not clear the lock.
- Frontend countdown comes from server `blocked_until` or `retry_after_seconds`.
- Public errors remain generic and must not reveal whether the username exists.
- Three concurrent failed requests must still produce one correct lock.
- Successful login resets the credential counter. IP/device abuse windows must follow an explicit server policy and must not be blindly cleared in a way that lets a successful account bypass shared-scope throttling.
- Frontend must not keep an independent security counter.

This replaces the old rule `5 failures -> 15 minutes`.

### 3.2 Stock Variance

Final decision:

```text
If physical count differs from system/reference:
- reason category is required
- notes/detail are optional for every category, including OTHER
```

Rules:

- Applies to opening and closing.
- The system must never auto-fill notes.
- If the operator types notes, store them as extra evidence.
- If there is no variance, reason and notes are not required.
- The database must still reject variance without a reason category.

This replaces the old rule that required both `reason_code` and `notes`.

### 3.3 Physical Count Attestation

Displayed system quantity must never silently become a physical count.

Required UX:

- Per-item explicit actions: `Sesuai`, `0`, `Ubah jumlah`.
- Bulk attestation: `Saya sudah menghitung semua; hasil fisik sesuai patokan`, with confirmation.
- Blank remains uncounted until an explicit action.

## 4. Current Production Findings

### P0-1: First-run opening has no initialization path

`rpc_confirm_opening` currently accepts only:

- Same-day SIANG handover for MALAM opening.
- Prior closing for SIANG/FULL opening.

If the source is missing it raises:

```text
REFERENCE_NOT_FOUND: Snapshot referensi opening terkonfirmasi tidak ditemukan.
```

Evidence: `supabase/migrations/0008_commands_privileges_audit.sql:2711-2737`.

Product contract: `PRODUCTION_PLAN.md:651-653` requires a manager-approved initialization event when no source exists. That flow does not exist.

Impact:

- First-ever opening cannot be confirmed.
- Existing cycles can remain stuck in `ACTIVE`.
- Operators have no recovery action.

### P0-2: MALAM opening does not fall back to prior closing

Contract: `PRODUCTION_PLAN.md:187`.

```text
MALAM -> same-day SIANG handover
if missing -> latest prior closing + warning
```

Current RPC fails immediately if handover is missing.

### P0-3: UI displays fake reference `0`

`src/features/stock/StockWorkspace.tsx:225-244` and `:620-623` convert missing opening/reference into `0` and label it `Patokan Sistem`.

The UI must distinguish:

- `REFERENCE_AVAILABLE`
- `REFERENCE_MISSING`
- `INITIALIZATION_REQUIRED`
- `HANDOVER_MISSING_USING_PRIOR_CLOSING`

Never display `0` as a system baseline when the server has no source.

### P0-4: Opening UX and audit evidence conflict

Current problems:

- Inputs visually show system values.
- State still treats untouched fields as uncounted.
- Operators must retype `0`.
- Auto-fill without attestation would turn system quantity into physical count.

Required solution: explicit attestation, not silent defaulting.

### P0-5: Device binding can be auto-healed by ordinary requests

`api/app.ts:138-170` can create devices, transfer `profile_id`, and rewrite `session.device_id`. If the device cookie is missing it still accepts `session.device_id`.

`api/auth.ts:259-268` can transfer an existing device record to the newly logged-in profile.

Impact:

- Device binding is no longer a real control.
- Shared-browser logins rewrite historical device ownership.
- Attendance challenges can succeed without proving the current device cookie.

### P0-6: Frontend and backend PIN lockout disagree

Frontend: 3 failures -> 60 seconds, client-side, lost on refresh.

Backend: 5 failures -> 15 minutes.

Use the authorized decision in section 3.1. Server must be authoritative.

### P0-7: Required API inventory is incomplete

Missing or incomplete actions from `PRODUCTION_PLAN.md:515-608`:

| Domain | Missing actions |
|---|---|
| Auth | `sessions.list`, `sessions.revoke` |
| User | `users.update`, `users.deactivate` |
| Settings | `settings.get`, `settings.update` |
| Items | `items.archive` |
| Swap | `swap.cancel` |
| Assignment | `assignment.active`, `assignment.complete` |
| Attendance | `attendance.mine`, `attendance.exceptions` |
| Correction | `attendance.correction.request`, `attendance.correction.review` |
| Leave | `leave.request`, `leave.cancel`, `leave.review` |
| Overtime | `overtime.list`, `overtime.review` |
| Checkout | emergency checkout + `PENDING_TASKS` |
| Stock | `opening.saveDraft`, `closing.saveDraft`, `movement.correct`, initialization |
| Report | `report.get`, `report.list`, `report.finance.save`, `report.share` |
| Bonus | `bonus.preview` |
| Payroll | `payroll.entry.adjust`, evidence/blocker detail, authorized download |
| Onboarding | `onboarding.get`, `onboarding.replay` |

### P0-8: Some critical mutations are still raw DML

Examples:

- `items.create/update`: `api/app.ts:512-555`
- `roster.save`: `api/app.ts:571-604`
- `onboarding.complete`: `api/app.ts:1219-1235`
- Login session/device creation and success audit in `api/auth.ts`

Mutation and audit are not always atomic. `logAudit()` swallows errors.

### P0-9: Temporary PIN generation is unsafe

`api/app.ts:1255` still uses `Math.random()` and accepts client `initial_pin`.

Required:

- Server-only CSPRNG.
- Weak PIN denylist.
- Do not accept PIN from the browser.
- Return the temporary PIN once after RPC success.

### P0-10: Payroll XLSX does not match specification

Current workbook has Summary, Adjustments, Evidence.

Required sheets:

1. Summary
2. Attendance
3. Exceptions
4. Overtime
5. Bonus
6. Adjustments
7. Audit

Also missing:

- Private `payroll-exports` bucket migration.
- Authorized download endpoint.
- Signed URL max 5 minutes.
- Required headers, freeze, filter, format, and reconciliation tests.

### P0-11: Release gates have never fully passed

Required by `PRODUCTION_PLAN.md:920-931`:

```bash
pnpm lint
pnpm test
pnpm build
pnpm test:db
pnpm test:e2e
git diff --check
```

Current gaps:

- `test:db` has not passed because Docker/Podman was unavailable on the original machine.
- No Playwright / `test:e2e`.
- No separate staging Supabase.
- No backup/restore evidence.
- No two-device race tests.
- No first-day reconciliation.
- Migrations were applied directly to production.

### P0-12: Request validation and public error handling are not strict

Most business actions call `request.json() as any` directly. There is no central action registry enforcing content type, maximum body size, exact allowed keys, string limits, numeric bounds, or required idempotency/version fields for every mutation.

`rpcErrorResponse()` can return raw PostgreSQL/PostgREST messages to the browser. Public responses must use stable domain messages while full dependency details stay in protected server logs with a request ID.

Required:

- Central request parser with JSON content-type and body-size limits.
- Per-action exact schemas that reject unknown fields.
- Stable public errors and HTTP mapping.
- Request ID propagated to audit and logs.
- No secret, SQL detail, raw GPS, PIN material, or internal schema text in public errors.

### P1: Runtime security, privacy operations, and observability are incomplete

Current production evidence shows HSTS, but no verified CSP, `frame-ancestors`, `nosniff`, referrer policy, or geolocation permissions policy. The root response currently includes wildcard CORS and `/api/health` is publicly cacheable. `vercel.json` only declares the Vite framework.

Also missing:

- Secret-protected `/api/readiness` dependency check.
- Expired session/challenge/rate-limit cleanup.
- Raw GPS retention cleanup and audit.
- Metrics/alerts for API failures, auth lockouts, conflicts, missing checkout, report blockers, and payroll blockers.
- Maintenance-mode behavior and operational runbook.
- Complete environment documentation. Production environment inspection did not show `PAYROLL_EXPORT_BUCKET`.
- Owner-managed, versioned settings flow. Migration `0009` hardcodes the geofence coordinate without a normal settings audit/version workflow.

### P1 findings that must not be ignored

- `roster.list` returns the whole outlet roster to every authenticated user.
- `items.list` returns all active items to every role, including investor.
- `items.update` allows SUPERVISOR; plan says owner-only.
- Report UI is local finance state, not a server-backed draft/revision.
- Management is a status viewer, not an exception/action center.
- Onboarding is five text pages; completion still proceeds in `finally` after API failure.
- Bootstrap errors fail open to empty assignment/onboarding/outlet.
- Native `alert`/`confirm` remain.
- Dialogs lack accessible semantics.
- `ACTION_LOG.md`, `EXECUTION_REPORT.md`, `README.md`, and `UX-CONTRACT.md` contradict current production.

## 5. Phase 0: Stabilization and Preflight

### Goal

Freeze production hotfixes and create a safe remediation environment.

### Tasks

1. Create a remediation branch. Do not continue patching `main` directly.
2. Record branch, HEAD, remote tracking, and worktree.
3. Take a production Supabase backup.
4. Record row counts for operational tables without credential data.
5. Record active cycles, assignments, attendance, openings, handovers, and closings.
6. Identify cycles stuck after `REFERENCE_NOT_FOUND`.
7. Provision local Supabase or a disposable staging branch.
8. Confirm migration history `0001-0009` on production and staging.
9. Verify Vercel environment variables exist without printing secrets.
10. Do not mutate production in this phase.
11. Record whether `PAYROLL_EXPORT_BUCKET` exists and is private; do not create it in production during preflight.
12. Record current security headers, readiness behavior, retention jobs, and monitoring without changing them.

### Acceptance

- Backup exists.
- Staging/disposable DB exists.
- Production data preflight is documented.
- No migration drift.
- Stuck cycles are listed.

### Stop

Stop if backup cannot be taken or production has unexpected schema drift.

## 6. Phase 1: Test Harness Before Domain Changes

### Target files

- `package.json`
- `playwright.config.ts`
- `tests/e2e/*`
- `supabase/tests/*`
- supporting fixtures

### Tasks

1. Make `pnpm test:db` run a fresh `supabase db reset` plus pgTAP/integration assertions.
2. Add Playwright and `pnpm test:e2e`.
3. Add reusable fixtures for OWNER, SUPERVISOR, OPERATOR, INVESTOR.
4. Add deterministic WIB clock fixtures.
5. Cover mobile `360x800` and desktop viewports.
6. Keep test data off production.

### Minimum initial tests

- Login page loads.
- Generic failed login.
- Role route guards.
- Current migration signatures and grants.
- Opening missing-reference behavior.
- Browser roles have no direct table access.
- Unauthenticated API smoke.

### Acceptance

```bash
pnpm lint
pnpm test
pnpm build
pnpm test:db
pnpm test:e2e
git diff --check
```

All pass on disposable environment.

### Stop

Do not start `0010` until `test:db` can actually execute.

## 7. Phase 2: Migration 0010 — Stock Initialization and Variance Policy

### New file

`supabase/migrations/0010_stock_reference_initialization.sql`

### Schema

Immutable initialization aggregate:

```text
stock_reference_initializations
- id
- outlet_id
- area_code
- work_date
- cycle_id
- reason
- approved_by
- approved_at
- idempotency_key unique
- status
```

```text
stock_reference_initialization_lines
- initialization_id
- item_id
- baseline_qty
```

Constraints:

- One initialization per cycle.
- Every initialization baseline quantity is exactly zero. The server generates these lines; clients cannot supply arbitrary baseline quantities.
- Exactly one line for every active item in the cycle area.
- Initialization append-only.
- OWNER/SUPERVISOR only.
- Browser roles have no direct access.
- Audit in the same transaction.

### RPCs

```text
rpc_get_opening_reference(cycle_id, actor_id)
```

Return:

```json
{
  "state": "AVAILABLE | INITIALIZATION_REQUIRED",
  "source_type": "HANDOVER | CLOSING | INITIALIZATION | null",
  "source_id": "uuid | null",
  "warning_code": "HANDOVER_MISSING_USING_PRIOR_CLOSING | null",
  "lines": []
}
```

```text
rpc_initialize_stock_reference(
  cycle_id,
  actor_id,
  expected_cycle_version,
  idempotency_key,
  reason
)
```

This manager-only RPC creates an immutable, approved zero-reference event for every active item in the cycle area. It does not silently confirm the operator's physical opening. After initialization, Primary/Manager confirms physical counts through `rpc_confirm_opening`.

### Reference rules

| Shift | Primary source | Fallback | Last resort |
|---|---|---|---|
| SIANG | Latest prior closing, same outlet/area | None | Manager initialization |
| FULL | Latest prior closing, same outlet/area | None | Manager initialization |
| MALAM | Same-day SIANG handover, same area | Latest prior closing + warning | Manager initialization |

### Update `rpc_confirm_opening` via `CREATE OR REPLACE` in 0010

- Server selects reference. Ignore client `reference_qty`.
- Variance requires `reason_code`.
- `notes` nullable.
- Return source type, source ID, warning, and cycle version.
- Existing stuck `ACTIVE` cycles must be recoverable.
- An INITIALIZATION source always contributes reference quantity zero. A nonzero first physical count is a variance and therefore requires a category under the authorized policy.
- Add a dedicated `INITIAL_STOCK_COUNT` reason category that is valid only when the selected source is `INITIALIZATION`. Do not force first-run stock to use unrelated categories such as counting error or spillage.

### Update `rpc_confirm_closing` via `CREATE OR REPLACE` in 0010

- Variance requires `reason_code`.
- `notes` nullable.
- Do not auto-fill notes.

### DB tests

- First-ever SIANG requires manager initialization.
- First-ever FULL requires initialization.
- MALAM uses SIANG handover.
- MALAM falls back to prior closing with warning.
- MALAM requires initialization if both sources are missing.
- OPERATOR cannot initialize.
- HELPER cannot confirm.
- Variance without category is rejected.
- Variance with category and no notes is accepted.
- No variance accepts null category and notes.
- Initialization is immutable.
- Duplicate identical idempotency returns the original result.
- Client cannot initialize an arbitrary nonzero baseline.
- Initialization success followed by delayed opening confirmation remains a valid recoverable state.

### Production recovery for existing stuck cycles

Do not backfill initialization rows automatically in a data migration because approval is a business act. After `0010` is deployed through the approved rollout:

1. List affected `ACTIVE` cycles in a manager recovery screen.
2. Require OWNER/SUPERVISOR to review area/date/items and provide an initialization reason.
3. Create the zero-reference event through `rpc_initialize_stock_reference`.
4. Let the assigned Primary or Manager enter and confirm physical counts.
5. Preserve the original assignment/cycle IDs and write audit events; do not delete/recreate stuck cycles.

## 8. Phase 3: Opening and Closing UX Rebuild

### Target files

- `src/features/stock/StockWorkspace.tsx`
- `src/lib/api.ts`
- new stock subcomponents
- stock component tests

### Reference state copy

Show one of:

```text
Referensi: Closing 2 September 2026
Referensi: Handover Shift Siang hari ini
Referensi fallback: Closing terakhir; handover Siang belum tersedia
Referensi belum tersedia; perlu inisialisasi Manager
```

### Count states

Each item: `UNCOUNTED | MATCHED | VARIANCE`.

### Quick actions

Per item: `Sesuai`, `0`, `Ubah jumlah`.

Bulk:

```text
Saya sudah menghitung semua; hasil fisik sesuai patokan
```

Bulk requires confirmation.

### Variance UI

- Required: category selector.
- Optional: additional notes, labeled `Catatan tambahan (opsional)`.
- Categories: `INITIAL_STOCK_COUNT` (initialization source only), `COUNTING_ERROR`, `SPILLAGE_UNRECORDED`, `WASTE_UNRECORDED`, `OVER_PORTIONING`, `OTHER`.

### Drafts

- Implement `opening.saveDraft` and `closing.saveDraft`.
- Helper can save drafts.
- Only Primary/Manager can confirm.
- Draft survives refresh and allowed offline behavior.
- UI shows saved, pending sync, conflict, and rejected.

### Acceptance

- Operators never retype displayed zero just to confirm.
- Blank never silently becomes a physical count.
- Missing reference never appears as zero.
- All categories work without notes.
- Closing uses the same contract.
- 360 px mobile has no accidental horizontal overflow.

## 9. Phase 4: Auth, Device, and Session Remediation

### Migration

`0011_auth_device_and_lockout.sql`

### PIN lockout RPC

```text
Threshold: 3
Lock duration: 60 seconds
Scopes: credential, IP hash, device hash
```

Return only a generic result:

```json
{
  "blocked": true,
  "retry_after_seconds": 60
}
```

Implement login verification, failure recording, lock evaluation, credential reset, device binding, session creation, and success audit with a transactionally safe design. At minimum, the check/failure path must not permit three concurrent requests to all pass a stale preflight. Prefer a single login-attempt RPC boundary where feasible; PIN hash verification may remain in the trusted server runtime only if the RPC reservation/finalization protocol is proven race-safe.

### Frontend login

- Remove client-authoritative `failedCount`.
- Auto-submit after the sixth digit with a single in-flight guard.
- On generic 401, clear all PIN boxes and focus the first input.
- On 429, use server `retry_after_seconds`.
- Keep the login button.
- Do not duplicate auto-submit after error/loading changes.

### Device rules

- Bind device only during login.
- `currentAuthContext` is validation-only.
- Never create or transfer a device during a normal business API request.
- Never accept `session.device_id` without a matching device cookie.
- Shared-browser profile switch rotates the device token or creates a separate binding.
- Do not transfer an existing user device record to another profile.
- Missing device proof requires re-login.

### Session actions

Implement `sessions.list` and `sessions.revoke`.

### Tests

- Three sequential failures lock one minute.
- Three concurrent failures lock one minute.
- Refresh cannot bypass lock.
- Unknown username has a generic response.
- Shared-browser user switch remains isolated.
- Missing device cookie blocks attendance.
- Re-login establishes a valid binding.
- Revoked device/session cannot attend.
- A successful login does not erase an unrelated/shared IP abuse window.

## 10. Phase 5: Transactional API Completion

### Priority A

- `settings.get/update`
- `items.archive`
- `users.update/deactivate`
- `swap.cancel`
- `assignment.active/complete`
- `movement.correct`

### Priority B

- `attendance.mine`
- `attendance.exceptions`
- `attendance.correction.request/review`
- `leave.request/cancel/review`
- `overtime.list/review`
- emergency checkout

### Priority C

- `report.get/list`
- `report.finance.save`
- `report.share`
- `bonus.preview`
- `payroll.entry.adjust`
- `onboarding.get/replay`

### Mutation contract

Every mutation must include, where applicable:

```text
idempotency_key
expected_version
strict enum validation
string/numeric bounds
actor/session/device validation
role/outlet/ownership authorization
transactional audit
stable error code
```

Replace raw DML for item changes, roster save, onboarding completion, login session/device creation, and successful-login audit.

### API boundary contract

Before adding more handlers, introduce one strict dispatcher boundary that provides:

- Known action and method registry.
- JSON content-type enforcement for mutation requests.
- Request body byte limit before parsing.
- Exact schema/unknown-key rejection per action.
- Request ID propagation.
- Stable public errors with protected internal logging.
- `Cache-Control: no-store` on auth and business responses.

## 11. Phase 6: Application Architecture and UX Rebuild

### Shared top-level states

```text
BOOTING
UNAUTHENTICATED
PIN_CHANGE_REQUIRED
ONBOARDING_REQUIRED
READY
SESSION_EXPIRED
SERVICE_UNAVAILABLE
CONFIGURATION_BLOCKED
```

Bootstrap failure must not look like “no assignment” or “no onboarding”.

### Operator navigation

```text
Hari Ini
Shift
Catatan Saya
Bantuan
```

### Manager navigation

```text
Ringkasan
Operasional
Jadwal
Kehadiran
Stok
Laporan
Payroll
Pengguna
Pengaturan
Audit
```

### Investor navigation

```text
Laporan
Detail Laporan
```

Investor must never see staff names, attendance, GPS, roster drafts, payroll, or PIN/session state.

### Shared components

`AppShell`, `MobileBottomNav`, `ManagerSidebar`, `PageHeader`, `InlineAlert`, `BlockerPanel`, `LoadingSkeleton`, `EmptyState`, `ErrorState`, `MutationReceipt`, `Dialog`, `ConfirmationDialog`, `BottomSheet`, `QuantityField`, `ReasonField`, `SyncCenter`, `ResponsiveDataView`.

### Accessibility

- Dialogs have semantics, focus trap, Escape, and restoration.
- Every label is associated with its control.
- Core attendance has a keyboard alternative.
- Critical errors remain visible until resolved.
- Toasts are not used for unresolved conflicts.

## 12. Phase 7: Onboarding Rebuild

Current five text pages are insufficient.

Required simulated journey:

1. Assignment and roster.
2. Check-in GPS explanation.
3. Primary versus Helper authority.
4. Opening physical count.
5. Movement and correction.
6. Handover or closing.
7. Offline queue and conflict.
8. Check-out and Help.

Rules:

- Simulation never writes production transactions.
- Completion writes only onboarding progress.
- Completion failure stays on the final screen.
- Provide retry, logout, and Help replay.
- Increment onboarding version when content changes.

## 13. Phase 8: Reports and Payroll Completion

### Reports

- Server-backed draft.
- Current revision retrieval.
- Bar/Kitchen readiness.
- Queue blockers.
- Finance save/version.
- Submission receipt.
- Review/clarification.
- Revision timeline.
- Server-generated WhatsApp share text.

### Payroll XLSX

Exactly seven sheets: Summary, Attendance, Exceptions, Overtime, Bonus, Adjustments, Audit.

### Storage

- Create private `payroll-exports` bucket via additive migration/config.
- Never expose public object paths.
- Add authorized download API.
- Signed URL TTL maximum five minutes.
- Persist checksum and row counts.

### XLSX tests

Exact sheet names, required columns, rupiah/date formats, freeze/filter, formula-injection protection, no raw GPS, totals equal snapshot, file checksum equals recorded checksum.

## 14. Phase 9: Runtime Security, Retention, and Operations

### Security headers

Configure and verify:

- Content Security Policy.
- `frame-ancestors` / clickjacking protection.
- `X-Content-Type-Options: nosniff`.
- Referrer policy.
- Permissions policy allowing geolocation only for same origin.
- Deliberate CORS behavior; do not rely on wildcard headers for credentialed APIs.

### Health and readiness

- `/api/health` remains a data-free liveness endpoint and is not misleadingly cached.
- Add secret-protected `/api/readiness` with a safe dependency query and no business data.

### Cleanup and retention

- Schedule and audit expired session cleanup.
- Schedule and audit expired attendance challenge/rate-limit cleanup.
- Delete raw GPS samples according to `raw_gps_retention_days` while preserving allowed derived evidence.
- Protect cron endpoints with `CRON_SECRET` or equivalent platform authentication.

### Observability

Capture request-ID-correlated metrics without sensitive payloads:

- API 4xx/5xx and latency.
- Auth failures and lockouts.
- Primary/version/idempotency conflicts.
- Unsynced queue count.
- GPS review status.
- Missing checkout and unresolved exceptions.
- Report/payroll blockers.
- Cleanup job results.

### Settings and geofence

- Implement owner-only, versioned `settings.get/update` with transactional audit.
- Treat migration `0009` as the current production bootstrap coordinate, not the permanent editing workflow.
- Validate coordinate/radius/accuracy ranges and expose masked/read-only settings to Supervisor as required.

### Acceptance

- Header assertions pass on root and API responses.
- Readiness success and dependency-failure behavior are tested.
- Retention jobs are idempotent and tested with deterministic timestamps.
- No logs/metrics contain raw PIN, token, IP, user agent, or GPS coordinates.
- Alert/runbook paths are documented.

## 15. Phase 10: Documentation Reconciliation

Update:

- `PRODUCTION_PLAN.md`
- `ACTION_LOG.md`
- `EXECUTION_REPORT.md`
- `README.md`
- `UX-CONTRACT.md`

Record:

- `3x / 60 seconds` lockout.
- Variance category required, notes optional.
- Server-first behavior instead of local demo.
- Mark `AUDIT_REMEDIATION_HANDOFF.md` historical.
- Accurate migration state.
- Do not claim production-ready before gates pass.

## 16. Final Release Gate

Required:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
pnpm test:db
pnpm test:e2e
pnpm audit --prod
git diff --check
```

Operational gates:

- Fresh DB reset passes.
- Upgrade path from `0001-0009` to `0010+` passes.
- Preview Vercel passes.
- OWNER, SUPERVISOR, OPERATOR, and INVESTOR smokes pass.
- Two-device race passes.
- Shared-device login passes.
- First-run opening passes.
- SIANG handover to MALAM opening passes.
- Offline replay and conflict pass.
- Report and payroll XLSX reconciliation pass.
- Backup restore drill passes.
- One-day pilot passes.

Production rollout is prohibited if any gate fails.

## 17. Definition of Done

Part 2 is complete only when:

- `REFERENCE_NOT_FOUND` has an explicit manager recovery path.
- Missing reference is never displayed as zero.
- Zero physical stock is easy to attest explicitly.
- Variance requires category and allows empty notes.
- PIN lockout is server-authoritative at 3 attempts / 60 seconds.
- Device binding cannot be auto-healed or transferred by business requests.
- Required action inventory exists.
- Critical mutations are transactional and audited.
- Reports use server-backed drafts and revisions.
- Payroll produces seven valid sheets and authorized downloads.
- Operator and manager journeys work at 360 px.
- Keyboard and dialog accessibility gates pass.
- Documentation matches production.
- Security headers, readiness, cleanup, retention, and minimum monitoring operate as documented.
- Production is promoted only after Preview, staging, DB tests, E2E, backup, and pilot evidence.

## 18. Immediate Next Step for the Next Agent

1. Read this file and `PRODUCTION_PLAN.md`.
2. Execute **Phase 0** then **Phase 1** only.
3. Do not write `0010`, change production data, or deploy until those phases are verified.
4. After Phase 1 gates pass, continue with Phase 2 stock initialization.
