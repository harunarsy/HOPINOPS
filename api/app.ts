import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import { assertRuntimeDatabaseTarget } from './runtime.js';

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

type AuthContext = {
  user: AuthProfile;
  sessionId: string;
  deviceId: string | null;
};

const SESSION_COOKIE = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
  ? '__Host-hopin_session'
  : 'hopin_session';
const DEVICE_COOKIE = 'hopin_device';

const inactivityMs = 30 * 60 * 1000;
const pinIterations = 310_000;
const jsonBodyLimitBytes = 16 * 1024;

const WEAK_PINS = new Set([
  '000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999',
  '123456', '654321', '123123', '654654', '012345', '543210', '112233', '121212',
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

function deviceTokenFromRequest(request: ApiRequest) {
  const token = cookieValue(request, DEVICE_COOKIE);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

async function hashSessionToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', encodeText(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function currentAuthContext(request: ApiRequest): Promise<AuthContext | null> {
  const token = sessionTokenFromRequest(request);
  if (!token) return null;

  const db = getAdminClient();
  const { data: session, error: sessionError } = await db
    .from('app_sessions')
    .select('id, profile_id, device_id, expires_at, absolute_expires_at, last_seen_at, revoked_at')
    .eq('token_hash', await hashSessionToken(token))
    .is('revoked_at', null)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) return null;

  const now = Date.now();
  const expired = new Date(session.expires_at).getTime() <= now;
  const absolutelyExpired = session.absolute_expires_at && new Date(session.absolute_expires_at).getTime() <= now;
  const inactive = new Date(session.last_seen_at).getTime() + inactivityMs <= now;
  if (expired || absolutelyExpired || inactive) {
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

  let deviceId: string | null = null;
  const deviceToken = deviceTokenFromRequest(request);
  if (session.device_id && deviceToken) {
    const devHash = await hashSessionToken(deviceToken);
    const { data: device, error: deviceError } = await db
      .from('app_devices')
      .select('id')
      .eq('id', session.device_id)
      .eq('profile_id', profile.id)
      .eq('device_token_hash', devHash)
      .is('revoked_at', null)
      .maybeSingle();
    if (deviceError) throw deviceError;
    deviceId = device?.id ?? null;
  }

  await db.from('app_sessions').update({ last_seen_at: new Date(now).toISOString() }).eq('id', session.id);
  return {
    user: {
      id: profile.id,
      username: profile.username,
      display_name: profile.display_name,
      role: profile.role,
      force_pin_change: Boolean(profile.force_pin_change),
    },
    sessionId: session.id,
    deviceId,
  };
}

export async function currentUser(request: ApiRequest): Promise<AuthProfile | null> {
  return (await currentAuthContext(request))?.user ?? null;
}

async function derivePin(pin: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', encodeText(pin), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encodeText(salt), iterations: pinIterations, hash: 'SHA-256' }, key, 512);
  return btoa(String.fromCharCode(...new Uint8Array(derived)));
}

export async function hashPin(pin: string) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = btoa(String.fromCharCode(...saltBytes));
  return { salt, hash: await derivePin(pin, salt) };
}

function getAdminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error('Server Supabase environment is not configured.');
  assertRuntimeDatabaseTarget(process.env.HOPIN_RUNTIME, url);
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    },
  });
}

function errorResponse(code: string, message: string, status = 400, details?: any) {
  return jsonResponse({
    ok: false,
    request_id: crypto.randomUUID(),
    error: { code, message, details },
  }, status);
}

function successResponse(data: any, version?: number) {
  return jsonResponse({
    ok: true,
    request_id: crypto.randomUUID(),
    data,
    ...(version !== undefined ? { version } : {}),
  });
}

async function scopedOutletId(db: SupabaseClient, profileId: string): Promise<string | null> {
  const { data, error } = await db
    .from('profile_outlet_scopes')
    .select('outlet_id, outlets!inner(active)')
    .eq('profile_id', profileId)
    .eq('active', true)
    .eq('outlets.active', true)
    .limit(2);
  if (error) throw error;
  return data?.length === 1 ? data[0].outlet_id : null;
}

function rpcErrorResponse(error: any) {
  const message = typeof error?.message === 'string' ? error.message : 'Perintah database gagal.';
  if (error?.code === 'PGRST202' || error?.code === '42883' || /could not find (the )?function|function .* does not exist|schema cache/i.test(message)) {
    return errorResponse(
      'RPC_UNAVAILABLE',
      'Perintah server belum tersedia; tidak ada fallback mutation yang dijalankan.',
      503,
    );
  }

  const domainCode = message.match(/\b([A-Z][A-Z0-9_]+):/)?.[1];
  const code = domainCode
    || (error?.code === '23505' || error?.code === '55000' ? 'STATE_CONFLICT' : null)
    || (error?.code === '40001' ? 'VERSION_CONFLICT' : 'RPC_FAILED');
  let status = 500;
  if (error?.code === '42501' || /(?:FORBIDDEN|AUTHORIZATION_FAILED|INVALID_SESSION|INVALID_DEVICE)/.test(code)) status = 403;
  else if (error?.code === 'P0002' || code === 'NOT_FOUND') status = 404;
  else if (error?.code === '23505' || error?.code === '55000' || error?.code === '40001' || code === 'VERSION_CONFLICT') status = 409;
  else if (error?.code === '22023' || error?.code === '23514') status = 400;

  if (code === 'PRIMARY_TAKEN') {
    return errorResponse(
      code,
      'Penanggung jawab utama area ini sudah terisi. Anda dapat bergabung sebagai Bantuan.',
      409,
      { can_join_as_helper: true },
    );
  }
  if (code === 'ATTENDANCE_NOTE_REQUIRED') {
    return errorResponse(code, 'Catatan alasan wajib diisi jika lokasi GPS tidak terverifikasi.', 400);
  }

  const publicMessage = status === 400
    ? 'Payload perintah tidak valid.'
    : status === 403
      ? 'Perintah tidak diizinkan.'
      : status === 404
        ? 'Data tidak ditemukan.'
        : status === 409
          ? 'Data berubah atau status tidak lagi sesuai.'
          : 'Perintah database gagal.';
  return errorResponse(code, publicMessage, status);
}

function invalidRpcResult() {
  return errorResponse('RPC_INVALID_RESPONSE', 'Perintah server tidak mengembalikan hasil yang valid.', 502);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function isOptionalString(value: unknown, maxLength: number): boolean {
  return value === undefined || value === null || isNonEmptyString(value, maxLength);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isIsoMonth(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= 2000 && year < 9999;
}

function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const value = Number(month.slice(5, 7));
  return value === 12 ? `${year + 1}-01` : `${year}-${String(value + 1).padStart(2, '0')}`;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function hasOnlyKeys(value: Record<string, any>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every(key => allowed.has(key));
}

async function readJsonObject(request: Request, allowedKeys: readonly string[]): Promise<Record<string, any> | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return null;
  const text = await request.text();
  if (!text || new TextEncoder().encode(text).byteLength > jsonBodyLimitBytes) return null;
  try {
    const body: unknown = JSON.parse(text);
    return isObject(body) && hasOnlyKeys(body, allowedKeys) ? body : null;
  } catch {
    return null;
  }
}

function invalidPayload(message = 'Payload JSON tidak valid atau memuat field yang tidak diizinkan.') {
  return errorResponse('VALIDATION_FAILED', message, 400);
}

function isItemId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.trim());
}

function isQuantity(value: unknown, allowZero = false): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (allowZero ? value < 0 : value <= 0) return false;
  return /^\d{1,10}(?:\.\d{1,4})?$/.test(String(value));
}

function isWholeAmount(value: unknown, allowNegative = false): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && Math.abs(value) <= 99_999_999_999_999
    && (allowNegative || value >= 0);
}

function isStrongTemporaryPin(pin: string): boolean {
  return !WEAK_PINS.has(pin) && !/^(\d)\1{5}$/.test(pin);
}

function generateTemporaryPin(): string {
  const range = 900_000;
  const cutoff = 0x1_0000_0000 - (0x1_0000_0000 % range);
  const random = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(random);
    if (random[0] >= cutoff) continue;
    const pin = String(100_000 + (random[0] % range));
    if (isStrongTemporaryPin(pin)) return pin;
  }
}

function isOperationalRole(role: string) {
  return role === 'OPERATOR' || role === 'OWNER' || role === 'SUPERVISOR';
}

function snapshotLines(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((line: any) => ({
    item_id: line?.item_id,
    counted_qty: line?.counted_qty,
    reason_code: line?.reason_code ?? null,
    notes: line?.notes ?? null,
  }));
}

function isDraftLines(value: unknown): value is Array<Record<string, any>> {
  if (!Array.isArray(value) || value.length > 200) return false;
  const itemIds = new Set<string>();
  for (const line of value) {
    if (!isObject(line) || !hasOnlyKeys(line, ['item_id', 'counted_qty', 'reason_code', 'notes'])
      || !Object.prototype.hasOwnProperty.call(line, 'item_id')
      || !Object.prototype.hasOwnProperty.call(line, 'counted_qty')
      || !isItemId(line.item_id) || line.item_id !== line.item_id.trim()
      || !isQuantity(line.counted_qty, true)
      || (line.reason_code !== undefined && line.reason_code !== null && typeof line.reason_code !== 'string')
      || (line.notes !== undefined && line.notes !== null && typeof line.notes !== 'string')
      || itemIds.has(line.item_id)) {
      return false;
    }
    itemIds.add(line.item_id);
  }
  return true;
}

function isSnapshotLines(value: unknown): value is Array<Record<string, any>> {
  // Confirmations must carry a complete, typed physical snapshot. Never turn a
  // malformed payload into an empty snapshot or an implicit zero baseline.
  return isDraftLines(value) && value.length > 0 && value.every((line: any) =>
    typeof line.reason_code === 'string' || line.reason_code === null || line.reason_code === undefined
  );
}

function isPhysicalBaselineLines(value: unknown): value is Array<Record<string, any>> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return false;
  const itemIds = new Set<string>();
  for (const line of value) {
    if (!isObject(line) || !hasOnlyKeys(line, ['item_id', 'counted_qty'])
      || !isItemId(line.item_id) || line.item_id !== line.item_id.trim()
      || !isQuantity(line.counted_qty, true) || itemIds.has(line.item_id)) {
      return false;
    }
    itemIds.add(line.item_id);
  }
  return true;
}

function attendanceChallengeBinding(body: any): { challengeId: string; nonce: string } | null {
  if (isUuid(body?.challengeId) && typeof body?.nonce === 'string' && body.nonce.length > 0) {
    return { challengeId: body.challengeId, nonce: body.nonce };
  }

  if (typeof body?.challengeId !== 'string') return null;
  const separator = body.challengeId.indexOf('.');
  const challengeId = body.challengeId.slice(0, separator);
  const nonce = body.challengeId.slice(separator + 1);
  return separator > 0 && isUuid(challengeId) && nonce.length > 0 ? { challengeId, nonce } : null;
}

function requestCountry(request: Request) {
  const value = request.headers.get('x-vercel-ip-country') || request.headers.get('cf-ipcountry');
  const country = value?.trim().toUpperCase();
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
}

