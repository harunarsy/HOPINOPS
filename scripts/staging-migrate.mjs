/**
 * Apply repository migrations to the disposable Supabase staging project.
 *
 * This intentionally does not support project linking, resets, or arbitrary
 * refs. A direct staging DB URL is required and is validated before the
 * Supabase CLI is started. Production credentials/URLs are rejected by the
 * shared staging runtime guard.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertStagingDatabaseEnv,
  loadStagingEnv,
} from './staging-runtime.mjs';

function fail(message) {
  throw new Error(`Migration staging dihentikan: ${message}`);
}

function parseArgs(argv) {
  const allowed = new Set(['--confirm-staging-migration', '--dry-run']);
  // pnpm forwards a standalone `--` when callers use the conventional
  // `pnpm script -- --dry-run` form; it is a delimiter, not an option.
  const args = new Set(argv.filter((arg) => arg !== '--'));
  for (const arg of args) {
    if (!allowed.has(arg)) fail(`opsi tidak dikenal: ${arg}`);
  }
  if (args.has('--confirm-staging-migration') && args.has('--dry-run')) {
    fail('pilih salah satu --dry-run atau --confirm-staging-migration.');
  }
  return { confirm: args.has('--confirm-staging-migration'), dryRun: args.has('--dry-run') };
}

function migrationFiles() {
  const directory = path.join(process.cwd(), 'supabase', 'migrations');
  return readdirSync(directory)
    .filter((file) => /^\d{4,}_.*\.sql$/.test(file))
    .sort();
}

function checkSupabaseCli() {
  const result = spawnSync('pnpm', ['exec', 'supabase', '--version'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'ignore',
  });
  if (result.error || result.status !== 0) {
    fail('Supabase CLI tidak tersedia. Instal/aktifkan Supabase CLI lalu ulangi; tidak ada database yang disentuh.');
  }
}

function applyMigrations(databaseUrl) {
  // Do not print commandArgs: databaseUrl is a secret-bearing connection
  // string. The value is passed only to the child process.
  const result = spawnSync('pnpm', [
    'exec',
    'supabase',
    'db',
    'push',
    '--db-url',
    databaseUrl,
    '--include-all',
    '--yes',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOPIN_RUNTIME: 'staging',
      HOPIN_STAGING_PROJECT_REF: env.HOPIN_STAGING_PROJECT_REF,
    },
    stdio: 'inherit',
  });
  if (result.error) fail('Supabase CLI tidak dapat dijalankan; tidak ada fallback ke production.');
  if (result.status !== 0) fail(`Supabase CLI gagal (exit ${result.status ?? 'unknown'}).`);
}

function managementQuery(args) {
  const result = spawnSync('pnpm', [
    'exec', 'supabase', 'db', 'query', '--linked',
    '--project-ref', env.HOPIN_STAGING_PROJECT_REF,
    '--output-format', 'json',
    ...args,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HOPIN_RUNTIME: 'staging', HOPIN_STAGING_PROJECT_REF: env.HOPIN_STAGING_PROJECT_REF },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error('Supabase SQL Management API gagal menjalankan query staging.');
  }
  return String(result.stdout ?? '');
}

function applyViaManagementApi(files) {
  // Direct Postgres can be blocked by a workstation network policy (for
  // example IPv6). The Supabase Management API remains a deterministic,
  // remote-only fallback and does not need a local database engine.
  managementQuery(['create table if not exists public.hopin_schema_migrations (version text primary key, name text not null, applied_at timestamptz not null default now())']);
  for (const file of files) {
    const version = file.split('_', 1)[0];
    const check = managementQuery(['select 1 as applied from public.hopin_schema_migrations where version = ' + `'${version}'` + ' limit 1']);
    if (/"rows"\s*:\s*\[\s*\{/.test(check)) continue;
    managementQuery(['--file', path.join(process.cwd(), 'supabase', 'migrations', file)]);
    managementQuery([`insert into public.hopin_schema_migrations(version, name) values ('${version}', '${file.replaceAll("'", "''")}')`]);
    console.log(`Migration ${version} diterapkan.`);
  }
}

const { confirm, dryRun } = parseArgs(process.argv.slice(2));
// Migration may operate with a DB-only secret; the server key is not needed
// by `supabase db push`. The target and DB URL are still both mandatory.
const env = loadStagingEnv({}, { requireServiceRole: false });
const databaseUrl = assertStagingDatabaseEnv(env);
const files = migrationFiles();
if (files.length === 0) fail('folder supabase/migrations kosong.');

if (dryRun) {
  console.log(`Migration staging dry-run: ${files.length} file akan diperiksa untuk ${env.HOPIN_STAGING_PROJECT_REF}.`);
  console.log(`- migration terakhir di repo: ${files.at(-1)}`);
  process.exit(0);
}

if (!confirm && process.env.HOPIN_STAGING_MIGRATE_ACK !== '1') {
  fail('migration remote memerlukan HOPIN_STAGING_MIGRATE_ACK=1 atau --confirm-staging-migration; tidak ada database yang disentuh.');
}

checkSupabaseCli();
console.log(`Menerapkan ${files.length} migration ke Supabase staging ${env.HOPIN_STAGING_PROJECT_REF}...`);
try {
  applyMigrations(databaseUrl);
  console.log(`Migration staging selesai: ${files.length} file diperiksa.`);
} catch (directError) {
  console.warn('Koneksi direct database staging gagal; beralih ke SQL Management API tanpa database lokal.');
  try {
    applyViaManagementApi(files);
    console.log(`Migration staging selesai melalui Management API: ${files.length} file diperiksa.`);
  } catch (managementError) {
    throw new Error(`Migration direct dan Management API gagal (${managementError?.message || directError?.message || 'error tidak diketahui'}).`);
  }
}
