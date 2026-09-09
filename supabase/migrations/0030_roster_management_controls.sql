-- Safe roster cancellation keeps the record and its audit trail rather than deleting history.
create or replace function public.rpc_cancel_roster(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_roster public.roster_entries%rowtype;
  v_before jsonb;
  v_swap public.shift_swap_requests%rowtype;
  v_swap_before jsonb;
  v_reason text := nullif(btrim(p_reason), '');
  v_now timestamptz := clock_timestamp();
begin
  if p_actor_id is null or p_outlet_id is null or p_entry_id is null
     or p_expected_version is null or p_expected_version <= 0
     or v_reason is null or length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_ROSTER_CANCELLATION: Roster, version, dan alasan pembatalan wajib valid.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER atau SUPERVISOR yang dapat membatalkan roster.';
  end if;

  select * into v_roster
  from public.roster_entries
  where id = p_entry_id
  for update;
  if not found or v_roster.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Roster entry pada outlet tidak ditemukan.';
  end if;
  if v_roster.version <> p_expected_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected roster version %s, current version %s.', p_expected_version, v_roster.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_version, v_roster.version);
  end if;
  if v_role::text = 'SUPERVISOR' then
    if v_roster.profile_id <> p_actor_id and not exists (
      select 1 from public.profiles where id = v_roster.profile_id and role::text = 'OPERATOR'
    ) then
      raise exception using errcode = '42501', message = 'FORBIDDEN: SUPERVISOR tidak dapat membatalkan roster manager lain.';
    end if;
  end if;
  if v_roster.status <> 'SCHEDULED'
     or exists (select 1 from public.work_assignments where roster_entry_id = v_roster.id and status <> 'RESET')
     or exists (select 1 from public.attendance_records where roster_entry_id = v_roster.id) then
    raise exception using errcode = '55000', message = 'ROSTER_LOCKED: Roster yang sudah dipakai operasional tidak dapat dibatalkan.';
  end if;

  v_before := to_jsonb(v_roster);
  update public.roster_entries
  set status = 'CANCELLED', version = version + 1, updated_at = v_now
  where id = v_roster.id
  returning * into v_roster;

  for v_swap in
    select * from public.shift_swap_requests
    where roster_entry_id = v_roster.id and status = 'PENDING'
    for update
  loop
    v_swap_before := to_jsonb(v_swap);
    update public.shift_swap_requests
    set status = 'CANCELLED', responded_at = v_now, version = version + 1
    where id = v_swap.id
    returning * into v_swap;
    perform public.log_audit_event(
      p_actor_id, 'CANCEL_SHIFT_SWAP', 'shift_swap_requests', v_swap.id::text,
      p_outlet_id, v_swap.offered_to, v_swap_before, to_jsonb(v_swap),
      'Roster dibatalkan: ' || v_reason
    );
  end loop;

  perform public.log_audit_event(
    p_actor_id, 'CANCEL_ROSTER', 'roster_entries', v_roster.id::text,
    p_outlet_id, v_roster.profile_id, v_before, to_jsonb(v_roster), v_reason
  );
  return to_jsonb(v_roster);
end;
$$;

revoke execute on function public.rpc_cancel_roster(uuid, uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.rpc_cancel_roster(uuid, uuid, uuid, integer, text) to service_role;
