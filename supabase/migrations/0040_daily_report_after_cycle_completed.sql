-- ---------------------------------------------------------------------------
-- 0040. Laporan harian tetap dapat dikirim walau cycle sudah COMPLETED.
--
-- rpc_submit_daily_report mensyaratkan cycle BAR dan KITCHEN MALAM/FULL
-- berstatus CLOSING_READY. Akibatnya, begitu penanggung jawab BAR menutup
-- assignment-nya (cycle menjadi COMPLETED) sebelum laporan dikirim, laporan
-- tidak akan pernah bisa dikirim lagi -- termasuk oleh OWNER/SUPERVISOR.
--
-- Operasional nyata: closing kedua area jarang selesai bersamaan, sehingga
-- primary BAR bisa sudah check-out saat closing KITCHEN baru terkonfirmasi.
--
-- Perubahan: gerbang status cycle pada rpc_submit_daily_report dilonggarkan
-- dari = 'CLOSING_READY' menjadi in ('CLOSING_READY', 'COMPLETED').
-- Syarat lain tidak berubah: tepat satu closing terkonfirmasi dan lengkap
-- untuk BAR dan KITCHEN pada work_date yang sama, serta validasi finance.
--
-- Fungsi diambil dari 0023_physical_baseline_and_generation_guards.sql.
-- ---------------------------------------------------------------------------

