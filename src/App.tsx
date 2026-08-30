import { useEffect, useMemo, useRef, useState } from 'react';

type Area = 'BAR' | 'KITCHEN';
type Tab = 'overview' | 'opening' | 'movement' | 'closing' | 'reports';
type StockStatus = 'Belum diisi' | 'Aman' | 'Hampir habis' | 'Habis';
type SubmissionState = Record<Area, boolean>;

type Item = {
  id: string; area: Area; name: string; unit: string; low: number;
  opening: number; incoming: number; outgoing: number; closing: number | null;
  varianceReason?: string; varianceNotes?: string; updatedAt?: string;
};

type Movement = {
  id: string; type: 'Masuk' | 'Keluar'; itemId: string; item: string;
  qty: number; unit: string; category: string; occurredAt: string;
};

type AppData = {
  items: Record<Area, Item[]>;
  movements: Record<Area, Movement[]>;
  submitted: SubmissionState;
  submittedAt: Partial<Record<Area, string>>;
  closingBaseline: Partial<Record<Area, Item[]>>;
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
  submitted: { BAR: false, KITCHEN: false },
  submittedAt: {},
  closingBaseline: {},
};

const storageKey = 'hopin-stock-demo-v03';
const leaseKey = 'hopin-stock-local-lease-v01';
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
      submitted: parsed.submitted ?? { BAR: false, KITCHEN: false },
      submittedAt: parsed.submittedAt ?? {},
      closingBaseline: parsed.closingBaseline ?? {},
    };
  } catch {
    return structuredClone(initialData);
  }
}

