import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../lib/api';
import { CatalogManager } from '../features/management/CatalogManager';

vi.mock('../lib/api', () => ({
  api: {
    listItems: vi.fn(),
    getChecklistLayout: vi.fn(),
    createItem: vi.fn(),
    archiveItem: vi.fn(),
    upsertChecklistSection: vi.fn(),
    moveChecklistItem: vi.fn(),
  },
}));

describe('CatalogManager (E1: B01/B07 server-owned checklist)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.listItems).mockResolvedValue([
      { id: 'gula', name: 'Gula', unit_code: 'kg', area_code: 'BAR', active: true },
      { id: 'kopi', name: 'Kopi', unit_code: 'kg', area_code: 'BAR', active: true },
    ]);
    vi.mocked(api.getChecklistLayout).mockResolvedValue({ version: 3, sections: [], placements: [] });
  });

  it('renders server layout version and falls back to item list without local name-sort override', async () => {
    render(<CatalogManager />);
    await waitFor(() => {
      expect(screen.getByText(/susunan aktif server/i)).toBeDefined();
    });
    expect(screen.getByText(/Gula/)).toBeDefined();
    expect(screen.getByText(/Kopi/)).toBeDefined();
  });

  it('ignores an older area response that arrives after a newer area response', async () => {
    let resolveBar!: (value: any) => void;
    const barLayout = new Promise((resolve) => { resolveBar = resolve; });
    vi.mocked(api.getChecklistLayout).mockImplementation((area) => area === 'BAR' ? barLayout as any : Promise.resolve({ version: 7, sections: [], placements: [] }));
    const user = userEvent.setup();
    render(<CatalogManager />);
    await user.click(screen.getByRole('button', { name: 'Kitchen' }));
    await waitFor(() => expect(screen.getByText(/versi 7/i)).toBeDefined());
    resolveBar({ version: 2, sections: [], placements: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText(/versi 7/i)).toBeDefined();
  });

  it('creates items and reports next-cycle effect without claiming instant availability', async () => {
    const user = userEvent.setup();
    vi.mocked(api.createItem).mockResolvedValue({ id: 'teh', active: true });
    render(<CatalogManager />);

    await waitFor(() => expect(screen.getByText(/Gula/)).toBeDefined());
    await user.type(screen.getByPlaceholderText('sirup_gula'), 'teh');
    await user.type(screen.getByPlaceholderText('Sirup Gula'), 'Teh');
    await user.click(screen.getByRole('button', { name: /tambah barang/i }));

    await waitFor(() => expect(api.createItem).toHaveBeenCalled());
    expect((await screen.findByRole('status')).textContent).toMatch(/cycle berikutnya/i);
  });

  it('clears stale list and archive form when switching area before load finishes', async () => {
    let resolveKitchen!: (value: any) => void;
    const kitchenLayout = new Promise((resolve) => { resolveKitchen = resolve; });
    vi.mocked(api.getChecklistLayout).mockImplementation((area) => area === 'BAR'
      ? Promise.resolve({ version: 3, sections: [], placements: [] })
      : kitchenLayout as any);
    const user = userEvent.setup();
    render(<CatalogManager />);

    await waitFor(() => expect(screen.getByText(/Gula/)).toBeDefined());
    const gulaRow = screen.getByText('Gula').closest('li')!;
    await user.click(within(gulaRow as HTMLElement).getByRole('button', { name: 'Arsip' }));
    expect(screen.getByPlaceholderText(/alasan arsip/i)).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Kitchen' }));
    expect(screen.queryByPlaceholderText(/alasan arsip/i)).toBeNull();
    expect(screen.queryByText(/Gula/)).toBeNull();

    resolveKitchen({ version: 7, sections: [], placements: [] });
    await waitFor(() => expect(screen.getByText(/versi 7/i)).toBeDefined());
  });

  it('labels a pending layout as next-cycle draft instead of claiming it active', async () => {
    vi.mocked(api.getChecklistLayout).mockResolvedValue({
      version: 5, pending: true, pending_version: 5, effective_next_cycle: true, sections: [], placements: [],
    });
    render(<CatalogManager />);
    await waitFor(() => expect(screen.getByText(/draft cycle berikutnya/i)).toBeDefined());
    expect(screen.queryByText(/susunan aktif/i)).toBeNull();
  });

  it('disables layout controls while a layout mutation is in flight', async () => {
    let resolveMove!: (value: any) => void;
    const movePromise = new Promise((resolve) => { resolveMove = resolve; });
    vi.mocked(api.getChecklistLayout).mockResolvedValue({
      version: 3,
      sections: [{ id: 's1', name: 'Rak', position: 0, active: true }],
      placements: [
        { item_id: 'gula', section_id: 's1', position: 0 },
        { item_id: 'kopi', section_id: 's1', position: 1 },
      ],
    });
    vi.mocked(api.moveChecklistItem).mockReturnValue(movePromise as any);
    const user = userEvent.setup();
    render(<CatalogManager />);

    const downBtn = await screen.findByRole('button', { name: /pindahkan gula ke bawah/i }) as HTMLButtonElement;
    await user.click(downBtn);
    await waitFor(() => expect(downBtn.disabled).toBe(true));
    resolveMove({ layout_version: 4 });
    await waitFor(() => expect(downBtn.disabled).toBe(false));
  });

  it('requires archive reason before archiving and preserves history note', async () => {
    const user = userEvent.setup();
    vi.mocked(api.archiveItem).mockResolvedValue({ id: 'gula', active: false });
    render(<CatalogManager />);

    await waitFor(() => expect(screen.getByText(/Gula/)).toBeDefined());
    const gulaRow = screen.getByText('Gula').closest('li')!;
    await user.click(within(gulaRow as HTMLElement).getByRole('button', { name: 'Arsip' }));

    const archiveBtn = screen.getByRole('button', { name: /arsipkan/i }) as HTMLButtonElement;
    expect(archiveBtn.disabled).toBe(true);
    await user.type(screen.getByPlaceholderText(/alasan arsip/i), 'tidak dipakai');
    expect(archiveBtn.disabled).toBe(false);
    await user.click(archiveBtn);

    await waitFor(() => expect(api.archiveItem).toHaveBeenCalledWith('gula', 'tidak dipakai'));
    expect((await screen.findByRole('status')).textContent).toMatch(/histori/i);
  });
});
