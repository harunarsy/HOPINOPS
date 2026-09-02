import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, supabaseConfigured } from './lib/supabase';

type Area = 'BAR' | 'KITCHEN';
type Tab = 'overview' | 'opening' | 'movement' | 'closing' | 'reports';
type ShiftType = 'SIANG' | 'MALAM' | 'FULL';
type StockStatus = 'Belum diisi' | 'Aman' | 'Hampir habis' | 'Habis';
type ReportStatus = 'DRAFT' | 'SENT' | 'APPROVED' | 'NEEDS_CLARIFICATION';

type Assignment = {
  id: string; workDate: string; shift: ShiftType; area: Area; name: string; confirmedAt: string;
};

type OpeningRecord = {
  reference: Record<string, number>;
  counts: Record<string, number | null>;
  reasons: Record<string, string>;
  notes: Record<string, string>;
  confirmedAt?: string;
};

type ClosingRecord = { status: ReportStatus; submittedAt?: string; revision: number };

type Item = {
  id: string; area: Area; name: string; unit: string; low: number;
  opening: number; incoming: number; outgoing: number; closing: number | null;
  varianceReason?: string; varianceNotes?: string; updatedAt?: string;
};

type Movement = {
  id: string; type: 'Masuk' | 'Keluar'; itemId: string; item: string;
  qty: number; unit: string; category: string; occurredAt: string;
};

type LoginOption = { username: string; display_name: string; job_title: string | null };

type AppData = {
  items: Record<Area, Item[]>;
  movements: Record<Area, Movement[]>;
  openings: Record<string, OpeningRecord>;
  reports: Record<string, ClosingRecord>;
};

const shiftOptions: Record<ShiftType, { label: string; hours: string }> = {
  SIANG: { label: 'Shift siang', hours: '11.00–17.00 WIB' },
  MALAM: { label: 'Shift malam', hours: '17.00–23.00 WIB' },
  FULL: { label: 'Full shift', hours: '11.00–23.00 WIB' },
};

const seedItems: Record<Area, Item[]> = {
  BAR: [
    { id: 'bar-01', area: 'BAR', name: 'Sirup Lemon Sunfresh', unit: 'ml', low: 350, opening: 700, incoming: 0, outgoing: 450, closing: 250 },
    { id: 'bar-02', area: 'BAR', name: 'Susu Oat Barista Edition', unit: 'pack', low: 3, opening: 4, incoming: 2, outgoing: 4, closing: 1, varianceReason: 'OVER_PORTIONING', varianceNotes: 'Takaran saji barista baru sedikit berlebih pada latte siang.' },
    { id: 'bar-03', area: 'BAR', name: 'Biji Kopi Arabika House Blend', unit: 'gram', low: 500, opening: 2100, incoming: 0, outgoing: 250, closing: 1850 },
    { id: 'bar-04', area: 'BAR', name: 'Sirup Vanilla Monin', unit: 'ml', low: 200, opening: 300, incoming: 0, outgoing: 300, closing: 0 },
    { id: 'bar-05', area: 'BAR', name: 'Susu Fresh Milk Greenfields', unit: 'pack', low: 5, opening: 10, incoming: 5, outgoing: 8, closing: 7 },
    { id: 'bar-06', area: 'BAR', name: 'Teh Chamomile Dilmah', unit: 'pcs', low: 10, opening: 35, incoming: 0, outgoing: 15, closing: 20 },
    { id: 'bar-07', area: 'BAR', name: 'Bubuk Matcha Uji Premium', unit: 'gram', low: 150, opening: 400, incoming: 0, outgoing: 100, closing: null },
    { id: 'bar-08', area: 'BAR', name: 'Cup Takeaway 16oz + Lid', unit: 'pcs', low: 50, opening: 120, incoming: 50, outgoing: 90, closing: 80 },
  ],
  KITCHEN: [
    { id: 'ktc-01', area: 'KITCHEN', name: 'Daging Ayam Fillet Dada', unit: 'gram', low: 1000, opening: 3500, incoming: 2000, outgoing: 4200, closing: 1300 },
    { id: 'ktc-02', area: 'KITCHEN', name: 'Telur Ayam Negeri', unit: 'pcs', low: 10, opening: 30, incoming: 0, outgoing: 22, closing: 8 },
    { id: 'ktc-03', area: 'KITCHEN', name: 'Minyak Goreng Sawit', unit: 'ml', low: 1500, opening: 4000, incoming: 0, outgoing: 2000, closing: 1500, varianceReason: 'SPILLAGE_UNRECORDED', varianceNotes: 'Tumpahan minyak saat penggantian wajan.' },
    { id: 'ktc-04', area: 'KITCHEN', name: 'Daging Patty Burger Sapi', unit: 'pcs', low: 8, opening: 15, incoming: 0, outgoing: 15, closing: 0 },
    { id: 'ktc-05', area: 'KITCHEN', name: 'Selada Romaine Segar', unit: 'gram', low: 500, opening: 1200, incoming: 0, outgoing: 1000, closing: 200 },
    { id: 'ktc-06', area: 'KITCHEN', name: 'Roti Burger Brioche Bun', unit: 'pcs', low: 10, opening: 20, incoming: 0, outgoing: 14, closing: null },
  ],
};

const seedMovements: Record<Area, Movement[]> = {
  BAR: [
    { id: 'm1', type: 'Keluar', itemId: 'bar-02', item: 'Susu Oat Barista Edition', qty: 4, unit: 'pack', category: 'USAGE', occurredAt: '2026-08-30T07:18:09.000Z' },
    { id: 'm2', type: 'Keluar', itemId: 'bar-01', item: 'Sirup Lemon Sunfresh', qty: 450, unit: 'ml', category: 'USAGE', occurredAt: '2026-08-30T07:04:32.000Z' },
  ],
  KITCHEN: [
    { id: 'm3', type: 'Masuk', itemId: 'ktc-01', item: 'Daging Ayam Fillet Dada', qty: 2000, unit: 'gram', category: 'PURCHASE', occurredAt: '2026-08-30T05:22:18.000Z' },
  ],
};

const initialData: AppData = {
  items: seedItems,
  movements: seedMovements,
  openings: {},
  reports: {},
};

const storageKey = 'hopin-stock-demo-v04';
const assignmentStorageKey = 'hopin-assignment-demo-v01';
const leaseKey = 'hopin-stock-local-lease-v02';
const inactivityMs = 30 * 60 * 1000;
const fmt = (value: number) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(value);
const wibTime = (date = new Date()) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
const wibDate = (date = new Date()) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
const wibDateTime = (iso: string) => `${wibDate(new Date(iso))} · ${wibTime(new Date(iso))} WIB`;
const uid = () => globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const movementCategoryLabel = (category: string) => ({
  PURCHASE: 'Pembelian',
  RETURN_IN: 'Retur masuk',
  TRANSFER_IN: 'Pindahan masuk',
  USAGE: 'Pemakaian',
  INTERNAL: 'Pemakaian internal',
  TRANSFER_OUT: 'Pindahan keluar',
  WASTE: 'Waste',
}[category] ?? category);
const workDateKey = (date = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const assignmentId = (workDate: string, shift: ShiftType, area: Area) => `${workDate}:${shift}:${area}`;
const authEmailFor = (username: string) => `${username.toLowerCase()}@hopin.local`;
const shiftLabel = (shift: ShiftType) => shiftOptions[shift].label;
const areaLabel = (area: Area) => area === 'BAR' ? 'Bar' : 'Kitchen';
const initialsOf = (value: string) => {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'OP';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
};

function statusOf(item: Item): StockStatus {
  if (item.closing === null) return 'Belum diisi';
  if (item.closing <= 0) return 'Habis';
  if (item.closing <= item.low) return 'Hampir habis';
  return 'Aman';
}

function loadData(): AppData {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return structuredClone(initialData);
    const parsed = JSON.parse(raw) as Partial<AppData>;
    if (!parsed.items?.BAR || !parsed.items?.KITCHEN) return structuredClone(initialData);
    return {
      items: parsed.items,
      movements: parsed.movements ?? structuredClone(seedMovements),
      openings: parsed.openings ?? {},
      reports: parsed.reports ?? {},
    };
  } catch {
    return structuredClone(initialData);
  }
}

