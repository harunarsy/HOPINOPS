import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';

type Area = 'BAR' | 'KITCHEN';
type MutationScope = 'MANAGEMENT' | 'PRIMARY' | 'READ_ONLY';
type Section = { id: string; name: string; position: number; active: boolean };
type Placement = { item_id: string; section_id: string | null; position: number | null };
type CatalogItem = {
  id: string;
  display_code?: string;
  name: string;
  unit_code: string;
  area_code: Area;
  decimal_scale: number;
  low_threshold: number;
  active: boolean;
};
type UnitOption = { code: string; label: string; decimal_scale: number; active: boolean; sort_order: number };
type ItemRevision = {
  id: string;
  action: 'CREATE' | 'UPDATE' | 'ARCHIVE' | 'RESTORE';
  effective_at: string;
  reason?: string | null;
  before_json?: Record<string, unknown> | null;
  after_json?: Record<string, unknown> | null;
  changed_by?: string | null;
};
type UnitRevision = {
  id: string;
  action: 'CREATE' | 'UPDATE' | 'ARCHIVE' | 'RESTORE';
  effective_at: string;
  reason?: string | null;
  before_json?: Record<string, unknown> | null;
  after_json?: Record<string, unknown> | null;
  changed_by?: string | null;
};

type Props = { fixedArea?: Area; mutationScope?: MutationScope; lockedMessage?: string };
const DEFAULT_SECTION = 'Belum ditempatkan ke kelompok';
const FALLBACK_UNITS: UnitOption[] = [
  { code: 'gram', label: 'gram', decimal_scale: 2, active: true, sort_order: 10 },
  { code: 'ml', label: 'ml', decimal_scale: 2, active: true, sort_order: 20 },
  { code: 'pcs', label: 'pcs', decimal_scale: 0, active: true, sort_order: 30 },
  { code: 'pack', label: 'pack', decimal_scale: 0, active: true, sort_order: 40 },
  { code: 'roll', label: 'roll', decimal_scale: 0, active: true, sort_order: 50 },
  { code: 'liter', label: 'liter', decimal_scale: 2, active: true, sort_order: 60 },
];

function formatDateTime(value?: string) {
  if (!value) return 'Waktu belum tersedia';
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(value));
}

function actionLabel(action: ItemRevision['action'] | UnitRevision['action']) {
  return ({ CREATE: 'Dibuat', UPDATE: 'Diperbarui', ARCHIVE: 'Diarsipkan', RESTORE: 'Dipulihkan' })[action];
}

function revisionChanges(revision: ItemRevision) {
  const before = revision.before_json ?? {};
  const after = revision.after_json ?? {};
  const labels: Array<[string, string]> = [
    ['Nama', 'name'],
    ['Satuan', 'unit_code'],
    ['Batas minimum', 'low_threshold'],
    ['Kode tampilan', 'display_code'],
    ['Status', 'active'],
  ];
  return labels.flatMap(([label, key]) => {
    const previous = before[key];
    const current = after[key];
    if (revision.action !== 'CREATE' && Object.is(previous, current)) return [];
    const format = (value: unknown) => value === true ? 'aktif' : value === false ? 'arsip' : value == null ? '—' : String(value);
    return [{ label, value: revision.action === 'CREATE' ? format(current) : `${format(previous)} → ${format(current)}` }];
  });
}

function unitRevisionChanges(revision: UnitRevision) {
  const before = revision.before_json ?? {};
  const after = revision.after_json ?? {};
  const fields: Array<[string, string]> = [['Nama', 'label'], ['Skala desimal', 'decimal_scale'], ['Urutan', 'sort_order'], ['Status', 'active']];
  return fields.flatMap(([label, key]) => {
    const previous = before[key];
    const current = after[key];
    if (revision.action !== 'CREATE' && Object.is(previous, current)) return [];
    const format = (value: unknown) => value === true ? 'aktif' : value === false ? 'arsip' : value == null ? '—' : String(value);
    return [{ label, value: revision.action === 'CREATE' ? format(current) : `${format(previous)} → ${format(current)}` }];
  });
}

