import { chmodSync } from 'node:fs';
import path from 'node:path';
import {
  BACKUP_ROOT,
  MANIFEST_ROOT,
  PRODUCTION_PROJECT_REF,
  REPO_ROOT,
  RUNTIME_TABLES,
  SANDBOX_ROOT,
  SNAPSHOT_ROOT,
  assertDockerAvailable,
  assertLocalDatabaseUrl,
  assertMigrationParity,
  assertProductionDatabaseUrl,
  createManifest,
  ensureDirectory,
  ensureLocalSupabase,
  ensureRequiredTools,
  fail,
  hashFile,
  latestMigrationVersion,
  listPublicTables,
  localMigrationVersions,
  psqlLocal,
  queryMigrationVersions,
  resolveSandboxEnv,
  runCommand,
  safeTimestamp,
  schemaFingerprint,
  snapshotTableList,
  tableSnapshot,
  writeJson0600,
} from './local-sandbox-lib.mjs';

function usage() {
  console.error('Gunakan: HOPIN_FULL_CLONE_ACK=1 pnpm db:local:sync atau pnpm db:local:sync');
  console.error('Perintah kedua sudah membawa konfirmasi target lokal; source tetap wajib HOPIN_PROD_DB_URL.');
}

function hasLocalConfirmation(argv, env) {
  return env.HOPIN_FULL_CLONE_ACK === '1' || argv.includes('--confirm-local-sandbox');
}

function dumpProduction(sourceUrl, outputPath, tables, env) {
  const args = [
    '--format=custom',
    '--compress=6',
    '--data-only',
    '--no-owner',
    '--no-privileges',
    '--file', outputPath,
    ...tables.map((table) => `--table=${table}`),
    ...RUNTIME_TABLES.map((table) => `--exclude-table=${table}`),
    sourceUrl,
  ];
  runCommand('pg_dump', args, {
    env: { ...env, PGOPTIONS: `${env.PGOPTIONS ? `${env.PGOPTIONS} ` : ''}-c default_transaction_read_only=on` },
    timeout: 300_000,
  });
}

function backupLocal(localUrl, backupPath, env) {
  runCommand('pg_dump', [
    '--format=custom',
    '--compress=6',
    '--no-owner',
    '--no-privileges',
    '--file', backupPath,
    localUrl,
  ], { env, timeout: 300_000 });
  try { chmodSync(backupPath, 0o600); } catch {}
}

function truncateLocalDatabase(localUrl, env) {
  const localTables = listPublicTables(localUrl, { env });
  const tables = localTables.map((qualified) => {
    const [schema, table] = qualified.split('.');
    return `"${schema}"."${table.replaceAll('"', '""')}"`;
  });
  if (tables.length) {
    psqlLocal(localUrl, `truncate table ${tables.join(', ')} restart identity cascade;`, { env });
  }
}

function restoreSnapshot(localUrl, dumpPath, env) {
  runCommand('pg_restore', [
    '--data-only',
    '--single-transaction',
    '--disable-triggers',
    '--no-owner',
    '--no-privileges',
    '--exit-on-error',
    '--dbname', localUrl,
    dumpPath,
  ], { env, timeout: 300_000 });
}

function resetLocalSchema(env) {
  runCommand('supabase', ['db', 'reset', '--local', '--yes'], { env, timeout: 300_000 });
}