function loadAssignment(name: string): Assignment | null {
  try {
    const saved = JSON.parse(localStorage.getItem(assignmentStorageKey) || 'null') as Assignment | null;
    return saved?.name === name.trim() && saved.workDate === workDateKey() ? saved : null;
  } catch {
    return null;
  }
}

function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginOptions, setLoginOptions] = useState<LoginOption[]>([]);
  const [authLoading, setAuthLoading] = useState(true);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [selectedShift, setSelectedShift] = useState<ShiftType>('SIANG');
  const [selectedArea, setSelectedArea] = useState<Area>('BAR');
  const [assignmentConfirmOpen, setAssignmentConfirmOpen] = useState(false);
  const [area, setArea] = useState<Area>('BAR');
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<AppData>(loadData);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [clock, setClock] = useState(() => new Date());
  const [syncLabel, setSyncLabel] = useState('Draf di perangkat siap');
  const [saveError, setSaveError] = useState('');
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'Semua' | 'Belum diisi' | 'Berselisih' | 'Kritis'>('Semua');
  const [editingClosingId, setEditingClosingId] = useState<string | null>(null);
  const [movementOpen, setMovementOpen] = useState(false);
  const [movementType, setMovementType] = useState<'Masuk' | 'Keluar'>('Masuk');
  const [movementItem, setMovementItem] = useState('');
  const [movementQty, setMovementQty] = useState('');
  const [movementCategory, setMovementCategory] = useState('PURCHASE');
  const tabId = useRef(sessionStorage.getItem('hopin-tab-id') || uid());
  const toastTimer = useRef<number | undefined>(undefined);

  const current = data.items[area];
  const activeOpening = assignment ? data.openings[assignment.id] : undefined;
  const activeReport = assignment ? data.reports[assignment.id] : undefined;
  const isSubmitted = activeReport?.status === 'SENT' || activeReport?.status === 'APPROVED' || activeReport?.status === 'NEEDS_CLARIFICATION';
  const systemBalance = (item: Item) => {
    const openingCount = activeOpening?.counts[item.id];
    const openingValue = openingCount !== null && openingCount !== undefined ? openingCount : item.opening;
    return openingValue + item.incoming - item.outgoing;
  };

  const stats = useMemo(() => {
    const status = current.map(statusOf);
    return {
      total: current.length,
      filled: status.filter((value) => value !== 'Belum diisi').length,
      low: status.filter((value) => value === 'Hampir habis').length,
      empty: status.filter((value) => value === 'Habis').length,
      variance: current.filter((item) => item.closing !== null && item.closing !== systemBalance(item)).length,
    };
  }, [current, activeOpening]);
  const openingConfirmed = Boolean(activeOpening?.confirmedAt);
  const closingAvailable = assignment?.shift === 'MALAM' || assignment?.shift === 'FULL';

  const filtered = current.filter((item) => {
    const queryMatches = item.name.toLowerCase().includes(search.trim().toLowerCase());
    const status = statusOf(item);
    const hasVariance = item.closing !== null && item.closing !== systemBalance(item);
    const keepsActiveEdit = item.id === editingClosingId;
    return queryMatches && (filter === 'Semua' || keepsActiveEdit
      || (filter === 'Belum diisi' && status === 'Belum diisi')
      || (filter === 'Berselisih' && hasVariance)
      || (filter === 'Kritis' && (status === 'Hampir habis' || status === 'Habis')));
  });

  useEffect(() => {
    const client = supabase;
    if (!client) {
      setAuthLoading(false);
      return;
    }
    let mounted = true;
    const loadAuth = async () => {
      const [{ data: sessionData }, { data: options, error }] = await Promise.all([
        client.auth.getSession(),
        client.rpc('get_login_options'),
      ]);
      if (!mounted) return;
      if (error) setLoginError('Daftar user belum bisa dimuat. Periksa migration Supabase.');
      setLoginOptions((options ?? []) as LoginOption[]);
      const session = sessionData.session;
      if (session) {
        const sessionUsername = session.user.user_metadata?.username ?? session.user.email?.split('@')[0] ?? '';
        setUsername(sessionUsername.toLowerCase());
        setName(String(session.user.user_metadata?.display_name ?? sessionUsername).toUpperCase());
        setLoggedIn(true);
      }
      setAuthLoading(false);
    };
    void loadAuth();
    const { data: authState } = client.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      if (!session) {
        setLoggedIn(false);
        setAssignment(null);
        return;
      }
      const sessionUsername = session.user.user_metadata?.username ?? session.user.email?.split('@')[0] ?? '';
      setUsername(sessionUsername.toLowerCase());
      setName(String(session.user.user_metadata?.display_name ?? sessionUsername).toUpperCase());
      setLoggedIn(true);
    });
    return () => {
      mounted = false;
      authState.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    sessionStorage.setItem('hopin-tab-id', tabId.current);
    const id = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setSyncLabel('Menyimpan...');
    try {
      localStorage.setItem(storageKey, JSON.stringify(data));
      setSaveError('');
      setSyncLabel(online ? `Tersimpan di perangkat · ${wibTime()}` : 'Tersimpan di perangkat · menunggu koneksi');
    } catch {
      setSaveError('Penyimpanan perangkat bermasalah. Jangan tutup halaman ini dulu.');
      setSyncLabel('Belum tersimpan di perangkat');
    }
  }, [data, online]);

  useEffect(() => {
    const handleOnline = () => { setOnline(true); showToast('Koneksi kembali. Draf di perangkat tetap aman.'); };
    const handleOffline = () => { setOnline(false); showToast('Koneksi terputus. Input tetap tersimpan di perangkat ini.'); };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); };
  }, []);

  useEffect(() => {
    if (!loggedIn) return;
    let idleTimer = window.setTimeout(handleLogout, inactivityMs);
    const refreshLease = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(handleLogout, inactivityMs);
      localStorage.setItem(leaseKey, JSON.stringify({ tabId: tabId.current, name, activeAt: Date.now() }));
    };
    const activityEvents: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart'];
    activityEvents.forEach((event) => window.addEventListener(event, refreshLease, { passive: true }));
    const heartbeat = window.setInterval(refreshLease, 30_000);
    refreshLease();
    return () => {
      activityEvents.forEach((event) => window.removeEventListener(event, refreshLease));
      window.clearInterval(heartbeat);
      window.clearTimeout(idleTimer);
    };
  }, [loggedIn, name]);

  function showToast(message: string) {
    window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(''), 3600);
  }

  async function handleLogin() {
    setLoginError('');
    if (!supabaseConfigured || !supabase) { setLoginError('Supabase belum dikonfigurasi. Tambahkan environment variables dulu.'); return; }
    if (!username) { setLoginError('Pilih nama user dulu.'); return; }
    if (pin.length < 6) { setLoginError('PIN harus terdiri dari minimal 6 digit.'); return; }
    try {
      const lease = JSON.parse(localStorage.getItem(leaseKey) || 'null') as { tabId: string; activeAt: number } | null;
      if (lease && lease.tabId !== tabId.current && Date.now() - lease.activeAt < inactivityMs) {
        setLoginError('Sesi masih aktif di tab lain. Keluar dari sana atau tunggu 30 menit.');
        return;
      }
    } catch { /* local lease is only a demo convenience */ }
    setAuthLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: authEmailFor(username), password: pin });
    if (error) {
      setAuthLoading(false);
      setLoginError('Nama user atau PIN salah.');
      return;
    }
    const selected = loginOptions.find((option) => option.username === username);
    const displayName = selected?.display_name ?? username.toUpperCase();
    try { localStorage.setItem(leaseKey, JSON.stringify({ tabId: tabId.current, name: displayName, activeAt: Date.now() })); } catch { /* local lease is only a demo convenience */ }
    const savedAssignment = loadAssignment(displayName);
    setAssignment(savedAssignment);
    if (savedAssignment) {
      setArea(savedAssignment.area);
      setTab('overview');
    }
    setName(displayName);
    setPin('');
    setAuthLoading(false);
    setLoggedIn(true);
  }

  function confirmAssignment() {
    const workDate = workDateKey();
    const id = assignmentId(workDate, selectedShift, selectedArea);
    const existing = data.openings[id];
    const sourceItems = data.items[selectedArea];
    const reference = existing?.reference ?? Object.fromEntries(sourceItems.map((item) => [item.id, item.opening + item.incoming - item.outgoing]));
    const counts = existing?.counts ?? Object.fromEntries(sourceItems.map((item) => [item.id, item.closing]));
    const record: OpeningRecord = existing ?? { reference, counts, reasons: {}, notes: {} };
    const nextAssignment: Assignment = { id, workDate, shift: selectedShift, area: selectedArea, name: name.trim(), confirmedAt: new Date().toISOString() };
    try { localStorage.setItem(assignmentStorageKey, JSON.stringify(nextAssignment)); } catch { /* local assignment is only a demo convenience */ }
    setData((previous) => ({
      ...previous,
      openings: { ...previous.openings, [id]: record },
      items: existing ? previous.items : { ...previous.items, [selectedArea]: sourceItems.map((item) => ({ ...item, closing: null, incoming: 0, outgoing: 0, updatedAt: undefined })) },
      movements: existing ? previous.movements : { ...previous.movements, [selectedArea]: [] },
    }));
    setAssignment(nextAssignment);
    setArea(selectedArea);
    setTab('opening');
    setAssignmentConfirmOpen(false);
  }

  async function handleLogout() {
    try { await supabase?.auth.signOut(); } catch { /* return to login even if auth is unavailable */ }
    try {
      const lease = JSON.parse(localStorage.getItem(leaseKey) || 'null') as { tabId: string } | null;
      if (lease?.tabId === tabId.current) localStorage.removeItem(leaseKey);
    } catch { /* return to login even if local storage is unavailable */ }
    setLoggedIn(false);
    setAssignment(null);
    setUsername('');
    setPin('');
  }

  function switchArea(nextArea: Area) {
    setArea(nextArea); setTab('overview'); setSearch(''); setFilter('Semua');
    setEditingClosingId(null);
    setMovementItem(''); setMovementQty('');
  }

  function goTab(next: Tab) {
    if (next !== 'closing') setEditingClosingId(null);
    if (next === 'movement' && !openingConfirmed) {
      setTab('opening');
      showToast('Konfirmasi stok awal dulu sebelum mencatat perubahan.');
      return;
    }
    if (next === 'closing' && !closingAvailable) {
      showToast('Closing akhir dilakukan pada shift malam.');
      return;
    }
    if (next === 'closing' && !openingConfirmed) {
      setTab('opening');
      showToast('Konfirmasi stok awal dulu sebelum mengisi closing.');
      return;
    }
    setTab(next);
  }

  function updateItem(id: string, patch: Partial<Item>) {
    const updatedAt = new Date().toISOString();
    setData((previous) => ({ ...previous, items: { ...previous.items, [area]: previous.items[area].map((item) => item.id === id ? { ...item, ...patch, updatedAt } : item) } }));
  }

  function updateClosing(id: string, value: string) {
    const parsed = value === '' ? null : Math.max(0, Number(value));
    updateItem(id, { closing: parsed !== null && Number.isFinite(parsed) ? parsed : null });
  }

  function updateOpening(id: string, value: string) {
    if (!assignment || openingConfirmed) return;
    const parsed = value === '' ? null : Math.max(0, Number(value));
    setData((previous) => {
      const record = previous.openings[assignment.id];
      if (!record) return previous;
      return { ...previous, openings: { ...previous.openings, [assignment.id]: { ...record, counts: { ...record.counts, [id]: parsed !== null && Number.isFinite(parsed) ? parsed : null } } } };
    });
  }

  function updateOpeningMeta(id: string, field: 'reason' | 'note', value: string) {
    if (!assignment || openingConfirmed) return;
    setData((previous) => {
      const record = previous.openings[assignment.id];
      if (!record) return previous;
      const key = field === 'reason' ? 'reasons' : 'notes';
      return { ...previous, openings: { ...previous.openings, [assignment.id]: { ...record, [key]: { ...record[key], [id]: value } } } };
    });
  }

  function confirmOpening() {
    if (!assignment || !activeOpening) return;
    const missing = current.find((item) => activeOpening.counts[item.id] === null || activeOpening.counts[item.id] === undefined);
    if (missing) { showToast(`${missing.name} belum diisi pada stok awal.`); return; }
    const missingReason = current.find((item) => {
      const count = activeOpening.counts[item.id] ?? 0;
      return count !== activeOpening.reference[item.id] && (!activeOpening.reasons[item.id] || !activeOpening.notes[item.id]?.trim());
    });
    if (missingReason) { showToast(`Tambahkan alasan selisih stok awal untuk ${missingReason.name}.`); return; }
    const confirmedAt = new Date().toISOString();
    setData((previous) => ({
      ...previous,
      openings: { ...previous.openings, [assignment.id]: { ...activeOpening, confirmedAt } },
      items: { ...previous.items, [area]: previous.items[area].map((item) => ({ ...item, opening: activeOpening.counts[item.id] ?? item.opening, incoming: 0, outgoing: 0, closing: null, updatedAt: confirmedAt })) },
    }));
    setTab('movement');
    showToast(`Stok awal ${areaLabel(area)} dikonfirmasi · ${wibDateTime(confirmedAt)}`);
  }

  function addMovement() {
    if (!openingConfirmed) { showToast('Konfirmasi stok awal dulu sebelum mencatat perubahan.'); return; }
    if (isSubmitted) { showToast('Laporan area ini sudah dikirim. Catatan baru tidak bisa ditambahkan.'); return; }
    const selected = current.find((item) => item.id === movementItem) ?? current[0];
    const qty = Number(movementQty);
    if (!selected || !Number.isFinite(qty) || qty <= 0) { showToast('Pilih item dan isi jumlah di atas 0.'); return; }
    const movement: Movement = { id: uid(), type: movementType, itemId: selected.id, item: selected.name, qty, unit: selected.unit, category: movementCategory, occurredAt: new Date().toISOString() };
    setData((previous) => ({
      ...previous,
      movements: { ...previous.movements, [area]: [movement, ...previous.movements[area]] },
      items: { ...previous.items, [area]: previous.items[area].map((item) => item.id === selected.id ? { ...item, incoming: item.incoming + (movementType === 'Masuk' ? qty : 0), outgoing: item.outgoing + (movementType === 'Keluar' ? qty : 0), updatedAt: movement.occurredAt } : item) },
    }));
    setMovementQty(''); setMovementOpen(false);
    showToast(`${movementType} tersimpan di ledger ${area === 'BAR' ? 'Bar' : 'Kitchen'} · ${wibTime()} WIB`);
  }

  function submitReport() {
    if (!assignment || !closingAvailable) { showToast('Closing akhir hanya dikirim dari shift malam atau full shift.'); return; }
    if (!openingConfirmed) { setTab('opening'); showToast('Konfirmasi stok awal dulu sebelum mengirim closing.'); return; }
    if (stats.filled < stats.total) {
      setTab('closing'); setFilter('Belum diisi');
      showToast(`${stats.total - stats.filled} item belum diisi. Pengiriman masih dikunci.`);
      return;
    }
    const missingReason = current.find((item) => {
      const variance = item.closing !== null && item.closing !== systemBalance(item);
      return variance && (!item.varianceReason || !item.varianceNotes?.trim());
    });
    if (missingReason) {
      setTab('closing'); setFilter('Berselisih');
      showToast(`Tambahkan alasan selisih untuk ${missingReason.name}.`);
      return;
    }
    const submittedAt = new Date().toISOString();
    const revision = (activeReport?.revision ?? 0) + 1;
    setData((previous) => ({ ...previous, reports: { ...previous.reports, [assignment.id]: { status: 'SENT', submittedAt, revision } } }));
    showToast(`Laporan ${areaLabel(area)} terkirim ke supervisor · ${wibDateTime(submittedAt)}`);
  }

  async function copyReport() {
    const text = createReportText(area, current, isSubmitted, activeReport?.submittedAt, assignment?.shift);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      showToast('Ringkasan sudah disalin. Tinggal tempel ke WhatsApp.');
    } catch { showToast('Browser tidak mengizinkan salin otomatis. Salin dari contoh pesan.'); }
  }

  if (!loggedIn) return <Login username={username} setUsername={setUsername} pin={pin} setPin={setPin} options={loginOptions} loading={authLoading} configured={supabaseConfigured} error={loginError} onLogin={handleLogin} />;
  if (!assignment) return <AssignmentPicker name={name} selectedShift={selectedShift} setSelectedShift={setSelectedShift} selectedArea={selectedArea} setSelectedArea={setSelectedArea} confirmOpen={assignmentConfirmOpen} setConfirmOpen={setAssignmentConfirmOpen} onConfirm={confirmAssignment} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span><strong>HOPIN</strong><small>CAFE OPERATIONS</small></span></div>
        <div className="topbar-right"><div className={`connection ${online ? 'is-online' : 'is-offline'}`}><span className="dot" />{online ? 'Terhubung' : 'Offline'}</div><div className="clock"><span className="clock-date">{wibDate(clock)}</span><strong>{wibTime(clock)} <i>WIB</i></strong></div><button className="avatar" onClick={handleLogout} aria-label="Keluar dari aplikasi" title="Keluar">{initialsOf(name)}</button></div>
      </header>
      {saveError && <div className="save-error" role="alert">{saveError}</div>}
      <main className="workspace">
        <section className="welcome"><div><p className="eyebrow">{shiftLabel(assignment.shift)} · {shiftOptions[assignment.shift].hours}</p><h1>Halo, {name}.</h1><p className="muted">Catat perubahan stok saat terjadi. {closingAvailable ? 'Tutup shift dengan angka yang bisa dicek.' : 'Closing akhir dilakukan pada shift malam.'}</p></div><div className="save-state"><span className="save-icon">↻</span><span><strong>Tersimpan otomatis di perangkat</strong><small>{syncLabel}</small></span></div></section>
        <section className="area-switch locked" aria-label="Penugasan area terkunci"><div className="switch-label"><span className="eyebrow">AREA TERKUNCI</span><strong>{areaLabel(area)}</strong></div><div className="area-button selected" aria-current="true"><span className="area-symbol">{area === 'BAR' ? '◒' : '⌁'}</span><span><strong>{areaLabel(area)}</strong><small>{shiftLabel(assignment.shift)}</small></span><span className="check">Terkunci</span></div></section>
        <nav className="tabs" aria-label="Navigasi operasi">{([['overview', 'Ringkasan'], ['opening', 'Stok awal'], ['movement', 'Perubahan'], ...(closingAvailable ? [['closing', 'Stok akhir'] as [Tab, string]] : []), ['reports', 'Laporan']] as [Tab, string][]).map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} aria-current={tab === key ? 'page' : undefined} disabled={key === 'movement' && !openingConfirmed} onClick={() => goTab(key)}>{label}{key === 'closing' && stats.filled < stats.total && <span className="tab-count">{stats.total - stats.filled}</span>}</button>)}</nav>
        {tab === 'overview' && <Overview area={area} shift={assignment.shift} stats={stats} items={current} submitted={isSubmitted} openingConfirmed={openingConfirmed} onTab={goTab} />}
        {tab === 'opening' && <Opening area={area} shift={assignment.shift} items={current} opening={activeOpening} updateOpening={updateOpening} updateOpeningMeta={updateOpeningMeta} onConfirm={confirmOpening} onTab={goTab} />}
        {tab === 'movement' && <MovementView area={area} shift={assignment.shift} movements={data.movements[area]} submitted={isSubmitted} openingConfirmed={openingConfirmed} onAdd={() => { setMovementItem(current[0]?.id ?? ''); setMovementOpen(true); }} />}
        {tab === 'closing' && closingAvailable && <Closing items={filtered} baseline={activeOpening ? current : current} stats={stats} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} updateItem={updateItem} updateClosing={updateClosing} setEditingClosingId={setEditingClosingId} submitted={isSubmitted} submittedAt={activeReport?.submittedAt} onSubmit={submitReport} />}
        {tab === 'reports' && <Reports area={area} shift={assignment.shift} items={current} submitted={isSubmitted} submittedAt={activeReport?.submittedAt} financeReady={Boolean(data.reports[`${assignment.workDate}:${assignment.shift}:BAR`]?.status === 'SENT' && data.reports[`${assignment.workDate}:${assignment.shift}:KITCHEN`]?.status === 'SENT')} onCopy={copyReport} />}
      </main>
      <footer className="footer"><span>v0.3 · Demo lokal · 1 outlet</span><span>Draf dipulihkan dari perangkat ini</span></footer>
      {movementOpen && <MovementModal area={area} items={current} type={movementType} setType={setMovementType} item={movementItem} setItem={setMovementItem} qty={movementQty} setQty={setMovementQty} category={movementCategory} setCategory={setMovementCategory} onClose={() => setMovementOpen(false)} onSave={addMovement} />}
      <div className="live-region" role="status" aria-live="polite">{toast}</div>
    </div>
  );
}

