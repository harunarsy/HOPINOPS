import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadStagingEnv } from './staging-runtime.mjs';

function fail(message) { throw new Error(`ops:staging-smoke: ${message}`); }
function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) fail(`${command} berhenti dengan status ${result.status ?? 1}.`);
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runId = (process.env.E2E_RUN_ID || randomBytes(6).toString('hex')).toLowerCase();
if (!/^[a-z0-9]{4,12}$/.test(runId)) fail('E2E_RUN_ID harus 4-12 karakter alfanumerik.');
const port = Number(process.env.E2E_PORT || process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('E2E_PORT/PORT tidak valid.');
function generatedPin() {
  const weak = new Set(['000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999', '123456', '654321', '123123', '654654', '012345', '543210', '112233', '121212']);
  let value = '';
  do value = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000)); while (weak.has(value) || /^(\d)\1{5}$/.test(value));
  return value;
}
const stagingEnv = loadStagingEnv({
  ...process.env,
  E2E_RUN_ID: runId,
  E2E_PORT: String(port),
  PORT: String(port),
  E2E_BASE_URL: `http://127.0.0.1:${port}`,
  HOPIN_RUNTIME: 'staging',
  HOPIN_STAGING_MIGRATE_ACK: '1',
  E2E_FIXTURE_PIN: process.env.E2E_FIXTURE_PIN || generatedPin(),
});
const tempRoot = mkdtempSync(path.join(tmpdir(), 'hopin-staging-smoke-'));
const manifestPath = path.join(tempRoot, `manifest-${runId}.json`);
const env = { ...stagingEnv, E2E_FIXTURE_MANIFEST: manifestPath };
let server;
let provisioned = false;

async function waitForHealth() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) fail(`server lokal berhenti sebelum sehat (exit ${server?.exitCode ?? 'unknown'}).`);
    try {
      const response = await fetch(`${env.E2E_BASE_URL}/api/health`, { cache: 'no-store' });
      const body = await response.text();
      if (response.status === 200 && body === 'ok') return;
    } catch {}
    await wait(500);
  }
  fail('timeout menunggu server staging lokal sehat.');
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (server.exitCode === null && Date.now() < deadline) await wait(100);
  if (server.exitCode === null) server.kill('SIGKILL');
}

try {
  run('pnpm', ['db:staging:migrate'], env);
  server = spawn('pnpm', ['dev:staging'], { cwd: process.cwd(), env, stdio: 'inherit' });
  await waitForHealth();
  run(process.execPath, ['scripts/provision-staging-fixtures.mjs'], env);
  provisioned = true;
  run(process.execPath, ['scripts/run-staging-operator-smoke.mjs'], env);
  console.log(`ops:staging-smoke PASS (run ${runId}, project ${env.HOPIN_STAGING_PROJECT_REF})`);
} finally {
  if (provisioned && existsSync(manifestPath)) {
    try { run(process.execPath, ['scripts/teardown-staging-fixtures.mjs'], env); }
    catch (error) { console.error('Teardown staging gagal; manifest dipertahankan untuk pemeriksaan:', manifestPath); throw error; }
  }
  await stopServer();
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
}
