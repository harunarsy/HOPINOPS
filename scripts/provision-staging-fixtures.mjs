// One-off staging fixture provisioning (not committed to CI usage).
// Run: node scripts/provision-staging-fixtures.mjs
import { createClient } from '@supabase/supabase-js';
import { randomBytes, webcrypto } from 'node:crypto';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error('Set SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY.');

const db = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const pinIterations = 310_000;
const encoder = new TextEncoder();

function isWeakPin(pin) {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  return ['000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999', '123456', '654321', '123123', '654654', '012345', '543210', '112233', '121212'].includes(pin);
}

async function hashPin(pin) {
  const salt = randomBytes(16).toString('base64');
  const key = await webcrypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const derived = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: pinIterations, hash: 'SHA-256' }, key, 512);
  return { salt, hash: Buffer.from(derived).toString('base64') };
}

const outletId = '11111111-1111-1111-1111-111111111111';
const pin = '741258';
if (isWeakPin(pin)) throw new Error('Weak PIN');

const users = [
  { username: 'e2e-owner', display_name: 'E2E OWNER', role: 'OWNER', job_title: 'OWNER' },
  { username: 'e2e-supervisor', display_name: 'E2E SUPERVISOR', role: 'SUPERVISOR', job_title: 'SUPERVISOR' },
  { username: 'e2e-operator', display_name: 'E2E OPERATOR', role: 'OPERATOR', job_title: 'BARISTA' },
  { username: 'e2e-operator2', display_name: 'E2E OPERATOR 2', role: 'OPERATOR', job_title: 'KITCHEN' },
  { username: 'e2e-investor', display_name: 'E2E INVESTOR', role: 'INVESTOR', job_title: 'INVESTOR' },
];

const { data: policy } = await db.from('compensation_policies').select('id').eq('outlet_id', outletId).maybeSingle();

for (const user of users) {
  const { data: existing } = await db.from('profiles').select('id').eq('username', user.username).maybeSingle();
  const profileId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    const { error } = await db.from('profiles').insert({
      id: profileId,
      username: user.username,
      display_name: user.display_name,
      job_title: user.job_title,
      role: user.role,
      active: true,
    });
    if (error) throw error;
  }
  const { salt, hash } = await hashPin(pin);
  const { error: credError } = await db.from('operator_credentials').upsert({
    profile_id: profileId,
    pin_salt: salt,
    pin_hash: hash,
    failed_attempts: 0,
    locked_until: null,
  }, { onConflict: 'profile_id' });
  if (credError) throw credError;
  const { error: scopeError } = await db.from('profile_outlet_scopes').upsert({
    profile_id: profileId,
    outlet_id: outletId,
    active: true,
  }, { onConflict: 'profile_id,outlet_id' });
  if (scopeError) throw scopeError;
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
