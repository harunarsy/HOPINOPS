import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../lib/api';
import { wibDateKey } from '../domain/rules';
import { ManagementView } from '../features/management/ManagementView';

vi.mock('../lib/api', () => ({
  api: {
    getDashboard: vi.fn(),
    getManagementStockReadiness: vi.fn(),
    recordCyclePhysicalBaseline: vi.fn(),
    correctCyclePhysicalBaseline: vi.fn(),
    listRoster: vi.fn(),
    listUsers: vi.fn(),
    listAttendanceExceptions: vi.fn(),
    listOvertime: vi.fn(),
    getPayrollRun: vi.fn(),
    previewPayroll: vi.fn(),
    reviewPayroll: vi.fn(),
    finalizePayroll: vi.fn(),
    markPayrollPaid: vi.fn(),
    voidPayroll: vi.fn(),
  },
}));

const ownerUser = {
  id: 'user-owner-1',
  username: 'owner',
  display_name: 'Owner',
  role: 'OWNER',
  job_title: 'OWNER',
  active: true,
  force_pin_change: false,
};

function runFor(period: string, id: string, status: string, version = 1) {
  return {
    run: { id, period_month: period, status, version },
    entries: [],
    adjustments: [],
  };
}

describe('ManagementView payroll period isolation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.getDashboard).mockResolvedValue({} as any);
    vi.mocked(api.getManagementStockReadiness).mockResolvedValue({ work_date: wibDateKey(), cycles: [] } as any);
    vi.mocked(api.listRoster).mockResolvedValue([] as any);
    vi.mocked(api.listUsers).mockResolvedValue([] as any);
    vi.mocked(api.listAttendanceExceptions).mockResolvedValue([] as any);
    vi.mocked(api.listOvertime).mockResolvedValue([] as any);
  });

  function monthInput() {
    return document.querySelector('#payroll-period') as HTMLInputElement;
  }

  it('initializes roster/payroll/review periods as ISO dates the server accepts', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getPayrollRun).mockImplementation(async (period?: string) => runFor(period ?? '', 'run-x', 'DRAFT'));
    render(<ManagementView user={ownerUser} onLogout={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /kelola payroll/i }));
    await waitFor(() => expect(monthInput().value).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/));
    expect(vi.mocked(api.getPayrollRun)).toHaveBeenCalledWith(monthInput().value);
  });

  it('keeps invalid schedule and review filters as drafts without sending a malformed request', async () => {
    const user = userEvent.setup();
    render(<ManagementView user={ownerUser} onLogout={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /atur jadwal/i }));
    const rosterMonth = document.querySelector('input[type="month"]') as HTMLInputElement;
    const initialRosterCalls = vi.mocked(api.listRoster).mock.calls.length;
    fireEvent.change(rosterMonth, { target: { value: '' } });
    expect(rosterMonth.value).toBe('');
    await user.click(screen.getByRole('button', { name: /terapkan bulan/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/masukkan bulan yang valid/i);
    expect(vi.mocked(api.listRoster)).toHaveBeenCalledTimes(initialRosterCalls);

    await user.click(screen.getByRole('button', { name: /review kehadiran/i }));
    const dateInputs = Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    const initialOvertimeCalls = vi.mocked(api.listOvertime).mock.calls.length;
    fireEvent.change(dateInputs[0], { target: { value: '' } });
    fireEvent.change(dateInputs[1], { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Terapkan' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/masukkan tanggal awal dan akhir yang valid/i);
    expect(vi.mocked(api.listOvertime)).toHaveBeenCalledTimes(initialOvertimeCalls);
  });

  it('closes payroll dialogs when the period changes before confirming', async () => {
    const user = userEvent.setup();
    const periodA = wibDateKey().slice(0, 7);
    const periodB = periodA === '2026-10' ? '2026-11' : '2026-10';
    vi.mocked(api.getPayrollRun).mockImplementation(async (period?: string) =>
      period === periodB ? runFor(periodB, 'run-b', 'DRAFT') : runFor(periodA, 'run-a', 'FINALIZED', 3),
    );

    render(<ManagementView user={ownerUser} onLogout={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /kelola payroll/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /tandai sudah dibayar/i })).toBeDefined());

    await user.click(screen.getByRole('button', { name: /tandai sudah dibayar/i }));
    expect(screen.getByRole('dialog')).toBeDefined();

    fireEvent.change(monthInput(), { target: { value: periodB } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(vi.mocked(api.markPayrollPaid)).not.toHaveBeenCalled();
  });

  it('does not let a stale preview reload overwrite a newer period', async () => {
    const user = userEvent.setup();
    const periodA = wibDateKey().slice(0, 7);
    const periodB = periodA === '2026-10' ? '2026-11' : '2026-10';
    let resolvePreview!: (value: any) => void;
    const previewGate = new Promise((resolve) => { resolvePreview = resolve; });
    let resolveLoadB!: (value: any) => void;
    const loadGateB = new Promise((resolve) => { resolveLoadB = resolve; });
    vi.mocked(api.getPayrollRun).mockImplementation((period?: string) =>
      period === periodB ? loadGateB as any : Promise.resolve(runFor(periodA, 'run-a', 'DRAFT', 1)),
    );
    vi.mocked(api.previewPayroll).mockReturnValue(previewGate as any);

    render(<ManagementView user={ownerUser} onLogout={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /kelola payroll/i }));
    await waitFor(() => expect(screen.getByText(new RegExp(`Periode dimuat ${periodA}`))).toBeDefined());
    await waitFor(() => expect(monthInput().value).toBe(periodA));

    await user.click(screen.getByRole('button', { name: /hitung ulang draft|buat draft payroll/i }));
    fireEvent.change(monthInput(), { target: { value: periodB } });

    await act(async () => {
      resolvePreview({ entry_count: 2 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      resolveLoadB(runFor(periodB, 'run-b', 'DRAFT', 1));
    });

    await waitFor(() => expect(monthInput().value).toBe(periodB));
    expect(monthInput().value).toBe(periodB);
  });
});
