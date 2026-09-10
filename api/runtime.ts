/**
 * Runtime target guard used by local Vercel Dev. Keep this check next to the
 * API so a hand-written local launch cannot silently reuse production env.
 * The local sandbox launcher also validates the database target before start.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function isLoopbackUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return LOCAL_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
export function assertRuntimeDatabaseTarget(
  runtime = process.env.HOPIN_RUNTIME,
  supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
) {
  if (runtime !== 'local') return;
  if (!isLoopbackUrl(supabaseUrl)) {
    throw new Error('Local runtime requires a loopback Supabase URL.');
  }
}
