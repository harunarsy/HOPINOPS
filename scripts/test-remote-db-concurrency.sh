#!/bin/sh
set -eu
printf '%s\n' 'Pengujian mutasi database dinonaktifkan pada workflow production.' >&2
exit 1

if [ "${DB_TEST_DISPOSABLE:-}" != "1" ]; then
  printf '%s\n' 'Refusing concurrency test without DB_TEST_DISPOSABLE=1.' >&2
  exit 1
fi
if [ -z "${DB_TEST_DATABASE_URL:-}" ]; then
  printf '%s\n' 'DB_TEST_DATABASE_URL is required.' >&2
  exit 1
fi

workdir="${TMPDIR:-/tmp}/hopin-db-concurrency-$$"
mkdir "$workdir"
cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT INT TERM

psql_cmd() {
  psql -X -v ON_ERROR_STOP=1 "$DB_TEST_DATABASE_URL" "$@"
}

profile_id=$(uuidgen | tr 'A-Z' 'a-z')
cycle_id=$(uuidgen | tr 'A-Z' 'a-z')
assignment_id=$(uuidgen | tr 'A-Z' 'a-z')
attendance_id=$(uuidgen | tr 'A-Z' 'a-z')
checkin_event_id=$(uuidgen | tr 'A-Z' 'a-z')
idem_key=$(uuidgen | tr 'A-Z' 'a-z')

used_slots=$(psql_cmd -At -c "select shift_code || '/' || area_code::text from public.work_cycles where outlet_id = '11111111-1111-1111-1111-111111111111' and work_date = current_date;")
shift_code=""
area_code=""
for combo in "SIANG BAR" "SIANG KITCHEN" "MALAM BAR" "MALAM KITCHEN" "FULL BAR" "FULL KITCHEN"; do
  set -- $combo
  case "$used_slots" in
    *"$1/$2"*) continue ;;
    *) shift_code="$1"; area_code="$2"; break ;;
  esac
done
if [ -z "$shift_code" ]; then
  printf '%s\n' 'No free cycle slot left today for the concurrency fixture.' >&2
  exit 1
fi

psql_cmd <<SQL
begin;
insert into public.profiles (id, display_name, role, active)
values ('$profile_id', 'Concurrent emergency operator', 'OPERATOR', true);
insert into public.profile_outlet_scopes (profile_id, outlet_id)
values ('$profile_id', '11111111-1111-1111-1111-111111111111');
insert into public.work_cycles (id, outlet_id, work_date, shift_code, area_code, status)
values ('$cycle_id', '11111111-1111-1111-1111-111111111111', current_date, '$shift_code', '$area_code', 'ACTIVE');
insert into public.work_assignments (id, cycle_id, work_date, profile_id, duty_role, status)
values ('$assignment_id', '$cycle_id', current_date, '$profile_id', 'PRIMARY', 'ACTIVE');
insert into public.attendance_records (id, outlet_id, work_date, profile_id, work_assignment_id, status, version)
values ('$attendance_id', '11111111-1111-1111-1111-111111111111', current_date, '$profile_id', '$assignment_id', 'CHECKED_IN', 1);
insert into public.attendance_events (id, attendance_id, event_type, location_status, idempotency_key)
values ('$checkin_event_id', '$attendance_id', 'CHECK_IN', 'VERIFIED', '$checkin_event_id');
update public.attendance_records set check_in_event_id = '$checkin_event_id' where id = '$attendance_id';
commit;
SQL

cat > "$workdir/call.sql" <<SQL
select public.rpc_self_emergency_checkout(
  '$profile_id',
  '11111111-1111-1111-1111-111111111111',
  1,
  '$idem_key',
  'Concurrent emergency reason'
);
SQL

psql_cmd -At -f "$workdir/call.sql" > "$workdir/first.out" 2> "$workdir/first.err" &
first_pid=$!
psql_cmd -At -f "$workdir/call.sql" > "$workdir/second.out" 2> "$workdir/second.err" &
second_pid=$!

wait "$first_pid"
wait "$second_pid"

psql_cmd -v ON_ERROR_STOP=1 <<SQL
do \$\$
declare
  checkout_events integer;
  audit_rows integer;
  receipt_rows integer;
begin
  select count(*) into checkout_events from public.attendance_events
  where attendance_id = '$attendance_id' and event_type = 'CHECK_OUT';
  select count(*) into audit_rows from public.audit_events
  where action = 'SELF_EMERGENCY_CHECKOUT' and entity_id = '$attendance_id';
  select count(*) into receipt_rows from public.workflow_idempotency
  where actor_user_id = '$profile_id'
    and outlet_id = '11111111-1111-1111-1111-111111111111'
    and action = 'SELF_EMERGENCY_CHECKOUT'
    and idempotency_key = '$idem_key'
    and response_json is not null;
  if checkout_events <> 1 or audit_rows <> 1 or receipt_rows <> 1 then
    raise exception 'Concurrent invariant failed: checkout %, audit %, receipt %', checkout_events, audit_rows, receipt_rows;
  end if;
end \$\$;
SQL

if ! grep -q 'idempotent_replay' "$workdir/first.out" || ! grep -q 'idempotent_replay' "$workdir/second.out"; then
  printf '%s\n' 'Concurrent callers did not both receive RPC receipts.' >&2
  cat "$workdir/first.err" >&2
  cat "$workdir/second.err" >&2
  exit 1
fi

psql_cmd -v ON_ERROR_STOP=1 <<SQL
begin;
set local session_replication_role = replica;
delete from public.attendance_records where id = '$attendance_id';
delete from public.workflow_idempotency
where actor_user_id = '$profile_id'
  and outlet_id = '11111111-1111-1111-1111-111111111111'
  and action = 'SELF_EMERGENCY_CHECKOUT'
  and idempotency_key = '$idem_key';
delete from public.work_assignments where id = '$assignment_id';
delete from public.work_cycles where id = '$cycle_id';
delete from public.profile_outlet_scopes where profile_id = '$profile_id';
delete from public.profiles where id = '$profile_id';
commit;
SQL

printf '%s\n' 'PASS: remote concurrent self-emergency created one checkout, audit, and receipt.'
