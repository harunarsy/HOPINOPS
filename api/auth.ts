import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type ApiRequest = {
  headers: Headers | Record<string, string | string[] | undefined>;
  body?: unknown;
};

export type AuthProfile = {
  id: string;
  username: string;
  display_name: string;
  role: string;
  force_pin_change?: boolean;
};

export type LoginOption = Pick<AuthProfile, 'username' | 'display_name'>;

const SESSION_COOKIE = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
  ? '__Host-hopin_session'
  : 'hopin_session';

const DEVICE_COOKIE = 'hopin_device';
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const inactivityMs = 30 * 60 * 1000;
const lockoutMs = 15 * 60 * 1000;
const maxPinAttempts = 5;
const pinIterations = 310_000;

const WEAK_PINS = new Set([
  '000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999',
  '123456', '654321', '123123', '654654', '012345', '543210', '112233', '121212'
]);

function encodeText(value: string) {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

export function validateOrigin(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true;

  const getHeader = (name: string): string | null => {
    if (typeof request.headers?.get === 'function') {
      return request.headers.get(name);
    }
    const h = (request as any).headers;
    return h?.[name] || h?.[name.toLowerCase()] || null;
  };

  const origin = getHeader('origin');
  const referer = getHeader('referer');
  const host = getHeader('host') || (request.url ? new URL(request.url).host : null);

  const allowed = process.env.APP_ALLOWED_ORIGIN;
  if (allowed && origin && origin === allowed) return true;

  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host === host) return true;
    } catch {}
    return false;
  }

  if (!origin && referer && host) {
    try {
      const refUrl = new URL(referer);
      if (refUrl.host === host) return true;
    } catch {}
    return false;
  }

  if (!origin && !referer) {
    return process.env.NODE_ENV === 'test';
  }

  return false;
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

function isWeakPin(pin: string): boolean {
  if (WEAK_PINS.has(pin)) return true;
  if (/^(\d)\1{5}$/.test(pin)) return true;
  return false;
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

// Constant-time compare
export async function verifyPin(pin: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = await derivePin(pin, salt);
  const a = encodeText(actual);
  const b = encodeText(expectedHash);
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a[i] ^ b[i];
  }
  return mismatch === 0;
}

async function hashSessionToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', encodeText(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function publicProfile(profile: any): AuthProfile {
  return {
    id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    role: profile.role,
    force_pin_change: Boolean(profile.force_pin_change),
  };
}

export async function listLoginOptions(): Promise<LoginOption[]> {
  const { data, error } = await getAdminClient()
    .from('profiles')
    .select('username, display_name')
    .eq('active', true)
    .is('deactivated_at', null)
    .not('username', 'is', null)
    .order('display_name');
  if (error) throw error;
  return (data ?? []) as LoginOption[];
}

