// Staging fixture provisioning — hardened, disposable per run.
// - Guard: hanya staging ibzlxdmnuszcmdzuocwu, E2E_MUTATIONS=1, host penuh.
// - Legacy fixed users tetap diprovision untuk kompatibilitas.
// - Jika E2E_RUN_ID diset, buat 2 outlet unik (desktop/mobile) + 4 profil per outlet,
//   tulis manifest JSON untuk isolasi desktop/mobile tanpa reset histori.
// Run: E2E_MUTATIONS=1 E2E_STAGING_PROJECT_REF=ibzlxdmnuszcmdzuocwu \
//   SUPABASE_URL=https://ibzlxdmnuszcmdzuocwu.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... E2E_RUN_ID=abc123 E2E_FIXTURE_PIN=741258 \
//   E2E_DESKTOP_CLIENT_IP=198.51.100.42 E2E_MOBILE_CLIENT_IP=198.51.100.44 \
//   E2E_FIXTURE_MANIFEST=test-results/e2e-manifest-abc123.json \
//   node scripts/provision-staging-fixtures.mjs
import { createClient } from '@supabase/supabase-js';
import { randomBytes, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STAGING_REF = 'ibzlxdmnuszcmdzuocwu';
const STAGING_HOST = `${STAGING_REF}.supabase.co`;
const GPS = { latitude: -7.277997, longitude: 112.7464245 };

function fail(msg) {
  throw new Error(msg);
}

if (process.env.E2E_MUTATIONS !== '1') {
  fail('Fixture mutasi memerlukan E2E_MUTATIONS=1 eksplisit.');
}

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) fail('Set SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY.');

const expectedProjectRef = process.env.E2E_STAGING_PROJECT_REF;
if (expectedProjectRef !== STAGING_REF) {
  fail(`Fixture mutasi hanya boleh ke staging ${STAGING_REF}; ditolak ref ${expectedProjectRef || '(kosong)'}.`);
}
let parsedUrl;
try {
  parsedUrl = new URL(url);
} catch {
  fail(`SUPABASE_URL tidak valid: ${url}`);
}
if (parsedUrl.hostname !== STAGING_HOST) {
  fail(`Menolak fixture: SUPABASE_URL host ${parsedUrl.hostname} bukan staging ${STAGING_HOST}.`);
}
const viteUrl = process.env.VITE_SUPABASE_URL;
if (viteUrl) {
  try {
    const viteHost = new URL(viteUrl).hostname;
    if (viteHost !== STAGING_HOST) fail(`VITE_SUPABASE_URL host ${viteHost} bukan staging.`);
  } catch {
    fail(`VITE_SUPABASE_URL tidak valid: ${viteUrl}`);
  }
}

const db = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const pinIterations = 310_000;
const encoder = new TextEncoder();

