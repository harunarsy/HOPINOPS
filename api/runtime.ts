/** Runtime target guard shared by local staging and production API functions. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const PRODUCTION_PROJECT_REF = 'naanarmoktmsumkxmjvj';
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

export function isLoopbackUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return LOCAL_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function supabaseProjectRefFromUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    const match = url.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/i);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function assertRuntimeDatabaseTarget(
  runtime = process.env.HOPIN_RUNTIME,
  supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
) {
  if (!runtime || runtime === 'production') return;
  if (runtime === 'local') {
    throw new Error('Runtime local sudah tidak didukung. Gunakan HOPIN_RUNTIME=staging.');
  }
  if (runtime !== 'staging') return;

  const ref = supabaseProjectRefFromUrl(supabaseUrl);
  const configuredRef = (process.env.HOPIN_STAGING_PROJECT_REF ?? '').trim().toLowerCase();
  if (!ref || !PROJECT_REF_PATTERN.test(ref) || !configuredRef || ref !== configuredRef) {
    throw new Error('Runtime staging memerlukan project Supabase staging yang di-allowlist.');
  }
  if (ref === PRODUCTION_PROJECT_REF) {
    throw new Error('Runtime staging tidak boleh menunjuk ke database production.');
  }
}
