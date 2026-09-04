import { useState, useMemo, useEffect, useRef } from 'react';
import type { Area, ShiftType, Item, DutyRole } from '../../domain/types';
import { fmtNumber, areaLabel, shiftLabel, statusOfStock, movementCategoryLabel } from '../../domain/rules';
import { api } from '../../lib/api';
import { idbQueue, type QueueItem } from '../../lib/idb-queue';

type Tab = 'overview' | 'opening' | 'movement' | 'closing';
type OpeningReference = Awaited<ReturnType<typeof api.getOpeningReference>>;
type CountState = 'UNCOUNTED' | 'MATCHED' | 'VARIANCE';
type CorrectionCategory = 'PURCHASE' | 'RETURN_IN' | 'TRANSFER_IN' | 'USAGE' | 'INTERNAL' | 'TRANSFER_OUT' | 'WASTE';

const countStateOf = (value: string, reference: number | null): CountState => {
  if (reference === null || value.trim() === '' || !Number.isFinite(Number(value))) return 'UNCOUNTED';
  return Number(value) === reference ? 'MATCHED' : 'VARIANCE';
};

const countStateLabel: Record<CountState, string> = {
  UNCOUNTED: 'Belum dihitung',
  MATCHED: 'Sesuai',
  VARIANCE: 'Selisih',
};