async function authScopeKey(scope, value) {
  const key = await webcrypto.subtle.importKey(
    'raw',
    encoder.encode(serviceRoleKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await webcrypto.subtle.sign('HMAC', key, encoder.encode(`${scope}\0${value}`));
  return `${scope}:${Buffer.from(digest).toString('hex')}`;
}

async function publicOptionsScopeKey(ip) {
  const key = await webcrypto.subtle.importKey(
    'raw',
    encoder.encode(serviceRoleKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await webcrypto.subtle.sign('HMAC', key, encoder.encode(`public-options\0${ip}`));
  return `public_options:${Buffer.from(digest).toString('hex')}`;
}

function isWeakPin(pin) {
  if (!/^\d{6}$/.test(pin)) return true;
  if (/^(\d)\1{5}$/.test(pin)) return true;
  return ['123456', '654321', '123123', '654654', '012345', '543210', '112233', '121212'].includes(pin);
}

async function hashPin(pin) {
  const salt = randomBytes(16).toString('base64');
  const key = await webcrypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const derived = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: pinIterations, hash: 'SHA-256' }, key, 512);
  return { salt, hash: Buffer.from(derived).toString('base64') };
}

const pin = process.env.E2E_FIXTURE_PIN ?? '741258';
if (isWeakPin(pin)) fail('E2E_FIXTURE_PIN lemah atau tidak valid (6 digit, tidak berulang/berurutan).');

const e2eClientIp = process.env.E2E_CLIENT_IP ?? process.env.E2E_DESKTOP_CLIENT_IP ?? '198.51.100.42';
const e2eFailedLoginIp = process.env.E2E_FAILED_LOGIN_IP ?? '198.51.100.43';
const desktopIp = process.env.E2E_DESKTOP_CLIENT_IP ?? e2eClientIp;
const mobileIp = process.env.E2E_MOBILE_CLIENT_IP ?? '198.51.100.44';
const mobileFailedLoginIp = process.env.E2E_MOBILE_FAILED_LOGIN_IP ?? '198.51.100.45';
const allIps = [desktopIp, mobileIp, e2eFailedLoginIp, mobileFailedLoginIp];
if (new Set(allIps).size !== allIps.length) fail('Semua IP E2E (desktop, mobile, failed-login desktop/mobile) wajib berbeda.');

const outletId = '11111111-1111-1111-1111-111111111111';

const legacyUsers = [
  { username: 'e2e-owner', display_name: 'E2E OWNER', role: 'OWNER', job_title: 'OWNER' },
  { username: 'e2e-supervisor', display_name: 'E2E SUPERVISOR', role: 'SUPERVISOR', job_title: 'SUPERVISOR' },
  { username: 'e2e-operator', display_name: 'E2E OPERATOR', role: 'OPERATOR', job_title: 'BARISTA' },
  { username: 'e2e-operator2', display_name: 'E2E OPERATOR 2', role: 'OPERATOR', job_title: 'KITCHEN' },
  { username: 'e2e-investor', display_name: 'E2E INVESTOR', role: 'INVESTOR', job_title: 'INVESTOR' },
];

async function clearRateLimits(usernames, ips) {
  const keys = [];
  for (const u of usernames) {
    keys.push(await authScopeKey('credential', u));
  }
  keys.push(await authScopeKey('credential', 'e2e-warmup'));
  keys.push(await authScopeKey('credential', 'e2e-no-such-user'));
  for (const ip of ips) {
    keys.push(await authScopeKey('ip', ip));
    keys.push(await publicOptionsScopeKey(ip));
  }
  // localhost variants used by vercel dev / playwright
  for (const ip of ['::1', '127.0.0.1', '::ffff:127.0.0.1', 'unknown']) {
    keys.push(await authScopeKey('ip', ip));
    keys.push(await publicOptionsScopeKey(ip));
  }
  const { error } = await db.from('auth_rate_limits').delete().in('scope_key', keys);
  if (error) throw error;
}

async function upsertProfileWithCredential({ username, display_name, role, job_title, outlet_id }) {
  const { data: existing } = await db.from('profiles').select('id').eq('username', username).maybeSingle();
  const profileId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    const { error } = await db.from('profiles').insert({
      id: profileId,
      username,
      display_name,
      job_title,
      role,
      active: true,
      force_pin_change: false,
      deactivated_at: null,
    });
    if (error) throw error;
  } else {
    const { error } = await db.from('profiles').update({
      display_name,
      job_title,
      role,
      active: true,
      force_pin_change: false,
      deactivated_at: null,
    }).eq('id', profileId);
    if (error) throw error;
  }

  // Revoke old sessions/devices so PIN rotation is effective.
  await db.from('app_sessions').delete().eq('profile_id', profileId);
  await db.from('app_devices').delete().eq('profile_id', profileId);

  const { data: cred } = await db.from('operator_credentials').select('pin_version').eq('profile_id', profileId).maybeSingle();
  const nextVersion = (cred?.pin_version ?? 0) + 1;
  const { salt, hash } = await hashPin(pin);
  const { error: credError } = await db.from('operator_credentials').upsert({
    profile_id: profileId,
    pin_salt: salt,
    pin_hash: hash,
    failed_attempts: 0,
    locked_until: null,
    last_failed_at: null,
    pin_version: nextVersion,
  }, { onConflict: 'profile_id' });
  if (credError) throw credError;

  const { error: scopeError } = await db.from('profile_outlet_scopes').upsert({
    profile_id: profileId,
    outlet_id,
    active: true,
  }, { onConflict: 'profile_id,outlet_id' });
  if (scopeError) throw scopeError;

  // Ensure exactly one active scope for fixture profiles.
  const { data: scopes } = await db.from('profile_outlet_scopes').select('outlet_id, active').eq('profile_id', profileId);
  for (const s of scopes ?? []) {
    if (s.outlet_id !== outlet_id && s.active) {
      await db.from('profile_outlet_scopes').update({ active: false }).eq('profile_id', profileId).eq('outlet_id', s.outlet_id);
    }
  }
  return profileId;
}

const { data: policy } = await db.from('compensation_policies').select('id').eq('outlet_id', outletId).maybeSingle();

// Legacy fixed users (backward compat)
await clearRateLimits(legacyUsers.map((u) => u.username), allIps);
for (const user of legacyUsers) {
  const profileId = await upsertProfileWithCredential({ ...user, outlet_id: outletId });
  if (user.role === 'OPERATOR' && policy) {
    const { error: compError } = await db.from('employee_compensations').insert({
      profile_id: profileId,
      policy_id: policy.id,
      effective_from: '2026-01-01',
      monthly_base: 3_000_000,
      daily_rate: 100_000,
      hourly_rate: 12_500,
    });
    if (compError && !String(compError.message).includes('duplicate')) console.error(`compensation ${user.username}:`, compError.message);
  }
  console.log(`ok ${user.username} (${user.role}) -> ${profileId}`);
}

// Unique per-run outlets/profiles
const runIdRaw = (process.env.E2E_RUN_ID ?? '').trim().toLowerCase();
if (!runIdRaw) {
  console.log('E2E_RUN_ID tidak diset; hanya legacy users diprovision. Set E2E_RUN_ID untuk isolasi desktop/mobile.');
  process.exit(0);
}
if (!/^[a-z0-9]{4,12}$/.test(runIdRaw)) fail('E2E_RUN_ID harus 4-12 karakter alnum lowercase.');
const runId = runIdRaw;

async function ensureOutlet(code, name) {
  const { data: existing } = await db.from('outlets').select('id').eq('code', code).maybeSingle();
  let id = existing?.id;
  if (!id) {
    id = crypto.randomUUID();
    const { error } = await db.from('outlets').insert({ id, code, name, timezone: 'Asia/Jakarta', active: true });
    if (error) throw error;
  } else {
    const { error } = await db.from('outlets').update({ name, active: true }).eq('id', id);
    if (error) throw error;
  }
  const { error: settingsError } = await db.from('outlet_settings').upsert({
    outlet_id: id,
    latitude: GPS.latitude,
    longitude: GPS.longitude,
    geofence_radius_m: 100,
    max_accuracy_m: 50,
    system_mode: 'PILOT',
    onboarding_version: 1,
    version: 1,
  }, { onConflict: 'outlet_id' });
  if (settingsError) throw settingsError;

  const shifts = [
    { code: 'SIANG', label: 'Shift Siang', start_local: '11:00:00', end_local: '17:00:00', scheduled_minutes: 360 },
    { code: 'MALAM', label: 'Shift Malam', start_local: '17:00:00', end_local: '23:00:00', scheduled_minutes: 360 },
    { code: 'FULL', label: 'Full Shift', start_local: '11:00:00', end_local: '23:00:00', scheduled_minutes: 720 },
  ];
  for (const s of shifts) {
    const { error } = await db.from('shift_templates').upsert({
      outlet_id: id,
      code: s.code,
      label: s.label,
      start_local: s.start_local,
      end_local: s.end_local,
      scheduled_minutes: s.scheduled_minutes,
      active: true,
    }, { onConflict: 'outlet_id,code' });
    if (error) throw error;
  }
  return id;
}

const desktopCode = `e2e-${runId}-desktop`;
const mobileCode = `e2e-${runId}-mobile`;
const desktopOutletId = await ensureOutlet(desktopCode, `E2E ${runId} desktop`);
const mobileOutletId = await ensureOutlet(mobileCode, `E2E ${runId} mobile`);

function runUsername(project, kind) {
  // username format: ^[a-z0-9][a-z0-9._-]{1,30}$ ; keep <=31 chars
  return `e2e-${runId}-${project}-${kind}`.slice(0, 31);
}
function runDisplayName(project, kind) {
  return `E2E ${runId} ${project} ${kind}`.toUpperCase();
}

const projects = ['desktop', 'mobile'];
const kinds = [
  { kind: 'lifecycle', role: 'OPERATOR', job_title: 'BARISTA' },
  { kind: 'journey', role: 'OPERATOR', job_title: 'KITCHEN' },
  { kind: 'onboarding', role: 'OPERATOR', job_title: 'BARISTA' },
  { kind: 'investor', role: 'INVESTOR', job_title: 'INVESTOR' },
];

const manifest = {
  runId,
  projectRef: STAGING_REF,
  gps: GPS,
  clientIps: { desktop: desktopIp, mobile: mobileIp },
  outlets: {
    desktop: { id: desktopOutletId, code: desktopCode },
    mobile: { id: mobileOutletId, code: mobileCode },
  },
  users: { desktop: {}, mobile: {} },
};

const allUsernames = [];
for (const project of projects) {
  const outlet_id = project === 'desktop' ? desktopOutletId : mobileOutletId;
  for (const { kind, role, job_title } of kinds) {
    const username = runUsername(project[0] === 'd' ? 'd' : 'm', kind.slice(0, 4));
    // Expand to full but keep unique + valid: e2e-<run>-d-life etc.
    const fullUsername = `e2e-${runId}-${project === 'desktop' ? 'd' : 'm'}-${kind}`.slice(0, 31);
    const display_name = `E2E ${runId} ${project} ${kind}`.toUpperCase();
    const profileId = await upsertProfileWithCredential({ username: fullUsername, display_name, role, job_title, outlet_id });
    allUsernames.push(fullUsername);
    manifest.users[project][kind] = { id: profileId, username: fullUsername, displayName: display_name, role };
    console.log(`ok ${fullUsername} (${role}) -> ${profileId} @ ${outlet_id}`);
  }
}

await clearRateLimits([...allUsernames, 'e2e-no-such-user'], allIps);

// Preflight: global items, outlet settings/shifts, clean state for new outlets
const { count: barCount } = await db.from('items').select('id', { count: 'exact', head: true }).eq('area_code', 'BAR').eq('active', true);
const { count: kitchenCount } = await db.from('items').select('id', { count: 'exact', head: true }).eq('area_code', 'KITCHEN').eq('active', true);
if (!barCount || !kitchenCount) fail(`Preflight items kosong: BAR=${barCount} KITCHEN=${kitchenCount}`);

for (const [project, outlet_id] of [['desktop', desktopOutletId], ['mobile', mobileOutletId]]) {
  const { data: settings } = await db.from('outlet_settings').select('latitude, longitude, system_mode').eq('outlet_id', outlet_id).maybeSingle();
  if (!settings) fail(`Preflight outlet_settings hilang untuk ${project}`);
  const { data: shifts } = await db.from('shift_templates').select('code').eq('outlet_id', outlet_id).eq('active', true);
  if (!shifts?.some((s) => s.code === 'SIANG')) fail(`Preflight shift SIANG hilang untuk ${project}`);
  const { count: cycles } = await db.from('work_cycles').select('id', { count: 'exact', head: true }).eq('outlet_id', outlet_id);
  if ((cycles ?? 0) !== 0) fail(`Preflight ${project} outlet tidak bersih: ${cycles} work_cycles`);
}

const manifestPath = process.env.E2E_FIXTURE_MANIFEST ?? `/tmp/e2e-manifest-${runId}.json`;
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`manifest ${manifestPath}`);