function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [loginError, setLoginError] = useState('');
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
  const baseline = data.closingBaseline[area];
  const isSubmitted = data.submitted[area];
  const systemBalance = (item: Item) => {
    const frozen = baseline?.find((entry) => entry.id === item.id) ?? item;
    return frozen.opening + frozen.incoming - frozen.outgoing;
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
  }, [current, baseline]);

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

  function handleLogin() {
    setLoginError('');
    if (!name.trim()) { setLoginError('Isi nama atau peran dulu.'); return; }
    if (pin !== '1234') { setLoginError('PIN demo salah. Coba 1234.'); return; }
    try {
      const lease = JSON.parse(localStorage.getItem(leaseKey) || 'null') as { tabId: string; activeAt: number } | null;
      if (lease && lease.tabId !== tabId.current && Date.now() - lease.activeAt < inactivityMs) {
        setLoginError('Sesi masih aktif di tab lain. Keluar dari sana atau tunggu 30 menit.');
        return;
      }
      localStorage.setItem(leaseKey, JSON.stringify({ tabId: tabId.current, name: name.trim(), activeAt: Date.now() }));
    } catch { /* local lease is only a demo convenience */ }
    setLoggedIn(true);
  }

  function handleLogout() {
    try {
      const lease = JSON.parse(localStorage.getItem(leaseKey) || 'null') as { tabId: string } | null;
      if (lease?.tabId === tabId.current) localStorage.removeItem(leaseKey);
    } catch { /* return to login even if local storage is unavailable */ }
    setLoggedIn(false);
    setPin('');
  }

  function switchArea(nextArea: Area) {
    setArea(nextArea); setTab('overview'); setSearch(''); setFilter('Semua');
    setEditingClosingId(null);
    setMovementItem(''); setMovementQty('');
  }

  function goTab(next: Tab) {
    if (next !== 'closing') setEditingClosingId(null);
    if (next === 'closing' && !data.closingBaseline[area]) {
      setData((previous) => ({ ...previous, closingBaseline: { ...previous.closingBaseline, [area]: previous.items[area].map((item) => ({ ...item })) } }));
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

  function addMovement() {
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
    setData((previous) => ({ ...previous, submitted: { ...previous.submitted, [area]: true }, submittedAt: { ...previous.submittedAt, [area]: submittedAt } }));
    showToast(`Laporan ${area === 'BAR' ? 'Bar' : 'Kitchen'} dikirim · ${wibDateTime(submittedAt)}`);
  }

  async function copyReport() {
    const text = createReportText(area, current, isSubmitted, data.submittedAt[area]);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      showToast('Ringkasan sudah disalin. Tinggal tempel ke WhatsApp.');
    } catch { showToast('Browser tidak mengizinkan salin otomatis. Salin dari contoh pesan.'); }
  }

  if (!loggedIn) return <Login name={name} setName={setName} pin={pin} setPin={setPin} error={loginError} onLogin={handleLogin} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span><strong>HOPIN</strong><small>CAFE OPERATIONS</small></span></div>
        <div className="topbar-right"><div className={`connection ${online ? 'is-online' : 'is-offline'}`}><span className="dot" />{online ? 'Terhubung' : 'Offline'}</div><div className="clock"><span className="clock-date">{wibDate(clock)}</span><strong>{wibTime(clock)} <i>WIB</i></strong></div><button className="avatar" onClick={handleLogout} aria-label="Keluar dari aplikasi" title="Keluar">{initialsOf(name)}</button></div>
      </header>
      {saveError && <div className="save-error" role="alert">{saveError}</div>}
      <main className="workspace">
        <section className="welcome"><div><p className="eyebrow">SHIFT SIANG · 11.00–17.00 WIB</p><h1>Halo, {name}.</h1><p className="muted">Catat perubahan stok saat terjadi. Tutup shift dengan angka yang bisa dicek.</p></div><div className="save-state"><span className="save-icon">↻</span><span><strong>Tersimpan otomatis di perangkat</strong><small>{syncLabel}</small></span></div></section>
        <section className="area-switch" aria-label="Pilih area kerja"><div className="switch-label"><span className="eyebrow">AREA SAYA</span><strong>Pilih area</strong></div>{(['BAR', 'KITCHEN'] as Area[]).map((option) => <button key={option} className={`area-button ${area === option ? 'selected' : ''}`} aria-pressed={area === option} onClick={() => switchArea(option)}><span className="area-symbol">{option === 'BAR' ? '◒' : '⌁'}</span><span><strong>{option === 'BAR' ? 'Bar' : 'Kitchen'}</strong><small>{data.items[option].length} item aktif</small></span>{area === option && <span className="check">✓</span>}</button>)}</section>
        <nav className="tabs" aria-label="Navigasi operasi">{([['overview', 'Ringkasan'], ['opening', 'Stok awal'], ['movement', 'Perubahan'], ['closing', 'Stok akhir'], ['reports', 'Laporan']] as [Tab, string][]).map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} aria-current={tab === key ? 'page' : undefined} onClick={() => goTab(key)}>{label}{key === 'closing' && stats.filled < stats.total && <span className="tab-count">{stats.total - stats.filled}</span>}</button>)}</nav>
        {tab === 'overview' && <Overview area={area} stats={stats} items={current} submitted={isSubmitted} onTab={goTab} />}
        {tab === 'opening' && <Opening area={area} items={current} onTab={goTab} />}
        {tab === 'movement' && <MovementView area={area} movements={data.movements[area]} submitted={isSubmitted} onAdd={() => { setMovementItem(current[0]?.id ?? ''); setMovementOpen(true); }} />}
        {tab === 'closing' && <Closing items={filtered} baseline={baseline ?? current} stats={stats} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} updateItem={updateItem} updateClosing={updateClosing} editingClosingId={editingClosingId} setEditingClosingId={setEditingClosingId} submitted={isSubmitted} submittedAt={data.submittedAt[area]} onSubmit={submitReport} />}
        {tab === 'reports' && <Reports area={area} items={current} submitted={isSubmitted} submittedAt={data.submittedAt[area]} onCopy={copyReport} />}
      </main>
      <footer className="footer"><span>v0.3 · Demo lokal · 1 outlet</span><span>Draf dipulihkan dari perangkat ini</span></footer>
      {movementOpen && <MovementModal area={area} items={current} type={movementType} setType={setMovementType} item={movementItem} setItem={setMovementItem} qty={movementQty} setQty={setMovementQty} category={movementCategory} setCategory={setMovementCategory} onClose={() => setMovementOpen(false)} onSave={addMovement} />}
      <div className="live-region" role="status" aria-live="polite">{toast}</div>
    </div>
  );
}

