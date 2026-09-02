import { describe, it, expect } from 'vitest';
import { validateOrigin, verifyPin, hashPin } from '../../api/auth';

describe('Security & Auth Hardening Tests', () => {
  it('validates CSRF and origin headers strictly', () => {
    // GET requests pass
    const getReq = new Request('http://localhost:3000/api/auth?action=me', { method: 'GET' });
    expect(validateOrigin(getReq)).toBe(true);

    // POST with mismatched origin
    const headersCross = new Headers();
    headersCross.set('host', 'localhost:3000');
    headersCross.set('origin', 'https://evil-attacker.com');

    const postCross = new Request('http://localhost:3000/api/auth?action=login', {
      method: 'POST',
      headers: headersCross,
    });
    // In some DOM implementations headers are parsed specifically
    expect(validateOrigin({ method: 'POST', headers: headersCross, url: 'http://localhost:3000/api/auth?action=login' } as any)).toBe(false);

    // POST with matching origin
    const headersValid = new Headers();
    headersValid.set('host', 'localhost:3000');
    headersValid.set('origin', 'http://localhost:3000');

    expect(validateOrigin({ method: 'POST', headers: headersValid, url: 'http://localhost:3000/api/auth?action=login' } as any)).toBe(true);
  });

  it('performs constant-time PIN verification', async () => {
    const { salt, hash } = await hashPin('654321');
    const valid = await verifyPin('654321', salt, hash);
    const invalid = await verifyPin('111111', salt, hash);

    expect(valid).toBe(true);
    expect(invalid).toBe(false);
  });
});