export function CatalogManager({ fixedArea, mutationScope = 'MANAGEMENT', lockedMessage }: Props) {
  const [area, setArea] = useState<Area>(fixedArea ?? 'BAR');
  const [loadedArea, setLoadedArea] = useState<Area | null>(null);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [layoutVersion, setLayoutVersion] = useState(1);
  const [layoutPending, setLayoutPending] = useState(false);
  const [layoutPendingVersion, setLayoutPendingVersion] = useState<number | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUnit, setNewUnit] = useState('pcs');
  const [newThreshold, setNewThreshold] = useState('0');
  const [newSectionId, setNewSectionId] = useState('');
  const [newSection, setNewSection] = useState('');
  const [archiveReason, setArchiveReason] = useState('');
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [restoreReason, setRestoreReason] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<CatalogItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editUnit, setEditUnit] = useState('');
  const [editThreshold, setEditThreshold] = useState('0');
  const [historyTarget, setHistoryTarget] = useState<CatalogItem | null>(null);
  const [history, setHistory] = useState<ItemRevision[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [layoutMode, setLayoutMode] = useState(false);
  const [pendingLayoutChange, setPendingLayoutChange] = useState(false);
  const [unitManagerOpen, setUnitManagerOpen] = useState(false);
  const [unitHistoryTarget, setUnitHistoryTarget] = useState<UnitOption | null>(null);
  const [unitHistory, setUnitHistory] = useState<UnitRevision[]>([]);
  const [unitHistoryLoading, setUnitHistoryLoading] = useState(false);
  const [unitShowArchived, setUnitShowArchived] = useState(false);
  const [newUnitCode, setNewUnitCode] = useState('');
  const [newUnitLabel, setNewUnitLabel] = useState('');
  const [newUnitScale, setNewUnitScale] = useState('2');
  const [unitArchiveTarget, setUnitArchiveTarget] = useState<string | null>(null);
  const [unitArchiveReason, setUnitArchiveReason] = useState('');
  const loadRequestRef = useRef(0);
  const activeAreaRef = useRef<Area>(fixedArea ?? 'BAR');
  const canMutate = mutationScope !== 'READ_ONLY';
  const canManageUnits = mutationScope === 'MANAGEMENT';
  const isPrimary = mutationScope === 'PRIMARY';

  useEffect(() => {
    if (!fixedArea || fixedArea === activeAreaRef.current) return;
    activeAreaRef.current = fixedArea;
    setArea(fixedArea);
  }, [fixedArea]);

  const load = async (targetArea: Area) => {
    const requestId = ++loadRequestRef.current;
    setLoading(true); setError('');
    try {
      const [itemList, layout, unitList] = await Promise.all([
        api.listItems(showArchived),
        api.getChecklistLayout(targetArea),
        typeof api.listUnitOptions === 'function' ? api.listUnitOptions(canManageUnits).catch(() => FALLBACK_UNITS) : Promise.resolve(FALLBACK_UNITS),
      ]);
      if (loadRequestRef.current !== requestId || activeAreaRef.current !== targetArea) return;
      setItems((itemList as CatalogItem[]).filter((item) => item.area_code === targetArea));
      const availableUnits = ((unitList as UnitOption[]).length > 0 ? unitList as UnitOption[] : FALLBACK_UNITS).filter((unit) => unit.active || canManageUnits);
      setUnits(availableUnits);
      setLayoutVersion(layout.version);
      setLayoutPending(layout.pending === true);
      setLayoutPendingVersion(typeof layout.pending_version === 'number' ? layout.pending_version : null);
      setSections(layout.sections.filter((section) => section.active));
      setPlacements(layout.placements);
      setLoadedArea(targetArea);
      setNewUnit((current) => availableUnits.some((unit) => unit.active && unit.code === current)
        ? current
        : availableUnits.find((unit) => unit.active)?.code ?? '');
    } catch (err: any) {
      if (loadRequestRef.current === requestId && activeAreaRef.current === targetArea) setError(err?.message || 'Gagal memuat katalog.');
    } finally {
      if (loadRequestRef.current === requestId && activeAreaRef.current === targetArea) setLoading(false);
    }
  };

  useEffect(() => { void load(area); }, [area, showArchived, canManageUnits]);

  const switchArea = (next: Area) => {
    if (fixedArea || next === activeAreaRef.current) return;
    activeAreaRef.current = next; loadRequestRef.current += 1; setArea(next); setLoadedArea(null); setItems([]); setSections([]); setPlacements([]);
    setNewSectionId(''); setArchiveTarget(null); setRestoreTarget(null); setEditTarget(null); setHistoryTarget(null); setNotice(''); setLayoutMode(false);
  };

  const placementByItem = useMemo(() => new Map(placements.map((placement) => [placement.item_id, placement])), [placements]);
  const sectionById = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);
  const grouped = useMemo(() => {
    const ordered = [...items].sort((left, right) => {
      const leftPlacement = placementByItem.get(left.id); const rightPlacement = placementByItem.get(right.id);
      const leftSection = leftPlacement?.section_id ? sectionById.get(leftPlacement.section_id)?.position ?? 999 : 999;
      const rightSection = rightPlacement?.section_id ? sectionById.get(rightPlacement.section_id)?.position ?? 999 : 999;
      return leftSection - rightSection || (leftPlacement?.position ?? 999) - (rightPlacement?.position ?? 999) || left.name.localeCompare(right.name);
    });
    return ordered.reduce((result, item) => {
      const placement = placementByItem.get(item.id);
      const name = (placement?.section_id && sectionById.get(placement.section_id)?.name) || DEFAULT_SECTION;
      result.set(name, [...(result.get(name) ?? []), item]); return result;
    }, new Map<string, CatalogItem[]>());
  }, [items, placementByItem, sectionById]);

  const createItem = async () => {
    const operationArea = activeAreaRef.current; const threshold = Number(newThreshold);
    if (!newName.trim() || !newUnit || !Number.isFinite(threshold) || threshold < 0) { setError('Nama, satuan, dan batas stok minimum wajib diisi dengan benar.'); return; }
    setError(''); setNotice('');
    const item = { area_code: operationArea, name: newName.trim(), unit_code: newUnit, low_threshold: threshold, section_id: newSectionId || null };
    try {
      if (isPrimary) await api.operatorCreateItem(item); else await api.createItem(item);
      if (activeAreaRef.current !== operationArea) return;
      setNotice(`Varian ${newName.trim()} ditambahkan dan akan berlaku pada cycle berikutnya.`); setNewName(''); setNewThreshold('0'); setNewSectionId(''); await load(operationArea);
    } catch (err: any) { if (activeAreaRef.current === operationArea) setError(err?.message || 'Gagal menambah varian.'); }
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    const threshold = Number(editThreshold);
    if (!editName.trim() || !editUnit || !Number.isFinite(threshold) || threshold < 0) { setError('Nama, satuan, dan batas stok minimum wajib valid.'); return; }
    const operationArea = activeAreaRef.current; setError(''); setNotice('');
    try {
      const payload = { id: editTarget.id, name: editName.trim(), unit_code: editUnit, low_threshold: threshold };
      if (isPrimary) await api.operatorUpdateItem(payload); else await api.updateItem(payload);
      if (activeAreaRef.current !== operationArea) return;
      setEditTarget(null); setNotice('Varian diperbarui untuk cycle berikutnya. Catatan stok dan histori sebelumnya tidak berubah.'); await load(operationArea);
    } catch (err: any) { if (activeAreaRef.current === operationArea) setError(err?.message || 'Gagal memperbarui varian.'); }
  };

  const archiveItem = async () => {
    if (!archiveTarget || !archiveReason.trim()) return; const operationArea = activeAreaRef.current; setError(''); setNotice('');
    try {
      if (isPrimary) await api.operatorArchiveItem(archiveTarget, archiveReason.trim()); else await api.archiveItem(archiveTarget, archiveReason.trim());
      if (activeAreaRef.current !== operationArea) return;
      setArchiveTarget(null); setArchiveReason(''); setNotice('Varian diarsipkan untuk cycle berikutnya. Histori dan laporan lama tetap utuh.'); await load(operationArea);
    } catch (err: any) { if (activeAreaRef.current === operationArea) setError(err?.message || 'Gagal mengarsipkan varian.'); }
  };

  const restoreItem = async () => {
    if (!restoreTarget || !restoreReason.trim()) return; const operationArea = activeAreaRef.current; setError(''); setNotice('');
    try {
      await api.restoreItem(restoreTarget, restoreReason.trim());
      if (activeAreaRef.current !== operationArea) return;
      setRestoreTarget(null); setRestoreReason(''); setNotice('Varian dipulihkan untuk cycle berikutnya dan tetap memakai kode yang sama.'); await load(operationArea);
    } catch (err: any) { if (activeAreaRef.current === operationArea) setError(err?.message || 'Gagal memulihkan varian.'); }
  };

  const openHistory = async (item: CatalogItem) => {
    setHistoryTarget(item); setHistory([]); setHistoryLoading(true); setError('');
    try { setHistory(await api.itemHistory(item.id) as ItemRevision[]); } catch (err: any) { setError(err?.message || 'Gagal memuat histori varian.'); } finally { setHistoryLoading(false); }
  };

  const moveItem = async (itemId: string, sectionId: string, position: number) => {
    if (pendingLayoutChange) return; const operationArea = activeAreaRef.current; setPendingLayoutChange(true); setError(''); setNotice('');
    try { await api.moveChecklistItem(operationArea, itemId, sectionId, position, layoutVersion, crypto.randomUUID()); if (activeAreaRef.current !== operationArea) return; setNotice('Kelompok checklist disimpan untuk cycle berikutnya.'); await load(operationArea); }
    catch (err: any) { if (activeAreaRef.current !== operationArea) return; if (/VERSION_CONFLICT/.test(err?.message ?? '')) { setError('Susunan berubah oleh pengguna lain. Memuat versi terbaru.'); await load(operationArea); } else setError(err?.message || 'Gagal memindahkan varian.'); }
    finally { if (activeAreaRef.current === operationArea) setPendingLayoutChange(false); }
  };

  const createSection = async () => {
    if (!newSection.trim() || pendingLayoutChange) return; const operationArea = activeAreaRef.current; setPendingLayoutChange(true); setError('');
    try { await api.upsertChecklistSection(operationArea, newSection.trim(), null, crypto.randomUUID()); if (activeAreaRef.current !== operationArea) return; setNewSection(''); setNotice('Kelompok checklist ditambahkan untuk cycle berikutnya.'); await load(operationArea); }
    catch (err: any) { if (activeAreaRef.current === operationArea) setError(err?.message || 'Gagal menambah kelompok.'); }
    finally { if (activeAreaRef.current === operationArea) setPendingLayoutChange(false); }
  };

  const refreshUnits = async () => {
    if (typeof api.listUnitOptions !== 'function') return;
    try { setUnits(await api.listUnitOptions(unitShowArchived) as UnitOption[]); } catch (err: any) { setError(err?.message || 'Gagal memuat satuan.'); }
  };

  const createUnit = async () => {
    const code = newUnitCode.trim().toLowerCase();
    if (!/^[a-z][a-z0-9._-]{0,31}$/.test(code) || !newUnitLabel.trim()) { setError('Kode dan nama satuan wajib valid.'); return; }
    try { await api.createUnitOption({ code, label: newUnitLabel.trim(), decimal_scale: Number(newUnitScale) }); setNewUnitCode(''); setNewUnitLabel(''); setNotice('Satuan ditambahkan dan siap dipakai pada cycle berikutnya.'); await refreshUnits(); }
    catch (err: any) { setError(err?.message || 'Gagal menambah satuan.'); }
  };

  const archiveUnit = async () => {
    if (!unitArchiveTarget || !unitArchiveReason.trim()) return;
    try { await api.archiveUnitOption(unitArchiveTarget, unitArchiveReason.trim()); setUnitArchiveTarget(null); setUnitArchiveReason(''); setNotice('Satuan diarsipkan. Histori item lama tetap memakai snapshot satuannya.'); await refreshUnits(); }
    catch (err: any) { setError(err?.message || 'Gagal mengarsipkan satuan.'); }
  };

  const restoreUnit = async (code: string) => {
    try { await api.restoreUnitOption(code); setNotice('Satuan dipulihkan dan tersedia untuk cycle berikutnya.'); await refreshUnits(); }
    catch (err: any) { setError(err?.message || 'Gagal memulihkan satuan.'); }
  };

  const openUnitHistory = async (unit: UnitOption) => {
    setUnitHistoryTarget(unit); setUnitHistory([]); setUnitHistoryLoading(true); setError('');
    try { setUnitHistory(await api.unitHistory(unit.code) as UnitRevision[]); } catch (err: any) { setError(err?.message || 'Gagal memuat histori satuan.'); } finally { setUnitHistoryLoading(false); }
  };

  return (
    <section className="section-card catalog-manager" aria-labelledby="catalog-title">
      <div className="section-heading catalog-heading"><div><p className="eyebrow">KATALOG & CHECKLIST</p><h2 id="catalog-title">Varian {area === 'BAR' ? 'Bar' : 'Kitchen'}</h2><p className="catalog-area-note">Area {area === 'BAR' ? 'Bar' : 'Kitchen'} · kelompok hanya mengatur urutan checklist.</p></div>{!fixedArea && <div className="catalog-area-switch" role="group" aria-label="Pilih area katalog">{(['BAR', 'KITCHEN'] as Area[]).map((candidate) => <button key={candidate} type="button" className={`segmented-btn ${area === candidate ? 'active' : ''}`} aria-pressed={area === candidate} onClick={() => switchArea(candidate)}>{candidate === 'BAR' ? 'Bar' : 'Kitchen'}</button>)}</div>}</div>
      <p className="muted catalog-help">{layoutPending && layoutPendingVersion !== null ? 'Perubahan katalog sedang dijadwalkan untuk cycle berikutnya.' : 'Perubahan katalog diterapkan pada cycle berikutnya bila ada cycle yang sedang berjalan.'} Histori stok tidak diubah.</p>
      {!canMutate && <p role="status" className="muted catalog-help">{lockedMessage || 'Katalog dapat dilihat, tetapi perubahan varian dikunci.'}</p>}
      {loading && <p role="status" className="catalog-state">Memuat katalog...</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p role="status" className="catalog-notice">{notice}</p>}

      {canMutate && <div className="catalog-form-block"><div className="catalog-field-grid"><label className="catalog-field">Nama varian<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Contoh: Sirup gula" /></label><label className="catalog-field">Satuan<select value={newUnit} onChange={(event) => setNewUnit(event.target.value)}>{units.filter((unit) => unit.active).map((unit) => <option key={unit.code} value={unit.code}>{unit.label}</option>)}</select></label><label className="catalog-field">Batas stok minimum<input type="number" min="0" step="any" value={newThreshold} onChange={(event) => setNewThreshold(event.target.value)} /></label><label className="catalog-field">Kelompok checklist<select value={newSectionId} onChange={(event) => setNewSectionId(event.target.value)}><option value="">Belum ditempatkan ke kelompok</option>{sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label></div><p className="catalog-field-help">Kode varian dibuat otomatis oleh server setelah disimpan.</p><button type="button" className="primary-button" onClick={() => void createItem()} disabled={!newName.trim() || !newUnit}>Tambah varian</button></div>}

      <div className="catalog-group-toolbar"><div><strong>Kelompok checklist</strong><p className="catalog-field-help">Area {area === 'BAR' ? 'Bar' : 'Kitchen'} sudah benar. Kelompok hanya membantu urutan kerja.</p></div><div className="catalog-toolbar-actions">{canManageUnits && <button type="button" className="outline-button" onClick={() => { setUnitManagerOpen(true); void refreshUnits(); }}>Kelola satuan</button>}<button type="button" className="outline-button" onClick={() => setLayoutMode((current) => !current)}>{layoutMode ? 'Selesai mengatur' : 'Atur kelompok'}</button>{canMutate && <label className="catalog-check"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Tampilkan arsip</label>}</div></div>
      {layoutMode && canMutate && <div className="catalog-section-create"><label className="catalog-field">Tambah kelompok<input value={newSection} onChange={(event) => setNewSection(event.target.value)} placeholder="Contoh: Rak atas" /></label><button type="button" className="outline-button" onClick={() => void createSection()} disabled={!newSection.trim() || pendingLayoutChange}>Tambah kelompok</button></div>}

      {loadedArea === area && grouped.size === 0 && !loading && <p className="muted catalog-empty">{showArchived ? 'Belum ada varian pada area ini.' : 'Belum ada varian aktif pada area ini.'}</p>}
      {loadedArea === area && [...grouped.entries()].map(([sectionName, sectionItems]) => <div key={sectionName} className="catalog-section-list"><h3>{sectionName} <small className="muted">({sectionItems.length} varian)</small></h3><ul className="catalog-item-list">{sectionItems.map((item, index) => { const placement = placementByItem.get(item.id); return <li key={item.id} className={`catalog-item-row ${item.active ? '' : 'is-archived'}`}><div className="catalog-item-main"><div className="catalog-item-copy"><strong>{item.name}</strong><span className="catalog-item-meta"><b>{item.display_code || 'Kode dibuat server'}</b> · {item.unit_code} · batas {item.low_threshold}{!item.active && <em> · Diarsipkan</em>}</span></div><div className="catalog-item-actions">{canMutate && item.active && !layoutMode && <><button type="button" className="outline-button" onClick={() => { setEditTarget(item); setEditName(item.name); setEditUnit(item.unit_code); setEditThreshold(String(item.low_threshold)); }}>Ubah</button><button type="button" className="outline-button" onClick={() => setArchiveTarget(item.id)}>Arsipkan</button></>}{canManageUnits && item.active && !layoutMode && <button type="button" className="text-button" onClick={() => void openHistory(item)}>Histori</button>}{canManageUnits && !item.active && <button type="button" className="outline-button" onClick={() => setRestoreTarget(item.id)}>Pulihkan</button>}</div></div>{canMutate && layoutMode && item.active && placement && <div className="catalog-layout-controls">{placement.section_id && <><button type="button" className="outline-button" aria-label={`Pindahkan ${item.name} ke atas`} disabled={index === 0 || pendingLayoutChange} onClick={() => void moveItem(item.id, placement.section_id as string, Math.max(0, (placement.position ?? 0) - 1))}>Naik</button><button type="button" className="outline-button" aria-label={`Pindahkan ${item.name} ke bawah`} disabled={index === sectionItems.length - 1 || pendingLayoutChange} onClick={() => void moveItem(item.id, placement.section_id as string, (placement.position ?? 0) + 1)}>Turun</button></>}<label className="catalog-inline-select"><span className="sr-only">Pindahkan {item.name} ke bagian</span><select value={placement.section_id ?? ''} disabled={pendingLayoutChange} onChange={(event) => event.target.value && void moveItem(item.id, event.target.value, 0)}><option value="">Belum ditempatkan ke kelompok</option>{sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label></div>}{archiveTarget === item.id && <div className="catalog-inline-form"><label className="catalog-field">Alasan arsip<input value={archiveReason} onChange={(event) => setArchiveReason(event.target.value)} placeholder="Contoh: item sudah tidak dipakai" /></label><button type="button" className="primary-button" onClick={() => void archiveItem()} disabled={!archiveReason.trim()}>Arsipkan</button><button type="button" className="outline-button" onClick={() => { setArchiveTarget(null); setArchiveReason(''); }}>Batal</button></div>}{restoreTarget === item.id && <div className="catalog-inline-form"><label className="catalog-field">Alasan pemulihan<input value={restoreReason} onChange={(event) => setRestoreReason(event.target.value)} placeholder="Contoh: kembali dipakai" /></label><button type="button" className="primary-button" onClick={() => void restoreItem()} disabled={!restoreReason.trim()}>Pulihkan</button><button type="button" className="outline-button" onClick={() => { setRestoreTarget(null); setRestoreReason(''); }}>Batal</button></div>}</li>; })}</ul></div>)}

      {editTarget && <div role="dialog" aria-modal="true" aria-labelledby="edit-variant-title" className="catalog-dialog"><div className="catalog-dialog-head"><div><p className="eyebrow">EDIT VARIAN</p><h3 id="edit-variant-title">{editTarget.name}</h3></div><button type="button" className="close-button" aria-label="Tutup edit varian" onClick={() => setEditTarget(null)}>×</button></div><p className="catalog-readonly"><span>Kode tampilan</span><strong>{editTarget.display_code || 'Dibuat server saat item aktif'}</strong></p><div className="catalog-field-grid"><label className="catalog-field">Nama varian<input value={editName} onChange={(event) => setEditName(event.target.value)} /></label><label className="catalog-field">Satuan<select value={editUnit} onChange={(event) => setEditUnit(event.target.value)}>{units.filter((unit) => unit.active).map((unit) => <option key={unit.code} value={unit.code}>{unit.label}</option>)}</select></label><label className="catalog-field">Batas stok minimum<input type="number" min="0" step="any" value={editThreshold} onChange={(event) => setEditThreshold(event.target.value)} /></label></div><p className="catalog-field-help">Perubahan berlaku pada cycle berikutnya. Histori stok sebelumnya tetap memakai snapshot lama.</p><div className="catalog-dialog-actions"><button type="button" className="primary-button" onClick={() => void saveEdit()}>Simpan perubahan</button><button type="button" className="outline-button" onClick={() => setEditTarget(null)}>Batal</button></div></div>}
      {historyTarget && <div role="dialog" aria-modal="true" aria-labelledby="item-history-title" className="catalog-dialog"><div className="catalog-dialog-head"><div><p className="eyebrow">HISTORI MASTER</p><h3 id="item-history-title">{historyTarget.name}</h3><p className="catalog-field-help">{historyTarget.display_code || 'Kode dibuat server'} · histori tidak dapat diubah.</p></div><button type="button" className="close-button" aria-label="Tutup histori varian" onClick={() => setHistoryTarget(null)}>×</button></div>{historyLoading ? <p role="status">Memuat histori...</p> : history.length === 0 ? <p className="catalog-empty">Belum ada catatan perubahan.</p> : <ol className="catalog-history-list">{history.map((revision) => <li key={revision.id}><div><strong>{actionLabel(revision.action)}</strong><small>{formatDateTime(revision.effective_at)}</small></div>{revisionChanges(revision).length > 0 && <ul className="catalog-history-changes">{revisionChanges(revision).map((change) => <li key={change.label}><span>{change.label}</span><strong>{change.value}</strong></li>)}</ul>}{revision.reason && <p>{revision.reason}</p>}{revision.changed_by && <small>Pengubah: {revision.changed_by}</small>}</li>)}</ol>}</div>}
      {unitManagerOpen && canManageUnits && <div role="dialog" aria-modal="true" aria-labelledby="unit-manager-title" className="catalog-dialog"><div className="catalog-dialog-head"><div><p className="eyebrow">MASTER SATUAN</p><h3 id="unit-manager-title">Kelola satuan</h3></div><button type="button" className="close-button" aria-label="Tutup kelola satuan" onClick={() => setUnitManagerOpen(false)}>×</button></div><p className="catalog-field-help">Satuan yang masih dipakai item aktif tidak dapat diarsipkan. Histori perubahan disimpan otomatis.</p><div className="catalog-field-grid unit-create-grid"><label className="catalog-field">Kode satuan<input value={newUnitCode} onChange={(event) => setNewUnitCode(event.target.value)} placeholder="Contoh: botol" /></label><label className="catalog-field">Nama tampilan<input value={newUnitLabel} onChange={(event) => setNewUnitLabel(event.target.value)} placeholder="Contoh: botol" /></label><label className="catalog-field">Skala desimal<select value={newUnitScale} onChange={(event) => setNewUnitScale(event.target.value)}><option value="0">0 · bilangan utuh</option><option value="1">1 angka desimal</option><option value="2">2 angka desimal</option><option value="3">3 angka desimal</option><option value="4">4 angka desimal</option></select></label></div><button type="button" className="primary-button" onClick={() => void createUnit()} disabled={!newUnitCode.trim() || !newUnitLabel.trim()}>Tambah satuan</button><label className="catalog-check unit-archive-toggle"><input type="checkbox" checked={unitShowArchived} onChange={(event) => { const includeArchived = event.target.checked; setUnitShowArchived(includeArchived); void (typeof api.listUnitOptions === 'function' ? api.listUnitOptions(includeArchived).then((list) => setUnits(list as UnitOption[])).catch((err: any) => setError(err?.message || 'Gagal memuat satuan.')) : Promise.resolve()); }} /> Tampilkan satuan arsip</label><ul className="unit-list">{units.map((unit) => <li key={unit.code} className={unit.active ? '' : 'is-archived'}><div><strong>{unit.label}</strong><span>{unit.code} · {unit.decimal_scale} desimal{!unit.active && ' · Diarsipkan'}</span></div><div className="catalog-item-actions">{unit.active ? <><button type="button" className="outline-button" onClick={() => setUnitArchiveTarget(unit.code)}>Arsipkan</button>{unitArchiveTarget === unit.code && <div className="catalog-inline-form"><label className="catalog-field">Alasan arsip<input value={unitArchiveReason} onChange={(event) => setUnitArchiveReason(event.target.value)} placeholder="Contoh: tidak dipakai" /></label><button type="button" className="primary-button" onClick={() => void archiveUnit()} disabled={!unitArchiveReason.trim()}>Simpan</button><button type="button" className="outline-button" onClick={() => { setUnitArchiveTarget(null); setUnitArchiveReason(''); }}>Batal</button></div>}</> : <button type="button" className="outline-button" onClick={() => void restoreUnit(unit.code)}>Pulihkan</button>}<button type="button" className="text-button" onClick={() => void openUnitHistory(unit)}>Histori</button></div></li>)}</ul></div>}
      {unitHistoryTarget && <div role="dialog" aria-modal="true" aria-labelledby="unit-history-title" className="catalog-dialog"><div className="catalog-dialog-head"><div><p className="eyebrow">HISTORI SATUAN</p><h3 id="unit-history-title">{unitHistoryTarget.label}</h3><p className="catalog-field-help">{unitHistoryTarget.code} · histori tidak dapat diubah.</p></div><button type="button" className="close-button" aria-label="Tutup histori satuan" onClick={() => setUnitHistoryTarget(null)}>×</button></div>{unitHistoryLoading ? <p role="status">Memuat histori...</p> : unitHistory.length === 0 ? <p className="catalog-empty">Belum ada catatan perubahan.</p> : <ol className="catalog-history-list">{unitHistory.map((revision) => <li key={revision.id}><div><strong>{actionLabel(revision.action)}</strong><small>{formatDateTime(revision.effective_at)}</small></div>{unitRevisionChanges(revision).length > 0 && <ul className="catalog-history-changes">{unitRevisionChanges(revision).map((change) => <li key={change.label}><span>{change.label}</span><strong>{change.value}</strong></li>)}</ul>}{revision.reason && <p>{revision.reason}</p>}{revision.changed_by && <small>Pengubah: {revision.changed_by}</small>}</li>)}</ol>}</div>}
    </section>
  );
}
