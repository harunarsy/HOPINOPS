import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
