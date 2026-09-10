import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { api } from '../lib/api';
import { StaffOnboarding } from '../features/onboarding/StaffOnboarding';

vi.mock('../lib/api', () => ({
  api: {
    getCurrentUser: vi.fn(),
    getLoginOptions: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    bootstrap: vi.fn(),
    getCycle: vi.fn(),
    claimAssignment: vi.fn(),
    completeOnboarding: vi.fn(),
    changePin: vi.fn(),
    getOpeningReference: vi.fn(),
    getDashboard: vi.fn(),
    getStockDrafts: vi.fn(),
    getChecklistLayout: vi.fn(),
    selfEmergencyCheckout: vi.fn(),
  },
}));

describe('Staff Flow & Onboarding UI Regression', () => {
  const operatorUser = {
    id: 'user-operator-1',
    username: 'budi',
    display_name: 'Budi Operator',
    role: 'OPERATOR',
    job_title: 'Staff Bar',
    active: true,
    force_pin_change: false,
  };

  const supervisorUser = {
    id: 'user-supervisor-1',
    username: 'siti',
    display_name: 'Siti Supervisor',
    role: 'SUPERVISOR',
    job_title: 'Supervisor',
    active: true,
    force_pin_change: false,
  };

  const defaultOutlet = {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'HOPIN Melawai',
    code: 'MLW',
    active: true,
  };

  const defaultSettings = {
    outlet_id: '11111111-1111-1111-1111-111111111111',
    version: 1,
    onboarding_version: 1,
    system_mode: 'PRODUCTION',
    geofence_radius_m: 100,
    max_accuracy_m: 50,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.getStockDrafts).mockResolvedValue({ opening_draft: null, closing_draft: null });
    vi.mocked(api.getOpeningReference).mockResolvedValue({
      state: 'INITIALIZATION_REQUIRED',
      warning_code: null,
      source_type: null,
      source_id: null,
      lines: [],
    });
    vi.mocked(api.getChecklistLayout).mockResolvedValue({ version: 1, sections: [], placements: [] });
  });

  async function performOnboardingSteps(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /bar/i }));
    await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

    await user.click(screen.getByRole('button', { name: /simulasikan dalam radius/i }));
    await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

    await user.click(screen.getByRole('button', { name: /^primary/i }));
    await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

    await user.click(screen.getByRole('button', { name: /sesuai/i }));
    await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

    await user.click(screen.getByRole('button', { name: /catat keluar 5/i }));
    await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

    await user.click(screen.getByRole('button', { name: /handover/i }));
    await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

    await user.click(screen.getByRole('button', { name: /coba tanpa internet/i }));
    await user.click(screen.getByRole('button', { name: /sambungkan internet/i }));
    await user.click(screen.getByRole('button', { name: /periksa catatan yang perlu diperbaiki/i }));
    await user.click(screen.getByRole('button', { name: 'Berikutnya' }));

    await user.click(screen.getByRole('button', { name: /simulasikan check-out/i }));
  }

  it('reproduces training failure when version mismatches and verifies user is not trapped', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    const onLogout = vi.fn();

    // Server expects version 2, but client sent 1
    vi.mocked(api.completeOnboarding).mockRejectedValueOnce(
      new Error('VERSION_CONFLICT: Current onboarding version is 2.')
    );

    render(
      <StaffOnboarding
        onComplete={onComplete}
        onLogout={onLogout}
        onboardingVersion={1}
      />
    );

    // Run all 8 mandatory interactions
    await performOnboardingSteps(user);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('8');

    // Click finish -> triggers failure
    await user.click(screen.getByRole('button', { name: /simpan & mulai bekerja/i }));

    // Error alert is displayed with recovery action
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/VERSION_CONFLICT|diperbarui ke versi 2/i);

    // Operator is NOT trapped: Logout button must be accessible (both header and error box provide it)
    const logoutBtns = screen.getAllByRole('button', { name: /keluar/i });
    expect(logoutBtns.length).toBeGreaterThanOrEqual(1);
    await user.click(logoutBtns[0]);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('runs complete staff journey: Login -> Onboarding -> AssignmentScreen -> Workspace', async () => {
    const user = userEvent.setup();

    // 1. Initial unauthenticated state
    vi.mocked(api.getCurrentUser).mockResolvedValue(null);
    vi.mocked(api.getLoginOptions).mockResolvedValue([
      { username: 'budi', display_name: 'Budi Operator' },
    ]);

    // 2. Login succeeds
    vi.mocked(api.login).mockResolvedValue(operatorUser);

    // 3. First bootstrap: needs onboarding (no completed_at)
    vi.mocked(api.bootstrap).mockResolvedValueOnce({
      user: operatorUser,
      outlet: defaultOutlet,
      settings: defaultSettings,
      items: [
        { id: 'item-1', name: 'Kopi Susu', active: true, area: 'BAR' },
      ],
      shifts: [
        { id: 'shift-1', code: 'SIANG', label: 'Shift Siang' },
      ],
      onboarding: null,
      activeAssignment: null,
      activeAttendance: null,
      workDate: '2026-09-06',
    });

    render(<App />);

    // Wait for login screen
    await waitFor(() => {
      expect(screen.getByText('Pilih pengguna...')).toBeDefined();
    });

    // Select user from picker
    await user.click(screen.getByRole('button', { name: /pilih pengguna/i }));
    await user.click(screen.getByText('Budi Operator'));

    // Fill 6-digit PIN
    for (let i = 0; i < 6; i++) {
      fireEvent.change(document.getElementById(`pin-input-${i}`) as HTMLInputElement, {
        target: { value: '1' },
      });
    }

    // Now Onboarding Screen should be visible
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /latihan alur shift/i })).toBeDefined();
    });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');

    // Complete all 8 mandatory interactive steps
    await performOnboardingSteps(user);

    // On complete onboarding: mock API resolution & next bootstrap
    vi.mocked(api.completeOnboarding).mockResolvedValue({
      profile_id: operatorUser.id,
      onboarding_version: 1,
      completed_at: '2026-09-06T10:00:00Z',
      idempotent_replay: false,
    });

    // Second bootstrap: onboarding completed, no assignment yet
    vi.mocked(api.bootstrap).mockResolvedValueOnce({
      user: operatorUser,
      outlet: defaultOutlet,
      settings: defaultSettings,
      items: [
        { id: 'item-1', name: 'Kopi Susu', active: true, area: 'BAR' },
      ],
      shifts: [
        { id: 'shift-1', code: 'SIANG', label: 'Shift Siang' },
      ],
      onboarding: {
        profile_id: operatorUser.id,
        onboarding_version: 1,
        completed_at: '2026-09-06T10:00:00Z',
      },
      activeAssignment: null,
      activeAttendance: null,
      workDate: '2026-09-06',
    });

    // Click "Simpan & mulai bekerja"
    await user.click(screen.getByRole('button', { name: /simpan & mulai bekerja/i }));

    // Should transition to AssignmentScreen!
    await waitFor(() => {
      expect(screen.getByText(/halo, budi operator/i)).toBeDefined();
    });
    expect(screen.getByText('PILIH TUGAS HARI INI')).toBeDefined();

    // Operator selects shift (SIANG is default), area (BAR is default), duty (PRIMARY is default)
    // Click "Lanjut ke Absensi GPS →" to open modal
    await user.click(screen.getByRole('button', { name: /lanjut ke absensi gps/i }));

    // Modal pops up with "Konfirmasi Penugasan"
    expect(screen.getByRole('heading', { name: 'Konfirmasi Penugasan' })).toBeDefined();

    // Mock claim assignment API and 3rd bootstrap (now with active assignment & checked-in attendance)
    vi.mocked(api.claimAssignment).mockResolvedValue({
      assignment: {
        id: 'asg-1',
        cycle_id: 'cycle-1',
        duty_role: 'PRIMARY',
        status: 'ACTIVE',
        work_cycles: {
          area_code: 'BAR',
          shift_code: 'SIANG',
          version: 1,
        },
      },
      cycle: {
        id: 'cycle-1',
        area_code: 'BAR',
        shift_code: 'SIANG',
        version: 1,
        status: 'OPEN',
      },
    });

    vi.mocked(api.getCycle).mockResolvedValue({
      cycle: {
        id: 'cycle-1',
        area_code: 'BAR',
        shift_code: 'SIANG',
        version: 1,
        status: 'OPEN',
      },
      movements: [],
    });

    vi.mocked(api.bootstrap).mockResolvedValueOnce({
      user: operatorUser,
      outlet: defaultOutlet,
      settings: defaultSettings,
      items: [
        { id: 'item-1', name: 'Kopi Susu', active: true, area: 'BAR' },
      ],
      shifts: [
        { id: 'shift-1', code: 'SIANG', label: 'Shift Siang' },
      ],
      onboarding: {
        profile_id: operatorUser.id,
        onboarding_version: 1,
        completed_at: '2026-09-06T10:00:00Z',
      },
      activeAssignment: {
        id: 'asg-1',
        cycle_id: 'cycle-1',
        duty_role: 'PRIMARY',
        status: 'ACTIVE',
        work_cycles: {
          area_code: 'BAR',
          shift_code: 'SIANG',
          version: 1,
        },
      },
      activeAttendance: {
        id: 'att-1',
        status: 'CHECKED_IN',
      },
      workDate: '2026-09-06',
    });

    // Click "Konfirmasi & Masuk" in confirmation modal
    await user.click(screen.getByRole('button', { name: /konfirmasi & masuk/i }));

    // Claim succeeds and transitions to attendance check-in
    await waitFor(() => {
      expect(screen.getByText('ABSENSI MASUK SHIFT')).toBeDefined();
      expect(screen.getByText('Verifikasi Kehadiran')).toBeDefined();
    });
  });

  it('honors B04: user with previously completed onboarding skips training completely', async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue(operatorUser);
    vi.mocked(api.bootstrap).mockResolvedValue({
      user: operatorUser,
      outlet: defaultOutlet,
      settings: { ...defaultSettings, onboarding_version: 3 }, // Outlet has newer version 3
      items: [],
      shifts: [],
      onboarding: {
        profile_id: operatorUser.id,
        onboarding_version: 1, // User completed version 1 in the past
        completed_at: '2026-08-01T00:00:00Z',
      },
      activeAssignment: null,
      activeAttendance: null,
      workDate: '2026-09-06',
    });

    render(<App />);

    // Directly renders AssignmentScreen, bypassing StaffOnboarding!
    await waitFor(() => {
      expect(screen.getByText(/halo, budi operator/i)).toBeDefined();
    });
    expect(screen.queryByRole('heading', { name: /latihan alur shift/i })).toBeNull();
  });

  it('resets PIN input when switching user in login picker (F11)', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCurrentUser).mockResolvedValue(null);
    vi.mocked(api.getLoginOptions).mockResolvedValue([
      { username: 'budi', display_name: 'Budi Operator' },
      { username: 'siti', display_name: 'Siti Supervisor' },
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Pilih pengguna...')).toBeDefined();
    });

    // Select Budi
    await user.click(screen.getByRole('button', { name: /pilih pengguna/i }));
    await user.click(screen.getByText('Budi Operator'));

    // Type 2 digits
    const pin0 = document.getElementById('pin-input-0') as HTMLInputElement;
    const pin1 = document.getElementById('pin-input-1') as HTMLInputElement;
    await user.type(pin0, '1');
    await user.type(pin1, '2');
    expect(pin0.value).toBe('1');
    expect(pin1.value).toBe('2');

    // Switch to Siti
    await user.click(screen.getByRole('button', { name: /pilih pengguna/i }));
    await user.click(screen.getByText('Siti Supervisor'));

    // PIN boxes should be reset to empty!
    expect((document.getElementById('pin-input-0') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('pin-input-1') as HTMLInputElement).value).toBe('');
  });

  it('provides logout on forced pin change screen (F10)', async () => {
    const user = userEvent.setup();
    const userWithForcedPin = {
      ...operatorUser,
      force_pin_change: true,
    };

    vi.mocked(api.getCurrentUser).mockResolvedValue(userWithForcedPin);
    vi.mocked(api.bootstrap).mockResolvedValue({
      user: userWithForcedPin,
      outlet: defaultOutlet,
      settings: defaultSettings,
      items: [],
      shifts: [],
      onboarding: null,
      activeAssignment: null,
      activeAttendance: null,
      workDate: '2026-09-06',
    });
    vi.mocked(api.logout).mockResolvedValue(undefined);
    vi.mocked(api.getLoginOptions).mockResolvedValue([
      { username: 'budi', display_name: 'Budi Operator' },
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/wajib buat pin baru/i)).toBeDefined();
    });

    const logoutBtn = screen.getByRole('button', { name: /keluar/i });
    expect(logoutBtn).toBeDefined();
    await user.click(logoutBtn);
    expect(api.logout).toHaveBeenCalled();
  });

  it('allows supervisor to enter an explicit physical baseline via canManage (F02/B06)', async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue(supervisorUser);
    vi.mocked(api.bootstrap).mockResolvedValue({
      user: supervisorUser,
      outlet: defaultOutlet,
      settings: defaultSettings,
      items: [
        { id: 'item-1', name: 'Sirup Gula', unit_code: 'botol', active: true, area_code: 'BAR' },
      ],
      shifts: [],
      onboarding: null,
      activeAssignment: {
        id: 'asg-sup',
        cycle_id: 'cycle-sup',
        duty_role: 'PRIMARY',
        status: 'ACTIVE',
        work_cycles: {
          area_code: 'BAR',
          shift_code: 'SIANG',
          version: 1,
        },
      },
      activeAttendance: {
        id: 'att-sup',
        status: 'CHECKED_IN',
      },
      workDate: '2026-09-06',
    });
    vi.mocked(api.getCycle).mockResolvedValue({
      cycle: {
        id: 'cycle-sup',
        area_code: 'BAR',
        shift_code: 'SIANG',
        version: 1,
        status: 'OPEN',
      },
      movements: [],
    });
    vi.mocked(api.getOpeningReference).mockResolvedValue({
      state: 'INITIALIZATION_REQUIRED',
      warning_code: null,
      source_type: null,
      source_id: null,
      lines: [{ item_id: 'item-1', reference_qty: null }],
    });

    vi.mocked(api.getDashboard).mockResolvedValue({
      date: '2026-09-06',
      shifts: [],
      emergencyWorkers: [],
    });

    const user = userEvent.setup();
    render(<App />);

    // Supervisor enters shift mode to view workspace
    const shiftModeBtn = await screen.findByRole('button', { name: /mode shift/i });
    await user.click(shiftModeBtn);

    // Go to Stok Awal tab where opening reference initialization is located
    const stokAwalTab = await screen.findByRole('button', { name: 'Stok Awal' });
    await user.click(stokAwalTab);

    // Supervisor in StockWorkspace should have canManage=true and must enter a
    // physical count. The old synthetic-zero initialization must not return.
    await waitFor(() => {
      expect(screen.getByLabelText(/jumlah fisik stok awal sirup gula/i)).toBeDefined();
      expect(screen.getByRole('button', { name: /tetapkan stok patokan/i })).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: /inisialisasi patokan 0/i })).toBeNull();
  });

  it('handles server logout failure: warns user, retains session on client, and allows retry', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCurrentUser).mockResolvedValue(operatorUser);
    vi.mocked(api.bootstrap).mockResolvedValue({
      user: operatorUser,
      outlet: defaultOutlet,
      settings: defaultSettings,
      items: [],
      shifts: [],
      onboarding: {
        profile_id: operatorUser.id,
        onboarding_version: 1,
        completed_at: '2026-09-06T10:00:00Z',
      },
      activeAssignment: null,
      activeAttendance: null,
      workDate: '2026-09-06',
    });

    // First logout attempt fails on server
    vi.mocked(api.logout).mockRejectedValueOnce(
      new Error('SESSION_REVOCATION_FAILED: database connection lost')
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/halo, budi operator/i)).toBeDefined();
    });

    // Attempt logout
    const logoutBtn = screen.getByRole('button', { name: /keluar/i });
    await user.click(logoutBtn);

    // Client must NOT redirect to Login on server failure!
    expect(screen.queryByText('Pilih pengguna...')).toBeNull();
    expect(screen.getByText(/halo, budi operator/i)).toBeDefined();

    // Security warning banner is displayed
    const warning = await screen.findByRole('alert');
    expect(warning.textContent).toMatch(/keluar akun belum terkonfirmasi di server/i);

    // Retry logout succeeds
    vi.mocked(api.logout).mockResolvedValueOnce(undefined);
    vi.mocked(api.getLoginOptions).mockResolvedValue([
      { username: 'budi', display_name: 'Budi Operator' },
    ]);

    const retryBtn = screen.getByRole('button', { name: /coba lagi/i });
    await user.click(retryBtn);

    // Now client is safely logged out
    await waitFor(() => {
      expect(screen.getByText('Pilih pengguna...')).toBeDefined();
    });
  });

  it('allows manager to return to dashboard from assignment screen, while investor cannot enter mode shift', async () => {
    const user = userEvent.setup();

    // 1. Supervisor on AssignmentScreen can return to dashboard
    vi.mocked(api.getCurrentUser).mockResolvedValue(supervisorUser);
    vi.mocked(api.bootstrap).mockResolvedValue({
      user: supervisorUser,
      outlet: defaultOutlet,
      settings: defaultSettings,
      items: [],
      shifts: [],
      onboarding: null,
      activeAssignment: null,
      activeAttendance: null,
      workDate: '2026-09-06',
    });
    vi.mocked(api.getDashboard).mockResolvedValue({
      date: '2026-09-06',
      shifts: [],
      emergencyWorkers: [],
    });

    const { unmount } = render(<App />);

    // Supervisor in dashboard clicks Mode Shift
    const shiftModeBtn = await screen.findByRole('button', { name: /mode shift/i });
    await user.click(shiftModeBtn);

    // Now on AssignmentScreen, Supervisor sees "Dashboard" button
    const dashboardBtn = await screen.findByRole('button', { name: /dashboard/i });
    expect(dashboardBtn).toBeDefined();

    // Click Dashboard to return
    await user.click(dashboardBtn);
    await waitFor(() => {
      expect(screen.getByText('DASHBOARD SUPERVISOR')).toBeDefined();
    });

    unmount();

    // 2. Investor cannot enter mode shift
    const investorUser = {
      id: 'user-investor-1',
      username: 'hendra',
      display_name: 'Hendra Investor',
      role: 'INVESTOR',
      job_title: 'Investor',
      active: true,
      force_pin_change: false,
    };

    vi.mocked(api.getCurrentUser).mockResolvedValue(investorUser);
    vi.mocked(api.bootstrap).mockResolvedValue({
      user: investorUser,
      outlet: defaultOutlet,
      settings: defaultSettings,
      items: [],
      shifts: [],
      onboarding: null,
      activeAssignment: null,
      activeAttendance: null,
      workDate: '2026-09-06',
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/hendra investor/i)).toBeDefined();
    });

    // Investor NEVER has "Mode Shift" button
    expect(screen.queryByRole('button', { name: /mode shift/i })).toBeNull();
  });

  it('confirms logout explicitly when unsynced queue or unconfirmed counts exist (E2)', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCurrentUser).mockResolvedValue(operatorUser);
    vi.mocked(api.bootstrap).mockResolvedValue({
      user: operatorUser,
      outlet: defaultOutlet,
      settings: defaultSettings,
      items: [{ id: 'item-1', name: 'Kopi Susu', unit_code: 'kg', active: true, area_code: 'BAR' }],
      shifts: [],
      onboarding: {
        profile_id: operatorUser.id,
        onboarding_version: 1,
        completed_at: '2026-09-06T10:00:00Z',
      },
      activeAssignment: {
        id: 'asg-1',
        cycle_id: 'cycle-1',
        duty_role: 'PRIMARY',
        status: 'ACTIVE',
        work_cycles: { area_code: 'BAR', shift_code: 'SIANG', version: 1 },
      },
      activeAttendance: { id: 'att-1', status: 'CHECKED_IN' },
      workDate: '2026-09-06',
    });
    vi.mocked(api.getCycle).mockResolvedValue({
      cycle: { id: 'cycle-1', area_code: 'BAR', shift_code: 'SIANG', version: 1, status: 'OPEN' },
      movements: [],
    });
    vi.mocked(api.getOpeningReference).mockResolvedValue({
      state: 'AVAILABLE',
      warning_code: null,
      source_type: 'INITIALIZATION',
      source_id: 'init-1',
      lines: [{ item_id: 'item-1', reference_qty: 5 }],
    });
    vi.mocked(api.logout).mockResolvedValue(undefined);
    vi.mocked(api.getLoginOptions).mockResolvedValue([
      { username: 'budi', display_name: 'Budi Operator' },
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /workspace bar/i })).toBeDefined();
    });

    // Open Stok Awal tab and type an unconfirmed count
    await user.click(screen.getByRole('button', { name: 'Stok Awal' }));
    const countInput = document.getElementById('opening-count-item-1') as HTMLInputElement;
    expect(countInput).toBeDefined();
    fireEvent.change(countInput, { target: { value: '5' } });

    // Attempt logout -> explicit confirm dialog, NOT instant logout
    const logoutBtns = screen.getAllByRole('button', { name: 'Keluar' });
    await user.click(logoutBtns[0]);

    const dialogTitle = await screen.findByRole('heading', { name: /tetap keluar akun/i });
    expect(dialogTitle).toBeDefined();

    // Cancel keeps the session and the typed input
    await user.click(screen.getByRole('button', { name: 'Batal' }));
    expect(screen.queryByRole('heading', { name: /tetap keluar akun/i })).toBeNull();
    expect((document.getElementById('opening-count-item-1') as HTMLInputElement).value).toBe('5');

    // Escape also dismisses the confirm dialog without logging out
    await user.click(screen.getAllByRole('button', { name: 'Keluar' })[0]);
    await screen.findByRole('heading', { name: /tetap keluar akun/i });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /tetap keluar akun/i })).toBeNull();
    });
    expect(screen.getByRole('heading', { name: /workspace bar/i })).toBeDefined();

    // Confirm proceeds to login
    await user.click(screen.getAllByRole('button', { name: 'Keluar' })[0]);
    await user.click(screen.getByRole('button', { name: /tetap keluar/i }));
    await waitFor(() => {
      expect(screen.getByText('Pilih pengguna...')).toBeDefined();
    });
    expect(api.logout).toHaveBeenCalled();
  });

  it('blocks the workspace immediately after successful self emergency checkout even when refresh fails (B05)', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCurrentUser).mockResolvedValue(operatorUser);
    vi.mocked(api.bootstrap)
      .mockResolvedValueOnce({
        user: operatorUser,
        outlet: defaultOutlet,
        settings: defaultSettings,
        items: [{ id: 'item-1', name: 'Kopi Susu', unit_code: 'kg', active: true, area_code: 'BAR' }],
        shifts: [],
        onboarding: {
          profile_id: operatorUser.id,
          onboarding_version: 1,
          completed_at: '2026-09-06T10:00:00Z',
        },
        activeAssignment: {
          id: 'asg-1',
          cycle_id: 'cycle-1',
          duty_role: 'PRIMARY',
          status: 'ACTIVE',
          work_cycles: { area_code: 'BAR', shift_code: 'SIANG', version: 1 },
        },
        activeAttendance: { id: 'att-1', status: 'CHECKED_IN', version: 1 },
        workDate: '2026-09-06',
      })
      .mockRejectedValueOnce(new Error('Network down'));
    vi.mocked(api.getCycle).mockResolvedValue({
      cycle: { id: 'cycle-1', area_code: 'BAR', shift_code: 'SIANG', version: 1, status: 'OPEN' },
      movements: [],
    });
    vi.mocked(api.selfEmergencyCheckout).mockResolvedValue({
      attendance_id: 'att-1',
      event_id: 'evt-1',
      status: 'REVIEW_REQUIRED',
      exception_status: 'PENDING_REVIEW',
      version: 2,
      idempotent_replay: false,
    });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /workspace bar/i })).toBeDefined();
    });

    const menuSummary = container.querySelector('details.account-menu summary') as HTMLElement;
    expect(menuSummary).toBeDefined();
    fireEvent.click(menuSummary);
    await user.click(screen.getByRole('button', { name: /check-out darurat/i }));
    fireEvent.change(screen.getByLabelText(/alasan check-out darurat/i), {
      target: { value: 'Harus pulang mendadak' },
    });
    await user.click(screen.getByRole('button', { name: /catat check-out darurat/i }));

    await waitFor(() => {
      expect(screen.getByText(/checkout dalam review/i)).toBeDefined();
    });
    expect(screen.queryByRole('heading', { name: /workspace bar/i })).toBeNull();
  });

  it('enforces transient PIN masking: max 1 digit visible, group blur masks immediately', async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue(null);
    vi.mocked(api.getLoginOptions).mockResolvedValue([
      { username: 'budi', display_name: 'Budi Operator' },
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Pilih pengguna...')).toBeDefined();
    });

    const pin0 = document.getElementById('pin-input-0') as HTMLInputElement;
    const pin1 = document.getElementById('pin-input-1') as HTMLInputElement;

    // Type 1 into pin-input-0
    fireEvent.change(pin0, { target: { value: '1' } });
    expect(pin0.type).toBe('text');

    // Type 2 into pin-input-1 -> pin0 is immediately masked, pin1 is text
    fireEvent.change(pin1, { target: { value: '2' } });
    expect(pin0.type).toBe('password');
    expect(pin1.type).toBe('text');

    // Blur from the PIN group to an outside element
    const wrap = pin0.closest('.pin-rail') as HTMLElement;
    fireEvent.blur(wrap, { relatedTarget: document.body });

    // Both are now masked!
    expect(pin0.type).toBe('password');
    expect(pin1.type).toBe('password');
  });
});
