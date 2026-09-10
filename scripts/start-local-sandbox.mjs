import { spawn } from 'node:child_process';
import {
  DEFAULT_LOCAL_DB_URL,
  DEFAULT_LOCAL_SUPABASE_URL,
  assertLocalDatabaseUrl,
  assertLocalRuntimeTarget,
  assertLocalSupabaseUrl,
  ensureLocalSupabase,
  readSupabaseStatusEnv,
  resolveSandboxEnv,
  runCommand,
} from './local-sandbox-lib.mjs';

function fail(message) {
  console.error(`Local sandbox tidak dapat dijalankan: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const baseEnv = resolveSandboxEnv();
  // The explicit sync flag is intentional: dev:local always refreshes from
  // the latest production state before opening a mutating local workspace.
  runCommand(process.execPath, ['scripts/sync-production-to-local.mjs', '--confirm-local-sandbox'], {
    env: { ...baseEnv, HOPIN_FULL_CLONE_ACK: '1' },
    timeout: 900_000,
    stdio: 'inherit',
  });

  const localDbUrl = assertLocalDatabaseUrl(baseEnv.HOPIN_LOCAL_DB_URL || DEFAULT_LOCAL_DB_URL);
  await ensureLocalSupabase({ databaseUrl: localDbUrl, env: baseEnv });
  const statusEnv = readSupabaseStatusEnv({ env: baseEnv });
  const localSupabaseUrl = assertLocalSupabaseUrl(
    baseEnv.HOPIN_LOCAL_SUPABASE_URL || statusEnv.API_URL || DEFAULT_LOCAL_SUPABASE_URL,
  );
  const localServiceRoleKey = baseEnv.HOPIN_LOCAL_SERVICE_ROLE_KEY || statusEnv.SERVICE_ROLE_KEY;
  if (!localServiceRoleKey) {
    throw new Error('Service role key Supabase lokal tidak ditemukan. Jalankan `supabase status -o env`, lalu set HOPIN_LOCAL_SERVICE_ROLE_KEY secara lokal.');
  }
  assertLocalRuntimeTarget({ runtime: 'local', supabaseUrl: localSupabaseUrl, databaseUrl: localDbUrl });

  const port = baseEnv.HOPIN_LOCAL_PORT || '3000';
  const appOrigin = `http://localhost:${port}`;
  const env = {
    ...baseEnv,
    HOPIN_RUNTIME: 'local',
    SUPABASE_URL: localSupabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: localServiceRoleKey,
    APP_ALLOWED_ORIGIN: appOrigin,
    VERCEL_ENV: 'development',
  };
  // The production dump credential is needed only by the short-lived sync
  // process. Never pass it into Vercel Dev or the API runtime.
  delete env.HOPIN_PROD_DB_URL;
  delete env.HOPIN_PROD_DB_ENV_FILE;
  delete env.HOPIN_FULL_CLONE_ACK;
  delete env.VITE_SUPABASE_SERVICE_ROLE_KEY;
  console.log(`Local sandbox aktif: ${appOrigin}`);
  console.log('Database target: Supabase lokal loopback. Perubahan tidak dikirim ke production.');

  const child = spawn('pnpm', ['exec', 'vercel', 'dev', '--local', '--yes', '--listen', `127.0.0.1:${port}`], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });
  const forwardSignal = (signal) => child.kill(signal);
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
  const exitCode = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code, signal) => resolve(typeof code === 'number' ? code : signal ? 1 : 0));
  });
  process.exitCode = exitCode;
}

try {
  await main();
} catch (error) {
  fail(error?.message || 'error tidak terduga. Detail sensitif tidak ditampilkan.');
}
