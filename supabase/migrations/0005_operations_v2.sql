-- HOPIN Production Migration 0005: Operations V2 (Stock Cycles & Handover)

create table if not exists public.shift_templates (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete cascade,
  code text not null,
  label text not null,
  start_local time not null,
  end_local time not null,
  scheduled_minutes integer not null,
  active boolean not null default true,
  version integer not null default 1 check (version > 0),
  unique (outlet_id, code)
);

-- Seed shift templates
insert into public.shift_templates (outlet_id, code, label, start_local, end_local, scheduled_minutes)
values 
  ('11111111-1111-1111-1111-111111111111', 'SIANG', 'Shift Siang', '11:00:00', '17:00:00', 360),
  ('11111111-1111-1111-1111-111111111111', 'MALAM', 'Shift Malam', '17:00:00', '23:00:00', 360),
  ('11111111-1111-1111-1111-111111111111', 'FULL', 'Full Shift', '11:00:00', '23:00:00', 720)
on conflict (outlet_id, code) do nothing;

create table if not exists public.work_cycles (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id) on delete restrict,
  work_date date not null,
  shift_code text not null check (shift_code in ('SIANG', 'MALAM', 'FULL')),
  area_code public.area_code not null,
  status text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'ACTIVE', 'OPEN', 'HANDOVER_READY', 'CLOSING_READY', 'COMPLETED', 'RESET')),
  movement_cutoff_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, work_date, shift_code, area_code)
);

create table if not exists public.work_assignments (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.work_cycles(id) on delete cascade,
  work_date date not null,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  duty_role text not null check (duty_role in ('PRIMARY', 'HELPER')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'PENDING_TASKS', 'COMPLETED', 'RESET')),
  roster_entry_id uuid,
  schedule_deviation boolean not null default false,
  assigned_at timestamptz not null default now(),
  completed_at timestamptz,
  reset_at timestamptz,
  reset_by uuid references public.profiles(id),
  reset_reason text,
  version integer not null default 1 check (version > 0),
  unique (cycle_id, profile_id)
);

-- Exactly one ACTIVE PRIMARY per cycle
create unique index if not exists work_assignments_primary_active_idx
on public.work_assignments (cycle_id)
where duty_role = 'PRIMARY' and status = 'ACTIVE';

-- An operator can only have one ACTIVE assignment per day across all cycles
create unique index if not exists work_assignments_user_active_date_idx
on public.work_assignments (profile_id, work_date)
where status = 'ACTIVE';

create table if not exists public.stock_openings (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null unique references public.work_cycles(id) on delete cascade,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'CONFIRMED')),
  reference_source_type text,
  reference_source_id uuid,
  confirmed_at timestamptz,
  confirmed_by uuid references public.profiles(id),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.stock_opening_lines (
  opening_id uuid not null references public.stock_openings(id) on delete cascade,
  item_id text not null references public.items(id) on delete restrict,
  reference_qty numeric(14, 4) not null check (reference_qty >= 0),
  counted_qty numeric(14, 4) check (counted_qty >= 0),
  variance_qty numeric(14, 4),
  reason_code text,
  notes text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  primary key (opening_id, item_id)
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.work_cycles(id) on delete restrict,
  item_id text not null references public.items(id) on delete restrict,
  direction public.movement_direction not null,
  category text not null check (
    (direction = 'IN' and category in ('PURCHASE', 'RETURN_IN', 'TRANSFER_IN'))
    or (direction = 'OUT' and category in ('USAGE', 'INTERNAL', 'TRANSFER_OUT', 'WASTE'))
  ),
  quantity numeric(14, 4) not null check (quantity > 0),
  unit_code_snapshot text not null,
  client_occurred_at timestamptz,
  server_occurred_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id),
  idempotency_key text not null,
  correction_of_id uuid references public.stock_movements(id),
  correction_reason text,
  unique (cycle_id, idempotency_key)
);

create table if not exists public.stock_handovers (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null unique references public.work_cycles(id) on delete cascade,
  status text not null default 'CONFIRMED' check (status in ('DRAFT', 'CONFIRMED')),
  movement_cutoff_at timestamptz not null,
  confirmed_at timestamptz not null default now(),
  confirmed_by uuid not null references public.profiles(id),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.stock_handover_lines (
  handover_id uuid not null references public.stock_handovers(id) on delete cascade,
  item_id text not null references public.items(id) on delete restrict,
  opening_qty numeric(14, 4) not null check (opening_qty >= 0),
  incoming_qty numeric(14, 4) not null default 0 check (incoming_qty >= 0),
  outgoing_qty numeric(14, 4) not null default 0 check (outgoing_qty >= 0),
  system_qty numeric(14, 4) not null,
  primary key (handover_id, item_id)
);

create table if not exists public.stock_closings (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null unique references public.work_cycles(id) on delete cascade,
  status text not null default 'CONFIRMED' check (status in ('DRAFT', 'CONFIRMED')),
  movement_cutoff_at timestamptz not null,
  confirmed_at timestamptz not null default now(),
  confirmed_by uuid not null references public.profiles(id),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.stock_closing_lines (
  closing_id uuid not null references public.stock_closings(id) on delete cascade,
  item_id text not null references public.items(id) on delete restrict,
  opening_qty numeric(14, 4) not null check (opening_qty >= 0),
  incoming_qty numeric(14, 4) not null default 0 check (incoming_qty >= 0),
  outgoing_qty numeric(14, 4) not null default 0 check (outgoing_qty >= 0),
  system_qty numeric(14, 4) not null,
  counted_qty numeric(14, 4) not null check (counted_qty >= 0),
  variance_qty numeric(14, 4) not null,
  reason_code text,
  notes text,
  primary key (closing_id, item_id)
);

alter table public.shift_templates enable row level security;
alter table public.work_cycles enable row level security;
alter table public.work_assignments enable row level security;
alter table public.stock_openings enable row level security;
alter table public.stock_opening_lines enable row level security;
alter table public.stock_movements enable row level security;
alter table public.stock_handovers enable row level security;
alter table public.stock_handover_lines enable row level security;
alter table public.stock_closings enable row level security;
alter table public.stock_closing_lines enable row level security;

revoke all on public.shift_templates, public.work_cycles, public.work_assignments, public.stock_openings, public.stock_opening_lines, public.stock_movements, public.stock_handovers, public.stock_handover_lines, public.stock_closings, public.stock_closing_lines from anon, authenticated;
grant all on public.shift_templates, public.work_cycles, public.work_assignments, public.stock_openings, public.stock_opening_lines, public.stock_movements, public.stock_handovers, public.stock_handover_lines, public.stock_closings, public.stock_closing_lines to service_role;
