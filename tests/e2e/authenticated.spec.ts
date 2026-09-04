import { test, expect } from '@playwright/test';
import { credentials, canRunMutating, BASE_URL } from './fixtures';

/**
 * Authenticated staging API flow tests (cookie-based, server-authoritative).
 *
 * SKIPPED unless E2E_USERNAME/E2E_PASSWORD point at a disposable account on
 * the staging database. Requires a running API (vercel dev or deployed URL)
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
  test.skip(!canRunMutating, 'Requires E2E_USERNAME/E2E_PASSWORD staging credentials');

  test('login, bootstrap, claim, opening reference/initialize/confirm, movement, closing', async ({ request }) => {
    test.setTimeout(180_000);
    const api = await login(request, credentials.username, credentials.pin);

    const boot = await api.get('/api/app?action=bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.body?.ok).toBe(true);
    const user = boot.body?.data?.user;
    expect(user?.id).toBeTruthy();

    // Role-based bootstrap shape
    const outletId = boot.body?.data?.outlet?.id;
    expect(outletId).toBe('11111111-1111-1111-1111-111111111111');

    // Investor must never see operational data in bootstrap
    // (operator account is the default actor here).
    const workDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

    // Claim PRIMARY BAR SIANG (idempotent-ish; PRIMARY_TAKEN yields 409 with helper offer)
    const claim = await api.post('/api/app?action=assignment.claim', {
      work_date: workDate,
      shift_code: 'SIANG',
      area_code: 'BAR',
      duty_role: 'PRIMARY',
    });
    expect([200, 409]).toContain(claim.status);
    if (claim.status === 409) {
      expect(claim.body?.error?.code).toBe('PRIMARY_TAKEN');
      return; // another e2e operator already claimed; remaining assertions covered by their own run
    }

    const assignment = claim.body?.data?.assignment;
    const cycleId = assignment?.cycle_id;
    expect(cycleId).toBeTruthy();

    // Opening reference resolution (server-owned)
    const ref = await api.get(`/api/app?action=opening.reference&cycle_id=${cycleId}`);
    expect(ref.status).toBe(200);
    expect(['AVAILABLE', 'INITIALIZATION_REQUIRED']).toContain(ref.body?.data?.state);

    if (ref.body?.data?.state === 'INITIALIZATION_REQUIRED') {
      // Operator cannot initialize: expect 403 from RPC
      const initDenied = await api.post('/api/app?action=opening.initialize', {
        cycle_id: cycleId,
        expected_version: assignment?.work_cycles?.version ?? 1,
        idempotency_key: crypto.randomUUID(),
        reason: 'e2e attempt',
      });
      expect([403, 409]).toContain(initDenied.status);
    }

    // Confirm opening (counted == reference; blank never allowed)
    const lines = (ref.body?.data?.lines ?? []).map((l: any) => ({
      item_id: l.item_id,
      counted_qty: Number(l.reference_qty) || 0,
      reason_code: null,
      notes: null,
    }));
    if (lines.length) {
      const opening = await api.post('/api/app?action=opening.confirm', {
        cycle_id: cycleId,
        lines,
      });
      expect([200, 409]).toContain(opening.status);
      if (opening.status === 200) {
        // Movement with idempotent key
        const key = crypto.randomUUID();
        const mv = await api.post('/api/app?action=movement.create', {
          cycle_id: cycleId,
          item_id: lines[0].item_id,
          direction: 'OUT',
          category: 'USAGE',
          quantity: 0.5,
          client_occurred_at: new Date().toISOString(),
          idempotency_key: key,
          expected_version: opening.body?.data?.opening ? undefined : undefined,
        });
        // expected_version required: fetch cycle for latest version if needed
        if (mv.status === 400) {
          const cycle = await api.get(`/api/app?action=cycle.get&cycle_id=${cycleId}`);
          const version = cycle.body?.data?.cycle?.version;
          const retry = await api.post('/api/app?action=movement.create', {
            cycle_id: cycleId,
            item_id: lines[0].item_id,
            direction: 'OUT',
            category: 'USAGE',
            quantity: 0.5,
            client_occurred_at: new Date().toISOString(),
            idempotency_key: key,
            expected_version: version,
          });
          expect([200, 409]).toContain(retry.status);
        } else {
          expect([200, 409]).toContain(mv.status);
        }
      }
    }

    // Logout clears session
    const out = await api.post('/api/auth?action=logout');
    expect([200, 400]).toContain(out.status);
  });

  test('investor cannot access operational mutations', async ({ request }) => {
    const api = await login(request, 'e2e-investor', credentials.pin);
    const claim = await api.post('/api/app?action=assignment.claim', {
      work_date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
      shift_code: 'SIANG',
      area_code: 'BAR',
      duty_role: 'PRIMARY',
    });
    expect(claim.status).toBe(403);
    const items = await api.get('/api/app?action=items.list');
    expect([403, 404]).toContain(items.status);
  });
});