function Login({ name, setName, pin, setPin, error, onLogin }: { name: string; setName: (value: string) => void; pin: string; setPin: (value: string) => void; error: string; onLogin: () => void }) {
  const [showPin, setShowPin] = useState(false);
  return <div className="login-page"><div className="login-panel"><div className="login-brand"><div><strong>HOPIN</strong><small>CAFE OPERATIONS</small></div></div><div className="login-copy"><p className="eyebrow">STOK HARI INI · DEMO LOKAL</p><h1>Mulai shift tanpa<br /><em>catatan tercecer.</em></h1><p>Catat stok Bar dan Kitchen di satu tempat. Draf tersimpan otomatis saat halaman dimuat ulang.</p></div><form noValidate onSubmit={(event) => { event.preventDefault(); onLogin(); }}><label>Nama atau peran<input autoComplete="username" value={name} onChange={(event) => setName(event.target.value)} placeholder="Contoh: PIC Bar" /></label><label>PIN demo<span className="password-field"><input type={showPin ? 'text' : 'password'} autoComplete="current-password" inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" /><button type="button" onClick={() => setShowPin((shown) => !shown)} aria-label={showPin ? 'Sembunyikan PIN' : 'Tampilkan PIN'}>{showPin ? 'Sembunyikan' : 'Tampilkan'}</button></span></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" type="submit">Masuk ke aplikasi <span>→</span></button></form><p className="demo-hint">Demo: isi nama apa saja · PIN 1234 · logout otomatis setelah 30 menit tanpa aktivitas</p></div><div className="login-aside"><div className="aside-stamp">OPS<br /><small>STOCK<br />V0.3</small></div><p className="eyebrow">OPERASIONAL HARI INI</p><h2>Semua stok tercatat.<br />Perubahan terakhir<br /><em>tetap tersimpan.</em></h2><div className="aside-line" /><p>Jam mengikuti WIB<br />dan diperbarui setiap detik.</p></div></div>;
}