async function getActiveProfile(username: string): Promise<any | null> {
  const { data, error } = await getAdminClient()
    .from('profiles')
    .select('id, username, display_name, role, active, force_pin_change, deactivated_at')
    .eq('username', username)
    .eq('active', true)
    .is('deactivated_at', null)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function loginWithPin(usernameInput: unknown, pinInput: unknown, deviceTokenInput?: string) {
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

  if (credential.locked_until && new Date(credential.locked_until).getTime() > Date.now()) {
    return { locked: true, user: null, token: null };
  }

  const valid = await verifyPin(pinInput, credential.pin_salt, credential.pin_hash);
  if (!valid) {
    const failedAttempts = Number(credential.failed_attempts ?? 0) + 1;
    await db.from('operator_credentials').update({
      failed_attempts: failedAttempts,
      last_failed_at: new Date().toISOString(),
      locked_until: failedAttempts >= maxPinAttempts ? new Date(Date.now() + lockoutMs).toISOString() : null,
    }).eq('profile_id', profile.id);

    // Audit failed attempt
    await db.from('audit_events').insert({
      actor_user_id: profile.id,
      action: 'LOGIN_FAILED',
      entity_type: 'operator_credentials',
      entity_id: profile.id,
      reason: `Percobaan PIN gagal (${failedAttempts}/${maxPinAttempts})`,
    });

    return null;
  }

  const token = randomHex(32);
  const now = new Date();
  await db.from('operator_credentials').update({
    failed_attempts: 0,
    locked_until: null,
  }).eq('profile_id', profile.id);

  let deviceId: string | null = null;
  let deviceToken = deviceTokenInput;
  if (!deviceToken) {
    deviceToken = randomHex(32);
  }

  const deviceHash = await hashSessionToken(deviceToken);
  const { data: existingDevice } = await db.from('app_devices').select('id').eq('device_token_hash', deviceHash).maybeSingle();
  if (existingDevice) {
    deviceId = existingDevice.id;
    await db.from('app_devices').update({ last_seen_at: now.toISOString() }).eq('id', deviceId);
  } else {
    const { data: newDevice } = await db.from('app_devices').insert({
      profile_id: profile.id,
      device_token_hash: deviceHash,
      first_seen_at: now.toISOString(),
      last_seen_at: now.toISOString(),
    }).select('id').single();
    if (newDevice) deviceId = newDevice.id;
  }

  const { error: sessionError } = await db.from('app_sessions').insert({
    profile_id: profile.id,
    token_hash: await hashSessionToken(token),
    device_id: deviceId,
    created_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    expires_at: new Date(now.getTime() + sessionLifetimeMs).toISOString(),
    absolute_expires_at: new Date(now.getTime() + sessionLifetimeMs).toISOString(),
  });
  if (sessionError) throw sessionError;

  // Log successful login
  await db.from('audit_events').insert({
    actor_user_id: profile.id,
    action: 'LOGIN_SUCCESS',
    entity_type: 'app_sessions',
    entity_id: profile.id,
    reason: 'User berhasil login dengan PIN',
  });

  return { token, deviceToken, user: publicProfile(profile) };
}

function cookieValue(request: ApiRequest, name: string) {
  const webHeaders = request.headers as Headers;
  const nodeHeaders = request.headers as Record<string, string | string[] | undefined>;
  const header = typeof webHeaders?.get === 'function' ? webHeaders.get('cookie') : nodeHeaders?.cookie;
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
  const token = cookieValue(request, SESSION_COOKIE) || cookieValue(request, 'hopin_session') || cookieValue(request, '__Host-hopin_session');
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export function deviceTokenFromRequest(request: ApiRequest) {
  const token = cookieValue(request, DEVICE_COOKIE);
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
    .select('id, username, display_name, role, active, force_pin_change, deactivated_at')
    .eq('id', session.profile_id)
    .eq('active', true)
    .is('deactivated_at', null)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) return null;

  await db.from('app_sessions').update({ last_seen_at: new Date(now).toISOString() }).eq('id', session.id);
  return publicProfile(profile);
}

export async function revokeCurrentSession(request: ApiRequest) {
  const token = sessionTokenFromRequest(request);
  if (!token) return;
  const db = getAdminClient();
  await db.from('app_sessions').update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', await hashSessionToken(token)).is('revoked_at', null);
}

export async function changePin(profileId: string, oldPin: string, newPin: string) {
  if (!isValidPin(oldPin) || !isValidPin(newPin)) {
    throw new Error('PIN harus 6 digit angka.');
  }
  if (oldPin === newPin) {
    throw new Error('PIN baru tidak boleh sama dengan PIN lama.');
  }
  if (isWeakPin(newPin)) {
    throw new Error('PIN terlalu mudah ditebak. Gunakan kombinasi angka lain.');
  }

  const db = getAdminClient();
  const { data: credential } = await db
    .from('operator_credentials')
    .select('pin_salt, pin_hash, pin_version')
    .eq('profile_id', profileId)
    .single();
  if (!credential) throw new Error('Kredensial tidak ditemukan.');

  const validOld = await verifyPin(oldPin, credential.pin_salt, credential.pin_hash);
  if (!validOld) throw new Error('PIN lama salah.');

  // Check pin history
  const { data: history } = await db
    .from('pin_history')
    .select('pin_salt, pin_hash')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: false })
    .limit(3);

  if (history) {
    for (const h of history) {
      if (await verifyPin(newPin, h.pin_salt, h.pin_hash)) {
        throw new Error('PIN baru pernah digunakan sebelumnya.');
      }
    }
  }

  // Save old to history
  await db.from('pin_history').insert({
    profile_id: profileId,
    pin_salt: credential.pin_salt,
    pin_hash: credential.pin_hash,
  });

  // Hash new pin
  const { salt: newSalt, hash: newHash } = await hashPin(newPin);
  const now = new Date().toISOString();

  await db.from('operator_credentials').update({
    pin_salt: newSalt,
    pin_hash: newHash,
    pin_changed_at: now,
    pin_version: (credential.pin_version ?? 1) + 1,
    failed_attempts: 0,
    locked_until: null,
  }).eq('profile_id', profileId);

  await db.from('profiles').update({
    force_pin_change: false,
    updated_at: now,
  }).eq('id', profileId);

  // Audit
  await db.from('audit_events').insert({
    actor_user_id: profileId,
    action: 'CHANGE_PIN',
    entity_type: 'operator_credentials',
    entity_id: profileId,
    reason: 'User berhasil memperbarui PIN mandiri',
  });

  return { ok: true };
}

