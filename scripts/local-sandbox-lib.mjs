import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_PROJECT_REF = 'naanarmoktmsumkxmjvj';
export const DEFAULT_LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
export const DEFAULT_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const LOCAL_RUNTIME = 'local';
export const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
export const RUNTIME_TABLES = Object.freeze([
  'public.app_sessions',
  'public.app_devices',
  'public.auth_rate_limits',
  'public.attendance_challenges',
  'public.workflow_idempotency',
  'public.payroll_export_download_authorizations',
  'public.payroll_export_reservations',
]);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SANDBOX_ROOT = path.join(REPO_ROOT, '.local-sandbox');
export const SNAPSHOT_ROOT = path.join(SANDBOX_ROOT, 'snapshots');
export const BACKUP_ROOT = path.join(SANDBOX_ROOT, 'backups');
export const MANIFEST_ROOT = path.join(SANDBOX_ROOT, 'manifests');

export class LocalSandboxError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'LocalSandboxError';
  }
}

export function fail(message) {
  throw new LocalSandboxError(message);
}

export function isLoopbackHostname(hostname) {
  return LOCAL_HOSTNAMES.has(String(hostname ?? '').toLowerCase());
}

function parseQuotedValue(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    if (trimmed.startsWith("'")) return trimmed.slice(1, -1);
    return trimmed.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  const commentIndex = trimmed.search(/\s+#/);
  return (commentIndex >= 0 ? trimmed.slice(0, commentIndex) : trimmed).trim();
}

/** Parse the small dotenv subset used by local sandbox credentials. */
export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    values[assignment[1]] = parseQuotedValue(assignment[2]);
  }
  return values;
}

export function loadEnvFile(filePath) {
  if (!filePath) return {};
  if (!existsSync(filePath)) fail(`File environment tidak ditemukan: ${filePath}`);
  return parseDotEnv(readFileSync(filePath, 'utf8'));
}

/**
 * Reads only the dedicated snapshot env file. `.env.local` is deliberately
 * ignored because this repository historically used it for production API
 * credentials and it must never become a snapshot source by accident.
 */
export function resolveSandboxEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const envFile = env.HOPIN_PROD_DB_ENV_FILE || path.join(REPO_ROOT, '.env.production-snapshot');
  if (existsSync(envFile)) {
    const fileValues = loadEnvFile(envFile);
    for (const [key, value] of Object.entries(fileValues)) {
      if (env[key] === undefined) env[key] = value;
    }
  }
  return env;
}

function parseDatabaseUrl(value, label) {
  if (!value) fail(`${label} wajib diisi.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} bukan connection string PostgreSQL yang valid.`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    fail(`${label} wajib memakai protokol PostgreSQL.`);
  }
  return parsed;
}

export function assertProductionDatabaseUrl(value, expectedProjectRef = PRODUCTION_PROJECT_REF) {
  const parsed = parseDatabaseUrl(value, 'HOPIN_PROD_DB_URL');
  const expectedDirectHost = `db.${expectedProjectRef}.supabase.co`;
  const isDirectHost = parsed.hostname === expectedDirectHost;
  const isPoolerHost = parsed.hostname.endsWith('.pooler.supabase.com')
    && (parsed.username === `postgres.${expectedProjectRef}` || parsed.username.endsWith(`.${expectedProjectRef}`));
  if (!isDirectHost && !isPoolerHost) {
    fail('HOPIN_PROD_DB_URL harus mengarah ke database production Supabase yang dilindungi; target lain ditolak.');
  }
  if (!parsed.password) fail('HOPIN_PROD_DB_URL harus memiliki password database; gunakan connection string read-only.');
  if (isLoopbackHostname(parsed.hostname)) fail('HOPIN_PROD_DB_URL tidak boleh mengarah ke target lokal.');

  // Force TLS for remote snapshot reads even if the caller supplied a weaker
  // sslmode. The source remains read-only from the runner's perspective.
  parsed.searchParams.set('sslmode', 'require');
  return parsed.toString();
}

export function assertLocalDatabaseUrl(value) {
  const parsed = parseDatabaseUrl(value || DEFAULT_LOCAL_DB_URL, 'HOPIN_LOCAL_DB_URL');
  if (!isLoopbackHostname(parsed.hostname)) {
    fail('Target database lokal harus loopback (localhost, 127.0.0.1, atau ::1); remote database ditolak.');
  }
  return parsed.toString();
}

