-- 0033: display codes must never truncate past 999.
--
-- `lpad(text, 3, '0')` truncates strings longer than 3 characters, so once the
-- per-area sequence crossed 1000 the generated codes silently lost digits
-- (1020 -> '102', 1066 -> '106') and eventually collided with an existing code,
-- aborting the audited item-create RPC. Pad to at least three digits without
-- ever truncating.

create or replace function public.next_item_display_code(p_area public.area_code)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next integer;
  v_prefix text;
begin
  if p_area is null then
    raise exception using errcode = '22023', message = 'AREA_REQUIRED: Area item wajib diisi.';
  end if;

  insert into public.item_code_sequences(area_code, next_value)
  values (p_area, 1)
  on conflict (area_code) do nothing;

  select next_value into v_next
  from public.item_code_sequences
  where area_code = p_area
  for update;

  update public.item_code_sequences
  set next_value = v_next + 1
  where area_code = p_area;

  v_prefix := case when p_area = 'BAR' then 'BAR' else 'KIT' end;
  return v_prefix || '-' || lpad(v_next::text, greatest(3, length(v_next::text)), '0');
end;
$$;
