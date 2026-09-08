import { test, expect } from '@playwright/test';
import {
  BASE_URL,
  requireMutatingStaging,
  getProjectOutletId,
  getOnboardingUsername,
  getInvestorUsernameForProject,
} from './fixtures';

/**
 * Authenticated staging API flow tests (cookie-based, server-authoritative).
 *
 * Requires E2E_MUTATIONS=1, an allowlisted staging URL, and disposable credentials
 * on the staging database. Requires a running API (vercel dev or deployed URL)
 * because Vercel functions do not exist in plain `vite preview`.
 */

type Api = {
  get: (path: string) => Promise<{ status: number; body: any }>;
  post: (path: string, payload?: unknown) => Promise<{ status: number; body: any }>;
};

async function login(request: any, username: string, pin: string): Promise<Api> {
  const loginRes = await request.post(`${BASE_URL}/api/auth?action=login`, {
    data: { username, pin },
  });
  if (loginRes.status() !== 200) {
    throw new Error(`login failed: ${loginRes.status()} ${await loginRes.text()}`);
  }
  return {
    get: async (path) => {
      const res = await request.get(`${BASE_URL}${path}`);
      let body: any = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status(), body };
    },
    post: async (path, payload) => {
      const res = await request.post(`${BASE_URL}${path}`, { data: payload ?? {} });
      let body: any = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status(), body };
    },
  };
}

