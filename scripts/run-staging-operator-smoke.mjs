/**
 * Adapter for the existing deterministic operator API/browser smoke. The
 * runner itself only talks to localhost; the API process behind it is pointed
 * at the isolated remote staging project by start-staging-dev.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadStagingEnv } from './staging-runtime.mjs';

const env = loadStagingEnv();
const manifestPath = env.E2E_FIXTURE_MANIFEST;
if (!manifestPath || !existsSync(manifestPath)) throw new Error('Fixture manifest staging tidak ditemukan.');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const lifecycle = manifest.users?.desktop?.lifecycle;
if (!lifecycle?.username) throw new Error('Manifest staging tidak memiliki operator lifecycle.');

const baseUrl = env.E2E_BASE_URL || `http://localhost:${env.PORT || 3000}`;
const runnerEnv = {
  ...env,
  E2E_BASE_URL: baseUrl,
  HOPIN_RUNTIME: 'staging',
  HOPIN_LOCAL_SMOKE_ACK: '1',
  HOPIN_LOCAL_SMOKE_USERNAME: lifecycle.username,
  HOPIN_LOCAL_SMOKE_PIN: env.E2E_FIXTURE_PIN,
  HOPIN_LOCAL_SMOKE_CLIENT_IP: manifest.clientIps?.desktop,
  // The second operator must share the first fixture's outlet so the BAR and
  // KITCHEN closings can satisfy the same daily-report gate. The mobile
  // fixture remains available for the browser/device matrix, but is isolated
  // to its own outlet and must not be used for this cross-area assertion.
  HOPIN_LOCAL_SMOKE_SECOND_USERNAME: manifest.users?.desktop?.journey?.username,
  HOPIN_LOCAL_SMOKE_SECOND_PIN: env.E2E_FIXTURE_PIN,
};

const result = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts/run-local-operator-smoke.mjs')], {
  cwd: process.cwd(),
  env: runnerEnv,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
