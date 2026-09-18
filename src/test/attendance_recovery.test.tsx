import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SwipeAttendance } from '../features/attendance/SwipeAttendance';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    requestChallenge: vi.fn(),
    checkIn: vi.fn(),
    checkOut: vi.fn(),
  },
}));

vi.mock('../lib/geolocation', () => ({
  LOCATION_ISSUE_MESSAGES: { DENIED: 'Izin lokasi ditolak', TIMEOUT: 'GPS timeout', UNAVAILABLE: 'GPS tidak tersedia' },
  geolocationSupportIssue: () => null,
  gpsGuideSteps: () => [],
  normalizeGpsSettings: () => ({}),
  queryGeolocationPermission: async () => 'granted',
  startGpsWatch: () => ({
    stop: () => {},
    waitForSamples: async () => ({
      samples: [{ latitude: -6.2, longitude: 106.8, accuracy_m: 10, client_sampled_at: new Date().toISOString() }],
      failure: null,
      issue: null,
    }),
  }),
}));

describe('SwipeAttendance checkout recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.requestChallenge).mockResolvedValue({ challengeId: '11111111-1111-4111-8111-111111111111' } as any);
  });

  it('routes a repeat checkout conflict to recovery instead of a dead-end error', async () => {
    const onSuccess = vi.fn();
    const onRecoverableConflict = vi.fn();
    vi.mocked(api.checkOut).mockRejectedValue(
      Object.assign(new Error('CHECK_IN_REQUIRED: Checkout memerlukan attendance dengan check-in yang belum ditutup.'), {
        code: 'CHECK_IN_REQUIRED',
      }),
    );

    render(
      <SwipeAttendance
        actionType="CHECK_OUT"
        assignmentId="22222222-2222-4222-8222-222222222222"
        gps={{}}
        onSuccess={onSuccess}
        onCancel={vi.fn()}
        onRecoverableConflict={onRecoverableConflict}
      />,
    );

    const slider = await screen.findByLabelText(/geser untuk check-out/i);
    fireEvent.change(slider, { target: { value: '100' } });

    await waitFor(() => {
      expect(onRecoverableConflict).toHaveBeenCalledWith('CHECK_IN_REQUIRED');
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a genuine check-in failure on the normal error surface', async () => {
    const onRecoverableConflict = vi.fn();
    vi.mocked(api.checkIn).mockRejectedValue(
      Object.assign(new Error('Gagal melakukan absensi.'), { code: 'RPC_FAILED' }),
    );

    render(
      <SwipeAttendance
        actionType="CHECK_IN"
        assignmentId="22222222-2222-4222-8222-222222222222"
        gps={{}}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
        onRecoverableConflict={onRecoverableConflict}
      />,
    );

    const slider = await screen.findByLabelText(/geser untuk check-in/i);
    fireEvent.change(slider, { target: { value: '100' } });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });
    expect(onRecoverableConflict).not.toHaveBeenCalled();
  });
});
