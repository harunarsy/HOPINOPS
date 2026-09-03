-- HOPIN Production Migration 0008: Commands, Privileges, Audit & Transactional RPCs

-- Audit context used by all transactional commands.
alter table public.audit_events
  add column if not exists outlet_id uuid references public.outlets(id),
  add column if not exists subject_user_id uuid references public.profiles(id),
  add column if not exists ip_hash text,
  add column if not exists metadata_json jsonb;

alter table public.payroll_runs
  add column if not exists reviewed_at timestamptz,
  add column if not exists payment_reference text,
  add column if not exists payment_reason text,
  add column if not exists paid_by uuid references public.profiles(id),
  add column if not exists paid_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists voided_by uuid references public.profiles(id),
  add column if not exists voided_at timestamptz,
  add column if not exists replacement_run_id uuid;

alter table public.payroll_runs
  drop constraint if exists payroll_runs_replacement_run_id_fkey,
  add constraint payroll_runs_replacement_run_id_fkey
    foreign key (replacement_run_id) references public.payroll_runs(id)
    deferrable initially deferred,
  drop constraint if exists payroll_runs_review_metadata_check,
  add constraint payroll_runs_review_metadata_check check (
    (reviewed_by is null and reviewed_at is null)
    or (reviewed_by is not null and reviewed_at is not null)
  ),
  drop constraint if exists payroll_runs_payment_metadata_check,
  add constraint payroll_runs_payment_metadata_check check (
    (status = 'PAID' and paid_by is not null and paid_at is not null
      and nullif(btrim(payment_reference), '') is not null
      and nullif(btrim(payment_reason), '') is not null)
    or (status = 'VOID' and (
      (paid_by is null and paid_at is null and payment_reference is null and payment_reason is null)
      or (paid_by is not null and paid_at is not null
        and nullif(btrim(payment_reference), '') is not null
        and nullif(btrim(payment_reason), '') is not null)
    ))
    or (status not in ('PAID', 'VOID') and paid_by is null and paid_at is null
      and payment_reference is null and payment_reason is null)
  ),
  drop constraint if exists payroll_runs_void_metadata_check,
  add constraint payroll_runs_void_metadata_check check (
    (status = 'VOID' and voided_by is not null and voided_at is not null
      and nullif(btrim(void_reason), '') is not null
      and replacement_run_id is not null and replacement_run_id <> id)
    or (status <> 'VOID' and voided_by is null and voided_at is null and void_reason is null)
  );

-- Prepare period uniqueness for a future schema-supported VOID/replacement path.
-- Until reason/reference columns exist, the payroll state trigger fails VOID closed.
alter table public.payroll_runs
  drop constraint if exists payroll_runs_outlet_period_uniq;
drop index if exists public.payroll_runs_outlet_period_uniq;
create unique index if not exists payroll_runs_outlet_period_nonvoid_uniq
  on public.payroll_runs (outlet_id, period_month)
  where status <> 'VOID';

-- Central positive authorization. Every operational RPC calls this before mutation.
create or replace function public.require_authorized_actor(
  p_actor_id uuid,
  p_outlet_id uuid
)
returns public.app_role
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
begin
  if p_actor_id is null or p_outlet_id is null then
    raise exception using
      errcode = '42501',
      message = 'AUTHORIZATION_FAILED: Actor dan outlet wajib diisi.';
  end if;

  select profile.role
    into v_role
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id
   and scope.outlet_id = p_outlet_id
   and scope.active is true
  join public.outlets outlet
    on outlet.id = scope.outlet_id
   and outlet.active is true
  where profile.id = p_actor_id
    and profile.active is true
    and profile.deactivated_at is null
    and profile.force_pin_change is false;

  if v_role is null then
    raise exception using
      errcode = '42501',
      message = 'AUTHORIZATION_FAILED: Actor tidak aktif, belum siap, atau tidak memiliki scope outlet aktif.';
  end if;

  return v_role;
end;
$$;