export function assertLocalSupabaseUrl(value) {
  const candidate = value || DEFAULT_LOCAL_SUPABASE_URL;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    fail('HOPIN_LOCAL_SUPABASE_URL bukan URL yang valid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopbackHostname(parsed.hostname)) {
    fail('Supabase lokal harus memakai URL HTTP loopback; URL remote ditolak.');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function assertLocalRuntimeTarget({ runtime, supabaseUrl, databaseUrl } = {}) {
  if (runtime !== LOCAL_RUNTIME) return;
  assertLocalSupabaseUrl(supabaseUrl);
  assertLocalDatabaseUrl(databaseUrl);
}

export function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function ensureDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
  return directory;
}

function commandName(command) {
  return path.basename(command);
}

/** Run a command without ever echoing captured stderr (it can contain URLs). */
export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') fail(`Perintah ${commandName(command)} tidak ditemukan. Instal tool yang dibutuhkan lalu ulangi.`);
    fail(`Perintah ${commandName(command)} gagal dijalankan.`);
  }
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    fail(`Perintah ${commandName(command)} gagal (exit ${status}). Detail sensitif tidak ditampilkan.`);
  }
  return {
    status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

export function readSupabaseStatusEnv(options = {}) {
  const result = runCommand(options.supabaseCommand || 'supabase', ['status', '-o', 'env'], {
    env: options.env || process.env,
    allowFailure: true,
    timeout: options.timeout || 30_000,
  });
  if (result.status !== 0) return {};
  return parseDotEnv(result.stdout);
}

export function withReadOnlyDbEnv(env = process.env) {
  const existing = env.PGOPTIONS ? `${env.PGOPTIONS} ` : '';
  return { ...env, PGOPTIONS: `${existing}-c default_transaction_read_only=on` };
}

export function psqlCapture(databaseUrl, sql, options = {}) {
  const result = runCommand(options.psqlCommand || 'psql', [
    '-X',
    '-v', 'ON_ERROR_STOP=1',
    '-At',
    databaseUrl,
    '-c', sql,
  ], {
    env: withReadOnlyDbEnv(options.env || process.env),
    allowFailure: options.allowFailure,
    timeout: options.timeout || 120_000,
  });
  return result.stdout.trim();
}

export function psqlLocal(databaseUrl, sql, options = {}) {
  const localUrl = assertLocalDatabaseUrl(databaseUrl);
  const result = runCommand(options.psqlCommand || 'psql', [
    '-X',
    '-v', 'ON_ERROR_STOP=1',
    localUrl,
    '-c', sql,
  ], {
    env: options.env || process.env,
    allowFailure: options.allowFailure,
    timeout: options.timeout || 120_000,
  });
  return result.stdout.trim();
}

export function ensureRequiredTools() {
  for (const command of ['docker', 'pg_dump', 'pg_restore', 'psql', 'supabase']) {
    const result = runCommand(command, ['--version'], { allowFailure: true, timeout: 15_000 });
    if (result.status !== 0) fail(`Tool ${command} tidak tersedia atau tidak dapat dijalankan.`);
  }
}

export function assertDockerAvailable() {
  const result = runCommand('docker', ['info'], { allowFailure: true, timeout: 30_000 });
  if (result.status !== 0) {
    fail('Docker daemon belum aktif. Buka Docker Desktop, tunggu sampai siap, lalu ulangi perintah local sandbox.');
  }
}

export async function waitForLocalDatabase(databaseUrl, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 120_000);
  while (Date.now() < deadline) {
    const result = runCommand(options.psqlCommand || 'psql', [
      '-X', '-v', 'ON_ERROR_STOP=1', '-At', databaseUrl, '-c', 'select 1',
    ], {
      env: options.env || process.env,
      allowFailure: true,
      timeout: 10_000,
    });
    if (result.status === 0 && result.stdout.trim() === '1') return true;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs || 1000));
  }
  fail('Supabase lokal belum siap setelah menunggu 120 detik. Pastikan Docker dan `supabase start` berhasil.');
}

export async function ensureLocalSupabase(options = {}) {
  const env = options.env || process.env;
  const databaseUrl = assertLocalDatabaseUrl(options.databaseUrl || env.HOPIN_LOCAL_DB_URL || DEFAULT_LOCAL_DB_URL);
  assertDockerAvailable();
  const ready = runCommand(options.psqlCommand || 'psql', [
    '-X', '-v', 'ON_ERROR_STOP=1', '-At', databaseUrl, '-c', 'select 1',
  ], { env, allowFailure: true, timeout: 10_000 });
  if (ready.status !== 0 || ready.stdout.trim() !== '1') {
    const started = runCommand(options.supabaseCommand || 'supabase', ['start'], {
      env,
      allowFailure: true,
      timeout: 180_000,
    });
    if (started.status !== 0) fail('Supabase lokal gagal dinyalakan. Pastikan Docker Desktop aktif dan jalankan `supabase start` untuk melihat statusnya.');
    await waitForLocalDatabase(databaseUrl, options);
  }
  return databaseUrl;
}

export function localMigrationVersions(repoRoot = REPO_ROOT) {
  const migrationDir = path.join(repoRoot, 'supabase', 'migrations');
  if (!existsSync(migrationDir)) fail('Folder supabase/migrations tidak ditemukan.');
  const files = readdirSync(migrationDir).filter((file) => /^\d+_[^/]+\.sql$/.test(file));
  const versions = files.map((file) => file.match(/^(\d+)_/)[1]);
  if (new Set(versions).size !== versions.length) fail('Nomor migration duplikat ditemukan; hentikan sync sampai diperbaiki.');
  return versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function latestMigrationVersion(repoRoot = REPO_ROOT) {
  const versions = localMigrationVersions(repoRoot);
  return versions.at(-1) || null;
}

export function queryMigrationVersions(databaseUrl, options = {}) {
  const output = psqlCapture(databaseUrl, 'select version::text from supabase_migrations.schema_migrations order by version;', options);
  return output ? output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) : [];
}

