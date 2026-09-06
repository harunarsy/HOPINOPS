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
      expect(screen.getByText(/versi susunan server/i)).toBeDefined();
    });
    expect(screen.getByText(/Gula/)).toBeDefined();
    expect(screen.getByText(/Kopi/)).toBeDefined();
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
