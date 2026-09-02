-- HOPIN Production Migration 0006: Roster, Attendance & GPS Verification

create table if not exists public.roster_entries (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete cascade,
  work_date date not null,
  shift_code text not null check (shift_code in ('SIANG', 'MALAM', 'FULL')),
  profile_id uuid not null references public.profiles(id) on delete restrict,
  expected_area public.area_code,
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'SWAPPED', 'CANCELLED', 'COMPLETED')),
  pay_treatment text not null default 'BASE' check (pay_treatment in ('BASE', 'EXTRA', 'MAKEUP')),
  override_reason text,
  created_by uuid references public.profiles(id),
  source text not null default 'MANUAL',
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists roster_entries_active_idx
on public.roster_entries (profile_id, work_date)
where status = 'SCHEDULED';

create table if not exists public.shift_swap_requests (
  id uuid primary key default gen_random_uuid(),
  roster_entry_id uuid not null references public.roster_entries(id) on delete cascade,
  requested_by uuid not null references public.profiles(id),
  offered_to uuid not null references public.profiles(id),
  status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED')),
  expires_at timestamptz not null,
  responded_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  constraint requester_target_diff check (requested_by <> offered_to)
);

create table if not exists public.attendance_challenges (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid references public.app_sessions(id) on delete set null,
  device_id uuid references public.app_devices(id) on delete set null,
  action text not null check (action in ('CHECK_IN', 'CHECK_OUT')),
  nonce_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  work_date date not null,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  roster_entry_id uuid references public.roster_entries(id) on delete set null,
  work_assignment_id uuid references public.work_assignments(id) on delete set null,
  status text not null default 'NOT_STARTED' check (status in ('NOT_STARTED', 'CHECKED_IN', 'CHECKED_OUT', 'MISSING_CHECKOUT', 'REVIEW_REQUIRED', 'APPROVED')),
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  check_in_event_id uuid,
  check_out_event_id uuid,
  lateness_status text not null default 'ON_TIME' check (lateness_status in ('ON_TIME', 'LATE', 'EXCUSED')),
  exception_status text not null default 'NONE' check (exception_status in ('NONE', 'PENDING_REVIEW', 'RESOLVED', 'REJECTED')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, work_date)
);

create table if not exists public.attendance_events (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance_records(id) on delete cascade,
  event_type text not null check (event_type in ('CHECK_IN', 'CHECK_OUT')),
  server_occurred_at timestamptz not null default now(),
  client_occurred_at timestamptz,
  challenge_id uuid references public.attendance_challenges(id),
  device_id uuid references public.app_devices(id),
  ip_country text,
  location_status text not null check (location_status in ('VERIFIED', 'OUTSIDE', 'POOR_ACCURACY', 'DENIED', 'TIMEOUT', 'UNAVAILABLE', 'HIGH_RISK')),
  selected_distance_m integer,
  selected_accuracy_m integer,
  risk_score integer not null default 0,
  risk_reasons jsonb not null default '[]'::jsonb,
  note text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (attendance_id, event_type),
  unique (idempotency_key)
);

create table if not exists public.attendance_location_samples (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.attendance_events(id) on delete cascade,
  latitude double precision not null,
  longitude double precision not null,
  accuracy_m double precision not null,
  client_sampled_at timestamptz,
  sample_order integer not null check (sample_order between 1 and 10),
  retained_until timestamptz not null default (now() + interval '90 days')
);

create table if not exists public.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance_records(id) on delete cascade,
  correction_type text not null,
  proposed_json jsonb not null,
  reason text not null,
  requested_by uuid not null references public.profiles(id),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  start_date date not null,
  end_date date not null,
  leave_type text not null check (leave_type in ('SICK', 'OTHER', 'UNPAID', 'OTHER_EXCEPTION')),
  reason text not null,
  submitted_by uuid not null references public.profiles(id),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.overtime_claims (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance_records(id) on delete cascade,
  raw_extra_minutes integer not null check (raw_extra_minutes >= 0),
  credited_hours integer not null default 0 check (credited_hours >= 0),
  status text not null default 'CANDIDATE' check (status in ('CANDIDATE', 'APPROVED', 'REJECTED')),
  reason text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now()
);

alter table public.roster_entries enable row level security;
alter table public.shift_swap_requests enable row level security;
alter table public.attendance_challenges enable row level security;
alter table public.attendance_records enable row level security;
alter table public.attendance_events enable row level security;
alter table public.attendance_location_samples enable row level security;
alter table public.attendance_corrections enable row level security;
alter table public.leave_requests enable row level security;
alter table public.overtime_claims enable row level security;

revoke all on public.roster_entries, public.shift_swap_requests, public.attendance_challenges, public.attendance_records, public.attendance_events, public.attendance_location_samples, public.attendance_corrections, public.leave_requests, public.overtime_claims from anon, authenticated;
grant all on public.roster_entries, public.shift_swap_requests, public.attendance_challenges, public.attendance_records, public.attendance_events, public.attendance_location_samples, public.attendance_corrections, public.leave_requests, public.overtime_claims to service_role;
