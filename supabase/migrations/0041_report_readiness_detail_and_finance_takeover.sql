-- ---------------------------------------------------------------------------
-- 0041. Kesiapan closing di report.get, detail item, ambil alih draft finance,
--       dan keterangan finance opsional.
--
-- 1. rpc_get_report kini mengirim `closing_readiness` (jumlah closing CONFIRMED
--    per area untuk shift MALAM/FULL) dan melengkapi setiap baris stok dengan
--    `item_name`/`unit_code` dari snapshot. Sebelumnya UI menyimpulkan kesiapan
--    closing dari `stock_lines`, yang hanya terisi setelah ada revisi terkirim,
--    sehingga tombol "Kirim Laporan Resmi" terkunci permanen pada laporan yang
--    belum pernah dikirim.
--
--    Draft finance juga dibuka untuk finalizer shift (primary BAR MALAM/FULL
--    ACTIVE), bukan hanya pemilik draft atau manajemen, supaya finalizer dapat
--    menyimpan dan mengirim tanpa memblokir pemilik draft sebelumnya.
--
-- 2. rpc_save_report_finance tidak lagi mengunci draft ke pemilik pertama.
--    Otorisasi finalizer/manajemen sudah diverifikasi sebelum titik ini, jadi
--    aktor yang lolos boleh mengambil alih draft dan menjadi pemilik baru.
--    Ini mencegah DRAFT_OWNED_BY_OTHER saat penanggung jawab laporan berganti.
--
-- 3. Keterangan finance (`note`) bersifat OPSIONAL dan tidak pernah wajib.
--    Nilainya ikut tersimpan di draft, di finance revisi terkirim, dan
--    ditampilkan pada ringkasan serta template salin. Catatan kosong dianggap
--    tidak ada (disimpan sebagai NULL).
--
-- rpc_submit_daily_report diambil dari 0040_daily_report_after_cycle_completed.sql;
-- hanya validasi finance, penyimpanan note, dan audit yang berubah.
-- ---------------------------------------------------------------------------

alter table public.daily_report_finance add column if not exists note text;
alter table public.daily_report_finance drop constraint if exists daily_report_finance_note_length;
alter table public.daily_report_finance add constraint daily_report_finance_note_length
  check (note is null or length(note) between 1 and 500);