function Overview({ area, stats, items, submitted, onTab }: { area: Area; stats: { total: number; filled: number; low: number; empty: number; variance: number }; items: Item[]; submitted: boolean; onTab: (tab: Tab) => void }) {
  const percentage = Math.round((stats.filled / stats.total) * 100);
  return <div className="content-grid"><div className="main-column"><section className="hero-card"><div><p className="eyebrow">{submitted ? 'LAPORAN TERKIRIM · REVISI 01' : 'SHIFT SEDANG BERJALAN'}</p><h2>{area === 'BAR' ? 'Bar' : 'Kitchen'} <span>·</span> Shift siang</h2><p className="muted">Stok awal diambil dari penutupan terakhir. Catat perubahan hari ini di sini.</p></div><div className="hero-progress"><div className="progress-ring" style={{ '--progress': `${percentage}%` } as React.CSSProperties}><strong>{percentage}<small>%</small></strong></div><span>stok akhir terisi</span></div></section><section className="metric-row"><Metric label="Item terisi" value={`${stats.filled}/${stats.total}`} hint={stats.filled === stats.total ? 'Siap dikirim' : 'Masih ada yang kosong'} tone={stats.filled === stats.total ? 'good' : 'warn'} /><Metric label="Hampir habis" value={String(stats.low)} hint="Perlu dicek" tone="warn" /><Metric label="Habis" value={String(stats.empty)} hint="Perlu diisi ulang" tone="danger" /><Metric label="Berselisih" value={String(stats.variance)} hint="Perlu keterangan" tone="neutral" /></section><section className="section-card"><div className="section-heading"><div><p className="eyebrow">CEK CEPAT</p><h3>Perlu dicek</h3></div><button className="text-button" onClick={() => onTab('closing')}>Buka stok akhir <span>→</span></button></div><div className="attention-list">{items.filter((item) => statusOf(item) !== 'Aman').slice(0, 4).map((item) => <AttentionItem key={item.id} item={item} />)}{items.every((item) => statusOf(item) === 'Aman') && <div className="empty-state">Semua stok dalam kondisi aman. ✦</div>}</div></section></div><aside className="side-column"><section className="side-card shift-card"><p className="eyebrow">DETAIL SHIFT</p><div className="shift-time"><strong>11.00</strong><span>–</span><strong>17.00</strong></div><div className="shift-meta"><span><i className="green-dot" />Sedang berjalan</span><span>{wibDate()}</span></div><div className="thin-rule" /><dl><div><dt>Area</dt><dd>{area === 'BAR' ? 'Bar' : 'Kitchen'}</dd></div><div><dt>Peran</dt><dd>PIC {area === 'BAR' ? 'Bar' : 'Kitchen'}</dd></div><div><dt>Status</dt><dd>{submitted ? 'Terkirim · 01' : 'Draf · 01'}</dd></div></dl></section><section className="side-card action-card"><p className="eyebrow">LANGKAH BERIKUT</p><h3>{stats.filled < stats.total ? 'Lengkapi stok akhir' : 'Periksa dan kirim'}</h3><p>{stats.filled < stats.total ? `${stats.total - stats.filled} item belum dihitung.` : 'Semua item sudah diisi. Periksa keterangan untuk setiap selisih.'}</p><button className="primary-button small" onClick={() => onTab(stats.filled < stats.total ? 'closing' : 'reports')}>{stats.filled < stats.total ? 'Isi stok akhir' : 'Periksa laporan'} <span>→</span></button></section></aside></div>;
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: string }) { return <div className={`metric ${tone}`}><span className="metric-label">{label}</span><strong>{value}</strong><small>{hint}</small></div>; }
function StatusMark({ status }: { status: StockStatus }) { const tone = status === 'Habis' ? 'danger' : status === 'Hampir habis' || status === 'Belum diisi' ? 'warning' : 'success'; const glyph = status === 'Habis' ? '!' : status === 'Hampir habis' ? '~' : status === 'Belum diisi' ? '·' : '✓'; return <span className={`status-mark ${tone}`} aria-label={status}>{glyph}</span>; }
function AttentionItem({ item }: { item: Item }) { const status = statusOf(item); return <div className="attention-item"><StatusMark status={status} /><div><strong>{item.name}</strong><small>{item.closing === null ? 'Belum diisi' : `${fmt(item.closing)} ${item.unit}`} · {status}</small></div><span className="chevron">›</span></div>; }

function Opening({ area, items, onTab }: { area: Area; items: Item[]; onTab: (tab: Tab) => void }) {
  return <div className="content-grid"><div className="main-column"><section className="section-card opening-intro"><p className="eyebrow">STOK AWAL · {area}</p><h2>Stok awal shift ini</h2><p className="muted">Angka ini berasal dari penutupan terakhir. Cek jumlah fisik saat serah-terima sebelum mencatat perubahan.</p><div className="opening-callout"><span className="callout-icon">↗</span><div><strong>Stok awal tersimpan</strong><p>Stok awal menjadi patokan shift. Kalau ada koreksi saat serah-terima, catat sebagai perubahan dan beri alasannya.</p></div></div></section><section className="section-card"><div className="section-heading"><div><p className="eyebrow">PATOKAN STOK AWAL</p><h3>{items.length} item</h3></div><span className="tag neutral">Tidak bisa diedit</span></div><div className="opening-table"><div className="table-head"><span>Item</span><span>Satuan</span><span>Stok awal</span></div>{items.map((item) => <div className="table-row" key={item.id}><span><strong>{item.name}</strong><small>Mulai menipis di: {fmt(item.low)} {item.unit}</small></span><span className="unit-pill">{item.unit}</span><strong>{fmt(item.opening)}</strong></div>)}</div></section></div><aside className="side-column"><section className="side-card action-card"><p className="eyebrow">SEBELUM MULAI</p><h3>Catat perubahan</h3><p>Stok awal sudah ada. Tambahkan barang masuk atau pemakaian saat terjadi.</p><button className="primary-button small" onClick={() => onTab('movement')}>Buka perubahan <span>→</span></button></section></aside></div>;
}

