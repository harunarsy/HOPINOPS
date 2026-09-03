import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';

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
  if (deviceToken) {
    const devHash = await hashSessionToken(deviceToken);
    // Find device or link it
    const { data: device } = await db
      .from('app_devices')
      .select('id, profile_id')
      .eq('device_token_hash', devHash)
      .is('revoked_at', null)
      .maybeSingle();

    if (device) {
      deviceId = device.id;
      if (device.profile_id !== profile.id) {
        await db.from('app_devices').update({ profile_id: profile.id, last_seen_at: new Date(now).toISOString() }).eq('id', deviceId);
      }
    } else {
      const { data: newDev } = await db.from('app_devices').insert({
        profile_id: profile.id,
        device_token_hash: devHash,
        first_seen_at: new Date(now).toISOString(),
        last_seen_at: new Date(now).toISOString(),
      }).select('id').maybeSingle();
      if (newDev) deviceId = newDev.id;
    }

    if (deviceId && session.device_id !== deviceId) {
      await db.from('app_sessions').update({ device_id: deviceId }).eq('id', session.id);
    }
  } else if (session.device_id) {
    deviceId = session.device_id;
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
  const code = domainCode || (error?.code === '23505' ? 'STATE_CONFLICT' : 'RPC_FAILED');
  let status = 500;
  if (error?.code === '42501' || /(?:FORBIDDEN|AUTHORIZATION_FAILED|INVALID_SESSION|INVALID_DEVICE)/.test(code)) status = 403;
  else if (error?.code === 'P0002' || code === 'NOT_FOUND') status = 404;
  else if (error?.code === '23505' || error?.code === '55000') status = 409;
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

  return errorResponse(code, message, status);
}

