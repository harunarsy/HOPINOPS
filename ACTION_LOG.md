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
- Added custom username + six-digit PIN credentials and server sessions in migration `0003`.
- Applied migration `0003_custom_auth.sql` to the remote database.
- Added Vercel auth endpoints with server-only Supabase service-role access and HttpOnly cookies.
- Switched the frontend login from Supabase Auth to the custom auth API.
- Added interactive `pnpm provision:user` without accepting PINs as command-line arguments.

## Current state

- Supabase project exists, is linked locally, and migrations `0001`-`0003` are applied.
- RLS is enabled for all application tables by the migration.
- `0003` removes the app profile dependency on `auth.users`; no Supabase Auth users are required.
- No custom operator profiles or PINs have been provisioned yet.
- The application still reads and writes `localStorage`.
- No Supabase credentials are stored in this repository.
- The custom auth code is local until pushed and requires `SUPABASE_SERVICE_ROLE_KEY` in Vercel.

## Next

- Configure the server-only Supabase service-role variable in Vercel.
- Provision initial custom users without sharing PINs.
- Wire auth, assignment, opening, movement, closing, and report commands to Supabase.
- Add Vercel environment variables and verify the deployed auth flow.

## Not committed

- Custom auth changes are not committed or pushed yet.