async function main() {
  const env = resolveSandboxEnv();
  if (!hasLocalConfirmation(process.argv.slice(2), env)) {
    usage();
    fail('Konfirmasi local sandbox belum diberikan; tidak ada database yang disentuh.');
  }
  ensureRequiredTools();
  assertDockerAvailable();

  // Deliberately do not fall back to SUPABASE_URL: this repository used that
  // variable for production before the local sandbox existed.
  const sourceValue = env.HOPIN_PROD_DB_URL;
  if (!sourceValue) {
    fail('HOPIN_PROD_DB_URL wajib diisi dari connection string production read-only. File `.env.local` tidak dipakai sebagai source.');
  }
  const sourceUrl = assertProductionDatabaseUrl(sourceValue, PRODUCTION_PROJECT_REF);
  const localUrl = assertLocalDatabaseUrl(env.HOPIN_LOCAL_DB_URL);
  const localSupabaseUrl = env.HOPIN_LOCAL_SUPABASE_URL || 'http://127.0.0.1:54321';
  if (!/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(localSupabaseUrl)) {
    fail('HOPIN_LOCAL_SUPABASE_URL harus menunjuk ke Supabase lokal loopback.');
  }

  ensureDirectory(SANDBOX_ROOT);
  ensureDirectory(SNAPSHOT_ROOT);
  ensureDirectory(BACKUP_ROOT);
  ensureDirectory(MANIFEST_ROOT);

  console.log('Memeriksa parity migration production secara read-only...');
  const localVersions = localMigrationVersions(REPO_ROOT);
  const remoteVersions = queryMigrationVersions(sourceUrl, { env });
  assertMigrationParity(remoteVersions, localVersions);
  const schemaRevision = latestMigrationVersion(REPO_ROOT);
  const sourceFingerprint = schemaFingerprint(sourceUrl, { env });
  const sourceTables = snapshotTableList(listPublicTables(sourceUrl, { env }));

  const capturedAt = new Date().toISOString();
  const stamp = safeTimestamp(new Date(capturedAt));
  const dumpPath = path.join(SNAPSHOT_ROOT, `production-${stamp}.dump`);
  const backupPath = path.join(BACKUP_ROOT, `local-before-${stamp}.dump`);
  console.log('Mengambil snapshot production read-only...');
  dumpProduction(sourceUrl, dumpPath, sourceTables, env);
  const snapshotSha256 = hashFile(dumpPath);

  console.log('Memastikan Supabase lokal aktif...');
  await ensureLocalSupabase({ databaseUrl: localUrl, env });
  console.log('Membuat backup database lokal sebelum restore...');
  backupLocal(localUrl, backupPath, env);

  console.log('Memastikan schema lokal sama dengan migration production...');
  resetLocalSchema(env);
  const localAfterResetVersions = queryMigrationVersions(localUrl, { env });
  assertMigrationParity(localAfterResetVersions, localVersions);
  const localFingerprint = schemaFingerprint(localUrl, { env });
  if (localFingerprint !== sourceFingerprint) {
    fail('Schema fingerprint production dan lokal berbeda; restore dihentikan. Backup lokal sudah disimpan.');
  }

  console.log(`Mengganti data bisnis lokal (${sourceTables.length} tabel, tanpa tabel runtime)...`);
  truncateLocalDatabase(localUrl, env);
  restoreSnapshot(localUrl, dumpPath, env);

  console.log('Memverifikasi jumlah baris dan fingerprint tabel hasil restore...');
  const sourceTableRows = tableSnapshot(sourceUrl, sourceTables, { env });
  const localTableRows = tableSnapshot(localUrl, sourceTables, { env });
  const importedAt = new Date().toISOString();
  const manifest = createManifest({
    capturedAt,
    importedAt,
    schemaRevision,
    sourceTableRows,
    localTableRows,
    snapshotSha256,
    snapshotFile: path.relative(REPO_ROOT, dumpPath),
    backupFile: path.relative(REPO_ROOT, backupPath),
  });
  const manifestPath = path.join(MANIFEST_ROOT, `production-${stamp}.json`);
  writeJson0600(manifestPath, manifest);
  console.log(`Local sandbox siap dari snapshot ${capturedAt}. Manifest: ${path.relative(REPO_ROOT, manifestPath)}`);
  console.log('Perubahan CRUD berikutnya hanya masuk ke Supabase lokal; production tidak menjadi target aplikasi.');
}

try {
  await main();
} catch (error) {
  if (error?.name === 'LocalSandboxError') {
    console.error(`Local sandbox dihentikan: ${error.message}`);
  } else {
    console.error('Local sandbox dihentikan karena error yang tidak terduga. Detail sensitif tidak ditampilkan.');
  }
  process.exitCode = 1;
}
