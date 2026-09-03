import { describe, it, expect } from 'vitest';
import appHandler from '../../api/app';

describe('Production Business API Dispatcher (api/app.ts)', () => {
  it('rejects requests without an action parameter with 404', async () => {
    const req = new Request('http://localhost/api/app', { method: 'GET' });
    const res = await appHandler.fetch(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe('NOT_FOUND');
  });

  it('rejects cross-site origins with 403 CSRF Protection', async () => {
    const headers = new Headers();
    headers.set('origin', 'https://evil-attacker.com');
    headers.set('host', 'hopinops.vercel.app');
    const req = {
      method: 'POST',
      url: 'https://hopinops.vercel.app/api/app?action=bootstrap',
      headers,
    } as any;
    const res = await appHandler.fetch(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe('ORIGIN_REJECTED');
  });

  it('rejects unauthenticated requests to protected endpoints with 401', async () => {
    const req = new Request('http://localhost/api/app?action=bootstrap', {
      method: 'GET',
    });
    const res = await appHandler.fetch(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBe('AUTH_REQUIRED');
  });

  it('has zero imports from ./auth (strictly self-contained)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const appTs = fs.readFileSync(path.resolve(__dirname, '../../api/app.ts'), 'utf8');
    expect(appTs).not.toContain("from './auth'");
    expect(appTs).not.toContain('from "./auth"');
    expect(appTs).not.toContain("import('./auth')");
  });
});
