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
    updateItem: vi.fn(),
    archiveItem: vi.fn(),
    operatorCreateItem: vi.fn(),
    operatorUpdateItem: vi.fn(),
    operatorArchiveItem: vi.fn(),
    upsertChecklistSection: vi.fn(),
    moveChecklistItem: vi.fn(),
  },
}));

const items = [
  { id: 'gula', name: 'Gula', unit_code: 'kg', area_code: 'BAR', decimal_scale: 2, low_threshold: 1, active: true },
  { id: 'kopi', name: 'Kopi', unit_code: 'kg', area_code: 'BAR', decimal_scale: 2, low_threshold: 2, active: true },
];

describe('CatalogManager', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.listItems).mockResolvedValue(items);
    vi.mocked(api.getChecklistLayout).mockResolvedValue({ version: 3, sections: [], placements: [] });
  });

  it('renders the server catalog without exposing raw item IDs', async () => {
    render(<CatalogManager />);
    await waitFor(() => expect(screen.getByText('Gula')).toBeDefined());
    expect(screen.getByText('Kopi')).toBeDefined();
    expect(screen.queryByText(/gula.*kg/i)).toBeNull();
  });

  it('ignores an older area response that arrives after a newer area response', async () => {
    let resolveBar!: (value: any) => void;
    const barLayout = new Promise((resolve) => { resolveBar = resolve; });
    vi.mocked(api.getChecklistLayout).mockImplementation((area) => area === 'BAR' ? barLayout as any : Promise.resolve({ version: 7, sections: [], placements: [] }));
    const user = userEvent.setup();
    render(<CatalogManager />);
    await user.click(screen.getByRole('button', { name: 'Kitchen' }));
    await waitFor(() => expect(screen.getByText(/cycle berikutnya/i)).toBeDefined());
    resolveBar({ version: 2, sections: [], placements: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText(/varian kitchen/i)).toBeDefined();
  });

  it('creates items and reports next-cycle effect without claiming instant availability', async () => {
    const user = userEvent.setup();
    vi.mocked(api.createItem).mockResolvedValue({ id: 'teh', active: true });
    render(<CatalogManager />);
    await waitFor(() => expect(screen.getByText('Gula')).toBeDefined());
    await user.type(screen.getByPlaceholderText('sirup_gula'), 'teh');
    await user.type(screen.getByPlaceholderText('Sirup gula'), 'Teh');
    await user.click(screen.getByRole('button', { name: /tambah varian/i }));
    await waitFor(() => expect(api.createItem).toHaveBeenCalled());
    expect((await screen.findByRole('status')).textContent).toMatch(/cycle berikutnya/i);
  });

  it('uses the scoped operator endpoint for a PRIMARY assigned to the fixed area', async () => {
    const user = userEvent.setup();
    vi.mocked(api.operatorCreateItem).mockResolvedValue({ id: 'teh', active: true });
    render(<CatalogManager fixedArea="BAR" mutationScope="PRIMARY" />);
    await waitFor(() => expect(screen.getByText('Gula')).toBeDefined());
    expect(screen.queryByRole('button', { name: 'Kitchen' })).toBeNull();
    await user.type(screen.getByPlaceholderText('sirup_gula'), 'teh');
    await user.type(screen.getByPlaceholderText('Sirup gula'), 'Teh');
    await user.click(screen.getByRole('button', { name: /tambah varian/i }));
    await waitFor(() => expect(api.operatorCreateItem).toHaveBeenCalled());
    expect(api.createItem).not.toHaveBeenCalled();
  });

  it('locks mutation controls for a HELPER while keeping the catalog visible', async () => {
    render(<CatalogManager fixedArea="BAR" mutationScope="READ_ONLY" lockedMessage="Petugas bantuan sedang bertugas." />);
    await waitFor(() => expect(screen.getByText('Gula')).toBeDefined());
    expect(screen.getByText(/petugas bantuan sedang bertugas/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /tambah varian/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ubah' })).toBeNull();
  });

  it('edits catalog metadata with a next-cycle notice', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateItem).mockResolvedValue({ id: 'gula', active: true });
    render(<CatalogManager />);
    const row = await screen.findByText('Gula');
    await user.click(within(row.closest('li') as HTMLElement).getByRole('button', { name: 'Ubah' }));
    const nameInput = screen.getByDisplayValue('Gula');
    await user.clear(nameInput);
    await user.type(nameInput, 'Gula aren');
    await user.click(screen.getByRole('button', { name: /simpan perubahan/i }));
    await waitFor(() => expect(api.updateItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'gula', name: 'Gula aren' })));
    expect((await screen.findByRole('status')).textContent).toMatch(/histori sebelumnya tidak berubah/i);
  });

  it('requires an archive reason and preserves history note', async () => {
    const user = userEvent.setup();
    vi.mocked(api.archiveItem).mockResolvedValue({ id: 'gula', active: false });
    render(<CatalogManager />);
    const row = await screen.findByText('Gula');
    await user.click(within(row.closest('li') as HTMLElement).getByRole('button', { name: 'Arsip' }));
    const archive = screen.getByRole('button', { name: /arsipkan/i }) as HTMLButtonElement;
    expect(archive.disabled).toBe(true);
    await user.type(screen.getByPlaceholderText(/alasan arsip/i), 'tidak dipakai');
    await user.click(archive);
    await waitFor(() => expect(api.archiveItem).toHaveBeenCalledWith('gula', 'tidak dipakai'));
    expect((await screen.findByRole('status')).textContent).toMatch(/histori/i);
  });
});
