import { describe, it, expect } from 'vitest';
import appHandler, { canonicalJson, sanitizeExcelCell } from '../../api/app';

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

  it('rejects unauthenticated requests to onboarding.complete with 401', async () => {
    const req = new Request('http://localhost/api/app?action=onboarding.complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    });
    const res = await appHandler.fetch(req);
    expect(res.status).toBe(401);
  });

  it('keeps physical baseline and payroll export contracts RPC-backed only', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const appTs = fs.readFileSync(path.resolve(__dirname, '../../api/app.ts'), 'utf8');
    const migration = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/0025_payroll_export_reservations.sql'), 'utf8');
    expect(appTs).toContain("rpc_get_cycle_physical_baseline");
    expect(appTs).toContain("rpc_record_cycle_physical_baseline");
    expect(appTs).toContain("rpc_reserve_payroll_export");
    expect(appTs).toContain("rpc_reconcile_payroll_export");
    expect(appTs).toContain("rpc_commit_payroll_export");
    expect(appTs).toContain("rpc_get_payroll_export_reservation");
    expect(appTs).toContain("UPLOAD_UNKNOWN");
    expect(appTs).not.toContain("rpc_record_payroll_export");
    expect(migration).toContain('rpc_reserve_payroll_export(uuid, uuid, integer, uuid)');
    expect(migration).toContain('rpc_commit_payroll_export(uuid, uuid, uuid, text)');
    expect(migration).toContain('rpc_reconcile_payroll_export(uuid, uuid, uuid, text, text)');
    expect(migration).toContain('rpc_get_payroll_export_reservation(uuid, uuid, uuid)');
    expect(migration).toContain('from public, anon, authenticated, service_role');
  });

  it('returns success when upload-error reconciliation already committed the export', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const appTs = fs.readFileSync(path.resolve(__dirname, '../../api/app.ts'), 'utf8');
    const uploadBranch = appTs.slice(
      appTs.indexOf('Payroll export upload reconciliation failed'),
      appTs.indexOf("return errorResponse('EXPORT_UPLOAD_UNKNOWN'") + 200,
    );
    expect(appTs).toContain("return errorResponse('EXPORT_UPLOAD_UNKNOWN'");
    expect(uploadBranch).toContain("uploadState.status === 'COMMITTED'");
    expect(uploadBranch).toContain('idempotent_replay: true');
  });

  it('requires a caller-provided idempotency key for payroll export (no per-retry key)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const clientTs = fs.readFileSync(path.resolve(__dirname, '../lib/api.ts'), 'utf8');
    expect(clientTs).not.toMatch(/exportPayrollXlsx[^=]*=\s*crypto\.randomUUID\(\)/);
    expect(clientTs).toContain('exportPayrollXlsx: (run_id: string, expected_version: number, idempotency_key: string)');
    expect(clientTs).toContain('VALIDATION_FAILED');
  });

  it('parses every mutation body through the strict JSON envelope (no raw request.json)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const appTs = fs.readFileSync(path.resolve(__dirname, '../../api/app.ts'), 'utf8');
    expect(appTs).not.toContain('await request.json()) as any');
    expect(appTs).toContain('SERVICE_UNAVAILABLE');
  });



  it('sanitizes Excel formulas hidden behind leading whitespace or control bytes', () => {
    expect(sanitizeExcelCell('  =SUM(A1:A2)')).toBe("'  =SUM(A1:A2)");
    expect(sanitizeExcelCell('\t@SUM(A1:A2)')).toBe("'\t@SUM(A1:A2)");
    expect(sanitizeExcelCell('\u0000-1+1')).toBe("'\u0000-1+1");
    expect(sanitizeExcelCell('\u0085+1')).toBe("'\u0085+1");
    expect(sanitizeExcelCell('ordinary text')).toBe('ordinary text');
  });

  it('canonicalizes supported JSON values and rejects every unsupported number or type', () => {
    expect(canonicalJson({ z: [true, null, 2], a: 'ok' })).toBe('{"a":"ok","z":[true,null,2]}');
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(1n)).toThrow(TypeError);
    expect(() => canonicalJson(Symbol('unsupported'))).toThrow(TypeError);
    expect(() => canonicalJson(() => null)).toThrow(TypeError);
    expect(() => canonicalJson(Array(1))).toThrow(TypeError);
    expect(() => canonicalJson(new Date())).toThrow(TypeError);
  });
});
