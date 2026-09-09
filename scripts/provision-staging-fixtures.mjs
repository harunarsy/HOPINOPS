import './mutating-tests-disabled.mjs';
// This script never reuses or repairs an existing run. Collision means abort.
import { createClient } from '@supabase/supabase-js';
import { randomBytes, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STAGING_REF = 'ibzlxdmnuszcmdzuocwu';
const STAGING_HOST = `${STAGING_REF}.supabase.co`;
const GPS = { latitude: -7.277997, longitude: 112.7464245 };
const PROJECTS = ['desktop', 'mobile'];
const KINDS = [
  { kind: 'lifecycle', role: 'OPERATOR', job_title: 'BARISTA' },
  { kind: 'journey', role: 'OPERATOR', job_title: 'KITCHEN' },
  { kind: 'onboarding', role: 'OPERATOR', job_title: 'BARISTA' },
  { kind: 'investor', role: 'INVESTOR', job_title: 'INVESTOR' },
];

function fail(message) {
  throw new Error(message);
}

if (process.env.E2E_MUTATIONS !== '1') fail('Fixture mutasi memerlukan E2E_MUTATIONS=1 eksplisit.');
if (process.env.E2E_STAGING_PROJECT_REF !== STAGING_REF) {
  fail(`Fixture mutasi hanya boleh ke staging ${STAGING_REF}.`);
}

const runId = (process.env.E2E_RUN_ID ?? '').trim().toLowerCase();
if (!/^[a-z0-9]{4,12}$/.test(runId)) fail('E2E_RUN_ID harus 4-12 karakter alnum lowercase.');
const manifestPath = process.env.E2E_FIXTURE_MANIFEST;
if (!manifestPath) fail('E2E_FIXTURE_MANIFEST wajib diisi sebelum provisioning.');
if (fs.existsSync(manifestPath)) fail(`Manifest sudah ada, menolak menimpa fixture run: ${manifestPath}`);

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) fail('Set SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY.');
let parsedUrl;
try {
  parsedUrl = new URL(url);
} catch {
  fail(`SUPABASE_URL tidak valid: ${url}`);
}
if (parsedUrl.hostname !== STAGING_HOST) {
  fail(`Menolak fixture: SUPABASE_URL host ${parsedUrl.hostname} bukan staging ${STAGING_HOST}.`);
}
if (process.env.VITE_SUPABASE_URL) {
  try {
    if (new URL(process.env.VITE_SUPABASE_URL).hostname !== STAGING_HOST) fail('VITE_SUPABASE_URL bukan staging.');
  } catch {
    fail('VITE_SUPABASE_URL tidak valid.');
  }
}

const pin = process.env.E2E_FIXTURE_PIN ?? '';
if (!/^\d{6}$/.test(pin) || /^(\d)\1{5}$/.test(pin) || ['123456', '654321', '123123', '654654', '012345', '543210', '112233', '121212'].includes(pin)) {
  fail('E2E_FIXTURE_PIN lemah atau tidak valid (6 digit, tidak berulang/berurutan).');
}
const desktopIp = process.env.E2E_DESKTOP_CLIENT_IP ?? process.env.E2E_CLIENT_IP ?? '198.51.100.42';
const mobileIp = process.env.E2E_MOBILE_CLIENT_IP ?? '198.51.100.44';
const failedLoginIp = process.env.E2E_FAILED_LOGIN_IP ?? '198.51.100.43';
const mobileFailedLoginIp = process.env.E2E_MOBILE_FAILED_LOGIN_IP ?? '198.51.100.45';
if (new Set([desktopIp, mobileIp, failedLoginIp, mobileFailedLoginIp]).size !== 4) {
  fail('Semua IP E2E (desktop, mobile, failed-login desktop/mobile) wajib berbeda.');
}

function outletCode(project) {
  return `e2e-${runId}-${project}`;
}
function username(project, kind) {
  return `e2e-${runId}-${project === 'desktop' ? 'd' : 'm'}-${kind}`;
}
function displayName(project, kind) {
  return `E2E ${runId} ${project} ${kind}`.toUpperCase();
}

const expectedUsernames = PROJECTS.flatMap((project) => KINDS.map(({ kind }) => username(project, kind)));
if (new Set(expectedUsernames).size !== 8) fail('Username fixture harus unik.');
const db = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

// Every preflight below is read-only. Do not write before all disposable identities are proven absent.
const { data: existingOutlets, error: outletLookupError } = await db.from('outlets').select('id, code').in('code', PROJECTS.map(outletCode));
if (outletLookupError) throw outletLookupError;
if ((existingOutlets ?? []).length > 0) {
  fail(`E2E_RUN_ID ${runId} sudah pernah dipakai (${existingOutlets.map((row) => row.code).join(', ')}). Gunakan run ID baru atau teardown fixture lama.`);
}
const { data: existingProfiles, error: profileLookupError } = await db.from('profiles').select('id, username').in('username', expectedUsernames);
if (profileLookupError) throw profileLookupError;
if ((existingProfiles ?? []).length > 0) {
  fail(`E2E_RUN_ID ${runId} sudah pernah dipakai (${existingProfiles.map((row) => row.username).join(', ')}). Gunakan run ID baru atau teardown fixture lama.`);
}
const { count: barCount, error: barError } = await db.from('items').select('id', { count: 'exact', head: true }).eq('area_code', 'BAR').eq('active', true);
if (barError) throw barError;
const { count: kitchenCount, error: kitchenError } = await db.from('items').select('id', { count: 'exact', head: true }).eq('area_code', 'KITCHEN').eq('active', true);
if (kitchenError) throw kitchenError;
if (!barCount || !kitchenCount) fail(`Preflight items kosong: BAR=${barCount} KITCHEN=${kitchenCount}`);

