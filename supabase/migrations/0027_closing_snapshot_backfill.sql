-- 0027: backfill snapshot metadata for closing/report lines predating 0023.
-- Rows written before 0023 carry NULL snapshots, which makes their closing
-- unsubmittable (BAR/KITCHEN_CLOSING_INCOMPLETE). Backfill from the current
-- items master so previously confirmed closings stay submittable. This is a
-- documented approximation for legacy rows: it records today's master values,
-- not the historical B02 values. Rows whose item no longer exists keep NULL
-- snapshots and remain explicitly unsubmittable.

-- The immutable-snapshot triggers deliberately block writes to confirmed
-- lines, so the one-time backfill runs with replica role (superuser-only;
-- fails loudly otherwise) and restores origin before verification.
set session_replication_role = replica;

update public.stock_closing_lines line
set item_name_snapshot = item.name,
    unit_code_snapshot = item.unit_code,
    decimal_scale_snapshot = item.decimal_scale,
    low_threshold_snapshot = item.low_threshold
from public.items item
where line.item_id = item.id
  and (line.item_name_snapshot is null
    or line.unit_code_snapshot is null
    or line.decimal_scale_snapshot is null
    or line.low_threshold_snapshot is null);

update public.daily_report_stock_lines rline
set item_name_snapshot = item.name,
    unit_code_snapshot = item.unit_code,
    decimal_scale_snapshot = item.decimal_scale
from public.items item
where rline.item_id = item.id
  and (rline.item_name_snapshot is null
    or rline.unit_code_snapshot is null
    or rline.decimal_scale_snapshot is null);

reset session_replication_role;

do $$
declare
  v_closing integer;
  v_report integer;
begin
  select count(*) into v_closing
  from public.stock_closing_lines line
  join public.items item on item.id = line.item_id
  where line.item_name_snapshot is null
     or line.unit_code_snapshot is null
     or line.decimal_scale_snapshot is null
     or line.low_threshold_snapshot is null;
  if v_closing <> 0 then
    raise exception using errcode = '55000', message = 'BACKFILL_INCOMPLETE: closing lines still lack snapshots.';
  end if;
  select count(*) into v_report
  from public.daily_report_stock_lines rline
  join public.items item on item.id = rline.item_id
  where rline.item_name_snapshot is null
     or rline.unit_code_snapshot is null
     or rline.decimal_scale_snapshot is null;
  if v_report <> 0 then
    raise exception using errcode = '55000', message = 'BACKFILL_INCOMPLETE: report lines still lack snapshots.';
  end if;
end;
$$;