export async function resetUserPin(actorProfile: AuthProfile, targetUsername: string) {
  const db = getAdminClient();
  const { data: target } = await db
    .from('profiles')
    .select('id, username, display_name, role')
    .eq('username', targetUsername)
    .eq('active', true)
    .single();
  if (!target) throw new Error('User target tidak ditemukan.');

  if (actorProfile.role === 'SUPERVISOR') {
    if (target.role !== 'OPERATOR') {
      throw new Error('Supervisor hanya boleh mereset PIN Operator.');
    }
  } else if (actorProfile.role !== 'OWNER') {
    throw new Error('Tidak memiliki akses mereset PIN.');
  }

  // Generate random 6-digit temp PIN
  const tempPin = Math.floor(100000 + Math.random() * 900000).toString();
  const { salt, hash } = await hashPin(tempPin);
  const now = new Date().toISOString();

  await db.from('operator_credentials').update({
    pin_salt: salt,
    pin_hash: hash,
    pin_changed_at: now,
    failed_attempts: 0,
    locked_until: null,
  }).eq('profile_id', target.id);

  await db.from('profiles').update({
    force_pin_change: true,
    updated_at: now,
  }).eq('id', target.id);

  // Revoke all existing sessions for target user
  await db.from('app_sessions').update({
    revoked_at: now,
  }).eq('profile_id', target.id).is('revoked_at', null);

  // Audit
  await db.from('audit_events').insert({
    actor_user_id: actorProfile.id,
    subject_user_id: target.id,
    action: 'RESET_USER_PIN',
    entity_type: 'operator_credentials',
    entity_id: target.id,
    reason: `PIN di-reset oleh ${actorProfile.display_name} (${actorProfile.role})`,
  });

  return { ok: true, tempPin, username: target.username, display_name: target.display_name };
}

function cookieFlags() {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
    ? '; Secure'
    : '';
}

export function sessionCookie(token: string) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetimeMs / 1000}${cookieFlags()}`;
}

export function deviceCookie(token: string) {
  return `${DEVICE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 60 * 60}${cookieFlags()}`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieFlags()}`;
}

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export default {
  async fetch(request: Request) {
    if (!validateOrigin(request)) {
      return jsonResponse({ error: 'Origin request tidak diizinkan (CSRF Protection)' }, 403);
    }

    const action = new URL(request.url).searchParams.get('action');

    if (request.method === 'GET' && action === 'options') {
      try {
        return jsonResponse({ options: await listLoginOptions() });
      } catch (error) {
        console.error('Unable to load login options', error);
        return jsonResponse({ error: 'Authentication service is not configured.' }, 503);
      }
    }

    if (request.method === 'GET' && action === 'me') {
      try {
        const user = await currentUser(request);
        return jsonResponse({ user });
      } catch (error) {
        console.error('Unable to load current user', error);
        return jsonResponse({ error: 'Authentication service is not configured.' }, 503);
      }
    }

    if (request.method === 'POST' && action === 'login') {
      let body: { username?: unknown; pin?: unknown } = {};
      try {
        body = (await request.json()) as any;
      } catch {
        return jsonResponse({ error: 'Request body tidak valid.' }, 400);
      }

      try {
        const devToken = deviceTokenFromRequest(request) ?? undefined;
        const result = await loginWithPin(body.username, body.pin, devToken);
        if (!result) return jsonResponse({ error: 'Nama user atau PIN salah.' }, 401);
        if (result.locked) return jsonResponse({ error: 'Akun terkunci karena 5 kali percobaan gagal. Coba lagi dalam 15 menit.' }, 423);

        const responseHeaders: Record<string, string> = {
          'Set-Cookie': sessionCookie(result.token!),
        };
        return jsonResponse({ user: result.user }, 200, responseHeaders);
      } catch (error) {
        console.error('Unable to login', error);
        return jsonResponse({ error: 'Authentication service is not configured.' }, 503);
      }
    }

    if (request.method === 'POST' && action === 'changePin') {
      const user = await currentUser(request);
      if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

      try {
        const body = (await request.json()) as { oldPin?: string; newPin?: string; confirmPin?: string };
        if (!body.oldPin || !body.newPin) return jsonResponse({ error: 'PIN lama dan PIN baru wajib diisi.' }, 400);
        if (body.confirmPin && body.newPin !== body.confirmPin) {
          return jsonResponse({ error: 'Konfirmasi PIN tidak cocok.' }, 400);
        }
        await changePin(user.id, body.oldPin, body.newPin);
        return jsonResponse({ ok: true, message: 'PIN berhasil diperbarui.' });
      } catch (err: any) {
        return jsonResponse({ error: err.message || 'Gagal mengubah PIN' }, 400);
      }
    }

    if (request.method === 'POST' && action === 'resetPin') {
      const user = await currentUser(request);
      if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

      try {
        const body = (await request.json()) as { username?: string };
        if (!body.username) return jsonResponse({ error: 'Username target wajib diisi.' }, 400);
        const res = await resetUserPin(user, body.username);
        return jsonResponse(res);
      } catch (err: any) {
        return jsonResponse({ error: err.message || 'Gagal mereset PIN' }, 403);
      }
    }

    if (request.method === 'POST' && action === 'logout') {
      try {
        await revokeCurrentSession(request);
      } catch (error) {
        console.error('Unable to logout', error);
      }
      return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};
