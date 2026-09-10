import {
  DEFAULT_LOCAL_DB_URL,
  DEFAULT_LOCAL_SUPABASE_URL,
  assertLocalDatabaseUrl,
  assertLocalRuntimeTarget,
  assertLocalSupabaseUrl,
  resolveSandboxEnv,
} from './local-sandbox-lib.mjs';

try {
  const env = resolveSandboxEnv();
  const runtime = env.HOPIN_RUNTIME || 'local';
  const databaseUrl = assertLocalDatabaseUrl(env.HOPIN_LOCAL_DB_URL || DEFAULT_LOCAL_DB_URL);
  const supabaseUrl = assertLocalSupabaseUrl(
    env.HOPIN_LOCAL_SUPABASE_URL || (runtime === 'local' ? env.SUPABASE_URL : '') || DEFAULT_LOCAL_SUPABASE_URL,
  );
  assertLocalRuntimeTarget({ runtime: 'local', supabaseUrl, databaseUrl });
  console.log(`Target lokal valid (${supabaseUrl}); remote database tidak diizinkan.`);
} catch (error) {
  console.error(`Target lokal ditolak: ${error?.message || 'konfigurasi tidak valid.'}`);
  process.exitCode = 1;
}
