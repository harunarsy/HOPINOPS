import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';

type Area = 'BAR' | 'KITCHEN';
type MutationScope = 'MANAGEMENT' | 'PRIMARY' | 'READ_ONLY';
type Section = { id: string; name: string; position: number; active: boolean };
type Placement = { item_id: string; section_id: string; position: number };
type CatalogItem = {
  id: string;
  name: string;
  unit_code: string;
  area_code: Area;
  decimal_scale: number;
  low_threshold: number;
  active: boolean;
};

type Props = {
  fixedArea?: Area;
  mutationScope?: MutationScope;
  lockedMessage?: string;
};

const DEFAULT_SECTION = 'Belum dikelompokkan';
const inputStyle = { width: '100%', padding: '8px', marginTop: '4px', boxSizing: 'border-box' as const };

export function CatalogManager({ fixedArea, mutationScope = 'MANAGEMENT', lockedMessage }: Props) {
  const [area, setArea] = useState<Area>(fixedArea ?? 'BAR');
  const [loadedArea, setLoadedArea] = useState<Area | null>(null);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [layoutVersion, setLayoutVersion] = useState(1);
  const [layoutPending, setLayoutPending] = useState(false);
  const [layoutPendingVersion, setLayoutPendingVersion] = useState<number | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newUnit, setNewUnit] = useState('pcs');
  const [newThreshold, setNewThreshold] = useState('0');
  const [newSection, setNewSection] = useState('');
  const [archiveReason, setArchiveReason] = useState('');
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<CatalogItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editUnit, setEditUnit] = useState('');
  const [editThreshold, setEditThreshold] = useState('0');
  const [layoutMode, setLayoutMode] = useState(false);
  const [pendingLayoutChange, setPendingLayoutChange] = useState(false);
  const loadRequestRef = useRef(0);
  const activeAreaRef = useRef<Area>(fixedArea ?? 'BAR');
  const canMutate = mutationScope !== 'READ_ONLY';
  const isPrimary = mutationScope === 'PRIMARY';

  useEffect(() => {
    if (!fixedArea || fixedArea === activeAreaRef.current) return;
    activeAreaRef.current = fixedArea;
    setArea(fixedArea);
  }, [fixedArea]);

  const load = async (targetArea: Area) => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const [itemList, layout] = await Promise.all([api.listItems(), api.getChecklistLayout(targetArea)]);
      if (loadRequestRef.current !== requestId || activeAreaRef.current !== targetArea) return;
      setItems(itemList.filter((item: CatalogItem) => item.area_code === targetArea));
      setLayoutVersion(layout.version);
      setLayoutPending(layout.pending === true);
      setLayoutPendingVersion(typeof layout.pending_version === 'number' ? layout.pending_version : null);
      setSections(layout.sections);
      setPlacements(layout.placements);
      setLoadedArea(targetArea);
    } catch (err: any) {
      if (loadRequestRef.current !== requestId || activeAreaRef.current !== targetArea) return;
      setError(err?.message || 'Gagal memuat katalog.');
    } finally {
      if (loadRequestRef.current === requestId && activeAreaRef.current === targetArea) setLoading(false);
    }
  };

  useEffect(() => { void load(area); }, [area]);

  const switchArea = (next: Area) => {
    if (fixedArea || next === activeAreaRef.current) return;
    activeAreaRef.current = next;
    loadRequestRef.current += 1;
    setArea(next);
    setLoadedArea(null);
    setItems([]);
    setSections([]);
    setPlacements([]);
    setArchiveTarget(null);
    setEditTarget(null);
    setNotice('');
    setLayoutMode(false);
  };

  const placementByItem = useMemo(() => new Map(placements.map((placement) => [placement.item_id, placement])), [placements]);
  const sectionById = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);
  const grouped = useMemo(() => {
    const ordered = [...items].sort((left, right) => {
      const leftPlacement = placementByItem.get(left.id);
      const rightPlacement = placementByItem.get(right.id);
      const leftSection = leftPlacement ? sectionById.get(leftPlacement.section_id)?.position ?? 999 : 999;
      const rightSection = rightPlacement ? sectionById.get(rightPlacement.section_id)?.position ?? 999 : 999;
      return leftSection - rightSection || (leftPlacement?.position ?? 999) - (rightPlacement?.position ?? 999);
    });
    return ordered.reduce((result, item) => {
      const placement = placementByItem.get(item.id);
      const name = (placement && sectionById.get(placement.section_id)?.name) || DEFAULT_SECTION;
      result.set(name, [...(result.get(name) ?? []), item]);
      return result;
    }, new Map<string, CatalogItem[]>());
  }, [items, placementByItem, sectionById]);

  const createItem = async () => {
    const operationArea = activeAreaRef.current;
    const threshold = Number(newThreshold);
    if (!Number.isFinite(threshold) || threshold < 0) {
      setError('Batas stok minimum harus berupa angka nol atau lebih.');
      return;
    }
    setError(''); setNotice('');
    const item = { id: newId.trim().toLowerCase().replace(/\s+/g, '_'), area_code: operationArea, name: newName.trim(), unit_code: newUnit.trim() || 'pcs', decimal_scale: 2, low_threshold: threshold };
    try {
      if (isPrimary) await api.operatorCreateItem(item);
      else await api.createItem(item);
      if (activeAreaRef.current !== operationArea) return;
      setNotice(`Varian ${newName.trim()} ditambahkan dan akan berlaku pada cycle berikutnya.`);
      setNewId(''); setNewName(''); setNewUnit('pcs'); setNewThreshold('0');
      await load(operationArea);
    } catch (err: any) { if (activeAreaRef.current === operationArea) setError(err?.message || 'Gagal menambah varian.'); }
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    const threshold = Number(editThreshold);
    if (!editName.trim() || !editUnit.trim() || !Number.isFinite(threshold) || threshold < 0) {
      setError('Nama, satuan, dan batas stok minimum wajib valid.');
      return;
    }
    const operationArea = activeAreaRef.current;
    setError(''); setNotice('');
    try {
      const payload = { id: editTarget.id, name: editName.trim(), unit_code: editUnit.trim(), decimal_scale: editTarget.decimal_scale ?? 2, low_threshold: threshold };
      if (isPrimary) await api.operatorUpdateItem(payload);
      else await api.updateItem(payload);
      if (activeAreaRef.current !== operationArea) return;
      setEditTarget(null);
      setNotice('Varian diperbarui untuk cycle berikutnya. Catatan stok dan histori sebelumnya tidak berubah.');
      await load(operationArea);
    } catch (err: any) { if (activeAreaRef.current === operationArea) setError(err?.message || 'Gagal memperbarui varian.'); }
  };

  const archiveItem = async () => {
    if (!archiveTarget || !archiveReason.trim()) return;
    const operationArea = activeAreaRef.current;
    setError(''); setNotice('');
    try {
      if (isPrimary) await api.operatorArchiveItem(archiveTarget, archiveReason.trim());
      else await api.archiveItem(archiveTarget, archiveReason.trim());
      if (activeAreaRef.current !== operationArea) return;
      setArchiveTarget(null); setArchiveReason('');
      setNotice('Varian diarsipkan untuk cycle berikutnya. Histori dan laporan lama tetap utuh.');
      await load(operationArea);
    } catch (err: any) { if (activeAreaRef.current === operationArea) setError(err?.message || 'Gagal mengarsipkan varian.'); }
  };

  const moveItem = async (itemId: string, sectionId: string, position: number) => {
    if (pendingLayoutChange) return;
    const operationArea = activeAreaRef.current;
    setPendingLayoutChange(true); setError(''); setNotice('');
    try {
      await api.moveChecklistItem(operationArea, itemId, sectionId, position, layoutVersion, crypto.randomUUID());
      if (activeAreaRef.current !== operationArea) return;
      setNotice('Susunan checklist disimpan untuk cycle berikutnya.');
      await load(operationArea);
    } catch (err: any) {
      if (activeAreaRef.current !== operationArea) return;
      if (/VERSION_CONFLICT/.test(err?.message ?? '')) { setError('Susunan berubah oleh pengguna lain. Memuat versi terbaru.'); await load(operationArea); }
      else setError(err?.message || 'Gagal memindahkan varian.');
    } finally { if (activeAreaRef.current === operationArea) setPendingLayoutChange(false); }
  };

  const createSection = async () => {
    if (!newSection.trim() || pendingLayoutChange) return;
    const operationArea = activeAreaRef.current;
    setPendingLayoutChange(true); setError('');
    try {
      await api.upsertChecklistSection(operationArea, newSection.trim(), null, crypto.randomUUID());
      if (activeAreaRef.current !== operationArea) return;
      setNewSection(''); setNotice('Bagian checklist ditambahkan untuk cycle berikutnya.'); await load(operationArea);
    } catch (err: any) { if (activeAreaRef.current === operationArea) setError(err?.message || 'Gagal menambah bagian.'); }
    finally { if (activeAreaRef.current === operationArea) setPendingLayoutChange(false); }
  };

  return (
    <section className="section-card" aria-labelledby="catalog-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">KATALOG & CHECKLIST</p>
          <h2 id="catalog-title">Varian {area === 'BAR' ? 'Bar' : 'Kitchen'}</h2>
        </div>
        {!fixedArea && <div style={{ display: 'flex', gap: '8px' }}>{(['BAR', 'KITCHEN'] as Area[]).map((candidate) => <button key={candidate} type="button" className={`segmented-btn ${area === candidate ? 'active' : ''}`} aria-pressed={area === candidate} onClick={() => switchArea(candidate)}>{candidate === 'BAR' ? 'Bar' : 'Kitchen'}</button>)}</div>}
      </div>

      <p className="muted" style={{ fontSize: '12px' }}>
        {layoutPending && layoutPendingVersion !== null ? 'Perubahan sedang dijadwalkan untuk cycle berikutnya.' : 'Perubahan katalog diterapkan pada cycle berikutnya bila ada cycle yang sedang berjalan.'} Histori stok tidak diubah.
      </p>
      {!canMutate && <p role="status" className="muted" style={{ fontSize: '12px', marginTop: '8px' }}>{lockedMessage || 'Katalog dapat dilihat, tetapi perubahan varian dikunci.'}</p>}
      {loading && <p role="status">Memuat katalog...</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p role="status" style={{ color: '#1e5b48' }}>{notice}</p>}

      {canMutate && <>
        <div className="catalog-fields" style={{ display: 'grid', gap: '8px', marginTop: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <label style={{ fontSize: '12px' }}>Kode varian<input value={newId} onChange={(event) => setNewId(event.target.value)} placeholder="sirup_gula" style={inputStyle} /></label>
          <label style={{ fontSize: '12px' }}>Nama varian<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Sirup gula" style={inputStyle} /></label>
          <label style={{ fontSize: '12px' }}>Satuan<input value={newUnit} onChange={(event) => setNewUnit(event.target.value)} placeholder="pcs" style={inputStyle} /></label>
          <label style={{ fontSize: '12px' }}>Batas stok minimum<input type="number" min="0" step="any" value={newThreshold} onChange={(event) => setNewThreshold(event.target.value)} style={inputStyle} /></label>
        </div>
        <button type="button" className="primary-button" onClick={() => void createItem()} disabled={!newId.trim() || !newName.trim()} style={{ marginTop: '8px' }}>Tambah varian</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '20px' }}>
          <strong>Susunan checklist</strong>
          <button type="button" className="outline-button" onClick={() => setLayoutMode((current) => !current)}>{layoutMode ? 'Selesai atur susunan' : 'Atur susunan'}</button>
        </div>
        {layoutMode && <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}><input value={newSection} onChange={(event) => setNewSection(event.target.value)} placeholder="Bagian baru, mis. Rak atas" aria-label="Nama bagian baru" style={{ ...inputStyle, marginTop: 0, flex: 1, minWidth: '180px' }} /><button type="button" className="outline-button" onClick={() => void createSection()} disabled={!newSection.trim() || pendingLayoutChange}>Tambah bagian</button></div>}
      </>}

      {loadedArea === area && grouped.size === 0 && !loading && <p className="muted" style={{ padding: '20px 0' }}>Belum ada varian aktif pada area ini.</p>}
      {loadedArea === area && [...grouped.entries()].map(([sectionName, sectionItems]) => (
        <div key={sectionName} style={{ marginTop: '16px' }}>
          <h3 style={{ fontSize: '14px' }}>{sectionName} <small className="muted">({sectionItems.length} varian)</small></h3>
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '8px' }}>{sectionItems.map((item, index) => {
            const placement = placementByItem.get(item.id);
            return <li key={item.id} style={{ padding: '10px', border: '1px solid #e0ece6', borderRadius: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                <span><strong>{item.name}</strong> <small className="muted">{item.unit_code} · batas {item.low_threshold}</small></span>
                {canMutate && !layoutMode && <span style={{ display: 'flex', gap: '6px' }}><button type="button" className="outline-button" onClick={() => { setEditTarget(item); setEditName(item.name); setEditUnit(item.unit_code); setEditThreshold(String(item.low_threshold)); }}>Ubah</button><button type="button" className="outline-button" onClick={() => setArchiveTarget(item.id)}>Arsip</button></span>}
              </div>
              {canMutate && layoutMode && placement && <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}><button type="button" className="outline-button" aria-label={`Pindahkan ${item.name} ke atas`} disabled={index === 0 || pendingLayoutChange} onClick={() => void moveItem(item.id, placement.section_id, Math.max(0, placement.position - 1))}>Naik</button><button type="button" className="outline-button" aria-label={`Pindahkan ${item.name} ke bawah`} disabled={index === sectionItems.length - 1 || pendingLayoutChange} onClick={() => void moveItem(item.id, placement.section_id, placement.position + 1)}>Turun</button><select aria-label={`Pindahkan ${item.name} ke bagian`} value={placement.section_id} disabled={pendingLayoutChange} onChange={(event) => event.target.value && void moveItem(item.id, event.target.value, 0)}>{sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</select></div>}
              {archiveTarget === item.id && <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' }}><input value={archiveReason} onChange={(event) => setArchiveReason(event.target.value)} placeholder="Alasan arsip" aria-label="Alasan arsip" style={{ ...inputStyle, marginTop: 0, flex: 1, minWidth: '180px' }} /><button type="button" className="primary-button" onClick={() => void archiveItem()} disabled={!archiveReason.trim()}>Arsipkan</button><button type="button" className="outline-button" onClick={() => { setArchiveTarget(null); setArchiveReason(''); }}>Batal</button></div>}
            </li>;
          })}</ul>
        </div>
      ))}

      {editTarget && <div role="dialog" aria-modal="true" aria-labelledby="edit-variant-title" style={{ marginTop: '16px', padding: '16px', border: '1px solid #cddcd4', borderRadius: '10px', background: '#f8faf9' }}><h3 id="edit-variant-title">Ubah {editTarget.name}</h3><div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}><label style={{ fontSize: '12px' }}>Nama<input value={editName} onChange={(event) => setEditName(event.target.value)} style={inputStyle} /></label><label style={{ fontSize: '12px' }}>Satuan<input value={editUnit} onChange={(event) => setEditUnit(event.target.value)} style={inputStyle} /></label><label style={{ fontSize: '12px' }}>Batas stok minimum<input type="number" min="0" step="any" value={editThreshold} onChange={(event) => setEditThreshold(event.target.value)} style={inputStyle} /></label></div><p className="muted" style={{ fontSize: '12px' }}>Perubahan satuan berlaku untuk cycle berikutnya. Histori stok sebelumnya tidak diubah.</p><div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}><button type="button" className="primary-button" onClick={() => void saveEdit()}>Simpan perubahan</button><button type="button" className="outline-button" onClick={() => setEditTarget(null)}>Batal</button></div></div>}
    </section>
  );
}