function AssignmentPicker({ name, selectedShift, setSelectedShift, selectedArea, setSelectedArea, confirmOpen, setConfirmOpen, onConfirm }: { name: string; selectedShift: ShiftType; setSelectedShift: (value: ShiftType) => void; selectedArea: Area; setSelectedArea: (value: Area) => void; confirmOpen: boolean; setConfirmOpen: (value: boolean) => void; onConfirm: () => void }) {
  return <div className="assignment-page"><section className="assignment-card"><p className="eyebrow">PENUGASAN HARI INI</p><h1>Mulai dengan pilihan yang tepat.</h1><p className="muted">Pilih shift dan area kerja. Pilihan ini akan terkunci setelah Anda mulai.</p><div className="assignment-group"><span className="assignment-label">Shift</span><div className="assignment-options">{(Object.keys(shiftOptions) as ShiftType[]).map((value) => <button key={value} className={selectedShift === value ? 'selected' : ''} aria-pressed={selectedShift === value} onClick={() => setSelectedShift(value)}><strong>{shiftOptions[value].label}</strong><small>{shiftOptions[value].hours}</small></button>)}</div></div><div className="assignment-group"><span className="assignment-label">Area kerja</span><div className="assignment-options area-options">{(['BAR', 'KITCHEN'] as Area[]).map((value) => <button key={value} className={selectedArea === value ? 'selected' : ''} aria-pressed={selectedArea === value} onClick={() => setSelectedArea(value)}><strong>{areaLabel(value)}</strong><small>{value === 'BAR' ? 'Kasir dan stok bar' : 'Stok bahan dan kitchen'}</small></button>)}</div></div><div className="assignment-summary"><span>Penugasan Anda</span><strong>{shiftLabel(selectedShift)} · {areaLabel(selectedArea)}</strong><small>{wibDate()} · {shiftOptions[selectedShift].hours}</small></div><button className="primary-button assignment-start" onClick={() => setConfirmOpen(true)}>Lanjutkan <span>→</span></button>{confirmOpen && <AssignmentConfirm shift={selectedShift} area={selectedArea} onCancel={() => setConfirmOpen(false)} onConfirm={onConfirm} />}</section></div>;
}