test.describe('Authenticated staging API flows', () => {
  test('login, bootstrap, claim, physical baseline, opening, movement', async ({ request }, testInfo) => {
    test.setTimeout(180_000);
    const selected = requireMutatingStaging(testInfo.project.name);
    const api = await login(request, selected.username, selected.pin);

    const boot = await api.get('/api/app?action=bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.body?.ok).toBe(true);
    const user = boot.body?.data?.user;
    expect(user?.id).toBeTruthy();

    // Outlet terisolasi per project via manifest; fallback ke outlet utama bila tanpa manifest.
    const outletId = boot.body?.data?.outlet?.id;
    const expectedOutletId = getProjectOutletId(testInfo.project.name) ?? '11111111-1111-1111-1111-111111111111';
    expect(outletId).toBe(expectedOutletId);

    const workDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

    // Claim PRIMARY BAR SIANG pada outlet fresh — wajib 200, bukan 409.
    const claim = await api.post('/api/app?action=assignment.claim', {
      work_date: workDate,
      shift_code: 'SIANG',
      area_code: 'BAR',
      duty_role: 'PRIMARY',
    });
    expect(claim.status, `PRIMARY claim gagal pada outlet fresh: ${JSON.stringify(claim.body)}`).toBe(200);

    const assignment = claim.body?.data?.assignment;
    const cycleId = assignment?.cycle_id;
    expect(cycleId).toBeTruthy();

    // Outlet fresh wajib INITIALIZATION_REQUIRED (tanpa histori handover/closing).
    let ref = await api.get(`/api/app?action=opening.reference&cycle_id=${cycleId}`);
    expect(ref.status).toBe(200);
    expect(ref.body?.data?.state).toBe('INITIALIZATION_REQUIRED');
    expect((ref.body?.data?.missing_item_ids ?? []).length).toBeGreaterThan(0);

    const cycleBefore = await api.get(`/api/app?action=cycle.get&cycle_id=${cycleId}`);
    expect(cycleBefore.status).toBe(200);
    const cycleVersion = cycleBefore.body?.data?.cycle?.version ?? claim.body?.data?.cycle?.version ?? 1;
    expect(cycleVersion).toBeGreaterThan(0);

    const baseline = await api.post('/api/app?action=cycle.baseline.record', {
      cycle_id: cycleId,
      expected_version: cycleVersion,
      lines: (ref.body?.data?.lines ?? []).map((line: any) => ({ item_id: line.item_id, counted_qty: 1 })),
      reason: 'e2e physical count',
      idempotency_key: crypto.randomUUID(),
    });
    expect(baseline.status, `Baseline fisik gagal: ${JSON.stringify(baseline.body)}`).toBe(200);

    ref = await api.get(`/api/app?action=opening.reference&cycle_id=${cycleId}`);
    expect(ref.status).toBe(200);
    expect(ref.body?.data?.state).toBe('AVAILABLE');

    // Confirm opening (counted == reference; blank never allowed)
    const lines = (ref.body?.data?.lines ?? []).map((l: any) => ({
      item_id: l.item_id,
      counted_qty: Number(l.reference_qty) || 0,
      reason_code: null,
      notes: null,
    }));
    expect(lines.length, 'Staging cycle must expose checklist lines for the opening flow.').toBeGreaterThan(0);
    const opening = await api.post('/api/app?action=opening.confirm', {
      cycle_id: cycleId,
      lines,
    });
    expect(opening.status, `Opening confirm gagal: ${JSON.stringify(opening.body)}`).toBe(200);

    const cycle = await api.get(`/api/app?action=cycle.get&cycle_id=${cycleId}`);
    expect(cycle.status).toBe(200);
    const version = cycle.body?.data?.cycle?.version;
    expect(version).toBeGreaterThan(0);

    const mv = await api.post('/api/app?action=movement.create', {
      cycle_id: cycleId,
      item_id: lines[0].item_id,
      direction: 'OUT',
      category: 'USAGE',
      quantity: 0.5,
      client_occurred_at: new Date().toISOString(),
      idempotency_key: crypto.randomUUID(),
      expected_version: version,
    });
    expect(mv.status, `Movement gagal: ${JSON.stringify(mv.body)}`).toBe(200);

    // Logout clears session
    const out = await api.post('/api/auth?action=logout');
    expect(out.status).toBe(200);
  });

  test('investor cannot access operational mutations', async ({ request }, testInfo) => {
    const selected = requireMutatingStaging(testInfo.project.name);
    const api = await login(request, getInvestorUsernameForProject(testInfo.project.name), selected.pin);
    const claim = await api.post('/api/app?action=assignment.claim', {
      work_date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
      shift_code: 'SIANG',
      area_code: 'BAR',
      duty_role: 'PRIMARY',
    });
    expect(claim.status).toBe(403);
    const items = await api.get('/api/app?action=items.list');
    expect([403, 404]).toContain(items.status);

    // Investor cannot record a physical baseline
    const baselineDenied = await api.post('/api/app?action=cycle.baseline.record', {
      cycle_id: '00000000-0000-0000-0000-000000000000',
      expected_version: 1,
      lines: [{ item_id: 'missing', counted_qty: 1 }],
      idempotency_key: crypto.randomUUID(),
      reason: 'investor attempt',
    });
    expect(baselineDenied.status).toBe(403);
  });

  test('server-authoritative logout revokes session and subsequent requests fail with 401', async ({ request, playwright }, testInfo) => {
    const selected = requireMutatingStaging(testInfo.project.name);
    const api = await login(request, selected.username, selected.pin);
    const oldState = await request.storageState();

    // Verify session is active
    const bootBefore = await api.get('/api/app?action=bootstrap');
    expect(bootBefore.status).toBe(200);

    // Logout
    const out = await api.post('/api/auth?action=logout');
    expect(out.status).toBe(200);
    expect(out.body?.ok).toBe(true);

    // Subsequent protected requests must be rejected with 401
    const bootAfter = await api.get('/api/app?action=bootstrap');
    expect(bootAfter.status).toBe(401);
    expect(bootAfter.body?.error?.code).toBe('AUTH_REQUIRED');

    const fresh = await playwright.request.newContext({ baseURL: BASE_URL, storageState: oldState });
    const oldCookieBoot = await fresh.get(`${BASE_URL}/api/app?action=bootstrap`);
    expect(oldCookieBoot.status()).toBe(401);
    await fresh.dispose();

    // Repeated logout must be safe and idempotent
    const outRepeat = await api.post('/api/auth?action=logout');
    expect(outRepeat.status).toBe(200);
  });

  test('enforces B04 once-only onboarding and rejects invalid payload', async ({ request }, testInfo) => {
    const selected = requireMutatingStaging(testInfo.project.name);
    const onboardingUsername = getOnboardingUsername(testInfo.project.name) ?? process.env.E2E_ONBOARDING_USERNAME ?? 'e2e-operator2';
    const api = await login(request, onboardingUsername, selected.pin);

    // 1. Invalid payload rejected with 400
    const invalidPayload = await api.post('/api/app?action=onboarding.complete', { version: -5 });
    expect(invalidPayload.status).toBe(400);

    // 2. Complete onboarding with valid version
    const completeRes = await api.post('/api/app?action=onboarding.complete', { version: 1 });
    expect(completeRes.status).toBe(200);
    expect(completeRes.body?.ok).toBe(true);

    // 3. Lifetime replay (B04): calling again with version 99 returns existing completion as replay
    const replayRes = await api.post('/api/app?action=onboarding.complete', { version: 99 });
    expect(replayRes.status).toBe(200);
    expect(replayRes.body?.data?.idempotent_replay).toBe(true);

    await api.post('/api/auth?action=logout');
  });
});
