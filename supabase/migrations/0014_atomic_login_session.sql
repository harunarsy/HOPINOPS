-- HOPIN Production Migration 0014: Atomic Login Session Issuance

create or replace function public.rpc_issue_login_session(
  p_profile_id uuid,
  p_outlet_id uuid,
  p_expected_pin_version integer,
  p_session_token_hash text,
  p_device_token_hash text,
  p_expires_at timestamptz,
  p_absolute_expires_at timestamptz,
  p_ip_hash text default null,
  p_user_agent_hash text default null,
  p_credential_scope_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_profile public.profiles%rowtype;
  v_credential public.operator_credentials%rowtype;
  v_scope public.profile_outlet_scopes%rowtype;
  v_outlet public.outlets%rowtype;
  v_limit public.auth_rate_limits%rowtype;
  v_device_id uuid;
  v_session_id uuid;
begin
  if p_profile_id is null
     or p_outlet_id is null
     or p_expected_pin_version is null
     or p_expected_pin_version <= 0
     or p_session_token_hash is null
     or p_session_token_hash !~ '^[a-f0-9]{64}$'
     or p_device_token_hash is null
     or p_device_token_hash !~ '^[a-f0-9]{64}$'
     or p_session_token_hash = p_device_token_hash
     or p_expires_at is null
     or p_absolute_expires_at is null
     or not isfinite(p_expires_at)
     or not isfinite(p_absolute_expires_at)
     or p_expires_at <= v_now
     or p_absolute_expires_at <= v_now
     or p_expires_at > p_absolute_expires_at
     or p_expires_at - v_now > interval '12 hours'
     or p_absolute_expires_at - v_now > interval '12 hours'
     or (p_ip_hash is not null and p_ip_hash !~ '^[a-f0-9]{64}$')
     or (p_user_agent_hash is not null and p_user_agent_hash !~ '^[a-f0-9]{64}$')
     or (p_credential_scope_key is not null
       and p_credential_scope_key !~ '^credential:[a-f0-9]{64}$') then
    raise exception using
      errcode = '22023',
      message = 'INVALID_LOGIN_SESSION: Profile, outlet, hashes, credential version, atau expiry tidak valid.';
  end if;

  lock table public.outlets in share mode;
  lock table public.profile_outlet_scopes in share mode;

  select * into v_outlet
  from public.outlets
  where id = p_outlet_id and active is true
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'LOGIN_ISSUANCE_REJECTED: Outlet tidak aktif.';
  end if;

  select * into v_profile
  from public.profiles
  where id = p_profile_id and active is true and deactivated_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'LOGIN_ISSUANCE_REJECTED: Profile tidak aktif.';
  end if;

  select * into v_credential
  from public.operator_credentials
  where profile_id = p_profile_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'LOGIN_ISSUANCE_REJECTED: Credential tidak aktif.';
  end if;
  if v_credential.pin_version <> p_expected_pin_version then
    raise exception using errcode = '40001', message = 'CREDENTIAL_CHANGED: PIN berubah selama login.';
  end if;

  select * into v_scope
  from public.profile_outlet_scopes
  where profile_id = p_profile_id and outlet_id = p_outlet_id and active is true
  for update;
  if not found or exists (
    select 1
    from public.profile_outlet_scopes scope
    join public.outlets outlet on outlet.id = scope.outlet_id and outlet.active is true
    where scope.profile_id = p_profile_id
      and scope.active is true
      and scope.outlet_id <> p_outlet_id
  ) then
    raise exception using errcode = '42501', message = 'LOGIN_ISSUANCE_REJECTED: Profile wajib memiliki tepat satu outlet aktif.';
  end if;

  if v_credential.locked_until is not null and v_credential.locked_until > v_now then
    return jsonb_build_object(
      'issued', false,
      'locked', true,
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_credential.locked_until - v_now)))::integer)
    );
  end if;

  if p_credential_scope_key is not null then
    select * into v_limit
    from public.auth_rate_limits
    where scope_key = p_credential_scope_key
    for update;
    if found and v_limit.blocked_until is not null and v_limit.blocked_until > v_now then
      return jsonb_build_object(
        'issued', false,
        'locked', true,
        'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_limit.blocked_until - v_now)))::integer)
      );
    end if;
  end if;

  insert into public.app_devices (
    profile_id,
    device_token_hash,
    first_seen_at,
    last_seen_at,
    last_ip_hash,
    last_user_agent_hash
  ) values (
    p_profile_id,
    p_device_token_hash,
    v_now,
    v_now,
    p_ip_hash,
    p_user_agent_hash
  ) returning id into v_device_id;

  insert into public.app_sessions (
    profile_id,
    token_hash,
    device_id,
    created_at,
    last_seen_at,
    expires_at,
    absolute_expires_at,
    ip_hash,
    user_agent_hash
  ) values (
    p_profile_id,
    p_session_token_hash,
    v_device_id,
    v_now,
    v_now,
    p_expires_at,
    p_absolute_expires_at,
    p_ip_hash,
    p_user_agent_hash
  ) returning id into v_session_id;

  update public.operator_credentials
  set failed_attempts = 0,
      locked_until = null,
      last_failed_at = null
  where profile_id = p_profile_id;

  if p_credential_scope_key is not null then
    insert into public.auth_rate_limits (
      scope_key,
      window_started_at,
      attempts,
      blocked_until,
      updated_at
    ) values (
      p_credential_scope_key,
      v_now,
      0,
      null,
      v_now
    )
    on conflict (scope_key) do update
    set window_started_at = excluded.window_started_at,
        attempts = 0,
        blocked_until = null,
        updated_at = excluded.updated_at;
  end if;

  perform public.log_audit_event(
    p_profile_id,
    'LOGIN_SUCCESS',
    'app_sessions',
    v_session_id::text,
    p_outlet_id,
    p_profile_id,
    null,
    null,
    'User berhasil login dengan PIN',
    null
  );

  return jsonb_build_object(
    'issued', true,
    'locked', false,
    'session_id', v_session_id,
    'device_id', v_device_id
  );
end;
$$;

revoke execute on function public.rpc_issue_login_session(uuid, uuid, integer, text, text, timestamptz, timestamptz, text, text, text) from public, anon, authenticated;
grant execute on function public.rpc_issue_login_session(uuid, uuid, integer, text, text, timestamptz, timestamptz, text, text, text) to service_role;
