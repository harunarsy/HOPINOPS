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
    expect(screen.getByText(/1 barang perlu perhatian/i)).toBeDefined();
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

  it('lets a manager open a past report and closing from the report list', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCurrentUser).mockResolvedValue({ role: 'OWNER' } as any);
    vi.mocked(api.listReports).mockResolvedValue([
      { id: 'rep-2', work_date: '2026-09-05', status: 'SUBMITTED', current_revision: 1, updated_at: '2026-09-06T00:00:00Z' },
    ] as any);

    render(
      <ReportsView isFinalizer={true} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /2026-09-05/ })).toBeDefined();
    });
    await user.click(screen.getByRole('button', { name: /2026-09-05/ }));

    await waitFor(() => {
      expect(vi.mocked(api.getReport)).toHaveBeenLastCalledWith('2026-09-05');
    });
    expect(screen.getByText(/status 2026-09-05/i)).toBeDefined();
  });

  it('steps to the previous work date with the day navigation control', async () => {
    const user = userEvent.setup();
    render(
      <ReportsView isFinalizer={true} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(vi.mocked(api.getReport)).toHaveBeenCalledWith('2026-09-06');
    });
    await user.click(screen.getByRole('button', { name: /hari sebelumnya/i }));

    await waitFor(() => {
      expect(vi.mocked(api.getReport)).toHaveBeenLastCalledWith('2026-09-05');
    });
    expect((screen.getByLabelText(/tanggal kerja/i) as HTMLInputElement).value).toBe('2026-09-05');
  });

  it('derives closing readiness from server closing_readiness, not stock line presence', async () => {
    vi.mocked(api.getReport).mockResolvedValue({
      ...snapshotWithStock,
      stock_lines: [{ item_id: 'kopi', area_code: 'BAR', closing_qty: 5, stock_status: 'AMAN' }],
      closing_readiness: { bar: { confirmed_closings: 1 }, kitchen: { confirmed_closings: 1 } },
    } as any);
    render(
      <ReportsView isFinalizer={true} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText(/closing bar: terkonfirmasi \(1 closing\)/i)).toBeDefined();
    });
    expect(screen.getByText(/closing kitchen: terkonfirmasi \(1 closing\)/i)).toBeDefined();
    expect(screen.queryAllByText(/menunggu closing terkonfirmasi/i)).toHaveLength(0);
  });

  it('flags more than one confirmed closing per area as needing attention', async () => {
    vi.mocked(api.getReport).mockResolvedValue({
      ...snapshotWithStock,
      closing_readiness: { bar: { confirmed_closings: 2 }, kitchen: { confirmed_closings: 0 } },
    } as any);
    render(
      <ReportsView isFinalizer={true} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText(/2 closing terkonfirmasi, server minta tepat 1/i)).toBeDefined();
    });
    const submitBtn = screen.getByRole('button', { name: /kirim laporan resmi/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it('renders per-item stock detail with quantity, unit, and category', async () => {
    vi.mocked(api.getReport).mockResolvedValue({
      ...snapshotWithStock,
      stock_lines: [
        { item_id: 'kopi', item_name: 'Kopi Susu', unit_code: 'kilo', decimal_scale_snapshot: 3, area_code: 'BAR', closing_qty: 5.5, stock_status: 'AMAN' },
        { item_id: 'gula', item_name: 'Gula Pasir', unit_code: 'kg', decimal_scale_snapshot: 2, area_code: 'BAR', closing_qty: 0, stock_status: 'HABIS' },
      ],
    } as any);
    render(
      <ReportsView isFinalizer={false} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText('Kopi Susu')).toBeDefined();
    });
    expect(screen.getByText('Gula Pasir')).toBeDefined();
    expect(screen.getByText('5,500 kilo')).toBeDefined();
    expect(screen.getByText('0,00 kg')).toBeDefined();
  });

  it('sorts stock lines habis, hampir habis, aman and colors each category', async () => {
    vi.mocked(api.getReport).mockResolvedValue({
      ...snapshotWithStock,
      stock_lines: [
        { item_id: 'aman-item', item_name: 'Aman Item', unit_code: 'pcs', decimal_scale_snapshot: 0, area_code: 'BAR', closing_qty: 10, stock_status: 'AMAN' },
        { item_id: 'habis-item', item_name: 'Habis Item', unit_code: 'pcs', decimal_scale_snapshot: 0, area_code: 'BAR', closing_qty: 0, stock_status: 'HABIS' },
        { item_id: 'hampir-item', item_name: 'Hampir Item', unit_code: 'pcs', decimal_scale_snapshot: 0, area_code: 'BAR', closing_qty: 1, stock_status: 'HAMPIR_HABIS' },
      ],
    } as any);
    render(
      <ReportsView isFinalizer={false} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText('Habis Item')).toBeDefined();
    });

    const ordered = screen.getAllByRole('listitem')
      .map((node) => node.textContent ?? '')
      .filter((text) => /Habis Item|Hampir Item|Aman Item/.test(text));
    expect(ordered[0]).toContain('Habis Item');
    expect(ordered[1]).toContain('Hampir Item');
    expect(ordered[2]).toContain('Aman Item');

    const badge = (label: string) => screen.getAllByText(label).find((node) => node.style.background) as HTMLElement;
    expect(badge('Habis').style.color).toBe('#b91c1c');
    expect(badge('Hampir habis').style.color).toBe('#b45309');
    expect(badge('Aman').style.color).toBe('#1e5b48');
  });

  it('renders the finance report above the stock report', async () => {
    render(
      <ReportsView isFinalizer={true} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /rincian keuangan/i })).toBeDefined();
    });
    const finance = screen.getByRole('heading', { name: /rincian keuangan/i });
    const stock = screen.getByRole('heading', { name: /stok penutup per area/i });
    expect(finance.compareDocumentPosition(stock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sends the optional finance note with the draft and omits the key when blank', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getReport).mockResolvedValue({
      ...snapshotWithStock,
      closing_readiness: { bar: { confirmed_closings: 1 }, kitchen: { confirmed_closings: 1 } },
    } as any);
    vi.mocked(api.saveReportFinance).mockResolvedValue({ version: 2 } as any);
    render(
      <ReportsView isFinalizer={true} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/cash fisik nyata/i)).toBeDefined();
    });
    await user.type(screen.getByLabelText(/cash fisik nyata/i), '105000');
    await user.type(screen.getByLabelText(/cash pos/i), '95000');
    await user.type(screen.getByLabelText(/qris mandiri/i), '520000');
    await user.type(screen.getByLabelText(/debit mandiri/i), '50000');
    await user.type(screen.getByLabelText(/keterangan/i), '  Kas selisih karena kembalian  ');
    await user.click(screen.getByRole('button', { name: /simpan draft/i }));

    await waitFor(() => {
      expect(vi.mocked(api.saveReportFinance)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(api.saveReportFinance).mock.calls[0][2]).toEqual({
      cash_real: 105000,
      cash_app: 95000,
      qris_mandiri: 520000,
      debit_mandiri: 50000,
      note: 'Kas selisih karena kembalian',
    });
  });

  it('omits the note key entirely when keterangan is left blank', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getReport).mockResolvedValue({
      ...snapshotWithStock,
      closing_readiness: { bar: { confirmed_closings: 1 }, kitchen: { confirmed_closings: 1 } },
    } as any);
    vi.mocked(api.saveReportFinance).mockResolvedValue({ version: 2 } as any);
    render(
      <ReportsView isFinalizer={true} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/cash fisik nyata/i)).toBeDefined();
    });
    await user.type(screen.getByLabelText(/cash fisik nyata/i), '105000');
    await user.type(screen.getByLabelText(/cash pos/i), '95000');
    await user.type(screen.getByLabelText(/qris mandiri/i), '520000');
    await user.type(screen.getByLabelText(/debit mandiri/i), '50000');
    await user.type(screen.getByLabelText(/keterangan/i), '   ');
    await user.click(screen.getByRole('button', { name: /simpan draft/i }));

    await waitFor(() => {
      expect(vi.mocked(api.saveReportFinance)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(api.saveReportFinance).mock.calls[0][2]).not.toHaveProperty('note');
  });

  it('copies a full-detail report template with stock, finance, and keterangan', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.mocked(api.getReport).mockResolvedValue({
      ...snapshotWithStock,
      report: { id: 'rep-1', status: 'SUBMITTED', current_revision: 1, version: 2 },
      revision: { id: 'rev-1', public_id: 'PUB-1', status: 'SUBMITTED' },
      finance: { cash_real: 105000, cash_app: 95000, qris_mandiri: 520000, debit_mandiri: 50000, note: 'Catatan kas' },
      closing_readiness: { bar: { confirmed_closings: 1 }, kitchen: { confirmed_closings: 1 } },
    } as any);
    render(
      <ReportsView isFinalizer={false} workDate="2026-09-06" onRefresh={vi.fn().mockResolvedValue(true)} onBack={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /salin template laporan/i })).toBeDefined();
    });
    await user.click(screen.getByRole('button', { name: /salin template laporan/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain('LAPORAN HARIAN HOPIN');
    expect(text).toContain('Tanggal: 2026-09-06');
    expect(text).toContain('Status: SUBMITTED · revisi 1');
    expect(text).toContain('STOK PENUTUP — BAR (2 barang)');
    expect(text).toContain('- kopi: 5,00 — Aman');
    expect(text).toContain('- gula: 0,00 — Habis');
    expect(text).toContain('STOK PENUTUP — KITCHEN (1 barang)');
    expect(text).toMatch(/Cash Fisik Nyata: Rp\s?105\.000/);
    expect(text).toContain('Keterangan: Catatan kas');
  });
});
