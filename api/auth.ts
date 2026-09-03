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

type AuthScope = 'credential' | 'ip' | 'device';
type AuthLimitResult = { attempts: number; blocked: boolean; blocked_until: string | null };

async function authScopeKeys(username: string, clientIp: string, deviceToken: string) {
  const pepper = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!pepper) throw new Error('Server Supabase environment is not configured.');

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const values: Array<[AuthScope, string]> = [
    ['credential', username || 'invalid-credential'],
    ['ip', clientIp || 'unknown'],
    ['device', deviceToken],
  ];

  return Promise.all(values.map(async ([scope, value]) => {
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${scope}\0${value}`));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${scope}:${hash}`;
  }));
}

async function runAuthLimitRpc(
  db: SupabaseClient,
  rpc: 'rpc_check_auth_limits' | 'rpc_record_auth_failure' | 'rpc_reset_auth_failures',
  profileId: string | null,
  scopeKeys: string[],
): Promise<AuthLimitResult> {
  const { data, error } = await db.rpc(rpc, {
    p_profile_id: profileId,
    p_scope_keys: scopeKeys,
  });
  if (error) throw error;
  return data as AuthLimitResult;
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

export async function loginWithPin(
  usernameInput: unknown,
  pinInput: unknown,
  deviceTokenInput?: string,
  clientIp = 'unknown',
) {
  const username = normalizeUsername(usernameInput);
  const db = getAdminClient();
  const deviceToken = deviceTokenInput && /^[a-f0-9]{64}$/.test(deviceTokenInput)
    ? deviceTokenInput
    : randomHex(32);
  const [profile, scopeKeys] = await Promise.all([
    username ? getActiveProfile(username) : Promise.resolve(null),
    authScopeKeys(username, clientIp, deviceToken),
  ]);
  const profileId = profile?.id ?? null;
  const limits = await runAuthLimitRpc(db, 'rpc_check_auth_limits', profileId, scopeKeys);
  if (limits.blocked) return { locked: true, user: null, token: null };

  if (!username || !isValidPin(pinInput) || !profile) {
    await runAuthLimitRpc(db, 'rpc_record_auth_failure', profileId, scopeKeys);
    return null;
  }

  const { data: credential, error: credentialError } = await db
    .from('operator_credentials')
    .select('pin_salt, pin_hash')
    .eq('profile_id', profile.id)
    .maybeSingle();
  if (credentialError) throw credentialError;
  if (!credential) {
    await runAuthLimitRpc(db, 'rpc_record_auth_failure', profile.id, scopeKeys);
    return null;
  }

  const valid = await verifyPin(pinInput, credential.pin_salt, credential.pin_hash);
  if (!valid) {
    await runAuthLimitRpc(db, 'rpc_record_auth_failure', profile.id, scopeKeys);
    return null;
  }

  const token = randomHex(32);
  const now = new Date();
  await runAuthLimitRpc(db, 'rpc_reset_auth_failures', profile.id, scopeKeys);

  let deviceId: string | null = null;
  const deviceHash = await hashSessionToken(deviceToken);
  const { data: existingDevice } = await db.from('app_devices').select('id').eq('device_token_hash', deviceHash).maybeSingle();
  if (existingDevice) {
    deviceId = existingDevice.id;
    await db.from('app_devices').update({
      profile_id: profile.id,
      revoked_at: null,
      last_seen_at: now.toISOString(),
    }).eq('id', deviceId);
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

function clientIpFromRequest(request: Request) {
  const forwardedFor = request.headers.get('x-forwarded-for');
  return forwardedFor?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || request.headers.get('cf-connecting-ip')?.trim()
    || 'unknown';
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

export async function changePin(request: ApiRequest, profileId: string, oldPin: string, newPin: string) {
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
  const token = sessionTokenFromRequest(request);
  if (!token) throw new Error('Session aktif tidak ditemukan. Silakan login kembali.');

  const [{ data: session, error: sessionError }, { data: scopes, error: scopeError }] = await Promise.all([
    db.from('app_sessions')
      .select('id')
      .eq('token_hash', await hashSessionToken(token))
      .eq('profile_id', profileId)
      .is('revoked_at', null)
      .maybeSingle(),
    db.from('profile_outlet_scopes')
      .select('outlet_id, outlets!inner(active)')
      .eq('profile_id', profileId)
      .eq('active', true)
      .eq('outlets.active', true)
      .limit(2),
  ]);
  if (sessionError) throw sessionError;
  if (scopeError) throw scopeError;
  if (!session) throw new Error('Session aktif tidak ditemukan. Silakan login kembali.');
  if (scopes?.length !== 1) throw new Error('Akun harus memiliki tepat satu scope outlet aktif.');

  const { data: credential, error: credentialError } = await db
    .from('operator_credentials')
    .select('pin_salt, pin_hash, pin_version')
    .eq('profile_id', profileId)
    .single();
  if (credentialError) throw credentialError;
  if (!credential) throw new Error('Kredensial tidak ditemukan.');

  const validOld = await verifyPin(oldPin, credential.pin_salt, credential.pin_hash);
  if (!validOld) throw new Error('PIN lama salah.');

  // Check pin history
  const { data: history, error: historyError } = await db
    .from('pin_history')
    .select('pin_salt, pin_hash')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: false })
    .limit(3);
  if (historyError) throw historyError;

  if (history) {
    for (const h of history) {
      if (await verifyPin(newPin, h.pin_salt, h.pin_hash)) {
        throw new Error('PIN baru pernah digunakan sebelumnya.');
      }
    }
  }

  const { salt: newSalt, hash: newHash } = await hashPin(newPin);
  const { error } = await db.rpc('rpc_change_pin', {
    p_actor_id: profileId,
    p_outlet_id: scopes[0].outlet_id,
    p_current_session_id: session.id,
    p_expected_pin_version: credential.pin_version,
    p_new_pin_salt: newSalt,
    p_new_pin_hash: newHash,
    p_revoke_all_sessions: false,
  });
  if (error?.code === '40001' || /VERSION_CONFLICT/.test(error?.message ?? '')) {
    throw new Error('PIN telah berubah di sesi lain. Silakan login kembali.');
  }
  if (error) throw error;

  return { ok: true };
}

export async function resetUserPin(actorProfile: AuthProfile, targetUsernameInput: string) {
  if (actorProfile.role !== 'OWNER') throw new Error('Hanya Owner yang boleh mereset PIN.');

  const targetUsername = normalizeUsername(targetUsernameInput);
  if (!targetUsername) throw new Error('Username target wajib diisi.');

  const db = getAdminClient();
  const { data: scopes, error: scopeError } = await db
    .from('profile_outlet_scopes')
    .select('outlet_id, outlets!inner(active)')
    .eq('profile_id', actorProfile.id)
    .eq('active', true)
    .eq('outlets.active', true)
    .limit(2);
  if (scopeError) throw scopeError;
  if (scopes?.length !== 1) throw new Error('Akun harus memiliki tepat satu scope outlet aktif.');

  const { data: target, error: targetError } = await db
    .from('profiles')
    .select('id, username, role, operator_credentials!inner(pin_version), profile_outlet_scopes!inner(outlet_id, active)')
    .eq('username', targetUsername)
    .eq('active', true)
    .is('deactivated_at', null)
    .eq('profile_outlet_scopes.outlet_id', scopes[0].outlet_id)
    .eq('profile_outlet_scopes.active', true)
    .maybeSingle();
  if (targetError) throw targetError;
  if (!target) throw new Error('User target aktif pada outlet ini tidak ditemukan.');
  if (target.id === actorProfile.id || target.role === 'OWNER') {
    throw new Error('Reset PIN diri sendiri atau Owner lain tidak diizinkan.');
  }

  const credential = Array.isArray(target.operator_credentials)
    ? target.operator_credentials[0]
    : target.operator_credentials;
  if (!credential?.pin_version) throw new Error('Kredensial target tidak ditemukan.');

  let tempPin = '';
  while (!tempPin) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    if (random[0] >= Math.floor(0x1_0000_0000 / 900000) * 900000) continue;
    const candidate = (100000 + (random[0] % 900000)).toString();
    if (!isWeakPin(candidate)) tempPin = candidate;
  }

  const { salt, hash } = await hashPin(tempPin);
  const { data, error } = await db.rpc('rpc_reset_pin', {
    p_actor_id: actorProfile.id,
    p_outlet_id: scopes[0].outlet_id,
    p_target_username: targetUsername,
    p_new_pin_salt: salt,
    p_new_pin_hash: hash,
    p_expected_pin_version: credential.pin_version,
  });
  if (error?.code === '40001' || /VERSION_CONFLICT/.test(error?.message ?? '')) {
    throw new Error('VERSION_CONFLICT: PIN target telah berubah. Muat ulang lalu coba lagi.');
  }
  if (error) throw error;
  if (!data?.username || !data?.display_name) throw new Error('Respons reset PIN tidak valid.');

  return {
    ok: true,
    tempPin,
    username: data.username,
    display_name: data.display_name,
  };
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
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('Content-Type')) responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  if (!responseHeaders.has('Cache-Control')) responseHeaders.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
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
        const devToken = deviceTokenFromRequest(request) ?? randomHex(32);
        const result = await loginWithPin(body.username, body.pin, devToken, clientIpFromRequest(request));
        const responseHeaders = new Headers();
        responseHeaders.append('Set-Cookie', deviceCookie(devToken));
        if (!result || result.locked) {
          return jsonResponse({ error: 'Nama user atau PIN salah.' }, 401, responseHeaders);
        }

        responseHeaders.append('Set-Cookie', sessionCookie(result.token!));
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
        await changePin(request, user.id, body.oldPin, body.newPin);
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
        const conflict = /VERSION_CONFLICT/.test(err?.message ?? '');
        return jsonResponse({ error: err.message || 'Gagal mereset PIN' }, conflict ? 409 : 403);
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