export function assertMigrationParity(remoteVersions, localVersions) {
  const remote = new Set(remoteVersions);
  const local = new Set(localVersions);
  const missing = localVersions.filter((version) => !remote.has(version));
  const unknown = remoteVersions.filter((version) => !local.has(version));
  if (missing.length || unknown.length) {
    const details = [
      missing.length ? `belum di production: ${missing.join(', ')}` : '',
      unknown.length ? `tidak ada di repo: ${unknown.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    fail(`Schema migration tidak parity (${details}). Sync dihentikan sebelum target lokal ditimpa.`);
  }
  return true;
}

export const SCHEMA_FINGERPRINT_SQL = `
select coalesce(string_agg(
  n.nspname || '.' || c.relname || '|' || c.relkind || '|' || a.attnum::text || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text,
  E'\\n' order by c.relname, a.attnum
), '')
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm')
  and a.attnum > 0
  and not a.attisdropped;
`;

export function schemaFingerprint(databaseUrl, options = {}) {
  return createHash('sha256').update(psqlCapture(databaseUrl, SCHEMA_FINGERPRINT_SQL, options)).digest('hex');
}

export function quoteIdentifier(identifier) {
  if (typeof identifier !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    fail('Nama tabel dari database tidak valid; sync dihentikan.');
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function listPublicTables(databaseUrl, options = {}) {
  const output = psqlCapture(databaseUrl, `
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
    order by c.relname;
  `, options);
  return output ? output.split(/\r?\n/).map((name) => name.trim()).filter(Boolean).map((name) => `public.${name}`) : [];
}

function rowFingerprint(databaseUrl, qualifiedTable, options = {}) {
  const [schema, table] = qualifiedTable.split('.');
  const identifier = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const sql = `
    select md5(coalesce(string_agg(row_hash, '' order by row_hash), ''))
    from (
      select md5(to_jsonb(t)::text) as row_hash
      from ${identifier} as t
    ) as rows;
  `;
  const output = psqlCapture(databaseUrl, sql, options);
  return output || createHash('md5').update('').digest('hex');
}

export function tableSnapshot(databaseUrl, qualifiedTables, options = {}) {
  const rows = {};
  for (const qualifiedTable of qualifiedTables) {
    const [schema, table] = qualifiedTable.split('.');
    const identifier = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const countOutput = psqlCapture(databaseUrl, `select count(*)::bigint from ${identifier};`, options);
    const count = Number(countOutput || 0);
    if (!Number.isSafeInteger(count)) fail(`Jumlah baris ${qualifiedTable} terlalu besar untuk manifest lokal.`);
    const digestSeed = rowFingerprint(databaseUrl, qualifiedTable, options);
    const digest = createHash('sha256').update(`${qualifiedTable}\0${count}\0${digestSeed}`).digest('hex');
    rows[qualifiedTable] = { rows: count, sha256: digest };
  }
  return rows;
}

export function snapshotTableList(publicTables) {
  const excluded = new Set(RUNTIME_TABLES);
  return [...publicTables].filter((table, index, all) => all.indexOf(table) === index && !excluded.has(table));
}

export function excludedRuntimeTables() {
  return [...RUNTIME_TABLES, 'auth.*', 'storage.*'];
}

export function hashFile(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

export function createManifest({ capturedAt, importedAt, schemaRevision, sourceTableRows, localTableRows, snapshotSha256, snapshotFile, backupFile }) {
  const tableNames = new Set([...Object.keys(sourceTableRows || {}), ...Object.keys(localTableRows || {})]);
  const tables = {};
  for (const table of [...tableNames].sort()) {
    const source = sourceTableRows?.[table];
    const local = localTableRows?.[table];
    if (!source || !local || source.rows !== local.rows || source.sha256 !== local.sha256) {
      fail(`Verifikasi snapshot gagal pada ${table}; restore dianggap tidak aman.`);
    }
    tables[table] = source;
  }
  return {
    sourceProjectRef: PRODUCTION_PROJECT_REF,
    schemaRevision,
    capturedAt,
    importedAt,
    mode: 'FULL_BUSINESS',
    snapshotFile,
    snapshotSha256,
    backupFile,
    tables,
    excludedRuntimeTables: excludedRuntimeTables(),
  };
}

export function writeJson0600(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const text = `${JSON.stringify(value, null, 2)}\n`;
  // writeFileSync is intentionally kept here so callers cannot accidentally
  // create manifests with default world-readable permissions.
  writeFileSync(filePath, text, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(filePath, 0o600); } catch {}
  return filePath;
}
