import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type ApiRequest = {
  headers: Headers | Record<string, string | string[] | undefined>;
  body?: unknown;
};

export type AuthProfile = {
  id: string;
  username: string;
  display_name: string;
  job_title: string;
  role: string;
};

export type LoginOption = Pick<AuthProfile, 'username' | 'display_name' | 'job_title'>;

const SESSION_COOKIE = 'hopin_session';
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const inactivityMs = 30 * 60 * 1000;
const lockoutMs = 15 * 60 * 1000;
const maxPinAttempts = 5;
const pinIterations = 310_000;

function encodeText(value: string) {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function getAdminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error('Server Supabase environment is not configured.');
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function normalizeUsername(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isValidPin(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/.test(value);
}

async function derivePin(pin: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', encodeText(pin), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encodeText(salt), iterations: pinIterations, hash: 'SHA-256' }, key, 512);
  return btoa(String.fromCharCode(...new Uint8Array(derived)));
}

function randomHex(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashPin(pin: string) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = btoa(String.fromCharCode(...saltBytes));
  return { salt, hash: await derivePin(pin, salt) };
}

async function verifyPin(pin: string, salt: string, expectedHash: string) {
  const actual = await derivePin(pin, salt);
  return actual === expectedHash;
}

async function hashSessionToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', encodeText(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function publicProfile(profile: AuthProfile): AuthProfile {
  return {
    id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    job_title: profile.job_title,
    role: profile.role,
  };
}

export async function listLoginOptions(): Promise<LoginOption[]> {
  const { data, error } = await getAdminClient()
    .from('profiles')
    .select('username, display_name, job_title')
    .eq('active', true)
    .not('username', 'is', null)
    .order('display_name');
  if (error) throw error;
  return (data ?? []) as LoginOption[];
}

async function getActiveProfile(username: string): Promise<AuthProfile | null> {
  const { data, error } = await getAdminClient()
    .from('profiles')
    .select('id, username, display_name, job_title, role, active')
    .eq('username', username)
    .eq('active', true)
    .maybeSingle();
  if (error) throw error;
  return data ? (data as AuthProfile) : null;
}

export async function loginWithPin(usernameInput: unknown, pinInput: unknown) {
  const username = normalizeUsername(usernameInput);
  if (!username || !isValidPin(pinInput)) return null;

  const db = getAdminClient();
  const profile = await getActiveProfile(username);
  if (!profile) return null;

  const { data: credential, error: credentialError } = await db
    .from('operator_credentials')
    .select('pin_salt, pin_hash, failed_attempts, locked_until')
    .eq('profile_id', profile.id)
    .maybeSingle();
  if (credentialError) throw credentialError;
  if (!credential) return null;

  if (credential.locked_until && new Date(credential.locked_until).getTime() > Date.now()) return null;

  const valid = await verifyPin(pinInput, credential.pin_salt, credential.pin_hash);
  if (!valid) {
    const failedAttempts = Number(credential.failed_attempts ?? 0) + 1;
    const { error: failureError } = await db.from('operator_credentials').update({
      failed_attempts: failedAttempts,
      locked_until: failedAttempts >= maxPinAttempts ? new Date(Date.now() + lockoutMs).toISOString() : null,
    }).eq('profile_id', profile.id);
    if (failureError) throw failureError;
    return null;
  }

  const token = randomHex(32);
  const now = new Date();
  const { error: resetError } = await db.from('operator_credentials').update({
    failed_attempts: 0,
    locked_until: null,
  }).eq('profile_id', profile.id);
  if (resetError) throw resetError;

  const { error: sessionError } = await db.from('app_sessions').insert({
    profile_id: profile.id,
    token_hash: await hashSessionToken(token),
    created_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    expires_at: new Date(now.getTime() + sessionLifetimeMs).toISOString(),
  });
  if (sessionError) throw sessionError;

  return { token, user: publicProfile(profile) };
}

function cookieValue(request: ApiRequest, name: string) {
  const webHeaders = request.headers as Headers;
  const nodeHeaders = request.headers as Record<string, string | string[] | undefined>;
  const header = typeof webHeaders.get === 'function' ? webHeaders.get('cookie') : nodeHeaders.cookie;
  const cookieHeader = Array.isArray(header) ? header.join(';') : header;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim() || null;
  }
  return null;
}

export function sessionTokenFromRequest(request: ApiRequest) {
  const token = cookieValue(request, SESSION_COOKIE);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export async function currentUser(request: ApiRequest): Promise<AuthProfile | null> {
  const token = sessionTokenFromRequest(request);
  if (!token) return null;

  const db = getAdminClient();
  const { data: session, error: sessionError } = await db
    .from('app_sessions')
    .select('id, profile_id, expires_at, last_seen_at, revoked_at')
    .eq('token_hash', await hashSessionToken(token))
    .is('revoked_at', null)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) return null;

  const now = Date.now();
  const expired = new Date(session.expires_at).getTime() <= now;
  const inactive = new Date(session.last_seen_at).getTime() + inactivityMs <= now;
  if (expired || inactive) {
    await db.from('app_sessions').update({ revoked_at: new Date(now).toISOString() }).eq('id', session.id);
    return null;
  }

  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('id, username, display_name, job_title, role, active')
    .eq('id', session.profile_id)
    .eq('active', true)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) return null;

  await db.from('app_sessions').update({ last_seen_at: new Date(now).toISOString() }).eq('id', session.id);
  return publicProfile(profile as AuthProfile);
}

export async function revokeCurrentSession(request: ApiRequest) {
  const token = sessionTokenFromRequest(request);
  if (!token) return;
  await getAdminClient().from('app_sessions').update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', await hashSessionToken(token)).is('revoked_at', null);
}

function cookieFlags() {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
    ? '; Secure'
    : '';
}

export function sessionCookie(token: string) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetimeMs / 1000}${cookieFlags()}`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieFlags()}`;
}

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
