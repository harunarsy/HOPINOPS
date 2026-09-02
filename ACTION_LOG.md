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
- Added a direct management dashboard for `OWNER`, `INVESTOR`, and `ADMIN` users.
- Added visible logout controls on both the assignment screen and dashboard.
- Persisted staff assignments per username and work date so another user cannot overwrite them on the same device.

## Current state

- Supabase project exists, is linked locally, and migrations `0001`-`0003` are applied.
- RLS is enabled for all application tables by the migration.
- `0003` removes the app profile dependency on `auth.users`; no Supabase Auth users are required.
- No additional operator profiles have been provisioned yet.
- HARUN is provisioned as `OWNER` and the deployed auth endpoint returns his active login option.
- The application still reads and writes `localStorage`.
- No Supabase credentials are stored in this repository.
- The custom auth code requires `SUPABASE_SERVICE_ROLE_KEY` in Vercel.
- Management dashboard and per-user assignment changes are deployed on `main`.

## Next

- Provision JEZY as `OWNER` with job title `SUPERVISOR / CO-OWNER`, and CATUR/AYAS as `INVESTOR`, without sharing PINs.
- Wire auth, assignment, opening, movement, closing, and report commands to Supabase.
- Add Preview/Development environment variables if those deployments are needed.

## Not committed

- Custom auth changes are not committed or pushed yet.
