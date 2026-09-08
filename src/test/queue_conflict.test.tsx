import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../lib/api';
import { idbQueue } from '../lib/idb-queue';
import { StockWorkspace } from '../features/stock/StockWorkspace';

vi.mock('../lib/api', () => ({
  api: {
    getStockDrafts: vi.fn(),
    getOpeningReference: vi.fn(),
    getChecklistLayout: vi.fn(),
    getCycle: vi.fn(),
  },
}));

vi.mock('../lib/idb-queue', () => ({
  idbQueue: {
    recoverSending: vi.fn(),
    getForAggregate: vi.fn(),
    markSending: vi.fn(),
    markPending: vi.fn(),
    markConflict: vi.fn(),
    markFailed: vi.fn(),
    remove: vi.fn(),
    add: vi.fn(),
  },
}));

const conflictItem = {
  id: 'conflict-abc123',
  idempotencyKey: 'key-1',
  profileId: 'user-1',
  outletId: 'outlet-1',
  aggregateId: 'cycle-1',
  baseVersion: 1,
  action: 'movement.create',
  payload: {},
  createdAtClient: Date.now(),
  attemptCount: 1,
  lastErrorCode: 'VERSION_CONFLICT',
  nextAttemptAt: null,
  state: 'CONFLICT',
} as any;

function renderWorkspace(onRefresh: () => Promise<boolean>) {
  return render(
    <StockWorkspace
      profileId="user-1"
      outletId="outlet-1"
      cycleId="cycle-1"
      area="BAR"
      shift="SIANG"
      dutyRole="PRIMARY"
      items={[{ id: 'kopi', name: 'Kopi', unit_code: 'kg', area_code: 'BAR' } as any]}
      cycleData={null}
      canManage={false}
      onRefresh={onRefresh}
      onCheckOutRequest={vi.fn()}
      onGoReports={vi.fn()}
    />
  );
}

describe('E2: conflict queue is never deleted on failed refresh', () => {
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
    vi.mocked(api.getCycle).mockResolvedValue({ cycle: { id: 'cycle-1', version: 1 }, movements: [] });
    vi.mocked(idbQueue.recoverSending).mockResolvedValue(undefined as any);
    vi.mocked(idbQueue.getForAggregate).mockResolvedValue([conflictItem]);
  });

  it('keeps the queue entry and warns when refresh fails', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn().mockResolvedValue(false);
    renderWorkspace(onRefresh);

    const resolveBtn = await screen.findByRole('button', { name: /selesaikan konflik/i });
    await user.click(resolveBtn);

    const confirmBtn = await screen.findByRole('button', { name: /muat ulang & hapus/i });
    await user.click(confirmBtn);

    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(idbQueue.remove).not.toHaveBeenCalled();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => /tetap tersimpan/i.test(a.textContent ?? ''))).toBe(true);
  });

  it('shows a storage error with retry instead of endless loading when IndexedDB fails', async () => {
    const user = userEvent.setup();
    vi.mocked(idbQueue.recoverSending).mockRejectedValueOnce(new Error('IDB blocked'));
    renderWorkspace(vi.fn().mockResolvedValue(true));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/penyimpanan perangkat/i);
    expect(screen.queryByText(/memuat status antrean/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: /^coba lagi$/i }));
    await waitFor(() => {
      expect(screen.queryByText(/penyimpanan perangkat/i)).toBeNull();
    });
  });

  it('deletes the queue entry only after fresh data is confirmed loaded', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn().mockResolvedValue(true);
    renderWorkspace(onRefresh);

    const resolveBtn = await screen.findByRole('button', { name: /selesaikan konflik/i });
    await user.click(resolveBtn);

    const confirmBtn = await screen.findByRole('button', { name: /muat ulang & hapus/i });
    await user.click(confirmBtn);

    await waitFor(() => expect(idbQueue.remove).toHaveBeenCalled());
    expect(screen.queryByText(/tetap tersimpan/i)).toBeNull();
  });
});
