// Logical teardown for disposable E2E runs (staging only, never production).
// Deactivates run outlets/profiles/scopes, revokes sessions/devices, clears
// run rate-limit keys. Immutable history (audit, cycles, attendance, stock)
// is preserved as evidence. Deletes NOTHING except session/device/rate-limit rows.
// Run: E2E_MUTATIONS=1 E2E_STAGING_PROJECT_REF=ibzlxdmnuszcmdzuocwu \
//   SUPABASE_URL=https://ibzlxdmnuszcmdzuocwu.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... E2E_FIXTURE_MANIFEST=/tmp/e2e-manifest-<run>.json \
//   node scripts/teardown-staging-fixtures.mjs
import { createClient } from '@supabase/supabase-js';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';

const STAGING_REF = 'ibzlxdmnuszcmdzuocwu';
const STAGING_HOST = `${STAGING_REF}.supabase.co`;

function fail(msg) {
  throw new Error(msg);
}

if (process.env.E2E_MUTATIONS !== '1') fail('Teardown memerlukan E2E_MUTATIONS=1 eksplisit.');
if (process.env.E2E_STAGING_PROJECT_REF !== STAGING_REF) {
  fail(`Teardown hanya boleh ke staging ${STAGING_REF}.`);
}
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) fail('Set SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY.');
let hostname;
try {
  hostname = new URL(url).hostname;
} catch {
  fail(`SUPABASE_URL tidak valid: ${url}`);
}
if (hostname !== STAGING_HOST) fail(`Menolak teardown: host ${hostname} bukan staging ${STAGING_HOST}.`);

const manifestPath = process.env.E2E_FIXTURE_MANIFEST;
if (!manifestPath || !fs.existsSync(manifestPath)) fail(`E2E_FIXTURE_MANIFEST tidak ditemukan: ${manifestPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.projectRef !== STAGING_REF) fail(`Manifest ref ${manifest.projectRef} bukan staging.`);
if (!/^[a-z0-9]{4,12}$/.test(manifest.runId ?? '')) fail(`Manifest runId tidak valid.`);
for (const project of ['desktop', 'mobile']) {
  const outlet = manifest.outlets?.[project];
  if (!outlet?.id || outlet.code !== `e2e-${manifest.runId}-${project}`) {
    fail(`Manifest outlet ${project} tidak cocok pola disposable run ${manifest.runId}.`);
  }
}

const db = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const encoder = new TextEncoder();
async function scopeKey(scope, value) {
  const key = await webcrypto.subtle.importKey('raw', encoder.encode(serviceRoleKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await webcrypto.subtle.sign('HMAC', key, encoder.encode(`${scope}\0${value}`));
  return `${scope}:${Buffer.from(digest).toString('hex')}`;
}
async function publicOptionsKey(ip) {
  const key = await webcrypto.subtle.importKey('raw', encoder.encode(serviceRoleKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await webcrypto.subtle.sign('HMAC', key, encoder.encode(`public-options\0${ip}`));
  return `public_options:${Buffer.from(digest).toString('hex')}`;
}

const profileIds = [];
const usernames = [];
for (const project of ['desktop', 'mobile']) {
  for (const kind of ['lifecycle', 'journey', 'onboarding', 'investor']) {
    const u = manifest.users?.[project]?.[kind];
    if (!u?.id || !u?.username) fail(`Manifest user ${project}/${kind} tidak lengkap.`);
    profileIds.push(u.id);
    usernames.push(u.username);
  }
}
const outletIds = [manifest.outlets.desktop.id, manifest.outlets.mobile.id];
const ips = [
  manifest.clientIps?.desktop, manifest.clientIps?.mobile,
  process.env.E2E_FAILED_LOGIN_IP ?? '198.51.100.43',
  process.env.E2E_MOBILE_FAILED_LOGIN_IP ?? '198.51.100.45',
  '::1', '127.0.0.1', '::ffff:127.0.0.1', 'unknown',
].filter(Boolean);

// 1. Delete sessions; revoke devices (devices referenced by attendance_events
// cannot be deleted due to FK, so mark revoked_at instead).
{
  const { error } = await db.from('app_sessions').delete().in('profile_id', profileIds);
  if (error) throw error;
}
{
  const { error } = await db.from('app_devices').update({ revoked_at: new Date().toISOString() }).in('profile_id', profileIds).is('revoked_at', null);
  if (error) throw error;
}
// 2. Deactivate scopes.
{
  const { error } = await db.from('profile_outlet_scopes').update({ active: false }).in('profile_id', profileIds);
  if (error) throw error;
}
// 3. Deactivate profiles.
{
  const { error } = await db.from('profiles').update({ active: false, deactivated_at: new Date().toISOString() }).in('id', profileIds);
  if (error) throw error;
}
// 4. Clear rate limits for run credential/IP scopes.
{
  const keys = [];
  for (const u of [...usernames, 'e2e-no-such-user']) keys.push(await scopeKey('credential', u));
  for (const ip of ips) {
    keys.push(await scopeKey('ip', ip));
    keys.push(await publicOptionsKey(ip));
  }
  const { error } = await db.from('auth_rate_limits').delete().in('scope_key', keys);
  if (error) throw error;
}
// 5. Deactivate run outlets (verified disposable codes only).
{
  const { data, error } = await db.from('outlets').update({ active: false }).in('id', outletIds).select('id, code');
  if (error) throw error;
  for (const row of data ?? []) {
    if (row.code !== `e2e-${manifest.runId}-desktop` && row.code !== `e2e-${manifest.runId}-mobile`) {
      throw new Error(`BATAL: outlet tak terduga tersentuh: ${row.code}`);
    }
  }
  if ((data ?? []).length !== 2) fail(`Teardown outlet tidak lengkap: ${(data ?? []).length}/2.`);
}

// Verify.
{
  const { count: activeOutlets } = await db.from('outlets').select('id', { count: 'exact', head: true }).in('id', outletIds).eq('active', true);
  const { count: activeProfiles } = await db.from('profiles').select('id', { count: 'exact', head: true }).in('id', profileIds).eq('active', true);
  const { count: activeScopes } = await db.from('profile_outlet_scopes').select('profile_id', { count: 'exact', head: true }).in('profile_id', profileIds).eq('active', true);
  if ((activeOutlets ?? 0) !== 0 || (activeProfiles ?? 0) !== 0 || (activeScopes ?? 0) !== 0) {
    fail(`Verifikasi teardown gagal: outlets=${activeOutlets} profiles=${activeProfiles} scopes=${activeScopes}.`);
  }
}
console.log(`teardown ok run ${manifest.runId}: 2 outlets + 8 profiles deactivated, sessions/devices/rate-limits cleared, history preserved.`);
