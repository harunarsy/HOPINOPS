# HOPIN Stock Operations — UX Contract (Local Demo)

## Scope and trust boundary

This is a local-only operational prototype seeded from the v0.2 evidence. It has no backend, server timestamp, real cross-device authentication, IndexedDB queue, or production security. UI language must say `demo lokal` or `tersimpan di perangkat` where it matters and must not imply server persistence.

## Workflow contract

| Operation | Trigger | Pending | Success | Recovery |
| --- | --- | --- | --- | --- |
| Login demo | Submit sign-in form | Assignment selection | Workspace opens after shift/area confirmation | Inline form stays usable |
| Assignment | Shift + area confirmation | Confirmation dialog | Assignment locked for the date | Supervisor reset required in production |
| Confirm opening | Complete all physical counts | Missing values/reasons | Opening snapshot locked | Fix values/reasons |
| Edit closing | Numeric input | Immediate local state | LocalStorage updated by React effect | Refresh restores draft |
| Add movement | Save in modal after opening | Immediate local state | Append-only ledger row and quantity update | Re-open modal, retry |
| Submit report | Review & submit on night/full | Gate validation | `Terkirim ke supervisor` + timestamp | Fix missing values/reasons |
| Copy report | Copy button | Browser clipboard | Live status confirms | Text remains visible in preview |

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Form | Native HTML + React controlled state | `src/App.tsx` login, movement, closing | Login form; number input; variance fields | Keyboard submit, labels, typecheck, browser flow |
| Select/Listbox | Native HTML `select` | `MovementModal`, `StockRow` | Item, category, variance reason | Keyboard select and responsive browser flow |
| Search/filter | App-owned local derived view | `Closing` | Search input; four filter chips | Clear action, `aria-pressed`, empty state |
| Toast | App-owned live region | `showToast`, `.live-region` | Save, offline, validation, copy, submit | `role=status`, `aria-live=polite` |
| Dialog | App-owned movement modal | `MovementModal` | Movement entry only | Initial focus, Escape, focus loop, backdrop close |
| Scrollbar | Global CSS baseline | `src/index.css` | Page and horizontal tabs | Visible themed scrollbar |
| Table/list | App-owned responsive cards | Opening, movement, closing views | Read-only opening rows; ledger rows; stock cards | No horizontal scroll at 320–430px |

## Data integrity contract

- Bar and Kitchen are separate state branches.
- Active items must all have a closing value before submit can succeed.
- Status: `closing <= 0` is Habis; `closing <= low` is Hampir habis; above low is Aman.
- Variance uses `closing - (opening + incoming - outgoing)`.
- Assignment is one shift and area per user/date in the local demo. The selected assignment is restored after refresh and login; production must enforce this lock server-side.
- Opening counts, variance reasons, and notes persist as the opening record. Opening must be confirmed before any movement can be recorded, and the confirmed opening is the shift's immutable snapshot.
- Closing is available only to `MALAM` and `FULL`; `SIANG` records opening and movements while final closing is done by the night shift.
- Closing reports are append-only in the demo. Submit records `SENT` with a timestamp and revision; supervisor review is asynchronous and must not block the next shift.
- Movement rows are append-only in the demo UI. There is no edit/delete affordance. Corrections must be represented as a new movement category in a production backend.
- Item, movement, assignment, opening, report status, and timestamps persist to `localStorage` under `hopin-stock-demo-v04`; this is recovery convenience, not a security boundary.
- Every physical count and variance edit gets a client-side `updatedAt`; successful submit stores a separate client-side timestamp for its area.

## States and feedback

- Draft shows `Autosave aktif` and a local timestamp.
- Offline simulation follows browser online/offline events and says `tersimpan di perangkat · menunggu sinkronisasi`.
- Submit is disabled after local `SUBMITTED` state.
- Missing closing values route to Closing and activate the `Belum diisi` filter.
- Assignment confirmation is an in-app dialog. No native browser alert/confirm/prompt is used.

## Accessibility and responsive rules

All actions are native buttons, all fields have labels, status uses text + shape, input uses numeric keyboard hints, focus-visible styling is global, and reduced motion is respected. The 320–430px layout is single-column with a sticky submit bar; tablet/desktop uses the two-column context rail.

## Prototype assumptions / blockers

- Seed item list is mock data from the supplied specification evidence.
- Opening is an editable, required count for every item until confirmed. Real server-side assignment locking and supervisor review are not implemented.
- Login is demo-only with PIN `1234`, one active browser-tab lease, and 30-minute inactivity logout. True single-device enforcement still requires a backend.
- Network sync is simulated by browser connectivity signals; no server replay or idempotency exists.
- Real session lease, audit trail, PDF, and supervisor approval/reopen require backend implementation.
