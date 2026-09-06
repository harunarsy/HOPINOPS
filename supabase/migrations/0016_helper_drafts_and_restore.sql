-- HOPIN Production Migration 0016: Helper-owned stock drafts
--
-- Drafts are private working copies. Every active cycle assignee may maintain
-- their own draft while confirmed opening/closing workflows remain unchanged.

alter table public.stock_opening_drafts
  drop constraint if exists stock_opening_drafts_cycle_id_key,
  add constraint stock_opening_drafts_cycle_owner_key unique (cycle_id, owner_id);

alter table public.stock_closing_drafts
  drop constraint if exists stock_closing_drafts_cycle_id_key,
  add constraint stock_closing_drafts_cycle_owner_key unique (cycle_id, owner_id);

create or replace function public.rpc_save_opening_draft(
  p_actor_id uuid,
  p_cycle_id uuid,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle public.work_cycles%rowtype;
  v_role public.app_role;
  v_draft public.stock_opening_drafts%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_before jsonb;
begin
  if p_cycle_id is null or p_idempotency_key is null
     or jsonb_typeof(p_lines) is distinct from 'array'
     or pg_column_size(p_lines) > 32768
     or jsonb_array_length(p_lines) > 200
     or exists (
       select 1 from jsonb_array_elements(p_lines) as line(value)
       where jsonb_typeof(line.value) <> 'object'
          or not (line.value ?& array['item_id', 'counted_qty'])
          or jsonb_typeof(line.value->'item_id') <> 'string'
          or jsonb_typeof(line.value->'counted_qty') <> 'number'
          or (line.value ? 'reason_code' and jsonb_typeof(line.value->'reason_code') not in ('string', 'null'))
          or (line.value ? 'notes' and jsonb_typeof(line.value->'notes') not in ('string', 'null'))
          or (line.value->>'counted_qty')::numeric < 0
          or (line.value->>'counted_qty')::numeric > 9999999999.9999
     )
     or exists (
       select 1
       from jsonb_array_elements(p_lines) as line(value)
       cross join lateral jsonb_object_keys(
         case when jsonb_typeof(line.value) = 'object' then line.value else '{}'::jsonb end
       ) as key(name)
       where jsonb_typeof(line.value) = 'object'
         and key.name not in ('item_id', 'counted_qty', 'reason_code', 'notes')
     )
     or (select count(distinct line.value->>'item_id') from jsonb_array_elements(p_lines) as line(value))
          <> jsonb_array_length(p_lines) then
    raise exception using errcode = '22023', message = 'INVALID_DRAFT_LINES: Lines draft opening tidak valid.';
  end if;

  select * into v_cycle from public.work_cycles where id = p_cycle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, v_cycle.outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan menyimpan draft opening.';
  end if;
  if v_cycle.status <> 'ACTIVE' then
    raise exception using errcode = '55000', message = 'INVALID_CYCLE_STATE: Draft opening hanya dapat disimpan pada cycle ACTIVE.';
  end if;
  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1 from public.work_assignments assignment
    where assignment.cycle_id = p_cycle_id
      and assignment.profile_id = p_actor_id
      and assignment.duty_role in ('PRIMARY', 'HELPER')
      and assignment.status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Draft opening memerlukan assignment cycle aktif atau manager.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as line(value)
    left join public.items item on item.id = line.value->>'item_id'
    where item.id is null or item.active is not true or item.area_code <> v_cycle.area_code
  ) then
    raise exception using errcode = '22023', message = 'INVALID_DRAFT_ITEM: Semua item draft wajib aktif dan berada pada area cycle.';
  end if;

  v_request := jsonb_build_object('cycle_id', p_cycle_id, 'expected_version', p_expected_version, 'lines', p_lines);
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, v_cycle.outlet_id, 'SAVE_OPENING_DRAFT', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency
  from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = v_cycle.outlet_id
    and action = 'SAVE_OPENING_DRAFT' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  select * into v_draft
  from public.stock_opening_drafts
  where cycle_id = p_cycle_id and owner_id = p_actor_id
  for update;
  if found then
    if p_expected_version is null or v_draft.version <> p_expected_version then
      raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected draft version %s, current version %s.', coalesce(p_expected_version::text, 'NULL'), v_draft.version);
    end if;
    v_before := jsonb_build_object('version', v_draft.version, 'line_count', jsonb_array_length(v_draft.lines_json));
    update public.stock_opening_drafts
    set lines_json = p_lines, version = version + 1, updated_at = clock_timestamp()
    where id = v_draft.id
    returning * into v_draft;
  else
    if p_expected_version is not null then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT: Draft opening belum ada; expected_version harus NULL.';
    end if;
    insert into public.stock_opening_drafts (cycle_id, owner_id, lines_json)
    values (p_cycle_id, p_actor_id, p_lines)
    returning * into v_draft;
  end if;

  v_response := jsonb_build_object(
    'draft_id', v_draft.id, 'cycle_id', v_draft.cycle_id,
    'owner_id', v_draft.owner_id, 'version', v_draft.version,
    'line_count', jsonb_array_length(v_draft.lines_json), 'updated_at', v_draft.updated_at
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = clock_timestamp()
  where actor_user_id = p_actor_id and outlet_id = v_cycle.outlet_id
    and action = 'SAVE_OPENING_DRAFT' and idempotency_key = p_idempotency_key;
  perform public.log_audit_event(
    p_actor_id, 'SAVE_OPENING_DRAFT', 'stock_opening_drafts', v_draft.id::text,
    v_cycle.outlet_id, p_actor_id, v_before, v_response
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

create or replace function public.rpc_save_closing_draft(
  p_actor_id uuid,
  p_cycle_id uuid,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle public.work_cycles%rowtype;
  v_role public.app_role;
  v_draft public.stock_closing_drafts%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_before jsonb;
begin
  if p_cycle_id is null or p_idempotency_key is null
     or jsonb_typeof(p_lines) is distinct from 'array'
     or pg_column_size(p_lines) > 32768
     or jsonb_array_length(p_lines) > 200
     or exists (
       select 1 from jsonb_array_elements(p_lines) as line(value)
       where jsonb_typeof(line.value) <> 'object'
          or not (line.value ?& array['item_id', 'counted_qty'])
          or jsonb_typeof(line.value->'item_id') <> 'string'
          or jsonb_typeof(line.value->'counted_qty') <> 'number'
          or (line.value ? 'reason_code' and jsonb_typeof(line.value->'reason_code') not in ('string', 'null'))
          or (line.value ? 'notes' and jsonb_typeof(line.value->'notes') not in ('string', 'null'))
          or (line.value->>'counted_qty')::numeric < 0
          or (line.value->>'counted_qty')::numeric > 9999999999.9999
     )
     or exists (
       select 1
       from jsonb_array_elements(p_lines) as line(value)
       cross join lateral jsonb_object_keys(
         case when jsonb_typeof(line.value) = 'object' then line.value else '{}'::jsonb end
       ) as key(name)
       where jsonb_typeof(line.value) = 'object'
         and key.name not in ('item_id', 'counted_qty', 'reason_code', 'notes')
     )
     or (select count(distinct line.value->>'item_id') from jsonb_array_elements(p_lines) as line(value))
          <> jsonb_array_length(p_lines) then
    raise exception using errcode = '22023', message = 'INVALID_DRAFT_LINES: Lines draft closing tidak valid.';
  end if;

  select * into v_cycle from public.work_cycles where id = p_cycle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, v_cycle.outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan menyimpan draft closing.';
  end if;
  if v_cycle.shift_code not in ('MALAM', 'FULL')
     or v_cycle.status <> 'OPEN'
     or v_cycle.movement_cutoff_at is not null then
    raise exception using errcode = '55000', message = 'INVALID_CYCLE_STATE: Draft closing hanya dapat disimpan pada cycle MALAM/FULL yang OPEN.';
  end if;
  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1 from public.work_assignments assignment
    where assignment.cycle_id = p_cycle_id
      and assignment.profile_id = p_actor_id
      and assignment.duty_role in ('PRIMARY', 'HELPER')
      and assignment.status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Draft closing memerlukan assignment cycle aktif atau manager.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as line(value)
    left join public.items item on item.id = line.value->>'item_id'
    where item.id is null or item.active is not true or item.area_code <> v_cycle.area_code
  ) then
    raise exception using errcode = '22023', message = 'INVALID_DRAFT_ITEM: Semua item draft wajib aktif dan berada pada area cycle.';
  end if;

  v_request := jsonb_build_object('cycle_id', p_cycle_id, 'expected_version', p_expected_version, 'lines', p_lines);
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, v_cycle.outlet_id, 'SAVE_CLOSING_DRAFT', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency
  from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = v_cycle.outlet_id
    and action = 'SAVE_CLOSING_DRAFT' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  select * into v_draft
  from public.stock_closing_drafts
  where cycle_id = p_cycle_id and owner_id = p_actor_id
  for update;
  if found then
    if p_expected_version is null or v_draft.version <> p_expected_version then
      raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected draft version %s, current version %s.', coalesce(p_expected_version::text, 'NULL'), v_draft.version);
    end if;
    v_before := jsonb_build_object('version', v_draft.version, 'line_count', jsonb_array_length(v_draft.lines_json));
    update public.stock_closing_drafts
    set lines_json = p_lines, version = version + 1, updated_at = clock_timestamp()
    where id = v_draft.id
    returning * into v_draft;
  else
    if p_expected_version is not null then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT: Draft closing belum ada; expected_version harus NULL.';
    end if;
    insert into public.stock_closing_drafts (cycle_id, owner_id, lines_json)
    values (p_cycle_id, p_actor_id, p_lines)
    returning * into v_draft;
  end if;

  v_response := jsonb_build_object(
    'draft_id', v_draft.id, 'cycle_id', v_draft.cycle_id,
    'owner_id', v_draft.owner_id, 'version', v_draft.version,
    'line_count', jsonb_array_length(v_draft.lines_json), 'updated_at', v_draft.updated_at
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = clock_timestamp()
  where actor_user_id = p_actor_id and outlet_id = v_cycle.outlet_id
    and action = 'SAVE_CLOSING_DRAFT' and idempotency_key = p_idempotency_key;
  perform public.log_audit_event(
    p_actor_id, 'SAVE_CLOSING_DRAFT', 'stock_closing_drafts', v_draft.id::text,
    v_cycle.outlet_id, p_actor_id, v_before, v_response
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

create or replace function public.rpc_get_stock_drafts(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_cycle_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_cycle public.work_cycles%rowtype;
  v_opening_draft public.stock_opening_drafts%rowtype;
  v_closing_draft public.stock_closing_drafts%rowtype;
begin
  if p_cycle_id is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Cycle wajib diisi.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);

  select * into v_cycle
  from public.work_cycles
  where id = p_cycle_id;
  if not found or v_cycle.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan pada outlet.';
  end if;

  if v_role::text not in ('OWNER', 'SUPERVISOR') and not (
    v_role::text = 'OPERATOR' and exists (
      select 1
      from public.work_assignments assignment
      where assignment.cycle_id = p_cycle_id
        and assignment.profile_id = p_actor_id
        and assignment.duty_role in ('PRIMARY', 'HELPER')
        and assignment.status = 'ACTIVE'
    )
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Draft stock memerlukan assignment cycle aktif atau manager.';
  end if;

  select * into v_opening_draft
  from public.stock_opening_drafts
  where cycle_id = p_cycle_id and owner_id = p_actor_id;

  select * into v_closing_draft
  from public.stock_closing_drafts
  where cycle_id = p_cycle_id and owner_id = p_actor_id;

  return jsonb_build_object(
    'opening_draft', case when v_opening_draft.id is null then null else jsonb_build_object(
      'lines', v_opening_draft.lines_json,
      'version', v_opening_draft.version,
      'updated_at', v_opening_draft.updated_at
    ) end,
    'closing_draft', case when v_closing_draft.id is null then null else jsonb_build_object(
      'lines', v_closing_draft.lines_json,
      'version', v_closing_draft.version,
      'updated_at', v_closing_draft.updated_at
    ) end
  );
end;
$$;

revoke execute on function public.rpc_save_opening_draft(uuid, uuid, integer, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.rpc_save_closing_draft(uuid, uuid, integer, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.rpc_get_stock_drafts(uuid, uuid, uuid) from public, anon, authenticated;

grant execute on function public.rpc_save_opening_draft(uuid, uuid, integer, uuid, jsonb) to service_role;
grant execute on function public.rpc_save_closing_draft(uuid, uuid, integer, uuid, jsonb) to service_role;
grant execute on function public.rpc_get_stock_drafts(uuid, uuid, uuid) to service_role;
