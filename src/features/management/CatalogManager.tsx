import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

type Area = 'BAR' | 'KITCHEN';

type Section = { id: string; name: string; position: number; active: boolean };
type Placement = { item_id: string; section_id: string; position: number };

const DEFAULT_SECTION = 'Belum dikelompokkan';

export function CatalogManager() {
  const [area, setArea] = useState<Area>('BAR');
  const [loadedArea, setLoadedArea] = useState<Area | null>(null);
  const [items, setItems] = useState<any[]>([]);
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
  const [newSection, setNewSection] = useState('');
  const [archiveReason, setArchiveReason] = useState('');
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const activeAreaRef = useRef<Area>('BAR');
  const [pendingLayoutChange, setPendingLayoutChange] = useState(false);

  const placementByItem = new Map(placements.map((p) => [p.item_id, p]));
  const sectionById = new Map(sections.map((s) => [s.id, s]));

  const load = async (targetArea: Area) => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const [itemList, layout] = await Promise.all([api.listItems(), api.getChecklistLayout(targetArea)]);
      if (loadRequestRef.current !== requestId || activeAreaRef.current !== targetArea) return;
      setItems(itemList.filter((it: any) => it.area_code === targetArea));
      setLayoutVersion(layout.version);
      setLayoutPending((layout as any).pending === true);
      setLayoutPendingVersion(typeof (layout as any).pending_version === 'number' ? (layout as any).pending_version : null);
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

  const switchArea = (next: Area) => {
    if (next === activeAreaRef.current) return;
    activeAreaRef.current = next;
    loadRequestRef.current += 1;
    setArea(next);
    setLoadedArea(null);
    setItems([]);
    setSections([]);
    setPlacements([]);
    setArchiveTarget(null);
    setArchiveReason('');
    setNotice('');
    setPendingLayoutChange(false);
  };

  useEffect(() => {
    void load(area);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area]);

  const orderedItems = [...items].sort((a, b) => {
    const pa = placementByItem.get(a.id);
    const pb = placementByItem.get(b.id);
    const sa = pa ? sectionById.get(pa.section_id)?.position ?? 999 : 999;
    const sb = pb ? sectionById.get(pb.section_id)?.position ?? 999 : 999;
    if (sa !== sb) return sa - sb;
    return (pa?.position ?? 999) - (pb?.position ?? 999);
  });

  const grouped = new Map<string, typeof orderedItems>();
  for (const it of orderedItems) {
    const p = placementByItem.get(it.id);
    const key = (p && sectionById.get(p.section_id)?.name) || DEFAULT_SECTION;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(it);
  }

  const handleCreate = async () => {
    const operationArea = activeAreaRef.current;
    setError('');
    setNotice('');
    try {
      await api.createItem({
        id: newId.trim().toLowerCase().replace(/\s+/g, '_'),
        area_code: operationArea,
        name: newName.trim(),
        unit_code: newUnit.trim() || 'pcs',
        decimal_scale: 2,
        low_threshold: 0,
      });
      if (activeAreaRef.current !== operationArea) return;
      setNotice(`Barang ${newName.trim()} ditambahkan. Berlaku mulai cycle berikutnya bila cycle aktif berjalan.`);
      setNewId('');
      setNewName('');
      await load(operationArea);
    } catch (err: any) {
      if (activeAreaRef.current !== operationArea) return;
      setError(err?.message || 'Gagal menambah barang.');
    }
  };

  const handleArchive = async () => {
    if (!archiveTarget) return;
    const operationArea = activeAreaRef.current;
    if (!items.some((it: any) => it.id === archiveTarget)) {
      setError('Area berubah saat formulir arsip terbuka. Pilih ulang barang pada area aktif.');
      setArchiveTarget(null);
      setArchiveReason('');
      return;
    }
    setError('');
    setNotice('');
    try {
      await api.archiveItem(archiveTarget, archiveReason.trim());
      if (activeAreaRef.current !== operationArea) return;
      setNotice('Barang diarsipkan dari daftar berikutnya. Histori dan laporan lama tetap utuh.');
      setArchiveTarget(null);
      setArchiveReason('');
      await load(operationArea);
    } catch (err: any) {
      if (activeAreaRef.current !== operationArea) return;
      setError(err?.message || 'Gagal mengarsipkan barang.');
    }
  };

  const handleMove = async (itemId: string, sectionId: string, position: number) => {
    if (pendingLayoutChange) return;
    const operationArea = activeAreaRef.current;
    const operationVersion = layoutVersion;
    setError('');
    setNotice('');
    setPendingLayoutChange(true);
    try {
      const res = await api.moveChecklistItem(operationArea, itemId, sectionId, position, operationVersion, crypto.randomUUID());
      if (activeAreaRef.current !== operationArea) return;
      setLayoutVersion(res.layout_version);
      setNotice('Susunan checklist tersimpan di server.');
      await load(operationArea);
    } catch (err: any) {
      if (activeAreaRef.current !== operationArea) return;
      if (/VERSION_CONFLICT/.test(err?.message ?? '')) {
        setError('Susunan berubah oleh pengguna lain. Memuat versi terbaru...');
        await load(operationArea);
        return;
      }
      setError(err?.message || 'Gagal memindahkan barang.');
    } finally {
      if (activeAreaRef.current === operationArea) setPendingLayoutChange(false);
    }
  };

  const handleNewSection = async () => {
    if (!newSection.trim() || pendingLayoutChange) return;
    const operationArea = activeAreaRef.current;
    setError('');
    setPendingLayoutChange(true);
    try {
      await api.upsertChecklistSection(operationArea, newSection.trim(), null, crypto.randomUUID());
      if (activeAreaRef.current !== operationArea) return;
      setNewSection('');
      await load(operationArea);
    } catch (err: any) {
      if (activeAreaRef.current !== operationArea) return;
      setError(err?.message || 'Gagal menambah bagian.');
    } finally {
      if (activeAreaRef.current === operationArea) setPendingLayoutChange(false);
    }
  };

  return (
    <section className="section-card" aria-labelledby="catalog-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">KATALOG & CHECKLIST</p>
          <h2 id="catalog-title">Kelola Barang & Susunan</h2>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {(['BAR', 'KITCHEN'] as Area[]).map((a) => (
            <button
              key={a}
              type="button"
              className={`segmented-btn ${area === a ? 'active' : ''}`}
              aria-pressed={area === a}
              onClick={() => switchArea(a)}
            >
              {a === 'BAR' ? 'Bar' : 'Kitchen'}
            </button>
          ))}
        </div>
      </div>

      <p className="muted" style={{ fontSize: '12px' }}>
        {layoutPending && layoutPendingVersion !== null ? (
          <>Draft cycle berikutnya: <strong>versi {layoutPendingVersion}</strong>. Berlaku mulai cycle berikutnya; cycle aktif tetap memakai susunan lama.</>
        ) : (
          <>Susunan aktif server: <strong>versi {layoutVersion}</strong>.</>
        )}
        {pendingLayoutChange && <> Perubahan susunan sedang menunggu konfirmasi server.</>}
        <br /><strong>Perubahan berikutnya:</strong> barang baru, arsip, dan susunan ini berlaku mulai cycle berikutnya.
        Arsip tidak menghapus histori.
      </p>

      {loading && <p role="status">Memuat katalog...</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p role="status" style={{ color: '#1e5b48' }}>{notice}</p>}

      <div style={{ display: 'grid', gap: '8px', marginTop: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <label style={{ fontSize: '12px' }}>ID barang
          <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="sirup_gula" style={{ width: '100%', padding: '6px', marginTop: '4px' }} />
        </label>
        <label style={{ fontSize: '12px' }}>Nama
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Sirup Gula" style={{ width: '100%', padding: '6px', marginTop: '4px' }} />
        </label>
        <label style={{ fontSize: '12px' }}>Satuan
          <input value={newUnit} onChange={(e) => setNewUnit(e.target.value)} placeholder="pcs" style={{ width: '100%', padding: '6px', marginTop: '4px' }} />
        </label>
      </div>
      <button type="button" className="primary-button" onClick={() => void handleCreate()} disabled={!newId.trim() || !newName.trim()} style={{ marginTop: '8px' }}>
        Tambah barang
      </button>

      <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
        <input value={newSection} onChange={(e) => setNewSection(e.target.value)} placeholder="Bagian baru, mis. Rak atas" style={{ flex: 1, padding: '6px' }} aria-label="Nama bagian baru" />
        <button type="button" className="outline-button" onClick={() => void handleNewSection()} disabled={!newSection.trim() || pendingLayoutChange}>
          Tambah bagian
        </button>
      </div>

      {loadedArea !== area && (
        <p role="status" style={{ color: '#476058', fontSize: '12px', marginTop: '12px' }}>
          Memuat katalog {area === 'BAR' ? 'Bar' : 'Kitchen'}...
        </p>
      )}
      {loadedArea === area && [...grouped.entries()].map(([sectionName, sectionItems]) => (
        <div key={sectionName} style={{ marginTop: '16px' }}>
          <h3 style={{ fontSize: '14px' }}>{sectionName} <small className="muted">({sectionItems.length} barang)</small></h3>
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '6px' }}>
            {sectionItems.map((it, idx) => {
              const p = placementByItem.get(it.id);
              return (
                <li key={it.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: '1px solid #e0ece6', borderRadius: '8px' }}>
                  <span style={{ flex: 1 }}><strong>{it.name}</strong> <small className="muted">{it.id} · {it.unit_code}</small></span>
                  <button type="button" className="outline-button" aria-label={`Pindahkan ${it.name} ke atas`} disabled={idx === 0 || pendingLayoutChange} onClick={() => p && void handleMove(it.id, p.section_id, Math.max(0, p.position - 1))} style={{ padding: '4px 8px' }}>↑</button>
                  <button type="button" className="outline-button" aria-label={`Pindahkan ${it.name} ke bawah`} disabled={idx === sectionItems.length - 1 || pendingLayoutChange} onClick={() => p && void handleMove(it.id, p.section_id, p.position + 1)} style={{ padding: '4px 8px' }}>↓</button>
                  <select
                    aria-label={`Pindahkan ${it.name} ke bagian`}
                    value={p?.section_id ?? ''}
                    disabled={pendingLayoutChange}
                    onChange={(e) => e.target.value && void handleMove(it.id, e.target.value, 0)}
                    style={{ padding: '4px' }}
                  >
                    <option value="">Pindah bagian...</option>
                    {sections.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  {archiveTarget === it.id ? (
                    <span style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <input value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)} placeholder="Alasan arsip" style={{ padding: '4px', width: '140px' }} aria-label="Alasan arsip" />
                      <button type="button" className="primary-button" onClick={() => void handleArchive()} disabled={!archiveReason.trim()} style={{ padding: '4px 8px' }}>Arsipkan</button>
                      <button type="button" className="outline-button" onClick={() => { setArchiveTarget(null); setArchiveReason(''); }} style={{ padding: '4px 8px' }}>Batal</button>
                    </span>
                  ) : (
                    <button type="button" className="outline-button" onClick={() => setArchiveTarget(it.id)} style={{ padding: '4px 8px' }}>Arsip</button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
