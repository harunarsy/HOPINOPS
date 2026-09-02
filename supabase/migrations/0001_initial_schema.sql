-- HOPIN Stock Operations: database foundation
-- Run this migration from Supabase SQL Editor.

create extension if not exists pgcrypto;

create type public.app_role as enum ('OPERATOR', 'SUPERVISOR', 'ADMIN');
create type public.area_code as enum ('BAR', 'KITCHEN');
create type public.shift_code as enum ('SIANG', 'MALAM', 'FULL');
create type public.assignment_status as enum ('ACTIVE', 'RESET');
create type public.opening_status as enum ('DRAFT', 'CONFIRMED');
create type public.report_status as enum ('DRAFT', 'SENT', 'APPROVED', 'NEEDS_CLARIFICATION');
create type public.movement_direction as enum ('IN', 'OUT');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  role public.app_role not null default 'OPERATOR',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.items (
  id text primary key,
  area_code public.area_code not null,
  name text not null,
  unit_code text not null,
  decimal_scale smallint not null default 2 check (decimal_scale between 0 and 4),
  low_threshold numeric(14, 4) not null check (low_threshold >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  work_date date not null,
  shift public.shift_code not null,
  area_code public.area_code not null,
  user_id uuid not null references public.profiles (id),
  status public.assignment_status not null default 'ACTIVE',
  version integer not null default 1 check (version > 0),
  confirmed_at timestamptz not null default now(),
  reset_at timestamptz,
  reset_by uuid references public.profiles (id),
  reset_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (work_date, user_id)
);

create table public.opening_records (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null unique references public.assignments (id) on delete cascade,
  status public.opening_status not null default 'DRAFT',
  version integer not null default 1 check (version > 0),
  confirmed_at timestamptz,
  confirmed_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.opening_lines (
  opening_id uuid not null references public.opening_records (id) on delete cascade,
  item_id text not null references public.items (id),
  reference_qty numeric(14, 4) not null check (reference_qty >= 0),
  counted_qty numeric(14, 4) check (counted_qty >= 0),
  variance_reason text,
  notes text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id),
  primary key (opening_id, item_id)
);

create table public.movements (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments (id) on delete restrict,
  item_id text not null references public.items (id),
  direction public.movement_direction not null,
  category text not null check (
    (direction = 'IN' and category in ('PURCHASE', 'RETURN_IN', 'TRANSFER_IN'))
    or (direction = 'OUT' and category in ('USAGE', 'INTERNAL', 'TRANSFER_OUT', 'WASTE'))
  ),
  quantity numeric(14, 4) not null check (quantity > 0),
  unit_code_snapshot text not null,
  client_occurred_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles (id),
  idempotency_key text not null,
  correction_of_id uuid references public.movements (id),
  unique (assignment_id, idempotency_key)
);

create table public.closing_reports (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null unique references public.assignments (id) on delete cascade,
  status public.report_status not null default 'DRAFT',
  current_revision integer not null default 0 check (current_revision >= 0),
  version integer not null default 1 check (version > 0),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles (id),
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.closing_report_revisions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.closing_reports (id) on delete cascade,
  revision integer not null check (revision > 0),
  status public.report_status not null default 'SENT',
  submitted_at timestamptz not null default now(),
  submitted_by uuid not null references public.profiles (id),
  movement_cutoff_at timestamptz not null default now(),
  unique (report_id, revision)
);

create table public.closing_lines (
  revision_id uuid not null references public.closing_report_revisions (id) on delete cascade,
  item_id text not null references public.items (id),
  opening_qty numeric(14, 4) not null check (opening_qty >= 0),
  incoming_qty numeric(14, 4) not null default 0 check (incoming_qty >= 0),
  outgoing_qty numeric(14, 4) not null default 0 check (outgoing_qty >= 0),
  system_qty numeric(14, 4) not null,
  closing_qty numeric(14, 4) not null check (closing_qty >= 0),
  variance_qty numeric(14, 4) not null,
  variance_reason text,
  variance_notes text,
  primary key (revision_id, item_id)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles (id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  before_json jsonb,
  after_json jsonb,
  server_occurred_at timestamptz not null default now(),
  request_id text,
  reason text
);

create index assignments_user_date_idx on public.assignments (user_id, work_date);
create index assignments_date_area_idx on public.assignments (work_date, area_code);
create index movements_assignment_created_idx on public.movements (assignment_id, created_at desc);
create index audit_events_entity_idx on public.audit_events (entity_type, entity_id, server_occurred_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger items_set_updated_at
before update on public.items
for each row execute function public.set_updated_at();

create trigger assignments_set_updated_at
before update on public.assignments
for each row execute function public.set_updated_at();

create trigger opening_records_set_updated_at
before update on public.opening_records
for each row execute function public.set_updated_at();

create trigger closing_reports_set_updated_at
before update on public.closing_reports
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(coalesce(new.email, 'operator'), '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and active = true
      and role in ('SUPERVISOR', 'ADMIN')
  );
$$;

create or replace function public.can_access_assignment(target_assignment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.assignments
    where id = target_assignment_id
      and (user_id = auth.uid() or public.is_manager())
  );
$$;

insert into public.items (id, area_code, name, unit_code, decimal_scale, low_threshold)
values
  ('bar-01', 'BAR', 'Sirup Lemon Sunfresh', 'ml', 2, 350),
  ('bar-02', 'BAR', 'Susu Oat Barista Edition', 'pack', 0, 3),
  ('bar-03', 'BAR', 'Biji Kopi Arabika House Blend', 'gram', 2, 500),
  ('bar-04', 'BAR', 'Sirup Vanilla Monin', 'ml', 2, 200),
  ('bar-05', 'BAR', 'Susu Fresh Milk Greenfields', 'pack', 0, 5),
  ('bar-06', 'BAR', 'Teh Chamomile Dilmah', 'pcs', 0, 10),
  ('bar-07', 'BAR', 'Bubuk Matcha Uji Premium', 'gram', 2, 150),
  ('bar-08', 'BAR', 'Cup Takeaway 16oz + Lid', 'pcs', 0, 50),
  ('ktc-01', 'KITCHEN', 'Daging Ayam Fillet Dada', 'gram', 2, 1000),
  ('ktc-02', 'KITCHEN', 'Telur Ayam Negeri', 'pcs', 0, 10),
  ('ktc-03', 'KITCHEN', 'Minyak Goreng Sawit', 'ml', 2, 1500),
  ('ktc-04', 'KITCHEN', 'Daging Patty Burger Sapi', 'pcs', 0, 8),
  ('ktc-05', 'KITCHEN', 'Selada Romaine Segar', 'gram', 2, 500),
  ('ktc-06', 'KITCHEN', 'Roti Burger Brioche Bun', 'pcs', 0, 10)
on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.items enable row level security;
alter table public.assignments enable row level security;
alter table public.opening_records enable row level security;
alter table public.opening_lines enable row level security;
alter table public.movements enable row level security;
alter table public.closing_reports enable row level security;
alter table public.closing_report_revisions enable row level security;
alter table public.closing_lines enable row level security;
alter table public.audit_events enable row level security;

create policy profiles_select_self_or_manager
on public.profiles for select to authenticated
using (id = auth.uid() or public.is_manager());

create policy items_select_authenticated
on public.items for select to authenticated
using (active = true or public.is_manager());

create policy items_manage_manager
on public.items for all to authenticated
using (public.is_manager())
with check (public.is_manager());

create policy assignments_select_owner_or_manager
on public.assignments for select to authenticated
using (user_id = auth.uid() or public.is_manager());

create policy assignments_insert_owner_or_manager
on public.assignments for insert to authenticated
with check (user_id = auth.uid() or public.is_manager());

create policy opening_records_select_assigned
on public.opening_records for select to authenticated
using (public.can_access_assignment(assignment_id));

create policy opening_lines_select_assigned
on public.opening_lines for select to authenticated
using (
  exists (
    select 1
    from public.opening_records opening
    where opening.id = opening_id
      and public.can_access_assignment(opening.assignment_id)
  )
);

create policy movements_select_assigned
on public.movements for select to authenticated
using (public.can_access_assignment(assignment_id));

create policy movements_insert_assigned
on public.movements for insert to authenticated
with check (
  created_by = auth.uid()
  and exists (
    select 1
    from public.assignments assignment
    join public.opening_records opening on opening.assignment_id = assignment.id
    where assignment.id = movements.assignment_id
      and assignment.status = 'ACTIVE'
      and opening.status = 'CONFIRMED'
      and (assignment.user_id = auth.uid() or public.is_manager())
  )
);

create policy closing_reports_select_assigned
on public.closing_reports for select to authenticated
using (public.can_access_assignment(assignment_id));

create policy closing_report_revisions_select_assigned
on public.closing_report_revisions for select to authenticated
using (
  exists (
    select 1
    from public.closing_reports report
    where report.id = report_id
      and public.can_access_assignment(report.assignment_id)
  )
);

create policy closing_lines_select_assigned
on public.closing_lines for select to authenticated
using (
  exists (
    select 1
    from public.closing_report_revisions revision
    join public.closing_reports report on report.id = revision.report_id
    where revision.id = revision_id
      and public.can_access_assignment(report.assignment_id)
  )
);

create policy audit_events_select_manager
on public.audit_events for select to authenticated
using (public.is_manager());

grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.items to authenticated;
grant select, insert on public.assignments to authenticated;
grant select on public.opening_records, public.opening_lines to authenticated;
grant select, insert on public.movements to authenticated;
grant select on public.closing_reports, public.closing_report_revisions, public.closing_lines to authenticated;
grant select on public.audit_events to authenticated;
