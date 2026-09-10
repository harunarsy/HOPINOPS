/**
 * Safety boundary for the HOPIN remote staging workflow.
 *
 * The application is served locally by Vercel Dev, but its server functions
 * talk to one disposable Supabase project. Every command that can mutate the
 * remote database must pass this module before it starts. Production is not a
 * valid staging target, even when a caller supplies a different project-ref
 * environment variable.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const PRODUCTION_PROJECT_REF = 'naanarmoktmsumkxmjvj';
export const STAGING_PROJECT_REF = process.env.HOPIN_STAGING_PROJECT_REF ?? '';
export const STAGING_HOST = STAGING_PROJECT_REF ? `${STAGING_PROJECT_REF}.supabase.co` : '';
export const STAGING_URL = STAGING_HOST ? `https://${STAGING_HOST}` : '';
export const DEFAULT_STAGING_PORT = 3000;
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
export const STAGING_REF_PATTERN = /^[a-z0-9]{20}$/;

const SECRET_KEY_PATTERN = /KEY|TOKEN|PASSWORD|SECRET|DATABASE_URL|PIN/i;

/** Parse the small dotenv subset used by `.env.staging.local`. */
export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = assignment.indexOf('=');
    if (separator <= 0) continue;
    const key = assignment.slice(0, separator).trim();
    let value = assignment.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function readEnvFile(filePath = process.env.HOPIN_STAGING_ENV_FILE ?? path.join(process.cwd(), '.env.staging.local')) {
  if (!existsSync(filePath)) return {};
  return parseDotEnv(readFileSync(filePath, 'utf8'));
}

export function projectRefFromSupabaseUrl(value) {
  try {
    const parsed = new URL(String(value ?? ''));
    const match = parsed.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/i);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function parseUrl(value, message) {
  try {
    return new URL(String(value ?? ''));
  } catch {
    throw new Error(message);
  }
}

function assertNoUrlDecorations(parsed, label) {
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error(`${label} harus berupa origin tanpa credential, path, query, atau hash.`);
  }
}

/** Validate the one allowed remote staging project and (optionally) its DB URL. */
export function assertStagingTarget({ url, projectRef, databaseUrl } = {}) {
  const parsed = parseUrl(url, 'SUPABASE_URL staging tidak valid.');
  const inferredRef = projectRefFromSupabaseUrl(parsed.toString());
  const configuredRef = String(projectRef ?? process.env.HOPIN_STAGING_PROJECT_REF ?? inferredRef ?? '').trim().toLowerCase();

  if (
    parsed.protocol !== 'https:'
    || !inferredRef
    || !STAGING_REF_PATTERN.test(configuredRef)
    || inferredRef !== configuredRef
    || configuredRef === PRODUCTION_PROJECT_REF
  ) {
    throw new Error('Target staging harus URL Supabase HTTPS yang cocok dengan project reference; production atau project lain ditolak.');
  }
  assertNoUrlDecorations(parsed, 'SUPABASE_URL staging');

  if (databaseUrl) {
    const db = parseUrl(databaseUrl, 'HOPIN_STAGING_DB_URL tidak valid.');
    if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.password) {
      throw new Error('HOPIN_STAGING_DB_URL harus connection string PostgreSQL ber-password.');
    }
    const direct = db.hostname === `db.${configuredRef}.supabase.co`;
    const pooler = db.hostname.endsWith('.pooler.supabase.com')
      && decodeURIComponent(db.username).endsWith(`.${configuredRef}`);
    if (!direct && !pooler) {
      throw new Error('HOPIN_STAGING_DB_URL harus menunjuk ke DB project staging yang sama; target lain ditolak.');
    }
    if (String(databaseUrl).includes(PRODUCTION_PROJECT_REF)) {
      throw new Error('Connection string production ditolak dari workflow staging.');
    }
  }

  return { url: parsed.origin, projectRef: configuredRef };
}

function jwtPayload(value) {
  const parts = String(value ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Validate that a server key belongs to staging without ever logging it. */
export function assertStagingServiceRoleKey(value, expectedProjectRef = STAGING_PROJECT_REF) {
  const payload = jwtPayload(value);
  if (!payload || payload.role !== 'service_role' || payload.ref !== expectedProjectRef) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY harus service-role key milik project staging yang di-allowlist.');
  }
  return true;
}

export function loadStagingEnv(overrides = {}, { requireServiceRole = true } = {}) {
  const fileEnv = readEnvFile();
  // Explicit process environment wins over the file. This makes an exported
  // production value fail closed instead of being silently shadowed.
  const env = { ...fileEnv, ...process.env, ...overrides };
  const target = assertStagingTarget({
    url: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL,
    projectRef: env.HOPIN_STAGING_PROJECT_REF,
    databaseUrl: env.HOPIN_STAGING_DB_URL,
  });
  if (env.HOPIN_RUNTIME && env.HOPIN_RUNTIME !== 'staging') {
    throw new Error('Runtime remote lokal harus HOPIN_RUNTIME=staging; runtime local/production ditolak.');
  }
  if (requireServiceRole) {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY staging wajib tersedia di .env.staging.local atau environment.');
    }
    assertStagingServiceRoleKey(env.SUPABASE_SERVICE_ROLE_KEY, target.projectRef);
  } else if (env.SUPABASE_SERVICE_ROLE_KEY) {
    assertStagingServiceRoleKey(env.SUPABASE_SERVICE_ROLE_KEY, target.projectRef);
  }
  if (env.VITE_SUPABASE_URL) {
    assertStagingTarget({ url: env.VITE_SUPABASE_URL, projectRef: target.projectRef });
  }
  return {
    ...env,
    HOPIN_RUNTIME: 'staging',
    HOPIN_STAGING_PROJECT_REF: target.projectRef,
    SUPABASE_URL: target.url,
    VITE_SUPABASE_URL: target.url,
  };
}

export function assertStagingDatabaseEnv(env) {
  const databaseUrl = String(env?.HOPIN_STAGING_DB_URL ?? '').trim();
  if (!databaseUrl) {
    throw new Error('HOPIN_STAGING_DB_URL wajib diisi hanya untuk migration staging.');
  }
  assertStagingTarget({ url: env.SUPABASE_URL, projectRef: env.HOPIN_STAGING_PROJECT_REF, databaseUrl });
  return databaseUrl;
}

export function assertLocalBaseUrl(value = `http://127.0.0.1:${DEFAULT_STAGING_PORT}`) {
  const parsed = parseUrl(value, 'E2E_BASE_URL staging tidak valid.');
  if (
    parsed.protocol !== 'http:'
    || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('E2E_BASE_URL wajib origin HTTP loopback dari Vercel Dev, bukan host remote.');
  }
  return parsed.origin;
}

export function assertPort(value = DEFAULT_STAGING_PORT) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('E2E_PORT harus bilangan bulat 1024-65535.');
  }
  return port;
}

export function createRunId(value) {
  const runId = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]{4,12}$/.test(runId)) {
    throw new Error('E2E_RUN_ID harus 4-12 karakter alfanumerik lowercase.');
  }
  return runId;
}

export function secretFreeEnv(env) {
  const copy = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!SECRET_KEY_PATTERN.test(key)) copy[key] = value;
  }
  return copy;
}

export function stagingSummary(env) {
  return {
    runtime: env?.HOPIN_RUNTIME ?? 'staging',
    projectRef: env?.HOPIN_STAGING_PROJECT_REF ?? STAGING_PROJECT_REF,
    supabaseOrigin: env?.SUPABASE_URL ? new URL(env.SUPABASE_URL).origin : STAGING_URL,
  };
}
