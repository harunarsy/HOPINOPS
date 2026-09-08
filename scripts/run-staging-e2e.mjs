// Run disposable staging E2E with local Vercel API routes and guaranteed teardown.
// The runner never targets a remote browser origin and never deploys.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const STAGING_REF = 'ibzlxdmnuszcmdzuocwu';
const STAGING_HOST = `${STAGING_REF}.supabase.co`;

function fail(message) {
  throw new Error(message);
}
function localBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`E2E_BASE_URL tidak valid: ${value}`);
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('E2E_BASE_URL wajib root HTTP localhost dari `vercel dev`, bukan target remote.');
  }
  return url;
}
function stagingSupabaseUrl(value) {
  try {
    return new URL(value);
  } catch {
    fail('SUPABASE_URL tidak valid.');
  }
}
function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`vercel dev berhenti sebelum sehat (exit ${child.exitCode ?? 'unknown'}).`);
    try {
      const response = await fetch(new URL('/api/health', baseUrl));
      if (response.status < 500) return;
    } catch {
      // Startup can take several seconds while Vercel compiles server functions.
    }
    await wait(500);
  }
  fail(`Timeout menunggu ${baseUrl.origin}/api/health dari vercel dev.`);
}
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) await wait(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

if (process.env.E2E_MUTATIONS !== '1') fail('Runner memerlukan E2E_MUTATIONS=1 eksplisit.');
if (process.env.E2E_STAGING_PROJECT_REF !== STAGING_REF) fail(`Runner hanya boleh ke staging ${STAGING_REF}.`);
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) fail('Runner memerlukan kredensial staging server-side.');
if (stagingSupabaseUrl(process.env.SUPABASE_URL).hostname !== STAGING_HOST) fail(`SUPABASE_URL harus ${STAGING_HOST}.`);
if (!process.env.E2E_FIXTURE_PIN) fail('Runner memerlukan E2E_FIXTURE_PIN.');

const port = Number(process.env.E2E_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('E2E_PORT harus port TCP 1024-65535.');
const baseUrl = localBaseUrl(process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`);
if (baseUrl.port !== String(port)) fail('E2E_BASE_URL dan E2E_PORT harus memakai port yang sama.');
const runId = (process.env.E2E_RUN_ID ?? randomBytes(6).toString('hex')).toLowerCase();
if (!/^[a-z0-9]{4,12}$/.test(runId)) fail('E2E_RUN_ID harus 4-12 karakter alnum lowercase.');

const tempDirectory = mkdtempSync(path.join(tmpdir(), 'hopin-e2e-'));
const manifestPath = path.join(tempDirectory, `manifest-${runId}.json`);
const env = {
  ...process.env,
  E2E_RUN_ID: runId,
  E2E_FIXTURE_MANIFEST: manifestPath,
  E2E_BASE_URL: baseUrl.origin,
};
let server;
let provisioned = false;
let testExitCode = 1;
let teardownError = null;
try {
  server = spawn('pnpm', ['exec', 'vercel', 'dev', '--local', '--yes', '--listen', `127.0.0.1:${port}`], { cwd: process.cwd(), env, stdio: 'inherit' });
  server.once('error', (error) => console.error('Gagal menjalankan vercel dev:', error));
  await waitForHealth(baseUrl, server);

  if (run('node', ['scripts/provision-staging-fixtures.mjs'], env) !== 0) fail('Provision fixture staging gagal.');
  provisioned = true;
  testExitCode = run('pnpm', ['exec', 'playwright', 'test'], env);
} finally {
  if (provisioned) {
    const teardownCode = run('node', ['scripts/teardown-staging-fixtures.mjs'], env);
    if (teardownCode !== 0) {
      teardownError = new Error(`Teardown fixture staging gagal untuk run ${runId}. Manifest dipertahankan di ${manifestPath}; jangan jalankan run baru sebelum diperiksa.`);
    }
  }
  await stopServer(server);
  if (!teardownError) rmSync(tempDirectory, { recursive: true, force: true });
}
if (teardownError) throw teardownError;
process.exitCode = testExitCode;
