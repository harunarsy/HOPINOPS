import { useState, useMemo, useEffect, useRef } from 'react';
import type { Area, ShiftType, Item, DutyRole } from '../../domain/types';
import { fmtNumber, areaLabel, shiftLabel, statusOfStock, movementCategoryLabel } from '../../domain/rules';
import { api } from '../../lib/api';
import { idbQueue, type QueueItem } from '../../lib/idb-queue';

type Tab = 'overview' | 'opening' | 'movement' | 'closing';

type Props = {
  profileId: string;
  outletId: string;
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
  profileId,
  outletId,
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
  const [queueStateLoaded, setQueueStateLoaded] = useState(false);
  const [queueSummary, setQueueSummary] = useState({ pending: 0, sending: 0, conflict: 0, failed: 0 });
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [handoverCompleted, setHandoverCompleted] = useState(false);
  const [closingCompleted, setClosingCompleted] = useState(false);
  const syncInFlightRef = useRef(false);
  const activeScopeRef = useRef('');
  const cycleVersionRef = useRef(0);
  const cycleVersionScopeRef = useRef('');

  // Opening state
  const openingRecord = cycleData?.opening;
  const isOpeningConfirmed = openingRecord?.status === 'CONFIRMED';
  const [openingCounts, setOpeningCounts] = useState<Record<string, string>>({});
  const [openingReasons, setOpeningReasons] = useState<Record<string, string>>({});
  const [openingNotes, setOpeningNotes] = useState<Record<string, string>>({});

  // Closing state
  const closingRecord = cycleData?.closing;
  const isClosingConfirmed = closingRecord?.status === 'CONFIRMED';
  const handoverRecord = cycleData?.handover;
  const isHandoverConfirmed = handoverRecord?.status === 'CONFIRMED';
  const [closingCounts, setClosingCounts] = useState<Record<string, string>>({});
  const [closingReasons, setClosingReasons] = useState<Record<string, string>>({});
  const [closingNotes, setClosingNotes] = useState<Record<string, string>>({});

  const isPrimary = dutyRole === 'PRIMARY';
  const isDayShift = shift === 'SIANG';
  const isNightOrFull = shift === 'MALAM' || shift === 'FULL';
  const isRequiredFinal = isDayShift
    ? isHandoverConfirmed || handoverCompleted
    : isNightOrFull
      ? isClosingConfirmed || closingCompleted
      : true;
  const isMovementFinal = isHandoverConfirmed || handoverCompleted || isClosingConfirmed || closingCompleted;
  const unresolvedCount = queueSummary.pending + queueSummary.sending + queueSummary.conflict + queueSummary.failed;
  const scopeSignature = `${profileId}:${outletId}:${cycleId}`;
  activeScopeRef.current = scopeSignature;
  const cycleVersion = Number(cycleData?.cycle?.version);
  if (cycleVersionScopeRef.current !== scopeSignature) {
    cycleVersionScopeRef.current = scopeSignature;
    cycleVersionRef.current = Number.isInteger(cycleVersion) && cycleVersion > 0 ? cycleVersion : 0;
  } else if (Number.isInteger(cycleVersion) && cycleVersion > cycleVersionRef.current) {
    cycleVersionRef.current = cycleVersion;
  }

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const queueScope = { profileId, outletId, aggregateId: cycleId };

  const loadQueueSummary = async () => {
    const queue = await idbQueue.getForAggregate(queueScope);
    if (activeScopeRef.current === scopeSignature) {
      setQueueItems(queue.filter((item) => item.state !== 'SYNCED'));
      setQueueSummary({
        pending: queue.filter((item) => item.state === 'PENDING').length,
        sending: queue.filter((item) => item.state === 'SENDING').length,
        conflict: queue.filter((item) => item.state === 'CONFLICT').length,
        failed: queue.filter((item) => item.state === 'FAILED').length,
      });
    }
    return queue;
  };

  // Replay is serialized and each row is claimed as SENDING in IndexedDB before the request.
  const syncQueue = async () => {
    if (!navigator.onLine || syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    let attemptedSync = false;
    try {
      await idbQueue.recoverSending(queueScope);
      const queue = await idbQueue.getForAggregate(queueScope);
      for (const item of queue) {
        if (item.state === 'SYNCED') continue;
        if (item.state !== 'PENDING' || (item.nextAttemptAt !== null && item.nextAttemptAt > Date.now())) {
          break;
        }

        const sendingItem = await idbQueue.markSending(queueScope, item.id);
        if (!sendingItem) break;
        attemptedSync = true;

        try {
          if (sendingItem.action !== 'CREATE_MOVEMENT') {
            await idbQueue.markFailed(queueScope, sendingItem.id, 'UNSUPPORTED_ACTION');
            break;
          }
          const expectedVersion = cycleVersionRef.current > 0
            ? cycleVersionRef.current
            : sendingItem.baseVersion;
          const result = await api.createMovement({
            ...(sendingItem.payload as Parameters<typeof api.createMovement>[0]),
            idempotency_key: sendingItem.idempotencyKey,
            expected_version: expectedVersion,
          });
          const nextVersion = Number((result as any)?.movement?.cycle_version);
          if (!Number.isInteger(nextVersion) || nextVersion < expectedVersion) {
            await idbQueue.markFailed(queueScope, sendingItem.id, 'INVALID_CYCLE_VERSION');
            break;
          }
          cycleVersionRef.current = nextVersion;
          await idbQueue.remove(queueScope, sendingItem.id);
        } catch (err: any) {
          const status = typeof err?.status === 'number' ? err.status : null;
          const errorCode = typeof err?.code === 'string'
            ? err.code
            : err instanceof TypeError || !navigator.onLine
              ? 'NETWORK_ERROR'
              : status !== null
                ? `HTTP_${status}`
                : 'UNKNOWN_ERROR';

          if (status === 409 || errorCode === 'VERSION_CONFLICT' || errorCode === 'STATE_CONFLICT' || errorCode === 'IDEMPOTENCY_CONFLICT') {
            await idbQueue.markConflict(queueScope, sendingItem.id, errorCode);
          } else if (status === 429 || (status !== null && status >= 500) || errorCode === 'NETWORK_ERROR') {
            const baseDelay = Math.min(300_000, 1_000 * (2 ** Math.min(sendingItem.attemptCount - 1, 8)));
            const jitter = Math.floor(Math.random() * Math.max(1, baseDelay * 0.25));
            await idbQueue.markPending(queueScope, sendingItem.id, errorCode, Date.now() + baseDelay + jitter);
          } else {
            await idbQueue.markFailed(queueScope, sendingItem.id, errorCode);
          }
          break;
        }
      }

      const remaining = await loadQueueSummary();
      const unresolved = remaining.filter((item) => item.state !== 'SYNCED');
      if (attemptedSync && unresolved.length === 0) {
        showToast('Semua catatan offline berhasil disinkronkan ke server.');
        await onRefresh();
      } else if (attemptedSync && unresolved.some((item) => item.state === 'CONFLICT')) {
        showToast('Sinkronisasi menemukan konflik. Closing tetap dikunci sampai konflik diselesaikan.');
      } else if (attemptedSync && unresolved.some((item) => item.state === 'FAILED')) {
        showToast('Sebagian catatan ditolak server dan tidak akan dicoba otomatis.');
      }
    } catch (e) {
      console.error('Queue sync error', e);
      try {
        await idbQueue.recoverSending(queueScope);
        await loadQueueSummary();
      } catch (recoveryError) {
        console.error('Queue recovery error', recoveryError);
      }
    } finally {
      syncInFlightRef.current = false;
    }
  };

  useEffect(() => {
    let active = true;
    setQueueStateLoaded(false);
    setQueueItems([]);
    setHandoverCompleted(false);
    setClosingCompleted(false);

    const initializeQueue = async () => {
      try {
        await idbQueue.recoverSending(queueScope);
        await loadQueueSummary();
        if (active && activeScopeRef.current === scopeSignature) setQueueStateLoaded(true);
        await syncQueue();
      } catch (e) {
        console.error('Queue initialization error', e);
      }
    };
    const handleOnline = () => void syncQueue();
    const interval = setInterval(() => void syncQueue(), 15000);
    void initializeQueue();
    window.addEventListener('online', handleOnline);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener('online', handleOnline);
    };
  }, [profileId, outletId, cycleId]);

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

    const uncounted = items.filter((it) => openingCounts[it.id] === undefined || openingCounts[it.id].trim() === '');
    if (uncounted.length > 0) {
      showToast(`Harap hitung fisik semua item. "${uncounted[0].name}" belum diisi.`);
      return;
    }

    const invalidCount = items.find((it) => {
      const count = Number(openingCounts[it.id]);
      return !Number.isFinite(count) || count < 0;
    });
    if (invalidCount) {
      showToast(`Jumlah fisik "${invalidCount.name}" harus berupa angka minimal 0.`);
      return;
    }

    const incompleteVariance = items.find((it) => {
      const hasVariance = Number(openingCounts[it.id]) !== (itemBalances[it.id]?.opening || 0);
      return hasVariance && (!openingReasons[it.id]?.trim() || !openingNotes[it.id]?.trim());
    });
    if (incompleteVariance) {
      showToast(`Alasan dan catatan selisih "${incompleteVariance.name}" wajib diisi.`);
      return;
    }

    setLoading(true);
    try {
      const lines = items.map((it) => {
        const val = Number(openingCounts[it.id]);
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
      const status = typeof err?.status === 'number' ? err.status : null;
      const errorCode = typeof err?.code === 'string' ? err.code : 'UNKNOWN_ERROR';
      showToast(status === 409
        ? `Konfirmasi stok awal berkonflik dengan server (${errorCode}).`
        : `Gagal konfirmasi stok awal (${errorCode}).`);
    } finally {
      setLoading(false);
    }
  };

  const handleAddMovement = async () => {
    if (isMovementFinal) {
      showToast('Perubahan stok sudah dikunci setelah finalisasi shift.');
      return;
    }

    const qty = Number(mvQty);
    if (!mvItem || !Number.isFinite(qty) || qty <= 0) {
      showToast('Isi jumlah barang yang valid.');
      return;
    }

    const idempotencyKey = crypto.randomUUID();
    const baseVersion = cycleVersionRef.current;
    const clientOccurredAt = new Date().toISOString();
    if (!Number.isInteger(baseVersion) || baseVersion <= 0 || !Number.isFinite(Date.parse(clientOccurredAt))) {
      showToast('Versi cycle atau waktu perangkat tidak valid. Muat ulang sebelum mencatat.');
      return;
    }
    const payload = {
      cycle_id: cycleId,
      item_id: mvItem,
      direction: mvType === 'Masuk' ? 'IN' : 'OUT',
      category: mvCat,
      quantity: qty,
      client_occurred_at: clientOccurredAt,
    };

    setLoading(true);
    try {
      const queueId = await idbQueue.add({
        ...queueScope,
        idempotencyKey,
        baseVersion,
        action: 'CREATE_MOVEMENT',
        payload,
      });
      await loadQueueSummary();
      if (navigator.onLine) await syncQueue();

      const remaining = await idbQueue.getForAggregate(queueScope);
      const savedItem = remaining.find((item) => item.id === queueId);
      if (savedItem?.state === 'CONFLICT') {
        showToast('Catatan tersimpan, tetapi konflik dengan kondisi server dan perlu ditinjau.');
      } else if (savedItem?.state === 'FAILED') {
        showToast('Catatan tersimpan, tetapi ditolak server dan tidak akan dicoba otomatis.');
      } else if (savedItem) {
        showToast(navigator.onLine
          ? 'Catatan tersimpan dan menunggu sinkronisasi.'
          : 'Offline: Perubahan disimpan di antrean perangkat.');
      }
      setMvQty('');
      setMovementModalOpen(false);
    } catch (err: any) {
      const errorCode = typeof err?.code === 'string' ? err.code : 'QUEUE_WRITE_FAILED';
      showToast(`Gagal menyimpan antrean perubahan (${errorCode}).`);
    } finally {
      setLoading(false);
    }
  };

  const verifyEmptyQueue = async (actionLabel: string) => {
    if (!queueStateLoaded) {
      showToast(`Status antrean masih dimuat. Tunggu sebelum ${actionLabel}.`);
      return false;
    }
    try {
      const currentQueue = await loadQueueSummary();
      const currentUnresolvedCount = currentQueue.filter((item) => item.state !== 'SYNCED').length;
      if (currentUnresolvedCount > 0) {
        showToast(`Terdapat ${currentUnresolvedCount} transaksi yang belum terselesaikan.`);
        return false;
      }
      return true;
    } catch (err: any) {
      const errorCode = typeof err?.code === 'string' ? err.code : 'QUEUE_READ_FAILED';
      showToast(`Status antrean tidak dapat diverifikasi (${errorCode}). ${actionLabel} dibatalkan.`);
      return false;
    }
  };

  const handleCompleteHandover = async () => {
    if (!isPrimary || !await verifyEmptyQueue('handover')) return;
    setLoading(true);
    try {
      await api.completeHandover(cycleId);
      setHandoverCompleted(true);
      showToast('Handover shift berhasil diselesaikan.');
      try {
        await onRefresh();
      } catch {
        showToast('Handover berhasil, tetapi tampilan gagal dimuat ulang.');
      }
    } catch (err: any) {
      showToast(`Gagal menyelesaikan handover (${typeof err?.code === 'string' ? err.code : 'UNKNOWN_ERROR'}).`);
    } finally {
      setLoading(false);
    }
  };

  const handleRetryFailed = async (item: QueueItem) => {
    try {
      await idbQueue.markPending(queueScope, item.id, item.lastErrorCode || 'MANUAL_RETRY', Date.now());
      await loadQueueSummary();
      await syncQueue();
    } catch (err: any) {
      showToast(`Gagal menjadwalkan ulang transaksi (${typeof err?.code === 'string' ? err.code : 'QUEUE_RETRY_FAILED'}).`);
    }
  };

  const handleResolveConflict = async (item: QueueItem) => {
    if (!window.confirm('Hapus transaksi konflik ini? Cycle akan dimuat ulang dan transaksi harus dimasukkan kembali secara manual.')) return;
    try {
      await onRefresh();
      await idbQueue.remove(queueScope, item.id);
      await loadQueueSummary();
      showToast('Konflik dihapus setelah refresh. Masukkan kembali transaksi dengan data terbaru.');
    } catch (err: any) {
      showToast(`Konflik tidak dihapus karena refresh gagal (${typeof err?.code === 'string' ? err.code : 'REFRESH_FAILED'}).`);
    }
  };

  const handleCheckOutRequest = async () => {
    if (!isRequiredFinal) {
      showToast(isDayShift ? 'Selesaikan handover sebelum check-out.' : 'Selesaikan closing sebelum check-out.');
      return;
    }
    if (await verifyEmptyQueue('check-out')) onCheckOutRequest();
  };

  const handleConfirmClosing = async () => {
    if (!isPrimary) {
      showToast('Hanya Penanggung Jawab Utama yang dapat mengonfirmasi closing.');
      return;
    }

    if (!await verifyEmptyQueue('closing')) return;

    const uncounted = items.filter((it) => closingCounts[it.id] === undefined || closingCounts[it.id].trim() === '');
    if (uncounted.length > 0) {
      showToast(`Harap hitung fisik closing semua item. "${uncounted[0].name}" belum diisi.`);
      return;
    }

    const invalidCount = items.find((it) => {
      const count = Number(closingCounts[it.id]);
      return !Number.isFinite(count) || count < 0;
    });
    if (invalidCount) {
      showToast(`Jumlah fisik "${invalidCount.name}" harus berupa angka minimal 0.`);
      return;
    }

    const incompleteVariance = items.find((it) => {
      const hasVariance = Number(closingCounts[it.id]) !== (itemBalances[it.id]?.system || 0);
      return hasVariance && (!closingReasons[it.id]?.trim() || !closingNotes[it.id]?.trim());
    });
    if (incompleteVariance) {
      showToast(`Alasan dan catatan selisih "${incompleteVariance.name}" wajib diisi.`);
      return;
    }

    setLoading(true);
    try {
      const lines = items.map((it) => {
        const bal = itemBalances[it.id];
        const val = Number(closingCounts[it.id]);
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
      setClosingCompleted(true);
      showToast('Closing shift berhasil dikonfirmasi.');
      try {
        await onRefresh();
      } catch {
        showToast('Closing berhasil, tetapi tampilan gagal dimuat ulang.');
      }
      onGoReports();
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : null;
      const errorCode = typeof err?.code === 'string' ? err.code : 'UNKNOWN_ERROR';
      showToast(status === 409
        ? `Closing berkonflik dengan kondisi server (${errorCode}).`
        : `Gagal konfirmasi closing (${errorCode}).`);
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
            {isClosingConfirmed || closingCompleted
              ? 'Closing shift telah dikonfirmasi.'
              : isHandoverConfirmed || handoverCompleted
                ? 'Handover shift telah diselesaikan.'
              : isOpeningConfirmed
              ? 'Catat perubahan stok masuk dan keluar secara real-time.'
              : 'Konfirmasi stok awal sebelum mencatat transaksi.'}
          </p>
          {!queueStateLoaded && (
            <p style={{ color: '#6b8378', fontSize: '12px', fontWeight: 600, marginTop: '4px' }}>
              Memuat status antrean perangkat...
            </p>
          )}
          {queueStateLoaded && unresolvedCount > 0 && (
            <div role="status" style={{ color: '#b45309', fontSize: '12px', fontWeight: 600, marginTop: '4px' }}>
              {queueSummary.pending + queueSummary.sending > 0 && (
                <div>{queueSummary.pending + queueSummary.sending} menunggu sinkronisasi</div>
              )}
              {queueSummary.conflict > 0 && <div>{queueSummary.conflict} konflik perlu ditinjau</div>}
              {queueSummary.failed > 0 && <div>{queueSummary.failed} gagal dan tidak dicoba otomatis</div>}
              {queueItems.filter((item) => item.state === 'FAILED').map((item) => (
                <button key={item.id} className="outline-button" onClick={() => void handleRetryFailed(item)} disabled={loading}>
                  Coba Lagi {item.id.slice(0, 8)}
                </button>
              ))}
              {queueItems.filter((item) => item.state === 'CONFLICT').map((item) => (
                <button key={item.id} className="outline-button" onClick={() => void handleResolveConflict(item)} disabled={loading}>
                  Selesaikan Konflik {item.id.slice(0, 8)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <button
            className="outline-button"
            onClick={() => void handleCheckOutRequest()}
            disabled={loading || !queueStateLoaded || unresolvedCount > 0 || !isRequiredFinal}
            style={{ borderColor: '#d97706', color: '#b45309' }}
          >
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
                        min="0"
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
            <button className="primary-button" onClick={() => setMovementModalOpen(true)} disabled={isMovementFinal}>
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
                          {movementCategoryLabel(m.category)} · {new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }).format(new Date(m.server_occurred_at))} WIB
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

      {isDayShift && isOpeningConfirmed && !isHandoverConfirmed && !handoverCompleted && (
        <div className="section-card">
          <button
            className="primary-button"
            onClick={() => void handleCompleteHandover()}
            disabled={loading || !isPrimary || !queueStateLoaded || unresolvedCount > 0}
            style={{ width: '100%' }}
          >
            {loading ? 'Menyimpan...' : !queueStateLoaded ? 'Memuat Antrean...' : unresolvedCount > 0 ? 'Selesaikan Antrean Sebelum Handover' : 'Selesaikan Handover →'}
          </button>
        </div>
      )}

      {/* 4. CLOSING TAB */}
      {tab === 'closing' && isNightOrFull && (
        <div className="section-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">HITUNG FISIK AKHIR SHIFT</p>
              <h2>{isClosingConfirmed || closingCompleted ? 'Closing Selesai Terkunci' : 'Closing Stok Akhir'}</h2>
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
                        min="0"
                        disabled={isClosingConfirmed || closingCompleted}
                        value={val}
                        onChange={(e) => setClosingCounts({ ...closingCounts, [it.id]: e.target.value })}
                        style={{ width: '90px', padding: '6px', textAlign: 'right', borderRadius: '6px', border: '1px solid #cddcd4' }}
                      />
                      <span>{it.unit_code}</span>
                    </div>
                  </div>

                  {hasDiff && !isClosingConfirmed && !closingCompleted && (
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

          {!isClosingConfirmed && !closingCompleted && (
            <button
              className="primary-button"
              onClick={handleConfirmClosing}
              disabled={loading || !isPrimary || !queueStateLoaded || unresolvedCount > 0}
              style={{ marginTop: '20px', width: '100%' }}
            >
              {loading
                ? 'Menyimpan...'
                : !queueStateLoaded
                  ? 'Memuat Antrean...'
                  : unresolvedCount > 0
                    ? 'Selesaikan Antrean Sebelum Closing'
                    : 'Konfirmasi Closing & Buat Laporan →'}
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
              min="0"
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
