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
});
