// scripts/test-concurrency-onboarding.mjs
// Parallel connection concurrency test for rpc_complete_onboarding (B04).
// Exercises two independent Supabase client connections issuing simultaneous completion requests.
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required.');
  process.exit(1);
}

// Two distinct client instances (separate HTTP agent / connection pools)
const clientA = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const clientB = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const outletId = '11111111-1111-1111-1111-111111111111';

async function run() {
  console.log('--- Concurrency Test: rpc_complete_onboarding (B04) ---');

  // Generate unique disposable actor ID for this run (preserves append-only audit immutability)
  const testActorId = crypto.randomUUID();
  const testUsername = `test-conc-${Date.now().toString(36)}`;

  console.log('1. Inserting profile...');
  const { error: profileErr } = await clientA.from('profiles').insert({
    id: testActorId,
    username: testUsername,
    display_name: 'Test Concurrency Operator',
    role: 'OPERATOR',
    job_title: 'TEST',
    active: true,
  });
  if (profileErr) throw profileErr;

  console.log('2. Inserting scope...');
  const { error: scopeErr } = await clientA.from('profile_outlet_scopes').insert({
    profile_id: testActorId,
    outlet_id: outletId,
    active: true,
  });
  if (scopeErr) throw scopeErr;

  console.log('3. Reading settings...');
  // Get current outlet onboarding version
  const { data: settings, error: setErr } = await clientA
    .from('outlet_settings')
    .select('onboarding_version')
    .eq('outlet_id', outletId)
    .single();
  if (setErr) throw setErr;
  const targetVersion = settings.onboarding_version;

  console.log(`4. Firing 2 concurrent completions for actor ${testActorId} on version ${targetVersion}...`);

  // Parallel execution across two independent client connections
  const [resA, resB] = await Promise.all([
    clientA.rpc('rpc_complete_onboarding', {
      p_actor_id: testActorId,
      p_outlet_id: outletId,
      p_onboarding_version: targetVersion,
    }),
    clientB.rpc('rpc_complete_onboarding', {
      p_actor_id: testActorId,
      p_outlet_id: outletId,
      p_onboarding_version: targetVersion,
    }),
  ]);

  if (resA.error) throw new Error(`Client A failed: ${resA.error.message}`);
  if (resB.error) throw new Error(`Client B failed: ${resB.error.message}`);

  const replayFlags = [resA.data.idempotent_replay, resB.data.idempotent_replay].sort();
  console.log(`Results: Client A replay=${resA.data.idempotent_replay}, Client B replay=${resB.data.idempotent_replay}`);

  // Exactly one must be false (initial insert) and one must be true (idempotent replay)
  if (replayFlags[0] !== false || replayFlags[1] !== true) {
    throw new Error(`Expected exactly one false and one true replay flag, got: ${JSON.stringify(replayFlags)}`);
  }

  // Check DB rows: exactly 1 completion row
  const { data: progressRows, error: pErr } = await clientA
    .from('onboarding_progress')
    .select('*')
    .eq('profile_id', testActorId);
  if (pErr) throw pErr;

  if (progressRows.length !== 1) {
    throw new Error(`Expected exactly 1 progress row, found ${progressRows.length}`);
  }
  console.log(`Verified: Exactly 1 onboarding_progress row persisted (completed_at: ${progressRows[0].completed_at})`);

  // Check audit log: exactly 1 audit event
  const { data: auditEvents, error: aErr } = await clientA
    .from('audit_events')
    .select('*')
    .eq('actor_user_id', testActorId)
    .eq('action', 'COMPLETE_ONBOARDING');
  if (aErr) throw aErr;

  if (auditEvents.length !== 1) {
    throw new Error(`Expected exactly 1 COMPLETE_ONBOARDING audit event, found ${auditEvents.length}`);
  }
  console.log(`Verified: Exactly 1 audit event recorded atomically.`);

  console.log('Testing B04 lifetime replay with different version...');
  const clientC = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const resReplay = await clientC.rpc('rpc_complete_onboarding', {
    p_actor_id: testActorId,
    p_outlet_id: outletId,
    p_onboarding_version: 99,
  });
  console.log('Replay call completed:', resReplay.data);
  if (resReplay.error) throw new Error(`Replay failed: ${resReplay.error.message}`);
  if (resReplay.data.idempotent_replay !== true) {
    throw new Error(`Expected idempotent_replay: true for B04 lifetime replay, got: ${resReplay.data.idempotent_replay}`);
  }
  console.log(`Verified: B04 Lifetime Replay succeeded with different version 99 (idempotent_replay=true).`);

  console.log('Deactivating test profile...');
  await clientA.from('profiles').update({ active: false, deactivated_at: new Date().toISOString() }).eq('id', testActorId);
  console.log('Deactivated test profile.');

  console.log('--- Concurrency test PASSED successfully ---');
}

run().catch((err) => {
  console.error('Concurrency test FAILED:', err);
  process.exit(1);
});