function AssignmentConfirm({ shift, area, onCancel, onConfirm }: { shift: ShiftType; area: Area; onCancel: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation"><div className="modal assignment-confirm" role="dialog" aria-modal="true" aria-labelledby="assignment-confirm-title"><div className="modal-head"><div><p className="eyebrow">KONFIRMASI PENUGASAN</p><h2 id="assignment-confirm-title">Pastikan pilihan Anda.</h2></div></div><p className="muted">Anda akan masuk ke <strong>{shiftLabel(shift)}</strong>, area <strong>{areaLabel(area)}</strong>, tanggal <strong>{wibDate()}</strong>.</p><div className="assignment-warning"><strong>Setelah dimulai, shift dan area tidak dapat diganti dari akun ini.</strong><span>Logout tidak menghapus penugasan. Jika salah, hubungi supervisor untuk reset.</span></div><div className="modal-actions"><button className="outline-button" onClick={onCancel}>Kembali</button><button className="primary-button" onClick={onConfirm}>Mulai shift <span>→</span></button></div></div></div>;
}

function Login({ username, setUsername, pin, setPin, options, loading, configured, error, onLogin }: { username: string; setUsername: (value: string) => void; pin: string; setPin: (value: string) => void; options: LoginOption[]; loading: boolean; configured: boolean; error: string; onLogin: () => void | Promise<void> }) {
  const [showPin, setShowPin] = useState(false);
  return <div className="login-page"><div className="login-panel"><div className="login-brand"><div><strong>HOPIN</strong><small>CAFE OPERATIONS</small></div></div><div className="login-copy"><p className="eyebrow">STOK HARI INI · {configured ? 'LOGIN USER' : 'KONFIGURASI DIPERLUKAN'}</p><h1>Mulai shift tanpa<br /><em>catatan tercecer.</em></h1><p>Catat stok Bar dan Kitchen di satu tempat. Draf tersimpan otomatis saat halaman dimuat ulang.</p></div><form noValidate onSubmit={(event) => { event.preventDefault(); void onLogin(); }}><label>Nama user<select autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} disabled={loading || !configured}><option value="">Pilih user...</option>{options.map((option) => <option key={option.username} value={option.username}>{option.display_name}{option.job_title ? ` · ${option.job_title}` : ''}</option>)}</select></label><label>PIN<span className="password-field"><input type={showPin ? 'text' : 'password'} autoComplete="current-password" inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="••••••" disabled={loading || !configured} /><button type="button" onClick={() => setShowPin((shown) => !shown)} aria-label={showPin ? 'Sembunyikan PIN' : 'Tampilkan PIN'}>{showPin ? 'Sembunyikan' : 'Tampilkan'}</button></span></label>{error && <p className="form-error" role="alert">{error}</p>}{configured && options.length === 0 && <p className="form-error" role="status">Belum ada user aktif di Supabase.</p>}<button className="primary-button" type="submit" disabled={loading || !configured || !username || pin.length < 6}>{loading ? 'Memuat...' : 'Masuk ke aplikasi'} <span>→</span></button></form><p className="demo-hint">Login memakai user terdaftar · PIN 6 digit · logout otomatis setelah 30 menit tanpa aktivitas</p></div><div className="login-aside"><div className="aside-stamp">OPS<br /><small>STOCK<br />V0.3</small></div><p className="eyebrow">OPERASIONAL HARI INI</p><h2>Semua stok tercatat.<br />Perubahan terakhir<br /><em>tetap tersimpan.</em></h2><div className="aside-line" /><p>Jam mengikuti WIB<br />dan diperbarui setiap detik.</p></div></div>;
}