create or replace function public.log_audit_event(
  p_actor_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_outlet_id uuid default null,
  p_subject_id uuid default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null,
  p_ip_hash text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.audit_events (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    outlet_id,
    subject_user_id,
    before_json,
    after_json,
    reason,
    ip_hash,
    server_occurred_at
  ) values (
    p_actor_id,
    p_action,
    p_entity_type,
    p_entity_id,
    p_outlet_id,
    p_subject_id,
    p_before,
    p_after,
    p_reason,
    p_ip_hash,
    clock_timestamp()
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- Immutability and parent-state enforcement.
create or replace function public.enforce_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception using
    errcode = '55000',
    message = format('APPEND_ONLY: %s tidak boleh diubah atau dihapus.', tg_table_name);
end;
$$;

create or replace function public.enforce_stock_snapshot_parent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = 'CONFIRMED' then
    raise exception using
      errcode = '55000',
      message = format('IMMUTABLE_SNAPSHOT: %s yang sudah dikonfirmasi tidak boleh diubah atau dihapus.', tg_table_name);
  end if;

  if tg_op = 'UPDATE' then
    if old.status <> 'DRAFT' or new.status <> 'CONFIRMED' then
      raise exception using
        errcode = '55000',
        message = 'INVALID_SNAPSHOT_TRANSITION: Hanya transisi DRAFT ke CONFIRMED yang diizinkan.';
    end if;

    if new.confirmed_at is null or new.confirmed_by is null then
      raise exception using
        errcode = '23514',
        message = 'INVALID_CONFIRMATION_METADATA: Actor dan waktu konfirmasi wajib diisi.';
    end if;

    if (to_jsonb(new) - 'status' - 'confirmed_at' - 'confirmed_by' - 'version' - 'updated_at')
         is distinct from
       (to_jsonb(old) - 'status' - 'confirmed_at' - 'confirmed_by' - 'version' - 'updated_at') then
      raise exception using
        errcode = '55000',
        message = 'IMMUTABLE_SNAPSHOT_PAYLOAD: Payload snapshot tidak boleh berubah saat konfirmasi.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_stock_snapshot_line_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parent_status text;
  v_parent_id uuid;
begin
  if tg_table_name = 'stock_opening_lines' then
    if tg_op = 'UPDATE' and new.opening_id is distinct from old.opening_id then
      raise exception using errcode = '55000', message = 'IMMUTABLE_PARENT: Parent opening line tidak boleh diganti.';
    end if;
    v_parent_id := case when tg_op = 'INSERT' then new.opening_id else old.opening_id end;
    select status into v_parent_status from public.stock_openings where id = v_parent_id;
  elsif tg_table_name = 'stock_handover_lines' then
    if tg_op = 'UPDATE' and new.handover_id is distinct from old.handover_id then
      raise exception using errcode = '55000', message = 'IMMUTABLE_PARENT: Parent handover line tidak boleh diganti.';
    end if;
    v_parent_id := case when tg_op = 'INSERT' then new.handover_id else old.handover_id end;
    select status into v_parent_status from public.stock_handovers where id = v_parent_id;
  elsif tg_table_name = 'stock_closing_lines' then
    if tg_op = 'UPDATE' and new.closing_id is distinct from old.closing_id then
      raise exception using errcode = '55000', message = 'IMMUTABLE_PARENT: Parent closing line tidak boleh diganti.';
    end if;
    v_parent_id := case when tg_op = 'INSERT' then new.closing_id else old.closing_id end;
    select status into v_parent_status from public.stock_closings where id = v_parent_id;
  else
    raise exception 'Unsupported stock snapshot table: %', tg_table_name;
  end if;

  if v_parent_status is null then
    raise exception using errcode = '23503', message = 'PARENT_NOT_FOUND: Snapshot induk tidak ditemukan.';
  end if;

  if v_parent_status = 'CONFIRMED' then
    raise exception using
      errcode = '55000',
      message = format('IMMUTABLE_SNAPSHOT: Baris %s pada snapshot terkonfirmasi tidak boleh dimutasi.', tg_table_name);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_report_revision_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status <> 'SUBMITTED'
     or new.status not in ('APPROVED', 'NEEDS_CLARIFICATION') then
    raise exception using
      errcode = '55000',
      message = 'INVALID_REPORT_TRANSITION: Hanya revisi SUBMITTED yang dapat direview sekali.';
  end if;

  if (to_jsonb(new) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note')
       is distinct from
     (to_jsonb(old) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note') then
    raise exception using
      errcode = '55000',
      message = 'IMMUTABLE_REPORT: Review hanya boleh mengubah status dan metadata review.';
  end if;

  if new.reviewed_by is null or new.reviewed_at is null then
    raise exception using
      errcode = '23514',
      message = 'INVALID_REVIEW_METADATA: Reviewer dan waktu review wajib diisi.';
  end if;

  return new;
end;
$$;

create or replace function public.enforce_report_line_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revision_id uuid;
  v_status text;
begin
  if tg_op <> 'INSERT' then
    raise exception using
      errcode = '55000',
      message = format('APPEND_ONLY: %s tidak boleh diubah atau dihapus.', tg_table_name);
  end if;

  v_revision_id := new.revision_id;
  select status into v_status
  from public.daily_report_revisions
  where id = v_revision_id;

  if v_status is distinct from 'SUBMITTED' then
    raise exception using
      errcode = '55000',
      message = 'INVALID_PARENT_STATE: Baris laporan hanya dapat ditambahkan ke revisi SUBMITTED.';
  end if;

  return new;
end;
$$;

create or replace function public.enforce_bonus_pool_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and old.status = 'FINAL' then
    raise exception using errcode = '55000', message = 'IMMUTABLE_BONUS: Bonus final tidak boleh dihapus.';
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'FINAL' then
      raise exception using errcode = '55000', message = 'IMMUTABLE_BONUS: Bonus final tidak boleh diubah.';
    end if;

    if old.status <> 'DRAFT'
       or new.status <> 'FINAL'
       or new.report_revision_id is distinct from old.report_revision_id
       or new.recorded_total is distinct from old.recorded_total
       or new.tier_percent is distinct from old.tier_percent
       or new.pool_amount is distinct from old.pool_amount
       or new.calculated_at is distinct from old.calculated_at then
      raise exception using errcode = '55000', message = 'INVALID_BONUS_TRANSITION: Hanya finalisasi DRAFT tanpa perubahan payload yang diizinkan.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_bonus_allocation_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pool_id uuid;
  v_status text;
begin
  if tg_op = 'UPDATE' and new.pool_id is distinct from old.pool_id then
    raise exception using errcode = '55000', message = 'IMMUTABLE_PARENT: Parent alokasi bonus tidak boleh diganti.';
  end if;

  v_pool_id := case when tg_op = 'INSERT' then new.pool_id else old.pool_id end;
  select status into v_status from public.daily_bonus_pools where id = v_pool_id;

  if v_status is null then
    raise exception using errcode = '23503', message = 'PARENT_NOT_FOUND: Pool bonus tidak ditemukan.';
  end if;

  if tg_op = 'INSERT' and v_status <> 'DRAFT' then
    raise exception using errcode = '55000', message = 'INVALID_PARENT_STATE: Alokasi hanya dapat ditambahkan saat pool DRAFT.';
  end if;

  if tg_op <> 'INSERT' and v_status = 'FINAL' then
    raise exception using errcode = '55000', message = 'IMMUTABLE_BONUS: Alokasi bonus final tidak boleh dimutasi.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_payroll_entry_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_run_status text;
begin
  if tg_op = 'UPDATE' and new.run_id is distinct from old.run_id then
    raise exception using errcode = '55000', message = 'IMMUTABLE_PARENT: Payroll entry tidak boleh dipindahkan antar-run.';
  end if;

  v_run_id := case when tg_op = 'INSERT' then new.run_id else old.run_id end;
  select status into v_run_status
  from public.payroll_runs
  where id = v_run_id;

  if v_run_status is null then
    raise exception using errcode = '23503', message = 'PARENT_NOT_FOUND: Payroll run tidak ditemukan.';
  end if;

  if v_run_status in ('FINALIZED', 'PAID', 'VOID') then
    raise exception using errcode = '55000', message = 'IMMUTABLE_PAYROLL: Entry payroll final tidak boleh dimutasi.';
  end if;

  if tg_op = 'INSERT' and (v_run_status <> 'DRAFT' or new.status <> 'DRAFT' or new.version <> 1) then
    raise exception using errcode = '55000', message = 'INVALID_PAYROLL_ENTRY_STATE: Entry baru wajib DRAFT versi 1 pada run DRAFT.';
  end if;

  if tg_op = 'UPDATE' then
    if v_run_status = 'DRAFT' then
      if old.status <> 'DRAFT' or new.status not in ('DRAFT', 'REVIEWED') then
        raise exception using errcode = '55000', message = 'INVALID_PAYROLL_ENTRY_TRANSITION: Entry DRAFT hanya dapat direview.';
      end if;
      if new.status = 'REVIEWED'
         and current_setting('hopin.payroll_review_run_id', true) is distinct from new.run_id::text then
        raise exception using errcode = '55000', message = 'PAYROLL_RPC_REQUIRED: Review entry wajib melalui RPC.';
      end if;
      if new.status = 'REVIEWED'
         and (to_jsonb(new) - 'status' - 'version') is distinct from (to_jsonb(old) - 'status' - 'version') then
        raise exception using errcode = '55000', message = 'IMMUTABLE_PAYROLL_ENTRY_SNAPSHOT: Review tidak boleh mengubah angka entry.';
      end if;
    elsif v_run_status = 'REVIEWED' then
      if old.status <> 'REVIEWED' or new.status <> 'APPROVED'
         or current_setting('hopin.payroll_finalize_run_id', true) is distinct from new.run_id::text
         or new.final_gross is distinct from old.proposed_gross
         or (to_jsonb(new) - 'status' - 'version' - 'final_gross')
              is distinct from (to_jsonb(old) - 'status' - 'version' - 'final_gross') then
        raise exception using errcode = '55000', message = 'INVALID_PAYROLL_ENTRY_TRANSITION: Finalisasi hanya boleh menyetujui snapshot REVIEWED.';
      end if;
    else
      raise exception using errcode = '55000', message = 'IMMUTABLE_PAYROLL: Entry tidak dapat dimutasi pada state run ini.';
    end if;

    if new.version <> old.version + 1 then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT: Versi entry payroll harus naik tepat satu.';
    end if;
  end if;

  if tg_op = 'DELETE' and v_run_status <> 'DRAFT' then
    raise exception using errcode = '55000', message = 'IMMUTABLE_PAYROLL: Entry hanya dapat dihapus saat run DRAFT.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_payroll_adjustment_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry_id uuid;
  v_run_status text;
begin
  if tg_op = 'UPDATE' and new.entry_id is distinct from old.entry_id then
    raise exception using errcode = '55000', message = 'IMMUTABLE_PARENT: Payroll adjustment tidak boleh dipindahkan antar-entry.';
  end if;

  v_entry_id := case when tg_op = 'INSERT' then new.entry_id else old.entry_id end;
  select run.status into v_run_status
  from public.payroll_entries entry
  join public.payroll_runs run on run.id = entry.run_id
  where entry.id = v_entry_id;
  if v_run_status is null then
    raise exception using errcode = '23503', message = 'PARENT_NOT_FOUND: Payroll entry tidak ditemukan.';
  end if;
  if v_run_status <> 'DRAFT' then
    raise exception using errcode = '55000', message = 'IMMUTABLE_PAYROLL: Adjustment hanya dapat dimutasi saat run DRAFT.';
  end if;

  if tg_op <> 'DELETE' then
    if nullif(btrim(new.adjustment_type), '') is null
       or nullif(btrim(new.reason), '') is null
       or new.amount::text in ('NaN', 'Infinity', '-Infinity')
       or (new.status in ('APPROVED', 'REJECTED') and (new.reviewed_by is null or new.reviewed_at is null or new.reviewed_by = new.proposed_by))
       or (new.status = 'PENDING' and (new.reviewed_by is not null or new.reviewed_at is not null)) then
      raise exception using errcode = '23514', message = 'INVALID_PAYROLL_ADJUSTMENT: Adjustment/review metadata tidak valid atau self-approved.';
    end if;
    return new;
  end if;
  return old;
end;
$$;

create or replace function public.enforce_payroll_run_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT'
       or new.version <> 1
       or new.reviewed_by is not null
       or new.reviewed_at is not null
       or new.finalized_by is not null
       or new.finalized_at is not null
       or new.payload_checksum is not null
       or new.paid_by is not null
       or new.paid_at is not null
       or new.payment_reference is not null
       or new.payment_reason is not null
       or new.voided_by is not null
       or new.voided_at is not null
       or new.void_reason is not null then
      raise exception using errcode = '55000', message = 'INVALID_PAYROLL_INITIAL_STATE: Payroll run baru wajib DRAFT versi 1 tanpa metadata review/finalisasi.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'IMMUTABLE_PAYROLL: Payroll run tidak boleh dihapus.';
  end if;

  if new.id is distinct from old.id
     or new.outlet_id is distinct from old.outlet_id
     or new.period_month is distinct from old.period_month
     or new.policy_id is distinct from old.policy_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'IMMUTABLE_PAYROLL_IDENTITY: Identitas payroll run tidak boleh diubah.';
  end if;

  if new.version <> old.version + 1 then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Payroll run harus naik tepat satu versi dari %s.', old.version);
  end if;

  if old.status = 'DRAFT' then
    if new.status = 'DRAFT' then
      if new.reviewed_by is not null or new.reviewed_at is not null
         or new.finalized_by is not null or new.finalized_at is not null
         or new.payload_checksum is not null or new.paid_by is not null
         or new.voided_by is not null then
        raise exception using errcode = '23514', message = 'INVALID_PAYROLL_METADATA: Payroll DRAFT tidak boleh memiliki metadata review/finalisasi.';
      end if;
      return new;
    end if;

    if new.status <> 'REVIEWED'
       or current_setting('hopin.payroll_review_run_id', true) is distinct from old.id::text
       or new.reviewed_by is null
       or new.reviewed_at is null
       or new.finalized_by is not null
       or new.finalized_at is not null
       or new.payload_checksum is not null then
      raise exception using errcode = '55000', message = 'INVALID_PAYROLL_TRANSITION: Hanya DRAFT ke REVIEWED dengan reviewer yang diizinkan.';
    end if;

    if not exists (
      select 1
      from public.profiles profile
      join public.profile_outlet_scopes scope
        on scope.profile_id = profile.id
       and scope.outlet_id = old.outlet_id
       and scope.active is true
      join public.outlets outlet
        on outlet.id = scope.outlet_id
       and outlet.active is true
      where profile.id = new.reviewed_by
        and profile.role::text in ('OWNER', 'SUPERVISOR')
        and profile.active is true
        and profile.deactivated_at is null
        and profile.force_pin_change is false
    ) then
      raise exception using errcode = '42501', message = 'FORBIDDEN: Review payroll hanya boleh dilakukan manager aktif yang memiliki scope outlet.';
    end if;

    if (to_jsonb(new) - 'status' - 'version' - 'reviewed_by' - 'reviewed_at')
         is distinct from
       (to_jsonb(old) - 'status' - 'version' - 'reviewed_by' - 'reviewed_at') then
      raise exception using errcode = '55000', message = 'IMMUTABLE_PAYROLL_PAYLOAD: Review tidak boleh mengubah identitas atau policy payroll.';
    end if;
    return new;
  end if;

  if old.status = 'REVIEWED' then
    if new.status = 'FINALIZED' then
      if current_setting('hopin.payroll_finalize_run_id', true) is distinct from old.id::text
         or new.reviewed_by is distinct from old.reviewed_by
         or new.reviewed_at is distinct from old.reviewed_at
         or new.finalized_by is null or new.finalized_at is null
         or new.payload_checksum is null or new.payload_checksum !~* '^[0-9a-f]{64}$'
         or (to_jsonb(new) - 'status' - 'version' - 'finalized_by' - 'finalized_at' - 'payload_checksum')
              is distinct from
            (to_jsonb(old) - 'status' - 'version' - 'finalized_by' - 'finalized_at' - 'payload_checksum') then
        raise exception using errcode = '55000', message = 'INVALID_PAYROLL_TRANSITION: REVIEWED hanya dapat difinalisasi tanpa mutasi snapshot.';
      end if;
      if not exists (select 1 from public.payroll_entries where run_id = old.id)
         or exists (select 1 from public.payroll_entries where run_id = old.id and status <> 'APPROVED') then
        raise exception using errcode = '55000', message = 'PAYROLL_ENTRIES_NOT_APPROVED: Semua entry wajib APPROVED sebelum finalisasi run.';
      end if;
      return new;
    elsif new.status = 'VOID'
       and current_setting('hopin.payroll_void_run_id', true) = old.id::text then
      if new.voided_by is null or new.voided_at is null
         or nullif(btrim(new.void_reason), '') is null or new.replacement_run_id is null
         or (to_jsonb(new) - 'status' - 'version' - 'voided_by' - 'voided_at' - 'void_reason' - 'replacement_run_id')
              is distinct from
            (to_jsonb(old) - 'status' - 'version' - 'voided_by' - 'voided_at' - 'void_reason' - 'replacement_run_id') then
        raise exception using errcode = '55000', message = 'INVALID_VOID_TRANSITION: VOID hanya boleh menambah metadata void/replacement.';
      end if;
      return new;
    end if;
    raise exception using errcode = '55000', message = 'INVALID_PAYROLL_TRANSITION: REVIEWED hanya dapat menjadi FINALIZED atau VOID melalui RPC.';
  end if;

  if old.status = 'FINALIZED' then
    if new.status = 'PAID' then
      if current_setting('hopin.payroll_paid_run_id', true) is distinct from old.id::text
         or new.paid_by is null or new.paid_at is null
         or nullif(btrim(new.payment_reference), '') is null
         or nullif(btrim(new.payment_reason), '') is null
         or (to_jsonb(new) - 'status' - 'version' - 'paid_by' - 'paid_at' - 'payment_reference' - 'payment_reason')
              is distinct from
            (to_jsonb(old) - 'status' - 'version' - 'paid_by' - 'paid_at' - 'payment_reference' - 'payment_reason') then
        raise exception using errcode = '55000', message = 'INVALID_PAYROLL_TRANSITION: FINALIZED hanya dapat menjadi PAID dengan metadata pembayaran.';
      end if;
      return new;
    elsif new.status = 'VOID'
       and current_setting('hopin.payroll_void_run_id', true) = old.id::text then
      if new.voided_by is null or new.voided_at is null
         or nullif(btrim(new.void_reason), '') is null or new.replacement_run_id is null
         or (to_jsonb(new) - 'status' - 'version' - 'voided_by' - 'voided_at' - 'void_reason' - 'replacement_run_id')
              is distinct from
            (to_jsonb(old) - 'status' - 'version' - 'voided_by' - 'voided_at' - 'void_reason' - 'replacement_run_id') then
        raise exception using errcode = '55000', message = 'INVALID_VOID_TRANSITION: VOID hanya boleh menambah metadata void/replacement.';
      end if;
      return new;
    end if;
    raise exception using errcode = '55000', message = 'IMMUTABLE_PAYROLL: FINALIZED hanya dapat menjadi PAID atau VOID melalui RPC.';
  end if;

  if old.status = 'PAID'
     and new.status = 'VOID'
     and current_setting('hopin.payroll_void_run_id', true) = old.id::text then
    if new.voided_by is null or new.voided_at is null
       or nullif(btrim(new.void_reason), '') is null or new.replacement_run_id is null
       or (to_jsonb(new) - 'status' - 'version' - 'voided_by' - 'voided_at' - 'void_reason' - 'replacement_run_id')
            is distinct from
          (to_jsonb(old) - 'status' - 'version' - 'voided_by' - 'voided_at' - 'void_reason' - 'replacement_run_id') then
      raise exception using errcode = '55000', message = 'INVALID_VOID_TRANSITION: VOID hanya boleh menambah metadata void/replacement.';
    end if;
    return new;
  end if;

  raise exception using errcode = '55000', message = format('IMMUTABLE_PAYROLL: Payroll %s tidak boleh diubah.', old.status);
end;
$$;

create or replace function public.enforce_payroll_export_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_outlet_id uuid;
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'APPEND_ONLY: Payroll export tidak boleh diubah atau dihapus.';
  end if;

  select status, outlet_id into v_status, v_outlet_id
  from public.payroll_runs
  where id = new.run_id;
  if v_status is null then
    raise exception using errcode = '23503', message = 'PARENT_NOT_FOUND: Payroll run tidak ditemukan.';
  end if;

  if nullif(btrim(new.file_path), '') is null
     or length(new.file_path) > 1024
     or new.file_path ~ '(^|/)\.\.(/|$)'
     or new.file_path ~ '[[:cntrl:]]'
     or new.checksum_sha256 !~* '^[0-9a-f]{64}$'
     or jsonb_typeof(new.row_counts) <> 'object'
     or new.row_counts = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'INVALID_EXPORT_METADATA: Metadata export payroll tidak valid.';
  end if;

  if exists (
    select 1
    from jsonb_each(new.row_counts) entry
    where case
      when jsonb_typeof(entry.value) <> 'number' then true
      else (entry.value #>> '{}')::numeric < 0
        or trunc((entry.value #>> '{}')::numeric) <> (entry.value #>> '{}')::numeric
    end
  ) then
    raise exception using errcode = '22023', message = 'INVALID_ROW_COUNTS: Setiap row count wajib bilangan bulat nonnegatif.';
  end if;

  if v_status = 'REVIEWED' and upper(new.file_path) !~ '(^|[/_.-])DRAFT([/_.-]|$)' then
    raise exception using errcode = '55000', message = 'DRAFT_LABEL_REQUIRED: Export payroll REVIEWED harus jelas berlabel DRAFT pada file_path.';
  elsif v_status not in ('REVIEWED', 'FINALIZED', 'PAID') then
    raise exception using errcode = '55000', message = 'INVALID_PARENT_STATE: Export hanya dapat dibuat dari payroll REVIEWED atau final.';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    join public.profile_outlet_scopes scope
      on scope.profile_id = profile.id
     and scope.outlet_id = v_outlet_id
     and scope.active is true
    where profile.id = new.generated_by
      and profile.role::text in ('OWNER', 'SUPERVISOR')
      and profile.active is true
      and profile.deactivated_at is null
      and profile.force_pin_change is false
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Generator export harus manager aktif dengan scope outlet.';
  end if;

  new.generated_at := clock_timestamp();

  return new;
end;
$$;

drop trigger if exists trg_audit_events_append_only on public.audit_events;
create trigger trg_audit_events_append_only
before update or delete on public.audit_events
for each row execute function public.enforce_append_only();

drop trigger if exists trg_attendance_events_append_only on public.attendance_events;
create trigger trg_attendance_events_append_only
before update or delete on public.attendance_events
for each row execute function public.enforce_append_only();

drop trigger if exists trg_location_samples_append_only on public.attendance_location_samples;
create trigger trg_location_samples_append_only
before update or delete on public.attendance_location_samples
for each row execute function public.enforce_append_only();

drop trigger if exists trg_stock_movements_append_only on public.stock_movements;
create trigger trg_stock_movements_append_only
before update or delete on public.stock_movements
for each row execute function public.enforce_append_only();

drop trigger if exists trg_stock_openings_immutable on public.stock_openings;
create trigger trg_stock_openings_immutable
before update or delete on public.stock_openings
for each row execute function public.enforce_stock_snapshot_parent();

drop trigger if exists trg_stock_opening_lines_parent_state on public.stock_opening_lines;
create trigger trg_stock_opening_lines_parent_state
before insert or update or delete on public.stock_opening_lines
for each row execute function public.enforce_stock_snapshot_line_state();

drop trigger if exists trg_stock_handovers_immutable on public.stock_handovers;
create trigger trg_stock_handovers_immutable
before update or delete on public.stock_handovers
for each row execute function public.enforce_stock_snapshot_parent();

drop trigger if exists trg_stock_handover_lines_parent_state on public.stock_handover_lines;
create trigger trg_stock_handover_lines_parent_state
before insert or update or delete on public.stock_handover_lines
for each row execute function public.enforce_stock_snapshot_line_state();

drop trigger if exists trg_stock_closings_immutable on public.stock_closings;
create trigger trg_stock_closings_immutable
before update or delete on public.stock_closings
for each row execute function public.enforce_stock_snapshot_parent();

drop trigger if exists trg_stock_closing_lines_parent_state on public.stock_closing_lines;
create trigger trg_stock_closing_lines_parent_state
before insert or update or delete on public.stock_closing_lines
for each row execute function public.enforce_stock_snapshot_line_state();

drop trigger if exists trg_daily_report_revisions_immutable on public.daily_report_revisions;
create trigger trg_daily_report_revisions_immutable
before update on public.daily_report_revisions
for each row execute function public.enforce_report_revision_immutable();

drop trigger if exists trg_daily_report_revisions_no_delete on public.daily_report_revisions;
create trigger trg_daily_report_revisions_no_delete
before delete on public.daily_report_revisions
for each row execute function public.enforce_append_only();

drop trigger if exists trg_daily_report_finance_parent_state on public.daily_report_finance;
create trigger trg_daily_report_finance_parent_state
before insert or update or delete on public.daily_report_finance
for each row execute function public.enforce_report_line_state();

drop trigger if exists trg_daily_report_stock_lines_parent_state on public.daily_report_stock_lines;
create trigger trg_daily_report_stock_lines_parent_state
before insert or update or delete on public.daily_report_stock_lines
for each row execute function public.enforce_report_line_state();

drop trigger if exists trg_daily_bonus_pools_state on public.daily_bonus_pools;
create trigger trg_daily_bonus_pools_state
before update or delete on public.daily_bonus_pools
for each row execute function public.enforce_bonus_pool_state();

drop trigger if exists trg_daily_bonus_allocations_append_only on public.daily_bonus_allocations;
drop trigger if exists trg_daily_bonus_allocations_state on public.daily_bonus_allocations;
create trigger trg_daily_bonus_allocations_state
before insert or update or delete on public.daily_bonus_allocations
for each row execute function public.enforce_bonus_allocation_state();

drop trigger if exists trg_payroll_entries_parent_state on public.payroll_entries;
create trigger trg_payroll_entries_parent_state
before insert or update or delete on public.payroll_entries
for each row execute function public.enforce_payroll_entry_state();

drop trigger if exists trg_payroll_adjustments_parent_state on public.payroll_adjustments;
create trigger trg_payroll_adjustments_parent_state
before insert or update or delete on public.payroll_adjustments
for each row execute function public.enforce_payroll_adjustment_state();

drop trigger if exists trg_payroll_runs_state on public.payroll_runs;
create trigger trg_payroll_runs_state
before insert or update or delete on public.payroll_runs
for each row execute function public.enforce_payroll_run_state();

drop trigger if exists trg_payroll_exports_append_only on public.payroll_exports;
drop trigger if exists trg_payroll_exports_parent_state on public.payroll_exports;
create trigger trg_payroll_exports_parent_state
before insert or update or delete on public.payroll_exports
for each row execute function public.enforce_payroll_export_state();

-- Great-circle distance for server-side attendance verification.
create or replace function public.haversine_distance_m(
  p_latitude_a double precision,
  p_longitude_a double precision,
  p_latitude_b double precision,
  p_longitude_b double precision
)
returns double precision
language sql
immutable
strict
parallel safe
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select 2.0 * 6371000.0 * asin(
    least(
      1.0,
      sqrt(
        power(sin(radians(p_latitude_b - p_latitude_a) / 2.0), 2)
        + cos(radians(p_latitude_a)) * cos(radians(p_latitude_b))
        * power(sin(radians(p_longitude_b - p_longitude_a) / 2.0), 2)
      )
    )
  );
$$;

-- Atomically record a failed login against the credential and keyed
-- credential/IP/device scopes. The response never identifies the credential.
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
          when v_next_attempts >= 5 then v_now + interval '15 minutes'
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
       or v_limit.window_started_at <= v_now - interval '15 minutes' then
      v_next_attempts := 1;
      v_next_blocked_until := null;
    else
      -- A newly inserted row already represents this failure.
      v_next_attempts := case when v_limit.updated_at = v_now then 1 else v_limit.attempts + 1 end;
      v_next_blocked_until := case
        when v_next_attempts >= 5 then v_now + interval '15 minutes'
        else null
      end;
    end if;

    update public.auth_rate_limits
    set window_started_at = case
          when v_limit.blocked_until is not null
            or v_limit.window_started_at <= v_now - interval '15 minutes'
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

-- Reset successful-login counters without revealing whether a credential row exists.
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

-- Generic preflight for credential/IP/device blocks. It returns no actor or scope data.
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

  select coalesce(max(attempts), 0), max(blocked_until) filter (where blocked_until > v_now)
    into v_value_attempts, v_value_blocked_until
  from public.auth_rate_limits
  where scope_key = any(p_scope_keys);

  v_attempts := greatest(v_attempts, v_value_attempts);
  if v_value_blocked_until is not null
     and (v_blocked_until is null or v_value_blocked_until > v_blocked_until) then
    v_blocked_until := v_value_blocked_until;
  end if;

  return jsonb_build_object(
    'attempts', v_attempts,
    'blocked', v_blocked_until is not null,
    'blocked_until', v_blocked_until
  );
end;
$$;

-- Issue a two-minute attendance nonce challenge bound to one active actor,
-- session, device, outlet, and action. The API retains and returns the raw nonce.
create or replace function public.rpc_create_attendance_challenge(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_session_id uuid,
  p_device_id uuid,
  p_action text,
  p_nonce_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_challenge_id uuid;
  v_expires_at timestamptz;
begin
  if p_session_id is null
     or p_device_id is null
     or p_action is null
     or p_action not in ('CHECK_IN', 'CHECK_OUT')
     or p_nonce_hash is null
     or p_nonce_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_CHALLENGE_ARGUMENT: Session, device, action, dan nonce hash tidak valid.';
  end if;

  perform public.require_authorized_actor(p_actor_id, p_outlet_id);

  perform 1
  from public.app_sessions session
  where session.id = p_session_id
    and session.profile_id = p_actor_id
    and session.device_id = p_device_id
    and session.revoked_at is null
    and session.expires_at > v_now
    and (session.absolute_expires_at is null or session.absolute_expires_at > v_now)
    and session.last_seen_at > v_now - interval '30 minutes'
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'INVALID_SESSION: Session tidak aktif atau tidak terikat ke actor/device.';
  end if;

  perform 1
  from public.app_devices device
  where device.id = p_device_id
    and device.profile_id = p_actor_id
    and device.revoked_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'INVALID_DEVICE: Device tidak aktif atau bukan milik actor.';
  end if;

  update public.attendance_challenges
  set used_at = v_now
  where profile_id = p_actor_id
    and session_id = p_session_id
    and device_id = p_device_id
    and action = p_action
    and used_at is null;

  v_expires_at := v_now + interval '2 minutes';
  insert into public.attendance_challenges (
    outlet_id, profile_id, session_id, device_id, action, nonce_hash, expires_at, created_at
  ) values (
    p_outlet_id, p_actor_id, p_session_id, p_device_id, p_action, p_nonce_hash, v_expires_at, v_now
  ) returning id into v_challenge_id;

  update public.app_sessions set last_seen_at = v_now where id = p_session_id;
  update public.app_devices set last_seen_at = v_now where id = p_device_id;

  return jsonb_build_object('challenge_id', v_challenge_id, 'expires_at', v_expires_at);
end;
$$;

-- Consume one challenge and atomically write the attendance aggregate, event,
-- raw samples, overtime candidate, and audit. No client-derived status is accepted.
create or replace function public.rpc_record_attendance_event(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_session_id uuid,
  p_device_id uuid,
  p_challenge_id uuid,
  p_action text,
  p_nonce_hash text,
  p_idempotency_key uuid,
  p_assignment_id uuid,
  p_samples jsonb,
  p_location_failure text,
  p_note text,
  p_ip_country text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_wib_today date;
  v_challenge public.attendance_challenges%rowtype;
  v_settings public.outlet_settings%rowtype;
  v_attendance public.attendance_records%rowtype;
  v_event public.attendance_events%rowtype;
  v_existing_event public.attendance_events%rowtype;
  v_assignment_id uuid;
  v_roster_entry_id uuid;
  v_work_date date;
  v_assignment_status text;
  v_cycle_status text;
  v_shift_code text;
  v_start_local time;
  v_end_local time;
  v_scheduled_start timestamptz;
  v_scheduled_end timestamptz;
  v_lateness_status text;
  v_location_status text;
  v_final_attendance_status text;
  v_exception_status text;
  v_risk_score integer := 0;
  v_risk_reasons jsonb := '[]'::jsonb;
  v_sample_count integer;
  v_line jsonb;
  v_sample_order integer := 0;
  v_latitude double precision;
  v_longitude double precision;
  v_accuracy double precision;
  v_sampled_at timestamptz;
  v_distance double precision;
  v_best_distance double precision;
  v_best_accuracy double precision;
  v_best_sampled_at timestamptz;
  v_selected_distance integer;
  v_selected_accuracy integer;
  v_raw_extra_minutes integer := 0;
  v_credited_hours integer := 0;
  v_overtime_id uuid;
  v_overtime jsonb;
begin
  if p_actor_id is null
     or p_outlet_id is null
     or p_session_id is null
     or p_device_id is null
     or p_challenge_id is null
     or p_idempotency_key is null
     or p_action is null
     or p_action not in ('CHECK_IN', 'CHECK_OUT')
     or p_nonce_hash is null
     or p_nonce_hash !~ '^[a-f0-9]{64}$'
     or length(coalesce(p_note, '')) > 500
     or (p_ip_country is not null and p_ip_country !~ '^[A-Z]{2}$') then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDANCE_ARGUMENT: Binding atau format attendance tidak valid.';
  end if;

  perform public.require_authorized_actor(p_actor_id, p_outlet_id);

  perform 1
  from public.app_sessions session
  where session.id = p_session_id
    and session.profile_id = p_actor_id
    and session.device_id = p_device_id
    and session.revoked_at is null
    and session.expires_at > v_now
    and (session.absolute_expires_at is null or session.absolute_expires_at > v_now)
    and session.last_seen_at > v_now - interval '30 minutes'
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'INVALID_SESSION: Session tidak aktif atau tidak terikat ke actor/device.';
  end if;

  perform 1
  from public.app_devices device
  where device.id = p_device_id
    and device.profile_id = p_actor_id
    and device.revoked_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'INVALID_DEVICE: Device tidak aktif atau bukan milik actor.';
  end if;

  select event.* into v_existing_event
  from public.attendance_events event
  join public.attendance_records attendance on attendance.id = event.attendance_id
  join public.attendance_challenges challenge on challenge.id = event.challenge_id
  where event.idempotency_key = p_idempotency_key::text
  for share of event;

  if found then
    if v_existing_event.event_type = p_action
       and v_existing_event.challenge_id = p_challenge_id
       and v_existing_event.device_id = p_device_id
       and exists (
         select 1
         from public.attendance_records attendance
         join public.attendance_challenges challenge on challenge.id = v_existing_event.challenge_id
         where attendance.id = v_existing_event.attendance_id
           and attendance.profile_id = p_actor_id
           and attendance.outlet_id = p_outlet_id
           and challenge.session_id = p_session_id
           and challenge.nonce_hash = p_nonce_hash
       ) then
      select * into v_attendance from public.attendance_records where id = v_existing_event.attendance_id;
      select to_jsonb(overtime) into v_overtime
      from public.overtime_claims overtime
      where attendance_id = v_attendance.id
      order by created_at desc, id desc
      limit 1;
      return jsonb_build_object(
        'attendance', to_jsonb(v_attendance),
        'event', to_jsonb(v_existing_event),
        'overtime', v_overtime,
        'idempotent_replay', true
      );
    end if;

    raise exception using errcode = '23505', message = 'IDEMPOTENCY_CONFLICT: UUID idempotency sudah dipakai untuk attendance lain.';
  end if;

  select * into v_challenge
  from public.attendance_challenges
  where id = p_challenge_id
  for update;
  if not found
     or v_challenge.profile_id <> p_actor_id
     or v_challenge.outlet_id <> p_outlet_id
     or v_challenge.session_id is distinct from p_session_id
     or v_challenge.device_id is distinct from p_device_id
     or v_challenge.action <> p_action
     or v_challenge.nonce_hash <> p_nonce_hash
     or v_challenge.used_at is not null
     or v_challenge.expires_at <= v_now then
    raise exception using errcode = '22023', message = 'INVALID_CHALLENGE: Challenge tidak cocok, sudah dipakai, atau kedaluwarsa.';
  end if;

  select * into v_settings
  from public.outlet_settings
  where outlet_id = p_outlet_id
  for share;
  if not found then
    raise exception using errcode = '55000', message = 'OUTLET_SETTINGS_REQUIRED: Pengaturan outlet tidak ditemukan.';
  end if;

  v_wib_today := (v_now at time zone 'Asia/Jakarta')::date;
  v_assignment_id := p_assignment_id;

  if p_action = 'CHECK_OUT' then
    select * into v_attendance
    from public.attendance_records attendance
    where attendance.profile_id = p_actor_id
      and attendance.outlet_id = p_outlet_id
      and attendance.work_date between v_wib_today - 1 and v_wib_today
      and attendance.check_in_event_id is not null
      and attendance.check_out_event_id is null
      and attendance.status in ('CHECKED_IN', 'REVIEW_REQUIRED')
      and (p_assignment_id is null or attendance.work_assignment_id = p_assignment_id)
    order by attendance.work_date desc
    limit 1
    for update;
    if not found then
      raise exception using errcode = '55000', message = 'CHECK_IN_REQUIRED: Checkout memerlukan attendance dengan check-in yang belum ditutup.';
    end if;
    v_assignment_id := v_attendance.work_assignment_id;
  elsif v_assignment_id is null then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_REQUIRED: Check-in memerlukan assignment_id.';
  end if;

  select
    assignment.roster_entry_id,
    assignment.status,
    cycle.status,
    cycle.work_date,
    cycle.shift_code,
    template.start_local,
    template.end_local
    into
      v_roster_entry_id,
      v_assignment_status,
      v_cycle_status,
      v_work_date,
      v_shift_code,
      v_start_local,
      v_end_local
  from public.work_assignments assignment
  join public.work_cycles cycle on cycle.id = assignment.cycle_id
  join public.shift_templates template
    on template.outlet_id = cycle.outlet_id
   and template.code = cycle.shift_code
   and template.active is true
  where assignment.id = v_assignment_id
    and assignment.profile_id = p_actor_id
    and cycle.outlet_id = p_outlet_id
  for share of assignment, cycle, template;

  if not found
     or v_assignment_status = 'RESET'
     or v_cycle_status = 'RESET'
     or (p_action = 'CHECK_IN' and v_assignment_status <> 'ACTIVE')
     or (p_action = 'CHECK_IN' and v_cycle_status not in ('ACTIVE', 'OPEN'))
     or (p_action = 'CHECK_IN' and v_work_date <> v_wib_today) then
    raise exception using errcode = '55000', message = 'INVALID_ASSIGNMENT: Assignment/shift tidak aktif atau bukan untuk work date WIB saat ini.';
  end if;

  if p_action = 'CHECK_OUT'
     and (v_attendance.work_assignment_id is distinct from v_assignment_id
       or v_attendance.work_date is distinct from v_work_date) then
    raise exception using errcode = '55000', message = 'ATTENDANCE_ASSIGNMENT_MISMATCH: Attendance tidak cocok dengan assignment cycle.';
  end if;

  v_scheduled_start := (v_work_date + v_start_local) at time zone 'Asia/Jakarta';
  v_scheduled_end := (
    v_work_date + v_end_local
    + case when v_end_local <= v_start_local then interval '1 day' else interval '0 days' end
  ) at time zone 'Asia/Jakarta';
  v_lateness_status := case
    when v_now > v_scheduled_start + make_interval(mins => v_settings.late_grace_minutes) then 'LATE'
    else 'ON_TIME'
  end;

  if p_location_failure is null then
    if jsonb_typeof(p_samples) is distinct from 'array' then
      raise exception using errcode = '22023', message = 'INVALID_SAMPLES: samples wajib berupa array.';
    end if;
    v_sample_count := jsonb_array_length(p_samples);
    if v_sample_count < 1 or v_sample_count > least(3, v_settings.gps_sample_limit) then
      raise exception using errcode = '22023', message = 'INVALID_SAMPLES: Wajib 1-3 sample sesuai batas outlet.';
    end if;
    if v_settings.latitude is null or v_settings.longitude is null then
      raise exception using errcode = '55000', message = 'GEOFENCE_NOT_CONFIGURED: Koordinat outlet wajib dikonfigurasi.';
    end if;

    for v_line in select value from jsonb_array_elements(p_samples) loop
      if jsonb_typeof(v_line) <> 'object' then
        raise exception using errcode = '22023', message = 'INVALID_SAMPLE: Setiap sample wajib berupa object.';
      end if;

      if not (v_line ?& array['latitude', 'longitude', 'accuracy_m', 'client_sampled_at'])
         or exists (
           select 1 from jsonb_object_keys(v_line) as object_key(key_name)
           where key_name not in ('latitude', 'longitude', 'accuracy_m', 'client_sampled_at')
         )
         or jsonb_typeof(v_line->'latitude') <> 'number'
         or jsonb_typeof(v_line->'longitude') <> 'number'
         or jsonb_typeof(v_line->'accuracy_m') <> 'number'
         or jsonb_typeof(v_line->'client_sampled_at') <> 'string' then
        raise exception using errcode = '22023', message = 'INVALID_SAMPLE: Field sample tidak lengkap atau bertipe salah.';
      end if;

      v_latitude := (v_line->>'latitude')::double precision;
      v_longitude := (v_line->>'longitude')::double precision;
      v_accuracy := (v_line->>'accuracy_m')::double precision;
      v_sampled_at := (v_line->>'client_sampled_at')::timestamptz;

      if v_latitude::text in ('NaN', 'Infinity', '-Infinity')
         or v_longitude::text in ('NaN', 'Infinity', '-Infinity')
         or v_accuracy::text in ('NaN', 'Infinity', '-Infinity')
         or v_latitude not between -90 and 90
         or v_longitude not between -180 and 180
         or v_accuracy <= 0
         or v_accuracy > 100000
         or v_sampled_at < greatest(v_challenge.created_at - interval '5 minutes', v_now - interval '5 minutes')
         or v_sampled_at > v_now + interval '1 minute' then
        raise exception using errcode = '22023', message = 'INVALID_SAMPLE: Range, akurasi, atau timestamp sample tidak valid.';
      end if;

      v_distance := public.haversine_distance_m(
        v_latitude, v_longitude, v_settings.latitude, v_settings.longitude
      );
      if v_best_accuracy is null
         or v_accuracy < v_best_accuracy
         or (v_accuracy = v_best_accuracy and v_distance < v_best_distance) then
        v_best_accuracy := v_accuracy;
        v_best_distance := v_distance;
        v_best_sampled_at := v_sampled_at;
      end if;
    end loop;

    if v_best_distance <= v_settings.geofence_radius_m
       and v_best_accuracy <= v_settings.max_accuracy_m then
      v_location_status := 'VERIFIED';
    else
      if v_best_distance > v_settings.geofence_radius_m then
        v_risk_score := v_risk_score + 40;
        v_risk_reasons := v_risk_reasons || jsonb_build_array('OUTSIDE_GEOFENCE');
      end if;
      if v_best_accuracy > v_settings.max_accuracy_m then
        v_risk_score := v_risk_score + 20;
        v_risk_reasons := v_risk_reasons || jsonb_build_array('POOR_ACCURACY');
      end if;

      v_location_status := case
        when v_risk_score >= 60 then 'HIGH_RISK'
        when v_best_accuracy > v_settings.max_accuracy_m then 'POOR_ACCURACY'
        else 'OUTSIDE'
      end;
    end if;
    v_selected_distance := round(v_best_distance)::integer;
    v_selected_accuracy := ceil(v_best_accuracy)::integer;
  else
    if p_location_failure not in ('DENIED', 'TIMEOUT', 'UNAVAILABLE') then
      raise exception using errcode = '22023', message = 'INVALID_LOCATION_FAILURE: Gunakan DENIED/TIMEOUT/UNAVAILABLE tanpa fabricated sample.';
    end if;
    if p_samples is not null and jsonb_typeof(p_samples) <> 'array' then
      raise exception using errcode = '22023', message = 'INVALID_LOCATION_FAILURE: samples harus null atau array kosong.';
    end if;
    if p_samples is not null and jsonb_array_length(p_samples) <> 0 then
      raise exception using errcode = '22023', message = 'INVALID_LOCATION_FAILURE: Jangan kirim fabricated sample.';
    end if;
    v_location_status := p_location_failure;
    v_risk_score := 50;
    v_risk_reasons := jsonb_build_array('LOCATION_' || p_location_failure);
    v_sample_count := 0;
  end if;

  if v_location_status <> 'VERIFIED' and nullif(btrim(p_note), '') is null then
    raise exception using errcode = '22023', message = 'ATTENDANCE_NOTE_REQUIRED: Catatan wajib untuk lokasi non-verified.';
  end if;

  v_final_attendance_status := case
    when p_action = 'CHECK_IN' and v_location_status = 'VERIFIED' then 'CHECKED_IN'
    when p_action = 'CHECK_OUT' and v_attendance.status = 'CHECKED_IN' and v_location_status = 'VERIFIED' then 'CHECKED_OUT'
    else 'REVIEW_REQUIRED'
  end;
  v_exception_status := case when v_final_attendance_status = 'REVIEW_REQUIRED' then 'PENDING_REVIEW' else 'NONE' end;

  if p_action = 'CHECK_IN' then
    perform 1
    from public.attendance_records
    where profile_id = p_actor_id and work_date = v_work_date
    for update;
    if found then
      raise exception using errcode = '23505', message = 'ATTENDANCE_EXISTS: Check-in untuk work date tersebut sudah ada.';
    end if;

    insert into public.attendance_records (
      outlet_id, work_date, profile_id, roster_entry_id, work_assignment_id,
      status, scheduled_start_at, scheduled_end_at, lateness_status,
      exception_status, created_at, updated_at
    ) values (
      p_outlet_id, v_work_date, p_actor_id, v_roster_entry_id, v_assignment_id,
      v_final_attendance_status, v_scheduled_start, v_scheduled_end, v_lateness_status,
      v_exception_status, v_now, v_now
    ) returning * into v_attendance;
  end if;

  update public.attendance_challenges set used_at = v_now where id = v_challenge.id;

  insert into public.attendance_events (
    attendance_id, event_type, server_occurred_at, client_occurred_at,
    challenge_id, device_id, ip_country, location_status,
    selected_distance_m, selected_accuracy_m, risk_score, risk_reasons,
    note, idempotency_key, created_at
  ) values (
    v_attendance.id, p_action, v_now, v_best_sampled_at,
    v_challenge.id, p_device_id, p_ip_country, v_location_status,
    v_selected_distance, v_selected_accuracy, v_risk_score, v_risk_reasons,
    nullif(btrim(p_note), ''), p_idempotency_key::text, v_now
  ) returning * into v_event;

  if v_sample_count > 0 then
    for v_line in select value from jsonb_array_elements(p_samples) loop
      v_sample_order := v_sample_order + 1;
      insert into public.attendance_location_samples (
        event_id, latitude, longitude, accuracy_m, client_sampled_at,
        sample_order, retained_until
      ) values (
        v_event.id,
        (v_line->>'latitude')::double precision,
        (v_line->>'longitude')::double precision,
        (v_line->>'accuracy_m')::double precision,
        (v_line->>'client_sampled_at')::timestamptz,
        v_sample_order,
        v_now + make_interval(days => v_settings.raw_gps_retention_days)
      );
    end loop;
  end if;

  if p_action = 'CHECK_IN' then
    update public.attendance_records
    set check_in_event_id = v_event.id, version = version + 1, updated_at = v_now
    where id = v_attendance.id
    returning * into v_attendance;
  else
    update public.attendance_records
    set status = v_final_attendance_status,
        check_out_event_id = v_event.id,
        scheduled_start_at = v_scheduled_start,
        scheduled_end_at = v_scheduled_end,
        exception_status = case
          when exception_status = 'PENDING_REVIEW' or v_exception_status = 'PENDING_REVIEW' then 'PENDING_REVIEW'
          else exception_status
        end,
        version = version + 1,
        updated_at = v_now
    where id = v_attendance.id
    returning * into v_attendance;

    v_raw_extra_minutes := greatest(
      0,
      floor(extract(epoch from (v_now - v_scheduled_end)) / 60)::integer
    );
    if v_raw_extra_minutes > v_settings.overtime_threshold_minutes then
      v_credited_hours := floor((v_raw_extra_minutes + 29)::numeric / 60)::integer;
      insert into public.overtime_claims (
        attendance_id, raw_extra_minutes, credited_hours, status, reason, created_at
      ) values (
        v_attendance.id, v_raw_extra_minutes, v_credited_hours, 'CANDIDATE',
        'Server-derived dari CHECK_OUT terverifikasi/review-gated.', v_now
      ) returning id into v_overtime_id;
      select to_jsonb(overtime) into v_overtime
      from public.overtime_claims overtime where id = v_overtime_id;
    end if;
  end if;

  update public.app_sessions set last_seen_at = v_now where id = p_session_id;
  update public.app_devices set last_seen_at = v_now where id = p_device_id;

  perform public.log_audit_event(
    p_actor_id, p_action, 'attendance_records', v_attendance.id::text,
    p_outlet_id, p_actor_id, null,
    jsonb_build_object(
      'event_id', v_event.id,
      'work_date', v_work_date,
      'assignment_id', v_assignment_id,
      'location_status', v_location_status,
      'attendance_status', v_attendance.status,
      'lateness_status', v_attendance.lateness_status,
      'risk_score', v_risk_score,
      'sample_count', v_sample_count,
      'overtime_id', v_overtime_id
    )
  );

  return jsonb_build_object(
    'attendance', to_jsonb(v_attendance),
    'event', to_jsonb(v_event),
    'overtime', v_overtime,
    'idempotent_replay', false
  );
end;
$$;

-- Request a swap for the caller's future roster entry. Expiry is bounded by
-- both 24 hours and the scheduled shift start.
create or replace function public.rpc_request_shift_swap(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_roster_entry_id uuid,
  p_offered_to uuid,
  p_expected_roster_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_target_role public.app_role;
  v_roster public.roster_entries%rowtype;
  v_swap public.shift_swap_requests%rowtype;
  v_timezone text;
  v_start_local time;
  v_shift_start timestamptz;
  v_now timestamptz;
begin
  if p_actor_id is null
     or p_outlet_id is null
     or p_roster_entry_id is null
     or p_offered_to is null
     or p_expected_roster_version is null
     or p_expected_roster_version <= 0
     or p_actor_id = p_offered_to then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Payload permintaan swap tidak valid.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OPERATOR', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OPERATOR atau SUPERVISOR yang dapat meminta swap.';
  end if;

  select * into v_roster
  from public.roster_entries
  where id = p_roster_entry_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Roster entry tidak ditemukan.';
  end if;

  if v_roster.outlet_id <> p_outlet_id or v_roster.profile_id <> p_actor_id then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Hanya pemilik roster pada outlet aktif yang dapat meminta swap.';
  end if;
  if v_roster.version <> p_expected_roster_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected roster version %s, current version %s.', p_expected_roster_version, v_roster.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_roster_version, v_roster.version);
  end if;
  if v_roster.status <> 'SCHEDULED' then
    raise exception using errcode = '55000', message = format('STATE_CONFLICT: Roster berstatus %s, bukan SCHEDULED.', v_roster.status);
  end if;

  select profile.role into v_target_role
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id
   and scope.outlet_id = p_outlet_id
   and scope.active is true
  where profile.id = p_offered_to
    and profile.active is true
    and profile.deactivated_at is null
    and profile.force_pin_change is false;
  if v_target_role is null or v_target_role::text not in ('OPERATOR', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'INVALID_SWAP_TARGET: Target harus staff aktif dengan scope outlet yang sama.';
  end if;

  select outlet.timezone, template.start_local
    into v_timezone, v_start_local
  from public.outlets outlet
  join public.shift_templates template
    on template.outlet_id = outlet.id
   and template.code = v_roster.shift_code
   and template.active is true
  where outlet.id = p_outlet_id and outlet.active is true;
  if v_start_local is null then
    raise exception using errcode = '55000', message = 'SHIFT_TEMPLATE_NOT_FOUND: Template shift aktif tidak ditemukan.';
  end if;

  v_now := clock_timestamp();
  v_shift_start := (v_roster.work_date + v_start_local) at time zone v_timezone;
  if v_shift_start <= v_now then
    raise exception using errcode = '55000', message = 'SWAP_WINDOW_CLOSED: Shift sudah dimulai.';
  end if;

  if exists (
    select 1 from public.shift_swap_requests
    where roster_entry_id = p_roster_entry_id and status = 'PENDING'
  ) then
    raise exception using errcode = '55000', message = 'STATE_CONFLICT: Roster sudah memiliki permintaan swap PENDING.';
  end if;

  insert into public.shift_swap_requests (
    roster_entry_id, requested_by, offered_to, status, expires_at
  ) values (
    p_roster_entry_id, p_actor_id, p_offered_to, 'PENDING', least(v_now + interval '24 hours', v_shift_start)
  ) returning * into v_swap;

  perform public.log_audit_event(
    p_actor_id, 'REQUEST_SHIFT_SWAP', 'shift_swap_requests', v_swap.id::text,
    p_outlet_id, p_offered_to, null,
    jsonb_build_object(
      'roster_entry_id', p_roster_entry_id,
      'status', v_swap.status,
      'expires_at', v_swap.expires_at,
      'version', v_swap.version
    )
  );

  return to_jsonb(v_swap);
end;
$$;

-- Accept or decline atomically. Acceptance preserves the original roster fact
-- as SWAPPED and creates a new SCHEDULED roster entry for the target.
create or replace function public.rpc_respond_shift_swap(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_swap_id uuid,
  p_accept boolean,
  p_expected_swap_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_swap public.shift_swap_requests%rowtype;
  v_roster public.roster_entries%rowtype;
  v_new_roster public.roster_entries%rowtype;
  v_before jsonb;
  v_collision_id uuid;
  v_now timestamptz;
begin
  if p_actor_id is null
     or p_outlet_id is null
     or p_swap_id is null
     or p_accept is null
     or p_expected_swap_version is null
     or p_expected_swap_version <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Payload respons swap tidak valid.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OPERATOR', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya target staff yang dapat merespons swap.';
  end if;

  select * into v_swap
  from public.shift_swap_requests
  where id = p_swap_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Permintaan swap tidak ditemukan.';
  end if;
  v_before := to_jsonb(v_swap);

  if v_swap.offered_to <> p_actor_id then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Hanya target swap yang dapat merespons.';
  end if;
  if v_swap.version <> p_expected_swap_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected swap version %s, current version %s.', p_expected_swap_version, v_swap.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_swap_version, v_swap.version);
  end if;
  if v_swap.status <> 'PENDING' then
    raise exception using errcode = '55000', message = format('STATE_CONFLICT: Swap sudah terminal dengan status %s.', v_swap.status);
  end if;

  select * into v_roster
  from public.roster_entries
  where id = v_swap.roster_entry_id
  for update;
  if not found or v_roster.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Roster swap pada outlet ini tidak ditemukan.';
  end if;

  v_now := clock_timestamp();
  if v_swap.expires_at <= v_now then
    update public.shift_swap_requests
    set status = 'EXPIRED', responded_at = v_now, version = version + 1
    where id = p_swap_id
    returning * into v_swap;

    perform public.log_audit_event(
      p_actor_id, 'EXPIRE_SHIFT_SWAP', 'shift_swap_requests', v_swap.id::text,
      p_outlet_id, v_swap.requested_by, v_before, to_jsonb(v_swap)
    );
    return jsonb_build_object('swap', to_jsonb(v_swap), 'roster_entry', null);
  end if;

  if p_accept then
    if v_roster.status <> 'SCHEDULED' or v_roster.profile_id <> v_swap.requested_by then
      raise exception using errcode = '55000', message = 'STATE_CONFLICT: Roster asal tidak lagi aktif untuk requester.';
    end if;

    select id into v_collision_id
    from public.roster_entries
    where profile_id = p_actor_id
      and work_date = v_roster.work_date
      and status = 'SCHEDULED'
      and id <> v_roster.id
    limit 1
    for update;
    if v_collision_id is not null then
      raise exception using errcode = '23505', message = 'ROSTER_CONFLICT: Target sudah memiliki roster aktif pada tanggal yang sama.';
    end if;

    begin
      insert into public.roster_entries (
        outlet_id, work_date, shift_code, profile_id, expected_area, status,
        pay_treatment, override_reason, created_by, source
      ) values (
        v_roster.outlet_id, v_roster.work_date, v_roster.shift_code, p_actor_id,
        v_roster.expected_area, 'SCHEDULED', v_roster.pay_treatment,
        v_roster.override_reason, p_actor_id, 'SHIFT_SWAP'
      ) returning * into v_new_roster;
    exception when unique_violation then
      raise exception using errcode = '23505', message = 'ROSTER_CONFLICT: Target sudah memiliki roster aktif pada tanggal yang sama.';
    end;

    update public.roster_entries
    set status = 'SWAPPED', version = version + 1, updated_at = v_now
    where id = v_roster.id;

    update public.shift_swap_requests
    set status = 'ACCEPTED', responded_at = v_now, version = version + 1
    where id = p_swap_id
    returning * into v_swap;
  else
    update public.shift_swap_requests
    set status = 'DECLINED', responded_at = v_now, version = version + 1
    where id = p_swap_id
    returning * into v_swap;
  end if;

  perform public.log_audit_event(
    p_actor_id,
    case when p_accept then 'ACCEPT_SHIFT_SWAP' else 'DECLINE_SHIFT_SWAP' end,
    'shift_swap_requests', v_swap.id::text, p_outlet_id, v_swap.requested_by,
    v_before,
    to_jsonb(v_swap) || jsonb_build_object('new_roster_entry_id', v_new_roster.id)
  );

  return jsonb_build_object(
    'swap', to_jsonb(v_swap),
    'roster_entry', case when p_accept then to_jsonb(v_new_roster) else null end
  );
end;
$$;

create or replace function public.rpc_cancel_shift_swap(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_swap_id uuid,
  p_expected_swap_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_swap public.shift_swap_requests%rowtype;
  v_roster public.roster_entries%rowtype;
  v_before jsonb;
  v_now timestamptz;
begin
  if p_actor_id is null or p_outlet_id is null or p_swap_id is null
     or p_expected_swap_version is null or p_expected_swap_version <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Payload pembatalan swap tidak valid.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OPERATOR', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan membatalkan swap.';
  end if;

  select * into v_swap from public.shift_swap_requests where id = p_swap_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Permintaan swap tidak ditemukan.';
  end if;
  v_before := to_jsonb(v_swap);

  select * into v_roster from public.roster_entries where id = v_swap.roster_entry_id for update;
  if not found or v_roster.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Roster swap pada outlet ini tidak ditemukan.';
  end if;
  if v_swap.requested_by <> p_actor_id then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Hanya requester yang dapat membatalkan swap.';
  end if;
  if v_swap.version <> p_expected_swap_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected swap version %s, current version %s.', p_expected_swap_version, v_swap.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_swap_version, v_swap.version);
  end if;
  if v_swap.status <> 'PENDING' then
    raise exception using errcode = '55000', message = format('STATE_CONFLICT: Swap sudah terminal dengan status %s.', v_swap.status);
  end if;

  v_now := clock_timestamp();
  update public.shift_swap_requests
  set status = case when expires_at <= v_now then 'EXPIRED' else 'CANCELLED' end,
      responded_at = v_now,
      version = version + 1
  where id = p_swap_id
  returning * into v_swap;

  perform public.log_audit_event(
    p_actor_id,
    case when v_swap.status = 'EXPIRED' then 'EXPIRE_SHIFT_SWAP' else 'CANCEL_SHIFT_SWAP' end,
    'shift_swap_requests', v_swap.id::text, p_outlet_id, v_swap.offered_to,
    v_before, to_jsonb(v_swap)
  );
  return to_jsonb(v_swap);
end;
$$;

-- Manager reset is limited to non-final assignments and always records reason,
-- optimistic version, reset metadata, and before/after audit state.
create or replace function public.rpc_reset_assignment(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_assignment_id uuid,
  p_expected_assignment_version integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_target_role public.app_role;
  v_cycle public.work_cycles%rowtype;
  v_assignment public.work_assignments%rowtype;
  v_cycle_id uuid;
  v_before jsonb;
  v_reason text := nullif(btrim(p_reason), '');
  v_now timestamptz;
begin
  if p_actor_id is null or p_outlet_id is null or p_assignment_id is null
     or p_expected_assignment_version is null or p_expected_assignment_version <= 0
     or v_reason is null or length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Assignment, expected version, dan alasan reset wajib valid.';
  end if;

  select cycle_id into v_cycle_id from public.work_assignments where id = p_assignment_id;
  if v_cycle_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Assignment tidak ditemukan.';
  end if;
  select * into v_cycle from public.work_cycles where id = v_cycle_id for update;
  select * into v_assignment from public.work_assignments where id = p_assignment_id for update;

  if v_cycle.id is null or v_assignment.id is null or v_assignment.cycle_id <> v_cycle.id then
    raise exception using errcode = '55000', message = 'STATE_CONFLICT: Assignment atau cycle berubah selama reset.';
  end if;

  if v_cycle.outlet_id <> p_outlet_id then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Assignment pada outlet ini tidak ditemukan.';
  end if;
  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya manager yang dapat mereset assignment.';
  end if;

  select profile.role into v_target_role from public.profiles profile where profile.id = v_assignment.profile_id;
  if v_target_role is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Profile assignment tidak ditemukan.';
  end if;
  if v_role::text = 'SUPERVISOR' and v_target_role::text <> 'OPERATOR' then
    raise exception using errcode = '42501', message = 'FORBIDDEN: SUPERVISOR hanya boleh mereset assignment OPERATOR.';
  end if;
  if v_assignment.version <> p_expected_assignment_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected assignment version %s, current version %s.', p_expected_assignment_version, v_assignment.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_assignment_version, v_assignment.version);
  end if;
  if v_assignment.status not in ('ACTIVE', 'PENDING_TASKS') then
    raise exception using errcode = '55000', message = format('STATE_CONFLICT: Assignment %s tidak dapat di-reset.', v_assignment.status);
  end if;

  v_now := clock_timestamp();
  v_before := to_jsonb(v_assignment);
  update public.work_assignments
  set status = 'RESET', reset_at = v_now, reset_by = p_actor_id,
      reset_reason = v_reason, version = version + 1
  where id = p_assignment_id
  returning * into v_assignment;

  perform public.log_audit_event(
    p_actor_id, 'RESET_ASSIGNMENT', 'work_assignments', v_assignment.id::text,
    p_outlet_id, v_assignment.profile_id, v_before, to_jsonb(v_assignment), v_reason
  );
  return to_jsonb(v_assignment);
end;
$$;

-- Create profile, credential, and outlet scope as one OWNER-only transaction.
-- Credential material is deliberately excluded from both audit and return data.
create or replace function public.rpc_create_user(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_username text,
  p_display_name text,
  p_role public.app_role,
  p_job_title text,
  p_pin_salt text,
  p_pin_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role public.app_role;
  v_profile public.profiles%rowtype;
  v_username text := lower(btrim(p_username));
  v_display_name text := nullif(btrim(p_display_name), '');
  v_job_title text := coalesce(nullif(btrim(p_job_title), ''), 'STAFF');
  v_pin_salt text := btrim(p_pin_salt);
  v_pin_hash text := btrim(p_pin_hash);
begin
  v_actor_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_actor_role::text <> 'OWNER' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER yang dapat membuat user.';
  end if;

  if v_username is null or v_username !~ '^[a-z0-9][a-z0-9._-]{1,30}$'
     or v_display_name is null or length(v_display_name) > 100
     or length(v_job_title) > 100
     or p_role is null or p_role::text not in ('OPERATOR', 'SUPERVISOR', 'OWNER', 'INVESTOR')
     or v_pin_salt is null or v_pin_salt !~ '^[A-Za-z0-9+/]{22}==$'
     or v_pin_hash is null or v_pin_hash !~ '^[A-Za-z0-9+/]{86}==$' then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Username, profile, role, salt, atau hash tidak valid.';
  end if;

  insert into public.profiles (
    id, username, display_name, role, active, job_title, force_pin_change, version
  ) values (
    gen_random_uuid(), v_username, v_display_name, p_role, true, v_job_title, true, 1
  ) returning * into v_profile;

  insert into public.operator_credentials (
    profile_id, pin_salt, pin_hash, failed_attempts, locked_until,
    pin_changed_at, pin_version, last_failed_at
  ) values (
    v_profile.id, v_pin_salt, v_pin_hash, 0, null, clock_timestamp(), 1, null
  );

  insert into public.profile_outlet_scopes (profile_id, outlet_id, active)
  values (v_profile.id, p_outlet_id, true);

  perform public.log_audit_event(
    p_actor_id, 'CREATE_USER', 'profiles', v_profile.id::text,
    p_outlet_id, v_profile.id, null,
    jsonb_build_object(
      'id', v_profile.id,
      'username', v_profile.username,
      'display_name', v_profile.display_name,
      'role', v_profile.role,
      'job_title', v_profile.job_title,
      'active', v_profile.active,
      'force_pin_change', v_profile.force_pin_change,
      'version', v_profile.version
    )
  );

  return jsonb_build_object(
    'id', v_profile.id,
    'username', v_profile.username,
    'display_name', v_profile.display_name,
    'role', v_profile.role,
    'job_title', v_profile.job_title,
    'active', v_profile.active,
    'force_pin_change', v_profile.force_pin_change,
    'version', v_profile.version
  );
end;
$$;

-- Store a caller-verified PIN replacement atomically. The API remains
-- responsible for checking the old PIN, weakness denylist, and recent history.
create or replace function public.rpc_change_pin(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_current_session_id uuid,
  p_expected_pin_version integer,
  p_new_pin_salt text,
  p_new_pin_hash text,
  p_revoke_all_sessions boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_credential public.operator_credentials%rowtype;
  v_session public.app_sessions%rowtype;
  v_new_salt text := btrim(p_new_pin_salt);
  v_new_hash text := btrim(p_new_pin_hash);
  v_revoked_sessions integer := 0;
  v_force_pin_change_before boolean;
  v_now timestamptz;
begin
  if p_actor_id is null or p_outlet_id is null or p_current_session_id is null
     or p_expected_pin_version is null or p_expected_pin_version <= 0
     or p_revoke_all_sessions is null
     or v_new_salt is null or v_new_salt !~ '^[A-Za-z0-9+/]{22}==$'
     or v_new_hash is null or v_new_hash !~ '^[A-Za-z0-9+/]{86}==$' then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Payload perubahan PIN tidak valid.';
  end if;

  select * into v_profile
  from public.profiles
  where id = p_actor_id and active is true and deactivated_at is null
  for update;
  if not found or not exists (
    select 1
    from public.profile_outlet_scopes scope
    join public.outlets outlet on outlet.id = scope.outlet_id and outlet.active is true
    where scope.profile_id = p_actor_id
      and scope.outlet_id = p_outlet_id
      and scope.active is true
  ) then
    raise exception using errcode = '42501', message = 'AUTHORIZATION_FAILED: Actor atau scope outlet tidak aktif.';
  end if;
  v_force_pin_change_before := v_profile.force_pin_change;

  select * into v_session
  from public.app_sessions
  where id = p_current_session_id and profile_id = p_actor_id
  for update;
  if not found or v_session.revoked_at is not null then
    raise exception using errcode = '42501', message = 'AUTH_REQUIRED: Session aktif yang sesuai wajib tersedia.';
  end if;

  select * into v_credential
  from public.operator_credentials
  where profile_id = p_actor_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Kredensial tidak ditemukan.';
  end if;
  v_now := clock_timestamp();
  if v_session.expires_at <= v_now
     or (v_session.absolute_expires_at is not null and v_session.absolute_expires_at <= v_now) then
    raise exception using errcode = '42501', message = 'AUTH_REQUIRED: Session aktif yang sesuai wajib tersedia.';
  end if;
  if v_credential.pin_version <> p_expected_pin_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected PIN version %s, current version %s.', p_expected_pin_version, v_credential.pin_version),
      detail = format('expected_version=%s,current_version=%s', p_expected_pin_version, v_credential.pin_version);
  end if;
  if v_new_salt = v_credential.pin_salt and v_new_hash = v_credential.pin_hash then
    raise exception using errcode = '22023', message = 'PIN_UNCHANGED: Kredensial baru identik dengan kredensial aktif.';
  end if;

  insert into public.pin_history (profile_id, pin_salt, pin_hash, created_at)
  values (p_actor_id, v_credential.pin_salt, v_credential.pin_hash, v_now);

  update public.operator_credentials
  set pin_salt = v_new_salt,
      pin_hash = v_new_hash,
      pin_changed_at = v_now,
      pin_version = pin_version + 1,
      failed_attempts = 0,
      locked_until = null,
      last_failed_at = null
  where profile_id = p_actor_id
  returning * into v_credential;

  update public.profiles
  set force_pin_change = false, version = version + 1, updated_at = v_now
  where id = p_actor_id
  returning * into v_profile;

  update public.app_sessions
  set revoked_at = v_now
  where profile_id = p_actor_id
    and revoked_at is null
    and (p_revoke_all_sessions or id <> p_current_session_id);
  get diagnostics v_revoked_sessions = row_count;

  if not p_revoke_all_sessions then
    update public.app_sessions set last_seen_at = v_now where id = p_current_session_id;
  end if;

  perform public.log_audit_event(
    p_actor_id, 'CHANGE_PIN', 'operator_credentials', p_actor_id::text,
    p_outlet_id, p_actor_id,
    jsonb_build_object('pin_version', p_expected_pin_version, 'force_pin_change', v_force_pin_change_before),
    jsonb_build_object(
      'pin_version', v_credential.pin_version,
      'force_pin_change', v_profile.force_pin_change,
      'revoked_sessions', v_revoked_sessions,
      'revoked_current_session', p_revoke_all_sessions
    ),
    'User memperbarui PIN mandiri'
  );

  return jsonb_build_object(
    'pin_version', v_credential.pin_version,
    'profile_version', v_profile.version,
    'force_pin_change', v_profile.force_pin_change,
    'revoked_sessions', v_revoked_sessions,
    'current_session_revoked', p_revoke_all_sessions
  );
end;
$$;

-- OWNER reset stores the caller-generated temporary credential atomically.
-- Resetting self or another OWNER is fail-closed until a recovery rule exists.
create or replace function public.rpc_reset_pin(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_target_username text,
  p_new_pin_salt text,
  p_new_pin_hash text,
  p_expected_pin_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role public.app_role;
  v_target public.profiles%rowtype;
  v_credential public.operator_credentials%rowtype;
  v_username text := lower(btrim(p_target_username));
  v_new_salt text := btrim(p_new_pin_salt);
  v_new_hash text := btrim(p_new_pin_hash);
  v_revoked_sessions integer;
  v_now timestamptz;
begin
  if p_actor_id is null
     or p_outlet_id is null
     or v_username is null
     or v_username !~ '^[a-z0-9][a-z0-9._-]{1,30}$'
     or v_new_salt is null
     or v_new_salt !~ '^[A-Za-z0-9+/]{22}==$'
     or v_new_hash is null
     or v_new_hash !~ '^[A-Za-z0-9+/]{86}==$'
     or p_expected_pin_version is null
     or p_expected_pin_version <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Payload reset PIN tidak valid.';
  end if;

  perform 1 from public.profiles where id = p_actor_id for update;
  if not found then
    raise exception using errcode = '42501', message = 'AUTHORIZATION_FAILED: Actor tidak ditemukan.';
  end if;
  v_actor_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_actor_role::text <> 'OWNER' then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER yang dapat mereset PIN.';
  end if;

  select profile.* into v_target
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id
   and scope.outlet_id = p_outlet_id
   and scope.active is true
  join public.outlets outlet
    on outlet.id = scope.outlet_id
   and outlet.active is true
  where lower(profile.username) = v_username
    and profile.active is true
    and profile.deactivated_at is null
  for update of profile;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: User target aktif pada outlet ini tidak ditemukan.';
  end if;
  if v_target.id = p_actor_id or v_target.role::text = 'OWNER' then
    raise exception using errcode = '42501', message = 'OWNER_RESET_FORBIDDEN: Reset PIN diri sendiri atau OWNER lain tidak diizinkan.';
  end if;

  select * into v_credential
  from public.operator_credentials
  where profile_id = v_target.id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Kredensial target tidak ditemukan.';
  end if;
  if v_credential.pin_version <> p_expected_pin_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected target PIN version %s, current version %s.', p_expected_pin_version, v_credential.pin_version),
      detail = format('expected_version=%s,current_version=%s', p_expected_pin_version, v_credential.pin_version);
  end if;

  v_now := clock_timestamp();
  insert into public.pin_history (profile_id, pin_salt, pin_hash, created_at)
  values (v_target.id, v_credential.pin_salt, v_credential.pin_hash, v_now);

  update public.operator_credentials
  set pin_salt = v_new_salt,
      pin_hash = v_new_hash,
      pin_changed_at = v_now,
      pin_version = pin_version + 1,
      failed_attempts = 0,
      locked_until = null,
      last_failed_at = null
  where profile_id = v_target.id
  returning * into v_credential;

  update public.profiles
  set force_pin_change = true,
      version = version + 1,
      updated_at = v_now
  where id = v_target.id
  returning * into v_target;

  update public.app_sessions
  set revoked_at = v_now
  where profile_id = v_target.id and revoked_at is null;
  get diagnostics v_revoked_sessions = row_count;

  perform public.log_audit_event(
    p_actor_id, 'RESET_USER_PIN', 'operator_credentials', v_target.id::text,
    p_outlet_id, v_target.id,
    jsonb_build_object('pin_version', p_expected_pin_version),
    jsonb_build_object(
      'pin_version', v_credential.pin_version,
      'profile_version', v_target.version,
      'force_pin_change', v_target.force_pin_change,
      'revoked_sessions', v_revoked_sessions
    ),
    'OWNER mereset PIN user'
  );

  return jsonb_build_object(
    'id', v_target.id,
    'username', v_target.username,
    'display_name', v_target.display_name,
    'role', v_target.role,
    'active', v_target.active,
    'force_pin_change', v_target.force_pin_change,
    'profile_version', v_target.version,
    'pin_version', v_credential.pin_version
  );
end;
$$;

-- Claim an assignment. A terminal or already-started cycle is never reopened.
create or replace function public.rpc_claim_assignment(
  p_outlet_id uuid,
  p_work_date date,
  p_shift_code text,
  p_area_code public.area_code,
  p_profile_id uuid,
  p_duty_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_cycle public.work_cycles%rowtype;
  v_assignment public.work_assignments%rowtype;
  v_other_assignment_id uuid;
  v_primary_id uuid;
  v_roster_id uuid;
  v_roster_shift text;
  v_roster_area public.area_code;
  v_schedule_deviation boolean;
begin
  if p_work_date is null
     or p_shift_code is null
     or p_shift_code not in ('SIANG', 'MALAM', 'FULL')
     or p_area_code is null
     or p_duty_role is null
     or p_duty_role not in ('PRIMARY', 'HELPER') then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Tanggal, shift, area, dan duty role tidak valid.';
  end if;

  v_role := public.require_authorized_actor(p_profile_id, p_outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan mengklaim assignment.';
  end if;

  if not exists (
    select 1 from public.shift_templates
    where outlet_id = p_outlet_id and code = p_shift_code and active is true
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SHIFT: Shift outlet tidak ditemukan atau tidak aktif.';
  end if;

  insert into public.work_cycles (outlet_id, work_date, shift_code, area_code, status)
  values (p_outlet_id, p_work_date, p_shift_code, p_area_code, 'AVAILABLE')
  on conflict (outlet_id, work_date, shift_code, area_code) do nothing;

  select * into v_cycle
  from public.work_cycles
  where outlet_id = p_outlet_id
    and work_date = p_work_date
    and shift_code = p_shift_code
    and area_code = p_area_code
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'CYCLE_CREATE_FAILED: Work cycle tidak dapat dibuat.';
  end if;

  if v_cycle.status not in ('AVAILABLE', 'ACTIVE') then
    raise exception using errcode = '55000', message = 'INVALID_CYCLE_STATE: Cycle yang sudah dimulai atau terminal tidak dapat diklaim ulang.';
  end if;

  select * into v_assignment
  from public.work_assignments
  where cycle_id = v_cycle.id and profile_id = p_profile_id
  for update;

  if found and v_assignment.status <> 'ACTIVE' then
    raise exception using errcode = '55000', message = 'TERMINAL_ASSIGNMENT: Assignment nonaktif tidak dapat dihidupkan kembali.';
  end if;

  select id into v_other_assignment_id
  from public.work_assignments
  where profile_id = p_profile_id
    and work_date = p_work_date
    and status = 'ACTIVE'
    and cycle_id <> v_cycle.id
  limit 1
  for update;

  if v_other_assignment_id is not null then
    raise exception using errcode = '23505', message = 'ACTIVE_ASSIGNMENT_EXISTS: Actor sudah memiliki assignment aktif pada tanggal tersebut.';
  end if;

  if p_duty_role = 'PRIMARY' then
    select profile_id into v_primary_id
    from public.work_assignments
    where cycle_id = v_cycle.id
      and duty_role = 'PRIMARY'
      and status = 'ACTIVE'
      and profile_id <> p_profile_id
    limit 1;

    if v_primary_id is not null then
      raise exception using errcode = '23505', message = 'PRIMARY_TAKEN: Primary cycle sudah terisi.';
    end if;
  end if;

  select id, shift_code, expected_area
    into v_roster_id, v_roster_shift, v_roster_area
  from public.roster_entries
  where outlet_id = p_outlet_id
    and profile_id = p_profile_id
    and work_date = p_work_date
    and status = 'SCHEDULED'
  limit 1;

  v_schedule_deviation := v_roster_id is null
    or v_roster_shift is distinct from p_shift_code
    or (v_roster_area is not null and v_roster_area is distinct from p_area_code);

  if v_assignment.id is null then
    insert into public.work_assignments (
      cycle_id, work_date, profile_id, duty_role, status, roster_entry_id,
      schedule_deviation, assigned_at
    ) values (
      v_cycle.id, p_work_date, p_profile_id, p_duty_role, 'ACTIVE', v_roster_id,
      v_schedule_deviation, clock_timestamp()
    )
    returning * into v_assignment;
  else
    update public.work_assignments
    set duty_role = p_duty_role,
        roster_entry_id = v_roster_id,
        schedule_deviation = v_schedule_deviation,
        version = version + 1
    where id = v_assignment.id
    returning * into v_assignment;
  end if;

  if v_cycle.status = 'AVAILABLE' then
    update public.work_cycles
    set status = 'ACTIVE', version = version + 1, updated_at = clock_timestamp()
    where id = v_cycle.id;
  end if;

  perform public.log_audit_event(
    p_profile_id, 'CLAIM_ASSIGNMENT', 'work_assignments', v_assignment.id::text,
    p_outlet_id, p_profile_id, null,
    jsonb_build_object(
      'cycle_id', v_cycle.id,
      'shift_code', p_shift_code,
      'area_code', p_area_code,
      'duty_role', p_duty_role,
      'schedule_deviation', v_schedule_deviation
    )
  );

  return jsonb_build_object(
    'assignment_id', v_assignment.id,
    'cycle_id', v_cycle.id,
    'duty_role', v_assignment.duty_role,
    'schedule_deviation', v_assignment.schedule_deviation
  );
end;
$$;

-- Confirm opening from a server-selected prior snapshot. Client lines may only
-- contain item_id, counted_qty, reason_code, and notes.
create or replace function public.rpc_confirm_opening(
  p_cycle_id uuid,
  p_actor_id uuid,
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
  v_opening_id uuid;
  v_existing_id uuid;
  v_source_type text;
  v_source_id uuid;
  v_expected_count integer;
  v_line jsonb;
  v_item_id text;
  v_counted_qty numeric;
  v_reference_qty numeric;
  v_variance_qty numeric;
  v_reason text;
  v_notes text;
begin
  if p_cycle_id is null or p_actor_id is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Cycle dan actor wajib diisi.';
  end if;

  select * into v_cycle from public.work_cycles where id = p_cycle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, v_cycle.outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan mengonfirmasi opening.';
  end if;

  if v_cycle.status <> 'ACTIVE' then
    raise exception using errcode = '55000', message = 'INVALID_CYCLE_STATE: Opening hanya dapat dikonfirmasi pada cycle ACTIVE.';
  end if;

  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1 from public.work_assignments
    where cycle_id = p_cycle_id
      and profile_id = p_actor_id
      and duty_role = 'PRIMARY'
      and status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Opening memerlukan primary cycle atau manager dengan scope outlet.';
  end if;

  select id into v_existing_id from public.stock_openings where cycle_id = p_cycle_id for update;
  if v_existing_id is not null then
    raise exception using errcode = '55000', message = 'OPENING_EXISTS: Opening tidak dapat ditimpa.';
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'INVALID_LINES: p_lines wajib berupa array JSON.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_lines) line
    where jsonb_typeof(line) <> 'object'
       or not (line ? 'item_id')
       or not (line ? 'counted_qty')
       or jsonb_typeof(line->'item_id') <> 'string'
       or jsonb_typeof(line->'counted_qty') <> 'number'
       or (line ? 'reason_code' and jsonb_typeof(line->'reason_code') not in ('string', 'null'))
       or (line ? 'notes' and jsonb_typeof(line->'notes') not in ('string', 'null'))
       or (line->>'counted_qty')::numeric < 0
       or (line->>'counted_qty')::numeric::text in ('NaN', 'Infinity', '-Infinity')
  ) then
    raise exception using errcode = '22023', message = 'INVALID_LINES: Item dan counted_qty finite nonnegative wajib eksplisit.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) line
    cross join lateral jsonb_object_keys(line) as object_key(key_name)
    where key_name not in ('item_id', 'counted_qty', 'reason_code', 'notes')
  ) then
    raise exception using errcode = '22023', message = 'INVALID_LINES: p_lines memuat field yang tidak diizinkan.';
  end if;

  select count(*) into v_expected_count
  from public.items
  where active is true and area_code = v_cycle.area_code;

  if v_expected_count = 0
     or jsonb_array_length(p_lines) <> v_expected_count
     or (select count(distinct line->>'item_id') from jsonb_array_elements(p_lines) line) <> v_expected_count
     or exists (
       select 1 from jsonb_array_elements(p_lines) line
       left join public.items item on item.id = line->>'item_id'
       where item.id is null or item.active is not true or item.area_code <> v_cycle.area_code
     ) then
    raise exception using errcode = '22023', message = 'INCOMPLETE_ITEMS: Wajib tepat satu baris untuk setiap item aktif di area cycle.';
  end if;

  if v_cycle.shift_code = 'MALAM' then
    select handover.id into v_source_id
    from public.stock_handovers handover
    join public.work_cycles source_cycle on source_cycle.id = handover.cycle_id
    where source_cycle.outlet_id = v_cycle.outlet_id
      and source_cycle.work_date = v_cycle.work_date
      and source_cycle.shift_code = 'SIANG'
      and source_cycle.area_code = v_cycle.area_code
      and handover.status = 'CONFIRMED'
    for share of handover;
    v_source_type := 'HANDOVER';
  else
    select closing.id into v_source_id
    from public.stock_closings closing
    join public.work_cycles source_cycle on source_cycle.id = closing.cycle_id
    where source_cycle.outlet_id = v_cycle.outlet_id
      and source_cycle.work_date < v_cycle.work_date
      and source_cycle.area_code = v_cycle.area_code
      and closing.status = 'CONFIRMED'
    order by source_cycle.work_date desc, closing.confirmed_at desc, closing.id desc
    limit 1
    for share of closing;
    v_source_type := 'CLOSING';
  end if;

  if v_source_id is null then
    raise exception using errcode = '55000', message = 'REFERENCE_NOT_FOUND: Snapshot referensi opening terkonfirmasi tidak ditemukan.';
  end if;

  insert into public.stock_openings (
    cycle_id, status, reference_source_type, reference_source_id
  ) values (
    p_cycle_id, 'DRAFT', v_source_type, v_source_id
  ) returning id into v_opening_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_item_id := v_line->>'item_id';
    v_counted_qty := (v_line->>'counted_qty')::numeric;
    v_reason := nullif(btrim(v_line->>'reason_code'), '');
    v_notes := nullif(btrim(v_line->>'notes'), '');

    if v_source_type = 'HANDOVER' then
      select system_qty into v_reference_qty
      from public.stock_handover_lines
      where handover_id = v_source_id and item_id = v_item_id;
    else
      select counted_qty into v_reference_qty
      from public.stock_closing_lines
      where closing_id = v_source_id and item_id = v_item_id;
    end if;

    if v_reference_qty is null or v_reference_qty < 0 then
      raise exception using errcode = '55000', message = format('INVALID_REFERENCE: Referensi item %s hilang atau negatif.', v_item_id);
    end if;

    v_variance_qty := v_counted_qty - v_reference_qty;
    if v_variance_qty <> 0 and (v_reason is null or v_notes is null) then
      raise exception using errcode = '22023', message = format('VARIANCE_EXPLANATION_REQUIRED: Item %s memerlukan reason_code dan notes.', v_item_id);
    end if;

    insert into public.stock_opening_lines (
      opening_id, item_id, reference_qty, counted_qty, variance_qty,
      reason_code, notes, updated_by
    ) values (
      v_opening_id, v_item_id, v_reference_qty, v_counted_qty, v_variance_qty,
      v_reason, v_notes, p_actor_id
    );
  end loop;

  update public.stock_openings
  set status = 'CONFIRMED', confirmed_at = clock_timestamp(), confirmed_by = p_actor_id,
      version = version + 1, updated_at = clock_timestamp()
  where id = v_opening_id;

  update public.work_cycles
  set status = 'OPEN', version = version + 1, updated_at = clock_timestamp()
  where id = p_cycle_id;

  perform public.log_audit_event(
    p_actor_id, 'CONFIRM_OPENING', 'stock_openings', v_opening_id::text,
    v_cycle.outlet_id, null, null,
    jsonb_build_object(
      'cycle_id', p_cycle_id,
      'reference_source_type', v_source_type,
      'reference_source_id', v_source_id,
      'lines_count', v_expected_count
    )
  );

  return jsonb_build_object(
    'opening_id', v_opening_id,
    'status', 'CONFIRMED',
    'reference_source_type', v_source_type,
    'reference_source_id', v_source_id
  );
end;
$$;

-- Append one movement with a server snapshot of the item unit. An idempotency
-- retry is accepted after cutoff only when its complete payload is identical.
drop function if exists public.rpc_create_stock_movement(uuid, uuid, text, public.movement_direction, text, numeric, timestamptz, text, uuid, text);
create or replace function public.rpc_create_stock_movement(
  p_cycle_id uuid,
  p_actor_id uuid,
  p_expected_cycle_version integer,
  p_item_id text,
  p_direction public.movement_direction,
  p_category text,
  p_quantity numeric,
  p_client_occurred_at timestamptz,
  p_idempotency_key uuid,
  p_correction_of_id uuid default null,
  p_correction_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle public.work_cycles%rowtype;
  v_role public.app_role;
  v_existing public.stock_movements%rowtype;
  v_movement public.stock_movements%rowtype;
  v_opening_id uuid;
  v_expected_count integer;
  v_unit_code text;
  v_category text;
  v_correction_reason text;
  v_cycle_version integer;
  v_now timestamptz;
begin
  v_category := nullif(btrim(p_category), '');
  v_correction_reason := nullif(btrim(p_correction_reason), '');
  if p_cycle_id is null
     or p_actor_id is null
     or p_expected_cycle_version is null
     or p_expected_cycle_version <= 0
     or nullif(btrim(p_item_id), '') is null
     or p_direction is null
     or v_category is null
     or p_quantity is null
     or p_quantity <= 0
     or p_quantity::text in ('NaN', 'Infinity', '-Infinity')
     or p_client_occurred_at is null
     or not isfinite(p_client_occurred_at)
     or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Payload movement tidak valid.';
  end if;

  if (p_correction_of_id is null) <> (v_correction_reason is null) then
    raise exception using errcode = '22023', message = 'INVALID_CORRECTION: correction_of_id dan correction_reason wajib diisi bersama.';
  end if;

  select * into v_cycle from public.work_cycles where id = p_cycle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, v_cycle.outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan mencatat movement.';
  end if;

  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1 from public.work_assignments
    where cycle_id = p_cycle_id and profile_id = p_actor_id and status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Movement memerlukan assignment aktif atau manager dengan scope outlet.';
  end if;

  v_now := clock_timestamp();
  if p_client_occurred_at < v_cycle.created_at - interval '5 minutes'
     or p_client_occurred_at > v_now + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'INVALID_CLIENT_TIMESTAMP: client_occurred_at berada di luar rentang cycle/server yang diizinkan.';
  end if;

  select * into v_existing
  from public.stock_movements
  where cycle_id = p_cycle_id and idempotency_key = p_idempotency_key::text
  for share;

  if found then
    if v_existing.created_by is not distinct from p_actor_id
       and v_existing.item_id is not distinct from p_item_id
       and v_existing.direction is not distinct from p_direction
       and v_existing.category is not distinct from v_category
       and v_existing.quantity is not distinct from p_quantity
       and v_existing.client_occurred_at is not distinct from p_client_occurred_at
       and v_existing.correction_of_id is not distinct from p_correction_of_id
       and v_existing.correction_reason is not distinct from v_correction_reason then
      return to_jsonb(v_existing) || jsonb_build_object(
        'cycle_version', v_cycle.version,
        'idempotent_replay', true
      );
    end if;

    raise exception using
      errcode = '23505',
      message = 'IDEMPOTENCY_CONFLICT: Key sudah digunakan dengan payload berbeda.';
  end if;

  if v_cycle.version <> p_expected_cycle_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected cycle version %s, current version %s.', p_expected_cycle_version, v_cycle.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_cycle_version, v_cycle.version);
  end if;

  if v_cycle.status <> 'OPEN'
     or v_cycle.movement_cutoff_at is not null
     or exists (select 1 from public.stock_handovers where cycle_id = p_cycle_id)
     or exists (select 1 from public.stock_closings where cycle_id = p_cycle_id) then
    raise exception using errcode = '55000', message = 'MOVEMENT_CUTOFF: Cycle tidak terbuka untuk movement baru.';
  end if;

  select id into v_opening_id
  from public.stock_openings
  where cycle_id = p_cycle_id and status = 'CONFIRMED'
  for share;
  if v_opening_id is null then
    raise exception using errcode = '55000', message = 'OPENING_REQUIRED: Opening terkonfirmasi wajib ada.';
  end if;

  select unit_code into v_unit_code
  from public.items
  where id = p_item_id and area_code = v_cycle.area_code and active is true;
  if v_unit_code is null then
    raise exception using errcode = '22023', message = 'INVALID_ITEM: Item tidak aktif atau bukan milik area cycle.';
  end if;

  select count(*) into v_expected_count
  from public.items where active is true and area_code = v_cycle.area_code;
  if v_expected_count = 0
     or (select count(*) from public.stock_opening_lines where opening_id = v_opening_id) <> v_expected_count
     or exists (
       select 1 from public.stock_opening_lines line
       left join public.items item on item.id = line.item_id
       where line.opening_id = v_opening_id
         and (item.id is null or item.active is not true or item.area_code <> v_cycle.area_code or line.counted_qty is null)
     )
     or not exists (
       select 1 from public.stock_opening_lines
       where opening_id = v_opening_id and item_id = p_item_id and counted_qty is not null
     ) then
    raise exception using errcode = '55000', message = 'INCOMPLETE_OPENING: Opening harus lengkap dan memuat item movement.';
  end if;

  if p_correction_of_id is not null and not exists (
    select 1 from public.stock_movements
    where id = p_correction_of_id and cycle_id = p_cycle_id and item_id = p_item_id
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CORRECTION: Movement asal tidak ditemukan pada cycle dan item yang sama.';
  end if;

  insert into public.stock_movements (
    cycle_id, item_id, direction, category, quantity, unit_code_snapshot,
    client_occurred_at, server_occurred_at, created_by, idempotency_key,
    correction_of_id, correction_reason
  ) values (
    p_cycle_id, p_item_id, p_direction, v_category, p_quantity, v_unit_code,
    p_client_occurred_at, v_now, p_actor_id, p_idempotency_key::text,
    p_correction_of_id, v_correction_reason
  ) returning * into v_movement;

  update public.work_cycles
  set version = version + 1, updated_at = v_now
  where id = p_cycle_id
  returning version into v_cycle_version;

  perform public.log_audit_event(
    p_actor_id, 'CREATE_STOCK_MOVEMENT', 'stock_movements', v_movement.id::text,
    v_cycle.outlet_id, null, null,
    jsonb_build_object(
      'cycle_id', p_cycle_id,
      'item_id', p_item_id,
      'direction', p_direction,
      'category', v_category,
      'quantity', p_quantity,
      'idempotency_key', p_idempotency_key,
      'cycle_version', v_cycle_version,
      'correction_of_id', p_correction_of_id
    )
  );

  return to_jsonb(v_movement) || jsonb_build_object(
    'cycle_version', v_cycle_version,
    'idempotent_replay', false
  );
end;
$$;

-- Complete a SIANG handover using only server-side opening and movement facts.
create or replace function public.rpc_complete_handover(
  p_cycle_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle public.work_cycles%rowtype;
  v_role public.app_role;
  v_opening_id uuid;
  v_handover_id uuid;
  v_cutoff_at timestamptz;
  v_expected_count integer;
  v_inserted_count integer;
begin
  select * into v_cycle from public.work_cycles where id = p_cycle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, v_cycle.outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan menyelesaikan handover.';
  end if;

  if v_cycle.shift_code <> 'SIANG' or v_cycle.status <> 'OPEN' or v_cycle.movement_cutoff_at is not null then
    raise exception using errcode = '55000', message = 'INVALID_CYCLE_STATE: Handover hanya untuk cycle SIANG yang masih OPEN.';
  end if;

  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1 from public.work_assignments
    where cycle_id = p_cycle_id
      and profile_id = p_actor_id
      and duty_role = 'PRIMARY'
      and status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Handover memerlukan primary SIANG atau manager dengan scope outlet.';
  end if;

  if exists (select 1 from public.stock_handovers where cycle_id = p_cycle_id) then
    raise exception using errcode = '55000', message = 'HANDOVER_EXISTS: Handover tidak dapat ditimpa.';
  end if;

  select id into v_opening_id
  from public.stock_openings
  where cycle_id = p_cycle_id and status = 'CONFIRMED'
  for share;
  if v_opening_id is null then
    raise exception using errcode = '55000', message = 'OPENING_REQUIRED: Opening terkonfirmasi wajib ada.';
  end if;

  select count(*) into v_expected_count
  from public.items where active is true and area_code = v_cycle.area_code;

  if v_expected_count = 0
     or (select count(*) from public.stock_opening_lines where opening_id = v_opening_id) <> v_expected_count
     or exists (
       select 1 from public.stock_opening_lines line
       left join public.items item on item.id = line.item_id
       where line.opening_id = v_opening_id
         and (item.id is null or item.active is not true or item.area_code <> v_cycle.area_code or line.counted_qty is null)
     ) then
    raise exception using errcode = '55000', message = 'INCOMPLETE_OPENING: Opening tidak memuat tepat semua item aktif area.';
  end if;

  v_cutoff_at := clock_timestamp();

  if exists (
    select 1
    from public.stock_opening_lines opening_line
    left join lateral (
      select
        coalesce(sum(movement.quantity) filter (where movement.direction = 'IN'), 0) as incoming_qty,
        coalesce(sum(movement.quantity) filter (where movement.direction = 'OUT'), 0) as outgoing_qty
      from public.stock_movements movement
      where movement.cycle_id = p_cycle_id
        and movement.item_id = opening_line.item_id
        and movement.server_occurred_at <= v_cutoff_at
    ) totals on true
    where opening_line.opening_id = v_opening_id
      and opening_line.counted_qty + totals.incoming_qty - totals.outgoing_qty < 0
  ) then
    raise exception using errcode = '23514', message = 'NEGATIVE_BALANCE: Handover menghasilkan saldo stok negatif.';
  end if;

  insert into public.stock_handovers (
    cycle_id, status, movement_cutoff_at, confirmed_at, confirmed_by
  ) values (
    p_cycle_id, 'DRAFT', v_cutoff_at, v_cutoff_at, p_actor_id
  ) returning id into v_handover_id;

  insert into public.stock_handover_lines (
    handover_id, item_id, opening_qty, incoming_qty, outgoing_qty, system_qty
  )
  select
    v_handover_id,
    opening_line.item_id,
    opening_line.counted_qty,
    coalesce(sum(movement.quantity) filter (where movement.direction = 'IN'), 0),
    coalesce(sum(movement.quantity) filter (where movement.direction = 'OUT'), 0),
    opening_line.counted_qty
      + coalesce(sum(movement.quantity) filter (where movement.direction = 'IN'), 0)
      - coalesce(sum(movement.quantity) filter (where movement.direction = 'OUT'), 0)
  from public.stock_opening_lines opening_line
  join public.items item
    on item.id = opening_line.item_id
   and item.active is true
   and item.area_code = v_cycle.area_code
  left join public.stock_movements movement
    on movement.cycle_id = p_cycle_id
   and movement.item_id = opening_line.item_id
   and movement.server_occurred_at <= v_cutoff_at
  where opening_line.opening_id = v_opening_id
  group by opening_line.item_id, opening_line.counted_qty;

  get diagnostics v_inserted_count = row_count;
  if v_inserted_count <> v_expected_count then
    raise exception using errcode = '55000', message = 'INCOMPLETE_HANDOVER: Hasil handover tidak memuat semua item aktif.';
  end if;

  update public.stock_handovers set status = 'CONFIRMED', version = version + 1 where id = v_handover_id;

  update public.work_cycles
  set status = 'HANDOVER_READY', movement_cutoff_at = v_cutoff_at,
      version = version + 1, updated_at = clock_timestamp()
  where id = p_cycle_id;

  perform public.log_audit_event(
    p_actor_id, 'COMPLETE_HANDOVER', 'stock_handovers', v_handover_id::text,
    v_cycle.outlet_id, null, null,
    jsonb_build_object('cycle_id', p_cycle_id, 'movement_cutoff_at', v_cutoff_at, 'lines_count', v_expected_count)
  );

  return jsonb_build_object(
    'handover_id', v_handover_id,
    'status', 'CONFIRMED',
    'movement_cutoff_at', v_cutoff_at
  );
end;
$$;

-- Confirm a MALAM/FULL closing. The cutoff and all calculated quantities are server-owned.
drop function if exists public.rpc_confirm_closing(uuid, uuid, jsonb, timestamptz);
create or replace function public.rpc_confirm_closing(
  p_cycle_id uuid,
  p_actor_id uuid,
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
  v_opening_id uuid;
  v_closing_id uuid;
  v_cutoff_at timestamptz;
  v_expected_count integer;
  v_line jsonb;
  v_item_id text;
  v_opening_qty numeric;
  v_incoming_qty numeric;
  v_outgoing_qty numeric;
  v_system_qty numeric;
  v_counted_qty numeric;
  v_variance_qty numeric;
  v_reason text;
  v_notes text;
begin
  select * into v_cycle from public.work_cycles where id = p_cycle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Work cycle tidak ditemukan.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, v_cycle.outlet_id);
  if v_role::text not in ('OPERATOR', 'OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Role tidak diizinkan mengonfirmasi closing.';
  end if;

  if v_cycle.shift_code not in ('MALAM', 'FULL')
     or v_cycle.status <> 'OPEN'
     or v_cycle.movement_cutoff_at is not null then
    raise exception using errcode = '55000', message = 'INVALID_CYCLE_STATE: Closing hanya untuk cycle MALAM/FULL yang masih OPEN.';
  end if;

  if v_role::text not in ('OWNER', 'SUPERVISOR') and not exists (
    select 1 from public.work_assignments
    where cycle_id = p_cycle_id
      and profile_id = p_actor_id
      and duty_role = 'PRIMARY'
      and status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Closing memerlukan primary cycle atau manager dengan scope outlet.';
  end if;

  if exists (select 1 from public.stock_closings where cycle_id = p_cycle_id) then
    raise exception using errcode = '55000', message = 'CLOSING_EXISTS: Closing tidak dapat ditimpa.';
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'INVALID_LINES: p_lines wajib berupa array JSON.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_lines) line
    where jsonb_typeof(line) <> 'object'
       or not (line ? 'item_id')
       or not (line ? 'counted_qty')
       or not (line ? 'reason_code')
       or not (line ? 'notes')
       or jsonb_typeof(line->'item_id') <> 'string'
       or jsonb_typeof(line->'counted_qty') <> 'number'
       or (line ? 'reason_code' and jsonb_typeof(line->'reason_code') not in ('string', 'null'))
       or (line ? 'notes' and jsonb_typeof(line->'notes') not in ('string', 'null'))
       or (line->>'counted_qty')::numeric < 0
       or (line->>'counted_qty')::numeric::text in ('NaN', 'Infinity', '-Infinity')
  ) then
    raise exception using errcode = '22023', message = 'INVALID_LINES: Item dan counted_qty finite nonnegative wajib eksplisit.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) line
    cross join lateral jsonb_object_keys(line) as object_key(key_name)
    where key_name not in ('item_id', 'counted_qty', 'reason_code', 'notes')
  ) then
    raise exception using errcode = '22023', message = 'INVALID_LINES: p_lines memuat field yang tidak diizinkan.';
  end if;

  select count(*) into v_expected_count
  from public.items where active is true and area_code = v_cycle.area_code;

  if v_expected_count = 0
     or jsonb_array_length(p_lines) <> v_expected_count
     or (select count(distinct line->>'item_id') from jsonb_array_elements(p_lines) line) <> v_expected_count
     or exists (
       select 1 from jsonb_array_elements(p_lines) line
       left join public.items item on item.id = line->>'item_id'
       where item.id is null or item.active is not true or item.area_code <> v_cycle.area_code
     ) then
    raise exception using errcode = '22023', message = 'INCOMPLETE_ITEMS: Wajib tepat satu baris untuk setiap item aktif di area cycle.';
  end if;

  select id into v_opening_id
  from public.stock_openings
  where cycle_id = p_cycle_id and status = 'CONFIRMED'
  for share;
  if v_opening_id is null
     or (select count(*) from public.stock_opening_lines where opening_id = v_opening_id) <> v_expected_count then
    raise exception using errcode = '55000', message = 'INCOMPLETE_OPENING: Opening terkonfirmasi dan lengkap wajib ada.';
  end if;

  v_cutoff_at := clock_timestamp();

  insert into public.stock_closings (
    cycle_id, status, movement_cutoff_at, confirmed_at, confirmed_by
  ) values (
    p_cycle_id, 'DRAFT', v_cutoff_at, v_cutoff_at, p_actor_id
  ) returning id into v_closing_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_item_id := v_line->>'item_id';
    v_counted_qty := (v_line->>'counted_qty')::numeric;
    v_reason := nullif(btrim(v_line->>'reason_code'), '');
    v_notes := nullif(btrim(v_line->>'notes'), '');

    select counted_qty into v_opening_qty
    from public.stock_opening_lines
    where opening_id = v_opening_id and item_id = v_item_id;
    if v_opening_qty is null then
      raise exception using errcode = '55000', message = format('INCOMPLETE_OPENING: Item %s tidak memiliki opening eksplisit.', v_item_id);
    end if;

    select
      coalesce(sum(quantity) filter (where direction = 'IN'), 0),
      coalesce(sum(quantity) filter (where direction = 'OUT'), 0)
      into v_incoming_qty, v_outgoing_qty
    from public.stock_movements
    where cycle_id = p_cycle_id
      and item_id = v_item_id
      and server_occurred_at <= v_cutoff_at;

    v_system_qty := v_opening_qty + v_incoming_qty - v_outgoing_qty;
    v_variance_qty := v_counted_qty - v_system_qty;
    if v_variance_qty <> 0 and (v_reason is null or v_notes is null) then
      raise exception using errcode = '22023', message = format('VARIANCE_EXPLANATION_REQUIRED: Item %s memerlukan reason_code dan notes.', v_item_id);
    end if;

    insert into public.stock_closing_lines (
      closing_id, item_id, opening_qty, incoming_qty, outgoing_qty,
      system_qty, counted_qty, variance_qty, reason_code, notes
    ) values (
      v_closing_id, v_item_id, v_opening_qty, v_incoming_qty, v_outgoing_qty,
      v_system_qty, v_counted_qty, v_variance_qty, v_reason, v_notes
    );
  end loop;

  update public.stock_closings set status = 'CONFIRMED', version = version + 1 where id = v_closing_id;

  update public.work_cycles
  set status = 'CLOSING_READY', movement_cutoff_at = v_cutoff_at,
      version = version + 1, updated_at = clock_timestamp()
  where id = p_cycle_id;

  perform public.log_audit_event(
    p_actor_id, 'CONFIRM_CLOSING', 'stock_closings', v_closing_id::text,
    v_cycle.outlet_id, null, null,
    jsonb_build_object('cycle_id', p_cycle_id, 'movement_cutoff_at', v_cutoff_at, 'lines_count', v_expected_count)
  );

  return jsonb_build_object(
    'closing_id', v_closing_id,
    'status', 'CONFIRMED',
    'movement_cutoff_at', v_cutoff_at
  );
end;
$$;

-- Submit one immutable report revision from complete BAR and KITCHEN closing facts.
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
    and cycle.status = 'CLOSING_READY'
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
    and cycle.status = 'CLOSING_READY'
    and closing.status = 'CONFIRMED'
  for share of closing;

  select count(*) into v_closing_count
  from public.stock_closings closing
  join public.work_cycles cycle on cycle.id = closing.cycle_id
  where cycle.outlet_id = p_outlet_id
    and cycle.work_date = p_work_date
    and cycle.shift_code in ('MALAM', 'FULL')
    and cycle.area_code = 'KITCHEN'
    and cycle.status = 'CLOSING_READY'
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
    and cycle.status = 'CLOSING_READY'
    and closing.status = 'CONFIRMED'
  for share of closing;

  select count(*) into v_expected_count from public.items where active is true and area_code = 'BAR';
  if v_expected_count = 0
     or (select count(*) from public.stock_closing_lines where closing_id = v_bar_closing_id) <> v_expected_count
     or exists (
       select 1 from public.stock_closing_lines line
       left join public.items item on item.id = line.item_id
       where line.closing_id = v_bar_closing_id
         and (item.id is null or item.active is not true or item.area_code <> 'BAR')
     ) then
    raise exception using errcode = '55000', message = 'BAR_CLOSING_INCOMPLETE: Closing BAR tidak memuat tepat semua item aktif.';
  end if;
  v_total_item_count := v_expected_count;

  select count(*) into v_expected_count from public.items where active is true and area_code = 'KITCHEN';
  if v_expected_count = 0
     or (select count(*) from public.stock_closing_lines where closing_id = v_kitchen_closing_id) <> v_expected_count
     or exists (
       select 1 from public.stock_closing_lines line
       left join public.items item on item.id = line.item_id
       where line.closing_id = v_kitchen_closing_id
         and (item.id is null or item.active is not true or item.area_code <> 'KITCHEN')
     ) then
    raise exception using errcode = '55000', message = 'KITCHEN_CLOSING_INCOMPLETE: Closing KITCHEN tidak memuat tepat semua item aktif.';
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
    revision_id, item_id, area_code, closing_qty, low_threshold_snapshot, stock_status
  )
  select
    v_revision_id,
    item.id,
    item.area_code,
    line.counted_qty,
    item.low_threshold,
    case
      when line.counted_qty = 0 then 'HABIS'
      when line.counted_qty <= item.low_threshold then 'HAMPIR_HABIS'
      else 'AMAN'
    end
  from public.items item
  join public.stock_closing_lines line
    on line.item_id = item.id
   and line.closing_id = case when item.area_code = 'BAR' then v_bar_closing_id else v_kitchen_closing_id end
  where item.active is true;

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

create or replace function public.rpc_review_daily_report(
  p_revision_id uuid,
  p_actor_id uuid,
  p_status text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revision public.daily_report_revisions%rowtype;
  v_report public.daily_reports%rowtype;
  v_role public.app_role;
begin
  if p_status is null or p_status not in ('APPROVED', 'NEEDS_CLARIFICATION') then
    raise exception using errcode = '22023', message = 'INVALID_REVIEW_STATUS: Status harus APPROVED atau NEEDS_CLARIFICATION.';
  end if;

  if p_status = 'NEEDS_CLARIFICATION' and nullif(btrim(p_note), '') is null then
    raise exception using errcode = '22023', message = 'REVIEW_NOTE_REQUIRED: Catatan wajib untuk NEEDS_CLARIFICATION.';
  end if;

  select * into v_revision
  from public.daily_report_revisions
  where id = p_revision_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Revisi laporan tidak ditemukan.';
  end if;

  select * into v_report
  from public.daily_reports
  where id = v_revision.report_id
  for update;

  v_role := public.require_authorized_actor(p_actor_id, v_report.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Review memerlukan manager dengan scope outlet.';
  end if;

  if v_revision.status <> 'SUBMITTED'
     or v_report.status <> 'SUBMITTED'
     or v_report.current_revision <> v_revision.revision then
    raise exception using errcode = '55000', message = 'INVALID_REPORT_STATE: Hanya revisi SUBMITTED terkini yang dapat direview.';
  end if;

  if v_revision.submitted_by = p_actor_id then
    raise exception using errcode = '42501', message = 'SELF_REVIEW_FORBIDDEN: Pembuat laporan tidak boleh mereview laporannya sendiri.';
  end if;

  update public.daily_report_revisions
  set status = p_status,
      reviewed_by = p_actor_id,
      reviewed_at = clock_timestamp(),
      review_note = nullif(btrim(p_note), '')
  where id = p_revision_id;

  update public.daily_reports
  set status = p_status, version = version + 1, updated_at = clock_timestamp()
  where id = v_report.id;

  perform public.log_audit_event(
    p_actor_id, 'REVIEW_DAILY_REPORT', 'daily_report_revisions', p_revision_id::text,
    v_report.outlet_id, v_revision.submitted_by,
    jsonb_build_object('status', v_revision.status),
    jsonb_build_object('status', p_status, 'note', nullif(btrim(p_note), ''))
  );

  return jsonb_build_object('revision_id', p_revision_id, 'status', p_status);
end;
$$;

-- Finalize a daily bonus once. Participants must have both a non-reset assignment
-- and a valid linked attendance record; UUID order deterministically receives remainders.
create or replace function public.rpc_finalize_daily_bonus(
  p_revision_id uuid,
  p_actor_id uuid,
  p_tier_percent numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revision public.daily_report_revisions%rowtype;
  v_report public.daily_reports%rowtype;
  v_role public.app_role;
  v_recorded_total numeric;
  v_pool_amount numeric;
  v_pool_id uuid;
  v_participant_count integer;
  v_inserted_count integer;
begin
  if p_tier_percent is null
     or p_tier_percent < 0
     or p_tier_percent > 100
     or round(p_tier_percent, 2) <> p_tier_percent
     or p_tier_percent::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = '22023', message = 'INVALID_TIER: tier_percent wajib finite, 0-100, maksimal dua desimal.';
  end if;

  select revision.* into v_revision
  from public.daily_report_revisions revision
  where revision.id = p_revision_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Revisi laporan tidak ditemukan.';
  end if;

  select * into v_report from public.daily_reports where id = v_revision.report_id for update;
  v_role := public.require_authorized_actor(p_actor_id, v_report.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN: Finalisasi bonus memerlukan manager dengan scope outlet.';
  end if;

  if v_revision.status <> 'APPROVED'
     or v_report.status <> 'APPROVED'
     or v_report.current_revision <> v_revision.revision then
    raise exception using errcode = '55000', message = 'REPORT_NOT_APPROVED: Revisi laporan terkini wajib APPROVED.';
  end if;

  if exists (select 1 from public.daily_bonus_pools where report_revision_id = p_revision_id) then
    raise exception using errcode = '23505', message = 'BONUS_ALREADY_FINALIZED: Pool dan alokasi bonus bersifat satu kali.';
  end if;

  -- Any operational participant without valid attendance, or with a pending
  -- attendance correction, blocks the complete allocation transaction.
  if exists (
    select 1
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where cycle.outlet_id = v_report.outlet_id
      and cycle.work_date = v_report.work_date
      and assignment.status <> 'RESET'
      and not exists (
        select 1
        from public.attendance_records attendance
        where attendance.work_assignment_id = assignment.id
          and attendance.profile_id = assignment.profile_id
          and attendance.outlet_id = cycle.outlet_id
          and attendance.work_date = cycle.work_date
          and attendance.status in ('CHECKED_OUT', 'APPROVED')
          and attendance.exception_status in ('NONE', 'RESOLVED')
      )
  ) or exists (
    select 1
    from public.attendance_corrections correction
    join public.attendance_records attendance on attendance.id = correction.attendance_id
    where attendance.outlet_id = v_report.outlet_id
      and attendance.work_date = v_report.work_date
      and correction.status = 'PENDING'
  ) then
    raise exception using errcode = '55000', message = 'REVIEW_BLOCKERS: Assignment atau attendance masih belum valid/final.';
  end if;

  select count(distinct assignment.profile_id) into v_participant_count
  from public.work_assignments assignment
  join public.work_cycles cycle on cycle.id = assignment.cycle_id
  join public.attendance_records attendance
    on attendance.work_assignment_id = assignment.id
   and attendance.profile_id = assignment.profile_id
   and attendance.outlet_id = cycle.outlet_id
   and attendance.work_date = cycle.work_date
   and attendance.status in ('CHECKED_OUT', 'APPROVED')
   and attendance.exception_status in ('NONE', 'RESOLVED')
  where cycle.outlet_id = v_report.outlet_id
    and cycle.work_date = v_report.work_date
    and assignment.status <> 'RESET';

  if v_participant_count = 0 then
    raise exception using errcode = '55000', message = 'NO_BONUS_PARTICIPANTS: Tidak ada participant assignment+attendance yang valid.';
  end if;

  select recorded_total into v_recorded_total
  from public.daily_report_finance
  where revision_id = p_revision_id;
  if v_recorded_total is null then
    raise exception using errcode = '55000', message = 'FINANCE_NOT_FOUND: Finance laporan tidak ditemukan.';
  end if;

  v_pool_amount := trunc(v_recorded_total * p_tier_percent / 100);

  insert into public.daily_bonus_pools (
    report_revision_id, recorded_total, tier_percent, pool_amount, status, calculated_at
  ) values (
    p_revision_id, v_recorded_total, p_tier_percent, v_pool_amount, 'DRAFT', clock_timestamp()
  ) returning id into v_pool_id;

  with participants as (
    select distinct on (assignment.profile_id)
      assignment.profile_id,
      attendance.id as attendance_id
    from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    join public.attendance_records attendance
      on attendance.work_assignment_id = assignment.id
     and attendance.profile_id = assignment.profile_id
     and attendance.outlet_id = cycle.outlet_id
     and attendance.work_date = cycle.work_date
     and attendance.status in ('CHECKED_OUT', 'APPROVED')
     and attendance.exception_status in ('NONE', 'RESOLVED')
    where cycle.outlet_id = v_report.outlet_id
      and cycle.work_date = v_report.work_date
      and assignment.status <> 'RESET'
    order by assignment.profile_id, attendance.id
  ), ranked as (
    select profile_id, attendance_id, row_number() over (order by profile_id) as ordinal
    from participants
  )
  insert into public.daily_bonus_allocations (
    pool_id, profile_id, amount, remainder_awarded, attendance_id
  )
  select
    v_pool_id,
    profile_id,
    floor(v_pool_amount / v_participant_count)
      + case when ordinal <= mod(v_pool_amount, v_participant_count) then 1 else 0 end,
    ordinal <= mod(v_pool_amount, v_participant_count),
    attendance_id
  from ranked
  order by ordinal;

  get diagnostics v_inserted_count = row_count;
  if v_inserted_count <> v_participant_count then
    raise exception using errcode = '55000', message = 'INCOMPLETE_BONUS_ALLOCATION: Seluruh participant wajib mendapat alokasi.';
  end if;

  update public.daily_bonus_pools set status = 'FINAL' where id = v_pool_id;

  perform public.log_audit_event(
    p_actor_id, 'FINALIZE_DAILY_BONUS', 'daily_bonus_pools', v_pool_id::text,
    v_report.outlet_id, null, null,
    jsonb_build_object(
      'report_revision_id', p_revision_id,
      'tier_percent', p_tier_percent,
      'pool_amount', v_pool_amount,
      'participant_count', v_participant_count
    )
  );

  return jsonb_build_object(
    'pool_id', v_pool_id,
    'status', 'FINAL',
    'pool_amount', v_pool_amount,
    'participant_count', v_participant_count
  );
end;
$$;

-- Evidence-first draft. Ambiguous absence, shortage, schedule conversion, and
-- excess-leave decisions fail closed because 0006/0007 store no approved ruling.
create or replace function public.rpc_preview_payroll(
  p_actor_id uuid,
  p_outlet_id uuid,
  p_period_month text,
  p_expected_run_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_period_start date;
  v_period_end date;
  v_policy public.compensation_policies%rowtype;
  v_run public.payroll_runs%rowtype;
  v_policy_count integer;
  v_profile_count integer;
  v_entry_count integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor_id is null or p_outlet_id is null
     or p_period_month is null or p_period_month !~ '^\d{4}-(0[1-9]|1[0-2])$'
     or (p_expected_run_version is not null and p_expected_run_version <= 0) then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Outlet, periode, atau expected version tidak valid.';
  end if;
  v_period_start := (p_period_month || '-01')::date;
  v_period_end := (v_period_start + interval '1 month - 1 day')::date;

  v_role := public.require_authorized_actor(p_actor_id, p_outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Preview payroll hanya boleh dibuat manager.';
  end if;

  select count(*) into v_policy_count
  from public.compensation_policies policy
  where policy.outlet_id = p_outlet_id
    and policy.status = 'ACTIVE'
    and policy.effective_from <= v_period_end
    and (policy.effective_to is null or policy.effective_to >= v_period_end);
  if v_policy_count <> 1 then
    raise exception using errcode = '55000', message = format('PAYROLL_BLOCKER: Expected satu policy aktif pada period end, ditemukan %s.', v_policy_count);
  end if;
  select * into v_policy
  from public.compensation_policies policy
  where policy.outlet_id = p_outlet_id
    and policy.status = 'ACTIVE'
    and policy.effective_from <= v_period_end
    and (policy.effective_to is null or policy.effective_to >= v_period_end)
  for share;

  select * into v_run
  from public.payroll_runs
  where outlet_id = p_outlet_id and period_month = p_period_month and status <> 'VOID'
  for update;
  if found then
    if v_run.status <> 'DRAFT' then
      raise exception using errcode = '55000', message = format('STATE_CONFLICT: Payroll run %s tidak dapat dibangun ulang.', v_run.status);
    end if;
    if p_expected_run_version is null or v_run.version <> p_expected_run_version then
      raise exception using
        errcode = '40001',
        message = format('VERSION_CONFLICT: Expected payroll version %s, current version %s.', coalesce(p_expected_run_version::text, 'NULL'), v_run.version),
        detail = format('expected_version=%s,current_version=%s', coalesce(p_expected_run_version::text, 'NULL'), v_run.version);
    end if;
    if v_run.policy_id <> v_policy.id then
      raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Policy aktif berubah; void/replacement diperlukan.';
    end if;
  else
    if p_expected_run_version is not null then
      raise exception using errcode = '40001', message = 'VERSION_CONFLICT: Payroll run belum ada; expected version harus NULL.';
    end if;
    insert into public.payroll_runs (outlet_id, period_month, status, policy_id, created_by)
    values (p_outlet_id, p_period_month, 'DRAFT', v_policy.id, p_actor_id)
    returning * into v_run;
  end if;

  select count(*) into v_profile_count
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
  where profile.active is true and profile.deactivated_at is null
    and profile.role::text in ('OPERATOR', 'SUPERVISOR');
  if v_profile_count = 0 then
    raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Tidak ada profile operational aktif pada outlet.';
  end if;

  if exists (
    select 1
    from public.profiles profile
    join public.profile_outlet_scopes scope
      on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
    where profile.active is true and profile.deactivated_at is null
      and profile.role::text in ('OPERATOR', 'SUPERVISOR')
      and (select count(*) from public.employee_compensations compensation
           where compensation.profile_id = profile.id
             and compensation.policy_id = v_policy.id
             and compensation.effective_from <= v_period_end
             and (compensation.effective_to is null or compensation.effective_to >= v_period_end)) <> 1
  ) then
    raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Compensation period-end hilang atau overlap.';
  end if;

  if exists (
    select 1 from public.attendance_corrections correction
    join public.attendance_records attendance on attendance.id = correction.attendance_id
    where attendance.outlet_id = p_outlet_id and attendance.work_date between v_period_start and v_period_end
      and correction.status = 'PENDING'
  ) then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Attendance correction PENDING.'; end if;

  if exists (
    select 1 from public.attendance_records attendance
    where attendance.outlet_id = p_outlet_id and attendance.work_date between v_period_start and v_period_end
      and (attendance.status in ('MISSING_CHECKOUT', 'REVIEW_REQUIRED')
        or attendance.exception_status not in ('NONE', 'RESOLVED'))
  ) then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Attendance exception belum resolved.'; end if;

  if exists (
    select 1 from public.overtime_claims overtime
    join public.attendance_records attendance on attendance.id = overtime.attendance_id
    where attendance.outlet_id = p_outlet_id and attendance.work_date between v_period_start and v_period_end
      and overtime.status = 'CANDIDATE'
  ) then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Overtime CANDIDATE belum direview.'; end if;

  if exists (
    select 1 from public.leave_requests leave_request
    where leave_request.outlet_id = p_outlet_id
      and leave_request.start_date <= v_period_end and leave_request.end_date >= v_period_start
      and leave_request.status = 'PENDING'
  ) then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Leave request PENDING.'; end if;

  if exists (
    select 1 from public.roster_entries roster
    where roster.outlet_id = p_outlet_id and roster.work_date between v_period_start and v_period_end
      and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment in ('EXTRA', 'MAKEUP')
  ) then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Roster EXTRA/MAKEUP belum memiliki keputusan uang tersimpan.'; end if;

  if exists (
    select 1 from public.work_assignments assignment
    join public.work_cycles cycle on cycle.id = assignment.cycle_id
    where cycle.outlet_id = p_outlet_id and cycle.work_date between v_period_start and v_period_end
      and assignment.status <> 'RESET' and assignment.schedule_deviation is true
  ) then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Schedule deviation belum memiliki approval payroll tersimpan.'; end if;

  if exists (select 1 from public.payroll_adjustments adjustment
    join public.payroll_entries entry on entry.id = adjustment.entry_id
    where entry.run_id = v_run.id and adjustment.status = 'PENDING') then
    raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Payroll adjustment PENDING.';
  end if;

  if exists (
    select 1
    from public.profiles profile
    join public.profile_outlet_scopes scope
      on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
    where profile.active is true and profile.deactivated_at is null
      and profile.role::text in ('OPERATOR', 'SUPERVISOR')
      and (select count(*) from public.roster_entries roster
           where roster.profile_id = profile.id and roster.outlet_id = p_outlet_id
             and roster.work_date between v_period_start and v_period_end
             and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE') <> v_policy.minimum_workdays
  ) then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Jumlah roster BASE berbeda dari baseline policy.'; end if;

  if exists (
    select 1 from public.leave_requests leave_request
    where leave_request.outlet_id = p_outlet_id
      and leave_request.start_date <= v_period_end and leave_request.end_date >= v_period_start
      and leave_request.status = 'APPROVED' and leave_request.leave_type in ('UNPAID', 'OTHER_EXCEPTION')
  ) then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Leave unpaid/exception memerlukan deduction review yang belum dimodelkan.'; end if;

  if exists (
    select 1
    from public.profiles profile
    join public.profile_outlet_scopes scope
      on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
    where profile.active is true and profile.deactivated_at is null
      and profile.role::text in ('OPERATOR', 'SUPERVISOR')
      and ((select count(distinct roster.work_date) from public.roster_entries roster
            where roster.profile_id = profile.id and roster.outlet_id = p_outlet_id
              and roster.work_date between v_period_start and v_period_end
              and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE'
              and exists (select 1 from public.leave_requests leave_request
                where leave_request.profile_id = profile.id and leave_request.outlet_id = p_outlet_id
                  and leave_request.status = 'APPROVED' and leave_request.leave_type = 'SICK'
                  and roster.work_date between leave_request.start_date and leave_request.end_date)) > v_policy.sick_allowance
        or (select count(distinct roster.work_date) from public.roster_entries roster
            where roster.profile_id = profile.id and roster.outlet_id = p_outlet_id
              and roster.work_date between v_period_start and v_period_end
              and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE'
              and exists (select 1 from public.leave_requests leave_request
                where leave_request.profile_id = profile.id and leave_request.outlet_id = p_outlet_id
                  and leave_request.status = 'APPROVED' and leave_request.leave_type = 'OTHER'
                  and roster.work_date between leave_request.start_date and leave_request.end_date)) > v_policy.other_leave_allowance)
  ) then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Paid leave melebihi allowance; deduction review belum dimodelkan.'; end if;

  if exists (
    select 1 from public.roster_entries roster
    where roster.outlet_id = p_outlet_id and roster.work_date between v_period_start and v_period_end
      and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE'
      and not exists (select 1 from public.attendance_records attendance
        where attendance.roster_entry_id = roster.id and attendance.profile_id = roster.profile_id
          and attendance.outlet_id = p_outlet_id and attendance.work_date = roster.work_date
          and attendance.status in ('CHECKED_OUT', 'APPROVED') and attendance.exception_status in ('NONE', 'RESOLVED'))
      and not exists (select 1 from public.leave_requests leave_request
        where leave_request.profile_id = roster.profile_id and leave_request.outlet_id = p_outlet_id
          and leave_request.status = 'APPROVED' and leave_request.leave_type in ('SICK', 'OTHER')
          and roster.work_date between leave_request.start_date and leave_request.end_date)
  ) then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Roster BASE tidak terpenuhi; ALPHA/deduction review belum dimodelkan.'; end if;

  if exists (
    select 1 from public.payroll_entries entry
    where entry.run_id = v_run.id
      and not exists (select 1 from public.profiles profile
        join public.profile_outlet_scopes scope on scope.profile_id = profile.id
          and scope.outlet_id = p_outlet_id and scope.active is true
        where profile.id = entry.profile_id and profile.active is true
          and profile.deactivated_at is null and profile.role::text in ('OPERATOR', 'SUPERVISOR'))
      and exists (select 1 from public.payroll_adjustments adjustment where adjustment.entry_id = entry.id)
  ) then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Adjustment tersimpan untuk profile yang tidak lagi eligible.'; end if;

  delete from public.payroll_entries entry
  where entry.run_id = v_run.id
    and not exists (select 1 from public.profiles profile
      join public.profile_outlet_scopes scope on scope.profile_id = profile.id
        and scope.outlet_id = p_outlet_id and scope.active is true
      where profile.id = entry.profile_id and profile.active is true
        and profile.deactivated_at is null and profile.role::text in ('OPERATOR', 'SUPERVISOR'));

  insert into public.payroll_entries (
    run_id, profile_id, base_amount, attendance_summary, approved_overtime_amount,
    approved_shortage_amount, absence_deduction, bonus_amount,
    manual_adjustment_amount, proposed_gross, final_gross, status, version
  )
  select
    v_run.id,
    profile.id,
    compensation.monthly_base,
    jsonb_build_object(
      'period_start', v_period_start, 'period_end', v_period_end,
      'policy_id', v_policy.id, 'policy_version', v_policy.version,
      'minimum_workdays', v_policy.minimum_workdays,
      'sick_allowance', v_policy.sick_allowance,
      'other_leave_allowance', v_policy.other_leave_allowance,
      'compensation_id', compensation.id, 'compensation_version', compensation.version,
      'compensation_effective_from', compensation.effective_from,
      'compensation_effective_to', compensation.effective_to,
      'monthly_base', compensation.monthly_base,
      'daily_rate', compensation.daily_rate, 'hourly_rate', compensation.hourly_rate,
      'base_roster_days', (select count(*) from public.roster_entries roster
        where roster.profile_id = profile.id and roster.outlet_id = p_outlet_id
          and roster.work_date between v_period_start and v_period_end
          and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE'),
      'valid_attendance_ids', coalesce((select jsonb_agg(attendance.id order by attendance.work_date)
        from public.attendance_records attendance where attendance.profile_id = profile.id
          and attendance.outlet_id = p_outlet_id and attendance.work_date between v_period_start and v_period_end
          and attendance.status in ('CHECKED_OUT', 'APPROVED')
          and attendance.exception_status in ('NONE', 'RESOLVED')), '[]'::jsonb),
      'approved_paid_leave_ids', coalesce((select jsonb_agg(leave_request.id order by leave_request.created_at)
        from public.leave_requests leave_request where leave_request.profile_id = profile.id
          and leave_request.outlet_id = p_outlet_id and leave_request.status = 'APPROVED'
          and leave_request.leave_type in ('SICK', 'OTHER')
          and leave_request.start_date <= v_period_end and leave_request.end_date >= v_period_start), '[]'::jsonb),
      'approved_overtime_ids', coalesce((select jsonb_agg(overtime.id order by attendance.work_date)
        from public.overtime_claims overtime join public.attendance_records attendance on attendance.id = overtime.attendance_id
        where attendance.profile_id = profile.id and attendance.outlet_id = p_outlet_id
          and attendance.work_date between v_period_start and v_period_end and overtime.status = 'APPROVED'), '[]'::jsonb),
      'final_bonus_allocation_ids', coalesce((select jsonb_agg(allocation.id order by report.work_date)
        from public.daily_bonus_allocations allocation
        join public.daily_bonus_pools pool on pool.id = allocation.pool_id and pool.status = 'FINAL'
        join public.daily_report_revisions revision on revision.id = pool.report_revision_id
        join public.daily_reports report on report.id = revision.report_id
        where allocation.profile_id = profile.id and report.outlet_id = p_outlet_id
          and report.work_date between v_period_start and v_period_end), '[]'::jsonb),
      'approved_adjustment_ids', coalesce((select jsonb_agg(adjustment.id order by adjustment.created_at)
        from public.payroll_adjustments adjustment join public.payroll_entries current_entry on current_entry.id = adjustment.entry_id
        where current_entry.run_id = v_run.id and current_entry.profile_id = profile.id
          and adjustment.status = 'APPROVED'), '[]'::jsonb),
      'absence_deduction_rule', 'ZERO_ONLY_ALL_BASE_FULFILLED',
      'approved_shortage_rule', 'ZERO_NO_APPROVED_SHORTAGE_SCHEMA'
    ),
    coalesce((select sum(overtime.credited_hours * compensation.hourly_rate)
      from public.overtime_claims overtime join public.attendance_records attendance on attendance.id = overtime.attendance_id
      where attendance.profile_id = profile.id and attendance.outlet_id = p_outlet_id
        and attendance.work_date between v_period_start and v_period_end and overtime.status = 'APPROVED'), 0),
    0,
    0,
    coalesce((select sum(allocation.amount)
      from public.daily_bonus_allocations allocation
      join public.daily_bonus_pools pool on pool.id = allocation.pool_id and pool.status = 'FINAL'
      join public.daily_report_revisions revision on revision.id = pool.report_revision_id
      join public.daily_reports report on report.id = revision.report_id
      where allocation.profile_id = profile.id and report.outlet_id = p_outlet_id
        and report.work_date between v_period_start and v_period_end), 0),
    coalesce((select sum(adjustment.amount)
      from public.payroll_adjustments adjustment join public.payroll_entries current_entry on current_entry.id = adjustment.entry_id
      where current_entry.run_id = v_run.id and current_entry.profile_id = profile.id
        and adjustment.status = 'APPROVED'), 0),
    compensation.monthly_base
      + coalesce((select sum(overtime.credited_hours * compensation.hourly_rate)
        from public.overtime_claims overtime join public.attendance_records attendance on attendance.id = overtime.attendance_id
        where attendance.profile_id = profile.id and attendance.outlet_id = p_outlet_id
          and attendance.work_date between v_period_start and v_period_end and overtime.status = 'APPROVED'), 0)
      + coalesce((select sum(allocation.amount)
        from public.daily_bonus_allocations allocation
        join public.daily_bonus_pools pool on pool.id = allocation.pool_id and pool.status = 'FINAL'
        join public.daily_report_revisions revision on revision.id = pool.report_revision_id
        join public.daily_reports report on report.id = revision.report_id
        where allocation.profile_id = profile.id and report.outlet_id = p_outlet_id
          and report.work_date between v_period_start and v_period_end), 0)
      + coalesce((select sum(adjustment.amount)
        from public.payroll_adjustments adjustment join public.payroll_entries current_entry on current_entry.id = adjustment.entry_id
        where current_entry.run_id = v_run.id and current_entry.profile_id = profile.id
          and adjustment.status = 'APPROVED'), 0),
    0, 'DRAFT', 1
  from public.profiles profile
  join public.profile_outlet_scopes scope
    on scope.profile_id = profile.id and scope.outlet_id = p_outlet_id and scope.active is true
  join public.employee_compensations compensation
    on compensation.profile_id = profile.id and compensation.policy_id = v_policy.id
   and compensation.effective_from <= v_period_end
   and (compensation.effective_to is null or compensation.effective_to >= v_period_end)
  where profile.active is true and profile.deactivated_at is null
    and profile.role::text in ('OPERATOR', 'SUPERVISOR')
  on conflict (run_id, profile_id) do update set
    base_amount = excluded.base_amount,
    attendance_summary = excluded.attendance_summary,
    approved_overtime_amount = excluded.approved_overtime_amount,
    approved_shortage_amount = excluded.approved_shortage_amount,
    absence_deduction = excluded.absence_deduction,
    bonus_amount = excluded.bonus_amount,
    manual_adjustment_amount = excluded.manual_adjustment_amount,
    proposed_gross = excluded.proposed_gross,
    final_gross = 0,
    status = 'DRAFT',
    version = public.payroll_entries.version + 1;

  select count(*) into v_entry_count from public.payroll_entries where run_id = v_run.id;
  if v_entry_count <> v_profile_count then
    raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Snapshot entry tidak lengkap.';
  end if;

  if p_expected_run_version is not null then
    update public.payroll_runs set version = version + 1 where id = v_run.id returning * into v_run;
  end if;

  perform public.log_audit_event(
    p_actor_id, 'PREVIEW_PAYROLL', 'payroll_runs', v_run.id::text,
    p_outlet_id, null, null,
    jsonb_build_object('period_month', p_period_month, 'policy_id', v_policy.id,
      'policy_version', v_policy.version, 'entry_count', v_entry_count, 'version', v_run.version)
  );
  return jsonb_build_object('run_id', v_run.id, 'status', v_run.status,
    'version', v_run.version, 'entry_count', v_entry_count, 'blockers', '[]'::jsonb);
end;
$$;

create or replace function public.rpc_review_payroll(
  p_actor_id uuid,
  p_run_id uuid,
  p_expected_run_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_run public.payroll_runs%rowtype;
  v_period_start date;
  v_period_end date;
  v_entry_count integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor_id is null or p_run_id is null or p_expected_run_version is null or p_expected_run_version <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Run dan expected version wajib valid.';
  end if;
  select * into v_run from public.payroll_runs where id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: Payroll run tidak ditemukan.'; end if;
  v_role := public.require_authorized_actor(p_actor_id, v_run.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Review payroll hanya boleh manager.'; end if;
  if v_run.version <> p_expected_run_version then
    raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected payroll version %s, current version %s.', p_expected_run_version, v_run.version), detail = format('expected_version=%s,current_version=%s', p_expected_run_version, v_run.version);
  end if;
  if v_run.status <> 'DRAFT' then raise exception using errcode = '55000', message = format('STATE_CONFLICT: Payroll %s tidak dapat direview.', v_run.status); end if;
  if not exists (select 1 from public.payroll_entries where run_id = p_run_id)
     or exists (select 1 from public.payroll_entries where run_id = p_run_id and status <> 'DRAFT') then
    raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Seluruh entry wajib DRAFT dan tidak kosong.';
  end if;
  if exists (select 1 from public.payroll_adjustments adjustment join public.payroll_entries entry on entry.id = adjustment.entry_id where entry.run_id = p_run_id and adjustment.status = 'PENDING') then
    raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Adjustment PENDING.';
  end if;

  v_period_start := (v_run.period_month || '-01')::date;
  v_period_end := (v_period_start + interval '1 month - 1 day')::date;
  if not exists (select 1 from public.compensation_policies policy
       where policy.id = v_run.policy_id and policy.outlet_id = v_run.outlet_id
         and policy.status = 'ACTIVE' and policy.effective_from <= v_period_end
         and (policy.effective_to is null or policy.effective_to >= v_period_end))
     or exists (
       select 1 from public.payroll_entries entry
       where entry.run_id = p_run_id
         and (select count(*) from public.employee_compensations compensation
              where compensation.profile_id = entry.profile_id
                and compensation.policy_id = v_run.policy_id
                and compensation.effective_from <= v_period_end
                and (compensation.effective_to is null or compensation.effective_to >= v_period_end)) <> 1
     ) then
    raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Policy/compensation period-end berubah atau ambigu; rebuild preview diperlukan.';
  end if;
  if exists (select 1 from public.attendance_corrections correction join public.attendance_records attendance on attendance.id = correction.attendance_id where attendance.outlet_id = v_run.outlet_id and attendance.work_date between v_period_start and v_period_end and correction.status = 'PENDING')
     or exists (select 1 from public.attendance_records attendance where attendance.outlet_id = v_run.outlet_id and attendance.work_date between v_period_start and v_period_end and (attendance.status in ('MISSING_CHECKOUT', 'REVIEW_REQUIRED') or attendance.exception_status not in ('NONE', 'RESOLVED')))
     or exists (select 1 from public.overtime_claims overtime join public.attendance_records attendance on attendance.id = overtime.attendance_id where attendance.outlet_id = v_run.outlet_id and attendance.work_date between v_period_start and v_period_end and overtime.status = 'CANDIDATE')
     or exists (select 1 from public.leave_requests leave_request where leave_request.outlet_id = v_run.outlet_id and leave_request.start_date <= v_period_end and leave_request.end_date >= v_period_start and leave_request.status = 'PENDING')
     or exists (select 1 from public.roster_entries roster where roster.outlet_id = v_run.outlet_id and roster.work_date between v_period_start and v_period_end and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment in ('EXTRA', 'MAKEUP'))
     or exists (select 1 from public.work_assignments assignment join public.work_cycles cycle on cycle.id = assignment.cycle_id where cycle.outlet_id = v_run.outlet_id and cycle.work_date between v_period_start and v_period_end and assignment.status <> 'RESET' and assignment.schedule_deviation is true)
     or exists (select 1 from public.leave_requests leave_request where leave_request.outlet_id = v_run.outlet_id and leave_request.start_date <= v_period_end and leave_request.end_date >= v_period_start and leave_request.status = 'APPROVED' and leave_request.leave_type in ('UNPAID', 'OTHER_EXCEPTION'))
     or exists (
       select 1 from public.payroll_entries entry
       join public.compensation_policies policy on policy.id = v_run.policy_id
       where entry.run_id = p_run_id
         and (select count(*) from public.roster_entries roster
              where roster.profile_id = entry.profile_id and roster.outlet_id = v_run.outlet_id
                and roster.work_date between v_period_start and v_period_end
                and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE') <> policy.minimum_workdays
     )
     or exists (
       select 1 from public.roster_entries roster
       where roster.outlet_id = v_run.outlet_id and roster.work_date between v_period_start and v_period_end
         and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE'
         and not exists (select 1 from public.attendance_records attendance
           where attendance.roster_entry_id = roster.id and attendance.profile_id = roster.profile_id
             and attendance.outlet_id = v_run.outlet_id and attendance.work_date = roster.work_date
             and attendance.status in ('CHECKED_OUT', 'APPROVED') and attendance.exception_status in ('NONE', 'RESOLVED'))
         and not exists (select 1 from public.leave_requests leave_request
           where leave_request.profile_id = roster.profile_id and leave_request.outlet_id = v_run.outlet_id
             and leave_request.status = 'APPROVED' and leave_request.leave_type in ('SICK', 'OTHER')
             and roster.work_date between leave_request.start_date and leave_request.end_date)
     )
     or exists (
       select 1 from public.payroll_entries entry
       join public.compensation_policies policy on policy.id = v_run.policy_id
       where entry.run_id = p_run_id
         and ((select count(distinct roster.work_date) from public.roster_entries roster
               where roster.profile_id = entry.profile_id and roster.outlet_id = v_run.outlet_id
                 and roster.work_date between v_period_start and v_period_end
                 and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE'
                 and exists (select 1 from public.leave_requests leave_request
                   where leave_request.profile_id = entry.profile_id and leave_request.outlet_id = v_run.outlet_id
                     and leave_request.status = 'APPROVED' and leave_request.leave_type = 'SICK'
                     and roster.work_date between leave_request.start_date and leave_request.end_date)) > policy.sick_allowance
           or (select count(distinct roster.work_date) from public.roster_entries roster
               where roster.profile_id = entry.profile_id and roster.outlet_id = v_run.outlet_id
                 and roster.work_date between v_period_start and v_period_end
                 and roster.status in ('SCHEDULED', 'COMPLETED') and roster.pay_treatment = 'BASE'
                 and exists (select 1 from public.leave_requests leave_request
                   where leave_request.profile_id = entry.profile_id and leave_request.outlet_id = v_run.outlet_id
                     and leave_request.status = 'APPROVED' and leave_request.leave_type = 'OTHER'
                     and roster.work_date between leave_request.start_date and leave_request.end_date)) > policy.other_leave_allowance)
     ) then
    raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Source evidence memiliki review blocker baru; rebuild preview diperlukan.';
  end if;

  perform set_config('hopin.payroll_review_run_id', p_run_id::text, true);
  update public.payroll_entries set status = 'REVIEWED', version = version + 1 where run_id = p_run_id;
  get diagnostics v_entry_count = row_count;
  update public.payroll_runs
  set status = 'REVIEWED', reviewed_by = p_actor_id, reviewed_at = v_now, version = version + 1
  where id = p_run_id returning * into v_run;
  perform public.log_audit_event(p_actor_id, 'REVIEW_PAYROLL', 'payroll_runs', p_run_id::text, v_run.outlet_id, null, jsonb_build_object('status', 'DRAFT', 'version', p_expected_run_version), jsonb_build_object('status', v_run.status, 'version', v_run.version, 'entry_count', v_entry_count));
  return jsonb_build_object('run_id', v_run.id, 'status', v_run.status, 'version', v_run.version, 'entry_count', v_entry_count, 'blockers', '[]'::jsonb);
end;
$$;

create or replace function public.rpc_finalize_payroll(
  p_actor_id uuid,
  p_run_id uuid,
  p_expected_run_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_run public.payroll_runs%rowtype;
  v_checksum text;
  v_entry_count integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor_id is null or p_run_id is null or p_expected_run_version is null or p_expected_run_version <= 0 then raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Run dan expected version wajib valid.'; end if;
  select * into v_run from public.payroll_runs where id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: Payroll run tidak ditemukan.'; end if;
  v_role := public.require_authorized_actor(p_actor_id, v_run.outlet_id);
  if v_role::text <> 'OWNER' then raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER dapat finalisasi payroll.'; end if;
  if v_run.version <> p_expected_run_version then raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected payroll version %s, current version %s.', p_expected_run_version, v_run.version), detail = format('expected_version=%s,current_version=%s', p_expected_run_version, v_run.version); end if;
  if v_run.status <> 'REVIEWED' then raise exception using errcode = '55000', message = format('STATE_CONFLICT: Payroll %s tidak dapat difinalisasi.', v_run.status); end if;
  if not exists (select 1 from public.payroll_entries where run_id = p_run_id)
     or exists (select 1 from public.payroll_entries where run_id = p_run_id and status <> 'REVIEWED') then raise exception using errcode = '55000', message = 'PAYROLL_BLOCKER: Seluruh entry wajib REVIEWED.'; end if;

  select encode(digest(convert_to(jsonb_build_object(
    'run_id', v_run.id, 'outlet_id', v_run.outlet_id, 'period_month', v_run.period_month,
    'policy_id', v_run.policy_id,
    'entries', (select jsonb_agg(
      (to_jsonb(entry) - 'version') || jsonb_build_object('status', 'APPROVED', 'final_gross', entry.proposed_gross)
      order by entry.profile_id
    ) from public.payroll_entries entry where entry.run_id = p_run_id),
    'adjustments', coalesce((select jsonb_agg(to_jsonb(adjustment) order by adjustment.id) from public.payroll_adjustments adjustment join public.payroll_entries entry on entry.id = adjustment.entry_id where entry.run_id = p_run_id), '[]'::jsonb)
  )::text, 'UTF8'), 'sha256'), 'hex') into v_checksum;

  perform set_config('hopin.payroll_finalize_run_id', p_run_id::text, true);
  update public.payroll_entries set status = 'APPROVED', final_gross = proposed_gross, version = version + 1 where run_id = p_run_id;
  get diagnostics v_entry_count = row_count;
  update public.payroll_runs set status = 'FINALIZED', finalized_by = p_actor_id, finalized_at = v_now, payload_checksum = v_checksum, version = version + 1 where id = p_run_id returning * into v_run;
  perform public.log_audit_event(p_actor_id, 'FINALIZE_PAYROLL', 'payroll_runs', p_run_id::text, v_run.outlet_id, null, jsonb_build_object('status', 'REVIEWED', 'version', p_expected_run_version), jsonb_build_object('status', v_run.status, 'version', v_run.version, 'payload_checksum', v_checksum, 'entry_count', v_entry_count));
  return jsonb_build_object('run_id', v_run.id, 'status', v_run.status, 'version', v_run.version, 'payload_checksum', v_checksum, 'entry_count', v_entry_count);
end;
$$;

create or replace function public.rpc_mark_payroll_paid(
  p_actor_id uuid,
  p_run_id uuid,
  p_expected_run_version integer,
  p_payment_reference text,
  p_payment_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role; v_run public.payroll_runs%rowtype;
  v_reference text := nullif(btrim(p_payment_reference), '');
  v_reason text := nullif(btrim(p_payment_reason), '');
  v_now timestamptz := clock_timestamp();
begin
  if p_actor_id is null or p_run_id is null or p_expected_run_version is null or p_expected_run_version <= 0 or v_reference is null or v_reason is null or length(v_reference) > 200 or length(v_reason) > 500 then raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Reference/reason pembayaran wajib valid.'; end if;
  select * into v_run from public.payroll_runs where id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: Payroll run tidak ditemukan.'; end if;
  v_role := public.require_authorized_actor(p_actor_id, v_run.outlet_id);
  if v_role::text <> 'OWNER' then raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER dapat menandai payroll PAID.'; end if;
  if v_run.version <> p_expected_run_version then raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected payroll version %s, current version %s.', p_expected_run_version, v_run.version), detail = format('expected_version=%s,current_version=%s', p_expected_run_version, v_run.version); end if;
  if v_run.status <> 'FINALIZED' then raise exception using errcode = '55000', message = format('STATE_CONFLICT: Payroll %s tidak dapat ditandai PAID.', v_run.status); end if;
  perform set_config('hopin.payroll_paid_run_id', p_run_id::text, true);
  update public.payroll_runs set status = 'PAID', payment_reference = v_reference, payment_reason = v_reason, paid_by = p_actor_id, paid_at = v_now, version = version + 1 where id = p_run_id returning * into v_run;
  perform public.log_audit_event(p_actor_id, 'MARK_PAYROLL_PAID', 'payroll_runs', p_run_id::text, v_run.outlet_id, null, jsonb_build_object('status', 'FINALIZED', 'version', p_expected_run_version), jsonb_build_object('status', v_run.status, 'version', v_run.version, 'payment_reference', v_reference), v_reason);
  return jsonb_build_object('run_id', v_run.id, 'status', v_run.status, 'version', v_run.version, 'payment_reference', v_run.payment_reference, 'paid_at', v_run.paid_at);
end;
$$;

create or replace function public.rpc_void_payroll(
  p_actor_id uuid,
  p_run_id uuid,
  p_expected_run_version integer,
  p_void_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role; v_run public.payroll_runs%rowtype; v_replacement public.payroll_runs%rowtype;
  v_reason text := nullif(btrim(p_void_reason), ''); v_now timestamptz := clock_timestamp();
begin
  if p_actor_id is null or p_run_id is null or p_expected_run_version is null or p_expected_run_version <= 0 or v_reason is null or length(v_reason) > 500 then raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Run/version/reason VOID wajib valid.'; end if;
  select * into v_run from public.payroll_runs where id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: Payroll run tidak ditemukan.'; end if;
  v_role := public.require_authorized_actor(p_actor_id, v_run.outlet_id);
  if v_role::text <> 'OWNER' then raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Hanya OWNER dapat VOID payroll.'; end if;
  if v_run.version <> p_expected_run_version then raise exception using errcode = '40001', message = format('VERSION_CONFLICT: Expected payroll version %s, current version %s.', p_expected_run_version, v_run.version), detail = format('expected_version=%s,current_version=%s', p_expected_run_version, v_run.version); end if;
  if v_run.status not in ('REVIEWED', 'FINALIZED', 'PAID') then raise exception using errcode = '55000', message = format('STATE_CONFLICT: Payroll %s tidak dapat di-VOID.', v_run.status); end if;

  v_replacement.id := gen_random_uuid();
  perform set_config('hopin.payroll_void_run_id', p_run_id::text, true);
  update public.payroll_runs set status = 'VOID', void_reason = v_reason, voided_by = p_actor_id, voided_at = v_now, replacement_run_id = v_replacement.id, version = version + 1 where id = p_run_id returning * into v_run;
  insert into public.payroll_runs (id, outlet_id, period_month, status, policy_id, created_by)
  values (v_replacement.id, v_run.outlet_id, v_run.period_month, 'DRAFT', v_run.policy_id, p_actor_id)
  returning * into v_replacement;
  perform public.log_audit_event(p_actor_id, 'VOID_PAYROLL', 'payroll_runs', p_run_id::text, v_run.outlet_id, null, jsonb_build_object('status', case when v_run.finalized_at is null then 'REVIEWED' when v_run.paid_at is null then 'FINALIZED' else 'PAID' end, 'version', p_expected_run_version), jsonb_build_object('status', 'VOID', 'version', v_run.version, 'replacement_run_id', v_replacement.id), v_reason);
  return jsonb_build_object('run_id', v_run.id, 'status', v_run.status, 'version', v_run.version, 'replacement_run_id', v_replacement.id, 'replacement_version', v_replacement.version);
end;
$$;

-- Record metadata for an already generated XLSX snapshot. This RPC never reads
-- operational facts to build or recalculate payroll values.
create or replace function public.rpc_record_payroll_export(
  p_actor_id uuid,
  p_run_id uuid,
  p_expected_run_version integer,
  p_export_label text,
  p_file_path text,
  p_checksum_sha256 text,
  p_row_counts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role;
  v_run public.payroll_runs%rowtype;
  v_export public.payroll_exports%rowtype;
  v_label text := upper(btrim(p_export_label));
  v_file_path text := nullif(btrim(p_file_path), '');
  v_checksum text := lower(btrim(p_checksum_sha256));
  v_now timestamptz;
begin
  if p_actor_id is null or p_run_id is null
     or p_expected_run_version is null or p_expected_run_version <= 0
     or v_label is null or v_label not in ('DRAFT', 'FINALIZED')
     or v_file_path is null or length(v_file_path) > 1024
     or v_file_path ~ '(^|/)\.\.(/|$)'
     or v_file_path ~ '[[:cntrl:]]'
     or v_checksum is null or v_checksum !~ '^[0-9a-f]{64}$'
     or p_row_counts is null or jsonb_typeof(p_row_counts) <> 'object'
     or p_row_counts = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT: Metadata export payroll tidak valid.';
  end if;

  if exists (
    select 1
    from jsonb_each(p_row_counts) entry
    where case
      when jsonb_typeof(entry.value) <> 'number' then true
      else (entry.value #>> '{}')::numeric < 0
        or trunc((entry.value #>> '{}')::numeric) <> (entry.value #>> '{}')::numeric
    end
  ) then
    raise exception using errcode = '22023', message = 'INVALID_ROW_COUNTS: Setiap row count wajib bilangan bulat nonnegatif.';
  end if;

  select * into v_run
  from public.payroll_runs
  where id = p_run_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: Payroll run tidak ditemukan.';
  end if;

  v_role := public.require_authorized_actor(p_actor_id, v_run.outlet_id);
  if v_role::text not in ('OWNER', 'SUPERVISOR') then
    raise exception using errcode = '42501', message = 'FORBIDDEN_ROLE: Export payroll hanya boleh dicatat manager.';
  end if;
  if v_run.version <> p_expected_run_version then
    raise exception using
      errcode = '40001',
      message = format('VERSION_CONFLICT: Expected payroll version %s, current version %s.', p_expected_run_version, v_run.version),
      detail = format('expected_version=%s,current_version=%s', p_expected_run_version, v_run.version);
  end if;

  if v_run.status = 'REVIEWED' then
    if v_label <> 'DRAFT' or upper(v_file_path) !~ '(^|[/_.-])DRAFT([/_.-]|$)' then
      raise exception using errcode = '55000', message = 'DRAFT_LABEL_REQUIRED: Export REVIEWED wajib memakai label DRAFT pada nama/path file.';
    end if;
  elsif v_run.status in ('FINALIZED', 'PAID') then
    if v_label <> 'FINALIZED' then
      raise exception using errcode = '55000', message = 'FINALIZED_LABEL_REQUIRED: Export payroll final wajib berlabel FINALIZED.';
    end if;
  else
    raise exception using errcode = '55000', message = format('STATE_CONFLICT: Payroll %s tidak dapat diekspor.', v_run.status);
  end if;

  v_now := clock_timestamp();
  insert into public.payroll_exports (
    run_id, format, file_path, checksum_sha256, generated_by, generated_at, row_counts
  ) values (
    p_run_id, 'XLSX', v_file_path, v_checksum, p_actor_id, v_now, p_row_counts
  ) returning * into v_export;

  perform public.log_audit_event(
    p_actor_id, 'RECORD_PAYROLL_EXPORT', 'payroll_exports', v_export.id::text,
    v_run.outlet_id, null, null,
    jsonb_build_object(
      'run_id', p_run_id,
      'run_status', v_run.status,
      'run_version', v_run.version,
      'export_label', v_label,
      'format', v_export.format,
      'file_path', v_export.file_path,
      'checksum_sha256', v_export.checksum_sha256,
      'row_counts', v_export.row_counts,
      'generated_at', v_export.generated_at
    )
  );

  return jsonb_build_object(
    'export_id', v_export.id,
    'run_status', v_run.status,
    'run_version', v_run.version,
    'export_label', v_label
  );
end;
$$;

-- Remove auth.uid()-based policies left by the legacy direct-client model.
drop policy if exists profiles_select_self_or_manager on public.profiles;
drop policy if exists items_select_authenticated on public.items;
drop policy if exists items_manage_manager on public.items;
drop policy if exists assignments_select_owner_or_manager on public.assignments;
drop policy if exists assignments_insert_owner_or_manager on public.assignments;
drop policy if exists opening_records_select_assigned on public.opening_records;
drop policy if exists opening_lines_select_assigned on public.opening_lines;
drop policy if exists movements_select_assigned on public.movements;
drop policy if exists movements_insert_assigned on public.movements;
drop policy if exists closing_reports_select_assigned on public.closing_reports;
drop policy if exists closing_report_revisions_select_assigned on public.closing_report_revisions;
drop policy if exists closing_lines_select_assigned on public.closing_lines;
drop policy if exists audit_events_select_manager on public.audit_events;

-- Legacy V1 tables are retained only for historical compatibility; all new writes
-- must use work_cycles and the stock_* command model.
comment on table public.assignments is 'DEPRECATED: legacy V1 assignment table; no new operational writes.';
comment on table public.opening_records is 'DEPRECATED: legacy V1 opening table; use stock_openings.';
comment on table public.opening_lines is 'DEPRECATED: legacy V1 opening lines; use stock_opening_lines.';
comment on table public.movements is 'DEPRECATED: legacy V1 movements; use rpc_create_stock_movement.';
comment on table public.closing_reports is 'DEPRECATED: legacy V1 closing reports; use daily_reports.';
comment on table public.closing_report_revisions is 'DEPRECATED: legacy V1 closing revisions; use daily_report_revisions.';
comment on table public.closing_lines is 'DEPRECATED: legacy V1 closing lines; use stock_closing_lines.';

-- No direct operational table access is exposed to browser roles, including items.
revoke all privileges on table
  public.profiles,
  public.items,
  public.assignments,
  public.opening_records,
  public.opening_lines,
  public.movements,
  public.closing_reports,
  public.closing_report_revisions,
  public.closing_lines,
  public.audit_events,
  public.outlets,
  public.outlet_settings,
  public.profile_outlet_scopes,
  public.operator_credentials,
  public.app_sessions,
  public.pin_history,
  public.app_devices,
  public.auth_rate_limits,
  public.shift_templates,
  public.work_cycles,
  public.work_assignments,
  public.stock_openings,
  public.stock_opening_lines,
  public.stock_movements,
  public.stock_handovers,
  public.stock_handover_lines,
  public.stock_closings,
  public.stock_closing_lines,
  public.roster_entries,
  public.shift_swap_requests,
  public.attendance_challenges,
  public.attendance_records,
  public.attendance_events,
  public.attendance_location_samples,
  public.attendance_corrections,
  public.leave_requests,
  public.overtime_claims,
  public.daily_reports,
  public.daily_report_revisions,
  public.daily_report_finance,
  public.daily_report_stock_lines,
  public.daily_bonus_pools,
  public.daily_bonus_allocations,
  public.compensation_policies,
  public.employee_compensations,
  public.payroll_runs,
  public.payroll_entries,
  public.payroll_adjustments,
  public.payroll_exports,
  public.onboarding_progress
from public, anon, authenticated;

grant all privileges on table
  public.profiles,
  public.items,
  public.assignments,
  public.opening_records,
  public.opening_lines,
  public.movements,
  public.closing_reports,
  public.closing_report_revisions,
  public.closing_lines,
  public.audit_events,
  public.outlets,
  public.outlet_settings,
  public.profile_outlet_scopes,
  public.operator_credentials,
  public.app_sessions,
  public.pin_history,
  public.app_devices,
  public.auth_rate_limits,
  public.shift_templates,
  public.work_cycles,
  public.work_assignments,
  public.stock_openings,
  public.stock_opening_lines,
  public.stock_movements,
  public.stock_handovers,
  public.stock_handover_lines,
  public.stock_closings,
  public.stock_closing_lines,
  public.roster_entries,
  public.shift_swap_requests,
  public.attendance_challenges,
  public.attendance_records,
  public.attendance_events,
  public.attendance_location_samples,
  public.attendance_corrections,
  public.leave_requests,
  public.overtime_claims,
  public.daily_reports,
  public.daily_report_revisions,
  public.daily_report_finance,
  public.daily_report_stock_lines,
  public.daily_bonus_pools,
  public.daily_bonus_allocations,
  public.compensation_policies,
  public.employee_compensations,
  public.payroll_runs,
  public.payroll_entries,
  public.payroll_adjustments,
  public.payroll_exports,
  public.onboarding_progress
to service_role;

-- Harden earlier SECURITY DEFINER helpers and safely revoke the legacy login listing.
alter function public.is_manager() set search_path = public, pg_temp;
alter function public.can_access_assignment(uuid) set search_path = public, pg_temp;
alter function public.can_view_finance() set search_path = public, pg_temp;

revoke execute on function public.is_manager() from public, anon, authenticated;
revoke execute on function public.can_access_assignment(uuid) from public, anon, authenticated;
revoke execute on function public.can_view_finance() from public, anon, authenticated;
grant execute on function public.is_manager() to service_role;
grant execute on function public.can_access_assignment(uuid) to service_role;
grant execute on function public.can_view_finance() to service_role;

do $revoke_legacy_login$
begin
  if to_regprocedure('public.get_login_options()') is not null then
    execute 'alter function public.get_login_options() set search_path = public, pg_temp';
    execute 'revoke execute on function public.get_login_options() from public, anon, authenticated';
    execute 'grant execute on function public.get_login_options() to service_role';
  end if;
end;
$revoke_legacy_login$;

-- Exact function signatures: browser roles receive none; the trusted backend does.
revoke execute on function public.require_authorized_actor(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.log_audit_event(uuid, text, text, text, uuid, uuid, jsonb, jsonb, text, text) from public, anon, authenticated;
revoke execute on function public.enforce_append_only() from public, anon, authenticated;
revoke execute on function public.enforce_stock_snapshot_parent() from public, anon, authenticated;
revoke execute on function public.enforce_stock_snapshot_line_state() from public, anon, authenticated;
revoke execute on function public.enforce_report_revision_immutable() from public, anon, authenticated;
revoke execute on function public.enforce_report_line_state() from public, anon, authenticated;
revoke execute on function public.enforce_bonus_pool_state() from public, anon, authenticated;
revoke execute on function public.enforce_bonus_allocation_state() from public, anon, authenticated;
revoke execute on function public.enforce_payroll_entry_state() from public, anon, authenticated;
revoke execute on function public.enforce_payroll_adjustment_state() from public, anon, authenticated;
revoke execute on function public.enforce_payroll_run_state() from public, anon, authenticated;
revoke execute on function public.enforce_payroll_export_state() from public, anon, authenticated;
revoke execute on function public.haversine_distance_m(double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke execute on function public.rpc_record_auth_failure(uuid, text[]) from public, anon, authenticated;
revoke execute on function public.rpc_reset_auth_failures(uuid, text[]) from public, anon, authenticated;
revoke execute on function public.rpc_check_auth_limits(uuid, text[]) from public, anon, authenticated;
revoke execute on function public.rpc_create_attendance_challenge(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_record_attendance_event(uuid, uuid, uuid, uuid, uuid, text, text, uuid, uuid, jsonb, text, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_request_shift_swap(uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.rpc_respond_shift_swap(uuid, uuid, uuid, boolean, integer) from public, anon, authenticated;
revoke execute on function public.rpc_cancel_shift_swap(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.rpc_reset_assignment(uuid, uuid, uuid, integer, text) from public, anon, authenticated;
revoke execute on function public.rpc_create_user(uuid, uuid, text, text, public.app_role, text, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_change_pin(uuid, uuid, uuid, integer, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.rpc_reset_pin(uuid, uuid, text, text, text, integer) from public, anon, authenticated;
revoke execute on function public.rpc_claim_assignment(uuid, date, text, public.area_code, uuid, text) from public, anon, authenticated;
revoke execute on function public.rpc_confirm_opening(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.rpc_create_stock_movement(uuid, uuid, integer, text, public.movement_direction, text, numeric, timestamptz, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.rpc_complete_handover(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.rpc_confirm_closing(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.rpc_submit_daily_report(uuid, date, uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function public.rpc_review_daily_report(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_finalize_daily_bonus(uuid, uuid, numeric) from public, anon, authenticated;
revoke execute on function public.rpc_preview_payroll(uuid, uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.rpc_review_payroll(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.rpc_finalize_payroll(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.rpc_mark_payroll_paid(uuid, uuid, integer, text, text) from public, anon, authenticated;
revoke execute on function public.rpc_void_payroll(uuid, uuid, integer, text) from public, anon, authenticated;
revoke execute on function public.rpc_record_payroll_export(uuid, uuid, integer, text, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.require_authorized_actor(uuid, uuid) to service_role;
grant execute on function public.log_audit_event(uuid, text, text, text, uuid, uuid, jsonb, jsonb, text, text) to service_role;
grant execute on function public.enforce_append_only() to service_role;
grant execute on function public.enforce_stock_snapshot_parent() to service_role;
grant execute on function public.enforce_stock_snapshot_line_state() to service_role;
grant execute on function public.enforce_report_revision_immutable() to service_role;
grant execute on function public.enforce_report_line_state() to service_role;
grant execute on function public.enforce_bonus_pool_state() to service_role;
grant execute on function public.enforce_bonus_allocation_state() to service_role;
grant execute on function public.enforce_payroll_entry_state() to service_role;
grant execute on function public.enforce_payroll_adjustment_state() to service_role;
grant execute on function public.enforce_payroll_run_state() to service_role;
grant execute on function public.enforce_payroll_export_state() to service_role;
grant execute on function public.haversine_distance_m(double precision, double precision, double precision, double precision) to service_role;
grant execute on function public.rpc_record_auth_failure(uuid, text[]) to service_role;
grant execute on function public.rpc_reset_auth_failures(uuid, text[]) to service_role;
grant execute on function public.rpc_check_auth_limits(uuid, text[]) to service_role;
grant execute on function public.rpc_create_attendance_challenge(uuid, uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_record_attendance_event(uuid, uuid, uuid, uuid, uuid, text, text, uuid, uuid, jsonb, text, text, text) to service_role;
grant execute on function public.rpc_request_shift_swap(uuid, uuid, uuid, uuid, integer) to service_role;
grant execute on function public.rpc_respond_shift_swap(uuid, uuid, uuid, boolean, integer) to service_role;
grant execute on function public.rpc_cancel_shift_swap(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.rpc_reset_assignment(uuid, uuid, uuid, integer, text) to service_role;
grant execute on function public.rpc_create_user(uuid, uuid, text, text, public.app_role, text, text, text) to service_role;
grant execute on function public.rpc_change_pin(uuid, uuid, uuid, integer, text, text, boolean) to service_role;
grant execute on function public.rpc_reset_pin(uuid, uuid, text, text, text, integer) to service_role;
grant execute on function public.rpc_claim_assignment(uuid, date, text, public.area_code, uuid, text) to service_role;
grant execute on function public.rpc_confirm_opening(uuid, uuid, jsonb) to service_role;
grant execute on function public.rpc_create_stock_movement(uuid, uuid, integer, text, public.movement_direction, text, numeric, timestamptz, uuid, uuid, text) to service_role;
grant execute on function public.rpc_complete_handover(uuid, uuid) to service_role;
grant execute on function public.rpc_confirm_closing(uuid, uuid, jsonb) to service_role;
grant execute on function public.rpc_submit_daily_report(uuid, date, uuid, jsonb, text) to service_role;
grant execute on function public.rpc_review_daily_report(uuid, uuid, text, text) to service_role;
grant execute on function public.rpc_finalize_daily_bonus(uuid, uuid, numeric) to service_role;
grant execute on function public.rpc_preview_payroll(uuid, uuid, text, integer) to service_role;
grant execute on function public.rpc_review_payroll(uuid, uuid, integer) to service_role;
grant execute on function public.rpc_finalize_payroll(uuid, uuid, integer) to service_role;
grant execute on function public.rpc_mark_payroll_paid(uuid, uuid, integer, text, text) to service_role;
grant execute on function public.rpc_void_payroll(uuid, uuid, integer, text) to service_role;
grant execute on function public.rpc_record_payroll_export(uuid, uuid, integer, text, text, text, jsonb) to service_role;

-- Practical lookup and parent-state indexes not already supplied by 0001-0007.
create index if not exists profile_outlet_scopes_active_lookup_idx
  on public.profile_outlet_scopes (profile_id, outlet_id) where active is true;
create index if not exists work_cycles_state_lookup_idx
  on public.work_cycles (outlet_id, work_date, area_code, shift_code, status);
create index if not exists work_assignments_cycle_actor_state_idx
  on public.work_assignments (cycle_id, profile_id, status, duty_role);
create index if not exists stock_movements_cycle_item_cutoff_idx
  on public.stock_movements (cycle_id, item_id, server_occurred_at);
create index if not exists stock_handovers_confirmed_lookup_idx
  on public.stock_handovers (cycle_id, confirmed_at desc) where status = 'CONFIRMED';
create index if not exists stock_closings_confirmed_lookup_idx
  on public.stock_closings (cycle_id, confirmed_at desc) where status = 'CONFIRMED';
create index if not exists roster_entries_outlet_date_actor_idx
  on public.roster_entries (outlet_id, work_date, profile_id, status);
create unique index if not exists shift_swap_requests_one_pending_per_roster_idx
  on public.shift_swap_requests (roster_entry_id) where status = 'PENDING';
create index if not exists shift_swap_requests_target_pending_idx
  on public.shift_swap_requests (offered_to, expires_at) where status = 'PENDING';
create index if not exists attendance_records_assignment_valid_idx
  on public.attendance_records (work_assignment_id, status, exception_status)
  where work_assignment_id is not null;
create index if not exists auth_rate_limits_blocked_idx
  on public.auth_rate_limits (blocked_until) where blocked_until is not null;
create index if not exists attendance_challenges_binding_active_idx
  on public.attendance_challenges (profile_id, session_id, device_id, action, expires_at)
  where used_at is null;
create index if not exists attendance_records_open_checkout_idx
  on public.attendance_records (profile_id, outlet_id, work_date desc)
  where check_in_event_id is not null and check_out_event_id is null;
create index if not exists attendance_events_challenge_idx
  on public.attendance_events (challenge_id) where challenge_id is not null;
create unique index if not exists attendance_location_samples_event_order_uniq
  on public.attendance_location_samples (event_id, sample_order);
create index if not exists attendance_location_samples_retention_idx
  on public.attendance_location_samples (retained_until);
create unique index if not exists overtime_claims_attendance_uniq
  on public.overtime_claims (attendance_id);
create index if not exists attendance_corrections_pending_idx
  on public.attendance_corrections (attendance_id) where status = 'PENDING';
create index if not exists daily_report_revisions_current_lookup_idx
  on public.daily_report_revisions (report_id, revision desc, status);
create index if not exists audit_events_outlet_time_idx
  on public.audit_events (outlet_id, server_occurred_at desc);
create index if not exists payroll_entries_run_status_idx
  on public.payroll_entries (run_id, status);
create index if not exists employee_compensations_profile_policy_effective_idx
  on public.employee_compensations (profile_id, policy_id, effective_from, effective_to);
create index if not exists payroll_adjustments_entry_status_idx
  on public.payroll_adjustments (entry_id, status);
create index if not exists payroll_exports_run_generated_idx
  on public.payroll_exports (run_id, generated_at desc);
create index if not exists payroll_runs_replacement_idx
  on public.payroll_runs (replacement_run_id) where replacement_run_id is not null;
create index if not exists pin_history_profile_created_idx
  on public.pin_history (profile_id, created_at desc);
create index if not exists app_sessions_lookup_idx
  on public.app_sessions (token_hash) where revoked_at is null;

-- API integration contract: api/auth.ts must HMAC/SHA-256 credential, IP, and
-- device identifiers before passing scope keys, including p_profile_id = null
-- for unknown credentials. Raw nonce, PIN, token, IP, and coordinates must never
-- enter audit metadata. Attendance callers must resolve the active session/device
-- server-side and supply UUID idempotency keys.