function MovementView({ area, movements, submitted, onAdd }: { area: Area; movements: Movement[]; submitted: boolean; onAdd: () => void }) {
  return <div className="content-grid"><div className="main-column"><section className="section-card"><div className="section-heading"><div><p className="eyebrow">PERUBAHAN STOK · {area}</p><h2>Perubahan stok</h2><p className="muted">Setiap catatan masuk ke riwayat dan tersimpan di perangkat ini.</p></div><button className="primary-button small" disabled={submitted} onClick={onAdd}>+ Catat perubahan</button></div><div className="ledger-list">{movements.map((movement) => <div className="ledger-row" key={movement.id}><span className={`movement-icon ${movement.type === 'Masuk' ? 'in' : 'out'}`}>{movement.type === 'Masuk' ? '↑' : '↓'}</span><div><strong>{movement.item}</strong><small>{movementCategoryLabel(movement.category)} · {wibDateTime(movement.occurredAt)}</small></div><span className={`movement-qty ${movement.type === 'Masuk' ? 'positive' : 'negative'}`}>{movement.type === 'Masuk' ? '+' : '−'}{fmt(movement.qty)} {movement.unit}</span></div>)}</div>{movements.length === 0 && <div className="empty-state">Belum ada perubahan di shift ini.</div>}</section></div><aside className="side-column"><section className="side-card ledger-note"><p className="eyebrow">CARA MENCATAT</p><h3>Catat saat terjadi.</h3><p>Pilih <strong>Masuk</strong> untuk barang datang atau pindahan. Pilih <strong>Keluar</strong> untuk pemakaian atau waste. Catatan yang sudah disimpan tidak bisa diedit atau dihapus.</p><div className="rule-row"><span>Sisa menurut catatan</span><strong>Dihitung otomatis</strong></div></section></aside></div>;
}

function Closing({ items, baseline, stats, filter, setFilter, search, setSearch, updateItem, updateClosing, editingClosingId, setEditingClosingId, submitted, submittedAt, onSubmit }: { items: Item[]; baseline: Item[]; stats: { total: number; filled: number; low: number; empty: number; variance: number }; filter: 'Semua' | 'Belum diisi' | 'Berselisih' | 'Kritis'; setFilter: (value: 'Semua' | 'Belum diisi' | 'Berselisih' | 'Kritis') => void; search: string; setSearch: (value: string) => void; updateItem: (id: string, patch: Partial<Item>) => void; updateClosing: (id: string, value: string) => void; editingClosingId: string | null; setEditingClosingId: (id: string | null) => void; submitted: boolean; submittedAt?: string; onSubmit: () => void }) {
  const percentage = Math.round((stats.filled / stats.total) * 100);
  return <div className="closing-page"><section className="closing-header"><div><p className="eyebrow">STOK AKHIR · HITUNG FISIK</p><h2>Hitung stok akhir dengan teliti.</h2><p className="muted">Isi semua item. Status dan selisih akan dihitung dari stok awal saat pengecekan dimulai.</p></div><div className="closing-score"><strong>{stats.filled}<small> / {stats.total}</small></strong><span>item terisi</span></div></section><div className="baseline-note">◷ <span><strong>Patokan stok sudah dikunci.</strong> Perubahan yang dicatat setelah halaman ini dibuka tidak mengubah angka patokan di sini.</span></div><div className="closing-tools"><div className="search-wrap"><span>⌕</span><input aria-label="Cari item" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari nama item..." />{search && <button onClick={() => setSearch('')} aria-label="Hapus pencarian">×</button>}</div><div className="filter-chips">{(['Semua', 'Belum diisi', 'Berselisih', 'Kritis'] as const).map((value) => <button className={filter === value ? 'active' : ''} aria-pressed={filter === value} key={value} onClick={() => setFilter(value)}>{value}{value === 'Belum diisi' && stats.total - stats.filled > 0 ? <b>{stats.total - stats.filled}</b> : value === 'Kritis' && stats.low + stats.empty > 0 ? <b>{stats.low + stats.empty}</b> : null}</button>)}</div></div><div className="progress-line"><span style={{ width: `${percentage}%` }} /><small>{percentage}% selesai</small></div><section className="closing-list">{items.map((item) => { const frozen = baseline.find((entry) => entry.id === item.id) ?? item; return <StockRow key={item.id} item={item} baseline={frozen} updateItem={updateItem} updateClosing={updateClosing} setEditingClosingId={setEditingClosingId} submitted={submitted} />; })}{items.length === 0 && <div className="empty-state">Tidak ada item yang cocok.</div>}</section><div className="submit-bar"><div><strong>{submitted ? 'Laporan terkunci · Revisi 01' : stats.filled === stats.total ? 'Siap dikirim' : 'Belum siap dikirim'}</strong><span>{submitted && submittedAt ? `Dikirim ${wibDateTime(submittedAt)}.` : stats.filled === stats.total ? 'Periksa angka dan catatan sebelum kirim.' : `${stats.total - stats.filled} item belum diisi.`}</span></div><button className="primary-button" disabled={submitted} onClick={onSubmit}>{submitted ? 'Terkirim ✓' : 'Periksa & kirim'} <span>→</span></button></div></div>;
}

