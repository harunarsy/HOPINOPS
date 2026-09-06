-- 0019_onboarding_lifetime_completion.sql
-- Enforce Decision B04 at DB/RPC level:
-- 1. Operator onboarding is completed once per user lifetime.
-- 2. If actor already has a valid completed onboarding (any version), return it idempotently without requiring new outlet version.
-- 3. Strict authorization verification via require_authorized_actor() (active actor, scope, outlet).
-- 4. Consistent lock order (profiles -> outlet_settings -> onboarding_progress) to prevent deadlocks.
-- 5. Atomic audit logging only upon first actual completion.

create or replace function public.rpc_complete_onboarding(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_onboarding_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_current_version integer;
  v_progress public.onboarding_progress%rowtype;
  v_before jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_onboarding_version is null or p_onboarding_version <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Onboarding version wajib positif.';
  end if;

  -- 1. Verify actor is active, has active scope on active outlet, and force_pin_change is false
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Guided onboarding hanya untuk OPERATOR.';
  end if;

  -- 2. Lock actor profile (prevent concurrent onboarding completions for this actor)
  perform 1 from public.profiles where id = p_actor_id for update;

  -- 3. Lock and read outlet settings
  select onboarding_version into v_current_version
  from public.outlet_settings
  where outlet_id = p_outlet_id
  for share;

  if not found or v_current_version is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Pengaturan outlet tidak ditemukan.';
  end if;

  -- 4. Decision B04 Lifetime Rule: check if actor already has ANY valid completion
  select * into v_progress
  from public.onboarding_progress
  where profile_id = p_actor_id
    and completed_at is not null
  order by completed_at desc
  limit 1
  for update;

  if found then
    -- Actor already completed onboarding in the past.
    -- Return existing completion idempotently without forcing retraining or duplicate audit log.
    return to_jsonb(v_progress) || jsonb_build_object('idempotent_replay', true);
  end if;

  -- 5. Actor has never completed onboarding: validate material version being completed
  if v_current_version <> p_onboarding_version then
    raise exception using errcode = '40001',
      message = format('VERSION_CONFLICT: Current onboarding version is %s.', v_current_version::text);
  end if;

  -- 6. Lock existing in-progress row for this specific version if present
  select * into v_progress
  from public.onboarding_progress
  where profile_id = p_actor_id and onboarding_version = p_onboarding_version
  for update;

  v_before := case when found then to_jsonb(v_progress) else null end;

  if v_progress.profile_id is null then
    insert into public.onboarding_progress (
      profile_id, onboarding_version, started_at, completed_at, replay_count, updated_at
    ) values (
      p_actor_id, p_onboarding_version, v_now, v_now, 0, v_now
    ) returning * into v_progress;
  else
    update public.onboarding_progress
    set completed_at = v_now, updated_at = v_now
    where profile_id = p_actor_id and onboarding_version = p_onboarding_version
    returning * into v_progress;
  end if;

  -- 7. Audit event logged atomically only upon initial completion
  perform public.log_audit_event(
    p_actor_id, 'COMPLETE_ONBOARDING', 'onboarding_progress',
    p_actor_id::text || ':' || p_onboarding_version::text,
    p_outlet_id, p_actor_id, v_before, to_jsonb(v_progress)
  );

  return to_jsonb(v_progress) || jsonb_build_object('idempotent_replay', false);
end;
$$;

revoke execute on function public.rpc_complete_onboarding(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.rpc_complete_onboarding(uuid, uuid, integer) to service_role;
