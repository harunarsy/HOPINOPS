# HOPIN Action Log

## Completed and verified

- Audited the current React/Vite local-only prototype.
- Confirmed `pnpm lint` passes.
- Confirmed `pnpm build` passes.
- Confirmed Vercel deploys `main` at `hopinops.vercel.app`.
- Added the initial Supabase schema and RLS migration.
- Added environment variable documentation without storing secrets.
- Linked the local CLI to the HOPIN Supabase project.
- Applied migration `0001_initial_schema.sql` to the remote database.
- Defined separate finance/progress access for investor and owner roles in migration `0002`.
- Applied migration `0002_role_scopes.sql` to the remote database.
- Replaced the native login select with an accessible user picker and six-digit PIN input.

## Current state

- Supabase project exists, is linked locally, and migration `0001` is applied.
- RLS is enabled for all application tables by the migration.
- `0002` is applied remotely; no Auth users have been created yet.
- The application still reads and writes `localStorage`.
- No Supabase credentials are stored in this repository.
- Auth UI changes are local until the final UI commit is pushed.

## Next

- Decide operator authentication as email/password or another Supabase Auth flow.
- Confirm initial user records and create Auth users without sharing PINs.
- Wire auth, assignment, opening, movement, closing, and report commands to Supabase.
- Add Vercel environment variables and verify the deployed flow.

## Not committed

- No commit or push was made by this session.
