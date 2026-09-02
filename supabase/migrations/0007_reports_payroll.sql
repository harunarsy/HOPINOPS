-- HOPIN Production Migration 0007: Daily Reports, Bonus & Payroll V2

create table if not exists public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  work_date date not null,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'SUBMITTED', 'NEEDS_CLARIFICATION', 'APPROVED')),
  current_revision integer not null default 0 check (current_revision >= 0),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, work_date)
);

create table if not exists public.daily_report_revisions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.daily_reports(id) on delete cascade,
  revision integer not null check (revision > 0),
  public_id text not null unique,
  status text not null default 'SUBMITTED' check (status in ('SUBMITTED', 'APPROVED', 'NEEDS_CLARIFICATION')),
  bar_closing_id uuid references public.stock_closings(id),
  kitchen_closing_id uuid references public.stock_closings(id),
  handover_ids jsonb not null default '[]'::jsonb,
  movement_cutoff_at timestamptz not null,
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  payload_checksum text not null,
  unique (report_id, revision)
);

create table if not exists public.daily_report_finance (
  revision_id uuid primary key references public.daily_report_revisions(id) on delete cascade,
  cash_real numeric(14, 0) not null check (cash_real >= 0),
  cash_app numeric(14, 0) not null check (cash_app >= 0),
  qris_mandiri numeric(14, 0) not null check (qris_mandiri >= 0),
  debit_mandiri numeric(14, 0) not null check (debit_mandiri >= 0),
  recorded_total numeric(14, 0) not null check (recorded_total >= 0),
  received_total numeric(14, 0) not null check (received_total >= 0),
  cash_difference numeric(14, 0) not null
);

create table if not exists public.daily_report_stock_lines (
  revision_id uuid not null references public.daily_report_revisions(id) on delete cascade,
  item_id text not null references public.items(id),
  area_code public.area_code not null,
  closing_qty numeric(14, 4) not null check (closing_qty >= 0),
  low_threshold_snapshot numeric(14, 4) not null check (low_threshold_snapshot >= 0),
  stock_status text not null check (stock_status in ('AMAN', 'HAMPIR_HABIS', 'HABIS')),
  primary key (revision_id, item_id)
);

create table if not exists public.daily_bonus_pools (
  id uuid primary key default gen_random_uuid(),
  report_revision_id uuid not null unique references public.daily_report_revisions(id) on delete cascade,
  recorded_total numeric(14, 0) not null check (recorded_total >= 0),
  tier_percent numeric(5, 2) not null check (tier_percent >= 0),
  pool_amount numeric(14, 0) not null check (pool_amount >= 0),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'FINAL')),
  calculated_at timestamptz not null default now()
);

create table if not exists public.daily_bonus_allocations (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.daily_bonus_pools(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  amount numeric(14, 0) not null check (amount >= 0),
  remainder_awarded boolean not null default false,
  attendance_id uuid references public.attendance_records(id),
  unique (pool_id, profile_id)
);

create table if not exists public.compensation_policies (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  name text not null,
  minimum_workdays integer not null default 24 check (minimum_workdays between 1 and 31),
  sick_allowance integer not null default 2 check (sick_allowance >= 0),
  other_leave_allowance integer not null default 1 check (other_leave_allowance >= 0),
  effective_from date not null,
  effective_to date,
  status text not null default 'ACTIVE' check (status in ('DRAFT', 'ACTIVE', 'RETIRED')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.employee_compensations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  policy_id uuid not null references public.compensation_policies(id) on delete restrict,
  effective_from date not null,
  effective_to date,
  monthly_base numeric(14, 0) not null check (monthly_base >= 0),
  daily_rate numeric(14, 0) not null check (daily_rate >= 0),
  hourly_rate numeric(14, 0) not null check (hourly_rate >= 0),
  created_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  period_month text not null check (period_month ~ '^\d{4}-\d{2}$'),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'REVIEWED', 'FINALIZED', 'PAID', 'VOID')),
  policy_id uuid not null references public.compensation_policies(id),
  version integer not null default 1 check (version > 0),
  created_by uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  finalized_by uuid references public.profiles(id),
  finalized_at timestamptz,
  payload_checksum text,
  created_at timestamptz not null default now()
);

create table if not exists public.payroll_entries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  base_amount numeric(14, 0) not null default 0 check (base_amount >= 0),
  attendance_summary jsonb not null default '{}'::jsonb,
  approved_overtime_amount numeric(14, 0) not null default 0 check (approved_overtime_amount >= 0),
  approved_shortage_amount numeric(14, 0) not null default 0 check (approved_shortage_amount >= 0),
  absence_deduction numeric(14, 0) not null default 0 check (absence_deduction >= 0),
  bonus_amount numeric(14, 0) not null default 0 check (bonus_amount >= 0),
  manual_adjustment_amount numeric(14, 0) not null default 0,
  proposed_gross numeric(14, 0) not null default 0,
  final_gross numeric(14, 0) not null default 0,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'REVIEWED', 'APPROVED')),
  version integer not null default 1 check (version > 0),
  unique (run_id, profile_id)
);

create table if not exists public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.payroll_entries(id) on delete cascade,
  adjustment_type text not null,
  quantity numeric(10, 2) not null default 1,
  rate numeric(14, 0) not null default 0,
  amount numeric(14, 0) not null,
  source_entity_type text,
  source_entity_id uuid,
  reason text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  proposed_by uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.payroll_exports (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs(id) on delete cascade,
  format text not null default 'XLSX' check (format = 'XLSX'),
  file_path text not null,
  checksum_sha256 text not null,
  generated_by uuid not null references public.profiles(id),
  generated_at timestamptz not null default now(),
  row_counts jsonb not null default '{}'::jsonb
);

create table if not exists public.onboarding_progress (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  onboarding_version integer not null check (onboarding_version > 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  replay_count integer not null default 0 check (replay_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (profile_id, onboarding_version)
);

-- Seed default compensation policy
insert into public.compensation_policies (id, outlet_id, name, minimum_workdays, sick_allowance, other_leave_allowance, effective_from, status)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Kebijakan Standar 2026', 24, 2, 1, '2026-01-01', 'ACTIVE')
on conflict do nothing;

alter table public.daily_reports enable row level security;
alter table public.daily_report_revisions enable row level security;
alter table public.daily_report_finance enable row level security;
alter table public.daily_report_stock_lines enable row level security;
alter table public.daily_bonus_pools enable row level security;
alter table public.daily_bonus_allocations enable row level security;
alter table public.compensation_policies enable row level security;
alter table public.employee_compensations enable row level security;
alter table public.payroll_runs enable row level security;
alter table public.payroll_entries enable row level security;
alter table public.payroll_adjustments enable row level security;
alter table public.payroll_exports enable row level security;
alter table public.onboarding_progress enable row level security;

revoke all on public.daily_reports, public.daily_report_revisions, public.daily_report_finance, public.daily_report_stock_lines, public.daily_bonus_pools, public.daily_bonus_allocations, public.compensation_policies, public.employee_compensations, public.payroll_runs, public.payroll_entries, public.payroll_adjustments, public.payroll_exports, public.onboarding_progress from anon, authenticated;
grant all on public.daily_reports, public.daily_report_revisions, public.daily_report_finance, public.daily_report_stock_lines, public.daily_bonus_pools, public.daily_bonus_allocations, public.compensation_policies, public.employee_compensations, public.payroll_runs, public.payroll_entries, public.payroll_adjustments, public.payroll_exports, public.onboarding_progress to service_role;