function StockRow({ item, baseline, updateItem, updateClosing, setEditingClosingId, submitted }: { item: Item; baseline: Item; updateItem: (id: string, patch: Partial<Item>) => void; updateClosing: (id: string, value: string) => void; setEditingClosingId: (id: string | null) => void; submitted: boolean }) {
  const status = statusOf(item); const system = baseline.opening + baseline.incoming - baseline.outgoing; const variance = item.closing === null ? null : item.closing - system;
  return <div className={`stock-row ${item.closing === null ? 'is-empty' : ''}`}><div className="stock-info"><StatusMark status={status} /><div><strong>{item.name}</strong><small>Sisa menurut catatan <b>{fmt(system)} {baseline.unit}</b> · mulai menipis di {fmt(baseline.low)} {baseline.unit}</small>{item.updatedAt && <small>Input terakhir {wibDateTime(item.updatedAt)}</small>}</div></div><div className="stock-input"><label htmlFor={`closing-${item.id}`}>Hitungan fisik</label><div><input id={`closing-${item.id}`} inputMode="decimal" type="number" min="0" step={item.unit === 'pcs' || item.unit === 'pack' ? '1' : '0.01'} value={item.closing ?? ''} onFocus={() => setEditingClosingId(item.id)} onBlur={() => setEditingClosingId(null)} onChange={(event) => updateClosing(item.id, event.target.value)} disabled={submitted} placeholder="0" /><span>{item.unit}</span></div></div><div className="stock-result">{variance === null ? <span className="tag pending">Belum diisi</span> : <><span className={`tag ${status === 'Aman' ? 'good' : status === 'Habis' ? 'bad' : 'warn'}`}>{status}</span><small className={variance === 0 ? 'zero' : ''}>{variance === 0 ? 'Sesuai' : `Selisih ${variance > 0 ? '+' : ''}${fmt(variance)} ${item.unit}`}</small></>}</div>{variance !== null && variance !== 0 && <div className="variance-fields"><label htmlFor={`reason-${item.id}`}>Kenapa berbeda?<select id={`reason-${item.id}`} value={item.varianceReason ?? ''} disabled={submitted} onChange={(event) => updateItem(item.id, { varianceReason: event.target.value })}><option value="">Pilih alasan...</option><option value="COUNTING_ERROR">Salah hitung</option><option value="OVER_PORTIONING">Porsi berlebih</option><option value="SPILLAGE_UNRECORDED">Tumpah belum tercatat</option><option value="WASTE_UNRECORDED">Waste belum tercatat</option><option value="UNIT_MISMATCH">Satuan tidak sesuai</option><option value="OTHER">Lainnya</option></select></label><label htmlFor={`notes-${item.id}`}>Catatan<textarea id={`notes-${item.id}`} value={item.varianceNotes ?? ''} disabled={submitted} onChange={(event) => updateItem(item.id, { varianceNotes: event.target.value })} placeholder="Tulis penyebabnya supaya mudah dicek" /></label></div>}</div>;
}

