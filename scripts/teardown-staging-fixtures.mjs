// Ownership is fully verified before the first write. History is preserved.
import { createClient } from '@supabase/supabase-js';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import { loadStagingEnv } from './staging-runtime.mjs';

const PROJECTS = ['desktop', 'mobile'];
const KINDS = ['lifecycle', 'journey', 'onboarding', 'supervisor', 'investor'];

function fail(message) {
  throw new Error(message);
}

const configuredProjectRef = String(process.env.E2E_STAGING_PROJECT_REF ?? process.env.HOPIN_STAGING_PROJECT_REF ?? '').trim().toLowerCase();
if (!/^[a-z0-9]{20}$/.test(configuredProjectRef) || configuredProjectRef === 'naanarmoktmsumkxmjvj') {
  fail('Teardown wajib memakai project staging 20 karakter yang bukan production.');
}
const stagingEnv = loadStagingEnv({ HOPIN_STAGING_PROJECT_REF: configuredProjectRef });
const url = stagingEnv.SUPABASE_URL;
const serviceRoleKey = stagingEnv.SUPABASE_SERVICE_ROLE_KEY;
const target = { projectRef: stagingEnv.HOPIN_STAGING_PROJECT_REF };

const manifestPath = process.env.E2E_FIXTURE_MANIFEST;
if (!manifestPath || !fs.existsSync(manifestPath)) fail(`E2E_FIXTURE_MANIFEST tidak ditemukan: ${manifestPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.projectRef !== target.projectRef) fail('Manifest ref bukan project staging aktif.');
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
if (new Set(profileIds).size !== 10 || new Set(usernames).size !== 10) fail('Manifest harus memuat tepat 10 profile ID dan username unik.');

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
if ((profiles ?? []).length !== 10) fail(`Teardown profile tidak lengkap: ${(profiles ?? []).length}/10.`);
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
if (activeScopeByProfile.size !== 10) fail(`BATAL: scope aktif fixture tidak lengkap: ${activeScopeByProfile.size}/10.`);

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
  manifest.clientIps?.manager ?? '198.51.100.46',
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
console.log(`teardown ok run ${manifest.runId}: 2 outlets + 10 profiles deactivated, sessions/devices/rate-limits cleared, history preserved.`);
