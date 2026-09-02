-- HOPIN Production Migration 0008: Commands, Privileges, Audit & Legacy Deprecation

-- Enhance audit_events
alter table public.audit_events
  add column if not exists outlet_id uuid references public.outlets(id),
  add column if not exists subject_user_id uuid references public.profiles(id),
  add column if not exists ip_hash text,
  add column if not exists metadata_json jsonb;

-- Revoke legacy operational tables from anon & authenticated to prevent direct client access
revoke all on public.assignments from anon, authenticated;
revoke all on public.opening_records from anon, authenticated;
revoke all on public.opening_lines from anon, authenticated;
revoke all on public.movements from anon, authenticated;
revoke all on public.closing_reports from anon, authenticated;
revoke all on public.closing_report_revisions from anon, authenticated;
revoke all on public.closing_lines from anon, authenticated;
revoke all on public.audit_events from anon, authenticated;

grant all on public.assignments, public.opening_records, public.opening_lines,
  public.movements, public.closing_reports, public.closing_report_revisions,
  public.closing_lines, public.audit_events to service_role;

-- Helpful Indexes for performance and reporting
create index if not exists work_cycles_lookup_idx on public.work_cycles (outlet_id, work_date, shift_code, area_code);
create index if not exists work_assignments_active_idx on public.work_assignments (cycle_id, status);
create index if not exists stock_movements_cycle_idx on public.stock_movements (cycle_id, server_occurred_at desc);
create index if not exists attendance_records_date_idx on public.attendance_records (outlet_id, work_date, status);
create index if not exists daily_reports_lookup_idx on public.daily_reports (outlet_id, work_date, status);
create index if not exists payroll_runs_period_idx on public.payroll_runs (outlet_id, period_month, status);
create index if not exists app_sessions_lookup_idx on public.app_sessions (token_hash) where revoked_at is null;
