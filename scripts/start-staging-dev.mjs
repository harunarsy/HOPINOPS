/**
 * Start the full HOPIN app locally while pointing server functions at the
 * disposable remote staging Supabase project. A local database is deliberately
 * not part of this workflow.
 *
 * Normal development:
 *   pnpm dev:staging
 *
 * Full staging smoke (mutating staging only):
 *   HOPIN_STAGING_MIGRATE_ACK=1 pnpm test:operator:staging
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  assertLocalBaseUrl,
  assertPort,
  createRunId,
  loadStagingEnv,
} from './staging-runtime.mjs';

function fail(message) {
  throw new Error(`Staging dev dihentikan: ${message}`);
}

function parseArgs(argv) {
  const args = { migrate: false, runSmoke: false, port: null, runId: null };
  const normalizedArgv = argv.filter((arg) => arg !== '--');
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const arg = normalizedArgv[index];
    if (arg === '--migrate') args.migrate = true;
    else if (arg === '--run-smoke') args.runSmoke = true;
    else if (arg === '--port') args.port = normalizedArgv[++index];
    else if (arg === '--run-id') args.runId = normalizedArgv[++index];
    else fail(`opsi tidak dikenal: ${arg}`);
  }
  return args;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function run(command, args, env, label) {
  // Never log args here: migration commands contain a secret-bearing DB URL.
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });
  if (result.error) fail(`${label} tidak dapat dijalankan.`);
  return result.status ?? 1;
}

async function waitForHealth(baseUrl, server) {
  const deadline = Date.now() + 90_000;
  const healthUrl = new URL('/api/health', baseUrl);
  while (Date.now() < deadline) {
    if (server.exitCode !== null) fail(`Vercel Dev berhenti sebelum sehat (exit ${server.exitCode ?? 'unknown'}).`);
    try {
      const response = await fetch(healthUrl);
      const body = await response.text();
      if (response.status === 200 && body.trim() === 'ok') return;
    } catch {
      // Vercel Dev may take several seconds to compile the API function.
    }
    await wait(500);
  }
  fail(`timeout menunggu ${healthUrl.origin}/api/health; periksa target staging dan kredensial tanpa mencetak secret.`);
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (server.exitCode === null && Date.now() < deadline) await wait(100);
  if (server.exitCode === null) server.kill('SIGKILL');
}

function waitForServerExit(server) {
  if (server.exitCode !== null) return Promise.resolve(server.exitCode ?? 1);
  return new Promise((resolve) => server.once('exit', (code) => resolve(code ?? 1)));
}

function stagingPin(env) {
  const pin = String(env.E2E_FIXTURE_PIN ?? '').trim();
  if (!/^\d{6}$/.test(pin) || /^(\d)\1{5}$/.test(pin)) {
    fail('E2E_FIXTURE_PIN staging wajib berupa PIN 6 digit non-trivial; nilainya tidak dicetak.');
  }
  return pin;
}

function generatedRunId() {
  return randomBytes(6).toString('hex');
}

const options = parseArgs(process.argv.slice(2));
const port = assertPort(options.port ?? process.env.E2E_PORT ?? process.env.HOPIN_STAGING_PORT ?? 3000);
const baseUrl = assertLocalBaseUrl(process.env.E2E_BASE_URL ?? `http://localhost:${port}`);
const basePort = new URL(baseUrl).port || '80';
if (basePort !== String(port)) fail('E2E_BASE_URL dan port staging harus sama.');
const runId = createRunId(options.runId ?? process.env.E2E_RUN_ID ?? generatedRunId());
const loadedEnv = loadStagingEnv({
  HOPIN_RUNTIME: 'staging',
  E2E_BASE_URL: baseUrl,
  E2E_PORT: String(port),
  E2E_RUN_ID: runId,
  APP_ALLOWED_ORIGIN: baseUrl,
  VERCEL_ENV: 'development',
});
const stagingEnv = {
  ...loadedEnv,
  E2E_STAGING_PROJECT_REF: loadedEnv.HOPIN_STAGING_PROJECT_REF,
};

if (options.migrate && process.env.HOPIN_STAGING_MIGRATE_ACK !== '1') {
  fail('migration staging memerlukan HOPIN_STAGING_MIGRATE_ACK=1; tanpa ack tidak ada database yang disentuh.');
}
if (options.runSmoke) stagingPin(stagingEnv);

if (options.migrate) {
  const migrationCode = run(
    'node',
    ['scripts/staging-migrate.mjs', '--confirm-staging-migration'],
    stagingEnv,
    'Migration staging',
  );
  if (migrationCode !== 0) fail(`Migration staging gagal (exit ${migrationCode}); server dan smoke tidak dijalankan.`);
}

const manifestDirectory = mkdtempSync(path.join(tmpdir(), 'hopin-staging-'));
const manifestPath = path.join(manifestDirectory, `manifest-${runId}.json`);
const runnerEnv = {
  ...stagingEnv,
  E2E_FIXTURE_MANIFEST: manifestPath,
};
// The Vercel Dev child only needs the Supabase service key for the API. Keep
// the direct DB URL and migration acknowledgement out of its environment.
const serverEnv = { ...runnerEnv };
delete serverEnv.HOPIN_STAGING_DB_URL;
delete serverEnv.HOPIN_STAGING_MIGRATE_ACK;
delete serverEnv.E2E_FIXTURE_PIN;

const server = spawn('pnpm', [
  'exec',
  'vercel',
  'dev',
  '--local',
  '--yes',
  '--listen',
  `127.0.0.1:${port}`,
], {
  cwd: process.cwd(),
  env: serverEnv,
  stdio: 'inherit',
});
server.once('error', () => console.error('Staging dev gagal menjalankan Vercel Dev.'));

let stopping = false;
let provisioned = false;
let testExitCode = 0;
let teardownError = null;
const stopOnSignal = async (signal) => {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
};
process.once('SIGINT', () => { void stopOnSignal('SIGINT'); });
process.once('SIGTERM', () => { void stopOnSignal('SIGTERM'); });

try {
  await waitForHealth(baseUrl, server);
  if (options.runSmoke) {
    const provisionCode = run('node', ['scripts/provision-staging-fixtures.mjs'], runnerEnv, 'Provision fixture staging');
    if (provisionCode !== 0) fail('Provision fixture staging gagal; periksa output tanpa mengulang run ID yang sama.');
    provisioned = true;

    // The operator runner exercises the authenticated API/browser journey
    // without relying on Playwright's read-only CI project selection.
    testExitCode = run('node', ['scripts/run-staging-operator-smoke.mjs'], runnerEnv, 'Operator staging smoke');
  } else {
    console.log(`Staging dev siap di ${baseUrl} (project ${stagingEnv.HOPIN_STAGING_PROJECT_REF}). Tekan Ctrl+C untuk berhenti.`);
    testExitCode = await waitForServerExit(server);
  }
} finally {
  if (provisioned) {
    const teardownCode = run('node', ['scripts/teardown-staging-fixtures.mjs'], runnerEnv, 'Teardown fixture staging');
    if (teardownCode !== 0) {
      teardownError = new Error(`Teardown fixture staging gagal untuk run ${runId}; manifest dipertahankan di ${manifestPath}.`);
    }
  }
  await stopServer(server);
  if (!teardownError) rmSync(manifestDirectory, { recursive: true, force: true });
}

if (teardownError) throw teardownError;
if (options.runSmoke) {
  console.log(`Staging operator smoke selesai untuk run ${runId}: ${testExitCode === 0 ? 'PASS' : `FAIL (${testExitCode})`}.`);
}
process.exitCode = testExitCode;