function Overview({ area, shift, stats, items, submitted, openingConfirmed, onTab }: { area: Area; shift: ShiftType; stats: { total: number; filled: number; low: number; empty: number; variance: number }; items: Item[]; submitted: boolean; openingConfirmed: boolean; onTab: (tab: Tab) => void }) {
  const percentage = Math.round((stats.filled / stats.total) * 100);
  const shiftHours = shiftOptions[shift].hours.replace(' WIB', '').split('–');
  const nextTab: Tab = !openingConfirmed ? 'opening' : shift === 'SIANG' ? 'movement' : 'closing';
  return <div className="content-grid"><div className="main-column"><section className="hero-card"><div><p className="eyebrow">{submitted ? 'LAPORAN TERKIRIM · REVISI 01' : 'SHIFT SEDANG BERJALAN'}</p><h2>{areaLabel(area)} <span>·</span> {shiftLabel(shift)}</h2><p className="muted">{openingConfirmed ? 'Catat perubahan stok saat terjadi.' : 'Selesaikan stok awal sebelum mulai mencatat perubahan.'}</p></div><div className="hero-progress"><div className="progress-ring" style={{ '--progress': `${percentage}%` } as React.CSSProperties}><strong>{percentage}<small>%</small></strong></div><span>stok akhir terisi</span></div></section><section className="metric-row"><Metric label="Item terisi" value={`${stats.filled}/${stats.total}`} hint={stats.filled === stats.total ? 'Siap dikirim' : 'Masih ada yang kosong'} tone={stats.filled === stats.total ? 'good' : 'warn'} /><Metric label="Hampir habis" value={String(stats.low)} hint="Perlu dicek" tone="warn" /><Metric label="Habis" value={String(stats.empty)} hint="Perlu diisi ulang" tone="danger" /><Metric label="Berselisih" value={String(stats.variance)} hint="Perlu keterangan" tone="neutral" /></section><section className="section-card"><div className="section-heading"><div><p className="eyebrow">CEK CEPAT</p><h3>Perlu dicek</h3></div><button className="text-button" onClick={() => onTab(nextTab)}>{openingConfirmed ? shift === 'SIANG' ? 'Buka perubahan' : 'Buka stok akhir' : 'Isi stok awal'} <span>→</span></button></div><div className="attention-list">{items.filter((item) => statusOf(item) !== 'Aman').slice(0, 4).map((item) => <AttentionItem key={item.id} item={item} />)}{items.every((item) => statusOf(item) === 'Aman') && <div className="empty-state">Semua stok dalam kondisi aman. ✦</div>}</div></section></div><aside className="side-column"><section className="side-card shift-card"><p className="eyebrow">DETAIL SHIFT</p><div className="shift-time"><strong>{shiftHours[0]}</strong><span>–</span><strong>{shiftHours[1]}</strong></div><div className="shift-meta"><span><i className="green-dot" />Sedang berjalan</span><span>{wibDate()}</span></div><div className="thin-rule" /><dl><div><dt>Area</dt><dd>{areaLabel(area)}</dd></div><div><dt>Peran</dt><dd>PIC {areaLabel(area)}</dd></div><div><dt>Status</dt><dd>{submitted ? 'Terkirim · 01' : openingConfirmed ? 'Draf · 01' : 'Opening belum dikonfirmasi'}</dd></div></dl></section><section className="side-card action-card"><p className="eyebrow">LANGKAH BERIKUT</p><h3>{!openingConfirmed ? 'Konfirmasi stok awal' : shift === 'SIANG' ? 'Catat perubahan stok' : stats.filled < stats.total ? 'Lengkapi stok akhir' : 'Periksa dan kirim'}</h3><p>{!openingConfirmed ? 'Hitung semua item lalu konfirmasi angka awal.' : shift === 'SIANG' ? 'Catat barang masuk atau pemakaian saat terjadi.' : stats.filled < stats.total ? `${stats.total - stats.filled} item belum dihitung.` : 'Semua item sudah diisi. Periksa keterangan untuk setiap selisih.'}</p><button className="primary-button small" onClick={() => onTab(nextTab)}>{!openingConfirmed ? 'Isi stok awal' : shift === 'SIANG' ? 'Buka perubahan' : stats.filled < stats.total ? 'Isi stok akhir' : 'Periksa laporan'} <span>→</span></button></section></aside></div>;
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: string }) { return <div className={`metric ${tone}`}><span className="metric-label">{label}</span><strong>{value}</strong><small>{hint}</small></div>; }
function StatusMark({ status }: { status: StockStatus }) { const tone = status === 'Habis' ? 'danger' : status === 'Hampir habis' || status === 'Belum diisi' ? 'warning' : 'success'; const glyph = status === 'Habis' ? '!' : status === 'Hampir habis' ? '~' : status === 'Belum diisi' ? '·' : '✓'; return <span className={`status-mark ${tone}`} aria-label={status}>{glyph}</span>; }
function AttentionItem({ item }: { item: Item }) { const status = statusOf(item); return <div className="attention-item"><StatusMark status={status} /><div><strong>{item.name}</strong><small>{item.closing === null ? 'Belum diisi' : `${fmt(item.closing)} ${item.unit}`} · {status}</small></div><span className="chevron">›</span></div>; }