const encoder = new TextEncoder();
async function hashPin(value) {
  const salt = randomBytes(16).toString('base64');
  const key = await webcrypto.subtle.importKey('raw', encoder.encode(value), 'PBKDF2', false, ['deriveBits']);
  const derived = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 310_000, hash: 'SHA-256' }, key, 512);
  return { salt, hash: Buffer.from(derived).toString('base64') };
}

async function createOutlet(project) {
  const id = crypto.randomUUID();
  const { error } = await db.from('outlets').insert({ id, code: outletCode(project), name: `E2E ${runId} ${project}`, timezone: 'Asia/Jakarta', active: true });
  if (error) throw error;
  const { error: settingsError } = await db.from('outlet_settings').insert({
    outlet_id: id,
    latitude: GPS.latitude,
    longitude: GPS.longitude,
    geofence_radius_m: 100,
    max_accuracy_m: 50,
    system_mode: 'PILOT',
    onboarding_version: 1,
    version: 1,
  });
  if (settingsError) throw settingsError;
  const { error: shiftsError } = await db.from('shift_templates').insert([
    { outlet_id: id, code: 'SIANG', label: 'Shift Siang', start_local: '11:00:00', end_local: '17:00:00', scheduled_minutes: 360, active: true },
    { outlet_id: id, code: 'MALAM', label: 'Shift Malam', start_local: '17:00:00', end_local: '23:00:00', scheduled_minutes: 360, active: true },
    { outlet_id: id, code: 'FULL', label: 'Full Shift', start_local: '11:00:00', end_local: '23:00:00', scheduled_minutes: 720, active: true },
  ]);
  if (shiftsError) throw shiftsError;
  return id;
}

async function createProfile(project, outletId, spec, onProfileCreated) {
  const id = crypto.randomUUID();
  const user = username(project, spec.kind);
  const { error: profileError } = await db.from('profiles').insert({
    id,
    username: user,
    display_name: displayName(project, spec.kind),
    job_title: spec.job_title,
    role: spec.role,
    active: true,
    force_pin_change: false,
    deactivated_at: null,
  });
  if (profileError) throw profileError;
  onProfileCreated(id);
  const credential = await hashPin(pin);
  const { error: credentialError } = await db.from('operator_credentials').insert({
    profile_id: id,
    pin_salt: credential.salt,
    pin_hash: credential.hash,
    failed_attempts: 0,
    locked_until: null,
    last_failed_at: null,
    pin_version: 1,
  });
  if (credentialError) throw credentialError;
  const { error: scopeError } = await db.from('profile_outlet_scopes').insert({ profile_id: id, outlet_id: outletId, active: true });
  if (scopeError) throw scopeError;
  return { id, username: user, displayName: displayName(project, spec.kind), role: spec.role };
}

const outletIds = {};
const createdOutletIds = [];
const createdProfileIds = [];

async function deactivatePartialFixture() {
  if (createdProfileIds.length > 0) {
    await db.from('app_sessions').delete().in('profile_id', createdProfileIds);
    await db.from('app_devices').update({ revoked_at: new Date().toISOString() }).in('profile_id', createdProfileIds).is('revoked_at', null);
    await db.from('profile_outlet_scopes').update({ active: false }).in('profile_id', createdProfileIds);
    await db.from('profiles').update({ active: false, deactivated_at: new Date().toISOString() }).in('id', createdProfileIds);
  }
  if (createdOutletIds.length > 0) await db.from('outlets').update({ active: false }).in('id', createdOutletIds);
}

try {
  for (const project of PROJECTS) {
    outletIds[project] = await createOutlet(project);
    createdOutletIds.push(outletIds[project]);
  }
  const manifest = {
    runId,
    projectRef: STAGING_REF,
    gps: GPS,
    clientIps: { desktop: desktopIp, mobile: mobileIp },
    outlets: Object.fromEntries(PROJECTS.map((project) => [project, { id: outletIds[project], code: outletCode(project) }])),
    users: { desktop: {}, mobile: {} },
  };
  for (const project of PROJECTS) {
    for (const spec of KINDS) {
      const user = await createProfile(project, outletIds[project], spec, (id) => createdProfileIds.push(id));
      manifest.users[project][spec.kind] = user;
    }
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`provision ok run ${runId}: 2 outlets + 8 profiles; manifest ${manifestPath}`);
} catch (error) {
  try {
    await deactivatePartialFixture();
  } catch (cleanupError) {
    console.error('Rollback fixture parsial gagal:', cleanupError);
  }
  throw error;
}
