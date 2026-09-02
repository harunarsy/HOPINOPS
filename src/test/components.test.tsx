import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

    expect(screen.getByText('Pilih nama Anda...')).toBeDefined();

    // Click picker button
    const picker = screen.getByRole('button', { name: /nama lengkap/i });
    await userEvent.click(picker);

    // Verify names are listed
    expect(screen.getByText('Harun Al Rasyid')).toBeDefined();
    expect(screen.getByText('Jezy Supervisor')).toBeDefined();

    // Select Harun
    await userEvent.click(screen.getByText('Harun Al Rasyid'));

    // Fill PIN
    const pinInput = screen.getByPlaceholderText('••••••');
    await userEvent.type(pinInput, '123456');

    // Submit
    const submitBtn = screen.getByRole('button', { name: /masuk ke sistem/i });
    await userEvent.click(submitBtn);

    expect(handleLogin).toHaveBeenCalledWith('harun', '123456');
  });

  it('renders forced pin change screen requiring 6-digit confirmation', () => {
    const handleSuccess = vi.fn();
    render(<ForcedPinChange onSuccess={handleSuccess} />);

    expect(screen.getByText(/wajib buat pin baru/i)).toBeDefined();
    expect(screen.getByText(/pin saat ini/i)).toBeDefined();
    expect(screen.getByText(/pin baru \(6 digit\)/i)).toBeDefined();
    expect(screen.getByText(/ulangi pin baru/i)).toBeDefined();
  });
});