function Opening({ area, shift, items, opening, updateOpening, updateOpeningMeta, onConfirm, onTab }: { area: Area; shift: ShiftType; items: Item[]; opening?: OpeningRecord; updateOpening: (id: string, value: string) => void; updateOpeningMeta: (id: string, field: 'reason' | 'note', value: string) => void; onConfirm: () => void; onTab: (tab: Tab) => void }) {
  const confirmed = Boolean(opening?.confirmedAt);
  const complete = Boolean(opening) && items.every((item) => opening?.counts[item.id] !== null && opening?.counts[item.id] !== undefined);
  const hasMissingReason = Boolean(opening) && items.some((item) => {
    const count = opening?.counts[item.id];
    return count !== null && count !== undefined && count !== opening?.reference[item.id] && (!opening?.reasons[item.id] || !opening?.notes[item.id]?.trim());
  });
  return <div className="content-grid"><div className="main-column"><section className="section-card opening-intro"><p className="eyebrow">STOK AWAL · {areaLabel(area)}</p><h2>{shiftLabel(shift)} dimulai di sini</h2><p className="muted">Bandingkan angka fisik dengan saldo referensi sebelum mencatat aktivitas shift.</p><div className="opening-callout"><span className="callout-icon">↗</span><div><strong>{confirmed ? 'Stok awal sudah dikonfirmasi' : 'Konfirmasi stok awal sebelum mulai'}</strong><p>{confirmed ? `Dikonfirmasi ${wibDateTime(opening?.confirmedAt ?? new Date().toISOString())}. Angka ini menjadi patokan shift.` : 'Isi semua item. Jika ada selisih, pilih alasan dan tulis catatan singkat.'}</p></div></div></section><section className="section-card"><div className="section-heading"><div><p className="eyebrow">REFERENSI STOK</p><h3>{items.length} item</h3></div><span className="tag neutral">{confirmed ? 'Terkunci' : 'Belum dikonfirmasi'}</span></div><div className="opening-table"><div className="table-head"><span>Item</span><span>Referensi</span><span>Hitungan awal</span></div>{items.map((item) => { const reference = opening?.reference[item.id] ?? item.opening; const count = opening?.counts[item.id] ?? null; const variance = count === null ? null : count - reference; return <div className={`table-row opening-row ${variance !== null && variance !== 0 ? 'has-variance' : ''}`} key={item.id}><span><strong>{item.name}</strong><small>Mulai menipis di: {fmt(item.low)} {item.unit}</small>{variance !== null && variance !== 0 && <span className="opening-variance">Selisih {variance > 0 ? '+' : ''}{fmt(variance)} {item.unit}</span>}</span><span><span className="unit-pill">{fmt(reference)} {item.unit}</span></span><label className="opening-input"><span className="sr-only">Hitungan awal {item.name}</span><input aria-label={`Hitungan awal ${item.name}`} type="number" min="0" step={item.unit === 'pcs' || item.unit === 'pack' ? '1' : '0.01'} value={count ?? ''} onChange={(event) => updateOpening(item.id, event.target.value)} disabled={confirmed} placeholder="0" /><em>{item.unit}</em></label>{variance !== null && variance !== 0 && <div className="opening-reason"><label>Alasan selisih<select aria-label={`Alasan selisih ${item.name}`} value={opening?.reasons[item.id] ?? ''} onChange={(event) => updateOpeningMeta(item.id, 'reason', event.target.value)} disabled={confirmed}><option value="">Pilih alasan...</option><option value="COUNTING_ERROR">Salah hitung</option><option value="DELIVERY_MISMATCH">Jumlah kiriman berbeda</option><option value="WASTE_UNRECORDED">Waste belum tercatat</option><option value="OTHER">Lainnya</option></select></label><label>Catatan<textarea aria-label={`Catatan selisih ${item.name}`} value={opening?.notes[item.id] ?? ''} onChange={(event) => updateOpeningMeta(item.id, 'note', event.target.value)} disabled={confirmed} placeholder="Tulis penyebabnya supaya mudah dicek" /></label></div>}</div>; })}</div></section><div className="opening-submit"><div><strong>{confirmed ? 'Opening terkunci' : complete && !hasMissingReason ? 'Siap dikonfirmasi' : 'Opening belum lengkap'}</strong><span>{confirmed ? 'Perubahan stok dapat dicatat.' : !complete ? 'Semua item harus diisi.' : hasMissingReason ? 'Lengkapi alasan dan catatan untuk setiap selisih.' : 'Setelah dikonfirmasi, angka awal tidak dapat diedit.'}</span></div><button className="primary-button" disabled={confirmed || !complete || hasMissingReason} onClick={onConfirm}>{confirmed ? 'Sudah dikonfirmasi' : 'Konfirmasi stok awal'} <span>→</span></button></div></div><aside className="side-column"><section className="side-card action-card"><p className="eyebrow">SETELAH OPENING</p><h3>Catat perubahan</h3><p>{confirmed ? 'Catat barang masuk, pemakaian, pindahan, atau waste saat terjadi.' : 'Perubahan stok terbuka setelah Opening dikonfirmasi.'}</p><button className="primary-button small" disabled={!confirmed} onClick={() => onTab('movement')}>Buka perubahan <span>→</span></button></section></aside></div>;
}