function invalidRpcResult() {
  return errorResponse('RPC_INVALID_RESPONSE', 'Perintah server tidak mengembalikan hasil yang valid.', 502);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
function sanitizeExcelCell(val: any): any {
  if (typeof val === 'string' && /^[=+\-@]/.test(val)) {
    return `'${val}`;
  }
  return val;
}

async function sha256Buffer(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function logAudit(db: SupabaseClient, {
  actor_user_id,
  action,
  entity_type,
  entity_id,
  outlet_id,
  subject_user_id,
  reason,
  metadata_json,
}: {
  actor_user_id?: string;
  action: string;
  entity_type: string;
  entity_id: string;
  outlet_id?: string;
  subject_user_id?: string;
  reason?: string;
  metadata_json?: any;
}) {
  try {
    await db.from('audit_events').insert({
      actor_user_id: actor_user_id || null,
      action,
      entity_type,
      entity_id,
      outlet_id: outlet_id || null,
      subject_user_id: subject_user_id || null,
      reason: reason || null,
      metadata_json: metadata_json || null,
      server_occurred_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Failed to write audit event', err);
  }
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

    const authContext = await currentAuthContext(request);
    if (!authContext) {
      return errorResponse('AUTH_REQUIRED', 'Sesi tidak valid atau telah berakhir.', 401);
    }
    const user = authContext.user;

    if (user.force_pin_change && action !== 'changePin' && action !== 'bootstrap') {
      return errorResponse('PIN_CHANGE_REQUIRED', 'Wajib mengganti PIN sebelum melanjutkan.', 403);
    }

    const db = getAdminClient();

    try {
      const outletId = await scopedOutletId(db, user.id);
      if (!outletId) {
        return errorResponse('OUTLET_SCOPE_REQUIRED', 'Akun harus memiliki tepat satu scope outlet aktif.', 403);
      }

      // 1. BOOTSTRAP
      if (action === 'bootstrap' && request.method === 'GET') {
        const { data: outlet } = await db.from('outlets').select('*').eq('id', outletId).eq('active', true).single();
        const { data: settings } = await db.from('outlet_settings').select('*').eq('outlet_id', outletId).single();
        const { data: items } = await db.from('items').select('*').eq('active', true).order('name');
        const { data: shifts } = await db.from('shift_templates').select('*').eq('outlet_id', outlet?.id).eq('active', true);
        const { data: onboarding } = await db.from('onboarding_progress').select('*').eq('profile_id', user.id).maybeSingle();

        const workDate = getWibDate();
        const { data: activeAssignment } = await db
          .from('work_assignments')
          .select('*, work_cycles!inner(*)')
           .eq('profile_id', user.id)
          .eq('work_cycles.outlet_id', outletId)
          .eq('work_date', workDate)
          .eq('status', 'ACTIVE')
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

      // 2. DASHBOARD (OWNER / SUPERVISOR)
      if (action === 'dashboard.get' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Owner & Supervisor yang dapat mengakses dashboard manajemen.', 403);
        }
        const workDate = url.searchParams.get('date') || getWibDate();
        const { data: cycles } = await db.from('work_cycles').select('*, work_assignments(*, profiles(display_name))').eq('outlet_id', outletId).eq('work_date', workDate);
        const { data: attendance } = await db.from('attendance_records').select('*, profiles(display_name), attendance_events(*)').eq('outlet_id', outletId).eq('work_date', workDate);
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
        const { data } = await db.from('items').select('*').eq('active', true).order('name');
        return successResponse({ items: data ?? [] });
      }

      if (action === 'items.create' && request.method === 'POST') {
        if (user.role !== 'OWNER') return errorResponse('FORBIDDEN', 'Hanya Owner yang boleh menambah item.', 403);
        const body = (await request.json()) as any;
        const { data, error } = await db.from('items').insert({
          id: body.id,
          area_code: body.area_code,
          name: body.name,
          unit_code: body.unit_code,
          decimal_scale: body.decimal_scale ?? 2,
          low_threshold: body.low_threshold ?? 0,
        }).select().single();
        if (error) return errorResponse('DB_ERROR', error.message, 400);

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'CREATE_ITEM',
          entity_type: 'items',
          entity_id: data.id,
          metadata_json: data,
        });

        return successResponse(data);
      }

      if (action === 'items.update' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mengubah item.', 403);
        const body = (await request.json()) as any;
        const { data, error } = await db.from('items').update({
          name: body.name,
          unit_code: body.unit_code,
          decimal_scale: body.decimal_scale,
          low_threshold: body.low_threshold,
        }).eq('id', body.id).select().single();
        if (error) return errorResponse('DB_ERROR', error.message, 400);

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'UPDATE_ITEM',
          entity_type: 'items',
          entity_id: body.id,
          metadata_json: data,
        });

        return successResponse(data);
      }

      // 5. ROSTER & SWAP
      if (action === 'roster.list' && request.method === 'GET') {
        const month = url.searchParams.get('month') || getWibDate().slice(0, 7);
        const { data } = await db
           .from('roster_entries')
           .select('*, profiles(username, display_name)')
          .eq('outlet_id', outletId)
          .gte('work_date', `${month}-01`)
          .lte('work_date', `${month}-31`)
          .order('work_date', { ascending: true });
        return successResponse({ roster: data ?? [] });
      }

      if (action === 'roster.save' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mengatur roster.', 403);
        const body = (await request.json()) as any;
        const { data: targetScope } = await db.from('profile_outlet_scopes').select('profile_id').eq('profile_id', body.profile_id).eq('outlet_id', outletId).eq('active', true).maybeSingle();
        if (!targetScope) return errorResponse('FORBIDDEN', 'User roster bukan anggota outlet ini.', 403);
        if (body.id) {
          const { data: existing } = await db.from('roster_entries').select('id').eq('id', body.id).eq('outlet_id', outletId).maybeSingle();
          if (!existing) return errorResponse('NOT_FOUND', 'Roster pada outlet ini tidak ditemukan.', 404);
        }

        const { data, error } = await db.from('roster_entries').upsert({
          id: body.id || undefined,
          outlet_id: outletId,
          work_date: body.work_date,
          shift_code: body.shift_code,
          profile_id: body.profile_id,
          expected_area: body.expected_area || null,
          pay_treatment: body.pay_treatment || 'BASE',
          override_reason: body.override_reason || null,
          created_by: user.id,
        }).select().single();
        if (error) return errorResponse('DB_ERROR', error.message, 400);

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'SAVE_ROSTER',
          entity_type: 'roster_entries',
          entity_id: data.id,
          outlet_id: outletId,
          subject_user_id: body.profile_id,
          metadata_json: data,
        });

        return successResponse(data);
      }

      if (action === 'swap.request' && request.method === 'POST') {
        const body = (await request.json()) as any;
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
        const body = (await request.json()) as any;
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

      // 6. ASSIGNMENT CLAIM (RPC / TRANSACTIONAL LOCK)
      if (action === 'assignment.claim' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan mengklaim assignment.', 403);
        }
        const body = (await request.json()) as any;
        const workDate = body.work_date || getWibDate();
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
        const body = (await request.json()) as any;
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

      // 7. ATTENDANCE
      if (action === 'attendance.challenge' && request.method === 'POST') {
        const body = (await request.json()) as any;
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

        const body = (await request.json()) as any;
        const binding = attendanceChallengeBinding(body);
        if (!binding) {
          return errorResponse('VALIDATION_FAILED', 'Challenge dan nonce absensi wajib valid.', 400);
        }
        const assignmentId = body.assignmentId ?? body.assignment_id ?? null;
        if (eventType === 'CHECK_IN' && !isUuid(assignmentId)) {
          return errorResponse('VALIDATION_FAILED', 'assignmentId wajib berupa UUID untuk check-in.', 400);
        }
        const suppliedIdempotencyKey = body.idempotencyKey ?? body.idempotency_key;
        if (suppliedIdempotencyKey !== undefined && !isUuid(suppliedIdempotencyKey)) {
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
          p_idempotency_key: suppliedIdempotencyKey || crypto.randomUUID(),
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

        return successResponse({ cycle, opening, movements: movements ?? [], handover, closing, items: items ?? [] });
      }

      if (action === 'opening.confirm' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan mengonfirmasi opening.', 403);
        }
        const body = (await request.json()) as any;
        if (!body.cycle_id) return errorResponse('VALIDATION_FAILED', 'cycle_id diperlukan.', 400);

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
        const body = (await request.json()) as any;
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

      if (action === 'handover.complete' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan menyelesaikan handover.', 403);
        }
        const body = (await request.json()) as any;
        if (!body.cycle_id) return errorResponse('VALIDATION_FAILED', 'cycle_id diperlukan.', 400);

        const { data: handover, error } = await db.rpc('rpc_complete_handover', {
          p_cycle_id: body.cycle_id,
          p_actor_id: user.id,
        });
        if (error) return rpcErrorResponse(error);
        if (!handover?.handover_id) return invalidRpcResult();
        return successResponse({ handover });
      }

      if (action === 'closing.confirm' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan mengonfirmasi closing.', 403);
        }
        const body = (await request.json()) as any;
        if (!body.cycle_id) return errorResponse('VALIDATION_FAILED', 'cycle_id diperlukan.', 400);

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
      if (action === 'report.submit' && request.method === 'POST') {
        if (!isOperationalRole(user.role)) {
          return errorResponse('FORBIDDEN', 'Role ini tidak diizinkan mengirim laporan harian.', 403);
        }
        const body = (await request.json()) as any;
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
        const body = (await request.json()) as any;
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
        const body = (await request.json()) as any;
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
        if (run?.id) {
          const { data: entriesData, error: entriesError } = await db
            .from('payroll_entries')
            .select('*, profiles(display_name, job_title)')
            .eq('run_id', run.id)
            .order('profile_id');
          if (entriesError) throw entriesError;
          entries = entriesData ?? [];
        }

        return successResponse({ run: run ?? null, entries });
      }

      if (action === 'payroll.preview' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh membuat preview payroll.', 403);
        }
        const body = (await request.json()) as any;
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

      if (action === 'payroll.review' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh me-review payroll.', 403);
        }
        const body = (await request.json()) as any;
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
        const body = (await request.json()) as any;
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
        const body = (await request.json()) as any;
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
        const body = (await request.json()) as any;
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
        const body = (await request.json()) as any;
        if (!isUuid(body.run_id) || !Number.isInteger(body.expected_version) || body.expected_version <= 0) {
          return errorResponse('VALIDATION_FAILED', 'run_id UUID dan expected_version integer positif wajib diisi.', 400);
        }
        const { data: run, error: runError } = await db.from('payroll_runs').select('*').eq('id', body.run_id).eq('outlet_id', outletId).maybeSingle();
        if (runError) throw runError;
        if (!run) return errorResponse('NOT_FOUND', 'Payroll run pada outlet ini tidak ditemukan.', 404);
        if (run.version !== body.expected_version) return errorResponse('VERSION_CONFLICT', 'Versi payroll run sudah berubah.', 409);
        if (!['REVIEWED', 'FINALIZED', 'PAID'].includes(run.status)) {
          return errorResponse('STATE_CONFLICT', `Payroll ${run.status} tidak dapat diekspor.`, 409);
        }

        const { data: entries, error: entriesError } = await db.from('payroll_entries').select('*, profiles(display_name)').eq('run_id', run.id).order('profile_id');
        if (entriesError) throw entriesError;
        const entryIds = (entries ?? []).map(entry => entry.id);
        const { data: adjustments, error: adjustmentsError } = entryIds.length
          ? await db.from('payroll_adjustments').select('*').in('entry_id', entryIds).order('created_at')
          : { data: [], error: null };
        if (adjustmentsError) throw adjustmentsError;

        const bucketName = process.env.PAYROLL_EXPORT_BUCKET;
        if (!bucketName) return errorResponse('PRIVATE_STORAGE_UNAVAILABLE', 'Bucket privat payroll belum dikonfigurasi.', 503);
        const { data: bucket, error: bucketError } = await db.storage.getBucket(bucketName);
        if (bucketError || !bucket || bucket.public) {
          return errorResponse('PRIVATE_STORAGE_UNAVAILABLE', 'Bucket payroll tidak tersedia atau tidak privat.', 503);
        }

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'HOPIN Operations Engine';
        workbook.created = new Date();

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
        (entries ?? []).forEach(entry => {
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
        (adjustments ?? []).forEach(adj => {
          sAdj.addRow({
            entry: sanitizeExcelCell(adj.entry_id),
            type: sanitizeExcelCell(adj.adjustment_type),
            reason: sanitizeExcelCell(adj.reason),
            amount: Number(adj.amount),
            status: sanitizeExcelCell(adj.status),
          });
        });

        const sEvidence = workbook.addWorksheet('Evidence');
        sEvidence.columns = [
          { header: 'Payroll Entry ID', key: 'entry', width: 36 },
          { header: 'Attendance Summary', key: 'attendance', width: 80 },
        ];
        (entries ?? []).forEach(entry => {
          sEvidence.addRow({
            entry: sanitizeExcelCell(entry.id),
            attendance: sanitizeExcelCell(JSON.stringify(entry.attendance_summary)),
          });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const checksum = await sha256Buffer(buffer);
        const label = run.status === 'REVIEWED' ? 'DRAFT' : 'FINALIZED';
        const filename = `HOPIN-PAYROLL-${run.period_month}-${label}.xlsx`;
        const filePath = `${outletId}/${run.id}/${filename}`;
        const rowCounts = { summary: entries?.length ?? 0, adjustments: adjustments?.length ?? 0, evidence: entries?.length ?? 0 };
        const { error: uploadError } = await db.storage.from(bucketName).upload(filePath, buffer, {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          upsert: false,
        });
        if (uploadError) return errorResponse('EXPORT_STORAGE_FAILED', uploadError.message, 503);

        const { data: exportResult, error: exportError } = await db.rpc('rpc_record_payroll_export', {
          p_actor_id: user.id,
          p_run_id: run.id,
          p_expected_run_version: body.expected_version,
          p_export_label: label,
          p_file_path: filePath,
          p_checksum_sha256: checksum,
          p_row_counts: rowCounts,
        });
        if (exportError) {
          await db.storage.from(bucketName).remove([filePath]);
          return rpcErrorResponse(exportError);
        }
        if (!exportResult?.export_id) {
          await db.storage.from(bucketName).remove([filePath]);
          return invalidRpcResult();
        }
        return successResponse({
          export_id: exportResult.export_id,
          filename,
          file_path: filePath,
          checksum,
          label,
        });
      }

      // 12. ONBOARDING
      if (action === 'onboarding.complete' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const v = body.version || 1;
        await db.from('onboarding_progress').upsert({
          profile_id: user.id,
          onboarding_version: v,
          completed_at: new Date().toISOString(),
        }, { onConflict: 'profile_id,onboarding_version' });

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'COMPLETE_ONBOARDING',
          entity_type: 'onboarding_progress',
          entity_id: user.id,
        });

        return successResponse({ ok: true });
      }

      // 13. USER MANAGEMENT (OWNER)
      if (action === 'users.list' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh melihat daftar user.', 403);
        }
        const { data } = await db.from('profile_outlet_scopes').select('profiles!inner(id, username, display_name, role, active, force_pin_change, deactivated_at)').eq('outlet_id', outletId).eq('active', true);
        const users = (data ?? []).map(scope => scope.profiles).sort((a: any, b: any) => a.display_name.localeCompare(b.display_name));
        return successResponse({ users });
      }

      if (action === 'users.create' && request.method === 'POST') {
        if (user.role !== 'OWNER') return errorResponse('FORBIDDEN', 'Hanya Owner yang boleh membuat user baru.', 403);
        const body = (await request.json()) as any;
        if (!body.username || !body.display_name || !body.role) {
          return errorResponse('VALIDATION_FAILED', 'Username, nama tampilan, dan role wajib diisi.', 400);
        }

        const tempPin = body.initial_pin || Math.floor(100000 + Math.random() * 900000).toString();
        const { salt, hash } = await hashPin(tempPin);

        const { data: newProfile, error } = await db.rpc('rpc_create_user', {
          p_actor_id: user.id,
          p_outlet_id: outletId,
          p_username: body.username,
          p_display_name: body.display_name,
          p_role: body.role,
          p_job_title: body.job_title || 'STAFF',
          p_pin_salt: salt,
          p_pin_hash: hash,
        });
        if (error) return rpcErrorResponse(error);
        if (!newProfile?.id) return invalidRpcResult();
        return successResponse({ user: newProfile, initial_pin: tempPin });
      }

      return errorResponse('NOT_FOUND', `Action ${action} tidak ditemukan.`, 404);
    } catch (err: any) {
      console.error('API Error:', err);
      return errorResponse('INTERNAL_ERROR', err.message || 'Terjadi kesalahan pada server.', 500);
    }
  },
};
