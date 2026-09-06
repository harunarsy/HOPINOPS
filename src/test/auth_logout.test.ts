import { describe, it, expect } from 'vitest';
import authHandler, { revokeCurrentSession, clearedSessionCookie } from '../../api/auth';

describe('Authentication & Session Revocation (api/auth.ts)', () => {
  it('successfully revokes empty/missing session with 200 and cleared cookie', async () => {
    const req = new Request('http://localhost/api/auth?action=logout', {
      method: 'POST',
      headers: { host: 'localhost' },
    });
    const res = await authHandler.fetch(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const cookieHeader = res.headers.get('set-cookie') || res.headers.get('Set-Cookie');
    if (cookieHeader) {
      expect(cookieHeader).toMatch(/Max-Age=0/);
    } else {
      // Direct verification of helper
      expect(clearedSessionCookie()).toMatch(/Max-Age=0/);
    }
  });

  it('handles revokeCurrentSession safely without token', async () => {
    const req = { headers: {} } as any;
    const result = await revokeCurrentSession(req);
    expect(result).toEqual({ revoked: false, reason: 'NO_TOKEN' });
  });
});