function createReportText(area: Area, items: Item[], submitted: boolean, submittedAt?: string) {
  const counts = { safe: items.filter((item) => statusOf(item) === 'Aman').length, low: items.filter((item) => statusOf(item) === 'Hampir habis').length, empty: items.filter((item) => statusOf(item) === 'Habis').length, missing: items.filter((item) => statusOf(item) === 'Belum diisi').length };
  const timestamp = submittedAt ? wibDateTime(submittedAt) : `${wibDate()} · ${wibTime()} WIB`;
  return `STOK HOPIN · ${area === 'BAR' ? 'BAR' : 'KITCHEN'}\nShift siang · ${wibDate()}\nStatus: ${submitted ? 'TERKIRIM' : 'DRAF'}\nWaktu: ${timestamp}\n\nAman ${counts.safe} · Hampir habis ${counts.low} · Habis ${counts.empty} · Belum diisi ${counts.missing}\n\n${items.map((item) => `• ${item.name}: ${item.closing === null ? 'Belum diisi' : `${fmt(item.closing)} ${item.unit}`} · ${statusOf(item)}`).join('\n')}`;
}

function Reports({ area, items, submitted, submittedAt, onCopy }: { area: Area; items: Item[]; submitted: boolean; submittedAt?: string; onCopy: () => void }) {
  const counts = { safe: items.filter((item) => statusOf(item) === 'Aman').length, low: items.filter((item) => statusOf(item) === 'Hampir habis').length, empty: items.filter((item) => statusOf(item) === 'Habis').length };
  return <div className="content-grid"><div className="main-column"><section className="hero-card report-hero"><div><p className="eyebrow">RINGKASAN LAPORAN · {submitted ? 'REVISI 01' : 'DRAF'}</p><h2>{area === 'BAR' ? 'Bar' : 'Kitchen'} · Shift siang</h2><p className="muted">Ringkasan memakai angka terakhir dari stok akhir.</p></div><span className={`status-badge ${submitted ? 'submitted' : 'draft'}`}>{submitted ? 'TERKIRIM' : 'DRAF'}</span></section><section className="section-card report-card"><div className="report-summary"><div><span className="eyebrow">STATUS STOK</span><strong>{counts.safe}<small> aman</small></strong></div><div><span className="eyebrow">PERLU DICEK</span><strong>{counts.low + counts.empty}<small> item</small></strong></div><div><span className="eyebrow">KELENGKAPAN</span><strong>{items.filter((item) => item.closing !== null).length}/{items.length}</strong></div></div><div className="report-preview"><p className="eyebrow">CONTOH PESAN</p><pre>{createReportText(area, items, submitted, submittedAt)}</pre></div><button className="outline-button" onClick={onCopy}>Salin untuk WhatsApp <span>↗</span></button></section></div><aside className="side-column"><section className="side-card action-card"><p className="eyebrow">STATUS LAPORAN</p><h3>{submitted ? 'Menunggu cek supervisor' : 'Masih berupa draf di perangkat'}</h3><p>{submitted && submittedAt ? `Waktu kirim: ${wibDateTime(submittedAt)}.` : 'Lengkapi stok akhir lalu kirim agar laporan tercatat.'}</p><div className="channel-row"><span>WA</span><span>PDF</span><span>Link</span></div></section></aside></div>;
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
