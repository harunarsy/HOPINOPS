-- HOPIN Production Migration 0013: Private Payroll Storage & Runtime Retention

insert into storage.buckets (id, name, public)
values ('payroll-exports', 'payroll-exports', false)
on conflict (id) do update
set public = false;

-- Storage remains server-only. No anon/authenticated object policy is created.
drop policy if exists payroll_exports_service_role_objects on storage.objects;
create policy payroll_exports_service_role_objects
on storage.objects
for all
to service_role
using (bucket_id = 'payroll-exports')
with check (bucket_id = 'payroll-exports');

create index if not exists app_sessions_expires_cleanup_idx
  on public.app_sessions (expires_at);
create index if not exists app_sessions_absolute_expires_cleanup_idx
  on public.app_sessions (absolute_expires_at)
  where absolute_expires_at is not null;
create index if not exists app_sessions_last_seen_cleanup_idx
  on public.app_sessions (last_seen_at);
create index if not exists attendance_challenges_expires_cleanup_idx
  on public.attendance_challenges (expires_at);
create index if not exists auth_rate_limits_updated_cleanup_idx
  on public.auth_rate_limits (updated_at);

-- Preserve append-only evidence while allowing this migration's tightly scoped
-- retention RPC to remove raw coordinates after their retention deadline.
create or replace function public.enforce_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_table_schema = 'public'
     and tg_table_name = 'attendance_location_samples'
     and tg_op = 'DELETE'
     and current_setting('hopin.runtime_retention_cleanup', true) = 'on' then
    return old;
  end if;

  raise exception using
    errcode = '55000',
    message = format('APPEND_ONLY: %s tidak boleh diubah atau dihapus.', tg_table_name);
end;
$$;

create or replace function public.rpc_cleanup_runtime_data()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_sessions_deleted integer := 0;
  v_challenges_deleted integer := 0;
  v_rate_limits_deleted integer := 0;
  v_gps_samples_deleted integer := 0;
  v_summary jsonb;
  v_audit_id uuid;
begin
  delete from public.app_sessions session
  where session.expires_at <= v_now
     or (session.absolute_expires_at is not null and session.absolute_expires_at <= v_now)
     or session.last_seen_at <= v_now - interval '30 minutes';
  get diagnostics v_sessions_deleted = row_count;

  -- Challenges referenced by immutable attendance evidence must remain intact.
  delete from public.attendance_challenges challenge
  where challenge.expires_at <= v_now
    and not exists (
      select 1
      from public.attendance_events event
      where event.challenge_id = challenge.id
    );
  get diagnostics v_challenges_deleted = row_count;

  delete from public.auth_rate_limits rate_limit
  where rate_limit.updated_at <= v_now - interval '60 seconds'
    and (rate_limit.blocked_until is null or rate_limit.blocked_until <= v_now);
  get diagnostics v_rate_limits_deleted = row_count;

  perform set_config('hopin.runtime_retention_cleanup', 'on', true);
  delete from public.attendance_location_samples sample
  using public.attendance_events event,
        public.attendance_records attendance,
        public.outlet_settings settings
  where event.id = sample.event_id
    and attendance.id = event.attendance_id
    and settings.outlet_id = attendance.outlet_id
    and least(
      sample.retained_until,
      event.server_occurred_at + make_interval(days => settings.raw_gps_retention_days)
    ) <= v_now;
  get diagnostics v_gps_samples_deleted = row_count;
  perform set_config('hopin.runtime_retention_cleanup', 'off', true);

  v_summary := jsonb_build_object(
    'sessions_deleted', v_sessions_deleted,
    'challenges_deleted', v_challenges_deleted,
    'auth_rate_limits_deleted', v_rate_limits_deleted,
    'gps_samples_deleted', v_gps_samples_deleted,
    'completed_at', v_now
  );

  v_audit_id := public.log_audit_event(
    null,
    'RUNTIME_RETENTION_CLEANUP',
    'runtime_retention',
    v_now::text,
    null,
    null,
    null,
    v_summary,
    'Service-role runtime retention cleanup.',
    null
  );

  return v_summary || jsonb_build_object('audit_event_id', v_audit_id);
end;
$$;

revoke execute on function public.rpc_cleanup_runtime_data() from public, anon, authenticated;
grant execute on function public.rpc_cleanup_runtime_data() to service_role;

comment on function public.rpc_cleanup_runtime_data() is
  'Service-role-only cleanup for expired runtime auth data and per-outlet raw GPS retention; returns and audits aggregate counts only.';