create or replace function public.rpc_get_report(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_work_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_report public.daily_reports%rowtype;
  v_revision public.daily_report_revisions%rowtype;
  v_draft public.daily_report_finance_drafts%rowtype;
  v_allowed boolean := false;
  v_can_finalize boolean := false;
  v_result jsonb;
begin
  if p_work_date is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Work date wajib diisi.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);

  select * into v_report
  from public.daily_reports
  where outlet_id = p_outlet_id and work_date = p_work_date;
  if found and v_report.current_revision > 0 then
    select * into v_revision
    from public.daily_report_revisions
    where report_id = v_report.id and revision = v_report.current_revision;
  end if;

  -- Cermin gate rpc_submit_daily_report: finalizer adalah primary BAR
  -- MALAM/FULL ACTIVE pada tanggal kerja ini, atau manajemen outlet.
  v_can_finalize := v_role::text in ('OWNER', 'SUPERVISOR') or exists (
    select 1
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY'
      and assignment.status = 'ACTIVE'
      and cycle.outlet_id = p_outlet_id
      and cycle.work_date = p_work_date
      and cycle.area_code = 'BAR'
      and cycle.shift_code in ('MALAM', 'FULL')
  );

  if v_role::text in ('OWNER', 'SUPERVISOR') then
    v_allowed := true;
  elsif v_revision.id is not null and (
    v_revision.submitted_by = p_actor_id
    or exists (
      select 1 from public.daily_report_shares share
      where share.revision_id = v_revision.id and share.recipient_id = p_actor_id
    )
  ) then
    v_allowed := true;
  elsif exists (
    select 1
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY'
      and assignment.status <> 'RESET'
      and cycle.outlet_id = p_outlet_id
      and cycle.work_date = p_work_date
      and cycle.shift_code in ('MALAM', 'FULL')
  ) then
    v_allowed := true;
  end if;

  select * into v_draft
  from public.daily_report_finance_drafts
  where outlet_id = p_outlet_id and work_date = p_work_date;

  if not v_allowed and (v_draft.id is null or v_draft.owner_id <> p_actor_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Actor tidak berhak membaca laporan ini.';
  end if;
  if v_report.id is null and v_draft.id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Laporan dan draft finance tidak ditemukan.';
  end if;

  v_result := jsonb_build_object(
    'report', case when v_report.id is null then null else to_jsonb(v_report) end,
    'revision', case when v_revision.id is null then null else to_jsonb(v_revision) end,
    'finance', case when v_revision.id is null then null else (
      select to_jsonb(finance) from public.daily_report_finance finance where finance.revision_id = v_revision.id
    ) end,
    'stock_lines', case when v_revision.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(
        to_jsonb(line) || jsonb_build_object(
          'item_name', line.item_name_snapshot,
          'unit_code', line.unit_code_snapshot
        )
        order by line.area_code, line.item_name_snapshot nulls last, line.item_id
      )
      from public.daily_report_stock_lines line
      where line.revision_id = v_revision.id
    ), '[]'::jsonb) end,
    'closing_readiness', jsonb_build_object(
      'bar', jsonb_build_object('confirmed_closings', (
        select count(*)
        from public.stock_closings closing
        join public.work_cycles cycle on cycle.id = closing.cycle_id
        where cycle.outlet_id = p_outlet_id
          and cycle.work_date = p_work_date
          and cycle.shift_code in ('MALAM', 'FULL')
          and cycle.area_code = 'BAR'
          and cycle.status in ('CLOSING_READY', 'COMPLETED')
          and closing.status = 'CONFIRMED'
      )),
      'kitchen', jsonb_build_object('confirmed_closings', (
        select count(*)
        from public.stock_closings closing
        join public.work_cycles cycle on cycle.id = closing.cycle_id
        where cycle.outlet_id = p_outlet_id
          and cycle.work_date = p_work_date
          and cycle.shift_code in ('MALAM', 'FULL')
          and cycle.area_code = 'KITCHEN'
          and cycle.status in ('CLOSING_READY', 'COMPLETED')
          and closing.status = 'CONFIRMED'
      ))
    ),
    'finance_draft', case
      when v_draft.id is not null and (v_draft.owner_id = p_actor_id or v_can_finalize)
      then to_jsonb(v_draft)
      else null
    end
  );
  perform public.log_audit_event(
    p_actor_id, 'VIEW_REPORT', 'daily_reports', coalesce(v_report.id::text, v_draft.id::text),
    p_outlet_id, null, null,
    jsonb_build_object('revision_id', v_revision.id, 'has_finance_draft', v_draft.id is not null)
  );
  return v_result;
end;
$$;

