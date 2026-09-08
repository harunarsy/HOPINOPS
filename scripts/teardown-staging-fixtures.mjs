// Logical teardown for one disposable E2E run on pinned staging only.
// Ownership is fully verified before the first write. History is preserved.
import { createClient } from '@supabase/supabase-js';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';

const STAGING_REF = 'ibzlxdmnuszcmdzuocwu';
const STAGING_HOST = `${STAGING_REF}.supabase.co`;
const PROJECTS = ['desktop', 'mobile'];
const KINDS = ['lifecycle', 'journey', 'onboarding', 'investor'];

function fail(message) {
  throw new Error(message);
}

if (process.env.E2E_MUTATIONS !== '1') fail('Teardown memerlukan E2E_MUTATIONS=1 eksplisit.');
if (process.env.E2E_STAGING_PROJECT_REF !== STAGING_REF) fail(`Teardown hanya boleh ke staging ${STAGING_REF}.`);
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
if (!/^[a-z0-9]{4,12}$/.test(manifest.runId ?? '')) fail('Manifest runId tidak valid.');

const outletIds = [];
const profileIds = [];
const usernames = [];
const expectedOutletByProfile = new Map();
for (const project of PROJECTS) {
  const outlet = manifest.outlets?.[project];
  if (!outlet?.id || outlet.code !== `e2e-${manifest.runId}-${project}`) {
    fail(`Manifest outlet ${project} tidak cocok pola disposable run ${manifest.runId}.`);
  }
  outletIds.push(outlet.id);
  for (const kind of KINDS) {
    const user = manifest.users?.[project]?.[kind];
    const expectedUsername = `e2e-${manifest.runId}-${project === 'desktop' ? 'd' : 'm'}-${kind}`;
    if (!user?.id || user.username !== expectedUsername) {
      fail(`Manifest user ${project}/${kind} tidak cocok fixture disposable ${expectedUsername}.`);
    }
    profileIds.push(user.id);
    usernames.push(user.username);
    expectedOutletByProfile.set(user.id, outlet.id);
  }
}
if (new Set(outletIds).size !== 2) fail('Manifest harus memuat tepat 2 outlet unik.');
if (new Set(profileIds).size !== 8 || new Set(usernames).size !== 8) fail('Manifest harus memuat tepat 8 profile ID dan username unik.');

const db = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

// Read-only ownership preflight. Every condition must pass before any write.
const { data: outlets, error: outletsError } = await db.from('outlets').select('id, code').in('id', outletIds);
if (outletsError) throw outletsError;
if ((outlets ?? []).length !== 2) fail(`Teardown outlet tidak lengkap: ${(outlets ?? []).length}/2.`);
for (const outlet of outlets) {
  const project = outlet.code === `e2e-${manifest.runId}-desktop` ? 'desktop' : outlet.code === `e2e-${manifest.runId}-mobile` ? 'mobile' : null;
  if (!project || manifest.outlets[project].id !== outlet.id) fail(`BATAL: outlet manifest bukan milik run: ${outlet.code}`);
}

const { data: profiles, error: profilesError } = await db.from('profiles').select('id, username').in('id', profileIds);
if (profilesError) throw profilesError;
if ((profiles ?? []).length !== 8) fail(`Teardown profile tidak lengkap: ${(profiles ?? []).length}/8.`);
for (const profile of profiles) {
  const manifestUser = PROJECTS.flatMap((project) => KINDS.map((kind) => manifest.users[project][kind])).find((user) => user.id === profile.id);
  if (!manifestUser || profile.username !== manifestUser.username) fail(`BATAL: profile manifest bukan milik run: ${profile.id}`);
}

const { data: scopes, error: scopesError } = await db.from('profile_outlet_scopes').select('profile_id, outlet_id, active').in('profile_id', profileIds);
if (scopesError) throw scopesError;
const activeScopeByProfile = new Map();
for (const scope of scopes ?? []) {
  if (!profileIds.includes(scope.profile_id)) fail(`BATAL: scope profile tak terduga ${scope.profile_id}`);
  if (scope.active) {
    if (scope.outlet_id !== expectedOutletByProfile.get(scope.profile_id)) {
      fail(`BATAL: profile ${scope.profile_id} memiliki active scope di luar outlet disposable.`);
    }
    if (activeScopeByProfile.has(scope.profile_id)) fail(`BATAL: profile ${scope.profile_id} memiliki lebih dari satu active scope.`);
    activeScopeByProfile.set(scope.profile_id, scope.outlet_id);
  }
}
if (activeScopeByProfile.size !== 8) fail(`BATAL: scope aktif fixture tidak lengkap: ${activeScopeByProfile.size}/8.`);

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

const ips = [
  manifest.clientIps?.desktop,
  manifest.clientIps?.mobile,
  process.env.E2E_FAILED_LOGIN_IP ?? '198.51.100.43',
  process.env.E2E_MOBILE_FAILED_LOGIN_IP ?? '198.51.100.45',
  '::1', '127.0.0.1', '::ffff:127.0.0.1', 'unknown',
].filter(Boolean);

const { error: sessionError } = await db.from('app_sessions').delete().in('profile_id', profileIds);
if (sessionError) throw sessionError;
const { error: devicesError } = await db.from('app_devices').update({ revoked_at: new Date().toISOString() }).in('profile_id', profileIds).is('revoked_at', null);
if (devicesError) throw devicesError;
const { error: scopeDeactivateError } = await db.from('profile_outlet_scopes').update({ active: false }).in('profile_id', profileIds);
if (scopeDeactivateError) throw scopeDeactivateError;
const { error: profileDeactivateError } = await db.from('profiles').update({ active: false, deactivated_at: new Date().toISOString() }).in('id', profileIds);
if (profileDeactivateError) throw profileDeactivateError;

const keys = [];
for (const username of [...usernames, 'e2e-no-such-user']) keys.push(await scopeKey('credential', username));
for (const ip of ips) {
  keys.push(await scopeKey('ip', ip));
  keys.push(await publicOptionsKey(ip));
}
const { error: rateLimitError } = await db.from('auth_rate_limits').delete().in('scope_key', keys);
if (rateLimitError) throw rateLimitError;
const { error: outletDeactivateError } = await db.from('outlets').update({ active: false }).in('id', outletIds);
if (outletDeactivateError) throw outletDeactivateError;

const { count: activeOutlets, error: activeOutletsError } = await db.from('outlets').select('id', { count: 'exact', head: true }).in('id', outletIds).eq('active', true);
if (activeOutletsError) throw activeOutletsError;
const { count: activeProfiles, error: activeProfilesError } = await db.from('profiles').select('id', { count: 'exact', head: true }).in('id', profileIds).eq('active', true);
if (activeProfilesError) throw activeProfilesError;
const { count: activeScopes, error: activeScopesError } = await db.from('profile_outlet_scopes').select('profile_id', { count: 'exact', head: true }).in('profile_id', profileIds).eq('active', true);
if (activeScopesError) throw activeScopesError;
if ((activeOutlets ?? 0) !== 0 || (activeProfiles ?? 0) !== 0 || (activeScopes ?? 0) !== 0) {
  fail(`Verifikasi teardown gagal: outlets=${activeOutlets} profiles=${activeProfiles} scopes=${activeScopes}.`);
}
console.log(`teardown ok run ${manifest.runId}: 2 outlets + 8 profiles deactivated, sessions/devices/rate-limits cleared, history preserved.`);
