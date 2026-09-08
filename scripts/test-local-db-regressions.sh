#!/bin/sh
set -eu

host="${HOPIN_TEST_DB_HOST:-localhost}"
port="${HOPIN_TEST_DB_PORT:-55432}"
database="${HOPIN_TEST_DB_NAME:-hopin_test}"

if [ "$host" != "localhost" ] && [ "$host" != "127.0.0.1" ]; then
  printf '%s\n' "Refusing non-local database host: $host" >&2
  exit 1
fi
if [ "$port" != "55432" ] || [ "$database" != "hopin_test" ]; then
  printf '%s\n' "Refusing unexpected disposable target: $host:$port/$database" >&2
  exit 1
fi

for test_file in \
  supabase/tests/catalog_pending.local.sql \
  supabase/tests/physical_baseline.local.sql \
  supabase/tests/self_emergency.local.sql \
  supabase/tests/payroll_export.local.sql \
  supabase/tests/closing_backfill.local.sql
do
  psql -X -v ON_ERROR_STOP=1 -h "$host" -p "$port" -d "$database" -f "$test_file"
done
