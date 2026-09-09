import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../lib/api';

describe('API Client Network Resilience (src/lib/api.ts)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it('differentiates mutation timeout from GET timeout with unconfirmed message', async () => {
    vi.useFakeTimers();

    global.fetch = vi.fn().mockImplementation((_url, options) => {
      return new Promise((_, reject) => {
        if (options?.signal) {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const promise = api.completeOnboarding(1);
    // Advance fake timer past default 15s timeout
    vi.advanceTimersByTime(16_000);

    await expect(promise).rejects.toMatchObject({
      code: 'MUTATION_TIMEOUT',
      status: 504,
      message: expect.stringMatching(/hasil transaksi belum terkonfirmasi/i),
    });
  });

  it('handles non-JSON response gracefully without crashing with SyntaxError', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers(),
      text: async () => '<html><body>502 Bad Gateway</body></html>',
    } as any);

    await expect(
      api.getCurrentUser()
    ).rejects.toMatchObject({
      code: 'NON_JSON_RESPONSE',
      status: 502,
      message: expect.stringMatching(/layanan server mengalami kendala/i),
    });
  });

  it('supports caller cancellation signal cleanly', async () => {
    const controller = new AbortController();
    global.fetch = vi.fn().mockImplementation((_url, options) => {
      return new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const promise = api.getLoginOptions({ signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({
      code: 'REQUEST_ABORTED',
      message: expect.stringMatching(/dibatalkan oleh pengguna/i),
    });
  });

  it('refuses payroll export without a caller-provided idempotency key', async () => {
    global.fetch = vi.fn();
    await expect(
      (api.exportPayrollXlsx as any)('22222222-2222-4222-8222-222222222222', 7),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends an explicit idempotency key for payroll export', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ ok: true, data: {
        export_id: '11111111-1111-4111-8111-111111111111',
        filename: 'payroll.xlsx', checksum: 'a'.repeat(64), label: 'FINALIZED',
      } }),
    } as any);

    await api.exportPayrollXlsx(
      '22222222-2222-4222-8222-222222222222',
      7,
      '33333333-3333-4333-8333-333333333333',
    );

    const [, options] = (global.fetch as any).mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      run_id: '22222222-2222-4222-8222-222222222222',
      expected_version: 7,
      idempotency_key: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('rejects a successful response with a non-object JSON body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify([]),
    } as any);

    await expect(api.getCurrentUser()).rejects.toMatchObject({
      code: 'INVALID_JSON_RESPONSE',
      status: 200,
    });
  });

  it('omits invalid roster month rather than sending a server-rejected filter', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ ok: true, data: { roster: [] } }),
    } as any);

    await api.listRoster('September 2026');

    expect((global.fetch as any).mock.calls[0][0]).toBe('/api/app?action=roster.list');
  });

  it('sends a roster cancellation with its optimistic version and reason', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ ok: true, data: {
        id: '11111111-1111-4111-8111-111111111111', version: 2, status: 'CANCELLED',
      } }),
    } as any);

    await api.cancelRoster('11111111-1111-4111-8111-111111111111', 1, 'Salah input jadwal.');

    expect((global.fetch as any).mock.calls[0][0]).toBe('/api/app?action=roster.cancel');
    const [, options] = (global.fetch as any).mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      expected_version: 1,
      reason: 'Salah input jadwal.',
    });
  });

  it('omits invalid overtime dates rather than sending a server-rejected filter', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ ok: true, data: { overtime: [] } }),
    } as any);

    await api.listOvertime({ from: '', to: '2026-02-30' });

    expect((global.fetch as any).mock.calls[0][0]).toBe('/api/app?action=overtime.list');
  });

  it('sends only normalized, encoded roster and overtime filters', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ ok: true, data: { roster: [], overtime: [] } }),
    } as any);

    await api.listRoster('2026-09');
    await api.listOvertime({ from: '2026-09-01', to: '2026-09-30', status: 'CANDIDATE' });

    expect((global.fetch as any).mock.calls[0][0]).toBe('/api/app?action=roster.list&month=2026-09');
    expect((global.fetch as any).mock.calls[1][0]).toBe('/api/app?action=overtime.list&from=2026-09-01&to=2026-09-30&status=CANDIDATE');
  });
});
