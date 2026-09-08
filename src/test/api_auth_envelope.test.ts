// @vitest-environment node
import { describe, it, expect } from 'vitest';
import appHandler from '../../api/app';

describe('API auth/dependency envelope (node Request preserves cookies)', () => {
  it('maps auth DB failures to a JSON 503 envelope instead of an unhandled rejection', async () => {
    // No SUPABASE_SERVICE_ROLE_KEY in unit env: session lookup must fail
    // inside the handler and surface as JSON, never as a rejected promise.
    const req = new Request('http://localhost/api/app?action=bootstrap', {
      method: 'GET',
      headers: { cookie: `hopin_session=${'a'.repeat(64)}` },
    });
    const res = await appHandler.fetch(req);
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(typeof data.request_id).toBe('string');
  });
});