function MovementView({ area, shift, movements, submitted, openingConfirmed, onAdd }: { area: Area; shift: ShiftType; movements: Movement[]; submitted: boolean; openingConfirmed: boolean; onAdd: () => void }) {
  return <div className="content-grid"><div className="main-column"><section className="section-card"><div className="section-heading"><div><p className="eyebrow">PERUBAHAN STOK · {areaLabel(area)}</p><h2>{shiftLabel(shift)}: perubahan stok</h2><p className="muted">Setiap catatan masuk ke riwayat dan tersimpan di perangkat ini.</p></div><button className="primary-button small" disabled={submitted || !openingConfirmed} onClick={onAdd}>+ Catat perubahan</button></div><div className="ledger-list">{movements.map((movement) => <div className="ledger-row" key={movement.id}><span className={`movement-icon ${movement.type === 'Masuk' ? 'in' : 'out'}`}>{movement.type === 'Masuk' ? '↑' : '↓'}</span><div><strong>{movement.item}</strong><small>{movementCategoryLabel(movement.category)} · {wibDateTime(movement.occurredAt)}</small></div><span className={`movement-qty ${movement.type === 'Masuk' ? 'positive' : 'negative'}`}>{movement.type === 'Masuk' ? '+' : '−'}{fmt(movement.qty)} {movement.unit}</span></div>)}</div>{movements.length === 0 && <div className="empty-state">Belum ada perubahan di shift ini.</div>}</section></div><aside className="side-column"><section className="side-card ledger-note"><p className="eyebrow">CARA MENCATAT</p><h3>Catat saat terjadi.</h3><p>Pilih <strong>Masuk</strong> untuk barang datang atau pindahan. Pilih <strong>Keluar</strong> untuk pemakaian atau waste. Catatan yang sudah disimpan tidak bisa diedit atau dihapus.</p><div className="rule-row"><span>Sisa menurut catatan</span><strong>Dihitung otomatis</strong></div></section></aside></div>;
}

function Closing({ items, baseline, stats, filter, setFilter, search, setSearch, updateItem, updateClosing, setEditingClosingId, submitted, submittedAt, onSubmit }: { items: Item[]; baseline: Item[]; stats: { total: number; filled: number; low: number; empty: number; variance: number }; filter: 'Semua' | 'Belum diisi' | 'Berselisih' | 'Kritis'; setFilter: (value: 'Semua' | 'Belum diisi' | 'Berselisih' | 'Kritis') => void; search: string; setSearch: (value: string) => void; updateItem: (id: string, patch: Partial<Item>) => void; updateClosing: (id: string, value: string) => void; setEditingClosingId: (id: string | null) => void; submitted: boolean; submittedAt?: string; onSubmit: () => void }) {
  const percentage = Math.round((stats.filled / stats.total) * 100);
  return <div className="closing-page"><section className="closing-header"><div><p className="eyebrow">STOK AKHIR · HITUNG FISIK</p><h2>Hitung stok akhir dengan teliti.</h2><p className="muted">Isi semua item. Status dan selisih akan dihitung dari stok awal saat pengecekan dimulai.</p></div><div className="closing-score"><strong>{stats.filled}<small> / {stats.total}</small></strong><span>item terisi</span></div></section><div className="baseline-note">◷ <span><strong>Patokan stok sudah dikunci.</strong> Perubahan yang dicatat setelah halaman ini dibuka tidak mengubah angka patokan di sini.</span></div><div className="closing-tools"><div className="search-wrap"><span>⌕</span><input aria-label="Cari item" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari nama item..." />{search && <button onClick={() => setSearch('')} aria-label="Hapus pencarian">×</button>}</div><div className="filter-chips">{(['Semua', 'Belum diisi', 'Berselisih', 'Kritis'] as const).map((value) => <button className={filter === value ? 'active' : ''} aria-pressed={filter === value} key={value} onClick={() => setFilter(value)}>{value}{value === 'Belum diisi' && stats.total - stats.filled > 0 ? <b>{stats.total - stats.filled}</b> : value === 'Kritis' && stats.low + stats.empty > 0 ? <b>{stats.low + stats.empty}</b> : null}</button>)}</div></div><div className="progress-line"><span style={{ width: `${percentage}%` }} /><small>{percentage}% selesai</small></div><section className="closing-list">{items.map((item) => { const frozen = baseline.find((entry) => entry.id === item.id) ?? item; return <StockRow key={item.id} item={item} baseline={frozen} updateItem={updateItem} updateClosing={updateClosing} setEditingClosingId={setEditingClosingId} submitted={submitted} />; })}{items.length === 0 && <div className="empty-state">Tidak ada item yang cocok.</div>}</section><div className="submit-bar"><div><strong>{submitted ? 'Laporan terkunci · Revisi 01' : stats.filled === stats.total ? 'Siap dikirim' : 'Belum siap dikirim'}</strong><span>{submitted && submittedAt ? `Dikirim ${wibDateTime(submittedAt)}.` : stats.filled === stats.total ? 'Periksa angka dan catatan sebelum kirim.' : `${stats.total - stats.filled} item belum diisi.`}</span></div><button className="primary-button" disabled={submitted} onClick={onSubmit}>{submitted ? 'Terkirim ✓' : 'Periksa & kirim'} <span>→</span></button></div></div>;
}

