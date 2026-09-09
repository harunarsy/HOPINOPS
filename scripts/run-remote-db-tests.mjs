import { spawnSync } from 'node:child_process';

const PRODUCTION_REF = 'naanarmoktmsumkxmjvj';
const STAGING_REF = 'ibzlxdmnuszcmdzuocwu';
const forbiddenRefs = new Set([PRODUCTION_REF, STAGING_REF]);

function fail(message) {
  console.error(`Database test ditolak: ${message}`);
  process.exit(1);
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const projectRef = (process.env.DB_TEST_PROJECT_REF ?? '').trim();
const databaseUrl = process.env.DB_TEST_DATABASE_URL ?? '';

if (!/^[a-z]{20}$/.test(projectRef)) fail('DB_TEST_PROJECT_REF wajib berupa project ref Supabase 20 karakter.');
if (forbiddenRefs.has(projectRef)) fail('production dan staging aplikasi tidak boleh menjadi target database test.');
if (process.env.DB_TEST_DISPOSABLE !== '1') fail('set DB_TEST_DISPOSABLE=1 untuk mengonfirmasi target memang khusus test.');
if (!databaseUrl) fail('DB_TEST_DATABASE_URL wajib diisi.');

let parsed;
try {
  parsed = new URL(databaseUrl);
} catch {
  fail('DB_TEST_DATABASE_URL bukan connection string PostgreSQL yang valid.');
}

if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) fail('DB_TEST_DATABASE_URL wajib memakai protokol PostgreSQL.');
if (!parsed.password) fail('DB_TEST_DATABASE_URL wajib memiliki password database test.');
if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') fail('target lokal tidak didukung karena workflow ini harus bebas Docker.');

const directHostMatches = parsed.hostname === `db.${projectRef}.supabase.co`;
const poolerMatches = parsed.hostname.endsWith('.pooler.supabase.com') && parsed.username.endsWith(`.${projectRef}`);
if (!directHostMatches && !poolerMatches) fail('connection string tidak cocok dengan DB_TEST_PROJECT_REF.');

for (const forbiddenRef of forbiddenRefs) {
  if (databaseUrl.includes(forbiddenRef)) fail('connection string mengarah ke project HOPIN yang dilindungi.');
}

console.log(`Target database test tervalidasi: project ${projectRef} (disposable).`);

if (process.argv.includes('--migrate')) {
  console.log('Menerapkan migration yang belum ada ke database test...');
  run('pnpm', ['exec', 'supabase', 'db', 'push', '--db-url', databaseUrl, '--include-all', '--yes']);
}

console.log('Menjalankan pgTAP database contract...');
run('pnpm', ['exec', 'supabase', 'test', 'db', '--db-url', databaseUrl, 'supabase/tests/database.test.sql']);

console.log('Menjalankan SQL regression transactional...');
for (const file of [
  'supabase/tests/catalog_pending.local.sql',
  'supabase/tests/physical_baseline.local.sql',
  'supabase/tests/self_emergency.local.sql',
  'supabase/tests/payroll_export.local.sql',
  'supabase/tests/closing_backfill.local.sql',
]) {
  run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', databaseUrl, '-f', file]);
}

console.log('Database test remote selesai tanpa Docker.');
