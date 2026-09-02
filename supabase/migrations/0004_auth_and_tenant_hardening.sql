-- HOPIN Production Migration 0004: Auth & Tenant Hardening

create table if not exists public.outlets (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  timezone text not null default 'Asia/Jakarta',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.outlet_settings (
  outlet_id uuid primary key references public.outlets(id) on delete cascade,
  latitude double precision,
  longitude double precision,
  geofence_radius_m integer not null default 100 check (geofence_radius_m between 10 and 10000),
  max_accuracy_m integer not null default 50 check (max_accuracy_m between 5 and 500),
  gps_sample_limit integer not null default 3 check (gps_sample_limit between 1 and 10),
  gps_timeout_seconds integer not null default 15 check (gps_timeout_seconds between 5 and 60),
  late_grace_minutes integer not null default 15 check (late_grace_minutes >= 0),
  overtime_threshold_minutes integer not null default 30 check (overtime_threshold_minutes >= 0),
  raw_gps_retention_days integer not null default 90 check (raw_gps_retention_days between 7 and 365),
  system_mode text not null default 'PRODUCTION' check (system_mode in ('PRODUCTION', 'PILOT', 'MAINTENANCE')),
  onboarding_version integer not null default 1 check (onboarding_version > 0),
  version integer not null default 1 check (version > 0),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.profile_outlet_scopes (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  outlet_id uuid not null references public.outlets(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (profile_id, outlet_id)
);

alter table public.profiles
  add column if not exists force_pin_change boolean not null default false,
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by uuid references public.profiles(id),
  add column if not exists version integer not null default 1 check (version > 0);

alter table public.operator_credentials
  add column if not exists pin_changed_at timestamptz,
  add column if not exists pin_version integer not null default 1 check (pin_version > 0),
  add column if not exists last_failed_at timestamptz;

create table if not exists public.pin_history (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  pin_salt text not null,
  pin_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.app_devices (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  device_token_hash text not null unique,
  label text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_ip_hash text,
  last_user_agent_hash text
);

alter table public.app_sessions
  add column if not exists device_id uuid references public.app_devices(id),
  add column if not exists ip_hash text,
  add column if not exists user_agent_hash text,
  add column if not exists absolute_expires_at timestamptz;

create table if not exists public.auth_rate_limits (
  scope_key text primary key,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 1,
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

-- Seed default single outlet if not exists
insert into public.outlets (id, code, name, timezone, active)
values ('11111111-1111-1111-1111-111111111111', 'hopin-main', 'HOPIN Cafe', 'Asia/Jakarta', true)
on conflict (code) do nothing;

insert into public.outlet_settings (outlet_id, geofence_radius_m, max_accuracy_m, system_mode, version)
values ('11111111-1111-1111-1111-111111111111', 100, 50, 'PRODUCTION', 1)
on conflict (outlet_id) do nothing;

-- Ensure all existing profiles are mapped to default outlet scope
insert into public.profile_outlet_scopes (profile_id, outlet_id, active)
select id, '11111111-1111-1111-1111-111111111111', true
from public.profiles
on conflict do nothing;

-- RLS protection
alter table public.outlets enable row level security;
alter table public.outlet_settings enable row level security;
alter table public.profile_outlet_scopes enable row level security;
alter table public.pin_history enable row level security;
alter table public.app_devices enable row level security;
alter table public.auth_rate_limits enable row level security;

revoke all on public.outlets, public.outlet_settings, public.profile_outlet_scopes, public.pin_history, public.app_devices, public.auth_rate_limits from anon, authenticated;
grant all on public.outlets, public.outlet_settings, public.profile_outlet_scopes, public.pin_history, public.app_devices, public.auth_rate_limits to service_role;
