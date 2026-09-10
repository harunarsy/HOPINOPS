import { describe, expect, it } from 'vitest';
import { getUserFacingError, sanitizeUserMessage } from '../lib/user-facing-error';

describe('user-facing error policy', () => {
  it('maps login authentication failures to human copy without diagnostics', () => {
    const message = getUserFacingError(
      Object.assign(new Error('Nama pengguna atau PIN salah. Internal detail'), {
        code: 'API_ERROR',
        status: 401,
        request_id: 'private-request-id',
      }),
      'Fallback login.',
      { surface: 'login' },
    );

    expect(message).toBe('Nama pengguna atau PIN salah.');
    expect(message).not.toMatch(/API_ERROR|HTTP|request_id|private-request-id/i);
  });

  it('maps protected and server failures to actionable generic copy', () => {
    expect(getUserFacingError({ code: 'AUTH_REQUIRED', status: 401 }, 'Fallback.')).toBe('Sesi berakhir. Silakan masuk lagi.');
    expect(getUserFacingError({ code: 'FORBIDDEN', status: 403 }, 'Fallback.')).toBe('Tindakan ini tidak diizinkan.');
    expect(getUserFacingError({ code: 'RPC_FAILED', status: 500 }, 'Fallback.')).toBe('Server sedang bermasalah. Coba lagi.');
    expect(getUserFacingError({ code: 'VERSION_CONFLICT', status: 409 }, 'Fallback.')).toMatch(/Data berubah/);
  });

  it('rejects diagnostic strings when a component only has a rendered message', () => {
    expect(sanitizeUserMessage('Nama pengguna atau PIN salah. (API_ERROR · HTTP 401)', 'Nama pengguna atau PIN salah.'))
      .toBe('Nama pengguna atau PIN salah.');
    expect(sanitizeUserMessage('VERSION_CONFLICT', 'Coba lagi.')).toBe('Coba lagi.');
    expect(sanitizeUserMessage('Nama pengguna atau PIN salah.', 'Fallback.')).toBe('Nama pengguna atau PIN salah.');
  });
});
