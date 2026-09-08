import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../lib/api';
import { ReportsView } from '../features/reports/ReportsView';

vi.mock('../lib/api', () => ({
  api: {
    getReport: vi.fn(),
    getCurrentUser: vi.fn(),
    listReports: vi.fn(),
    saveReportFinance: vi.fn(),
    submitReport: vi.fn(),
    shareReport: vi.fn(),
    previewBonus: vi.fn(),
  },
}));

const snapshotWithStock = {
  report: { id: 'rep-1', status: 'DRAFT', current_revision: 1, version: 1 },
  revision: { id: 'rev-1', public_id: 'PUB-1', status: 'DRAFT' },
  finance: null,
  stock_lines: [
    { item_id: 'kopi', area_code: 'BAR', closing_qty: 5, stock_status: 'AMAN' },
    { item_id: 'gula', area_code: 'BAR', closing_qty: 0, stock_status: 'HABIS' },
    { item_id: 'telur', area_code: 'KITCHEN', closing_qty: 12, stock_status: 'AMAN' },
  ],
  finance_draft: null,
};

describe('ReportsView stock summary (E3/U05)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.getReport).mockResolvedValue(snapshotWithStock as any);
    vi.mocked(api.getCurrentUser).mockResolvedValue(null);
    vi.mocked(api.listReports).mockResolvedValue([]);
    vi.mocked(api.previewBonus).mockResolvedValue({ report: null, pool: null, blockers: ['Closing Bar dan Kitchen belum lengkap'] } as any);
  });

  it('renders per-area stock summary from server snapshot before finance', async () => {
    render(
      <ReportsView isFinalizer={false} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /stok penutup per area/i })).toBeDefined();
    });
    expect(screen.getByText('Bar')).toBeDefined();
    expect(screen.getByText('Kitchen')).toBeDefined();
    expect(screen.getByText(/1 perlu perhatian/i)).toBeDefined();
    expect(screen.getByRole('heading', { name: /kesiapan laporan/i })).toBeDefined();
    expect(screen.getByText(/closing bar:/i)).toBeDefined();
  });

  it('tells non-finalizers that submit belongs to BAR MALAM/FULL primary or management', async () => {
    render(
      <ReportsView isFinalizer={false} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText(/pengiriman laporan dilakukan oleh primary bar shift malam/i)).toBeDefined();
    });
    const submitBtn = screen.getByRole('button', { name: /kirim laporan resmi/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it('blocks submit while closing is incomplete even when finance format is valid', async () => {
    vi.mocked(api.getReport).mockResolvedValue({ ...snapshotWithStock, stock_lines: [
      { item_id: 'kopi', area_code: 'BAR', closing_qty: 5, stock_status: 'AMAN' },
    ] } as any);
    render(
      <ReportsView isFinalizer={true} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText(/menunggu closing terkonfirmasi/i)).toBeDefined();
    });
    const submitBtn = screen.getByRole('button', { name: /kirim laporan resmi/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    expect(screen.getByText(/tombol kirim nonaktif/i).textContent).toMatch(/closing/i);
    expect(vi.mocked(api.submitReport)).not.toHaveBeenCalled();
  });

  it('renders blank finance inputs instead of synthetic zeros before server finance loads', async () => {
    vi.mocked(api.getReport).mockResolvedValue({ ...snapshotWithStock, finance: null, finance_draft: null } as any);
    render(
      <ReportsView isFinalizer={true} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/cash fisik nyata/i)).toBeDefined();
    });
    expect((screen.getByLabelText(/cash fisik nyata/i) as HTMLInputElement).value).toBe('');
    expect(screen.getAllByText(/nilai belum valid/i).length).toBeGreaterThan(0);
  });

  it('marks the bonus preview stale after finance edits and reloads on demand', async () => {
    const user = userEvent.setup();
    vi.mocked(api.previewBonus).mockResolvedValue({
      preview: { recorded_total: 100000, tier_percent: 5, pool_amount: 5000, participant_count: 2 },
      blockers: [],
    } as any);
    render(
      <ReportsView isFinalizer={true} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText(/pool/i)).toBeDefined();
    });
    expect(vi.mocked(api.previewBonus)).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText(/cash fisik nyata/i), { target: { value: '50000' } });
    await waitFor(() => {
      expect(screen.getByText(/preview mungkin kedaluwarsa/i)).toBeDefined();
    });
    await user.click(screen.getByRole('button', { name: /muat ulang preview/i }));
    await waitFor(() => {
      expect(vi.mocked(api.previewBonus)).toHaveBeenCalledTimes(2);
    });
  });

  it('confirms before discarding unsaved finance edits on back navigation', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const confirmSpy = vi.fn().mockReturnValue(false);
    (window as any).confirm = confirmSpy;
    render(
      <ReportsView isFinalizer={true} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={onBack} />
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/cash fisik nyata/i)).toBeDefined();
    });
    fireEvent.change(screen.getByLabelText(/cash fisik nyata/i), { target: { value: '50000' } });
    await user.click(screen.getByRole('button', { name: /kembali ke workspace/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /kembali ke workspace/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
    delete (window as any).confirm;
  });

  it('shows empty-state guidance when no stock snapshot exists yet', async () => {
    vi.mocked(api.getReport).mockResolvedValue({ ...snapshotWithStock, stock_lines: [] } as any);
    render(
      <ReportsView isFinalizer={true} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText(/belum ada ringkasan stok tersimpan/i)).toBeDefined();
    });
  });
});
