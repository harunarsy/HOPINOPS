-- HOPIN Production Migration 0011: Server-Authoritative PIN Lockout (3x/60s)
--
-- Authorized product decision (see REMEDIATION_IMPLEMENTATION_PLAN_PART_2.md):
--   3 failed PIN attempts -> lock 60 seconds, server-authoritative, across
--   credential, IP hash, and device hash.
--
-- This replaces the old 5-failures/15-minutes policy in the auth RPCs via
-- CREATE OR REPLACE. Migration is additive and does not edit 0001-0009.

create or replace function public.rpc_record_auth_failure(
  p_profile_id uuid,
  p_scope_keys text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_credential public.operator_credentials%rowtype;
  v_limit public.auth_rate_limits%rowtype;
  v_scope_key text;
  v_attempts integer := 0;
  v_blocked_until timestamptz;
  v_next_attempts integer;
  v_next_blocked_until timestamptz;
begin
  if coalesce(array_length(p_scope_keys, 1), 0) not between 1 and 3
     or exists (
       select 1 from unnest(p_scope_keys) as scope(scope_key)
       where scope_key is null
          or scope_key !~ '^(credential|ip|device):[a-f0-9]{64}$'
     )
     or (select count(distinct scope_key) from unnest(p_scope_keys) as scope(scope_key))
        <> array_length(p_scope_keys, 1)
     or (select count(distinct split_part(scope_key, ':', 1)) from unnest(p_scope_keys) as scope(scope_key))
        <> array_length(p_scope_keys, 1) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_AUTH_SCOPES: Wajib 1-3 keyed SHA-256 scope credential/IP/device yang unik.';
  end if;

  if p_profile_id is not null then
    select * into v_credential
    from public.operator_credentials
    where profile_id = p_profile_id
    for update;

    if found then
      if v_credential.locked_until is not null and v_credential.locked_until > v_now then
        v_next_attempts := v_credential.failed_attempts;
        v_next_blocked_until := v_credential.locked_until;
      elsif v_credential.locked_until is not null then
        v_next_attempts := 1;
        v_next_blocked_until := null;
      else
        v_next_attempts := v_credential.failed_attempts + 1;
        v_next_blocked_until := case
          when v_next_attempts >= 3 then v_now + interval '60 seconds'
          else null
        end;
      end if;

      update public.operator_credentials
      set failed_attempts = v_next_attempts,
          locked_until = v_next_blocked_until,
          last_failed_at = v_now
      where profile_id = p_profile_id;

      v_attempts := greatest(v_attempts, v_next_attempts);
      if v_next_blocked_until is not null
         and (v_blocked_until is null or v_next_blocked_until > v_blocked_until) then
        v_blocked_until := v_next_blocked_until;
      end if;
    end if;
  end if;

  for v_scope_key in
    select scope_key from unnest(p_scope_keys) as scope(scope_key) order by scope_key
  loop
    insert into public.auth_rate_limits (
      scope_key, window_started_at, attempts, blocked_until, updated_at
    ) values (
      v_scope_key, v_now, 1, null, v_now
    )
    on conflict (scope_key) do nothing;

    select * into v_limit
    from public.auth_rate_limits
    where scope_key = v_scope_key
    for update;

    if v_limit.blocked_until is not null and v_limit.blocked_until > v_now then
      v_next_attempts := v_limit.attempts;
      v_next_blocked_until := v_limit.blocked_until;
    elsif v_limit.blocked_until is not null
       or v_limit.window_started_at <= v_now - interval '60 seconds' then
      v_next_attempts := 1;
      v_next_blocked_until := null;
    else
      v_next_attempts := case when v_limit.updated_at = v_now then 1 else v_limit.attempts + 1 end;
      v_next_blocked_until := case
        when v_next_attempts >= 3 then v_now + interval '60 seconds'
        else null
      end;
    end if;

    update public.auth_rate_limits
    set window_started_at = case
          when v_limit.blocked_until is not null
            or v_limit.window_started_at <= v_now - interval '60 seconds'
          then v_now else v_limit.window_started_at
        end,
        attempts = v_next_attempts,
        blocked_until = v_next_blocked_until,
        updated_at = v_now
    where scope_key = v_scope_key;

    v_attempts := greatest(v_attempts, v_next_attempts);
    if v_next_blocked_until is not null
       and (v_blocked_until is null or v_next_blocked_until > v_blocked_until) then
      v_blocked_until := v_next_blocked_until;
    end if;
  end loop;

  perform public.log_audit_event(
    v_credential.profile_id,
    'LOGIN_FAILED',
    'operator_credentials',
    coalesce(v_credential.profile_id::text, 'unknown'),
    null,
    v_credential.profile_id,
    null,
    jsonb_build_object(
      'attempts', v_attempts,
      'blocked', v_blocked_until is not null and v_blocked_until > v_now
    )
  );

  return jsonb_build_object(
    'attempts', v_attempts,
    'blocked', v_blocked_until is not null and v_blocked_until > v_now,
    'blocked_until', v_blocked_until
  );
end;
$$;

create or replace function public.rpc_reset_auth_failures(
  p_profile_id uuid,
  p_scope_keys text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_scope_key text;
begin
  if coalesce(array_length(p_scope_keys, 1), 0) not between 1 and 3
     or exists (
       select 1 from unnest(p_scope_keys) as scope(scope_key)
       where scope_key is null
          or scope_key !~ '^(credential|ip|device):[a-f0-9]{64}$'
     )
     or (select count(distinct scope_key) from unnest(p_scope_keys) as scope(scope_key))
        <> array_length(p_scope_keys, 1)
     or (select count(distinct split_part(scope_key, ':', 1)) from unnest(p_scope_keys) as scope(scope_key))
        <> array_length(p_scope_keys, 1) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_AUTH_SCOPES: Wajib 1-3 keyed SHA-256 scope credential/IP/device yang unik.';
  end if;

  if p_profile_id is not null then
    perform 1 from public.operator_credentials where profile_id = p_profile_id for update;
    if found then
      update public.operator_credentials
      set failed_attempts = 0,
          locked_until = null,
          last_failed_at = null
      where profile_id = p_profile_id;
    end if;
  end if;

  for v_scope_key in
    select scope_key from unnest(p_scope_keys) as scope(scope_key) order by scope_key
  loop
    insert into public.auth_rate_limits (
      scope_key, window_started_at, attempts, blocked_until, updated_at
    ) values (
      v_scope_key, v_now, 0, null, v_now
    )
    on conflict (scope_key) do update
    set window_started_at = excluded.window_started_at,
        attempts = 0,
        blocked_until = null,
        updated_at = excluded.updated_at;
  end loop;

  return jsonb_build_object('attempts', 0, 'blocked', false, 'blocked_until', null);
end;
$$;

create or replace function public.rpc_check_auth_limits(
  p_profile_id uuid,
  p_scope_keys text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_attempts integer := 0;
  v_blocked_until timestamptz;
  v_value_attempts integer;
  v_value_blocked_until timestamptz;
begin
  if coalesce(array_length(p_scope_keys, 1), 0) not between 1 and 3
     or exists (
       select 1 from unnest(p_scope_keys) as scope(scope_key)
       where scope_key is null
          or scope_key !~ '^(credential|ip|device):[a-f0-9]{64}$'
     )
     or (select count(distinct scope_key) from unnest(p_scope_keys) as scope(scope_key))
        <> array_length(p_scope_keys, 1)
     or (select count(distinct split_part(scope_key, ':', 1)) from unnest(p_scope_keys) as scope(scope_key))
        <> array_length(p_scope_keys, 1) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_AUTH_SCOPES: Wajib 1-3 keyed SHA-256 scope credential/IP/device yang unik.';
  end if;

  if p_profile_id is not null then
    select failed_attempts, locked_until
      into v_value_attempts, v_value_blocked_until
    from public.operator_credentials
    where profile_id = p_profile_id;
    if found then
      v_attempts := greatest(v_attempts, v_value_attempts);
      if v_value_blocked_until is not null
         and v_value_blocked_until > v_now
         and (v_blocked_until is null or v_value_blocked_until > v_blocked_until) then
        v_blocked_until := v_value_blocked_until;
      end if;
    end if;
  end if;

  for v_scope_key in
    select scope_key from unnest(p_scope_keys) as scope(scope_key) order by scope_key
  loop
    select attempts, blocked_until
      into v_value_attempts, v_value_blocked_until
    from public.auth_rate_limits
    where scope_key = v_scope_key;
    if found then
      v_attempts := greatest(v_attempts, v_value_attempts);
      if v_value_blocked_until is not null
         and v_value_blocked_until > v_now
         and (v_blocked_until is null or v_value_blocked_until > v_blocked_until) then
        v_blocked_until := v_value_blocked_until;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'blocked', v_blocked_until is not null,
    'blocked_until', v_blocked_until,
    'attempts', v_attempts,
    'retry_after_seconds', case
      when v_blocked_until is not null
        then greatest(1, ceil(extract(epoch from (v_blocked_until - v_now)))::integer)
      else null
    end
  );
end;
$$;
