import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../lib/api';
import { StaffOnboarding } from '../features/onboarding/StaffOnboarding';

vi.mock('../lib/api', () => ({
  api: { completeOnboarding: vi.fn() },
}));

describe('StaffOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs all eight steps locally and only completes onboarding with version 2', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    vi.mocked(api.completeOnboarding).mockResolvedValue(undefined);

    render(<StaffOnboarding onComplete={onComplete} />);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByText(/tidak ada absensi, lokasi, roster, atau stok produksi/i)).toBeDefined();

    for (let step = 2; step <= 8; step += 1) {
      await user.click(screen.getByRole('button', { name: 'Berikutnya' }));
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(String(step));
    }

    expect(api.completeOnboarding).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /simpan & mulai bekerja/i }));

    await waitFor(() => expect(api.completeOnboarding).toHaveBeenCalledWith(2));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('stays on the final step after failure and retries without completing early', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    vi.mocked(api.completeOnboarding)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);

    render(<StaffOnboarding onComplete={onComplete} />);

    for (let step = 1; step < 8; step += 1) {
      await user.click(screen.getByRole('button', { name: 'Berikutnya' }));
    }
    await user.click(screen.getByRole('button', { name: /simpan & mulai bekerja/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/gagal menyimpan progres/i);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('8');
    expect(onComplete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /coba lagi/i }));

    await waitFor(() => expect(api.completeOnboarding).toHaveBeenCalledTimes(2));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