function StockRow({ item, baseline, updateItem, updateClosing, setEditingClosingId, submitted }: { item: Item; baseline: Item; updateItem: (id: string, patch: Partial<Item>) => void; updateClosing: (id: string, value: string) => void; setEditingClosingId: (id: string | null) => void; submitted: boolean }) {
  const status = statusOf(item); const system = baseline.opening + baseline.incoming - baseline.outgoing; const variance = item.closing === null ? null : item.closing - system;
  return <div className={`stock-row ${item.closing === null ? 'is-empty' : ''}`}><div className="stock-info"><StatusMark status={status} /><div><strong>{item.name}</strong><small>Sisa menurut catatan <b>{fmt(system)} {baseline.unit}</b> · mulai menipis di {fmt(baseline.low)} {baseline.unit}</small>{item.updatedAt && <small>Input terakhir {wibDateTime(item.updatedAt)}</small>}</div></div><div className="stock-input"><label htmlFor={`closing-${item.id}`}>Hitungan fisik</label><div><input id={`closing-${item.id}`} inputMode="decimal" type="number" min="0" step={item.unit === 'pcs' || item.unit === 'pack' ? '1' : '0.01'} value={item.closing ?? ''} onFocus={() => setEditingClosingId(item.id)} onBlur={() => setEditingClosingId(null)} onChange={(event) => updateClosing(item.id, event.target.value)} disabled={submitted} placeholder="0" /><span>{item.unit}</span></div></div><div className="stock-result">{variance === null ? <span className="tag pending">Belum diisi</span> : <><span className={`tag ${status === 'Aman' ? 'good' : status === 'Habis' ? 'bad' : 'warn'}`}>{status}</span><small className={variance === 0 ? 'zero' : ''}>{variance === 0 ? 'Sesuai' : `Selisih ${variance > 0 ? '+' : ''}${fmt(variance)} ${item.unit}`}</small></>}</div>{variance !== null && variance !== 0 && <div className="variance-fields"><label htmlFor={`reason-${item.id}`}>Kenapa berbeda?<select id={`reason-${item.id}`} value={item.varianceReason ?? ''} disabled={submitted} onChange={(event) => updateItem(item.id, { varianceReason: event.target.value })}><option value="">Pilih alasan...</option><option value="COUNTING_ERROR">Salah hitung</option><option value="OVER_PORTIONING">Porsi berlebih</option><option value="SPILLAGE_UNRECORDED">Tumpah belum tercatat</option><option value="WASTE_UNRECORDED">Waste belum tercatat</option><option value="UNIT_MISMATCH">Satuan tidak sesuai</option><option value="OTHER">Lainnya</option></select></label><label htmlFor={`notes-${item.id}`}>Catatan<textarea id={`notes-${item.id}`} value={item.varianceNotes ?? ''} disabled={submitted} onChange={(event) => updateItem(item.id, { varianceNotes: event.target.value })} placeholder="Tulis penyebabnya supaya mudah dicek" /></label></div>}</div>;
}

function createReportText(area: Area, items: Item[], submitted: boolean, submittedAt?: string, shift: ShiftType = 'SIANG') {
  const counts = { safe: items.filter((item) => statusOf(item) === 'Aman').length, low: items.filter((item) => statusOf(item) === 'Hampir habis').length, empty: items.filter((item) => statusOf(item) === 'Habis').length, missing: items.filter((item) => statusOf(item) === 'Belum diisi').length };
  const timestamp = submittedAt ? wibDateTime(submittedAt) : `${wibDate()} · ${wibTime()} WIB`;
  return `STOK HOPIN · ${areaLabel(area).toUpperCase()}\n${shiftLabel(shift)} · ${wibDate()}\nStatus: ${submitted ? 'TERKIRIM KE SUPERVISOR' : 'DRAF'}\nWaktu: ${timestamp}\n\nAman ${counts.safe} · Hampir habis ${counts.low} · Habis ${counts.empty} · Belum diisi ${counts.missing}\n\n${items.map((item) => `• ${item.name}: ${item.closing === null ? 'Belum diisi' : `${fmt(item.closing)} ${item.unit}`} · ${statusOf(item)}`).join('\n')}`;
}

function Reports({ area, shift, items, submitted, submittedAt, financeReady, onCopy }: { area: Area; shift: ShiftType; items: Item[]; submitted: boolean; submittedAt?: string; financeReady: boolean; onCopy: () => void }) {
  const counts = { safe: items.filter((item) => statusOf(item) === 'Aman').length, low: items.filter((item) => statusOf(item) === 'Hampir habis').length, empty: items.filter((item) => statusOf(item) === 'Habis').length };
  return <div className="content-grid"><div className="main-column"><section className="hero-card report-hero"><div><p className="eyebrow">RINGKASAN LAPORAN · {submitted ? 'REVISI 01' : 'DRAF'}</p><h2>{areaLabel(area)} · {shiftLabel(shift)}</h2><p className="muted">Ringkasan memakai angka terakhir dari stok akhir.</p></div><span className={`status-badge ${submitted ? 'submitted' : 'draft'}`}>{submitted ? 'TERKIRIM KE SUPERVISOR' : 'DRAF'}</span></section><section className="section-card report-card"><div className="report-summary"><div><span className="eyebrow">STATUS STOK</span><strong>{counts.safe}<small> aman</small></strong></div><div><span className="eyebrow">PERLU DICEK</span><strong>{counts.low + counts.empty}<small> item</small></strong></div><div><span className="eyebrow">KELENGKAPAN</span><strong>{items.filter((item) => item.closing !== null).length}/{items.length}</strong></div></div><div className="report-preview"><p className="eyebrow">CONTOH PESAN</p><pre>{createReportText(area, items, submitted, submittedAt, shift)}</pre></div><button className="outline-button" onClick={onCopy}>Salin untuk WhatsApp <span>↗</span></button></section></div><aside className="side-column"><section className="side-card action-card"><p className="eyebrow">STATUS LAPORAN</p><h3>{submitted ? 'Terkirim ke supervisor' : 'Masih berupa draf di perangkat'}</h3><p>{submitted && submittedAt ? `Dikirim ${wibDateTime(submittedAt)}. Cek supervisor berjalan terpisah.` : 'Lengkapi stok akhir lalu kirim agar laporan tercatat.'}</p><div className="channel-row"><span>WA</span><span>PDF</span><span>Link</span></div></section>{area === 'BAR' && <section className="side-card finance-note"><p className="eyebrow">LAPORAN KEUANGAN</p><h3>{financeReady ? 'Siap diisi' : 'Menunggu stok lengkap'}</h3><p>{financeReady ? 'Closing Bar dan Kitchen sudah terkirim. Laporan keuangan dapat dilanjutkan.' : 'Closing Bar dan Kitchen harus terkirim sebelum laporan keuangan dikirim.'}</p></section>}</aside></div>;
}

function MovementModal({ area, items, type, setType, item, setItem, qty, setQty, category, setCategory, onClose, onSave }: { area: Area; items: Item[]; type: 'Masuk' | 'Keluar'; setType: (value: 'Masuk' | 'Keluar') => void; item: string; setItem: (value: string) => void; qty: string; setQty: (value: string) => void; category: string; setCategory: (value: string) => void; onClose: () => void; onSave: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    focusable?.[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !focusable?.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="movement-title"><div className="modal-head"><div><p className="eyebrow">PERUBAHAN STOK · {area}</p><h2 id="movement-title">Catat perubahan stok</h2></div><button className="close-button" onClick={onClose} aria-label="Tutup">×</button></div><div className="segmented"><button className={type === 'Masuk' ? 'selected' : ''} aria-pressed={type === 'Masuk'} onClick={() => { setType('Masuk'); setCategory('PURCHASE'); }}>↑ Masuk</button><button className={type === 'Keluar' ? 'selected' : ''} aria-pressed={type === 'Keluar'} onClick={() => { setType('Keluar'); setCategory('USAGE'); }}>↓ Keluar</button></div><label>Item<select value={item || items[0]?.id} onChange={(event) => setItem(event.target.value)}>{items.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><div className="form-grid"><label>Jumlah<input type="number" min="0" step="0.01" inputMode="decimal" value={qty} onChange={(event) => setQty(event.target.value)} placeholder="0" /></label><label>Kategori<select value={category} onChange={(event) => setCategory(event.target.value)}>{(type === 'Masuk' ? ['PURCHASE', 'RETURN_IN', 'TRANSFER_IN'] : ['USAGE', 'INTERNAL', 'TRANSFER_OUT', 'WASTE']).map((value) => <option key={value} value={value}>{movementCategoryLabel(value)}</option>)}</select></label></div><div className="modal-actions"><button className="outline-button" onClick={onClose}>Batal</button><button className="primary-button" onClick={onSave}>Simpan perubahan <span>→</span></button></div></div></div>;
}

export default App;