create or replace function public.rpc_save_report_finance(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_work_date date,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_finance jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_report public.daily_reports%rowtype;
  v_draft public.daily_report_finance_drafts%rowtype;
  v_idempotency public.workflow_idempotency%rowtype;
  v_request jsonb;
  v_response jsonb;
  v_before jsonb;
  v_finance jsonb;
  v_note text;
  v_cash_real numeric;
  v_cash_app numeric;
  v_qris numeric;
  v_debit numeric;
begin
  if p_work_date is null or p_idempotency_key is null
     or jsonb_typeof(p_finance) is distinct from 'object'
     or pg_column_size(p_finance) > 8192
     or not (p_finance ?& array['cash_real', 'cash_app', 'qris_mandiri', 'debit_mandiri'])
     or exists (
       select 1 from jsonb_object_keys(p_finance) as key(name)
       where key.name not in ('cash_real', 'cash_app', 'qris_mandiri', 'debit_mandiri', 'note')
     )
     or jsonb_typeof(p_finance->'cash_real') <> 'number'
     or jsonb_typeof(p_finance->'cash_app') <> 'number'
     or jsonb_typeof(p_finance->'qris_mandiri') <> 'number'
     or jsonb_typeof(p_finance->'debit_mandiri') <> 'number'
     or (p_finance ? 'note' and jsonb_typeof(p_finance->'note') not in ('string', 'null'))
     or (p_finance ? 'note' and jsonb_typeof(p_finance->'note') = 'string'
         and length(btrim(p_finance->>'note')) > 500) then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE: Empat field finance numerik wajib diisi, keterangan opsional maksimal 500 karakter.';
  end if;

  v_cash_real := (p_finance->>'cash_real')::numeric;
  v_cash_app := (p_finance->>'cash_app')::numeric;
  v_qris := (p_finance->>'qris_mandiri')::numeric;
  v_debit := (p_finance->>'debit_mandiri')::numeric;
  if v_cash_real < 0 or v_cash_app < 0 or v_qris < 0 or v_debit < 0
     or v_cash_real > 99999999999999 or v_cash_app > 99999999999999
     or v_qris > 99999999999999 or v_debit > 99999999999999
     or trunc(v_cash_real) <> v_cash_real or trunc(v_cash_app) <> v_cash_app
     or trunc(v_qris) <> v_qris or trunc(v_debit) <> v_debit
     or v_cash_real::text in ('NaN', 'Infinity', '-Infinity')
     or v_cash_app::text in ('NaN', 'Infinity', '-Infinity')
     or v_qris::text in ('NaN', 'Infinity', '-Infinity')
     or v_debit::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE: Semua nilai finance wajib whole dan nonnegative.';
  end if;

  -- Keterangan selalu opsional: kosong/whitespace/JSON null menjadi NULL.
  v_note := nullif(btrim(coalesce(p_finance->>'note', '')), '');
  v_finance := case
    when v_note is null then p_finance - 'note'
    else jsonb_set(p_finance, '{note}', to_jsonb(v_note))
  end;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan menyimpan finance laporan.';
  end if;
  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where assignment.profile_id = p_actor_id
      and assignment.duty_role = 'PRIMARY'
      and assignment.status = 'ACTIVE'
      and cycle.outlet_id = p_outlet_id
      and cycle.work_date = p_work_date
      and cycle.area_code = 'BAR'
      and cycle.shift_code in ('MALAM', 'FULL')
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Finance laporan memerlukan primary BAR MALAM/FULL atau manager.';
  end if;

  -- Serialize the no-parent-yet path without taking a global table lock.
  perform pg_advisory_xact_lock(hashtextextended(p_outlet_id::text || ':' || p_work_date::text, 0));
  v_request := jsonb_build_object('work_date', p_work_date, 'expected_version', p_expected_version, 'finance', v_finance);
  insert into public.workflow_idempotency (
    actor_user_id, outlet_id, action, idempotency_key, request_json
  ) values (
    p_actor_id, p_outlet_id, 'SAVE_REPORT_FINANCE', p_idempotency_key, v_request
  ) on conflict do nothing;
  select * into v_idempotency
  from public.workflow_idempotency
  where actor_user_id = p_actor_id and outlet_id = p_outlet_id
    and action = 'SAVE_REPORT_FINANCE' and idempotency_key = p_idempotency_key
  for update;
  if v_idempotency.request_json is distinct from v_request then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED: Idempotency key tidak boleh dipakai untuk payload berbeda.';
  end if;
  if v_idempotency.response_json is not null then
    return v_idempotency.response_json || jsonb_build_object('idempotent_replay', true);
  end if;

  -- Materialize and lock the parent before the draft. Existing submission locks
  -- this same row, so finance cannot commit after the report becomes immutable.
  insert into public.daily_reports (outlet_id, work_date, status, current_revision)
  values (p_outlet_id, p_work_date, 'DRAFT', 0)
  on conflict (outlet_id, work_date) do nothing;
  select * into v_report
  from public.daily_reports
  where outlet_id = p_outlet_id and work_date = p_work_date
  for update;
  if found and v_report.status not in ('DRAFT', 'NEEDS_CLARIFICATION') then
    raise exception using errcode = '55000', message = 'REPORT_IMMUTABLE: Finance draft tidak dapat diubah setelah laporan dikirim atau disetujui.';
  end if;

  select * into v_draft
  from public.daily_report_finance_drafts
  where outlet_id = p_outlet_id and work_date = p_work_date
  for update;
  if found then
    -- Aktor yang sampai di sini sudah terverifikasi sebagai finalizer shift
    -- atau manajemen, jadi draft milik orang lain boleh diambil alih.
    if p_expected_version is null or v_draft.version <> p_expected_version then
      raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected finance draft version %s, current version %s.', coalesce(p_expected_version::text, 'NULL'), v_draft.version);
    end if;
    v_before := jsonb_build_object('version', v_draft.version, 'owner_id', v_draft.owner_id);
    update public.daily_report_finance_drafts
    set finance_json = v_finance, version = version + 1, owner_id = p_actor_id, updated_at = clock_timestamp()
    where id = v_draft.id
    returning * into v_draft;
  else
    if p_expected_version is not null then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT: Draft finance belum ada; expected_version harus NULL.';
    end if;
    insert into public.daily_report_finance_drafts (outlet_id, work_date, owner_id, finance_json)
    values (p_outlet_id, p_work_date, p_actor_id, v_finance)
    returning * into v_draft;
  end if;

  v_response := jsonb_build_object(
    'draft_id', v_draft.id, 'outlet_id', v_draft.outlet_id,
    'work_date', v_draft.work_date, 'owner_id', v_draft.owner_id,
    'version', v_draft.version, 'updated_at', v_draft.updated_at
  );
  update public.workflow_idempotency
  set response_json = v_response, completed_at = clock_timestamp()
  where actor_user_id = p_actor_id and outlet_id = p_outlet_id
    and action = 'SAVE_REPORT_FINANCE' and idempotency_key = p_idempotency_key;
  perform public.log_audit_event(
    p_actor_id, 'SAVE_REPORT_FINANCE', 'daily_report_finance_drafts', v_draft.id::text,
    p_outlet_id, p_actor_id, v_before, v_response
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

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
  v_note text;
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
       where key_name not in ('cash_real', 'cash_app', 'qris_mandiri', 'debit_mandiri', 'note')
     )
     or jsonb_typeof(p_finance->'cash_real') <> 'number'
     or jsonb_typeof(p_finance->'cash_app') <> 'number'
     or jsonb_typeof(p_finance->'qris_mandiri') <> 'number'
     or jsonb_typeof(p_finance->'debit_mandiri') <> 'number'
     or (p_finance ? 'note' and jsonb_typeof(p_finance->'note') not in ('string', 'null'))
     or (p_finance ? 'note' and jsonb_typeof(p_finance->'note') = 'string'
         and length(btrim(p_finance->>'note')) > 500) then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE: Empat field finance numerik wajib diisi, keterangan opsional maksimal 500 karakter.';
  end if;

  v_cash_real := (p_finance->>'cash_real')::numeric;
  v_cash_app := (p_finance->>'cash_app')::numeric;
  v_qris := (p_finance->>'qris_mandiri')::numeric;
  v_debit := (p_finance->>'debit_mandiri')::numeric;
  v_note := nullif(btrim(coalesce(p_finance->>'note', '')), '');

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
    recorded_total, received_total, cash_difference, note
  ) values (
    v_revision_id, v_cash_real, v_cash_app, v_qris, v_debit,
    v_recorded_total, v_received_total, v_cash_difference, v_note
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
      'cash_difference', v_cash_difference,
      'note', v_note
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

revoke execute on function public.rpc_get_report(uuid, uuid, date) from public, anon, authenticated;
revoke execute on function public.rpc_save_report_finance(uuid, uuid, date, integer, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.rpc_submit_daily_report(uuid, date, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.rpc_get_report(uuid, uuid, date) to service_role;
grant execute on function public.rpc_save_report_finance(uuid, uuid, date, integer, uuid, jsonb) to service_role;
grant execute on function public.rpc_submit_daily_report(uuid, date, uuid, jsonb, text) to service_role;