create or replace function public.rpc_submit_daily_report(
  p_outlet_id uuid,
  p_work_date date,
  p_actor_id uuid,
  p_finance jsonb,
  p_checksum text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_outlet_code text;
  v_report public.daily_reports%rowtype;
  v_bar_closing_id uuid;
  v_kitchen_closing_id uuid;
  v_bar_cutoff timestamptz;
  v_kitchen_cutoff timestamptz;
  v_closing_count integer;
  v_expected_count integer;
  v_revision integer;
  v_revision_id uuid;
  v_public_id text;
  v_cash_real numeric;
  v_cash_app numeric;
  v_qris numeric;
  v_debit numeric;
  v_recorded_total numeric;
  v_received_total numeric;
  v_cash_difference numeric;
  v_handover_ids jsonb;
  v_total_item_count integer;
  v_inserted_count integer;
begin
  if p_work_date is null or nullif(btrim(p_checksum), '') is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Tanggal dan checksum wajib diisi.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan mengirim laporan.';
  end if;

  select code into v_outlet_code from public.outlets where id = p_outlet_id and active is true;
  if v_outlet_code is null then
    raise exception using errcode = '22023', message = 'INVALID_OUTLET: Outlet tidak aktif atau tidak ditemukan.';
  end if;

  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where cycle.outlet_id = p_outlet_id
      and cycle.work_date = p_work_date
      and cycle.area_code = 'BAR'
      and cycle.shift_code in ('MALAM', 'FULL')
      and assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY'
      and assignment.status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Submit memerlukan primary BAR MALAM/FULL atau manager dengan scope outlet.';
  end if;

  select count(*) into v_closing_count
  from public.stock_closings closing
  join public.work_cycles cycle on cycle.id = closing.cycle_id
  where cycle.outlet_id = p_outlet_id
    and cycle.work_date = p_work_date
    and cycle.shift_code in ('MALAM', 'FULL')
    and cycle.area_code = 'BAR'
    and cycle.status in ('CLOSING_READY', 'COMPLETED')
    and closing.status = 'CONFIRMED';
  if v_closing_count <> 1 then
    raise exception using errcode = '55000', message = 'BAR_CLOSING_INVALID: Wajib tepat satu closing BAR MALAM/FULL terkonfirmasi.';
  end if;

  select closing.id, closing.movement_cutoff_at
    into v_bar_closing_id, v_bar_cutoff
  from public.stock_closings closing
  join public.work_cycles cycle on cycle.id = closing.cycle_id
  where cycle.outlet_id = p_outlet_id
    and cycle.work_date = p_work_date
    and cycle.shift_code in ('MALAM', 'FULL')
    and cycle.area_code = 'BAR'
    and cycle.status in ('CLOSING_READY', 'COMPLETED')
    and closing.status = 'CONFIRMED'
  for share of closing;

  select count(*) into v_closing_count
  from public.stock_closings closing
  join public.work_cycles cycle on cycle.id = closing.cycle_id
  where cycle.outlet_id = p_outlet_id
    and cycle.work_date = p_work_date
    and cycle.shift_code in ('MALAM', 'FULL')
    and cycle.area_code = 'KITCHEN'
    and cycle.status in ('CLOSING_READY', 'COMPLETED')
    and closing.status = 'CONFIRMED';
  if v_closing_count <> 1 then
    raise exception using errcode = '55000', message = 'KITCHEN_CLOSING_INVALID: Wajib tepat satu closing KITCHEN MALAM/FULL terkonfirmasi.';
  end if;

  select closing.id, closing.movement_cutoff_at
    into v_kitchen_closing_id, v_kitchen_cutoff
  from public.stock_closings closing
  join public.work_cycles cycle on cycle.id = closing.cycle_id
  where cycle.outlet_id = p_outlet_id
    and cycle.work_date = p_work_date
    and cycle.shift_code in ('MALAM', 'FULL')
    and cycle.area_code = 'KITCHEN'
    and cycle.status in ('CLOSING_READY', 'COMPLETED')
    and closing.status = 'CONFIRMED'
  for share of closing;

  -- Closing line membership and metadata snapshots are authoritative. Mutable
  -- catalog rows are intentionally not consulted after closing confirmation.
  select count(*) into v_expected_count
  from public.stock_closing_lines
  where closing_id = v_bar_closing_id;
  if v_expected_count = 0
     or exists (
       select 1
       from public.stock_closing_lines line
       where line.closing_id = v_bar_closing_id
         and (line.item_name_snapshot is null
           or line.unit_code_snapshot is null
           or line.decimal_scale_snapshot is null
           or line.low_threshold_snapshot is null)
     ) then
    raise exception using errcode = '55000', message = 'BAR_CLOSING_INCOMPLETE: Closing BAR tidak memuat tepat semua item referensi closing.';
  end if;
  v_total_item_count := v_expected_count;

  select count(*) into v_expected_count
  from public.stock_closing_lines
  where closing_id = v_kitchen_closing_id;
  if v_expected_count = 0
     or exists (
       select 1
       from public.stock_closing_lines line
       where line.closing_id = v_kitchen_closing_id
         and (line.item_name_snapshot is null
           or line.unit_code_snapshot is null
           or line.decimal_scale_snapshot is null
           or line.low_threshold_snapshot is null)
     ) then
    raise exception using errcode = '55000', message = 'KITCHEN_CLOSING_INCOMPLETE: Closing KITCHEN tidak memuat tepat semua item referensi closing.';
  end if;
  v_total_item_count := v_total_item_count + v_expected_count;

  if jsonb_typeof(p_finance) is distinct from 'object'
     or not (p_finance ?& array['cash_real', 'cash_app', 'qris_mandiri', 'debit_mandiri'])
     or exists (
       select 1 from jsonb_object_keys(p_finance) as object_key(key_name)
       where key_name not in ('cash_real', 'cash_app', 'qris_mandiri', 'debit_mandiri')
     )
     or jsonb_typeof(p_finance->'cash_real') <> 'number'
     or jsonb_typeof(p_finance->'cash_app') <> 'number'
     or jsonb_typeof(p_finance->'qris_mandiri') <> 'number'
     or jsonb_typeof(p_finance->'debit_mandiri') <> 'number' then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE: Empat field finance numerik wajib diisi tanpa field tambahan.';
  end if;

  v_cash_real := (p_finance->>'cash_real')::numeric;
  v_cash_app := (p_finance->>'cash_app')::numeric;
  v_qris := (p_finance->>'qris_mandiri')::numeric;
  v_debit := (p_finance->>'debit_mandiri')::numeric;

  if v_cash_real < 0 or v_cash_app < 0 or v_qris < 0 or v_debit < 0
     or trunc(v_cash_real) <> v_cash_real
     or trunc(v_cash_app) <> v_cash_app
     or trunc(v_qris) <> v_qris
     or trunc(v_debit) <> v_debit
     or v_cash_real::text in ('NaN', 'Infinity', '-Infinity')
     or v_cash_app::text in ('NaN', 'Infinity', '-Infinity')
     or v_qris::text in ('NaN', 'Infinity', '-Infinity')
     or v_debit::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE: Semua nilai finance wajib whole dan nonnegative.';
  end if;

  insert into public.daily_reports (outlet_id, work_date, status, current_revision)
  values (p_outlet_id, p_work_date, 'DRAFT', 0)
  on conflict (outlet_id, work_date) do nothing;

  select * into v_report
  from public.daily_reports
  where outlet_id = p_outlet_id and work_date = p_work_date
  for update;

  if v_report.status not in ('DRAFT', 'NEEDS_CLARIFICATION') then
    raise exception using errcode = '55000', message = 'INVALID_REPORT_STATE: Hanya DRAFT atau NEEDS_CLARIFICATION yang dapat disubmit.';
  end if;

  v_revision := v_report.current_revision + 1;
  v_public_id := upper(v_outlet_code) || '-' || to_char(p_work_date, 'YYYYMMDD') || '-R' || lpad(v_revision::text, 2, '0');
  v_recorded_total := v_cash_app + v_qris + v_debit;
  v_received_total := v_cash_real + v_qris + v_debit;
  v_cash_difference := v_cash_real - v_cash_app;

  select coalesce(jsonb_agg(handover.id order by cycle.area_code), '[]'::jsonb)
    into v_handover_ids
  from public.stock_handovers handover
  join public.work_cycles cycle on cycle.id = handover.cycle_id
  where cycle.outlet_id = p_outlet_id
    and cycle.work_date = p_work_date
    and cycle.shift_code = 'SIANG'
    and handover.status = 'CONFIRMED';

  insert into public.daily_report_revisions (
    report_id, revision, public_id, status, bar_closing_id, kitchen_closing_id,
    handover_ids, movement_cutoff_at, submitted_by, submitted_at, payload_checksum
  ) values (
    v_report.id, v_revision, v_public_id, 'SUBMITTED', v_bar_closing_id, v_kitchen_closing_id,
    v_handover_ids, greatest(v_bar_cutoff, v_kitchen_cutoff), p_actor_id, clock_timestamp(), btrim(p_checksum)
  ) returning id into v_revision_id;

  insert into public.daily_report_finance (
    revision_id, cash_real, cash_app, qris_mandiri, debit_mandiri,
    recorded_total, received_total, cash_difference
  ) values (
    v_revision_id, v_cash_real, v_cash_app, v_qris, v_debit,
    v_recorded_total, v_received_total, v_cash_difference
  );

  insert into public.daily_report_stock_lines (
    revision_id, item_id, area_code, closing_qty, low_threshold_snapshot, stock_status,
    item_name_snapshot, unit_code_snapshot, decimal_scale_snapshot
  )
  select
    v_revision_id,
    line.item_id,
    source.area_code,
    line.counted_qty,
    line.low_threshold_snapshot,
    case
      when line.counted_qty = 0 then 'HABIS'
      when line.counted_qty <= line.low_threshold_snapshot then 'HAMPIR_HABIS'
      else 'AMAN'
    end,
    line.item_name_snapshot,
    line.unit_code_snapshot,
    line.decimal_scale_snapshot
  from public.stock_closing_lines line
  join (values
    (v_bar_closing_id, 'BAR'::public.area_code),
    (v_kitchen_closing_id, 'KITCHEN'::public.area_code)
  ) source(closing_id, area_code) on source.closing_id = line.closing_id;

  get diagnostics v_inserted_count = row_count;
  if v_inserted_count <> v_total_item_count then
    raise exception using errcode = '55000', message = 'INCOMPLETE_REPORT_STOCK: Snapshot laporan tidak memuat semua item aktual.';
  end if;

  update public.daily_reports
  set status = 'SUBMITTED', current_revision = v_revision,
      version = version + 1, updated_at = clock_timestamp()
  where id = v_report.id;

  perform public.log_audit_event(
    p_actor_id, 'SUBMIT_DAILY_REPORT', 'daily_report_revisions', v_revision_id::text,
    p_outlet_id, null, null,
    jsonb_build_object(
      'public_id', v_public_id,
      'revision', v_revision,
      'recorded_total', v_recorded_total,
      'received_total', v_received_total,
      'cash_difference', v_cash_difference
    )
  );

  return jsonb_build_object(
    'report_id', v_report.id,
    'revision_id', v_revision_id,
    'public_id', v_public_id,
    'status', 'SUBMITTED'
  );
end;
$$;

revoke execute on function public.rpc_submit_daily_report(uuid, date, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.rpc_submit_daily_report(uuid, date, uuid, jsonb, text) to service_role;
