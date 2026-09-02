import { useState, useMemo, useEffect } from 'react';
import type { Area, ShiftType, Item, DutyRole } from '../../domain/types';
import { fmtNumber, areaLabel, shiftLabel, statusOfStock, movementCategoryLabel } from '../../domain/rules';
import { api } from '../../lib/api';
import { idbQueue } from '../../lib/idb-queue';

type Tab = 'overview' | 'opening' | 'movement' | 'closing';

type Props = {
  cycleId: string;
  area: Area;
  shift: ShiftType;
  dutyRole: DutyRole;
  items: Item[];
  cycleData: any;
  onRefresh: () => Promise<void>;
  onCheckOutRequest: () => void;
  onGoReports: () => void;
};

export function StockWorkspace({
  cycleId,
  area,
  shift,
  dutyRole,
  items,
  cycleData,
  onRefresh,
  onCheckOutRequest,
  onGoReports,
}: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [movementModalOpen, setMovementModalOpen] = useState(false);
  const [mvType, setMvType] = useState<'Masuk' | 'Keluar'>('Masuk');
  const [mvItem, setMvItem] = useState(items[0]?.id || '');
  const [mvQty, setMvQty] = useState('');
  const [mvCat, setMvCat] = useState('PURCHASE');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [queuedCount, setQueuedCount] = useState(0);

  // Opening state
  const openingRecord = cycleData?.opening;
  const isOpeningConfirmed = openingRecord?.status === 'CONFIRMED';
  const [openingCounts, setOpeningCounts] = useState<Record<string, string>>({});
  const [openingReasons, setOpeningReasons] = useState<Record<string, string>>({});
  const [openingNotes, setOpeningNotes] = useState<Record<string, string>>({});

  // Closing state
  const closingRecord = cycleData?.closing;
  const isClosingConfirmed = closingRecord?.status === 'CONFIRMED';
  const [closingCounts, setClosingCounts] = useState<Record<string, string>>({});
  const [closingReasons, setClosingReasons] = useState<Record<string, string>>({});
  const [closingNotes, setClosingNotes] = useState<Record<string, string>>({});

  const isPrimary = dutyRole === 'PRIMARY';
  const isNightOrFull = shift === 'MALAM' || shift === 'FULL';

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // Sync offline queue when online
  const syncQueue = async () => {
    if (!navigator.onLine) return;
    try {
      const queue = await idbQueue.getAll();
      setQueuedCount(queue.length);
      for (const item of queue) {
        if (item.action === 'CREATE_MOVEMENT') {
          await api.createMovement(item.payload);
          await idbQueue.remove(item.id);
        }
      }
      const remaining = await idbQueue.getAll();
      setQueuedCount(remaining.length);
      if (queue.length > 0 && remaining.length === 0) {
        showToast('Semua catatan offline berhasil disinkronkan ke server.');
        await onRefresh();
      }
    } catch (e) {
      console.error('Queue sync error', e);
    }
  };

  useEffect(() => {
    void syncQueue();
    const interval = setInterval(syncQueue, 15000);
    window.addEventListener('online', syncQueue);
    return () => {
      clearInterval(interval);
      window.removeEventListener('online', syncQueue);
    };
  }, []);

  const movements = cycleData?.movements ?? [];

  // Calculate balances per item
  const itemBalances = useMemo(() => {
    const map: Record<string, { opening: number; incoming: number; outgoing: number; system: number }> = {};
    for (const it of items) {
      const opLine = openingRecord?.stock_opening_lines?.find((l: any) => l.item_id === it.id);
      const opVal = opLine?.counted_qty != null ? Number(opLine.counted_qty) : (Number(opLine?.reference_qty) || 0);

      const itMovements = movements.filter((m: any) => m.item_id === it.id);
      const inc = itMovements.filter((m: any) => m.direction === 'IN').reduce((acc: number, m: any) => acc + Number(m.quantity), 0);
      const out = itMovements.filter((m: any) => m.direction === 'OUT').reduce((acc: number, m: any) => acc + Number(m.quantity), 0);

      map[it.id] = {
        opening: opVal,
        incoming: inc,
        outgoing: out,
        system: opVal + inc - out,
      };
    }
    return map;
  }, [items, openingRecord, movements]);

  const handleConfirmOpening = async () => {
    if (!isPrimary) {
      showToast('Hanya Penanggung Jawab Utama yang dapat mengonfirmasi stok awal.');
      return;
    }

    setLoading(true);
    try {
      const lines = items.map((it) => {
        const val = openingCounts[it.id] !== undefined ? Number(openingCounts[it.id]) : itemBalances[it.id]?.opening || 0;
        return {
          item_id: it.id,
          reference_qty: itemBalances[it.id]?.opening || 0,
          counted_qty: val,
          reason_code: openingReasons[it.id] || null,
          notes: openingNotes[it.id] || null,
        };
      });

      await api.confirmOpening(cycleId, lines);
      showToast('Stok awal berhasil dikonfirmasi.');
      await onRefresh();
      setTab('movement');
    } catch (err: any) {
      showToast(err.message || 'Gagal konfirmasi stok awal');
    } finally {
      setLoading(false);
    }
  };

  const handleAddMovement = async () => {
    const qty = Number(mvQty);
    if (!mvItem || !qty || qty <= 0) {
      showToast('Isi jumlah barang yang valid.');
      return;
    }

    const payload = {
      cycle_id: cycleId,
      item_id: mvItem,
      direction: mvType === 'Masuk' ? 'IN' : 'OUT',
      category: mvCat,
      quantity: qty,
      idempotency_key: crypto.randomUUID(),
    };

    setLoading(true);
    try {
      if (navigator.onLine) {
        await api.createMovement(payload);
        showToast('Perubahan stok berhasil dicatat ke server.');
        await onRefresh();
      } else {
        await idbQueue.add('CREATE_MOVEMENT', payload);
        const q = await idbQueue.getAll();
        setQueuedCount(q.length);
        showToast('Offline: Perubahan disimpan di antrean perangkat.');
      }
      setMvQty('');
      setMovementModalOpen(false);
    } catch (err: any) {
      // If network failure, queue it
      await idbQueue.add('CREATE_MOVEMENT', payload);
      const q = await idbQueue.getAll();
      setQueuedCount(q.length);
      showToast('Koneksi terganggu. Catatan disimpan di antrean offline.');
      setMvQty('');
      setMovementModalOpen(false);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmClosing = async () => {
    if (!isPrimary) {
      showToast('Hanya Penanggung Jawab Utama yang dapat mengonfirmasi closing.');
      return;
    }

    if (queuedCount > 0) {
      showToast(`Terdapat ${queuedCount} transaksi offline yang belum tersinkronisasi.`);
      return;
    }

    setLoading(true);
    try {
      const lines = items.map((it) => {
        const bal = itemBalances[it.id];
        const val = closingCounts[it.id] !== undefined ? Number(closingCounts[it.id]) : bal.system;
        return {
          item_id: it.id,
          opening_qty: bal.opening,
          incoming_qty: bal.incoming,
          outgoing_qty: bal.outgoing,
          system_qty: bal.system,
          counted_qty: val,
          reason_code: closingReasons[it.id] || null,
          notes: closingNotes[it.id] || null,
        };
      });

      await api.confirmClosing(cycleId, lines);
      showToast('Closing shift berhasil dikonfirmasi.');
      await onRefresh();
      onGoReports();
    } catch (err: any) {
      showToast(err.message || 'Gagal konfirmasi closing');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="workspace">
      <section className="welcome">
        <div>
          <p className="eyebrow">{shiftLabel(shift)} · {areaLabel(area)} · {dutyRole === 'PRIMARY' ? 'Penanggung Jawab' : 'Bantuan'}</p>
          <h1>Workspace {areaLabel(area)}</h1>
          <p className="muted">
            {isClosingConfirmed
              ? 'Closing shift telah dikonfirmasi.'
              : isOpeningConfirmed
              ? 'Catat perubahan stok masuk dan keluar secara real-time.'
              : 'Konfirmasi stok awal sebelum mencatat transaksi.'}
          </p>
          {queuedCount > 0 && (
            <p style={{ color: '#d97706', fontSize: '12px', fontWeight: 600, marginTop: '4px' }}>
              ⚡ {queuedCount} transaksi offline dalam antrean sinkronisasi
            </p>
          )}
        </div>
        <div>
          <button className="outline-button" onClick={onCheckOutRequest} style={{ borderColor: '#d97706', color: '#b45309' }}>
            Selesai / Check-Out ➔
          </button>
        </div>
      </section>

      <nav className="tabs" aria-label="Navigasi operasi">
        <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Ringkasan</button>
        <button className={tab === 'opening' ? 'active' : ''} onClick={() => setTab('opening')}>Stok Awal</button>
        <button className={tab === 'movement' ? 'active' : ''} disabled={!isOpeningConfirmed} onClick={() => setTab('movement')}>Perubahan</button>
        {isNightOrFull && (
          <button className={tab === 'closing' ? 'active' : ''} disabled={!isOpeningConfirmed} onClick={() => setTab('closing')}>Stok Akhir</button>
        )}
      </nav>

      {/* 1. OVERVIEW TAB */}
      {tab === 'overview' && (
        <div style={{ display: 'grid', gap: '16px' }}>
          <div className="section-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">RINGKASAN ITEM</p>
                <h2>Status Bahan Baku</h2>
              </div>
            </div>
            <div className="table-responsive" style={{ marginTop: '12px' }}>
              <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #cddcd4', color: '#6b8378' }}>
                    <th style={{ padding: '8px' }}>Item</th>
                    <th style={{ padding: '8px' }}>Awal</th>
                    <th style={{ padding: '8px' }}>Masuk</th>
                    <th style={{ padding: '8px' }}>Keluar</th>
                    <th style={{ padding: '8px' }}>Sisa Sistem</th>
                    <th style={{ padding: '8px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => {
                    const b = itemBalances[it.id] || { opening: 0, incoming: 0, outgoing: 0, system: 0 };
                    const st = statusOfStock(b.system, it.low_threshold);
                    return (
                      <tr key={it.id} style={{ borderBottom: '1px solid #eef3f0' }}>
                        <td style={{ padding: '8px', fontWeight: 600 }}>{it.name}</td>
                        <td style={{ padding: '8px' }}>{fmtNumber(b.opening)} {it.unit_code}</td>
                        <td style={{ padding: '8px', color: '#1e5b48' }}>+{fmtNumber(b.incoming)}</td>
                        <td style={{ padding: '8px', color: '#b91c1c' }}>-{fmtNumber(b.outgoing)}</td>
                        <td style={{ padding: '8px', fontWeight: 700 }}>{fmtNumber(b.system)} {it.unit_code}</td>
                        <td style={{ padding: '8px' }}>
                          <span className={`tag ${st === 'Aman' ? 'good' : st === 'Habis' ? 'bad' : 'warn'}`}>{st}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 2. OPENING TAB */}
      {tab === 'opening' && (
        <div className="section-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">HITUNG FISIK STOK AWAL</p>
              <h2>{isOpeningConfirmed ? 'Stok Awal Terkunci' : 'Konfirmasi Stok Awal'}</h2>
            </div>
          </div>
          <div style={{ display: 'grid', gap: '12px', marginTop: '16px' }}>
            {items.map((it) => {
              const refVal = itemBalances[it.id]?.opening || 0;
              const val = openingCounts[it.id] !== undefined ? openingCounts[it.id] : refVal.toString();
              const hasDiff = Number(val) !== refVal;

              return (
                <div key={it.id} style={{ padding: '12px', background: '#f8faf9', borderRadius: '10px', border: '1px solid #e0ece6' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong>{it.name}</strong>
                      <small style={{ display: 'block', color: '#6b8378' }}>Patokan Sistem: {fmtNumber(refVal)} {it.unit_code}</small>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="number"
                        disabled={isOpeningConfirmed}
                        value={val}
                        onChange={(e) => setOpeningCounts({ ...openingCounts, [it.id]: e.target.value })}
                        style={{ width: '90px', padding: '6px', textAlign: 'right', borderRadius: '6px', border: '1px solid #cddcd4' }}
                      />
                      <span>{it.unit_code}</span>
                    </div>
                  </div>

                  {hasDiff && !isOpeningConfirmed && (
                    <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #cddcd4' }}>
                      <select
                        value={openingReasons[it.id] || ''}
                        onChange={(e) => setOpeningReasons({ ...openingReasons, [it.id]: e.target.value })}
                        style={{ width: '100%', padding: '6px', borderRadius: '6px', marginBottom: '6px' }}
                      >
                        <option value="">-- Pilih Alasan Selisih --</option>
                        <option value="COUNTING_ERROR">Salah Hitung Sebelumnya</option>
                        <option value="SPILLAGE_UNRECORDED">Tumpah / Rusak Belum Dicatat</option>
                        <option value="OTHER">Lainnya</option>
                      </select>
                      <input
                        type="text"
                        placeholder="Catatan rincian selisih..."
                        value={openingNotes[it.id] || ''}
                        onChange={(e) => setOpeningNotes({ ...openingNotes, [it.id]: e.target.value })}
                        style={{ width: '100%', padding: '6px', borderRadius: '6px', border: '1px solid #cddcd4' }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!isOpeningConfirmed && (
            <button
              className="primary-button"
              onClick={handleConfirmOpening}
              disabled={loading || !isPrimary}
              style={{ marginTop: '20px', width: '100%' }}
            >
              {loading ? 'Menyimpan...' : 'Konfirmasi Stok Awal →'}
            </button>
          )}
        </div>
      )}

      {/* 3. MOVEMENT TAB */}
      {tab === 'movement' && (
        <div className="section-card">
          <div className="section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <p className="eyebrow">CATATAN TRANSAKSI STOK</p>
              <h2>Ledger Perubahan</h2>
            </div>
            <button className="primary-button" onClick={() => setMovementModalOpen(true)}>
              + Catat Perubahan
            </button>
          </div>

          <div style={{ marginTop: '16px' }}>
            {movements.length === 0 ? (
              <p className="muted" style={{ textAlign: 'center', padding: '24px' }}>Belum ada catatan barang masuk / keluar pada shift ini.</p>
            ) : (
              <div style={{ display: 'grid', gap: '8px' }}>
                {movements.map((m: any) => {
                  const it = items.find((i) => i.id === m.item_id);
                  const isInc = m.direction === 'IN';
                  return (
                    <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: '#f8faf9', borderRadius: '8px', border: '1px solid #e0ece6' }}>
                      <div>
                        <strong>{it?.name || m.item_id}</strong>
                        <small style={{ display: 'block', color: '#6b8378' }}>
                          {movementCategoryLabel(m.category)} · {new Date(m.server_occurred_at).toLocaleTimeString('id-ID')} WIB
                        </small>
                      </div>
                      <div style={{ fontWeight: 700, fontSize: '15px', color: isInc ? '#1e5b48' : '#b91c1c' }}>
                        {isInc ? '+' : '-'}{fmtNumber(m.quantity)} {m.unit_code_snapshot}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4. CLOSING TAB */}
      {tab === 'closing' && isNightOrFull && (
        <div className="section-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">HITUNG FISIK AKHIR SHIFT</p>
              <h2>{isClosingConfirmed ? 'Closing Selesai Terkunci' : 'Closing Stok Akhir'}</h2>
            </div>
          </div>
          <div style={{ display: 'grid', gap: '12px', marginTop: '16px' }}>
            {items.map((it) => {
              const sysVal = itemBalances[it.id]?.system || 0;
              const val = closingCounts[it.id] !== undefined ? closingCounts[it.id] : sysVal.toString();
              const hasDiff = Number(val) !== sysVal;

              return (
                <div key={it.id} style={{ padding: '12px', background: '#f8faf9', borderRadius: '10px', border: '1px solid #e0ece6' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong>{it.name}</strong>
                      <small style={{ display: 'block', color: '#6b8378' }}>Sisa Catatan: {fmtNumber(sysVal)} {it.unit_code}</small>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="number"
                        disabled={isClosingConfirmed}
                        value={val}
                        onChange={(e) => setClosingCounts({ ...closingCounts, [it.id]: e.target.value })}
                        style={{ width: '90px', padding: '6px', textAlign: 'right', borderRadius: '6px', border: '1px solid #cddcd4' }}
                      />
                      <span>{it.unit_code}</span>
                    </div>
                  </div>

                  {hasDiff && !isClosingConfirmed && (
                    <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #cddcd4' }}>
                      <select
                        value={closingReasons[it.id] || ''}
                        onChange={(e) => setClosingReasons({ ...closingReasons, [it.id]: e.target.value })}
                        style={{ width: '100%', padding: '6px', borderRadius: '6px', marginBottom: '6px' }}
                      >
                        <option value="">-- Pilih Alasan Selisih Closing --</option>
                        <option value="OVER_PORTIONING">Takaran Porsi Lebih</option>
                        <option value="SPILLAGE_UNRECORDED">Tumpah Belum Dicatat</option>
                        <option value="WASTE_UNRECORDED">Waste / Basi</option>
                        <option value="OTHER">Lainnya</option>
                      </select>
                      <input
                        type="text"
                        placeholder="Catatan selisih closing..."
                        value={closingNotes[it.id] || ''}
                        onChange={(e) => setClosingNotes({ ...closingNotes, [it.id]: e.target.value })}
                        style={{ width: '100%', padding: '6px', borderRadius: '6px', border: '1px solid #cddcd4' }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!isClosingConfirmed && (
            <button
              className="primary-button"
              onClick={handleConfirmClosing}
              disabled={loading || !isPrimary}
              style={{ marginTop: '20px', width: '100%' }}
            >
              {loading ? 'Menyimpan...' : 'Konfirmasi Closing & Buat Laporan →'}
            </button>
          )}
        </div>
      )}

      {/* Movement Modal */}
      {movementModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" style={{ maxWidth: '420px' }}>
            <div className="modal-head">
              <h3>Catat Perubahan Stok</h3>
              <button className="close-button" onClick={() => setMovementModalOpen(false)}>×</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', margin: '12px 0' }}>
              <button
                type="button"
                className={`segmented-btn ${mvType === 'Masuk' ? 'active' : ''}`}
                onClick={() => { setMvType('Masuk'); setMvCat('PURCHASE'); }}
                style={{ padding: '8px', borderRadius: '6px', background: mvType === 'Masuk' ? '#1e5b48' : '#eee', color: mvType === 'Masuk' ? '#fff' : '#000' }}
              >
                ↑ Masuk
              </button>
              <button
                type="button"
                className={`segmented-btn ${mvType === 'Keluar' ? 'active' : ''}`}
                onClick={() => { setMvType('Keluar'); setMvCat('USAGE'); }}
                style={{ padding: '8px', borderRadius: '6px', background: mvType === 'Keluar' ? '#1e5b48' : '#eee', color: mvType === 'Keluar' ? '#fff' : '#000' }}
              >
                ↓ Keluar
              </button>
            </div>

            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>Item</label>
            <select
              value={mvItem}
              onChange={(e) => setMvItem(e.target.value)}
              style={{ width: '100%', padding: '8px', borderRadius: '6px', marginBottom: '12px' }}
            >
              {items.map((it) => (
                <option key={it.id} value={it.id}>{it.name} ({it.unit_code})</option>
              ))}
            </select>

            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>Jumlah</label>
            <input
              type="number"
              value={mvQty}
              onChange={(e) => setMvQty(e.target.value)}
              placeholder="0"
              style={{ width: '100%', padding: '8px', borderRadius: '6px', marginBottom: '12px', border: '1px solid #cddcd4' }}
            />

            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>Kategori</label>
            <select
              value={mvCat}
              onChange={(e) => setMvCat(e.target.value)}
              style={{ width: '100%', padding: '8px', borderRadius: '6px', marginBottom: '16px' }}
            >
              {mvType === 'Masuk' ? (
                <>
                  <option value="PURCHASE">Pembelian</option>
                  <option value="RETURN_IN">Retur Masuk</option>
                  <option value="TRANSFER_IN">Pindahan Masuk</option>
                </>
              ) : (
                <>
                  <option value="USAGE">Pemakaian Reguler</option>
                  <option value="INTERNAL">Pemakaian Internal</option>
                  <option value="WASTE">Waste / Rusak</option>
                </>
              )}
            </select>

            <div className="modal-actions">
              <button className="outline-button" onClick={() => setMovementModalOpen(false)}>Batal</button>
              <button className="primary-button" onClick={handleAddMovement} disabled={loading}>
                Simpan
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="live-region" role="status">{toast}</div>}
    </div>
  );
}
