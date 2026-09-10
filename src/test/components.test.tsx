import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Login } from '../features/auth/Login';
import { ForcedPinChange } from '../features/auth/ForcedPinChange';

describe('UI Component Flow Tests', () => {
  it('renders login options without role/job_title leakage and handles pin input', async () => {
    const handleLogin = vi.fn();
    const options = [
      { username: 'harun', display_name: 'Harun Al Rasyid' },
      { username: 'jezy', display_name: 'Jezy Supervisor' },
    ];

    render(
      <Login
        options={options}
        onLogin={handleLogin}
        loading={false}
        error=""
      />
    );

    expect(screen.getByText('Pilih pengguna...')).toBeDefined();

    // Click picker button
    const picker = screen.getByRole('button', { name: /pilih pengguna/i });
    await userEvent.click(picker);

    // Verify names are listed
    expect(screen.getByText('Harun Al Rasyid')).toBeDefined();
    expect(screen.getByText('Jezy Supervisor')).toBeDefined();

    // Select Harun
    await userEvent.click(screen.getByText('Harun Al Rasyid'));

    // Fill PIN
    const firstDigit = document.getElementById('pin-input-0') as HTMLInputElement;
    expect(firstDigit).toBeDefined();
    await userEvent.type(firstDigit, '1');
    await userEvent.type(document.getElementById('pin-input-1') as HTMLInputElement, '2');
    await userEvent.type(document.getElementById('pin-input-2') as HTMLInputElement, '3');
    await userEvent.type(document.getElementById('pin-input-3') as HTMLInputElement, '4');
    await userEvent.type(document.getElementById('pin-input-4') as HTMLInputElement, '5');
    await userEvent.type(document.getElementById('pin-input-5') as HTMLInputElement, '6');

    // Submit
    const submitBtn = screen.getByRole('button', { name: /masuk ke sistem/i });
    await userEvent.click(submitBtn);

    await waitFor(() => {
      expect(handleLogin).toHaveBeenCalledWith('harun', '123456');
    });
  });

  it('renders a sanitized login error in an animated live slot below the PIN rail', () => {
    const { container } = render(
      <Login
        options={[]}
        onLogin={vi.fn()}
        loading={false}
        error="Nama pengguna atau PIN salah. (API_ERROR · HTTP 401 · request_id private)"
      />,
    );

    expect(screen.getByText('Nama pengguna atau PIN salah.')).toBeDefined();
    expect(screen.queryByText(/API_ERROR|HTTP 401|request_id/i)).toBeNull();

    const slot = container.querySelector('.login-error-slot');
    expect(slot?.classList.contains('is-visible')).toBe(true);
    expect(slot?.getAttribute('aria-live')).toBe('polite');
    expect(slot?.getAttribute('aria-atomic')).toBe('true');

    const pinRail = container.querySelector('.pin-rail');
    expect(pinRail?.getAttribute('aria-describedby')).toBe('login-error');
  });

  it('renders forced pin change screen requiring 6-digit confirmation', () => {
    const handleSuccess = vi.fn();
    render(<ForcedPinChange onSuccess={handleSuccess} />);

    expect(screen.getByText(/wajib buat pin baru/i)).toBeDefined();
    expect(screen.getByText(/pin saat ini/i)).toBeDefined();
    expect(screen.getByText(/pin baru \(6 digit\)/i)).toBeDefined();
    expect(screen.getByText(/ulangi pin baru/i)).toBeDefined();
  });

  describe('login connection status', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('starts in checking state and becomes online only for an exact ok health body', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => 'ok' }) as any;
      render(<Login options={[]} onLogin={vi.fn()} loading={false} error="" />);

      expect(screen.getByText(/memeriksa koneksi server/i)).toBeDefined();
      await waitFor(() => expect(screen.getByText('Server terhubung')).toBeDefined());
      expect(global.fetch).toHaveBeenCalledWith('/api/health', expect.objectContaining({ cache: 'no-store' }));
    });

    it('shows offline state and reacts to browser network events', async () => {
      global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as any;
      render(<Login options={[]} onLogin={vi.fn()} loading={false} error="" />);

      await waitFor(() => expect(screen.getByText('Server tidak terjangkau')).toBeDefined());
      global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => 'ok' }) as any;
      fireEvent(window, new Event('online'));
      await waitFor(() => expect(screen.getByText('Server terhubung')).toBeDefined());
      fireEvent(window, new Event('offline'));
      expect(screen.getByText('Server tidak terjangkau')).toBeDefined();
    });
  });
});
