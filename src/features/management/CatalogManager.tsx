import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

type Area = 'BAR' | 'KITCHEN';

type Section = { id: string; name: string; position: number; active: boolean };
type Placement = { item_id: string; section_id: string; position: number };

const DEFAULT_SECTION = 'Belum dikelompokkan';

export function CatalogManager() {
  const [area, setArea] = useState<Area>('BAR');
  const [items, setItems] = useState<any[]>([]);
  const [layoutVersion, setLayoutVersion] = useState(1);
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

  const placementByItem = new Map(placements.map((p) => [p.item_id, p]));
  const sectionById = new Map(sections.map((s) => [s.id, s]));

  const load = async (targetArea: Area = area) => {
    setLoading(true);
    setError('');
    try {
      const [itemList, layout] = await Promise.all([api.listItems(), api.getChecklistLayout(targetArea)]);
      setItems(itemList.filter((it: any) => it.area_code === targetArea));
      setLayoutVersion(layout.version);
      setSections(layout.sections);
      setPlacements(layout.placements);
    } catch (err: any) {
      setError(err?.message || 'Gagal memuat katalog.');
    } finally {
      setLoading(false);
    }
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
    return (pa?.position ?? 999) - (pb?.position ?? 999) || a.name.localeCompare(b.name);
  });

  const grouped = new Map<string, typeof orderedItems>();
  for (const it of orderedItems) {
    const p = placementByItem.get(it.id);
    const key = (p && sectionById.get(p.section_id)?.name) || DEFAULT_SECTION;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(it);
  }

  const handleCreate = async () => {
    setError('');
    setNotice('');
    try {
      await api.createItem({
        id: newId.trim().toLowerCase().replace(/\s+/g, '_'),
        area_code: area,
        name: newName.trim(),
        unit_code: newUnit.trim() || 'pcs',
        decimal_scale: 2,
        low_threshold: 0,
      });
      setNotice(`Barang ${newName.trim()} ditambahkan. Berlaku mulai cycle berikutnya bila cycle aktif berjalan.`);
      setNewId('');
      setNewName('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Gagal menambah barang.');
    }
  };

  const handleArchive = async () => {
    if (!archiveTarget) return;
    setError('');
    setNotice('');
    try {
      await api.archiveItem(archiveTarget, archiveReason.trim());
      setNotice('Barang diarsipkan dari daftar berikutnya. Histori dan laporan lama tetap utuh.');
      setArchiveTarget(null);
      setArchiveReason('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Gagal mengarsipkan barang.');
    }
  };

  const handleMove = async (itemId: string, sectionId: string, position: number) => {
    setError('');
    setNotice('');
    try {
      const res = await api.moveChecklistItem(area, itemId, sectionId, position, layoutVersion, crypto.randomUUID());
      setLayoutVersion(res.layout_version);
      setNotice('Susunan checklist tersimpan di server.');
      await load();
    } catch (err: any) {
      if (/VERSION_CONFLICT/.test(err?.message ?? '')) {
        setError('Susunan berubah oleh pengguna lain. Memuat versi terbaru...');
        await load();
        return;
      }
      setError(err?.message || 'Gagal memindahkan barang.');
    }
  };

  const handleNewSection = async () => {
    if (!newSection.trim()) return;
    setError('');
    try {
      await api.upsertChecklistSection(area, newSection.trim(), null, crypto.randomUUID());
      setNewSection('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Gagal menambah bagian.');
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
              onClick={() => setArea(a)}
            >
              {a === 'BAR' ? 'Bar' : 'Kitchen'}
            </button>
          ))}
        </div>
      </div>

      <p className="muted" style={{ fontSize: '12px' }}>
        Perubahan katalog berlaku mulai cycle berikutnya. Versi susunan server: <strong>{layoutVersion}</strong>.
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
        <button type="button" className="outline-button" onClick={() => void handleNewSection()} disabled={!newSection.trim()}>
          Tambah bagian
        </button>
      </div>

      {[...grouped.entries()].map(([sectionName, sectionItems]) => (
        <div key={sectionName} style={{ marginTop: '16px' }}>
          <h3 style={{ fontSize: '14px' }}>{sectionName} <small className="muted">({sectionItems.length} barang)</small></h3>
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '6px' }}>
            {sectionItems.map((it, idx) => {
              const p = placementByItem.get(it.id);
              return (
                <li key={it.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: '1px solid #e0ece6', borderRadius: '8px' }}>
                  <span style={{ flex: 1 }}><strong>{it.name}</strong> <small className="muted">{it.id} · {it.unit_code}</small></span>
                  <button type="button" className="outline-button" aria-label={`Pindahkan ${it.name} ke atas`} disabled={idx === 0} onClick={() => p && void handleMove(it.id, p.section_id, Math.max(0, p.position - 1))} style={{ padding: '4px 8px' }}>↑</button>
                  <button type="button" className="outline-button" aria-label={`Pindahkan ${it.name} ke bawah`} disabled={idx === sectionItems.length - 1} onClick={() => p && void handleMove(it.id, p.section_id, p.position + 1)} style={{ padding: '4px 8px' }}>↓</button>
                  <select
                    aria-label={`Pindahkan ${it.name} ke bagian`}
                    value={p?.section_id ?? ''}
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
