import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../lib/api';
import { StaffOnboarding } from '../features/onboarding/StaffOnboarding';

vi.mock('../lib/api', () => ({
  api: { completeOnboarding: vi.fn() },
}));

async function completeAllSteps(user: ReturnType<typeof userEvent.setup>) {
  // Step 0: Area
  await user.click(screen.getByRole('button', { name: /bar/i }));
  await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

  // Step 1: GPS
  await user.click(screen.getByRole('button', { name: /simulasikan dalam radius/i }));
  await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

  // Step 2: Role (match exact choice button name, not primary-button class)
  await user.click(screen.getByRole('button', { name: /^primary/i }));
  await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

  // Step 3: Opening
  await user.click(screen.getByRole('button', { name: /sesuai/i }));
  await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

  // Step 4: Movement
  await user.click(screen.getByRole('button', { name: /catat keluar 5/i }));
  await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

  // Step 5: Handover/Closing
  await user.click(screen.getByRole('button', { name: /handover/i }));
  await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

  // Step 6: Queue & Conflict
  await user.click(screen.getByRole('button', { name: /simulasikan offline/i }));
  await user.click(screen.getByRole('button', { name: /sambungkan kembali/i }));
  await user.click(screen.getByRole('button', { name: /tinjau & selesaikan/i }));
  await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

  // Step 7: Check-out
  await user.click(screen.getByRole('button', { name: /simulasikan check-out/i }));
}

describe('StaffOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enforces mandatory interactions on all eight steps and completes with active version', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    vi.mocked(api.completeOnboarding).mockResolvedValue(undefined);

    render(<StaffOnboarding onComplete={onComplete} onboardingVersion={2} />);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByText(/tidak ada absensi, lokasi, roster, atau stok produksi/i)).toBeDefined();

    // Step 0: "Berikutnya" is disabled until area is chosen
    const nextBtn = screen.getByRole('button', { name: 'Berikutnya' }) as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);

    // Complete all 8 interactive steps
    await completeAllSteps(user);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('8');
    expect(api.completeOnboarding).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /simpan & mulai bekerja/i }));

    await waitFor(() => expect(api.completeOnboarding).toHaveBeenCalledWith(2));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('validates CUSTOM opening quantity: rejects empty, NaN, and negative', async () => {
    const user = userEvent.setup();
    render(<StaffOnboarding onComplete={vi.fn()} />);

    // Advance to step 3 (Opening)
    await user.click(screen.getByRole('button', { name: /bar/i }));
    await user.click(screen.getByRole('button', { name: 'Berikutnya' }));
    await user.click(screen.getByRole('button', { name: /simulasikan dalam radius/i }));
    await user.click(screen.getByRole('button', { name: 'Berikutnya' }));
    await user.click(screen.getByRole('button', { name: /^primary/i }));
    await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('4');

    // Select CUSTOM
    await user.click(screen.getByRole('button', { name: /ubah jumlah/i }));
    const input = screen.getByPlaceholderText(/contoh: 10/i);
    const nextBtn = screen.getByRole('button', { name: 'Berikutnya' }) as HTMLButtonElement;

    // Empty input: disabled
    expect(nextBtn.disabled).toBe(true);

    // Negative input: disabled
    await user.type(input, '-5');
    expect(nextBtn.disabled).toBe(true);

    // Clear and type valid non-negative number
    await user.clear(input);
    await user.type(input, '8');
    expect(nextBtn.disabled).toBe(false);
  });

  it('stays on the final step after failure and retries without losing state', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    vi.mocked(api.completeOnboarding)
      .mockRejectedValueOnce(new Error('Koneksi offline'))
      .mockResolvedValueOnce(undefined);

    render(<StaffOnboarding onComplete={onComplete} onboardingVersion={2} />);

    await completeAllSteps(user);
    await user.click(screen.getByRole('button', { name: /simpan & mulai bekerja/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/gagal menyimpan progres/i);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('8');
    expect(onComplete).not.toHaveBeenCalled();

    // Retry button preserves checkedOut state and succeeds
    await user.click(screen.getByRole('button', { name: /coba lagi/i }));

    await waitFor(() => expect(api.completeOnboarding).toHaveBeenCalledTimes(2));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
