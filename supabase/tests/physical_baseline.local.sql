-- Disposable PostgreSQL regression. Run with psql -v ON_ERROR_STOP=1.
begin;
do $$
begin
  if current_database() <> 'hopin_test' or current_setting('port') <> '55432' then
    raise exception 'This fixture may only run in hopin_test on port 55432';
  end if;
end $$;

insert into public.profiles (id, display_name, role, active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', 'Disposable baseline primary', 'OPERATOR', true);
insert into public.profile_outlet_scopes (profile_id, outlet_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', '11111111-1111-1111-1111-111111111111');
insert into public.profiles (id, display_name, role, active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'Disposable baseline helper', 'OPERATOR', true),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad', 'Disposable baseline investor', 'INVESTOR', true);
insert into public.profile_outlet_scopes (profile_id, outlet_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', '11111111-1111-1111-1111-111111111111'),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad', '11111111-1111-1111-1111-111111111111');
insert into public.work_cycles (id, outlet_id, work_date, shift_code, area_code, status, version)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc', '11111111-1111-1111-1111-111111111111',
  current_date + 30, 'FULL', 'BAR', 'ACTIVE', 1);
insert into public.work_assignments (id, cycle_id, work_date, profile_id, duty_role, status)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',
  current_date + 30, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', 'PRIMARY', 'ACTIVE'),
       ('cccccccc-cccc-4ccc-8ccc-cccccccccccd', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',
  current_date + 30, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'HELPER', 'ACTIVE');

do $$
<<fixture>>
declare
  actor_id uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
  outlet_id uuid := '11111111-1111-1111-1111-111111111111';
  cycle_id uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
  idem uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  baseline_lines jsonb;
  opening_lines jsonb;
  before_reference jsonb;
  after_reference jsonb;
  first_result jsonb;
  replay_result jsonb;
  opening_result jsonb;
begin
  begin
    perform public.rpc_get_cycle_physical_baseline(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', outlet_id, cycle_id);
    raise exception 'HELPER baseline read was not rejected';
  exception when sqlstate '42501' then
    if position('FORBIDDEN' in sqlerrm) = 0 then raise; end if;
  end;
  begin
    perform public.rpc_get_opening_reference(
      cycle_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad');
    raise exception 'INVESTOR reference read was not rejected';
  exception when sqlstate '42501' then
    if position('FORBIDDEN' in sqlerrm) = 0 then raise; end if;
  end;

  before_reference := public.rpc_get_opening_reference(cycle_id, actor_id);
  if before_reference->>'state' <> 'INITIALIZATION_REQUIRED'
     or jsonb_array_length(before_reference->'missing_item_ids') <> 8 then
    raise exception 'Fresh BAR cycle did not request all eight explicit baselines: %', before_reference;
  end if;

  select jsonb_agg(jsonb_build_object('item_id', id, 'counted_qty', 0) order by id)
  into baseline_lines from public.items where area_code = 'BAR' and active;
  first_result := public.rpc_record_cycle_physical_baseline(
    actor_id, outlet_id, cycle_id, 1, baseline_lines,
    'Disposable explicit physical count', idem
  );
  replay_result := public.rpc_record_cycle_physical_baseline(
    actor_id, outlet_id, cycle_id, 1, baseline_lines,
    'Disposable explicit physical count', idem
  );
  if first_result->>'idempotent_replay' <> 'false'
     or replay_result->>'idempotent_replay' <> 'true'
     or first_result->>'baseline_id' <> replay_result->>'baseline_id' then
    raise exception 'Physical baseline replay did not return the original receipt';
  end if;

  after_reference := public.rpc_get_opening_reference(cycle_id, actor_id);
  if after_reference->>'state' <> 'AVAILABLE'
     or jsonb_array_length(after_reference->'lines') <> 8
     or exists(select 1 from jsonb_array_elements(after_reference->'lines') line
       where line->>'source_type' <> 'PHYSICAL_BASELINE'
          or (line->>'reference_qty')::numeric <> 0) then
    raise exception 'Explicit physical baseline was not frozen as the cycle reference: %', after_reference;
  end if;

  select jsonb_agg(jsonb_build_object(
    'item_id', line->>'item_id', 'counted_qty', (line->>'reference_qty')::numeric,
    'reason_code', null, 'notes', null
  ) order by line->>'item_id') into opening_lines
  from jsonb_array_elements(after_reference->'lines') line;
  opening_result := public.rpc_confirm_opening(cycle_id, actor_id, opening_lines);
  if opening_result->>'status' <> 'CONFIRMED'
     or (select status from public.work_cycles where id = fixture.cycle_id) <> 'OPEN'
     or (select count(*) from public.stock_opening_lines line
         join public.stock_openings opening on opening.id = line.opening_id
         where opening.cycle_id = fixture.cycle_id) <> 8 then
    raise exception 'Opening did not consume the frozen physical reference';
  end if;
  raise notice 'PASS: explicit physical baseline, replay, frozen reference and opening';
end $$;
rollback;
