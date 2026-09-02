-- HOPIN custom username + PIN authentication.
-- Supabase Auth email identities are intentionally not used for app users.

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

alter table public.profiles
  drop constraint if exists profiles_id_fkey;

alter table public.profiles
  add column if not exists job_title text;

update public.profiles
set job_title = coalesce(nullif(job_title, ''), 'STAFF')
where job_title is null or job_title = '';

alter table public.profiles
  alter column job_title set default 'STAFF',
  alter column job_title set not null;

create table public.operator_credentials (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  pin_salt text not null,
  pin_hash text not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create table public.app_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index app_sessions_profile_idx on public.app_sessions (profile_id);
create index app_sessions_active_idx on public.app_sessions (token_hash, expires_at)
where revoked_at is null;

create trigger operator_credentials_set_updated_at
before update on public.operator_credentials
for each row execute function public.set_updated_at();

alter table public.operator_credentials enable row level security;
alter table public.app_sessions enable row level security;

revoke all on public.operator_credentials from anon, authenticated;
revoke all on public.app_sessions from anon, authenticated;

grant all on public.operator_credentials to service_role;
grant all on public.app_sessions to service_role;