export function getWibDate(date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Convert date to WIB minutes from midnight (0..1439)
export function getWibMinutesOfDay(date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);

  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

// Sanitize string to prevent Excel Formula Injection
export function sanitizeExcelCell(val: any): any {
  if (typeof val === 'string' && /^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u.test(val)) {
    return `'${val}`;
  }
  return val;
}

async function sha256Buffer(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const source = new Uint8Array(buffer);
  const digest = await crypto.subtle.digest('SHA-256', source.buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialize = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Canonical JSON numbers must be finite.');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError(`Unsupported canonical JSON value: ${typeof item}`);
    if (seen.has(item)) throw new TypeError('Canonical JSON does not support cyclic values.');
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getOwnPropertySymbols(item).length > 0
          || Object.keys(item).some(key => !/^(0|[1-9]\d*)$/.test(key))
          || Array.from({ length: item.length }, (_, index) => index)
            .some(index => !Object.prototype.hasOwnProperty.call(item, index))) {
          throw new TypeError('Canonical JSON only supports dense arrays.');
        }
        return `[${item.map(serialize).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(item).length > 0) {
        throw new TypeError('Canonical JSON only supports plain string-keyed objects.');
      }
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${serialize((item as Record<string, unknown>)[key])}`).join(',')}}`;
    } finally {
      seen.delete(item);
    }
  };
  return serialize(value);
}

export default {
  async fetch(request: Request) {
    // CSRF / Origin Validation
    if (!validateOrigin(request)) {
      return errorResponse('ORIGIN_REJECTED', 'Origin request tidak diizinkan (CSRF Protection)', 403);
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (!action) return errorResponse('NOT_FOUND', 'Action tidak ditemukan', 404);

    let authContext;
    try {
      authContext = await currentAuthContext(request);
    } catch (err) {
      console.error('API Auth/Dependency Error:', err);
      return errorResponse('SERVICE_UNAVAILABLE', 'Layanan autentikasi atau database mengalami kendala. Coba lagi.', 503);
    }
    if (!authContext) {
      return errorResponse('AUTH_REQUIRED', 'Sesi tidak valid atau telah berakhir.', 401);
    }
    let db;
    try {
      db = getAdminClient();
    } catch (err) {
      console.error('API Dependency Error:', err);
      return errorResponse('SERVICE_UNAVAILABLE', 'Layanan autentikasi atau database mengalami kendala. Coba lagi.', 503);
    }
    const user = authContext.user;

    if (user.force_pin_change && action !== 'changePin' && action !== 'bootstrap') {
      return errorResponse('PIN_CHANGE_REQUIRED', 'Wajib mengganti PIN sebelum melanjutkan.', 403);
    }

    try {
      const outletId = await scopedOutletId(db, user.id);
      if (!outletId) {
        return errorResponse('OUTLET_SCOPE_REQUIRED', 'Akun harus memiliki tepat satu scope outlet aktif.', 403);
      }

      // 1. BOOTSTRAP
      if (action === 'bootstrap' && request.method === 'GET') {
        const { data: outlet, error: outletError } = await db.from('outlets').select('*').eq('id', outletId).eq('active', true).single();
        if (outletError || !outlet) throw (outletError || new Error('OUTLET_NOT_FOUND'));

        const { data: settings, error: settingsError } = await db.from('outlet_settings').select('*').eq('outlet_id', outletId).single();
        if (settingsError || !settings) throw (settingsError || new Error('SETTINGS_NOT_FOUND'));

        const { data: items, error: itemsError } = await db.from('items').select('*').eq('active', true).order('name');
        if (itemsError) throw itemsError;

        const { data: shifts, error: shiftsError } = await db.from('shift_templates').select('*').eq('outlet_id', outlet?.id).eq('active', true);
        if (shiftsError) throw shiftsError;

        // Onboarding state is projected by the database so a supervisor reset
        // can be deferred safely while an operator is still working. Forced
        // PIN changes take precedence and cannot call the operator-only RPC.
        let onboarding = null;
        if (user.role === 'OPERATOR' && !user.force_pin_change) {
          const { data: onboardingState, error: onboardingError } = await db.rpc('rpc_get_onboarding_state', {
            p_actor_id: user.id,
            p_outlet_id: outletId,
          });
          if (onboardingError) return rpcErrorResponse(onboardingError);
          if (!isObject(onboardingState)
            || !isPositiveInteger(onboardingState.onboarding_version)
            || (onboardingState.progress !== null && !isObject(onboardingState.progress))
            || typeof onboardingState.reset_required !== 'boolean'
            || typeof onboardingState.reset_deferred !== 'boolean'
            || (onboardingState.reset_requested_at !== null && typeof onboardingState.reset_requested_at !== 'string')) {
            return invalidRpcResult();
          }
          onboarding = onboardingState;
        }

        const workDate = getWibDate();
        const { data: activeAssignment } = await db
          .from('work_assignments')
          .select('*, work_cycles!inner(*)')
           .eq('profile_id', user.id)
          .eq('work_cycles.outlet_id', outletId)
          .eq('work_date', workDate)
          .in('status', ['ACTIVE', 'PENDING_TASKS'])
          .maybeSingle();

        const { data: activeAttendance } = await db
          .from('attendance_records')
           .select('*')
           .eq('profile_id', user.id)
          .eq('outlet_id', outletId)
          .eq('work_date', workDate)
          .maybeSingle();

        return successResponse({
          user,
          outlet,
          settings: {
            ...settings,
            latitude: user.role === 'OWNER' || user.role === 'SUPERVISOR' ? settings?.latitude : undefined,
            longitude: user.role === 'OWNER' || user.role === 'SUPERVISOR' ? settings?.longitude : undefined,
          },
          items: items ?? [],
          shifts: shifts ?? [],
          onboarding,
          activeAssignment,
          activeAttendance,
          workDate,
        });
      }

      if (action === 'sessions.list' && request.method === 'GET') {
        const { data, error } = await db.rpc('rpc_list_sessions', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !hasOnlyKeys(data, ['sessions']) || !Array.isArray(data.sessions)
          || data.sessions.some((session: any) => !isObject(session)
            || !hasOnlyKeys(session, ['session_id', 'created_at', 'last_seen_at', 'expires_at', 'version'])
            || !isUuid(session.session_id) || !isTimestamp(session.created_at)
            || !isTimestamp(session.last_seen_at) || !isTimestamp(session.expires_at)
            || !isPositiveInteger(session.version))) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'sessions.revoke' && request.method === 'POST') {
        const body = await readJsonObject(request, ['session_ids', 'expected_versions', 'idempotency_key']);
        const sessionIds = body?.session_ids;
        const expectedVersions = body?.expected_versions;
        if (!body || !Array.isArray(sessionIds) || sessionIds.length < 1 || sessionIds.length > 20
          || sessionIds.some(sessionId => !isUuid(sessionId))
          || new Set(sessionIds).size !== sessionIds.length
          || !Array.isArray(expectedVersions) || expectedVersions.length !== sessionIds.length
          || expectedVersions.some(version => !isPositiveInteger(version))
          || !isUuid(body.idempotency_key)) {
          return invalidPayload('session_ids, expected_versions, dan idempotency_key wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_revoke_sessions', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_session_ids: sessionIds,
          p_expected_versions: expectedVersions,
          p_idempotency_key: body.idempotency_key,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !hasOnlyKeys(data, ['revoked_count', 'idempotent_replay'])
          || data.revoked_count !== sessionIds.length || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse(data);
      }

      // 2. DASHBOARD (OWNER / SUPERVISOR)
      if (action === 'dashboard.get' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Owner & Supervisor yang dapat mengakses dashboard manajemen.', 403);
        }
        const workDate = url.searchParams.get('date') || getWibDate();
        const { data: cycles } = await db.from('work_cycles').select('*, work_assignments(*, profiles(display_name))').eq('outlet_id', outletId).eq('work_date', workDate);
        const { data: attendance } = await db.from('attendance_records').select('*, profiles(display_name, role), attendance_events(*)').eq('outlet_id', outletId).eq('work_date', workDate);
        const { data: reports } = await db.from('daily_reports').select('*, daily_report_revisions(*)').eq('outlet_id', outletId).eq('work_date', workDate);
        const { data: exceptions } = await db.from('attendance_records').select('*, profiles(display_name)').eq('outlet_id', outletId).eq('work_date', workDate).or('lateness_status.eq.LATE,status.eq.REVIEW_REQUIRED,status.eq.MISSING_CHECKOUT');

        return successResponse({
          cycles: cycles ?? [],
          attendance: attendance ?? [],
          reports: reports ?? [],
          exceptions: exceptions ?? [],
        });
      }

      // 3. INVESTOR REPORTS (READ-ONLY)
      if (action === 'investor.reports' && request.method === 'GET') {
        if (user.role !== 'INVESTOR' && user.role !== 'OWNER') {
          return errorResponse('FORBIDDEN', 'Hanya Investor dan Owner yang berhak melihat laporan investor.', 403);
        }
        if (user.role === 'INVESTOR') {
          const { data: revisions, error } = await db
            .from('daily_report_revisions')
            .select(`
              id, revision, status, public_id,
              daily_report_finance(*), daily_report_stock_lines(*),
              daily_report_shares!inner(recipient_id),
              daily_reports!inner(id, work_date, status, current_revision)
            `)
            .eq('daily_report_shares.recipient_id', user.id)
            .eq('daily_reports.outlet_id', outletId)
            .in('status', ['SUBMITTED', 'APPROVED']);
          if (error) throw error;

          const reports = (revisions ?? []).flatMap((revision: any) => {
            const report = revision.daily_reports;
            if (!report || report.current_revision !== revision.revision || report.status !== revision.status) return [];
            return [{
              ...report,
              daily_report_revisions: [{
                id: revision.id,
                revision: revision.revision,
                status: revision.status,
                public_id: revision.public_id,
                daily_report_finance: revision.daily_report_finance,
                daily_report_stock_lines: revision.daily_report_stock_lines,
              }],
            }];
          }).sort((left: any, right: any) => right.work_date.localeCompare(left.work_date)).slice(0, 30);

          return successResponse({ reports });
        }
        const { data: reports } = await db
           .from('daily_reports')
           .select('id, work_date, status, current_revision, daily_report_revisions(*, daily_report_finance(*), daily_report_stock_lines(*))')
          .eq('outlet_id', outletId)
          .in('status', ['SUBMITTED', 'APPROVED'])
          .order('work_date', { ascending: false })
          .limit(30);

        const submittedReports = (reports ?? []).flatMap((report: any) => {
          const current = (report.daily_report_revisions ?? []).filter(
            (revision: any) => revision.revision === report.current_revision
              && revision.status === report.status
              && (revision.status === 'SUBMITTED' || revision.status === 'APPROVED'),
          );
          return current.length === 1 ? [{ ...report, daily_report_revisions: current }] : [];
        });

        return successResponse({ reports: submittedReports });
      }

      // 4. ITEMS LIST & MANAGEMENT
      if (action === 'items.list' && request.method === 'GET') {
        if (user.role === 'INVESTOR' || !isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan melihat master item.', 403);
        }
        const includeArchived = new URL(request.url).searchParams.get('include_archived') === '1';
        const query = db.from('items').select('*').order('name');
        const { data, error } = includeArchived ? await query : await query.eq('active', true);
        if (error) throw error;
        return successResponse({ items: data ?? [] });
      }

      if (action === 'items.create' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Owner atau Supervisor yang boleh menambah item.', 403);
        const body = await readJsonObject(request, ['area_code', 'name', 'unit_code', 'low_threshold', 'section_id']);
        if (!body || !['BAR', 'KITCHEN'].includes(body.area_code)
          || !isNonEmptyString(body.name, 150) || !isNonEmptyString(body.unit_code, 32)
          || !isQuantity(body.low_threshold, true)
          || (body.section_id !== undefined && body.section_id !== null && !isUuid(body.section_id))) {
          return invalidPayload('Area, nama, satuan, batas stok, dan kelompok item wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_create_item_auto', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_area_code: body.area_code,
          p_name: body.name.trim(),
          p_unit_code: body.unit_code.trim(),
          p_low_threshold: body.low_threshold,
          p_section_id: body.section_id ?? null,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isItemId(data.id) || data.area_code !== body.area_code || data.active !== true) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'items.update' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Owner atau Supervisor yang boleh mengubah item.', 403);
        const body = await readJsonObject(request, ['id', 'name', 'unit_code', 'low_threshold']);
        if (!body || !isItemId(body.id) || !isNonEmptyString(body.name, 150)
          || !isNonEmptyString(body.unit_code, 32) || !isQuantity(body.low_threshold, true)) {
          return invalidPayload('ID, nama, satuan, dan batas stok item wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_update_item_auto', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_item_id: body.id.trim(),
          p_name: body.name.trim(),
          p_unit_code: body.unit_code.trim(),
          p_low_threshold: body.low_threshold,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.id !== body.id.trim() || data.active !== true) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'items.archive' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Owner atau Supervisor yang boleh mengarsipkan item.', 403);
        const body = await readJsonObject(request, ['id', 'reason']);
        if (!body || !isItemId(body.id) || !isNonEmptyString(body.reason, 500)) {
          return invalidPayload('ID item dan reason wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_archive_item_auto', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_item_id: body.id.trim(),
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.id !== body.id.trim() || data.active !== false) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'items.restore' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Owner atau Supervisor yang boleh memulihkan item.', 403);
        const body = await readJsonObject(request, ['id', 'reason']);
        if (!body || !isItemId(body.id) || !isNonEmptyString(body.reason, 500)) {
          return invalidPayload('ID item dan alasan pemulihan wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_restore_item', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_item_id: body.id.trim(),
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.id !== body.id.trim() || data.active !== true) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'items.history' && request.method === 'GET') {
        if (user.role === 'INVESTOR' || !isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan melihat histori master item.', 403);
        }
        const itemId = new URL(request.url).searchParams.get('id');
        if (!isItemId(itemId)) return invalidPayload('ID item wajib valid.');
        const { data, error } = await db
          .from('item_master_revisions')
          .select('*')
          .eq('item_id', itemId.trim())
          .order('effective_at', { ascending: false });
        if (error) throw error;
        return successResponse({ revisions: data ?? [] });
      }

      if (action === 'units.list' && request.method === 'GET') {
        if (user.role === 'INVESTOR' || !isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan melihat master satuan.', 403);
        }
        const includeArchived = new URL(request.url).searchParams.get('include_archived') === '1';
        const query = db.from('unit_options').select('*').order('sort_order').order('label');
        const { data, error } = includeArchived ? await query : await query.eq('active', true);
        if (error) throw error;
        return successResponse({ units: data ?? [] });
      }

      if (action === 'units.history' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Histori satuan hanya dapat dilihat supervisor.', 403);
        }
        const unitCode = new URL(request.url).searchParams.get('code');
        if (typeof unitCode !== 'string' || !/^[a-z][a-z0-9._-]{0,31}$/.test(unitCode.trim().toLowerCase())) {
          return invalidPayload('Kode satuan wajib valid.');
        }
        const { data, error } = await db
          .from('unit_option_revisions')
          .select('*')
          .eq('unit_code', unitCode.trim().toLowerCase())
          .order('effective_at', { ascending: false });
        if (error) throw error;
        return successResponse({ revisions: data ?? [] });
      }

      if (action === 'units.create' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Owner atau Supervisor yang boleh menambah satuan.', 403);
        const body = await readJsonObject(request, ['code', 'label', 'decimal_scale', 'sort_order']);
        const sortOrder = body?.sort_order ?? 90;
        if (!body || typeof body.code !== 'string' || !/^[a-z][a-z0-9._-]{0,31}$/.test(body.code.trim().toLowerCase())
          || !isNonEmptyString(body.label, 40) || !Number.isInteger(body.decimal_scale)
          || body.decimal_scale < 0 || body.decimal_scale > 4 || !Number.isInteger(sortOrder) || sortOrder < 0) {
          return invalidPayload('Kode, nama, skala desimal, dan urutan satuan wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_create_unit_option', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_code: body.code.trim().toLowerCase(),
          p_label: body.label.trim(),
          p_decimal_scale: body.decimal_scale,
          p_sort_order: sortOrder,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || typeof data.code !== 'string' || data.active !== true) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'units.archive' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Owner atau Supervisor yang boleh mengarsipkan satuan.', 403);
        const body = await readJsonObject(request, ['code', 'reason']);
        if (!body || typeof body.code !== 'string' || !/^[a-z][a-z0-9._-]{0,31}$/.test(body.code.trim().toLowerCase()) || !isNonEmptyString(body.reason, 500)) {
          return invalidPayload('Kode dan alasan arsip satuan wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_archive_unit_option', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_code: body.code.trim().toLowerCase(),
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.code !== body.code.trim().toLowerCase() || data.active !== false) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'units.restore' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Owner atau Supervisor yang boleh memulihkan satuan.', 403);
        const body = await readJsonObject(request, ['code']);
        if (!body || typeof body.code !== 'string' || !/^[a-z][a-z0-9._-]{0,31}$/.test(body.code.trim().toLowerCase())) {
          return invalidPayload('Kode satuan wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_restore_unit_option', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_code: body.code.trim().toLowerCase(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.code !== body.code.trim().toLowerCase() || data.active !== true) return invalidRpcResult();
        return successResponse(data);
      }

      // B07: PRIMARY scoped catalog (own active area only; RPC enforces scope).
      if (action === 'items.operatorCreate' && request.method === 'POST') {
        if (user.role !== 'OPERATOR') return errorResponse('FORBIDDEN', 'Jalur ini hanya untuk Operator PRIMARY.', 403);
        const body = await readJsonObject(request, ['area_code', 'name', 'unit_code', 'low_threshold', 'section_id']);
        if (!body || !['BAR', 'KITCHEN'].includes(body.area_code)
          || !isNonEmptyString(body.name, 150) || !isNonEmptyString(body.unit_code, 32)
          || !isQuantity(body.low_threshold, true)
          || (body.section_id !== undefined && body.section_id !== null && !isUuid(body.section_id))) {
          return invalidPayload('Area, nama, satuan, batas stok, dan kelompok item wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_operator_create_item_auto', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_area_code: body.area_code,
          p_name: body.name.trim(),
          p_unit_code: body.unit_code.trim(),
          p_low_threshold: body.low_threshold,
          p_section_id: body.section_id ?? null,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isItemId(data.id) || data.area_code !== body.area_code) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'items.operatorUpdate' && request.method === 'POST') {
        if (user.role !== 'OPERATOR') return errorResponse('FORBIDDEN', 'Jalur ini hanya untuk Operator PRIMARY.', 403);
        const body = await readJsonObject(request, ['id', 'name', 'unit_code', 'low_threshold']);
        if (!body || !isItemId(body.id) || !isNonEmptyString(body.name, 150)
          || !isNonEmptyString(body.unit_code, 32) || !isQuantity(body.low_threshold, true)) {
          return invalidPayload('ID, nama, satuan, dan batas stok item wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_operator_update_item_auto', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_item_id: body.id.trim(),
          p_name: body.name.trim(),
          p_unit_code: body.unit_code.trim(),
          p_low_threshold: body.low_threshold,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.id !== body.id.trim() || data.active !== true) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'items.operatorArchive' && request.method === 'POST') {
        if (user.role !== 'OPERATOR') return errorResponse('FORBIDDEN', 'Jalur ini hanya untuk Operator PRIMARY.', 403);
        const body = await readJsonObject(request, ['id', 'reason']);
        if (!body || !isItemId(body.id) || !isNonEmptyString(body.reason, 500)) {
          return invalidPayload('ID item dan reason wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_operator_archive_item_auto', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_item_id: body.id.trim(),
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.id !== body.id.trim()) return invalidRpcResult();
        return successResponse(data);
      }

      // Checklist layout server-owned (Owner/Supervisor full outlet; PRIMARY own area; Investor denied).
      if (action === 'checklist.layout' && request.method === 'GET') {
        if (user.role === 'INVESTOR' || !isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan melihat susunan checklist.', 403);
        }
        const area = new URL(request.url).searchParams.get('area_code');
        if (area !== 'BAR' && area !== 'KITCHEN') return invalidPayload('area_code wajib BAR atau KITCHEN.');
        const { data, error } = await db.rpc('rpc_checklist_layout_get', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_area_code: area,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !Number.isInteger((data as any).version)
          || !Array.isArray((data as any).sections) || !Array.isArray((data as any).placements)) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'checklist.section.upsert' && request.method === 'POST') {
        if (user.role === 'INVESTOR' || !isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan menata bagian.', 403);
        }
        const body = await readJsonObject(request, ['area_code', 'name', 'idempotency_key']);
        if (!body || !['BAR', 'KITCHEN'].includes(body.area_code) || !isNonEmptyString(body.name, 80)
          || !isUuid(body.idempotency_key) || (body.section_id !== undefined && body.section_id !== null && !isUuid(body.section_id))) {
          return invalidPayload('area_code, name, dan idempotency_key wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_checklist_section_upsert', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_area_code: body.area_code,
          p_section_id: body.section_id ?? null,
          p_name: body.name.trim(),
          p_idempotency_key: body.idempotency_key,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isObject((data as any).section)) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'checklist.item.move' && request.method === 'POST') {
        if (user.role === 'INVESTOR' || !isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan menata item.', 403);
        }
        const body = await readJsonObject(request, ['area_code', 'item_id', 'section_id', 'position', 'expected_layout_version', 'idempotency_key']);
        if (!body || !['BAR', 'KITCHEN'].includes(body.area_code) || !isItemId(body.item_id)
          || !isUuid(body.section_id) || !Number.isInteger(body.position) || body.position < 0
          || !isPositiveInteger(body.expected_layout_version) || !isUuid(body.idempotency_key)) {
          return invalidPayload('Payload pemindahan checklist wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_checklist_item_move', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_area_code: body.area_code,
          p_item_id: body.item_id.trim(),
          p_section_id: body.section_id,
          p_position: body.position,
          p_expected_layout_version: body.expected_layout_version,
          p_idempotency_key: body.idempotency_key,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || typeof (data as any).layout_version !== 'number') return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'settings.get' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh membaca pengaturan.', 403);
        const { data: settings, error: settingsError } = await db.from('outlet_settings').select('*').eq('outlet_id', outletId).maybeSingle();
        if (settingsError) throw settingsError;
        if (!settings) return errorResponse('NOT_FOUND', 'Pengaturan outlet tidak ditemukan.', 404);
        // Mask exact coordinates for Supervisor; Owner may read full settings.
        if (user.role === 'SUPERVISOR') {
          return successResponse({ ...settings, latitude: undefined, longitude: undefined });
        }
        return successResponse(settings);
      }

      if (action === 'settings.update' && request.method === 'POST') {
        if (user.role !== 'OWNER') return errorResponse('FORBIDDEN', 'Hanya Owner yang boleh mengubah pengaturan.', 403);
        const body = await readJsonObject(request, ['expected_version', 'settings']);
        const settings = body?.settings;
        const settingKeys = [
          'latitude', 'longitude', 'geofence_radius_m', 'max_accuracy_m', 'gps_sample_limit',
          'gps_timeout_seconds', 'late_grace_minutes', 'overtime_threshold_minutes',
          'raw_gps_retention_days', 'system_mode', 'onboarding_version',
        ] as const;
        if (!body || !isPositiveInteger(body.expected_version) || !isObject(settings)
          || Object.keys(settings).length === 0 || !hasOnlyKeys(settings, settingKeys)
          || ('latitude' in settings && settings.latitude !== null && (!Number.isFinite(settings.latitude) || settings.latitude < -90 || settings.latitude > 90))
          || ('longitude' in settings && settings.longitude !== null && (!Number.isFinite(settings.longitude) || settings.longitude < -180 || settings.longitude > 180))
          || ('geofence_radius_m' in settings && (!Number.isInteger(settings.geofence_radius_m) || settings.geofence_radius_m < 10 || settings.geofence_radius_m > 10_000))
          || ('max_accuracy_m' in settings && (!Number.isInteger(settings.max_accuracy_m) || settings.max_accuracy_m < 5 || settings.max_accuracy_m > 500))
          || ('gps_sample_limit' in settings && (!Number.isInteger(settings.gps_sample_limit) || settings.gps_sample_limit < 1 || settings.gps_sample_limit > 10))
          || ('gps_timeout_seconds' in settings && (!Number.isInteger(settings.gps_timeout_seconds) || settings.gps_timeout_seconds < 5 || settings.gps_timeout_seconds > 60))
          || ('late_grace_minutes' in settings && (!Number.isInteger(settings.late_grace_minutes) || settings.late_grace_minutes < 0 || settings.late_grace_minutes > 1440))
          || ('overtime_threshold_minutes' in settings && (!Number.isInteger(settings.overtime_threshold_minutes) || settings.overtime_threshold_minutes < 0 || settings.overtime_threshold_minutes > 1440))
          || ('raw_gps_retention_days' in settings && (!Number.isInteger(settings.raw_gps_retention_days) || settings.raw_gps_retention_days < 7 || settings.raw_gps_retention_days > 365))
          || ('system_mode' in settings && !['PRODUCTION', 'PILOT', 'MAINTENANCE'].includes(settings.system_mode))
          || ('onboarding_version' in settings && !isPositiveInteger(settings.onboarding_version))) {
          return invalidPayload('expected_version dan settings wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_update_settings', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_expected_version: body.expected_version,
          p_settings: settings,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.outlet_id !== outletId || data.version !== body.expected_version + 1) return invalidRpcResult();
        return successResponse(data, data.version);
      }

      // 5. ROSTER & SWAP
      if (action === 'roster.list' && request.method === 'GET') {
        const month = url.searchParams.get('month') || getWibDate().slice(0, 7);
        if (!isOperationalRole(user.role)) return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan melihat roster.', 403);
        if (!isIsoMonth(month)) return errorResponse('VALIDATION_FAILED', 'month wajib berformat YYYY-MM.', 400);
        let query = db
          .from('roster_entries')
          .select('*')
          .eq('outlet_id', outletId)
          .gte('work_date', `${month}-01`)
          .lt('work_date', `${nextMonth(month)}-01`);
        if (user.role === 'OPERATOR') query = query.eq('profile_id', user.id);
        const { data: rosterEntries, error: rosterError } = await query.order('work_date', { ascending: true });
        if (rosterError) throw rosterError;

        const profileIds = [...new Set((rosterEntries ?? []).map((entry) => entry.profile_id).filter(isUuid))];
        const profilesById = new Map<string, { username: string | null; display_name: string | null }>();
        if (profileIds.length > 0) {
          const { data: profiles, error: profilesError } = await db
            .from('profiles')
            .select('id, username, display_name')
            .in('id', profileIds);
          if (profilesError) throw profilesError;
          for (const profile of profiles ?? []) {
            profilesById.set(profile.id, { username: profile.username, display_name: profile.display_name });
          }
        }

        const roster = (rosterEntries ?? []).map((entry) => ({
          ...entry,
          profiles: profilesById.get(entry.profile_id) ?? null,
        }));
        return successResponse({ roster });
      }

      if (action === 'roster.save' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mengatur roster.', 403);
        const body = await readJsonObject(request, [
          'id', 'expected_version', 'work_date', 'shift_code', 'profile_id',
          'expected_area', 'pay_treatment', 'override_reason',
        ]);
        const entryId = body?.id ?? null;
        const expectedVersion = body?.expected_version ?? null;
        const expectedArea = body?.expected_area ?? null;
        const payTreatment = body?.pay_treatment ?? 'BASE';
        const overrideReason = body?.override_reason ?? null;
        if (!body || (entryId !== null && !isUuid(entryId))
          || (entryId === null ? expectedVersion !== null : !isPositiveInteger(expectedVersion))
          || !isIsoDate(body.work_date) || !['SIANG', 'MALAM', 'FULL'].includes(body.shift_code)
          || !isUuid(body.profile_id) || (expectedArea !== null && !['BAR', 'KITCHEN'].includes(expectedArea))
          || !['BASE', 'EXTRA', 'MAKEUP'].includes(payTreatment) || !isOptionalString(overrideReason, 500)
          || (new Date(`${body.work_date}T00:00:00Z`).getUTCDay() === 2 && !isNonEmptyString(overrideReason, 500))) {
          return invalidPayload('Roster ID/version, tanggal, shift, profile, area, treatment, atau alasan tidak valid.');
        }
        const { data, error } = await db.rpc('rpc_save_roster', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_entry_id: entryId,
          p_expected_version: expectedVersion,
          p_work_date: body.work_date,
          p_shift_code: body.shift_code,
          p_profile_id: body.profile_id,
          p_expected_area: expectedArea,
          p_pay_treatment: payTreatment,
          p_override_reason: overrideReason,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isUuid(data.id) || data.outlet_id !== outletId
          || data.profile_id !== body.profile_id
          || data.version !== (entryId === null ? 1 : expectedVersion + 1)) return invalidRpcResult();
        return successResponse(data, data.version);
      }

      if (action === 'roster.cancel' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh membatalkan roster.', 403);
        const body = await readJsonObject(request, ['id', 'expected_version', 'reason']);
        if (!body || !isUuid(body.id) || !isPositiveInteger(body.expected_version) || !isNonEmptyString(body.reason, 500)) {
          return invalidPayload('Roster ID, expected_version, dan alasan pembatalan wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_cancel_roster', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_entry_id: body.id,
          p_expected_version: body.expected_version,
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isUuid(data.id) || data.outlet_id !== outletId
          || data.status !== 'CANCELLED' || data.version !== body.expected_version + 1) return invalidRpcResult();
        return successResponse(data, data.version);
      }

      if (action === 'swap.request' && request.method === 'POST') {
        const body = await readJsonObject(request, ['roster_entry_id', 'offered_to', 'expected_version']);
        if (!body || !isUuid(body.roster_entry_id) || !isUuid(body.offered_to)
          || body.offered_to === user.id || !isPositiveInteger(body.expected_version)) {
          return invalidPayload('Roster, target swap, dan expected_version wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_request_shift_swap', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_roster_entry_id: body.roster_entry_id,
          p_offered_to: body.offered_to,
          p_expected_roster_version: body.expected_version,
        });
        if (error) return rpcErrorResponse(error);
        if (!data?.id) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'swap.respond' && request.method === 'POST') {
        const body = await readJsonObject(request, ['swap_id', 'accept', 'expected_version']);
        if (!body || !isUuid(body.swap_id) || typeof body.accept !== 'boolean' || !isPositiveInteger(body.expected_version)) {
          return invalidPayload('Swap, keputusan, dan expected_version wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_respond_shift_swap', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_swap_id: body.swap_id,
          p_accept: body.accept,
          p_expected_swap_version: body.expected_version,
        });
        if (error) return rpcErrorResponse(error);
        if (!data?.swap?.id) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'swap.cancel' && request.method === 'POST') {
        const body = await readJsonObject(request, ['swap_id', 'expected_version']);
        if (!body || !isUuid(body.swap_id) || !isPositiveInteger(body.expected_version)) {
          return invalidPayload('swap_id UUID dan expected_version integer positif wajib diisi.');
        }
        const { data, error } = await db.rpc('rpc_cancel_shift_swap', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_swap_id: body.swap_id,
          p_expected_swap_version: body.expected_version,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.id !== body.swap_id || !['CANCELLED', 'EXPIRED'].includes(data.status)
          || data.version !== body.expected_version + 1) return invalidRpcResult();
        return successResponse(data, data.version);
      }

      // 6. ASSIGNMENT CLAIM (RPC / TRANSACTIONAL LOCK)
      if (action === 'assignment.active' && request.method === 'GET') {
        if (!isOperationalRole(user.role)) return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan melihat assignment.', 403);
        const workDate = url.searchParams.get('date') || getWibDate();
        if (!isIsoDate(workDate)) return errorResponse('VALIDATION_FAILED', 'date wajib berupa tanggal ISO.', 400);
        let query = db
          .from('work_assignments')
          .select('*, work_cycles!inner(*)')
          .eq('work_cycles.outlet_id', outletId)
          .eq('work_date', workDate)
          .in('status', ['ACTIVE', 'PENDING_TASKS']);
        if (user.role === 'OPERATOR') query = query.eq('profile_id', user.id);
        const { data, error } = await query.order('assigned_at', { ascending: true });
        if (error) throw error;
        return successResponse({ assignments: data ?? [] });
      }

      if (action === 'assignment.claim' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan mengklaim assignment.', 403);
        }
        const body = await readJsonObject(request, ['work_date', 'shift_code', 'area_code', 'duty_role']);
        const workDate = body?.work_date ?? getWibDate();
        if (!body || !isIsoDate(workDate) || !['SIANG', 'MALAM', 'FULL'].includes(body.shift_code)
          || !['BAR', 'KITCHEN'].includes(body.area_code) || !['PRIMARY', 'HELPER'].includes(body.duty_role)) {
          return invalidPayload('Tanggal, shift, area, dan duty_role assignment wajib valid.');
        }
        const { data: rpcRes, error: rpcErr } = await db.rpc('rpc_claim_assignment', {
          p_outlet_id: outletId,
          p_work_date: workDate,
          p_shift_code: body.shift_code,
          p_area_code: body.area_code,
          p_profile_id: user.id,
          p_duty_role: body.duty_role,
        });
        if (rpcErr) return rpcErrorResponse(rpcErr);
        if (!rpcRes?.assignment_id || !rpcRes?.cycle_id) return invalidRpcResult();

        const { data: assignment, error: assignmentError } = await db.from('work_assignments').select('*, work_cycles!inner(outlet_id)').eq('id', rpcRes.assignment_id).eq('work_cycles.outlet_id', outletId).single();
        if (assignmentError) throw assignmentError;
        const { data: cycle, error: cycleError } = await db.from('work_cycles').select('*').eq('id', rpcRes.cycle_id).eq('outlet_id', outletId).single();
        if (cycleError) throw cycleError;
        return successResponse({ assignment, cycle });
      }

      if (action === 'assignment.reset' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh me-reset penugasan.', 403);
        }
        const body = await readJsonObject(request, ['assignment_id', 'expected_version', 'reason']);
        if (!body || !isUuid(body.assignment_id) || !isPositiveInteger(body.expected_version)
          || !isNonEmptyString(body.reason, 1000)) {
          return invalidPayload('assignment_id, expected_version, dan reason wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_reset_assignment', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_assignment_id: body.assignment_id,
          p_expected_assignment_version: body.expected_version,
          p_reason: body.reason,
        });
        if (error) return rpcErrorResponse(error);
        if (!data?.id) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'assignment.complete' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan menyelesaikan assignment.', 403);
        const body = await readJsonObject(request, ['assignment_id', 'expected_version']);
        if (!body || !isUuid(body.assignment_id) || !isPositiveInteger(body.expected_version)) {
          return invalidPayload('assignment_id UUID dan expected_version integer positif wajib diisi.');
        }
        const { data, error } = await db.rpc('rpc_complete_assignment', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_assignment_id: body.assignment_id,
          p_expected_assignment_version: body.expected_version,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.id !== body.assignment_id || data.status !== 'COMPLETED'
          || data.version !== body.expected_version + 1 || typeof data.cycle_completed !== 'boolean') return invalidRpcResult();
        return successResponse(data, data.version);
      }

      // 7. ATTENDANCE
      if (action === 'attendance.challenge' && request.method === 'POST') {
        const body = await readJsonObject(request, ['action']);
        if (!body) return invalidPayload();
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan melakukan absensi.', 403);
        }
        if (!authContext.deviceId) {
          return errorResponse('DEVICE_REQUIRED', 'Session attendance harus terikat ke device aktif.', 403);
        }
        if (body.action !== 'CHECK_IN' && body.action !== 'CHECK_OUT') {
          return errorResponse('VALIDATION_FAILED', 'Action challenge harus CHECK_IN atau CHECK_OUT.', 400);
        }

        const nonce = crypto.randomUUID();
        const { data: challenge, error } = await db.rpc('rpc_create_attendance_challenge', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_session_id: authContext.sessionId,
          p_device_id: authContext.deviceId,
          p_action: body.action,
          p_nonce_hash: await hashSessionToken(nonce),
        });
        if (error) return rpcErrorResponse(error);
        if (!challenge?.challenge_id) return invalidRpcResult();

        return successResponse({
          challengeId: `${challenge.challenge_id}.${nonce}`,
          nonce,
        });
      }

      if ((action === 'attendance.checkIn' || action === 'attendance.checkOut') && request.method === 'POST') {
        const eventType = action === 'attendance.checkIn' ? 'CHECK_IN' : 'CHECK_OUT';
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan melakukan absensi.', 403);
        }
        if (!authContext.deviceId) {
          return errorResponse('DEVICE_REQUIRED', 'Session attendance harus terikat ke device aktif.', 403);
        }

        const body = await readJsonObject(request, [
          'challengeId', 'nonce', 'assignmentId', 'assignment_id',
          'idempotencyKey', 'idempotency_key', 'samples',
          'location_failure', 'locationFailure', 'note',
        ]);
        if (!body) return invalidPayload();
        const binding = attendanceChallengeBinding(body);
        if (!binding) {
          return errorResponse('VALIDATION_FAILED', 'Challenge dan nonce absensi wajib valid.', 400);
        }
        const assignmentId = body.assignmentId ?? body.assignment_id ?? null;
        if (eventType === 'CHECK_IN' && !isUuid(assignmentId)) {
          return errorResponse('VALIDATION_FAILED', 'assignmentId wajib berupa UUID untuk check-in.', 400);
        }
        const suppliedIdempotencyKey = body.idempotencyKey ?? body.idempotency_key;
        if (!isUuid(suppliedIdempotencyKey)) {
          return errorResponse('VALIDATION_FAILED', 'idempotencyKey wajib berupa UUID.', 400);
        }

        const sampledAt = new Date().toISOString();
        const samples = Array.isArray(body.samples)
          ? body.samples.map((sample: any) => ({
              latitude: sample?.latitude,
              longitude: sample?.longitude,
              accuracy_m: sample?.accuracy_m ?? sample?.accuracy,
              client_sampled_at: sampledAt,
            }))
          : [];
        const requestedFailure = body.location_failure ?? body.locationFailure;
        const locationFailure = samples.length === 0
          ? (['DENIED', 'TIMEOUT', 'UNAVAILABLE'].includes(requestedFailure) ? requestedFailure : 'UNAVAILABLE')
          : null;

        const { data: result, error } = await db.rpc('rpc_record_attendance_event', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_session_id: authContext.sessionId,
          p_device_id: authContext.deviceId,
          p_challenge_id: binding.challengeId,
          p_action: eventType,
          p_nonce_hash: await hashSessionToken(binding.nonce),
          p_idempotency_key: suppliedIdempotencyKey,
          p_assignment_id: eventType === 'CHECK_IN' ? assignmentId : null,
          p_samples: samples,
          p_location_failure: locationFailure,
          p_note: typeof body.note === 'string' ? body.note : null,
          p_ip_country: requestCountry(request),
        });
        if (error) return rpcErrorResponse(error);
        if (!result?.attendance || !result?.event) return invalidRpcResult();

        return successResponse(eventType === 'CHECK_IN' ? result : { ok: true, ...result });
      }

      if (action === 'attendance.exceptions' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh melihat exception attendance.', 403);
        }
        const from = url.searchParams.get('from') || `${getWibDate().slice(0, 8)}01`;
        const to = url.searchParams.get('to') || getWibDate();
        if (!isIsoDate(from) || !isIsoDate(to) || from > to
          || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * 86_400_000) {
          return errorResponse('VALIDATION_FAILED', 'Rentang tanggal exception wajib valid dan maksimal 367 hari.', 400);
        }
        let query = db
          .from('attendance_records')
          .select(`
            id, work_date, profile_id, roster_entry_id, work_assignment_id, status,
            scheduled_start_at, scheduled_end_at, check_in_event_id, check_out_event_id,
            lateness_status, exception_status, version, created_at, updated_at,
            profiles!inner(display_name, role),
            work_assignments(schedule_deviation),
            attendance_events(id, event_type, server_occurred_at, client_occurred_at, location_status, selected_distance_m, selected_accuracy_m, risk_score, risk_reasons, note),
            attendance_corrections(id, correction_type, proposed_json, reason, requested_by, status, reviewed_by, reviewed_at, review_note, created_at)
          `)
          .eq('outlet_id', outletId)
          .gte('work_date', from)
          .lte('work_date', to);
        if (user.role === 'SUPERVISOR') query = query.eq('profiles.role', 'OPERATOR');
        const { data, error } = await query.order('work_date', { ascending: false });
        if (error) throw error;
        const exceptions = (data ?? []).filter((attendance: any) =>
          attendance.lateness_status === 'LATE'
          || attendance.exception_status === 'PENDING_REVIEW'
          || attendance.exception_status === 'REJECTED'
          || attendance.status === 'REVIEW_REQUIRED'
          || attendance.status === 'MISSING_CHECKOUT'
          || attendance.work_assignments?.schedule_deviation === true
          || (attendance.attendance_corrections ?? []).some((correction: any) => correction.status === 'PENDING'),
        );
        return successResponse({ exceptions });
      }

      if (action === 'attendance.emergencyCheckout' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh melakukan emergency checkout.', 403);
        }
        const body = await readJsonObject(request, ['attendance_id', 'expected_attendance_version', 'idempotency_key', 'reason']);
        if (!body || !isUuid(body.attendance_id) || !isPositiveInteger(body.expected_attendance_version)
          || !isUuid(body.idempotency_key) || !isNonEmptyString(body.reason, 1000)) {
          return invalidPayload('attendance_id, expected_attendance_version, idempotency_key, dan reason wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_emergency_checkout', {
          p_actor_id: user.id,
          p_attendance_id: body.attendance_id,
          p_expected_attendance_version: body.expected_attendance_version,
          p_idempotency_key: body.idempotency_key,
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.attendance_id !== body.attendance_id || !isUuid(data.event_id)
          || data.status !== 'REVIEW_REQUIRED' || data.exception_status !== 'PENDING_REVIEW'
          || data.version !== body.expected_attendance_version + 1
          || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse(data, data.version);
      }

      // B05: self-service emergency checkout. Target diambil dari sesi server
      // (attendance milik sendiri); klien tidak mengirim attendance_id arbitrary.
      if (action === 'attendance.selfEmergencyCheckout' && request.method === 'POST') {
        if (user.role !== 'OPERATOR') {
          return errorResponse('FORBIDDEN', 'Check-out darurat mandiri hanya untuk Operator.', 403);
        }
        const body = await readJsonObject(request, ['expected_attendance_version', 'idempotency_key', 'reason']);
        if (!body || !isPositiveInteger(body.expected_attendance_version)
          || !isUuid(body.idempotency_key) || !isNonEmptyString(body.reason, 1000)) {
          return invalidPayload('expected_attendance_version, idempotency_key, dan reason wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_self_emergency_checkout', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_expected_attendance_version: body.expected_attendance_version,
          p_idempotency_key: body.idempotency_key,
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isUuid(data.attendance_id) || !isUuid(data.event_id)
          || data.status !== 'REVIEW_REQUIRED' || data.exception_status !== 'PENDING_REVIEW'
          // A replay returns the original committed version, not expected+1.
          || (!data.idempotent_replay && data.version !== body.expected_attendance_version + 1)
          || (data.idempotent_replay && data.version < body.expected_attendance_version)
          || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse(data, data.version);
      }

      if (action === 'attendance.correction.request' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan meminta koreksi attendance.', 403);
        const body = await readJsonObject(request, ['attendance_id', 'correction_type', 'proposed', 'reason']);
        const proposed = body?.proposed;
        const type = body?.correction_type;
        let validProposed = false;
        if (isObject(proposed) && Object.keys(proposed).length === 1) {
          if (type === 'CHECK_IN_TIME' || type === 'CHECK_OUT_TIME') validProposed = isTimestamp(proposed.occurred_at);
          else if (type === 'STATUS') validProposed = ['CHECKED_OUT', 'APPROVED'].includes(proposed.status);
          else if (type === 'LATENESS') validProposed = ['ON_TIME', 'LATE', 'EXCUSED'].includes(proposed.lateness_status);
          else if (type === 'EXCEPTION') validProposed = proposed.exception_status === 'RESOLVED';
        }
        if (!body || !isUuid(body.attendance_id)
          || !['CHECK_IN_TIME', 'CHECK_OUT_TIME', 'STATUS', 'LATENESS', 'EXCEPTION'].includes(type)
          || !validProposed || !isNonEmptyString(body.reason, 1000)) {
          return invalidPayload('Attendance, correction_type, proposed, dan reason wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_request_attendance_correction', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_attendance_id: body.attendance_id,
          p_correction_type: type,
          p_proposed: proposed,
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isUuid(data.id) || data.attendance_id !== body.attendance_id || data.status !== 'PENDING') return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'attendance.correction.review' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mereview koreksi attendance.', 403);
        }
        const body = await readJsonObject(request, ['correction_id', 'status', 'note']);
        if (!body || !isUuid(body.correction_id) || !['APPROVED', 'REJECTED'].includes(body.status)
          || !isNonEmptyString(body.note, 1000)) {
          return invalidPayload('correction_id, status, dan note wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_review_attendance_correction', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_correction_id: body.correction_id,
          p_status: body.status,
          p_note: body.note.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isObject(data.correction) || !isObject(data.attendance)
          || data.correction.id !== body.correction_id || data.correction.status !== body.status
          || data.attendance.id !== data.correction.attendance_id) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'leave.request' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan meminta leave.', 403);
        const body = await readJsonObject(request, ['profile_id', 'start_date', 'end_date', 'leave_type', 'reason']);
        const targetId = body?.profile_id ?? user.id;
        if (!body || !isUuid(targetId) || !isIsoDate(body.start_date) || !isIsoDate(body.end_date)
          || body.end_date < body.start_date
          || Date.parse(`${body.end_date}T00:00:00Z`) - Date.parse(`${body.start_date}T00:00:00Z`) > 366 * 86_400_000
          || !['SICK', 'OTHER', 'UNPAID', 'OTHER_EXCEPTION'].includes(body.leave_type)
          || !isNonEmptyString(body.reason, 1000)) {
          return invalidPayload('Profile, rentang tanggal, leave_type, dan reason wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_request_leave', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_target_id: targetId,
          p_start_date: body.start_date,
          p_end_date: body.end_date,
          p_leave_type: body.leave_type,
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isUuid(data.id) || data.outlet_id !== outletId
          || data.profile_id !== targetId || data.status !== 'PENDING') return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'leave.cancel' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan membatalkan leave.', 403);
        const body = await readJsonObject(request, ['leave_id']);
        if (!body || !isUuid(body.leave_id)) return invalidPayload('leave_id wajib berupa UUID.');
        const { data, error } = await db.rpc('rpc_cancel_leave', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_leave_id: body.leave_id,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.id !== body.leave_id || data.outlet_id !== outletId || data.status !== 'CANCELLED') return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'leave.review' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mereview leave.', 403);
        }
        const body = await readJsonObject(request, ['leave_id', 'status', 'note']);
        if (!body || !isUuid(body.leave_id) || !['APPROVED', 'REJECTED'].includes(body.status)
          || !isNonEmptyString(body.note, 1000)) {
          return invalidPayload('leave_id, status, dan note wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_review_leave', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_leave_id: body.leave_id,
          p_status: body.status,
          p_note: body.note.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.id !== body.leave_id || data.outlet_id !== outletId || data.status !== body.status) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'overtime.list' && request.method === 'GET') {
        if (!isOperationalRole(user.role)) return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan melihat overtime.', 403);
        const from = url.searchParams.get('from') || `${getWibDate().slice(0, 8)}01`;
        const to = url.searchParams.get('to') || getWibDate();
        const status = url.searchParams.get('status');
        if (!isIsoDate(from) || !isIsoDate(to) || from > to
          || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * 86_400_000
          || (status !== null && !['CANDIDATE', 'APPROVED', 'REJECTED'].includes(status))) {
          return errorResponse('VALIDATION_FAILED', 'Filter overtime tidak valid.', 400);
        }
        let query = db
          .from('overtime_claims')
          .select('*, attendance_records!inner(id, outlet_id, work_date, profile_id, status, exception_status, profiles!inner(display_name, role))')
          .eq('attendance_records.outlet_id', outletId)
          .gte('attendance_records.work_date', from)
          .lte('attendance_records.work_date', to);
        if (status) query = query.eq('status', status);
        if (user.role === 'OPERATOR') query = query.eq('attendance_records.profile_id', user.id);
        if (user.role === 'SUPERVISOR') query = query.eq('attendance_records.profiles.role', 'OPERATOR');
        const { data, error } = await query.order('created_at', { ascending: false }).limit(500);
        if (error) throw error;
        return successResponse({ overtime: data ?? [] });
      }

      if (action === 'overtime.review' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mereview overtime.', 403);
        }
        const body = await readJsonObject(request, ['claim_id', 'expected_version', 'status', 'reason']);
        if (!body || !isUuid(body.claim_id) || !isPositiveInteger(body.expected_version)
          || !['APPROVED', 'REJECTED'].includes(body.status) || !isNonEmptyString(body.reason, 1000)) {
          return invalidPayload('claim_id, expected_version, status, dan reason wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_review_overtime', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_claim_id: body.claim_id,
          p_expected_version: body.expected_version,
          p_status: body.status,
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.id !== body.claim_id || data.status !== body.status
          || data.version !== body.expected_version + 1) return invalidRpcResult();
        return successResponse(data, data.version);
      }

      // 8. STOCK CYCLES, OPENING, MOVEMENTS, HANDOVER, CLOSING
      if (action === 'cycle.get' && request.method === 'GET') {
        const cycleId = url.searchParams.get('cycle_id');
        if (!isUuid(cycleId)) return errorResponse('VALIDATION_FAILED', 'cycle_id wajib berupa UUID.', 400);

        const { data: cycle } = await db.from('work_cycles').select('*').eq('id', cycleId).eq('outlet_id', outletId).maybeSingle();
        if (!cycle) return errorResponse('NOT_FOUND', 'Cycle pada outlet ini tidak ditemukan.', 404);
        const { data: opening } = await db.from('stock_openings').select('*, stock_opening_lines(*)').eq('cycle_id', cycleId).maybeSingle();
        const { data: movements } = await db.from('stock_movements').select('*').eq('cycle_id', cycleId).order('server_occurred_at', { ascending: false });
        const { data: handover } = await db.from('stock_handovers').select('*, stock_handover_lines(*)').eq('cycle_id', cycleId).maybeSingle();
        const { data: closing } = await db.from('stock_closings').select('*, stock_closing_lines(*)').eq('cycle_id', cycleId).maybeSingle();
        const { data: items } = await db.from('items').select('*').eq('area_code', cycle.area_code).eq('active', true);

        let handoverWithProfile = handover;
        if (handover?.confirmed_by) {
          const { data: confirmer } = await db
            .from('profiles')
            .select('id, display_name')
            .eq('id', handover.confirmed_by)
            .maybeSingle();
          handoverWithProfile = {
            ...handover,
            confirmed_by_profile: confirmer ?? null,
          };
        }

        // A MALAM cycle has its own opening/closing records, while the
        // authoritative handover lives on the same-day SIANG cycle. Load that
        // area-scoped handover separately so staff can inspect the actual
        // source history before confirming the night opening. FULL cycles may
        // also display the same history when it already exists, but it is not
        // silently treated as the FULL opening source.
        let handoverReference = null;
        if (cycle.shift_code === 'MALAM' || cycle.shift_code === 'FULL') {
          let sourceHandoverId = opening?.reference_source_type === 'HANDOVER'
            ? opening.reference_source_id
            : null;
          let sourceCycle = null;

          if (!sourceHandoverId) {
            const { data: sourceCycles } = await db
              .from('work_cycles')
              .select('id, work_date, shift_code, area_code, status')
              .eq('outlet_id', outletId)
              .eq('work_date', cycle.work_date)
              .eq('shift_code', 'SIANG')
              .eq('area_code', cycle.area_code)
              .limit(1);
            const sourceCycleId = sourceCycles?.[0]?.id;
            if (sourceCycleId) {
              const { data: sourceRows } = await db
                .from('stock_handovers')
                .select('id')
                .eq('cycle_id', sourceCycleId)
                .eq('status', 'CONFIRMED')
                .order('confirmed_at', { ascending: false })
                .limit(1);
              sourceHandoverId = sourceRows?.[0]?.id ?? null;
            }
          }

          if (sourceHandoverId) {
            const { data: sourceHandover } = await db
              .from('stock_handovers')
              .select('*, stock_handover_lines(*)')
              .eq('id', sourceHandoverId)
              .maybeSingle();
            if (sourceHandover) {
              const { data: sourceCycleRow } = await db
                .from('work_cycles')
                .select('id, work_date, shift_code, area_code, status')
                .eq('id', sourceHandover.cycle_id)
                .eq('outlet_id', outletId)
                .maybeSingle();
              sourceCycle = sourceCycleRow ?? null;
              if (sourceCycle?.area_code === cycle.area_code && sourceCycle?.shift_code === 'SIANG') {
                const { data: sourceMovements } = await db
                  .from('stock_movements')
                  .select('*')
                  .eq('cycle_id', sourceHandover.cycle_id)
                  .lte('server_occurred_at', sourceHandover.movement_cutoff_at)
                  .order('server_occurred_at', { ascending: false });
                let confirmer = null;
                if (sourceHandover.confirmed_by) {
                  const { data: confirmerRow } = await db
                    .from('profiles')
                    .select('id, display_name')
                    .eq('id', sourceHandover.confirmed_by)
                    .maybeSingle();
                  confirmer = confirmerRow ?? null;
                }
                handoverReference = {
                  ...sourceHandover,
                  confirmed_by_profile: confirmer,
                  source_cycle: sourceCycle,
                  movements: sourceMovements ?? [],
                };
              }
            }
          }
        }

        const handoverMovementRows = handoverReference?.movements ?? movements ?? [];
        const handoverForCount = handoverReference ?? handoverWithProfile;
        const handoverMovementCount = handoverForCount?.movement_cutoff_at
          ? handoverMovementRows.filter((movement: any) => movement.server_occurred_at
            && Date.parse(movement.server_occurred_at) <= Date.parse(handoverForCount.movement_cutoff_at)).length
          : 0;

        return successResponse({
          cycle,
          opening,
          movements: movements ?? [],
          handover: handoverWithProfile,
          handover_reference: handoverReference,
          handover_movement_count: handoverMovementCount,
          closing,
          items: items ?? [],
        });
      }

      if (action === 'management.stock.readiness' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Owner & Supervisor yang dapat mengelola stok.', 403);
        }
        const workDate = url.searchParams.get('date') || getWibDate();
        if (!isIsoDate(workDate)) return invalidPayload('date wajib berformat YYYY-MM-DD.');
        const { data, error } = await db.rpc('rpc_get_management_stock_readiness', {
          p_actor_id: user.id, p_outlet_id: outletId, p_work_date: workDate,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.work_date !== workDate || !Array.isArray(data.cycles)) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'cycle.baseline' && request.method === 'GET') {
        const cycleId = url.searchParams.get('cycle_id');
        if (!isUuid(cycleId)) return invalidPayload('cycle_id UUID wajib diisi.');
        const { data, error } = await db.rpc('rpc_get_cycle_physical_baseline', {
          p_actor_id: user.id, p_outlet_id: outletId, p_cycle_id: cycleId,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.cycle_id !== cycleId
          || !['AVAILABLE', 'REQUIRED', 'PENDING_REVIEW'].includes(data.state)
          || !Array.isArray(data.lines)) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'cycle.baseline.record' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan merekam baseline fisik cycle.', 403);
        }
        const body = await readJsonObject(request, ['cycle_id', 'expected_version', 'lines', 'reason', 'idempotency_key']);
        if (!body || !isUuid(body.cycle_id) || !isPositiveInteger(body.expected_version)
          || !isPhysicalBaselineLines(body.lines) || !isNonEmptyString(body.reason, 1000)
          || !isUuid(body.idempotency_key)) {
          return invalidPayload('cycle_id, expected_version, lines physical, reason, dan idempotency_key wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_record_cycle_physical_baseline', {
          p_actor_id: user.id, p_outlet_id: outletId, p_cycle_id: body.cycle_id,
          p_expected_version: body.expected_version, p_lines: body.lines,
          p_reason: body.reason.trim(), p_idempotency_key: body.idempotency_key,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.cycle_id !== body.cycle_id || !isPositiveInteger(data.version)
          || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse(data, data.version);
      }

      if (action === 'cycle.baseline.correct' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Owner & Supervisor yang dapat mengoreksi baseline fisik.', 403);
        }
        const body = await readJsonObject(request, ['cycle_id', 'expected_version', 'lines', 'reason', 'idempotency_key']);
        if (!body || !isUuid(body.cycle_id) || !isPositiveInteger(body.expected_version)
          || !isPhysicalBaselineLines(body.lines) || !isNonEmptyString(body.reason, 1000)
          || !isUuid(body.idempotency_key)) {
          return invalidPayload('cycle_id, expected_version, lines physical, reason, dan idempotency_key wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_correct_cycle_physical_baseline', {
          p_actor_id: user.id, p_outlet_id: outletId, p_cycle_id: body.cycle_id,
          p_expected_version: body.expected_version, p_lines: body.lines,
          p_reason: body.reason.trim(), p_idempotency_key: body.idempotency_key,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.cycle_id !== body.cycle_id || !isPositiveInteger(data.version)
          || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse(data, data.version);
      }

      if (action === 'stock.drafts' && request.method === 'GET') {
        const cycleId = url.searchParams.get('cycle_id');
        if (!isUuid(cycleId)) return invalidPayload('cycle_id UUID wajib diisi.');
        const { data, error } = await db.rpc('rpc_get_stock_drafts', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_cycle_id: cycleId,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !hasOnlyKeys(data, ['opening_draft', 'closing_draft'])) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'opening.reference' && request.method === 'GET') {
        const cycleId = url.searchParams.get('cycle_id');
        if (!isUuid(cycleId)) return invalidPayload('cycle_id UUID wajib diisi.');
        const { data, error } = await db.rpc('rpc_get_opening_reference', {
          p_cycle_id: cycleId,
          p_actor_id: user.id,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !['AVAILABLE', 'INITIALIZATION_REQUIRED'].includes(data.state)
          || !Array.isArray(data.lines)) return invalidRpcResult();
        return successResponse(data);
      }


      if (action === 'opening.saveDraft' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan menyimpan draft opening.', 403);
        const body = await readJsonObject(request, ['cycle_id', 'expected_version', 'idempotency_key', 'lines']);
        const expectedVersion = body?.expected_version ?? null;
        if (!body || !isUuid(body.cycle_id)
          || (expectedVersion !== null && !isPositiveInteger(expectedVersion))
          || !isUuid(body.idempotency_key) || !isDraftLines(body.lines)) {
          return invalidPayload('cycle_id, expected_version, idempotency_key, dan lines draft opening wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_save_opening_draft', {
          p_actor_id: user.id,
          p_cycle_id: body.cycle_id,
          p_expected_version: expectedVersion,
          p_idempotency_key: body.idempotency_key,
          p_lines: body.lines,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isUuid(data.draft_id) || data.cycle_id !== body.cycle_id
          || data.owner_id !== user.id || data.version !== (expectedVersion === null ? 1 : expectedVersion + 1)
          || data.line_count !== body.lines.length || !isTimestamp(data.updated_at)
          || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse(data, data.version);
      }

      if (action === 'opening.confirm' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan mengonfirmasi opening.', 403);
        }
        const body = await readJsonObject(request, ['cycle_id', 'lines']);
        if (!body || !isUuid(body.cycle_id) || !isSnapshotLines(body.lines)) {
          return invalidPayload('cycle_id UUID dan snapshot physical opening lengkap wajib diisi.');
        }

        const { data: opening, error } = await db.rpc('rpc_confirm_opening', {
          p_cycle_id: body.cycle_id,
          p_actor_id: user.id,
          p_lines: snapshotLines(body.lines),
        });
        if (error) return rpcErrorResponse(error);
        if (!opening?.opening_id) return invalidRpcResult();
        return successResponse({ opening });
      }

      if (action === 'movement.create' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan mencatat movement.', 403);
        }
        const body = await readJsonObject(request, [
          'cycle_id', 'expected_version', 'idempotency_key', 'client_occurred_at',
          'item_id', 'direction', 'category', 'quantity', 'correction_of_id', 'correction_reason',
        ]);
        if (!body) return invalidPayload();
        if (!isUuid(body.idempotency_key) || !Number.isInteger(body.expected_version) || body.expected_version <= 0) {
          return errorResponse('VALIDATION_FAILED', 'idempotency_key UUID dan expected_version integer positif wajib diisi.', 400);
        }
        if (typeof body.client_occurred_at !== 'string'
          || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(body.client_occurred_at)
          || !Number.isFinite(Date.parse(body.client_occurred_at))) {
          return errorResponse('VALIDATION_FAILED', 'client_occurred_at wajib berupa timestamp valid.', 400);
        }
        const { data: scopedCycle } = await db.from('work_cycles').select('id').eq('id', body.cycle_id).eq('outlet_id', outletId).maybeSingle();
        if (!scopedCycle) return errorResponse('NOT_FOUND', 'Cycle pada outlet ini tidak ditemukan.', 404);
        const { data: movement, error } = await db.rpc('rpc_create_stock_movement', {
          p_cycle_id: body.cycle_id,
          p_actor_id: user.id,
          p_expected_cycle_version: body.expected_version,
          p_item_id: body.item_id,
          p_direction: body.direction,
          p_category: body.category,
          p_quantity: body.quantity,
          p_client_occurred_at: body.client_occurred_at,
          p_idempotency_key: body.idempotency_key,
          p_correction_of_id: body.correction_of_id || null,
          p_correction_reason: body.correction_reason || null,
        });
        if (error) return rpcErrorResponse(error);
        if (!movement?.id || !Number.isInteger(movement.cycle_version)) return invalidRpcResult();
        return successResponse({ movement }, movement.cycle_version);
      }

      if (action === 'movement.correct' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan mengoreksi movement.', 403);
        const body = await readJsonObject(request, [
          'cycle_id', 'expected_version', 'original_movement_id', 'direction',
          'category', 'quantity', 'idempotency_key', 'reason',
        ]);
        const validCategory = body?.direction === 'IN'
          ? ['PURCHASE', 'RETURN_IN', 'TRANSFER_IN'].includes(body?.category)
          : body?.direction === 'OUT' && ['USAGE', 'INTERNAL', 'TRANSFER_OUT', 'WASTE'].includes(body?.category);
        if (!body || !isUuid(body.cycle_id) || !isPositiveInteger(body.expected_version)
          || !isUuid(body.original_movement_id) || !['IN', 'OUT'].includes(body.direction)
          || !validCategory || !isQuantity(body.quantity) || !isUuid(body.idempotency_key)
          || !isNonEmptyString(body.reason, 1000)) {
          return invalidPayload('Cycle, version, movement asal, arah, kategori, quantity, key, dan reason wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_correct_stock_movement', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_cycle_id: body.cycle_id,
          p_expected_cycle_version: body.expected_version,
          p_original_movement_id: body.original_movement_id,
          p_direction: body.direction,
          p_category: body.category,
          p_quantity: body.quantity,
          p_idempotency_key: body.idempotency_key,
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isUuid(data.id) || data.cycle_id !== body.cycle_id
          || data.correction_of_id !== body.original_movement_id || !isPositiveInteger(data.cycle_version)
          || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse({ movement: data }, data.cycle_version);
      }

      if (action === 'handover.complete' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan menyelesaikan handover.', 403);
        }
        const body = await readJsonObject(request, ['cycle_id']);
        if (!body) return invalidPayload();
        if (!body.cycle_id) return errorResponse('VALIDATION_FAILED', 'cycle_id diperlukan.', 400);

        const { data: handover, error } = await db.rpc('rpc_complete_handover', {
          p_cycle_id: body.cycle_id,
          p_actor_id: user.id,
        });
        if (error) return rpcErrorResponse(error);
        if (!handover?.handover_id) return invalidRpcResult();
        return successResponse({ handover });
      }

      if (action === 'closing.saveDraft' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan menyimpan draft closing.', 403);
        const body = await readJsonObject(request, ['cycle_id', 'expected_version', 'idempotency_key', 'lines']);
        const expectedVersion = body?.expected_version ?? null;
        if (!body || !isUuid(body.cycle_id)
          || (expectedVersion !== null && !isPositiveInteger(expectedVersion))
          || !isUuid(body.idempotency_key) || !isDraftLines(body.lines)) {
          return invalidPayload('cycle_id, expected_version, idempotency_key, dan lines draft closing wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_save_closing_draft', {
          p_actor_id: user.id,
          p_cycle_id: body.cycle_id,
          p_expected_version: expectedVersion,
          p_idempotency_key: body.idempotency_key,
          p_lines: body.lines,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isUuid(data.draft_id) || data.cycle_id !== body.cycle_id
          || data.owner_id !== user.id || data.version !== (expectedVersion === null ? 1 : expectedVersion + 1)
          || data.line_count !== body.lines.length || !isTimestamp(data.updated_at)
          || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse(data, data.version);
      }

      if (action === 'closing.confirm' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan mengonfirmasi closing.', 403);
        }
        const body = await readJsonObject(request, ['cycle_id', 'lines']);
        if (!body || !isUuid(body.cycle_id) || !isSnapshotLines(body.lines)) {
          return invalidPayload('cycle_id UUID dan snapshot physical closing lengkap wajib diisi.');
        }

        const { data: closing, error } = await db.rpc('rpc_confirm_closing', {
          p_cycle_id: body.cycle_id,
          p_actor_id: user.id,
          p_lines: snapshotLines(body.lines),
        });
        if (error) return rpcErrorResponse(error);
        if (!closing?.closing_id) return invalidRpcResult();
        return successResponse({ closing });
      }

      // 9. DAILY REPORTS & FINANCE (VALIDATING BOTH BAR & KITCHEN READY)
      if (action === 'report.get' && request.method === 'GET') {
        const workDate = url.searchParams.get('date') || getWibDate();
        if (!isIsoDate(workDate)) return errorResponse('VALIDATION_FAILED', 'date wajib berupa tanggal ISO.', 400);
        const { data, error } = await db.rpc('rpc_get_report', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_work_date: workDate,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !hasOnlyKeys(data, ['report', 'revision', 'finance', 'stock_lines', 'finance_draft'])
          || (data.report !== null && !isObject(data.report))
          || (data.revision !== null && !isObject(data.revision))
          || (data.finance !== null && !isObject(data.finance))
          || !Array.isArray(data.stock_lines)
          || (data.finance_draft !== null && !isObject(data.finance_draft))) return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'report.finance.save' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan menyimpan finance laporan.', 403);
        const body = await readJsonObject(request, ['work_date', 'expected_version', 'idempotency_key', 'finance']);
        const expectedVersion = body?.expected_version ?? null;
        const finance = body?.finance;
        if (!body || !isIsoDate(body.work_date)
          || (expectedVersion !== null && !isPositiveInteger(expectedVersion))
          || !isUuid(body.idempotency_key) || !isObject(finance)
          || !hasOnlyKeys(finance, ['cash_real', 'cash_app', 'qris_mandiri', 'debit_mandiri'])
          || Object.keys(finance).length !== 4
          || !isWholeAmount(finance.cash_real) || !isWholeAmount(finance.cash_app)
          || !isWholeAmount(finance.qris_mandiri) || !isWholeAmount(finance.debit_mandiri)) {
          return invalidPayload('work_date, expected_version, idempotency_key, dan empat nilai finance whole nonnegative wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_save_report_finance', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_work_date: body.work_date,
          p_expected_version: expectedVersion,
          p_idempotency_key: body.idempotency_key,
          p_finance: finance,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isUuid(data.draft_id) || data.outlet_id !== outletId
          || data.work_date !== body.work_date || data.owner_id !== user.id
          || data.version !== (expectedVersion === null ? 1 : expectedVersion + 1)
          || !isTimestamp(data.updated_at) || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse(data, data.version);
      }

      if (action === 'report.share' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh membagikan laporan.', 403);
        }
        const body = await readJsonObject(request, [
          'revision_id', 'expected_report_version', 'recipient_id', 'reason', 'idempotency_key',
        ]);
        if (!body || !isUuid(body.revision_id) || !isPositiveInteger(body.expected_report_version)
          || !isUuid(body.recipient_id) || body.recipient_id === user.id
          || !isOptionalString(body.reason, 1000) || !isUuid(body.idempotency_key)) {
          return invalidPayload('revision_id, expected_report_version, recipient_id, reason, dan idempotency_key wajib valid.');
        }
        const reason = body.reason?.trim() || null;
        const { data, error } = await db.rpc('rpc_share_report', {
          p_actor_id: user.id,
          p_revision_id: body.revision_id,
          p_expected_report_version: body.expected_report_version,
          p_recipient_id: body.recipient_id,
          p_reason: reason,
          p_idempotency_key: body.idempotency_key,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isUuid(data.share_id) || data.revision_id !== body.revision_id
          || data.recipient_id !== body.recipient_id || !isTimestamp(data.shared_at)
          || typeof data.already_shared !== 'boolean' || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'report.submit' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan mengirim laporan harian.', 403);
        }
        const body = await readJsonObject(request, ['work_date', 'finance']);
        if (!body) return invalidPayload();
        const workDate = body.work_date || getWibDate();
        const finance = {
          cash_real: body.finance?.cash_real,
          cash_app: body.finance?.cash_app,
          qris_mandiri: body.finance?.qris_mandiri,
          debit_mandiri: body.finance?.debit_mandiri,
        };
        const checksum = await sha256Buffer(new TextEncoder().encode(JSON.stringify({ outletId, workDate, finance })));

        const { data: rpcRes, error: rpcErr } = await db.rpc('rpc_submit_daily_report', {
          p_outlet_id: outletId,
          p_work_date: workDate,
          p_actor_id: user.id,
          p_finance: finance,
          p_checksum: checksum,
        });
        if (rpcErr) return rpcErrorResponse(rpcErr);
        if (!rpcRes?.report_id || !rpcRes?.revision_id || rpcRes.status !== 'SUBMITTED') return invalidRpcResult();
        return successResponse(rpcRes);
      }

      if (action === 'report.review' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang berhak mereview laporan harian.', 403);
        }
        const body = await readJsonObject(request, ['revision_id', 'status', 'note']);
        if (!body) return invalidPayload();
        if (!body.revision_id || !body.status) {
          return errorResponse('VALIDATION_FAILED', 'revision_id dan status wajib diisi.', 400);
        }
        if (body.status !== 'APPROVED' && body.status !== 'NEEDS_CLARIFICATION') {
          return errorResponse('INVALID_REVIEW_STATUS', 'Status review harus APPROVED atau NEEDS_CLARIFICATION.', 400);
        }

        const { data: rpcRes, error: rpcErr } = await db.rpc('rpc_review_daily_report', {
          p_revision_id: body.revision_id,
          p_actor_id: user.id,
          p_status: body.status,
          p_note: body.note || null,
        });
        if (rpcErr) return rpcErrorResponse(rpcErr);
        if (!rpcRes?.revision_id || rpcRes.status !== body.status) return invalidRpcResult();
        return successResponse(rpcRes);
      }

      // 10. BONUS OMZET (EQUAL SPLIT)
      if (action === 'bonus.finalize' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh memfinalisasi bonus.', 403);
        }
        const body = await readJsonObject(request, ['report_revision_id']);
        if (!body) return invalidPayload();
        if (!body.report_revision_id) {
          return errorResponse('VALIDATION_FAILED', 'report_revision_id diperlukan.', 400);
        }
        const { data: finance, error: financeError } = await db
          .from('daily_report_finance')
          .select('recorded_total, daily_report_revisions!inner(daily_reports!inner(outlet_id))')
          .eq('revision_id', body.report_revision_id)
          .eq('daily_report_revisions.daily_reports.outlet_id', outletId)
          .maybeSingle();
        if (financeError) throw financeError;
        if (!finance) return errorResponse('NOT_FOUND', 'Data finance laporan tidak ditemukan.', 404);

        const recordedTotal = Number(finance.recorded_total);
        let tierPercent = 0;
        if (recordedTotal >= 1200000) tierPercent = 7;
        else if (recordedTotal >= 1000000) tierPercent = 6;
        else if (recordedTotal >= 600000) tierPercent = 5;

        const { data: pool, error } = await db.rpc('rpc_finalize_daily_bonus', {
          p_revision_id: body.report_revision_id,
          p_actor_id: user.id,
          p_tier_percent: tierPercent,
        });
        if (error) return rpcErrorResponse(error);
        if (!pool?.pool_id || pool.status !== 'FINAL') return invalidRpcResult();
        return successResponse({ pool });
      }

      if (action === 'bonus.preview' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh melihat pratinjau bonus.', 403);
        }
        const workDate = url.searchParams.get('date') || getWibDate();
        const { data: report } = await db
          .from('daily_reports')
          .select('id, work_date, status, current_revision, daily_report_revisions(*, daily_report_finance(recorded_total))')
          .eq('outlet_id', outletId)
          .eq('work_date', workDate)
          .eq('status', 'APPROVED')
          .maybeSingle();
        if (!report) return successResponse({ report: null, pool: null, blockers: [] });

        const revision = (report.daily_report_revisions ?? []).find(
          (r: any) => r.revision === report.current_revision && r.status === 'APPROVED',
        );
        const recordedTotal = Number(revision?.daily_report_finance?.[0]?.recorded_total || 0);
        let tierPercent = 0;
        if (recordedTotal >= 1200000) tierPercent = 7;
        else if (recordedTotal >= 1000000) tierPercent = 6;
        else if (recordedTotal >= 600000) tierPercent = 5;
        const poolAmount = Math.floor(recordedTotal * tierPercent / 100);

        const { data: participants } = await db
          .from('work_assignments')
          .select('profile_id, work_cycles!inner(work_date, outlet_id)')
          .eq('work_cycles.outlet_id', outletId)
          .eq('work_cycles.work_date', workDate)
          .neq('status', 'RESET');
        const participantCount = new Set((participants ?? []).map((p: any) => p.profile_id)).size;

        const { data: existingPool } = await db
          .from('daily_bonus_pools')
          .select('id, status, pool_amount')
          .eq('report_revision_id', revision?.id ?? '00000000-0000-0000-0000-000000000000')
          .maybeSingle();

        return successResponse({
          report: { id: report.id, work_date: report.work_date, status: report.status },
          preview: { recorded_total: recordedTotal, tier_percent: tierPercent, pool_amount: poolAmount, participant_count: participantCount },
          pool: existingPool ?? null,
          blockers: [],
        });
      }

      if (action === 'attendance.mine' && request.method === 'GET') {
        const from = url.searchParams.get('from') || getWibDate().slice(0, 8) + '01';
        const { data } = await db
          .from('attendance_records')
          .select('id, work_date, status, lateness_status, exception_status, scheduled_start_at, scheduled_end_at, check_in_event_id, check_out_event_id')
          .eq('profile_id', user.id)
          .eq('outlet_id', outletId)
          .gte('work_date', from)
          .order('work_date', { ascending: false });
        return successResponse({ attendance: data ?? [] });
      }

      if (action === 'report.list' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh melihat daftar laporan.', 403);
        }
        const from = url.searchParams.get('from') || '';
        let q = db
          .from('daily_reports')
          .select('id, work_date, status, current_revision, updated_at')
          .eq('outlet_id', outletId);
        if (from) q = q.gte('work_date', from);
        const { data } = await q.order('work_date', { ascending: false }).limit(60);
        return successResponse({ reports: data ?? [] });
      }

      // 11. PAYROLL LIFECYCLE (PREVIEW, REVIEW, FINALIZE, PAID, VOID)
      if (action === 'payroll.get' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh melihat payroll.', 403);
        }
        const period = url.searchParams.get('period') || getWibDate().slice(0, 7);
        const { data: run, error: runError } = await db
          .from('payroll_runs')
          .select('*, compensation_policies(*)')
          .eq('outlet_id', outletId)
          .eq('period_month', period)
          .neq('status', 'VOID')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (runError) throw runError;

        let entries: any[] = [];
        let adjustments: any[] = [];
        if (run?.id) {
          const { data: entriesData, error: entriesError } = await db
            .from('payroll_entries')
            .select('*, profiles(display_name, job_title)')
            .eq('run_id', run.id)
            .order('profile_id');
          if (entriesError) throw entriesError;
          entries = entriesData ?? [];
          if (entries.length > 0) {
            const { data: adjustmentsData, error: adjustmentsError } = await db
              .from('payroll_adjustments')
              .select('*')
              .in('entry_id', entries.map(entry => entry.id))
              .order('created_at');
            if (adjustmentsError) throw adjustmentsError;
            adjustments = adjustmentsData ?? [];
          }
        }

        return successResponse({ run: run ?? null, entries, adjustments });
      }

      if (action === 'payroll.preview' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh membuat preview payroll.', 403);
        }
        const body = await readJsonObject(request, ['period_month', 'expected_version']);
        if (!body) return invalidPayload();
        const period = body.period_month || getWibDate().slice(0, 7);
        const expectedVersion = body.expected_version ? Number(body.expected_version) : null;

        const { data: result, error } = await db.rpc('rpc_preview_payroll', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_period_month: period,
          p_expected_run_version: expectedVersion,
        });
        if (error) return rpcErrorResponse(error);
        if (!result?.run_id) return invalidRpcResult();
        return successResponse(result);
      }

      if (action === 'payroll.entry.adjust' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mengajukan adjustment payroll.', 403);
        }
        const body = await readJsonObject(request, [
          'entry_id', 'expected_entry_version', 'adjustment_type', 'amount', 'reason', 'idempotency_key',
        ]);
        if (!body || !isUuid(body.entry_id) || !isPositiveInteger(body.expected_entry_version)
          || !isNonEmptyString(body.adjustment_type, 64) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(body.adjustment_type.trim())
          || !isWholeAmount(body.amount, true) || !isNonEmptyString(body.reason, 1000) || !isUuid(body.idempotency_key)) {
          return invalidPayload('entry_id, expected_entry_version, adjustment_type, amount, reason, dan idempotency_key wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_adjust_payroll_entry', {
          p_actor_id: user.id,
          p_entry_id: body.entry_id,
          p_expected_entry_version: body.expected_entry_version,
          p_adjustment_type: body.adjustment_type.trim(),
          p_amount: body.amount,
          p_reason: body.reason.trim(),
          p_idempotency_key: body.idempotency_key,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isUuid(data.adjustment_id) || data.entry_id !== body.entry_id || data.status !== 'PENDING'
          || data.version !== 1 || data.adjustment_type !== body.adjustment_type.trim() || data.amount !== body.amount
          || data.entry_version !== body.expected_entry_version + 1 || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse(data, data.entry_version);
      }

      if (action === 'payroll.adjustment.review' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mereview adjustment payroll.', 403);
        }
        const body = await readJsonObject(request, [
          'adjustment_id', 'expected_adjustment_version', 'expected_entry_version', 'status', 'note', 'idempotency_key',
        ]);
        if (!body || !isUuid(body.adjustment_id) || !isPositiveInteger(body.expected_adjustment_version)
          || !isPositiveInteger(body.expected_entry_version) || !['APPROVED', 'REJECTED'].includes(body.status)
          || !isNonEmptyString(body.note, 1000) || !isUuid(body.idempotency_key)) {
          return invalidPayload('adjustment_id, adjustment/entry version, status, note, dan idempotency_key wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_review_payroll_adjustment', {
          p_actor_id: user.id,
          p_adjustment_id: body.adjustment_id,
          p_expected_adjustment_version: body.expected_adjustment_version,
          p_expected_entry_version: body.expected_entry_version,
          p_status: body.status,
          p_note: body.note.trim(),
          p_idempotency_key: body.idempotency_key,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.adjustment_id !== body.adjustment_id || !isUuid(data.entry_id)
          || data.status !== body.status || data.version !== body.expected_adjustment_version + 1
          || typeof data.reviewed_at !== 'string' || data.entry_version !== body.expected_entry_version + 1
          || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse(data, data.entry_version);
      }

      if (action === 'payroll.review' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh me-review payroll.', 403);
        }
        const body = await readJsonObject(request, ['run_id', 'expected_version']);
        if (!body) return invalidPayload();
        if (!isUuid(body.run_id) || !Number.isInteger(body.expected_version) || body.expected_version <= 0) {
          return errorResponse('VALIDATION_FAILED', 'run_id UUID dan expected_version integer positif diperlukan.', 400);
        }

        const { data: result, error } = await db.rpc('rpc_review_payroll', {
          p_actor_id: user.id,
          p_run_id: body.run_id,
          p_expected_run_version: body.expected_version,
        });
        if (error) return rpcErrorResponse(error);
        if (!result?.run_id) return invalidRpcResult();
        return successResponse(result);
      }

      if (action === 'payroll.finalize' && request.method === 'POST') {
        if (user.role !== 'OWNER') {
          return errorResponse('FORBIDDEN', 'Hanya Owner yang boleh memfinalisasi payroll.', 403);
        }
        const body = await readJsonObject(request, ['run_id', 'expected_version']);
        if (!body) return invalidPayload();
        if (!isUuid(body.run_id) || !Number.isInteger(body.expected_version) || body.expected_version <= 0) {
          return errorResponse('VALIDATION_FAILED', 'run_id UUID dan expected_version integer positif diperlukan.', 400);
        }

        const { data: result, error } = await db.rpc('rpc_finalize_payroll', {
          p_actor_id: user.id,
          p_run_id: body.run_id,
          p_expected_run_version: body.expected_version,
        });
        if (error) return rpcErrorResponse(error);
        if (!result?.run_id) return invalidRpcResult();
        return successResponse(result);
      }

      if (action === 'payroll.markPaid' && request.method === 'POST') {
        if (user.role !== 'OWNER') {
          return errorResponse('FORBIDDEN', 'Hanya Owner yang boleh menandai payroll dibayar.', 403);
        }
        const body = await readJsonObject(request, ['run_id', 'expected_version', 'payment_reference', 'payment_reason']);
        if (!body) return invalidPayload();
        if (!isUuid(body.run_id) || !Number.isInteger(body.expected_version) || body.expected_version <= 0) {
          return errorResponse('VALIDATION_FAILED', 'run_id UUID dan expected_version integer positif diperlukan.', 400);
        }
        if (!body.payment_reference || !body.payment_reason) {
          return errorResponse('VALIDATION_FAILED', 'payment_reference dan payment_reason wajib diisi.', 400);
        }

        const { data: result, error } = await db.rpc('rpc_mark_payroll_paid', {
          p_actor_id: user.id,
          p_run_id: body.run_id,
          p_expected_run_version: body.expected_version,
          p_payment_reference: body.payment_reference,
          p_payment_reason: body.payment_reason,
        });
        if (error) return rpcErrorResponse(error);
        if (!result?.run_id) return invalidRpcResult();
        return successResponse(result);
      }

      if (action === 'payroll.void' && request.method === 'POST') {
        if (user.role !== 'OWNER') {
          return errorResponse('FORBIDDEN', 'Hanya Owner yang boleh membatalkan (VOID) payroll.', 403);
        }
        const body = await readJsonObject(request, ['run_id', 'expected_version', 'void_reason']);
        if (!body) return invalidPayload();
        if (!isUuid(body.run_id) || !Number.isInteger(body.expected_version) || body.expected_version <= 0) {
          return errorResponse('VALIDATION_FAILED', 'run_id UUID dan expected_version integer positif diperlukan.', 400);
        }
        if (!body.void_reason) {
          return errorResponse('VALIDATION_FAILED', 'void_reason wajib diisi.', 400);
        }

        const { data: result, error } = await db.rpc('rpc_void_payroll', {
          p_actor_id: user.id,
          p_run_id: body.run_id,
          p_expected_run_version: body.expected_version,
          p_void_reason: body.void_reason,
        });
        if (error) return rpcErrorResponse(error);
        if (!result?.run_id) return invalidRpcResult();
        return successResponse(result);
      }

      // 12. PAYROLL SNAPSHOT XLSX EXPORT
      if (action === 'payroll.export.xlsx' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mengekspor payroll.', 403);
        }
        const body = await readJsonObject(request, ['run_id', 'expected_version', 'idempotency_key']);
        if (!body || !isUuid(body.run_id) || !isPositiveInteger(body.expected_version) || !isUuid(body.idempotency_key)) {
          return invalidPayload('run_id, expected_version, dan idempotency_key UUID wajib diisi.');
        }

        const bucketName = process.env.PAYROLL_EXPORT_BUCKET;
        if (!bucketName) return errorResponse('PRIVATE_STORAGE_UNAVAILABLE', 'Bucket privat payroll belum dikonfigurasi.', 503);
        const { data: bucket, error: bucketError } = await db.storage.getBucket(bucketName);
        if (bucketError || !bucket || bucket.public) {
          return errorResponse('PRIVATE_STORAGE_UNAVAILABLE', 'Bucket payroll tidak tersedia atau tidak privat.', 503);
        }

        const { data: reservation, error: reservationError } = await db.rpc('rpc_reserve_payroll_export', {
          p_actor_id: user.id,
          p_run_id: body.run_id,
          p_expected_run_version: body.expected_version,
          p_idempotency_key: body.idempotency_key,
        });
        if (reservationError) return rpcErrorResponse(reservationError);
        if (!isObject(reservation) || !isUuid(reservation.reservation_id) || !isUuid(reservation.final_export_id)
          || !isNonEmptyString(reservation.file_path, 1024) || !isObject(reservation.evidence_json)
          || !isObject(reservation.row_counts) || !/^[a-f0-9]{64}$/.test(reservation.evidence_checksum_sha256)
          || !isTimestamp(reservation.created_at) || typeof reservation.idempotent_replay !== 'boolean'
          || typeof reservation.can_upload !== 'boolean'
          || !['IN_PROGRESS', 'UPLOAD_UNKNOWN', 'COMMITTED', 'ABANDONED'].includes(reservation.status)) {
          return invalidRpcResult();
        }

        const evidenceJson = reservation.evidence_json;
        const run = evidenceJson.run;
        const entries = evidenceJson.entries;
        const adjustments = evidenceJson.adjustments;
        const attendance = evidenceJson.attendance;
        const bonusRows = evidenceJson.bonusRows;
        const auditEvents = evidenceJson.auditEvents;
        if (!isObject(run) || run.id !== body.run_id || run.outlet_id !== outletId
          || run.version !== body.expected_version || !['REVIEWED', 'FINALIZED', 'PAID'].includes(run.status)
          || !isIsoMonth(run.period_month) || !Array.isArray(entries) || !Array.isArray(adjustments)
          || !Array.isArray(attendance) || !Array.isArray(bonusRows) || !Array.isArray(auditEvents)) {
          return invalidRpcResult();
        }
        try {
          canonicalJson(evidenceJson);
        } catch {
          return invalidRpcResult();
        }
        const expectedEntryStatus = run.status === 'REVIEWED' ? 'REVIEWED' : 'APPROVED';
        if (entries.length === 0 || entries.some((entry: any) =>
          !isObject(entry) || !isUuid(entry.id) || entry.run_id !== run.id || !isUuid(entry.profile_id)
          || entry.status !== expectedEntryStatus
          || ['base_amount', 'approved_overtime_amount', 'approved_shortage_amount', 'absence_deduction', 'bonus_amount', 'manual_adjustment_amount', 'final_gross']
            .some(field => !Number.isFinite(Number(entry[field]))))) {
          return errorResponse('EVIDENCE_MISSING', 'Evidence entry payroll tidak lengkap atau statusnya tidak sesuai.', 409);
        }

        const label = run.status === 'REVIEWED' ? 'DRAFT' : 'FINALIZED';
        const filename = `HOPIN-PAYROLL-${run.period_month}-${label}.xlsx`;
        if (reservation.status === 'COMMITTED') {
          if (!/^[a-f0-9]{64}$/.test(reservation.artifact_checksum_sha256)) return invalidRpcResult();
          return successResponse({
            export_id: reservation.final_export_id,
            reservation_id: reservation.reservation_id,
            filename,
            file_path: reservation.file_path,
            checksum: reservation.artifact_checksum_sha256,
            label,
            idempotent_replay: true,
          });
        }
        if (!reservation.can_upload) {
          const code = reservation.status === 'UPLOAD_UNKNOWN' ? 'EXPORT_UPLOAD_UNKNOWN'
            : reservation.status === 'ABANDONED' ? 'EXPORT_RETRY_REQUIRED' : 'EXPORT_IN_PROGRESS';
          return errorResponse(code, 'Export dengan idempotency key ini sedang diproses atau menunggu rekonsiliasi.', 409, {
            reservation_id: reservation.reservation_id,
            final_export_id: reservation.final_export_id,
            reservation_status: reservation.status,
          });
        }
        if (!isUuid(reservation.upload_token)) return invalidRpcResult();

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'HOPIN Operations Engine';
        workbook.created = new Date(reservation.created_at);
        workbook.modified = new Date(reservation.created_at);
        workbook.lastModifiedBy = 'HOPIN Operations Engine';

        const sSummary = workbook.addWorksheet('Summary');
        sSummary.columns = [
          { header: 'Employee ID', key: 'id', width: 36 },
          { header: 'Nama Lengkap', key: 'name', width: 24 },
          { header: 'Periode', key: 'period', width: 12 },
          { header: 'Gaji Pokok', key: 'base', width: 16 },
          { header: 'Lembur', key: 'overtime', width: 16 },
          { header: 'Kekurangan', key: 'shortage', width: 16 },
          { header: 'Potongan Absen', key: 'absence', width: 16 },
          { header: 'Bonus', key: 'bonus', width: 16 },
          { header: 'Penyesuaian', key: 'adjustment', width: 16 },
          { header: 'Total Final', key: 'gross', width: 18 },
          { header: 'Status', key: 'status', width: 14 },
        ];
        (entries ?? []).forEach((entry: any) => {
          sSummary.addRow({
            id: sanitizeExcelCell(entry.profile_id),
            name: sanitizeExcelCell(entry.profiles?.display_name),
            period: sanitizeExcelCell(run.period_month),
            base: Number(entry.base_amount),
            overtime: Number(entry.approved_overtime_amount),
            shortage: Number(entry.approved_shortage_amount),
            absence: Number(entry.absence_deduction),
            bonus: Number(entry.bonus_amount),
            adjustment: Number(entry.manual_adjustment_amount),
            gross: Number(entry.final_gross),
            status: sanitizeExcelCell(entry.status),
          });
        });

        const sAdj = workbook.addWorksheet('Adjustments');
        sAdj.columns = [
          { header: 'Payroll Entry ID', key: 'entry', width: 36 },
          { header: 'Tipe Penyesuaian', key: 'type', width: 20 },
          { header: 'Alasan', key: 'reason', width: 28 },
          { header: 'Jumlah (Rp)', key: 'amount', width: 18 },
          { header: 'Status', key: 'status', width: 14 },
        ];
        (adjustments ?? []).forEach((adj: any) => {
          sAdj.addRow({
            entry: sanitizeExcelCell(adj.entry_id),
            type: sanitizeExcelCell(adj.adjustment_type),
            reason: sanitizeExcelCell(adj.reason),
            amount: Number(adj.amount),
            status: sanitizeExcelCell(adj.status),
          });
        });

        // Exceptions sheet (late / review-required / missing-checkout in period).
        const sExc = workbook.addWorksheet('Exceptions');
        sExc.columns = [
          { header: 'Tanggal WIB', key: 'date', width: 12 },
          { header: 'Nama', key: 'name', width: 22 },
          { header: 'Jenis', key: 'type', width: 18 },
          { header: 'Status', key: 'status', width: 18 },
        ];
        (attendance ?? [])
          .filter((a: any) => a.lateness_status === 'LATE' || a.status === 'REVIEW_REQUIRED' || a.status === 'MISSING_CHECKOUT')
          .forEach((a: any) => {
            const type = a.status === 'REVIEW_REQUIRED' ? 'Review GPS' : a.status === 'MISSING_CHECKOUT' ? 'Missing Checkout' : 'Terlambat';
            sExc.addRow({
              date: sanitizeExcelCell(a.work_date),
              name: sanitizeExcelCell(a.profiles?.display_name),
              type: sanitizeExcelCell(type),
              status: sanitizeExcelCell(a.status),
            });
          });

        // Attendance sheet (period-scoped, no raw GPS coordinates).
        const sAtt = workbook.addWorksheet('Attendance');
        sAtt.columns = [
          { header: 'Tanggal WIB', key: 'date', width: 12 },
          { header: 'Nama', key: 'name', width: 22 },
          { header: 'Status', key: 'status', width: 16 },
          { header: 'Keterlambatan', key: 'late', width: 14 },
          { header: 'Lokasi', key: 'location', width: 12 },
        ];
        (attendance ?? []).forEach((a: any) => {
          const loc = (a.attendance_events ?? [])[0]?.location_status || '';
          sAtt.addRow({
            date: sanitizeExcelCell(a.work_date),
            name: sanitizeExcelCell(a.profiles?.display_name),
            status: sanitizeExcelCell(a.status),
            late: sanitizeExcelCell(a.lateness_status),
            location: sanitizeExcelCell(loc),
          });
        });

        // Overtime sheet (period attendance evidence statuses).
        const sOt = workbook.addWorksheet('Overtime');
        sOt.columns = [
          { header: 'Tanggal WIB', key: 'date', width: 12 },
          { header: 'Nama', key: 'name', width: 22 },
          { header: 'Status', key: 'status', width: 16 },
        ];
        (attendance ?? []).forEach((a: any) => {
          sOt.addRow({
            date: sanitizeExcelCell(a.work_date),
            name: sanitizeExcelCell(a.profiles?.display_name),
            status: sanitizeExcelCell(a.status),
          });
        });

        // Bonus sheet from period allocation pools (finalized amounts only).
        const sBon = workbook.addWorksheet('Bonus');
        sBon.columns = [
          { header: 'Tanggal', key: 'date', width: 12 },
          { header: 'Nama', key: 'name', width: 22 },
          { header: 'Alokasi (Rp)', key: 'amount', width: 16 },
          { header: 'Sisa (+1 Rp)', key: 'rem', width: 14 },
        ];
        (bonusRows ?? []).forEach((b: any) => {
          sBon.addRow({
            date: sanitizeExcelCell(run.period_month),
            name: sanitizeExcelCell(b.profiles?.display_name),
            amount: Number(b.amount),
            rem: b.remainder_awarded ? 'Ya' : 'Tidak',
          });
        });

        // Audit sheet (entity + action; no raw GPS/PIN/IP).
        const sAud = workbook.addWorksheet('Audit');
        sAud.columns = [
          { header: 'Waktu', key: 'time', width: 20 },
          { header: 'Aktor', key: 'actor', width: 22 },
          { header: 'Aksi', key: 'action', width: 24 },
          { header: 'Entity', key: 'entity', width: 20 },
          { header: 'Alasan', key: 'reason', width: 30 },
        ];
        (auditEvents ?? []).forEach((ev: any) => {
          sAud.addRow({
            time: sanitizeExcelCell(ev.server_occurred_at),
            actor: sanitizeExcelCell(ev.profiles?.display_name || 'System'),
            action: sanitizeExcelCell(ev.action),
            entity: sanitizeExcelCell(`${ev.entity_type}:${ev.entity_id}`),
            reason: sanitizeExcelCell(ev.reason || ''),
          });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const checksum = await sha256Buffer(buffer);
        const filePath = reservation.file_path;
        let uploadError: any = null;
        try {
          const uploadResult = await db.storage.from(bucketName).upload(filePath, buffer, {
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            upsert: false,
          });
          uploadError = uploadResult.error;
        } catch (error) {
          uploadError = error;
        }
        if (uploadError) {
          let uploadState: any = null;
          try {
            const reconcileResult = await db.rpc('rpc_reconcile_payroll_export', {
              p_actor_id: user.id,
              p_reservation_id: reservation.reservation_id,
              p_upload_token: reservation.upload_token,
              p_observed_state: 'UNKNOWN',
              p_artifact_checksum_sha256: checksum,
            });
            uploadState = reconcileResult.data;
          } catch (reconcileError) {
            console.error('Payroll export upload reconciliation failed:', reconcileError);
          }
          if (isObject(uploadState) && uploadState.status === 'COMMITTED'
            && uploadState.final_export_id === reservation.final_export_id
            && uploadState.artifact_checksum_sha256 === checksum) {
            return successResponse({
              export_id: uploadState.final_export_id,
              reservation_id: reservation.reservation_id,
              filename,
              file_path: filePath,
              checksum,
              label,
              idempotent_replay: true,
            });
          }
          return errorResponse('EXPORT_UPLOAD_UNKNOWN', 'Hasil upload tidak dapat dipastikan dan harus direkonsiliasi.', 503, {
            reservation_id: reservation.reservation_id,
            final_export_id: reservation.final_export_id,
            reservation_status: isObject(uploadState) ? uploadState.status : 'IN_PROGRESS',
          });
        }

        let exportResult: any = null;
        let exportError: any = null;
        try {
          const commitResult = await db.rpc('rpc_commit_payroll_export', {
            p_actor_id: user.id,
            p_reservation_id: reservation.reservation_id,
            p_upload_token: reservation.upload_token,
            p_artifact_checksum_sha256: checksum,
          });
          exportResult = commitResult.data;
          exportError = commitResult.error;
        } catch (error) {
          exportError = error;
        }
        if (exportError || !isObject(exportResult) || exportResult.export_id !== reservation.final_export_id
          || exportResult.checksum_sha256 !== checksum || typeof exportResult.idempotent_replay !== 'boolean') {
          let current: any = null;
          let currentError: any = null;
          try {
            const lookupResult = await db.rpc('rpc_get_payroll_export_reservation', {
              p_actor_id: user.id,
              p_reservation_id: reservation.reservation_id,
              p_idempotency_key: body.idempotency_key,
            });
            current = lookupResult.data;
            currentError = lookupResult.error;
          } catch (error) {
            currentError = error;
          }
          if (!currentError && isObject(current) && current.status === 'COMMITTED'
            && current.final_export_id === reservation.final_export_id
            && current.artifact_checksum_sha256 === checksum) {
            return successResponse({
              export_id: current.final_export_id,
              reservation_id: reservation.reservation_id,
              filename,
              file_path: filePath,
              checksum,
              label,
              idempotent_replay: true,
            });
          }
          let preservedStatus = isObject(current) && typeof current.status === 'string' ? current.status : 'UPLOAD_UNKNOWN';
          if (!isObject(current) || current.status === 'IN_PROGRESS') {
            try {
              const { data: reconciled } = await db.rpc('rpc_reconcile_payroll_export', {
                p_actor_id: user.id,
                p_reservation_id: reservation.reservation_id,
                p_upload_token: reservation.upload_token,
                p_observed_state: 'UNKNOWN',
                p_artifact_checksum_sha256: checksum,
              });
              if (isObject(reconciled) && reconciled.status === 'COMMITTED'
                && reconciled.final_export_id === reservation.final_export_id
                && reconciled.artifact_checksum_sha256 === checksum) {
                return successResponse({
                  export_id: reconciled.final_export_id,
                  reservation_id: reservation.reservation_id,
                  filename,
                  file_path: filePath,
                  checksum,
                  label,
                  idempotent_replay: true,
                });
              }
              if (isObject(reconciled) && typeof reconciled.status === 'string') preservedStatus = reconciled.status;
            } catch (reconcileError) {
              console.error('Payroll export commit reconciliation failed:', reconcileError);
            }
          }
          return errorResponse('EXPORT_COMMIT_UNKNOWN', 'Hasil commit export tidak dapat dipastikan dan harus direkonsiliasi.', 503, {
            reservation_id: reservation.reservation_id,
            final_export_id: reservation.final_export_id,
            reservation_status: preservedStatus,
          });
        }
        return successResponse({
          export_id: exportResult.export_id,
          reservation_id: reservation.reservation_id,
          filename,
          file_path: filePath,
          checksum,
          label,
          idempotent_replay: exportResult.idempotent_replay,
        });
      }

      if (action === 'payroll.export.download' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mengunduh export payroll.', 403);
        }
        const body = await readJsonObject(request, ['export_id', 'expected_run_version', 'idempotency_key']);
        if (!body || !isUuid(body.export_id) || !isPositiveInteger(body.expected_run_version) || !isUuid(body.idempotency_key)) {
          return invalidPayload('export_id, expected_run_version, dan idempotency_key wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_get_payroll_export_download', {
          p_actor_id: user.id,
          p_export_id: body.export_id,
          p_expected_run_version: body.expected_run_version,
          p_idempotency_key: body.idempotency_key,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || !isUuid(data.authorization_id) || data.export_id !== body.export_id
          || !isNonEmptyString(data.file_path, 1024) || !isNonEmptyString(data.format, 32)
          || !isNonEmptyString(data.checksum_sha256, 128) || typeof data.expires_at !== 'string'
          || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();

        const bucketName = process.env.PAYROLL_EXPORT_BUCKET;
        if (!bucketName) return errorResponse('PRIVATE_STORAGE_UNAVAILABLE', 'Bucket privat payroll belum dikonfigurasi.', 503);
        const { data: bucket, error: bucketError } = await db.storage.getBucket(bucketName);
        if (bucketError || !bucket || bucket.public) {
          return errorResponse('PRIVATE_STORAGE_UNAVAILABLE', 'Bucket payroll tidak tersedia atau tidak privat.', 503);
        }
        const { data: signed, error: signedError } = await db.storage.from(bucketName).createSignedUrl(data.file_path, 300);
        if (signedError || !signed?.signedUrl) {
          return errorResponse('EXPORT_STORAGE_FAILED', 'URL unduhan payroll tidak dapat dibuat.', 503);
        }
        return successResponse({
          authorization_id: data.authorization_id,
          export_id: data.export_id,
          format: data.format,
          checksum_sha256: data.checksum_sha256,
          expires_at: data.expires_at,
          url: signed.signedUrl,
          idempotent_replay: data.idempotent_replay,
        });
      }

      // 12. ONBOARDING
      if (action === 'onboarding.get' && request.method === 'GET') {
        if (user.role !== 'OPERATOR') return errorResponse('FORBIDDEN', 'Guided onboarding hanya untuk Operator.', 403);
        const { data, error } = await db.rpc('rpc_get_onboarding_state', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data)
          || !isPositiveInteger(data.onboarding_version)
          || (data.progress !== null && !isObject(data.progress))
          || typeof data.reset_required !== 'boolean'
          || typeof data.reset_deferred !== 'boolean'
          || (data.reset_requested_at !== null && typeof data.reset_requested_at !== 'string')) {
          return invalidRpcResult();
        }
        return successResponse(data);
      }

      if (action === 'onboarding.reset' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Owner atau Supervisor yang dapat mereset tutorial.', 403);
        }
        const body = await readJsonObject(request, ['profile_id', 'reason']);
        if (!body || !isUuid(body.profile_id) || !isNonEmptyString(body.reason, 1000)) {
          return invalidPayload('profile_id dan alasan reset wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_request_onboarding_reset', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_target_profile_id: body.profile_id,
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data)
          || !isUuid(data.reset_id)
          || data.profile_id !== body.profile_id
          || !isPositiveInteger(data.onboarding_version)
          || typeof data.requested_at !== 'string'
          || !['NEXT_BOOTSTRAP', 'AFTER_SHIFT'].includes(data.effective)) {
          return invalidRpcResult();
        }
        return successResponse(data);
      }

      if (action === 'onboarding.complete' && request.method === 'POST') {
        if (user.role !== 'OPERATOR') return errorResponse('FORBIDDEN', 'Guided onboarding hanya untuk Operator.', 403);
        const body = await readJsonObject(request, ['version']);
        if (!body || !isPositiveInteger(body.version)) {
          return invalidPayload('version onboarding wajib berupa integer positif.');
        }

        const { data, error } = await db.rpc('rpc_complete_onboarding', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_onboarding_version: body.version,
        });

        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.profile_id !== user.id
          || typeof data.completed_at !== 'string' || typeof data.idempotent_replay !== 'boolean') return invalidRpcResult();
        return successResponse(data);
      }

      if (action === 'onboarding.replay' && request.method === 'POST') {
        if (user.role !== 'OPERATOR') return errorResponse('FORBIDDEN', 'Replay onboarding hanya untuk Operator.', 403);
        const body = await readJsonObject(request, ['version']);
        if (!body || !isPositiveInteger(body.version)) return invalidPayload('version onboarding wajib berupa integer positif.');
        const { data, error } = await db.rpc('rpc_replay_onboarding', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_onboarding_version: body.version,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.profile_id !== user.id || data.onboarding_version !== body.version
          || !Number.isInteger(data.replay_count) || data.replay_count < 1) return invalidRpcResult();
        return successResponse(data);
      }

      // 13. USER MANAGEMENT (OWNER)
      if (action === 'users.list' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh melihat daftar user.', 403);
        }
        let query = db
          .from('profile_outlet_scopes')
          .select('profiles!inner(id, username, display_name, role, job_title, active, force_pin_change, deactivated_at, version)')
          .eq('outlet_id', outletId)
          .eq('active', true);
        if (user.role === 'SUPERVISOR') query = query.eq('profiles.role', 'OPERATOR');
        const { data, error } = await query;
        if (error) throw error;
        const baseUsers = (data ?? []).map((scope: any) => scope.profiles);
        const operatorIds = baseUsers.filter((profile: any) => profile?.role === 'OPERATOR').map((profile: any) => profile.id);
        const resetByProfile = new Map<string, any>();

        if (operatorIds.length > 0) {
          const { data: resetRows, error: resetError } = await db
            .from('onboarding_reset_events')
            .select('id, profile_id, requested_by, requested_at, deferred_until_assignment_id')
            .eq('outlet_id', outletId)
            .in('profile_id', operatorIds)
            .order('requested_at', { ascending: false })
            .order('id', { ascending: false });
          if (resetError) throw resetError;

          const latestRows = (resetRows ?? []).filter((row: any) => {
            if (resetByProfile.has(row.profile_id)) return false;
            resetByProfile.set(row.profile_id, row);
            return true;
          });

          const { data: activeAssignments, error: assignmentError } = await db
            .from('work_assignments')
            .select('profile_id, id, status, work_cycles!inner(outlet_id)')
            .eq('work_cycles.outlet_id', outletId)
            .in('profile_id', operatorIds)
            .in('status', ['ACTIVE', 'PENDING_TASKS']);
          if (assignmentError) throw assignmentError;
          const activeAssignmentProfiles = new Set((activeAssignments ?? []).map((row: any) => row.profile_id));

          const { data: activeAttendance, error: attendanceError } = await db
            .from('attendance_records')
            .select('profile_id')
            .eq('outlet_id', outletId)
            .in('profile_id', operatorIds)
            .not('check_in_event_id', 'is', null)
            .is('check_out_event_id', null);
          if (attendanceError) throw attendanceError;
          const activeAttendanceProfiles = new Set((activeAttendance ?? []).map((row: any) => row.profile_id));

          const { data: completionRows, error: completionError } = await db
            .from('onboarding_progress')
            .select('profile_id, completed_at')
            .in('profile_id', operatorIds)
            .not('completed_at', 'is', null)
            .order('completed_at', { ascending: false });
          if (completionError) throw completionError;
          const latestCompletionByProfile = new Map<string, string>();
          for (const completion of completionRows ?? []) {
            if (!latestCompletionByProfile.has(completion.profile_id)) {
              latestCompletionByProfile.set(completion.profile_id, completion.completed_at);
            }
          }

          const requesterIds = [...new Set(latestRows.map((row: any) => row.requested_by).filter(Boolean))];
          const requesterNames = new Map<string, string>();
          if (requesterIds.length > 0) {
            const { data: requesters, error: requesterError } = await db
              .from('profiles')
              .select('id, display_name')
              .in('id', requesterIds);
            if (requesterError) throw requesterError;
            for (const requester of requesters ?? []) requesterNames.set(requester.id, requester.display_name);
          }

          for (const [profileId, reset] of resetByProfile) {
            const completedAt = latestCompletionByProfile.get(profileId);
            const resetPending = !completedAt || new Date(reset.requested_at).getTime() > new Date(completedAt).getTime();
            resetByProfile.set(profileId, {
              id: reset.id,
              requested_at: reset.requested_at,
              requested_by: reset.requested_by,
              requested_by_name: requesterNames.get(reset.requested_by) ?? null,
              pending: resetPending,
              deferred: resetPending && (activeAssignmentProfiles.has(profileId) || activeAttendanceProfiles.has(profileId)),
              deferred_until_assignment_id: reset.deferred_until_assignment_id ?? null,
            });
          }
        }

        const users = baseUsers
          .map((profile: any) => ({
            ...profile,
            onboarding_reset: profile.role === 'OPERATOR' ? (resetByProfile.get(profile.id) ?? null) : null,
          }))
          .sort((a: any, b: any) => a.display_name.localeCompare(b.display_name));
        return successResponse({ users });
      }

      if (action === 'users.create' && request.method === 'POST') {
        if (user.role !== 'OWNER') return errorResponse('FORBIDDEN', 'Hanya Owner yang boleh membuat user baru.', 403);
        const body = await readJsonObject(request, ['username', 'display_name', 'role', 'job_title']);
        if (!body || typeof body.username !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,30}$/.test(body.username.trim().toLowerCase())
          || !isNonEmptyString(body.display_name, 100)
          || !['OPERATOR', 'SUPERVISOR', 'OWNER', 'INVESTOR'].includes(body.role)
          || !isOptionalString(body.job_title, 100)) {
          return invalidPayload('Username, nama tampilan, role, dan job title wajib valid.');
        }

        const tempPin = generateTemporaryPin();
        const { salt, hash } = await hashPin(tempPin);

        const { data: newProfile, error } = await db.rpc('rpc_create_user', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_username: body.username.trim().toLowerCase(),
          p_display_name: body.display_name.trim(),
          p_role: body.role,
          p_job_title: body.job_title?.trim() || 'STAFF',
          p_pin_salt: salt,
          p_pin_hash: hash,
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(newProfile) || !isUuid(newProfile.id) || newProfile.username !== body.username.trim().toLowerCase()
          || !isPositiveInteger(newProfile.version) || newProfile.active !== true) return invalidRpcResult();
        return successResponse({ user: newProfile, initial_pin: tempPin });
      }

      if (action === 'users.update' && request.method === 'POST') {
        if (user.role !== 'OWNER') return errorResponse('FORBIDDEN', 'Hanya Owner yang boleh mengubah user.', 403);
        const body = await readJsonObject(request, ['id', 'expected_version', 'display_name', 'role', 'job_title']);
        if (!body || !isUuid(body.id) || !isPositiveInteger(body.expected_version)
          || !isNonEmptyString(body.display_name, 100)
          || !['OPERATOR', 'SUPERVISOR', 'OWNER', 'INVESTOR'].includes(body.role)
          || !isNonEmptyString(body.job_title, 100)) {
          return invalidPayload('User, expected_version, nama, role, dan job title wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_update_user', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_target_id: body.id,
          p_expected_version: body.expected_version,
          p_display_name: body.display_name.trim(),
          p_role: body.role,
          p_job_title: body.job_title.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.id !== body.id || data.role !== body.role
          || data.version !== body.expected_version + 1) return invalidRpcResult();
        return successResponse(data, data.version);
      }

      if (action === 'users.deactivate' && request.method === 'POST') {
        if (user.role !== 'OWNER') return errorResponse('FORBIDDEN', 'Hanya Owner yang boleh menonaktifkan user.', 403);
        const body = await readJsonObject(request, ['id', 'expected_version', 'reason']);
        if (!body || !isUuid(body.id) || body.id === user.id || !isPositiveInteger(body.expected_version)
          || !isNonEmptyString(body.reason, 500)) {
          return invalidPayload('User lain, expected_version, dan reason wajib valid.');
        }
        const { data, error } = await db.rpc('rpc_deactivate_user', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_target_id: body.id,
          p_expected_version: body.expected_version,
          p_reason: body.reason.trim(),
        });
        if (error) return rpcErrorResponse(error);
        if (!isObject(data) || data.id !== body.id || data.active !== false
          || data.version !== body.expected_version + 1
          || !Number.isInteger(data.revoked_sessions) || data.revoked_sessions < 0
          || !Number.isInteger(data.revoked_devices) || data.revoked_devices < 0
          || !Number.isInteger(data.cancelled_rosters) || data.cancelled_rosters < 0
          || !Number.isInteger(data.cancelled_swaps) || data.cancelled_swaps < 0) return invalidRpcResult();
        return successResponse(data, data.version);
      }

      return errorResponse('NOT_FOUND', `Action ${action} tidak ditemukan.`, 404);
    } catch (err: any) {
      console.error('API Error:', err);
      return errorResponse('INTERNAL_ERROR', 'Terjadi kesalahan pada server.', 500);
    }
  },
};