type Props = {
  profileId: string;
  outletId: string;
  cycleId: string;
  area: Area;
  shift: ShiftType;
  dutyRole: DutyRole;
  items: Item[];
  cycleData: any;
  canManage?: boolean;
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
  canManage = false,
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
  const [criticalError, setCriticalError] = useState('');
  const [queueStateLoaded, setQueueStateLoaded] = useState(false);
  const [queueSummary, setQueueSummary] = useState({ pending: 0, sending: 0, conflict: 0, failed: 0 });
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [handoverCompleted, setHandoverCompleted] = useState(false);
  const [closingCompleted, setClosingCompleted] = useState(false);
  const [openingReference, setOpeningReference] = useState<OpeningReference | null>(null);
  const [openingReferenceLoading, setOpeningReferenceLoading] = useState(false);
  const [openingReferenceError, setOpeningReferenceError] = useState('');
  const [openingReferenceReload, setOpeningReferenceReload] = useState(0);
  const [initializationDialogOpen, setInitializationDialogOpen] = useState(false);
  const [initializationReason, setInitializationReason] = useState('');
  const [bulkMatchTarget, setBulkMatchTarget] = useState<'OPENING' | 'CLOSING' | null>(null);
  const [conflictDiscardItem, setConflictDiscardItem] = useState<QueueItem | null>(null);
  const [correctionMovement, setCorrectionMovement] = useState<any | null>(null);
  const [correctionQty, setCorrectionQty] = useState('');
  const [correctionCategory, setCorrectionCategory] = useState<CorrectionCategory>('USAGE');
  const [correctionReason, setCorrectionReason] = useState('');
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

  const showCriticalError = (msg: string) => {
    setCriticalError(msg);
    showToast(msg);
  };

  useEffect(() => {
    setOpeningCounts({});
    setOpeningReasons({});
    setOpeningNotes({});
    setClosingCounts({});
    setClosingReasons({});
    setClosingNotes({});
    setCriticalError('');
    setInitializationDialogOpen(false);
    setBulkMatchTarget(null);
    setConflictDiscardItem(null);
    setCorrectionMovement(null);
  }, [cycleId]);

  useEffect(() => {
    let active = true;
    if (openingRecord) {
      setOpeningReference(null);
      setOpeningReferenceLoading(false);
      setOpeningReferenceError('');
      return () => { active = false; };
    }

    setOpeningReference(null);
    setOpeningReferenceLoading(true);
    setOpeningReferenceError('');
    void api.getOpeningReference(cycleId)
      .then((reference) => {
        if (active && activeScopeRef.current === scopeSignature) setOpeningReference(reference);
      })
      .catch((err: any) => {
        if (!active || activeScopeRef.current !== scopeSignature) return;
        const code = typeof err?.code === 'string' ? err.code : 'OPENING_REFERENCE_FAILED';
        setOpeningReferenceError(`Patokan stok awal gagal dimuat (${code}).`);
      })
      .finally(() => {
        if (active && activeScopeRef.current === scopeSignature) setOpeningReferenceLoading(false);
      });

    return () => { active = false; };
  }, [scopeSignature, openingRecord?.id, openingReferenceReload]);

  useEffect(() => {
    const hasDialog = movementModalOpen || initializationDialogOpen || bulkMatchTarget !== null
      || conflictDiscardItem !== null || correctionMovement !== null;
    if (!hasDialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || loading) return;
      setMovementModalOpen(false);
      setInitializationDialogOpen(false);
      setBulkMatchTarget(null);
      setConflictDiscardItem(null);
      setCorrectionMovement(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [movementModalOpen, initializationDialogOpen, bulkMatchTarget, conflictDiscardItem, correctionMovement, loading]);

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
  const correctedMovementIds = useMemo(
    () => new Set(movements.filter((movement: any) => movement.correction_of_id).map((movement: any) => movement.correction_of_id)),
    [movements],
  );
  const openingReferenceByItem = useMemo(() => {
    if (openingRecord) {
      return new Map<string, number>(
        (openingRecord.stock_opening_lines ?? []).map((line: any) => [line.item_id, Number(line.reference_qty)]),
      );
    }
    if (openingReference?.state !== 'AVAILABLE') return new Map<string, number>();
    return new Map(openingReference.lines.map((line) => [line.item_id, Number(line.reference_qty)]));
  }, [openingRecord, openingReference]);
  const openingReferenceReady = Boolean(openingRecord) || openingReference?.state === 'AVAILABLE';
  const missingOpeningReferences = openingReferenceReady
    ? items.filter((item) => {
      const reference = openingReferenceByItem.get(item.id);
      return reference === undefined || !Number.isFinite(reference) || reference < 0;
    })
    : [];
  const openingSourceType = openingRecord?.reference_source_type ?? openingReference?.source_type ?? null;
  const openingSourceLabel = openingSourceType === 'HANDOVER'
    ? 'handover shift siang hari ini'
    : openingSourceType === 'CLOSING'
      ? 'closing terakhir yang dikonfirmasi'
      : openingSourceType === 'INITIALIZATION'
        ? 'inisialisasi 0 yang disetujui manajemen'
        : null;
  const openingWarningCode = openingRecord?.reference_warning_code
    ?? openingRecord?.warning_code
    ?? openingReference?.warning_code
    ?? (shift === 'MALAM' && openingSourceType === 'CLOSING' ? 'HANDOVER_MISSING_USING_PRIOR_CLOSING' : null);

  // Calculate balances per item
  const itemBalances = useMemo(() => {
    const map: Record<string, { opening: number | null; incoming: number; outgoing: number; system: number | null }> = {};
    for (const it of items) {
      const opLine = openingRecord?.stock_opening_lines?.find((l: any) => l.item_id === it.id);
      const rawOpening = opLine?.counted_qty != null
        ? Number(opLine.counted_qty)
        : openingReferenceByItem.get(it.id);
      const opVal = rawOpening !== undefined && Number.isFinite(rawOpening) ? rawOpening : null;

      const itMovements = movements.filter((m: any) => m.item_id === it.id);
      const inc = itMovements.filter((m: any) => m.direction === 'IN').reduce((acc: number, m: any) => acc + Number(m.quantity), 0);
      const out = itMovements.filter((m: any) => m.direction === 'OUT').reduce((acc: number, m: any) => acc + Number(m.quantity), 0);

      map[it.id] = {
        opening: opVal,
        incoming: inc,
        outgoing: out,
        system: opVal === null ? null : opVal + inc - out,
      };
    }
    return map;
  }, [items, openingRecord, openingReferenceByItem, movements]);

  const markOpeningCount = (itemId: string, value: string) => {
    const reference = openingReferenceByItem.get(itemId);
    if (isOpeningConfirmed || reference === undefined) return;
    const next = { ...openingCounts, [itemId]: value };
    setOpeningCounts(next);
    if (value.trim() !== '' && Number(value) === reference) {
      // matches system -> no variance -> clear stale reason/notes
      const reasons = { ...openingReasons };
      const notes = { ...openingNotes };
      delete reasons[itemId];
      delete notes[itemId];
      setOpeningReasons(reasons);
      setOpeningNotes(notes);
    }
  };

  const markAllOpeningMatch = () => {
    if (isOpeningConfirmed || !openingReferenceReady || missingOpeningReferences.length > 0) return;
    const next: Record<string, string> = {};
    const reasons = { ...openingReasons };
    const notes = { ...openingNotes };
    items.forEach((it) => {
      const ref = openingReferenceByItem.get(it.id);
      if (ref === undefined) return;
      next[it.id] = ref.toString();
      delete reasons[it.id];
      delete notes[it.id];
    });
    setOpeningCounts(next);
    setOpeningReasons(reasons);
    setOpeningNotes(notes);
    setBulkMatchTarget(null);
    showToast('Semua item disamakan dengan patokan sistem.');
  };

  const markClosingCount = (itemId: string, value: string) => {
    if (isClosingConfirmed || closingCompleted || itemBalances[itemId]?.system === null) return;
    setClosingCounts((current) => ({ ...current, [itemId]: value }));
    if (value.trim() !== '' && Number(value) === itemBalances[itemId]?.system) {
      setClosingReasons((current) => {
        const next = { ...current };
        delete next[itemId];
        return next;
      });
      setClosingNotes((current) => {
        const next = { ...current };
        delete next[itemId];
        return next;
      });
    }
  };

  const markAllClosingMatch = () => {
    if (isClosingConfirmed || closingCompleted || items.some((item) => itemBalances[item.id]?.system === null)) return;
    const next: Record<string, string> = {};
    items.forEach((item) => {
      const system = itemBalances[item.id]?.system;
      if (system !== null && system !== undefined) next[item.id] = system.toString();
    });
    setClosingCounts(next);
    setClosingReasons({});
    setClosingNotes({});
    setBulkMatchTarget(null);
    showToast('Semua stok akhir disamakan dengan sisa catatan.');
  };

  const handleInitializeOpeningReference = async () => {
    const reason = initializationReason.trim();
    const expectedVersion = cycleVersionRef.current;
    setCriticalError('');
    if (!canManage) {
      showCriticalError('Inisialisasi ditolak di tampilan: hak Owner/Supervisor belum tersedia.');
      return;
    }
    if (!reason) {
      showCriticalError('Alasan inisialisasi wajib diisi.');
      return;
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
      showCriticalError('Versi cycle tidak valid. Muat ulang sebelum inisialisasi.');
      return;
    }

    setLoading(true);
    try {
      await api.initializeOpeningReference(cycleId, expectedVersion, reason);
      const reference = await api.getOpeningReference(cycleId);
      if (reference.state !== 'AVAILABLE') throw Object.assign(new Error('Referensi belum tersedia.'), { code: 'REFERENCE_NOT_AVAILABLE' });
      setOpeningReference(reference);
      setOpeningReferenceError('');
      setInitializationReason('');
      setInitializationDialogOpen(false);
      showToast('Referensi stok awal berhasil diinisialisasi. Semua patokan awal kini 0.');
      try {
        await onRefresh();
      } catch {
        showCriticalError('Referensi berhasil dibuat, tetapi data cycle gagal dimuat ulang.');
      }
    } catch (err: any) {
      showCriticalError(`Gagal menginisialisasi referensi (${typeof err?.code === 'string' ? err.code : 'UNKNOWN_ERROR'}).`);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmOpening = async () => {
    setCriticalError('');
    if (!isPrimary) {
      showCriticalError('Hanya Penanggung Jawab Utama yang dapat mengonfirmasi stok awal.');
      return;
    }
    if (!openingReferenceReady || missingOpeningReferences.length > 0) {
      showCriticalError(missingOpeningReferences.length > 0
        ? `Patokan stok awal tidak lengkap. Item "${missingOpeningReferences[0].name}" tidak memiliki referensi server.`
        : 'Patokan stok awal belum tersedia. Opening tidak dapat dikonfirmasi.');
      return;
    }

    const uncounted = items.filter((it) => openingCounts[it.id] === undefined || openingCounts[it.id].trim() === '');
    if (uncounted.length > 0) {
      showCriticalError(`Harap hitung fisik semua item. "${uncounted[0].name}" belum diisi.`);
      return;
    }

    const invalidCount = items.find((it) => {
      const count = Number(openingCounts[it.id]);
      return !Number.isFinite(count) || count < 0;
    });
    if (invalidCount) {
      showCriticalError(`Jumlah fisik "${invalidCount.name}" harus berupa angka minimal 0.`);
      return;
    }

    const incompleteVariance = items.find((it) => {
      const hasVariance = Number(openingCounts[it.id]) !== openingReferenceByItem.get(it.id);
      return hasVariance && !openingReasons[it.id]?.trim();
    });
    if (incompleteVariance) {
      showCriticalError(`Pilih kategori alasan selisih untuk "${incompleteVariance.name}".`);
      return;
    }

    setLoading(true);
    try {
      const lines = items.map((it) => {
        const val = Number(openingCounts[it.id]);
        return {
          item_id: it.id,
          reference_qty: openingReferenceByItem.get(it.id),
          counted_qty: val,
          reason_code: openingReasons[it.id] || null,
          notes: openingNotes[it.id] || null,
        };
      });

      await api.confirmOpening(cycleId, lines);
      setCriticalError('');
      showToast('Stok awal berhasil dikonfirmasi.');
      await onRefresh();
      setTab('movement');
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : null;
      const errorCode = typeof err?.code === 'string' ? err.code : 'UNKNOWN_ERROR';
      showCriticalError(status === 409
        ? `Konfirmasi stok awal berkonflik dengan server (${errorCode}).`
        : `Gagal konfirmasi stok awal (${errorCode}).`);
    } finally {
      setLoading(false);
    }
  };

  const handleAddMovement = async () => {
    setCriticalError('');
    if (isMovementFinal) {
      showCriticalError('Perubahan stok sudah dikunci setelah finalisasi shift.');
      return;
    }

    const qty = Number(mvQty);
    if (!mvItem || !Number.isFinite(qty) || qty <= 0) {
      showCriticalError('Isi jumlah barang yang valid.');
      return;
    }

    const idempotencyKey = crypto.randomUUID();
    const baseVersion = cycleVersionRef.current;
    const clientOccurredAt = new Date().toISOString();
    if (!Number.isInteger(baseVersion) || baseVersion <= 0 || !Number.isFinite(Date.parse(clientOccurredAt))) {
      showCriticalError('Versi cycle atau waktu perangkat tidak valid. Muat ulang sebelum mencatat.');
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
      showCriticalError(`Gagal menyimpan antrean perubahan (${errorCode}).`);
    } finally {
      setLoading(false);
    }
  };

  const verifyEmptyQueue = async (actionLabel: string) => {
    if (!queueStateLoaded) {
      showCriticalError(`Status antrean masih dimuat. Tunggu sebelum ${actionLabel}.`);
      return false;
    }
    try {
      const currentQueue = await loadQueueSummary();
      const currentUnresolvedCount = currentQueue.filter((item) => item.state !== 'SYNCED').length;
      if (currentUnresolvedCount > 0) {
        showCriticalError(`Terdapat ${currentUnresolvedCount} transaksi yang belum terselesaikan. ${actionLabel} diblokir.`);
        return false;
      }
      return true;
    } catch (err: any) {
      const errorCode = typeof err?.code === 'string' ? err.code : 'QUEUE_READ_FAILED';
      showCriticalError(`Status antrean tidak dapat diverifikasi (${errorCode}). ${actionLabel} dibatalkan.`);
      return false;
    }
  };

  const handleCompleteHandover = async () => {
    setCriticalError('');
    if (!isPrimary || !await verifyEmptyQueue('handover')) return;
    setLoading(true);
    try {
      await api.completeHandover(cycleId);
      setHandoverCompleted(true);
      showToast('Handover shift berhasil diselesaikan.');
      try {
        await onRefresh();
      } catch {
        showCriticalError('Handover berhasil, tetapi tampilan gagal dimuat ulang.');
      }
    } catch (err: any) {
      showCriticalError(`Gagal menyelesaikan handover (${typeof err?.code === 'string' ? err.code : 'UNKNOWN_ERROR'}).`);
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
      showCriticalError(`Gagal menjadwalkan ulang transaksi (${typeof err?.code === 'string' ? err.code : 'QUEUE_RETRY_FAILED'}).`);
    }
  };

  const handleResolveConflict = async (item: QueueItem) => {
    setLoading(true);
    setCriticalError('');
    try {
      await onRefresh();
      await idbQueue.remove(queueScope, item.id);
      await loadQueueSummary();
      setConflictDiscardItem(null);
      showToast('Konflik dihapus setelah refresh. Masukkan kembali transaksi dengan data terbaru.');
    } catch (err: any) {
      showCriticalError(`Konflik tidak dihapus karena refresh gagal (${typeof err?.code === 'string' ? err.code : 'REFRESH_FAILED'}).`);
    } finally {
      setLoading(false);
    }
  };

  const openCorrection = (movement: any) => {
    const direction = movement.direction === 'IN' ? 'OUT' : 'IN';
    setCorrectionMovement(movement);
    setCorrectionQty(String(movement.quantity));
    setCorrectionCategory(direction === 'IN' ? 'PURCHASE' : 'USAGE');
    setCorrectionReason('');
    setCriticalError('');
  };

  const handleCorrectMovement = async () => {
    if (!correctionMovement) return;
    setCriticalError('');
    if (isMovementFinal) {
      showCriticalError('Koreksi diblokir setelah finalisasi shift.');
      return;
    }
    if (!await verifyEmptyQueue('koreksi movement')) return;

    const quantity = Number(correctionQty);
    const originalQuantity = Number(correctionMovement.quantity);
    const reason = correctionReason.trim();
    const expectedVersion = cycleVersionRef.current;
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity !== originalQuantity) {
      showCriticalError(`Jumlah koreksi harus sama dengan movement asal: ${fmtNumber(originalQuantity)}.`);
      return;
    }
    if (!reason) {
      showCriticalError('Alasan koreksi wajib diisi.');
      return;
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
      showCriticalError('Versi cycle tidak valid. Muat ulang sebelum koreksi.');
      return;
    }

    const direction = correctionMovement.direction === 'IN' ? 'OUT' : 'IN';
    setLoading(true);
    try {
      const common = {
        cycle_id: cycleId,
        expected_version: expectedVersion,
        original_movement_id: correctionMovement.id,
        quantity,
        idempotency_key: crypto.randomUUID(),
        reason,
      };
      const result = direction === 'IN'
        ? await api.correctMovement({ ...common, direction, category: correctionCategory as 'PURCHASE' | 'RETURN_IN' | 'TRANSFER_IN' })
        : await api.correctMovement({ ...common, direction, category: correctionCategory as 'USAGE' | 'INTERNAL' | 'TRANSFER_OUT' | 'WASTE' });
      const nextVersion = Number(result.movement.cycle_version);
      if (!Number.isInteger(nextVersion) || nextVersion <= expectedVersion) {
        throw Object.assign(new Error('Versi correction tidak valid.'), { code: 'INVALID_CYCLE_VERSION' });
      }
      cycleVersionRef.current = nextVersion;
      setCorrectionMovement(null);
      setCorrectionReason('');
      showToast('Movement koreksi tersimpan sebagai catatan penyeimbang.');
      try {
        await onRefresh();
      } catch {
        showCriticalError('Koreksi berhasil, tetapi ledger gagal dimuat ulang.');
      }
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : null;
      const code = typeof err?.code === 'string' ? err.code : 'UNKNOWN_ERROR';
      showCriticalError(status === 409
        ? `Koreksi berkonflik dengan kondisi server (${code}). Muat ulang ledger.`
        : `Gagal menyimpan koreksi (${code}).`);
    } finally {
      setLoading(false);
    }
  };

  const handleCheckOutRequest = async () => {
    setCriticalError('');
    if (!isRequiredFinal) {
      showCriticalError(isDayShift ? 'Selesaikan handover sebelum check-out.' : 'Selesaikan closing sebelum check-out.');
      return;
    }
    if (await verifyEmptyQueue('check-out')) onCheckOutRequest();
  };

  const handleConfirmClosing = async () => {
    setCriticalError('');
    if (!isPrimary) {
      showCriticalError('Hanya Penanggung Jawab Utama yang dapat mengonfirmasi closing.');
      return;
    }

    if (!await verifyEmptyQueue('closing')) return;

    const unavailableBalance = items.find((item) => itemBalances[item.id]?.system === null);
    if (unavailableBalance) {
      showCriticalError(`Sisa catatan "${unavailableBalance.name}" belum tersedia. Closing diblokir.`);
      return;
    }

    const uncounted = items.filter((it) => closingCounts[it.id] === undefined || closingCounts[it.id].trim() === '');
    if (uncounted.length > 0) {
      showCriticalError(`Harap hitung fisik closing semua item. "${uncounted[0].name}" belum diisi.`);
      return;
    }

    const invalidCount = items.find((it) => {
      const count = Number(closingCounts[it.id]);
      return !Number.isFinite(count) || count < 0;
    });
    if (invalidCount) {
      showCriticalError(`Jumlah fisik "${invalidCount.name}" harus berupa angka minimal 0.`);
      return;
    }

    const incompleteVariance = items.find((it) => {
      const hasVariance = Number(closingCounts[it.id]) !== itemBalances[it.id]?.system;
      return hasVariance && !closingReasons[it.id]?.trim();
    });
    if (incompleteVariance) {
      showCriticalError(`Pilih kategori alasan selisih closing untuk "${incompleteVariance.name}".`);
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
      setCriticalError('');
      setClosingCompleted(true);
      showToast('Closing shift berhasil dikonfirmasi.');
      try {
        await onRefresh();
      } catch {
        showCriticalError('Closing berhasil, tetapi tampilan gagal dimuat ulang.');
      }
      onGoReports();
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : null;
      const errorCode = typeof err?.code === 'string' ? err.code : 'UNKNOWN_ERROR';
      showCriticalError(status === 409
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
                <button key={item.id} className="outline-button" onClick={() => setConflictDiscardItem(item)} disabled={loading}>
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

      {criticalError && (
        <div role="alert" className="form-error" style={{ marginBottom: '16px' }}>
          <strong>Tindakan belum selesai.</strong> {criticalError}
          <button
            type="button"
            className="outline-button"
            onClick={() => setCriticalError('')}
            style={{ marginLeft: '12px', padding: '4px 8px' }}
          >
            Tutup pesan
          </button>
        </div>
      )}

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
                    const b = itemBalances[it.id] || { opening: null, incoming: 0, outgoing: 0, system: null };
                    const st = statusOfStock(b.system, it.low_threshold);
                    return (
                      <tr key={it.id} style={{ borderBottom: '1px solid #eef3f0' }}>
                        <td style={{ padding: '8px', fontWeight: 600 }}>{it.name}</td>
                        <td style={{ padding: '8px' }}>{b.opening === null ? 'Belum tersedia' : `${fmtNumber(b.opening)} ${it.unit_code}`}</td>
                        <td style={{ padding: '8px', color: '#1e5b48' }}>+{fmtNumber(b.incoming)}</td>
                        <td style={{ padding: '8px', color: '#b91c1c' }}>-{fmtNumber(b.outgoing)}</td>
                        <td style={{ padding: '8px', fontWeight: 700 }}>{b.system === null ? 'Belum tersedia' : `${fmtNumber(b.system)} ${it.unit_code}`}</td>
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

          <div
            role={openingReferenceError || openingReference?.state === 'INITIALIZATION_REQUIRED' || missingOpeningReferences.length > 0 ? 'alert' : 'status'}
            style={{ marginTop: '16px', padding: '12px', borderRadius: '10px', border: '1px solid #d8e9dd', background: '#f0f7f2', color: '#496b5d', fontSize: '12px' }}
          >
            {openingReferenceLoading ? (
              <strong>Memuat patokan stok awal dari server...</strong>
            ) : openingReferenceError ? (
              <>
                <strong>{openingReferenceError}</strong> Nilai 0 tidak digunakan sebagai pengganti.
                <button type="button" className="outline-button" onClick={() => setOpeningReferenceReload((value) => value + 1)} style={{ marginLeft: '10px' }}>
                  Coba Lagi
                </button>
              </>
            ) : openingReference?.state === 'INITIALIZATION_REQUIRED' ? (
              <>
                <strong>Patokan belum tersedia.</strong> Tidak ada handover, closing terdahulu, atau inisialisasi yang disetujui. Nilai stok awal sengaja tidak ditampilkan sebagai 0.
                {canManage ? (
                  <button type="button" className="primary-button" onClick={() => setInitializationDialogOpen(true)} style={{ marginLeft: '10px' }}>
                    Inisialisasi Patokan 0
                  </button>
                ) : (
                  <span style={{ display: 'block', marginTop: '8px', fontWeight: 700 }}>
                    Diblokir: Owner/Supervisor harus membuka workspace dengan izin manajemen untuk menginisialisasi patokan.
                  </span>
                )}
              </>
            ) : missingOpeningReferences.length > 0 ? (
              <strong>Patokan server tidak lengkap untuk {missingOpeningReferences.map((item) => item.name).join(', ')}. Konfirmasi diblokir.</strong>
            ) : openingSourceLabel ? (
              <>
                <strong>Sumber patokan:</strong> {openingSourceLabel}.
                {openingWarningCode && (
                  <span style={{ display: 'block', marginTop: '6px', color: '#9a6700', fontWeight: 700 }}>
                    {openingWarningCode === 'HANDOVER_MISSING_USING_PRIOR_CLOSING'
                      ? 'Peringatan: handover shift siang tidak ditemukan; server memakai closing terdahulu.'
                      : `Peringatan referensi server: ${openingWarningCode}.`}
                  </span>
                )}
              </>
            ) : (
              <strong>Sumber patokan tidak tercatat. Nilai opening tersimpan tetap ditampilkan tanpa menebak sumber.</strong>
            )}
          </div>

          {!isOpeningConfirmed && openingReferenceReady && missingOpeningReferences.length === 0 && (
            <button
              type="button"
              className="outline-button"
              onClick={() => setBulkMatchTarget('OPENING')}
              disabled={loading || items.length === 0}
              style={{ width: '100%', marginTop: '16px' }}
            >
              Saya Sudah Menghitung: Tandai Semua Sesuai
            </button>
          )}

          <div style={{ display: 'grid', gap: '12px', marginTop: '16px' }}>
            {items.map((it) => {
              const reference = openingReferenceByItem.get(it.id);
              const refVal = reference !== undefined && Number.isFinite(reference) ? reference : null;
              const savedLine = openingRecord?.stock_opening_lines?.find((line: any) => line.item_id === it.id);
              const val = openingCounts[it.id] !== undefined
                ? openingCounts[it.id]
                : isOpeningConfirmed && savedLine?.counted_qty != null
                  ? String(savedLine.counted_qty)
                  : '';
              const countState = countStateOf(val, refVal);
              const hasDiff = countState === 'VARIANCE';
              const inputId = `opening-count-${it.id}`;

              return (
                <div key={it.id} style={{ padding: '12px', background: countState === 'UNCOUNTED' ? '#fff7ed' : '#f8faf9', borderRadius: '10px', border: '1px solid #e0ece6' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <label htmlFor={inputId} style={{ display: 'block', fontWeight: 700 }}>{it.name}</label>
                      <small style={{ display: 'block', color: '#6b8378' }}>
                        Patokan Server: {refVal === null ? 'Belum tersedia' : `${fmtNumber(refVal)} ${it.unit_code}`}
                      </small>
                      <small style={{ display: 'block', color: countState === 'VARIANCE' ? '#b45309' : '#496b5d', fontWeight: 700 }}>
                        Status: {countStateLabel[countState]}
                      </small>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => refVal !== null && markOpeningCount(it.id, String(refVal))}
                        disabled={isOpeningConfirmed || refVal === null}
                        style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid #c9dad1', background: '#fff', color: '#1e5b48', fontSize: '11px', fontWeight: 700 }}
                      >
                        Sesuai
                      </button>
                      <button
                        type="button"
                        onClick={() => markOpeningCount(it.id, '0')}
                        disabled={isOpeningConfirmed || refVal === null}
                        style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid #c9dad1', background: '#fff', color: '#1e5b48', fontSize: '11px', fontWeight: 700 }}
                      >
                        0
                      </button>
                      <input
                        id={inputId}
                        type="number"
                        min="0"
                        step="any"
                        disabled={isOpeningConfirmed || refVal === null}
                        value={val}
                        placeholder="Custom"
                        aria-label={`Jumlah fisik stok awal ${it.name}`}
                        onChange={(e) => markOpeningCount(it.id, e.target.value)}
                        style={{ width: '76px', padding: '6px', textAlign: 'right', borderRadius: '6px', border: '1px solid #cddcd4' }}
                      />
                      <span>{it.unit_code}</span>
                    </div>
                  </div>

                  {hasDiff && !isOpeningConfirmed && (
                    <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #cddcd4' }}>
                      <label htmlFor={`opening-reason-${it.id}`} style={{ display: 'block', fontSize: '11px', fontWeight: 700, marginBottom: '4px' }}>
                        Kategori alasan selisih (wajib)
                      </label>
                      <select
                        id={`opening-reason-${it.id}`}
                        value={openingReasons[it.id] || ''}
                        onChange={(e) => setOpeningReasons({ ...openingReasons, [it.id]: e.target.value })}
                        style={{ width: '100%', padding: '6px', borderRadius: '6px', marginBottom: '6px' }}
                      >
                        <option value="">Pilih kategori</option>
                        <option value="INITIAL_STOCK_COUNT">Stok Awal Baru / Inisialisasi</option>
                        <option value="COUNTING_ERROR">Salah Hitung Sebelumnya</option>
                        <option value="SPILLAGE_UNRECORDED">Tumpah / Rusak Belum Dicatat</option>
                        <option value="OTHER">Lainnya</option>
                      </select>
                      <label htmlFor={`opening-note-${it.id}`} style={{ display: 'block', fontSize: '11px', fontWeight: 700, marginBottom: '4px' }}>
                        Catatan (opsional)
                      </label>
                      <input
                        id={`opening-note-${it.id}`}
                        type="text"
                        placeholder="Catatan tambahan (opsional)"
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
              disabled={loading || !isPrimary || !openingReferenceReady || missingOpeningReferences.length > 0}
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
                  const isCorrection = Boolean(m.correction_of_id);
                  const isCorrected = correctedMovementIds.has(m.id);
                  return (
                    <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', padding: '10px 14px', background: '#f8faf9', borderRadius: '8px', border: '1px solid #e0ece6' }}>
                      <div>
                        <strong>{it?.name || m.item_id}</strong>
                        <small style={{ display: 'block', color: '#6b8378' }}>
                          {movementCategoryLabel(m.category)} · {new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }).format(new Date(m.server_occurred_at))} WIB
                        </small>
                        {isCorrection && <small style={{ display: 'block', color: '#b45309', fontWeight: 700 }}>Koreksi untuk {String(m.correction_of_id).slice(0, 8)} · {m.correction_reason}</small>}
                        {isCorrected && <small style={{ display: 'block', color: '#6b8378', fontWeight: 700 }}>Sudah dikoreksi</small>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ fontWeight: 700, fontSize: '15px', color: isInc ? '#1e5b48' : '#b91c1c' }}>
                          {isInc ? '+' : '-'}{fmtNumber(m.quantity)} {m.unit_code_snapshot}
                        </div>
                        {!isCorrection && !isCorrected && !isMovementFinal && (
                          <button
                            type="button"
                            className="outline-button"
                            onClick={() => openCorrection(m)}
                            disabled={loading || !queueStateLoaded || unresolvedCount > 0}
                            title={unresolvedCount > 0 ? 'Selesaikan antrean perangkat sebelum koreksi.' : undefined}
                          >
                            Koreksi
                          </button>
                        )}
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
          {!isClosingConfirmed && !closingCompleted && (
            <button
              type="button"
              className="outline-button"
              onClick={() => setBulkMatchTarget('CLOSING')}
              disabled={loading || items.length === 0 || items.some((item) => itemBalances[item.id]?.system === null)}
              style={{ width: '100%', marginTop: '16px' }}
            >
              Saya Sudah Menghitung: Tandai Semua Sesuai
            </button>
          )}
          <div style={{ display: 'grid', gap: '12px', marginTop: '16px' }}>
            {items.map((it) => {
              const sysVal = itemBalances[it.id]?.system ?? null;
              const savedLine = closingRecord?.stock_closing_lines?.find((line: any) => line.item_id === it.id);
              const val = closingCounts[it.id] !== undefined
                ? closingCounts[it.id]
                : isClosingConfirmed && savedLine?.counted_qty != null
                  ? String(savedLine.counted_qty)
                  : '';
              const countState = countStateOf(val, sysVal);
              const hasDiff = countState === 'VARIANCE';
              const inputId = `closing-count-${it.id}`;

              return (
                <div key={it.id} style={{ padding: '12px', background: countState === 'UNCOUNTED' ? '#fff7ed' : '#f8faf9', borderRadius: '10px', border: '1px solid #e0ece6' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <div>
                      <label htmlFor={inputId} style={{ display: 'block', fontWeight: 700 }}>{it.name}</label>
                      <small style={{ display: 'block', color: '#6b8378' }}>Sisa Catatan: {sysVal === null ? 'Belum tersedia' : `${fmtNumber(sysVal)} ${it.unit_code}`}</small>
                      <small style={{ display: 'block', color: countState === 'VARIANCE' ? '#b45309' : '#496b5d', fontWeight: 700 }}>
                        Status: {countStateLabel[countState]}
                      </small>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => sysVal !== null && markClosingCount(it.id, String(sysVal))}
                        disabled={isClosingConfirmed || closingCompleted || sysVal === null}
                        style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid #c9dad1', background: '#fff', color: '#1e5b48', fontSize: '11px', fontWeight: 700 }}
                      >
                        Sesuai
                      </button>
                      <button
                        type="button"
                        onClick={() => markClosingCount(it.id, '0')}
                        disabled={isClosingConfirmed || closingCompleted || sysVal === null}
                        style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid #c9dad1', background: '#fff', color: '#1e5b48', fontSize: '11px', fontWeight: 700 }}
                      >
                        0
                      </button>
                      <input
                        id={inputId}
                        type="number"
                        min="0"
                        step="any"
                        disabled={isClosingConfirmed || closingCompleted || sysVal === null}
                        value={val}
                        placeholder="Custom"
                        aria-label={`Jumlah fisik stok akhir ${it.name}`}
                        onChange={(e) => markClosingCount(it.id, e.target.value)}
                        style={{ width: '90px', padding: '6px', textAlign: 'right', borderRadius: '6px', border: '1px solid #cddcd4' }}
                      />
                      <span>{it.unit_code}</span>
                    </div>
                  </div>

                  {hasDiff && !isClosingConfirmed && !closingCompleted && (
                    <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #cddcd4' }}>
                      <label htmlFor={`closing-reason-${it.id}`} style={{ display: 'block', fontSize: '11px', fontWeight: 700, marginBottom: '4px' }}>
                        Kategori alasan selisih (wajib)
                      </label>
                      <select
                        id={`closing-reason-${it.id}`}
                        value={closingReasons[it.id] || ''}
                        onChange={(e) => setClosingReasons({ ...closingReasons, [it.id]: e.target.value })}
                        style={{ width: '100%', padding: '6px', borderRadius: '6px', marginBottom: '6px' }}
                      >
                        <option value="">Pilih kategori</option>
                        <option value="OVER_PORTIONING">Takaran Porsi Lebih</option>
                        <option value="SPILLAGE_UNRECORDED">Tumpah Belum Dicatat</option>
                        <option value="WASTE_UNRECORDED">Waste / Basi</option>
                        <option value="OTHER">Lainnya</option>
                      </select>
                      <label htmlFor={`closing-note-${it.id}`} style={{ display: 'block', fontSize: '11px', fontWeight: 700, marginBottom: '4px' }}>
                        Catatan (opsional)
                      </label>
                      <input
                        id={`closing-note-${it.id}`}
                        type="text"
                        placeholder="Catatan tambahan (opsional)"
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
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="movement-dialog-title" style={{ maxWidth: '420px' }}>
            <div className="modal-head">
              <h3 id="movement-dialog-title">Catat Perubahan Stok</h3>
              <button type="button" className="close-button" aria-label="Tutup dialog" onClick={() => setMovementModalOpen(false)}>×</button>
            </div>

            {criticalError && <p className="form-error" role="alert">{criticalError}</p>}

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

            <label htmlFor="movement-item" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>Item</label>
            <select
              id="movement-item"
              value={mvItem}
              onChange={(e) => setMvItem(e.target.value)}
              style={{ width: '100%', padding: '8px', borderRadius: '6px', marginBottom: '12px' }}
            >
              {items.map((it) => (
                <option key={it.id} value={it.id}>{it.name} ({it.unit_code})</option>
              ))}
            </select>

            <label htmlFor="movement-quantity" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>Jumlah</label>
            <input
              id="movement-quantity"
              type="number"
              min="0"
              step="any"
              value={mvQty}
              onChange={(e) => setMvQty(e.target.value)}
              placeholder="0"
              style={{ width: '100%', padding: '8px', borderRadius: '6px', marginBottom: '12px', border: '1px solid #cddcd4' }}
            />

            <label htmlFor="movement-category" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>Kategori</label>
            <select
              id="movement-category"
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
              <button type="button" className="outline-button" onClick={() => setMovementModalOpen(false)}>Batal</button>
              <button type="button" className="primary-button" onClick={handleAddMovement} disabled={loading}>
                Simpan
              </button>
            </div>
          </div>
        </div>
      )}

      {initializationDialogOpen && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="initialization-dialog-title" style={{ maxWidth: '460px' }}>
            <div className="modal-head">
              <h3 id="initialization-dialog-title">Inisialisasi Patokan Stok 0</h3>
              <button type="button" className="close-button" aria-label="Tutup dialog" onClick={() => setInitializationDialogOpen(false)} disabled={loading}>×</button>
            </div>
            <p className="muted" style={{ margin: '12px 0' }}>
              Tindakan ini membuat referensi 0 untuk semua item aktif. Hanya gunakan saat belum pernah ada stok sebelumnya.
            </p>
            {criticalError && <p className="form-error" role="alert">{criticalError}</p>}
            <label htmlFor="initialization-reason" style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '4px' }}>Alasan (wajib)</label>
            <textarea
              id="initialization-reason"
              autoFocus
              maxLength={1000}
              value={initializationReason}
              onChange={(event) => setInitializationReason(event.target.value)}
              placeholder="Contoh: outlet baru, belum ada stok historis"
              style={{ width: '100%', minHeight: '88px', padding: '8px', borderRadius: '6px', border: '1px solid #cddcd4', resize: 'vertical' }}
            />
            <div className="modal-actions" style={{ marginTop: '16px' }}>
              <button type="button" className="outline-button" onClick={() => setInitializationDialogOpen(false)} disabled={loading}>Batal</button>
              <button type="button" className="primary-button" onClick={() => void handleInitializeOpeningReference()} disabled={loading || !initializationReason.trim()}>
                {loading ? 'Menyimpan...' : 'Inisialisasi Patokan 0'}
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkMatchTarget && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="bulk-match-dialog-title" style={{ maxWidth: '440px' }}>
            <div className="modal-head">
              <h3 id="bulk-match-dialog-title">Konfirmasi Semua Sesuai</h3>
              <button type="button" className="close-button" aria-label="Tutup dialog" onClick={() => setBulkMatchTarget(null)}>×</button>
            </div>
            <p style={{ margin: '16px 0' }}>
              Konfirmasi bahwa semua {items.length} item sudah dihitung fisik dan hasilnya sesuai {bulkMatchTarget === 'OPENING' ? 'patokan stok awal' : 'sisa catatan'}.
            </p>
            <div className="modal-actions">
              <button type="button" className="outline-button" onClick={() => setBulkMatchTarget(null)}>Batal</button>
              <button
                type="button"
                className="primary-button"
                autoFocus
                onClick={bulkMatchTarget === 'OPENING' ? markAllOpeningMatch : markAllClosingMatch}
              >
                Ya, Tandai Semua Sesuai
              </button>
            </div>
          </div>
        </div>
      )}

      {conflictDiscardItem && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="conflict-dialog-title" style={{ maxWidth: '460px' }}>
            <div className="modal-head">
              <h3 id="conflict-dialog-title">Hapus Transaksi Konflik?</h3>
              <button type="button" className="close-button" aria-label="Tutup dialog" onClick={() => setConflictDiscardItem(null)} disabled={loading}>×</button>
            </div>
            <p style={{ margin: '16px 0' }}>
              Cycle dimuat ulang lebih dulu. Transaksi {conflictDiscardItem.id.slice(0, 8)} lalu dihapus dari perangkat dan harus dimasukkan kembali secara manual.
            </p>
            {criticalError && <p className="form-error" role="alert">{criticalError}</p>}
            <div className="modal-actions">
              <button type="button" className="outline-button" onClick={() => setConflictDiscardItem(null)} disabled={loading}>Batal</button>
              <button type="button" className="primary-button" autoFocus onClick={() => void handleResolveConflict(conflictDiscardItem)} disabled={loading}>
                {loading ? 'Memuat Ulang...' : 'Muat Ulang & Hapus'}
              </button>
            </div>
          </div>
        </div>
      )}

      {correctionMovement && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="correction-dialog-title" style={{ maxWidth: '460px' }}>
            <div className="modal-head">
              <h3 id="correction-dialog-title">Koreksi Movement</h3>
              <button type="button" className="close-button" aria-label="Tutup dialog" onClick={() => setCorrectionMovement(null)} disabled={loading}>×</button>
            </div>
            <p className="muted" style={{ margin: '12px 0' }}>
              Server menyimpan koreksi berlawanan arah. Movement asal tetap ada untuk audit.
            </p>
            {criticalError && <p className="form-error" role="alert">{criticalError}</p>}
            <label htmlFor="correction-quantity" style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '4px' }}>
              Jumlah koreksi (wajib sama dengan asal)
            </label>
            <input
              id="correction-quantity"
              type="number"
              min="0"
              step="any"
              value={correctionQty}
              onChange={(event) => setCorrectionQty(event.target.value)}
              style={{ width: '100%', padding: '8px', borderRadius: '6px', marginBottom: '12px', border: '1px solid #cddcd4' }}
            />
            <label htmlFor="correction-category" style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '4px' }}>Kategori koreksi</label>
            <select
              id="correction-category"
              value={correctionCategory}
              onChange={(event) => setCorrectionCategory(event.target.value as CorrectionCategory)}
              style={{ width: '100%', padding: '8px', borderRadius: '6px', marginBottom: '12px' }}
            >
              {correctionMovement.direction === 'OUT' ? (
                <>
                  <option value="PURCHASE">Pembelian</option>
                  <option value="RETURN_IN">Retur Masuk</option>
                  <option value="TRANSFER_IN">Pindahan Masuk</option>
                </>
              ) : (
                <>
                  <option value="USAGE">Pemakaian Reguler</option>
                  <option value="INTERNAL">Pemakaian Internal</option>
                  <option value="TRANSFER_OUT">Pindahan Keluar</option>
                  <option value="WASTE">Waste / Rusak</option>
                </>
              )}
            </select>
            <label htmlFor="correction-reason" style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '4px' }}>Alasan koreksi</label>
            <textarea
              id="correction-reason"
              autoFocus
              maxLength={1000}
              value={correctionReason}
              onChange={(event) => setCorrectionReason(event.target.value)}
              style={{ width: '100%', minHeight: '80px', padding: '8px', borderRadius: '6px', border: '1px solid #cddcd4', resize: 'vertical' }}
            />
            <div className="modal-actions" style={{ marginTop: '16px' }}>
              <button type="button" className="outline-button" onClick={() => setCorrectionMovement(null)} disabled={loading}>Batal</button>
              <button type="button" className="primary-button" onClick={() => void handleCorrectMovement()} disabled={loading || !correctionReason.trim()}>
                {loading ? 'Menyimpan...' : 'Simpan Koreksi'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="live-region" role="status">{toast}</div>}
    </div>
  );
}
