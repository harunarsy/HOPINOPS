import { createClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import readline from 'node:readline/promises';
import process from 'node:process';

const roles = ['OPERATOR', 'SUPERVISOR', 'ADMIN', 'INVESTOR', 'OWNER'];
const pinIterations = 310_000;
const encoder = new TextEncoder();
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith('--')) continue;
  args.set(key.slice(2), process.argv[index + 1] ?? '');
  index += 1;
}
if (args.has('pin')) throw new Error('PIN tidak boleh diberikan sebagai command-line argument.');

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error('Set SUPABASE_URL (atau VITE_SUPABASE_URL) dan SUPABASE_SERVICE_ROLE_KEY terlebih dahulu.');
}

const db = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (key, label, fallback = '') => {
  const value = await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `);
  return (value.trim() || fallback).trim();
};

function askPin(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Provisioning harus dijalankan dari terminal interaktif agar PIN tidak tampil.');

  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk) => {
      const input = chunk.toString();
      if (input === '\u0003') {
        cleanup();
        reject(new Error('Dibatalkan.'));
        return;
      }
      if (input === '\r' || input === '\n') {
        process.stdout.write('\n');
        cleanup();
        resolve(value);
        return;
      }
      if (input === '\u007f') {
        if (value) value = value.slice(0, -1);
        return;
      }
      if (/^\d$/.test(input) && value.length < 6) {
        value += input;
        process.stdout.write('*');
      }
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdout.write(`${label}: `);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function hashPin(pin) {
  const salt = randomBytes(16).toString('base64');
  const key = await webcrypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const derived = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: pinIterations, hash: 'SHA-256' }, key, 512);
  return { salt, hash: Buffer.from(derived).toString('base64') };
}

try {
  const username = (args.get('username') || await ask('username', 'Username lowercase')).toLowerCase();
  const displayName = args.get('display-name') || await ask('display-name', 'Nama tampilan uppercase');
  const jobTitle = args.get('job-title') || await ask('job-title', 'Jabatan');
  const role = (args.get('role') || await ask('role', `Role (${roles.join(' / ')})`)).toUpperCase();

  if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(username)) throw new Error('Username harus 2-31 karakter: a-z, angka, titik, underscore, atau strip.');
  if (!displayName || displayName.length > 80) throw new Error('Nama tampilan wajib diisi dan maksimal 80 karakter.');
  if (!jobTitle || jobTitle.length > 80) throw new Error('Jabatan wajib diisi dan maksimal 80 karakter.');
  if (!roles.includes(role)) throw new Error(`Role tidak valid. Pilih: ${roles.join(', ')}.`);

  const pin = await askPin('PIN 6 digit');
  if (!/^\d{6}$/.test(pin)) throw new Error('PIN harus tepat 6 digit.');

  const { data: existing, error: lookupError } = await db
    .from('profiles')
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (lookupError) throw lookupError;

  const profileId = existing?.id ?? randomUUID();
  const { error: profileError } = await db.from('profiles').upsert({
    id: profileId,
    username,
    display_name: displayName,
    job_title: jobTitle,
    role,
    active: true,
  }, { onConflict: 'id' });
  if (profileError) throw profileError;

  const { salt, hash } = await hashPin(pin);
  const { error: credentialError } = await db.from('operator_credentials').upsert({
    profile_id: profileId,
    pin_salt: salt,
    pin_hash: hash,
    failed_attempts: 0,
    locked_until: null,
  }, { onConflict: 'profile_id' });
  if (credentialError) {
    if (!existing) await db.from('profiles').delete().eq('id', profileId);
    throw credentialError;
  }

  console.log(`${existing ? 'Updated' : 'Created'} user ${username} (${displayName}, ${role}).`);
} finally {
  rl.close();
}
