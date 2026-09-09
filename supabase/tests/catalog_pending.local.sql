-- Disposable PostgreSQL regression. Run with psql -v ON_ERROR_STOP=1.
begin;
do $$
begin
  if current_database() <> 'hopin_test' or current_setting('port') <> '55432' then
    raise exception 'This fixture may only run in hopin_test on port 55432';
  end if;
end $$;

insert into public.profiles (id, display_name, role, active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Disposable catalog supervisor', 'SUPERVISOR', true);
insert into public.profile_outlet_scopes (profile_id, outlet_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111');
insert into public.profiles (id, display_name, role, active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', 'Disposable catalog primary', 'OPERATOR', true);
insert into public.profile_outlet_scopes (profile_id, outlet_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', '11111111-1111-1111-1111-111111111111');
insert into public.profiles (id, display_name, role, active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'Disposable catalog helper', 'OPERATOR', true);
insert into public.profile_outlet_scopes (profile_id, outlet_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', '11111111-1111-1111-1111-111111111111');

do $$
<<fixture>>
declare
  actor_id uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  outlet_id uuid := '11111111-1111-1111-1111-111111111111';
  cycle_id uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  result jsonb;
  pending_version integer;
  layout_version integer;
  section_id uuid;
begin
  if has_function_privilege('anon', 'public.rpc_catalog_get(uuid,uuid,public.area_code)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rpc_catalog_apply(uuid,uuid,public.area_code,integer,jsonb,jsonb,jsonb,text,uuid)', 'EXECUTE') then
    raise exception 'Catalog RPC leaked direct browser execute privileges';
  end if;

  result := public.rpc_create_item(actor_id, outlet_id, 'regression-current', 'BAR',
    'Current fixture', 'pcs', 0::smallint, 1::numeric);
  result := public.rpc_create_item(actor_id, outlet_id, 'regression-update', 'BAR',
    'Update fixture', 'pcs', 0::smallint, 1::numeric);
  result := public.rpc_create_item(actor_id, outlet_id, 'regression-kitchen', 'KITCHEN',
    'Kitchen fixture', 'pcs', 0::smallint, 1::numeric);
  if not exists(select 1 from public.items where id = 'regression-current' and active) then
    raise exception 'Catalog create without started cycle did not become current';
  end if;

  result := public.rpc_checklist_section_upsert(
    actor_id, outlet_id, 'BAR', null, 'Disposable rack',
    'dddddddd-dddd-4ddd-8ddd-dddddddddda1'
  );
  section_id := (result->'section'->>'id')::uuid;
  layout_version := (result->>'layout_version')::integer;
  result := public.rpc_checklist_item_move(
    actor_id, outlet_id, 'BAR', 'regression-current', section_id, 0,
    layout_version, 'dddddddd-dddd-4ddd-8ddd-dddddddddda2'
  );
  if result->>'layout_version' is null
     or not exists(select 1 from public.item_placements placement
       where placement.item_id = 'regression-current'
         and placement.section_id = fixture.section_id
         and placement.position = 0) then
    raise exception 'Checklist section/reorder did not persist current server order';
  end if;

  insert into public.work_cycles (id, outlet_id, work_date, shift_code, area_code, status)
  values (cycle_id, outlet_id, current_date, 'SIANG', 'BAR', 'ACTIVE');
  insert into public.work_assignments (id, cycle_id, work_date, profile_id, duty_role, status)
  values ('cccccccc-cccc-4ccc-8ccc-cccccccccccb', cycle_id, current_date,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', 'PRIMARY', 'ACTIVE');

  begin
    perform public.rpc_catalog_apply('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      outlet_id, 'BAR', 0, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      'Operator full apply probe', gen_random_uuid());
    raise exception 'OPERATOR full catalog apply was not rejected';
  exception when sqlstate '42501' then
    if position('FORBIDDEN_ROLE' in sqlerrm) = 0 then raise; end if;
  end;

  result := public.rpc_operator_update_item(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', outlet_id, 'regression-update',
    'Primary pending update', 'btl', 2::smallint, 3.5::numeric
  );
  if result->>'effective_mode' <> 'PENDING'
     or (select name from public.items where id = 'regression-update') <> 'Update fixture' then
    raise exception 'PRIMARY update changed the active cycle catalog instead of pending catalog';
  end if;
  if not exists(
    select 1 from public.pending_catalogs p,
      lateral jsonb_array_elements(p.items_json) i
    where p.outlet_id = fixture.outlet_id and p.area_code = 'BAR'
      and i->>'item_id' = 'regression-update'
      and i->>'name' = 'Primary pending update'
      and i->>'unit_code' = 'btl'
      and (i->>'decimal_scale')::smallint = 2
      and (i->>'low_threshold')::numeric = 3.5
  ) then
    raise exception 'PRIMARY update did not persist its pending metadata';
  end if;

  begin
    perform public.rpc_operator_update_item(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', outlet_id, 'regression-update',
      'Helper update', 'pcs', 0::smallint, 1::numeric
    );
    raise exception 'HELPER-equivalent OPERATOR update was not rejected';
  exception when sqlstate '42501' then
    if position('FORBIDDEN_SCOPE' in sqlerrm) = 0 then raise; end if;
  end;

  begin
    perform public.rpc_operator_update_item(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', outlet_id, 'regression-kitchen',
      'Cross area update', 'pcs', 0::smallint, 1::numeric
    );
    raise exception 'PRIMARY cross-area update was not rejected';
  exception when sqlstate '42501' then
    if position('FORBIDDEN_SCOPE' in sqlerrm) = 0 then raise; end if;
  end;

  begin
    insert into public.pending_catalogs (outlet_id, area_code, version, items_json,
      sections_json, placements_json, fingerprint, last_idempotency_key, last_actor_id)
    values (outlet_id, 'KITCHEN', 1,
      '[{"item_id":"zero-active-probe","active":false}]'::jsonb,
      '[]'::jsonb, '[]'::jsonb, 'probe', gen_random_uuid(), actor_id);
    raise exception 'Zero-active pending snapshot was accepted (dead-end possible)';
  exception when sqlstate '22023' then
    if position('INVALID_CATALOG' in sqlerrm) = 0 then raise; end if;
  end;

  result := public.rpc_create_item(actor_id, outlet_id, 'regression-pending', 'BAR',
    'Pending fixture', 'pcs', 0::smallint, 1::numeric);
  if exists(select 1 from public.items where id = 'regression-pending') then
    raise exception 'Pending item leaked into started cycle current catalog';
  end if;
  if not exists(select 1 from public.pending_catalogs p,
    lateral jsonb_array_elements(p.items_json) i
    where p.outlet_id = fixture.outlet_id and i->>'item_id' = 'regression-pending') then
    raise exception 'Pending item was not persisted';
  end if;

  result := public.rpc_archive_item(actor_id, outlet_id, 'regression-current', 'Fixture archive');
  if not exists(select 1 from public.items where id = 'regression-current' and active) then
    raise exception 'Archive changed active cycle catalog';
  end if;
  select p.version into pending_version from public.pending_catalogs p
  where p.outlet_id = fixture.outlet_id and p.area_code = 'BAR';

  update public.work_cycles set status = 'RESET' where id = fixture.cycle_id;
  if not exists(select 1 from public.items where id = 'regression-pending' and active)
     or not exists(select 1 from public.items
       where id = 'regression-update' and active and name = 'Primary pending update'
         and unit_code = 'btl' and decimal_scale = 2 and low_threshold = 3.5)
     or exists(select 1 from public.items where id = 'regression-current' and active) then
    raise exception 'Terminal cycle did not promote accumulated pending changes';
  end if;
  if (select l.version from public.checklist_layouts l
      where l.outlet_id = fixture.outlet_id and l.area_code = 'BAR') <> pending_version then
    raise exception 'Promoted layout version differs from pending version';
  end if;
  raise notice 'PASS: catalog privileges, current create, section/order, pending freeze, accumulation, promotion and version';
end $$;
rollback;
