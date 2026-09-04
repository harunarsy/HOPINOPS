import { useState, useEffect, useRef, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { fmtRupiah, wibDate } from '../../domain/rules';

type Tab = 'dashboard' | 'roster' | 'exceptions' | 'payroll' | 'users' | 'settings' | 'reports';
type Settings = Awaited<ReturnType<typeof api.getSettings>>;
type Decision = 'APPROVED' | 'REJECTED';

const inputStyle = { width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cddcd4', fontSize: '13px', boxSizing: 'border-box' as const };
const labelStyle = { fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' };

const labels: Record<string, string> = {
  OPERATOR: 'Operator', SUPERVISOR: 'Supervisor', OWNER: 'Pemilik', INVESTOR: 'Investor',
  SIANG: 'Shift siang', MALAM: 'Shift malam', FULL: 'Shift penuh',
  BAR: 'Area bar', KITCHEN: 'Area dapur', BASE: 'Jadwal reguler', EXTRA: 'Hari kerja tambahan', MAKEUP: 'Pengganti hari kerja',
  SCHEDULED: 'Terjadwal', SWAPPED: 'Sudah ditukar', CANCELLED: 'Dibatalkan', COMPLETED: 'Selesai',
  NOT_STARTED: 'Belum mulai', CHECKED_IN: 'Sudah masuk', CHECKED_OUT: 'Sudah pulang', MISSING_CHECKOUT: 'Belum check-out', REVIEW_REQUIRED: 'Perlu review',
  APPROVED: 'Disetujui', REJECTED: 'Ditolak', PENDING: 'Menunggu review', PENDING_REVIEW: 'Perlu review', RESOLVED: 'Selesai ditangani', NONE: 'Tidak ada exception',
  ON_TIME: 'Tepat waktu', LATE: 'Terlambat', EXCUSED: 'Diberi pengecualian', CANDIDATE: 'Menunggu review',
  CHECK_IN_TIME: 'Waktu check-in', CHECK_OUT_TIME: 'Waktu check-out', STATUS: 'Status kehadiran', LATENESS: 'Status keterlambatan', EXCEPTION: 'Status exception',
  DRAFT: 'Draft', REVIEWED: 'Selesai direview', FINALIZED: 'Sudah dikunci', PAID: 'Sudah dibayar',
  PRODUCTION: 'Produksi', PILOT: 'Uji coba', MAINTENANCE: 'Pemeliharaan',
};

function taskLabel(value?: string | null) {
  return value ? labels[value] ?? value.replace(/_/g, ' ').toLowerCase() : 'Belum ditentukan';
}

function proposedLabel(correction: any) {
  const proposed = correction?.proposed_json ?? {};
  const value = proposed.occurred_at ?? proposed.status ?? proposed.lateness_status ?? proposed.exception_status;
  if (!value) return 'Tidak ada nilai usulan';
  if (proposed.occurred_at) return new Date(value).toLocaleString('id-ID');
  return taskLabel(value);
}

function Dialog({ titleId, title, onClose, children }: { titleId: string; title: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    dialogRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, []);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ background: '#fff', padding: '24px', borderRadius: '12px', maxWidth: '480px', width: '100%', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto', boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}
      >
        <h3 id={titleId} style={{ margin: '0 0 8px' }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

type Props = {
  user: any;
  onLogout: () => void;
  onEnterOperatorMode?: () => void;
};

export function ManagementView({ user, onLogout, onEnterOperatorMode }: Props) {
  const [tab, setTab] = useState<Tab>(user.role === 'INVESTOR' ? 'reports' : 'dashboard');
  const [loading, setLoading] = useState(false);
  const [viewError, setViewError] = useState('');
  const [receipt, setReceipt] = useState<{ message: string; error?: boolean } | null>(null);
  const [actionLoading, setActionLoading] = useState('');
  const [dashboardData, setDashboardData] = useState<any>(null);
  const [investorReports, setInvestorReports] = useState<any[]>([]);
  const [usersList, setUsersList] = useState<any[]>([]);

  // Roster, attendance, overtime, and settings state
  const [roster, setRoster] = useState<any[]>([]);
  const [rosterMonth, setRosterMonth] = useState(wibDate().slice(0, 7));
  const [rosterDate, setRosterDate] = useState(wibDate());
  const [rosterShift, setRosterShift] = useState<'SIANG' | 'MALAM' | 'FULL'>('SIANG');
  const [rosterProfileId, setRosterProfileId] = useState('');
  const [rosterArea, setRosterArea] = useState<'' | 'BAR' | 'KITCHEN'>('');
  const [rosterPayTreatment, setRosterPayTreatment] = useState<'BASE' | 'EXTRA' | 'MAKEUP'>('BASE');
  const [rosterReason, setRosterReason] = useState('');
  const [attendanceExceptions, setAttendanceExceptions] = useState<any[]>([]);
  const [overtime, setOvertime] = useState<any[]>([]);
  const [reviewFrom, setReviewFrom] = useState(`${wibDate().slice(0, 8)}01`);
  const [reviewTo, setReviewTo] = useState(wibDate());
  const [attendanceReview, setAttendanceReview] = useState<{ attendance: any; correction: any; decision: Decision } | null>(null);
  const [overtimeReview, setOvertimeReview] = useState<{ claim: any; decision: Decision } | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null);

  // Payroll state
  const [payrollPeriod, setPayrollPeriod] = useState(wibDate().slice(0, 7));
  const [payrollRun, setPayrollRun] = useState<any | null>(null);
  const [payrollEntries, setPayrollEntries] = useState<any[]>([]);
  const [payrollLoading, setPayrollLoading] = useState(false);
  const [paymentRef, setPaymentRef] = useState('');
  const [paymentReason, setPaymentReason] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [showPayModal, setShowPayModal] = useState(false);
  const [showVoidModal, setShowVoidModal] = useState(false);
  const [showFinalizeModal, setShowFinalizeModal] = useState(false);

  // Create user state
  const [showCreateUserModal, setShowCreateUserModal] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<'OPERATOR' | 'SUPERVISOR' | 'INVESTOR' | 'OWNER'>('OPERATOR');
  const [newJobTitle, setNewJobTitle] = useState('STAFF');
  const [userEdit, setUserEdit] = useState<any | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<any | null>(null);
  const [deactivateReason, setDeactivateReason] = useState('');
  const [resetTarget, setResetTarget] = useState<any | null>(null);
  const [oneTimeSecret, setOneTimeSecret] = useState<{ username: string; pin: string } | null>(null);

  const isInvestor = user.role === 'INVESTOR';
  const isOwner = user.role === 'OWNER';

  const showToast = (message: string) => setReceipt({ message });
  const showError = (message: string) => setReceipt({ message, error: true });

  const loadData = async () => {
    setLoading(true);
    setViewError('');
    try {
      if (isInvestor) {
        const reps = await api.getInvestorReports();
        setInvestorReports(reps);
        return;
      }

      if (tab === 'dashboard') {
        setDashboardData(await api.getDashboard());
      } else if (tab === 'roster') {
        const [entries, users] = await Promise.all([api.listRoster(rosterMonth), api.listUsers()]);
        setRoster(entries);
        setUsersList(users);
        if (!rosterProfileId) setRosterProfileId(users.find((entry: any) => entry.role !== 'INVESTOR')?.id ?? '');
      } else if (tab === 'exceptions') {
        const [exceptions, claims] = await Promise.all([
          api.listAttendanceExceptions(reviewFrom, reviewTo),
          api.listOvertime({ from: reviewFrom, to: reviewTo }),
        ]);
        setAttendanceExceptions(exceptions);
        setOvertime(claims);
      } else if (tab === 'payroll') {
        setPayrollLoading(true);
        const { run, entries } = await api.getPayrollRun(payrollPeriod);
        setPayrollRun(run);
        setPayrollEntries(entries || []);
      } else if (tab === 'users') {
        setUsersList(await api.listUsers());
      } else if (tab === 'settings') {
        const current = await api.getSettings();
        setSettings(current);
        setSettingsDraft(current);
      }
    } catch (e: any) {
      setViewError(e.message || 'Gagal memuat data manajemen.');
    } finally {
      setLoading(false);
      setPayrollLoading(false);
    }
  };

  const loadPayroll = async (period: string) => {
    setPayrollLoading(true);
    try {
      const { run, entries } = await api.getPayrollRun(period);
      setPayrollRun(run);
      setPayrollEntries(entries || []);
      setViewError('');
    } catch (e: any) {
      setViewError(e.message || 'Gagal memuat data payroll.');
    } finally {
      setPayrollLoading(false);
    }
  };

  const handlePreviewPayroll = async () => {
    setPayrollLoading(true);
    try {
      const res = await api.previewPayroll(payrollPeriod, payrollRun?.version);
      showToast(`Draft Payroll berhasil dihitung (${res.entry_count} karyawan).`);
      await loadPayroll(payrollPeriod);
    } catch (e: any) {
      showError(e.message || 'Gagal membuat draft payroll.');
    } finally {
      setPayrollLoading(false);
    }
  };

  const handleReviewPayroll = async () => {
    if (!payrollRun) return;
    setPayrollLoading(true);
    try {
      await api.reviewPayroll(payrollRun.id, payrollRun.version);
      showToast('Payroll berhasil ditandai REVIEWED.');
      await loadPayroll(payrollPeriod);
    } catch (e: any) {
      showError(e.message || 'Gagal menyelesaikan review payroll.');
    } finally {
      setPayrollLoading(false);
    }
  };

  const handleFinalizePayroll = async () => {
    if (!payrollRun) return;
    setPayrollLoading(true);
    try {
      await api.finalizePayroll(payrollRun.id, payrollRun.version);
      setShowFinalizeModal(false);
      showToast('Payroll dikunci. Data gaji tidak dapat dihitung ulang.');
      await loadPayroll(payrollPeriod);
    } catch (e: any) {
      showError(e.message || 'Gagal mengunci payroll.');
    } finally {
      setPayrollLoading(false);
    }
  };

  const handleMarkPaid = async () => {
    if (!payrollRun || !paymentRef.trim() || !paymentReason.trim()) {
      showToast('Referensi dan alasan pembayaran wajib diisi.');
      return;
    }
    setPayrollLoading(true);
    try {
      await api.markPayrollPaid(payrollRun.id, payrollRun.version, paymentRef.trim(), paymentReason.trim());
      showToast('Payroll berhasil ditandai PAID.');
      setShowPayModal(false);
      setPaymentRef('');
      setPaymentReason('');
      await loadPayroll(payrollPeriod);
    } catch (e: any) {
      showError(e.message || 'Gagal menandai payroll dibayar.');
    } finally {
      setPayrollLoading(false);
    }
  };

  const handleVoidPayroll = async () => {
    if (!payrollRun || !voidReason.trim()) {
      showToast('Alasan pembatalan (VOID) wajib diisi.');
      return;
    }
    setPayrollLoading(true);
    try {
      await api.voidPayroll(payrollRun.id, payrollRun.version, voidReason.trim());
      showToast('Payroll telah di-VOID dan draft pengganti dibuat.');
      setShowVoidModal(false);
      setVoidReason('');
      await loadPayroll(payrollPeriod);
    } catch (e: any) {
      showError(e.message || 'Gagal membatalkan payroll.');
    } finally {
      setPayrollLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [tab, rosterMonth, payrollPeriod]);

  const handleExportPayroll = async () => {
    if (!payrollRun) {
      showToast('Belum ada payroll run untuk periode ini.');
      return;
    }
    if (!['REVIEWED', 'FINALIZED', 'PAID'].includes(payrollRun.status)) {
      showToast('Payroll harus berstatus REVIEWED atau FINALIZED sebelum dapat diekspor.');
      return;
    }
    setPayrollLoading(true);
    try {
      const res = await api.exportPayrollXlsx(payrollRun.id, payrollRun.version);
      showToast(`Snapshot Excel (${res.label}) berhasil dicatat: ${res.filename}`);
    } catch (e: any) {
      showError(e.message || 'Gagal mengekspor payroll.');
    } finally {
      setPayrollLoading(false);
    }
  };

  const handleResetPin = async () => {
    if (!resetTarget) return;
    setActionLoading('reset-pin');
    try {
      const res = await api.resetPin(resetTarget.username);
      setResetTarget(null);
      setOneTimeSecret({ username: res.username, pin: res.tempPin });
      await loadData();
    } catch (err: any) {
      showError(err.message || 'Gagal mereset PIN.');
    } finally {
      setActionLoading('');
    }
  };

  const handleCreateRoster = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!rosterProfileId) return showError('Pilih pengguna untuk jadwal baru.');
    const isTuesday = new Date(`${rosterDate}T00:00:00Z`).getUTCDay() === 2;
    if (isTuesday && !rosterReason.trim()) return showError('Alasan wajib untuk roster hari Selasa.');
    setActionLoading('roster');
    try {
      await api.saveRoster({
        work_date: rosterDate,
        shift_code: rosterShift,
        profile_id: rosterProfileId,
        expected_area: rosterArea || null,
        pay_treatment: rosterPayTreatment,
        override_reason: rosterReason.trim() || null,
      });
      showToast('Jadwal berhasil ditambahkan.');
      setRosterReason('');
      await loadData();
    } catch (err: any) {
      showError(err.message || 'Gagal menambahkan jadwal.');
    } finally {
      setActionLoading('');
    }
  };

  const handleAttendanceReview = async () => {
    if (!attendanceReview || !reviewNote.trim()) return showError('Catatan keputusan wajib diisi.');
    setActionLoading('attendance-review');
    try {
      await api.reviewAttendanceCorrection(attendanceReview.correction.id, attendanceReview.decision, reviewNote.trim());
      showToast(attendanceReview.decision === 'APPROVED' ? 'Koreksi kehadiran disetujui.' : 'Koreksi kehadiran ditolak.');
      setAttendanceReview(null);
      setReviewNote('');
      await loadData();
    } catch (err: any) {
      showError(err.message || 'Gagal menyimpan review koreksi.');
    } finally {
      setActionLoading('');
    }
  };

  const handleOvertimeReview = async () => {
    if (!overtimeReview || !reviewNote.trim()) return showError('Alasan keputusan wajib diisi.');
    setActionLoading('overtime-review');
    try {
      await api.reviewOvertime(overtimeReview.claim.id, overtimeReview.claim.version, overtimeReview.decision, reviewNote.trim());
      showToast(overtimeReview.decision === 'APPROVED' ? 'Lembur disetujui.' : 'Lembur ditolak.');
      setOvertimeReview(null);
      setReviewNote('');
      await loadData();
    } catch (err: any) {
      showError(err.message || 'Gagal menyimpan review lembur.');
    } finally {
      setActionLoading('');
    }
  };

  const handleUpdateUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!userEdit?.display_name.trim() || !userEdit?.job_title.trim()) return showError('Nama dan jabatan wajib diisi.');
    setActionLoading('update-user');
    try {
      await api.updateUser({
        id: userEdit.id,
        expected_version: userEdit.version,
        display_name: userEdit.display_name.trim(),
        role: userEdit.role,
        job_title: userEdit.job_title.trim(),
      });
      setUserEdit(null);
      showToast('Data pengguna diperbarui.');
      await loadData();
    } catch (err: any) {
      showError(err.message || 'Gagal memperbarui pengguna.');
    } finally {
      setActionLoading('');
    }
  };

  const handleDeactivateUser = async () => {
    if (!deactivateTarget || !deactivateReason.trim()) return showError('Alasan penonaktifan wajib diisi.');
    setActionLoading('deactivate-user');
    try {
      const result = await api.deactivateUser(deactivateTarget.id, deactivateTarget.version, deactivateReason.trim());
      setDeactivateTarget(null);
      setDeactivateReason('');
      showToast(`Akun dinonaktifkan. ${result.revoked_sessions} sesi dan ${result.revoked_devices} perangkat dicabut.`);
      await loadData();
    } catch (err: any) {
      showError(err.message || 'Gagal menonaktifkan pengguna.');
    } finally {
      setActionLoading('');
    }
  };

  const handleUpdateSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settings || !settingsDraft || !isOwner) return;
    setActionLoading('settings');
    try {
      await api.updateSettings(settings.version, {
        latitude: settingsDraft.latitude ?? null,
        longitude: settingsDraft.longitude ?? null,
        geofence_radius_m: settingsDraft.geofence_radius_m,
        max_accuracy_m: settingsDraft.max_accuracy_m,
        gps_sample_limit: settingsDraft.gps_sample_limit,
        gps_timeout_seconds: settingsDraft.gps_timeout_seconds,
        late_grace_minutes: settingsDraft.late_grace_minutes,
        overtime_threshold_minutes: settingsDraft.overtime_threshold_minutes,
        raw_gps_retention_days: settingsDraft.raw_gps_retention_days,
        system_mode: settingsDraft.system_mode,
        onboarding_version: settingsDraft.onboarding_version,
      });
      const current = await api.getSettings();
      setSettings(current);
      setSettingsDraft(current);
      showToast(`Pengaturan disimpan sebagai versi ${current.version}.`);
    } catch (err: any) {
      showError(err.message || 'Gagal menyimpan pengaturan. Muat ulang jika versi telah berubah.');
    } finally {
      setActionLoading('');
    }
  };

  return (
    <div className="app-shell management-shell">
      <header className="topbar">
        <div className="brand">
          <span><strong>HOPIN</strong><small>{isInvestor ? 'PORTAL INVESTOR' : 'MANAJEMEN OUTLET'}</small></span>
        </div>
        <div className="topbar-right">
          <div className="avatar" title={user.display_name} style={{ display: 'grid', placeItems: 'center', fontSize: '12px', fontWeight: 700 }}>
            {user.display_name.slice(0, 2).toUpperCase()}
          </div>
          {onEnterOperatorMode && !isInvestor && (
            <button className="outline-button" onClick={onEnterOperatorMode} style={{ fontSize: '12px', padding: '6px 12px' }}>
              Mode Shift ➔
            </button>
          )}
          <button className="logout-button" onClick={onLogout}>
            <span>Keluar</span>
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="welcome">
          <div>
            <p className="eyebrow">{isInvestor ? 'DASHBOARD INVESTOR (READ-ONLY)' : `DASHBOARD ${user.role}`}</p>
            <h1>Halo, {user.display_name}.</h1>
            <p className="muted">
              {isInvestor
                ? 'Pantau ringkasan laporan harian outlet yang telah diserahkan dan diverifikasi.'
                : 'Pusat kendali shift, kehadiran, absensi GPS, stok, laporan, dan payroll.'}
            </p>
          </div>
        </section>

        {!isInvestor && (
          <nav className="tabs" aria-label="Navigasi manajemen">
            <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}>Ringkasan Shift</button>
            <button className={tab === 'roster' ? 'active' : ''} onClick={() => setTab('roster')}>Atur Jadwal</button>
            <button className={tab === 'exceptions' ? 'active' : ''} onClick={() => setTab('exceptions')}>Review Kehadiran</button>
            <button className={tab === 'payroll' ? 'active' : ''} onClick={() => setTab('payroll')}>Kelola Payroll</button>
            <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Kelola Akun</button>
            <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Pengaturan</button>
          </nav>
        )}

        {receipt && (
          <div
            role={receipt.error ? 'alert' : 'status'}
            style={{ marginBottom: '16px', padding: '12px 14px', borderRadius: '8px', border: `1px solid ${receipt.error ? '#fecaca' : '#bbf7d0'}`, background: receipt.error ? '#fef2f2' : '#f0fdf4', color: receipt.error ? '#991b1b' : '#166534', display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}
          >
            <span>{receipt.message}</span>
            <button type="button" className="outline-button" onClick={() => setReceipt(null)} aria-label="Tutup pemberitahuan" style={{ padding: '4px 9px' }}>Tutup</button>
          </div>
        )}

        {loading && (
          <div role="status" style={{ marginBottom: '16px', padding: '12px 14px', borderRadius: '8px', background: '#f8faf9', border: '1px solid #e0ece6' }}>
            Memuat data terbaru...
          </div>
        )}

        {viewError && (
          <div role="alert" style={{ marginBottom: '16px', padding: '12px 14px', borderRadius: '8px', border: '1px solid #fecaca', background: '#fef2f2', color: '#991b1b', display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
            <span>{viewError}</span>
            <button type="button" className="outline-button" onClick={() => void loadData()} disabled={loading}>Coba lagi</button>
          </div>
        )}

        {/* 1. DASHBOARD OVERVIEW */}
        {tab === 'dashboard' && !isInvestor && (
          <div style={{ display: 'grid', gap: '16px' }}>
            <div className="section-card">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">OPERASIONAL HARI INI</p>
                  <h2>Status Shift & Area</h2>
                </div>
                <span className="tag neutral">{wibDate()}</span>
              </div>

              {!loading && !viewError && (dashboardData?.cycles ?? []).length === 0 ? (
                <p className="muted" style={{ padding: '24px', textAlign: 'center' }}>Belum ada shift operasional hari ini.</p>
              ) : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px', marginTop: '16px' }}>
                {(dashboardData?.cycles ?? []).map((c: any) => {
                  const assigned = c.work_assignments ?? [];
                  const primary = assigned.find((a: any) => a.duty_role === 'PRIMARY');
                  const helpers = assigned.filter((a: any) => a.duty_role === 'HELPER');

                  return (
                    <div key={c.id} style={{ padding: '14px', background: '#f8faf9', borderRadius: '10px', border: '1px solid #e0ece6' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <strong>{taskLabel(c.shift_code)} · {taskLabel(c.area_code)}</strong>
                        <span className={`tag ${c.status === 'COMPLETED' ? 'good' : 'neutral'}`}>{taskLabel(c.status)}</span>
                      </div>
                      <small style={{ display: 'block', color: '#6b8378' }}>
                        PJ Utama: <b>{primary ? primary.profiles?.display_name : 'Belum Terisi'}</b>
                      </small>
                      {helpers.length > 0 && (
                        <small style={{ display: 'block', color: '#6b8378', marginTop: '4px' }}>
                          Bantuan: {helpers.map((h: any) => h.profiles?.display_name).join(', ')}
                        </small>
                      )}
                    </div>
                  );
                })}
              </div>}
            </div>
          </div>
        )}

        {/* 2. ROSTER */}
        {tab === 'roster' && !isInvestor && (
          <div style={{ display: 'grid', gap: '16px' }}>
            <div className="section-card">
              <div className="section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                  <p className="eyebrow">JADWAL KERJA BULANAN</p>
                  <h2>Lihat dan Tambah Jadwal</h2>
                </div>
                <label style={{ ...labelStyle, marginBottom: 0 }}>
                  Bulan
                  <input type="month" value={rosterMonth} onChange={(event) => setRosterMonth(event.target.value)} style={{ ...inputStyle, marginTop: '4px' }} />
                </label>
              </div>

              {!loading && !viewError && roster.length === 0 ? (
                <p className="muted" style={{ padding: '24px', textAlign: 'center' }}>Belum ada jadwal pada bulan ini. Tambahkan jadwal lewat formulir di bawah.</p>
              ) : (
                <div className="table-responsive" style={{ marginTop: '16px' }}>
                  <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead><tr style={{ borderBottom: '1px solid #cddcd4', color: '#6b8378' }}>
                      <th style={{ padding: '8px' }}>Tanggal</th><th style={{ padding: '8px' }}>Petugas</th><th style={{ padding: '8px' }}>Shift</th><th style={{ padding: '8px' }}>Area</th><th style={{ padding: '8px' }}>Perlakuan upah</th><th style={{ padding: '8px' }}>Status</th>
                    </tr></thead>
                    <tbody>{roster.map((entry) => (
                      <tr key={entry.id} style={{ borderBottom: '1px solid #eef3f0' }}>
                        <td style={{ padding: '8px' }}>{entry.work_date}</td>
                        <td style={{ padding: '8px', fontWeight: 600 }}>{entry.profiles?.display_name ?? entry.profiles?.username ?? 'Pengguna tidak ditemukan'}</td>
                        <td style={{ padding: '8px' }}>{taskLabel(entry.shift_code)}</td>
                        <td style={{ padding: '8px' }}>{entry.expected_area ? taskLabel(entry.expected_area) : 'Fleksibel'}</td>
                        <td style={{ padding: '8px' }}>{taskLabel(entry.pay_treatment)}</td>
                        <td style={{ padding: '8px' }}><span className={`tag ${entry.status === 'COMPLETED' ? 'good' : 'neutral'}`}>{taskLabel(entry.status)}</span></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="section-card">
              <div className="section-heading"><div><p className="eyebrow">JADWAL BARU</p><h2>Tambahkan Satu Jadwal</h2></div></div>
              <form onSubmit={handleCreateRoster} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginTop: '16px' }}>
                <label style={labelStyle}>Tanggal<input required type="date" value={rosterDate} onChange={(event) => setRosterDate(event.target.value)} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                <label style={labelStyle}>Petugas<select required value={rosterProfileId} onChange={(event) => setRosterProfileId(event.target.value)} style={{ ...inputStyle, marginTop: '4px' }}><option value="">Pilih petugas</option>{usersList.filter((entry) => entry.role !== 'INVESTOR').map((entry) => <option key={entry.id} value={entry.id}>{entry.display_name} · {taskLabel(entry.role)}</option>)}</select></label>
                <label style={labelStyle}>Shift<select value={rosterShift} onChange={(event) => setRosterShift(event.target.value as typeof rosterShift)} style={{ ...inputStyle, marginTop: '4px' }}><option value="SIANG">Shift siang</option><option value="MALAM">Shift malam</option><option value="FULL">Shift penuh</option></select></label>
                <label style={labelStyle}>Area yang diharapkan<select value={rosterArea} onChange={(event) => setRosterArea(event.target.value as typeof rosterArea)} style={{ ...inputStyle, marginTop: '4px' }}><option value="">Fleksibel</option><option value="BAR">Area bar</option><option value="KITCHEN">Area dapur</option></select></label>
                <label style={labelStyle}>Perlakuan upah<select value={rosterPayTreatment} onChange={(event) => setRosterPayTreatment(event.target.value as typeof rosterPayTreatment)} style={{ ...inputStyle, marginTop: '4px' }}><option value="BASE">Jadwal reguler</option><option value="EXTRA">Hari kerja tambahan</option><option value="MAKEUP">Pengganti hari kerja</option></select></label>
                <label style={{ ...labelStyle, gridColumn: '1 / -1' }}>Alasan khusus <span className="muted">(wajib untuk hari Selasa)</span><textarea value={rosterReason} onChange={(event) => setRosterReason(event.target.value)} rows={2} maxLength={500} placeholder="Jelaskan perubahan atau perlakuan jadwal khusus." style={{ ...inputStyle, marginTop: '4px', resize: 'vertical' }} /></label>
                <div style={{ gridColumn: '1 / -1' }}><button type="submit" className="primary-button" disabled={actionLoading === 'roster'}>{actionLoading === 'roster' ? 'Menyimpan...' : 'Tambahkan Jadwal'}</button></div>
              </form>
            </div>
          </div>
        )}

        {/* 3. EXCEPTIONS & ATTENDANCE */}
        {tab === 'exceptions' && !isInvestor && (
          <div style={{ display: 'grid', gap: '16px' }}>
            <div className="section-card">
              <div className="section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', flexWrap: 'wrap', gap: '12px' }}>
                <div><p className="eyebrow">RENTANG REVIEW</p><h2>Tugas Kehadiran</h2></div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'end', flexWrap: 'wrap' }}>
                  <label style={labelStyle}>Dari<input type="date" value={reviewFrom} onChange={(event) => setReviewFrom(event.target.value)} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                  <label style={labelStyle}>Sampai<input type="date" value={reviewTo} onChange={(event) => setReviewTo(event.target.value)} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                  <button type="button" className="outline-button" onClick={() => void loadData()} disabled={loading}>Terapkan</button>
                </div>
              </div>
            </div>

            <div className="section-card">
              <div className="section-heading"><div><p className="eyebrow">EXCEPTION & KOREKSI</p><h2>Review Koreksi Kehadiran</h2></div></div>
              {!loading && !viewError && attendanceExceptions.length === 0 ? (
                <p className="muted" style={{ padding: '24px', textAlign: 'center' }}>Tidak ada exception kehadiran pada rentang ini.</p>
              ) : <div className="table-responsive" style={{ marginTop: '16px' }}>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead><tr style={{ borderBottom: '1px solid #cddcd4', color: '#6b8378' }}><th style={{ padding: '8px' }}>Kehadiran</th><th style={{ padding: '8px' }}>Masalah</th><th style={{ padding: '8px' }}>Usulan koreksi</th><th style={{ padding: '8px' }}>Alasan</th><th style={{ padding: '8px' }}>Aksi</th></tr></thead>
                  <tbody>{attendanceExceptions.map((attendance) => {
                    const pending = (attendance.attendance_corrections ?? []).filter((correction: any) => correction.status === 'PENDING');
                    return (
                      <tr key={attendance.id} style={{ borderBottom: '1px solid #eef3f0', verticalAlign: 'top' }}>
                        <td style={{ padding: '8px' }}><strong>{attendance.profiles?.display_name ?? 'Pengguna'}</strong><br /><span className="muted">{attendance.work_date} · {taskLabel(attendance.status)}</span></td>
                        <td style={{ padding: '8px' }}>{taskLabel(attendance.lateness_status)}<br /><span className="muted">{taskLabel(attendance.exception_status)}</span></td>
                        <td style={{ padding: '8px' }}>{pending.length ? pending.map((correction: any) => <div key={correction.id}><strong>{taskLabel(correction.correction_type)}:</strong> {proposedLabel(correction)}</div>) : 'Belum ada permintaan koreksi'}</td>
                        <td style={{ padding: '8px', color: '#6b8378' }}>{pending.map((correction: any) => <div key={correction.id}>{correction.reason}</div>)}</td>
                        <td style={{ padding: '8px' }}>{pending.map((correction: any) => correction.requested_by === user.id || attendance.profile_id === user.id ? <span key={correction.id} className="muted">Reviewer lain diperlukan</span> : <div key={correction.id} style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' }}><button type="button" className="outline-button" onClick={() => { setReviewNote(''); setAttendanceReview({ attendance, correction, decision: 'APPROVED' }); }} style={{ padding: '5px 8px', fontSize: '11px' }}>Setujui</button><button type="button" className="outline-button" onClick={() => { setReviewNote(''); setAttendanceReview({ attendance, correction, decision: 'REJECTED' }); }} style={{ padding: '5px 8px', fontSize: '11px', color: '#b91c1c', borderColor: '#fecaca' }}>Tolak</button></div>)}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>}
            </div>

            <div className="section-card">
              <div className="section-heading"><div><p className="eyebrow">DURASI KERJA TAMBAHAN</p><h2>Review Lembur</h2></div></div>
              {!loading && !viewError && overtime.length === 0 ? (
                <p className="muted" style={{ padding: '24px', textAlign: 'center' }}>Tidak ada catatan lembur pada rentang ini.</p>
              ) : <div className="table-responsive" style={{ marginTop: '16px' }}>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead><tr style={{ borderBottom: '1px solid #cddcd4', color: '#6b8378' }}><th style={{ padding: '8px' }}>Petugas</th><th style={{ padding: '8px' }}>Tanggal</th><th style={{ padding: '8px' }}>Durasi terdeteksi</th><th style={{ padding: '8px' }}>Kredit</th><th style={{ padding: '8px' }}>Status</th><th style={{ padding: '8px' }}>Aksi</th></tr></thead>
                  <tbody>{overtime.map((claim) => {
                    const attendance = claim.attendance_records;
                    return <tr key={claim.id} style={{ borderBottom: '1px solid #eef3f0' }}><td style={{ padding: '8px', fontWeight: 600 }}>{attendance?.profiles?.display_name ?? 'Pengguna'}</td><td style={{ padding: '8px' }}>{attendance?.work_date}</td><td style={{ padding: '8px' }}>{claim.raw_extra_minutes} menit</td><td style={{ padding: '8px' }}>{claim.credited_hours} jam</td><td style={{ padding: '8px' }}><span className={`tag ${claim.status === 'APPROVED' ? 'good' : claim.status === 'REJECTED' ? 'neutral' : 'warn'}`}>{taskLabel(claim.status)}</span></td><td style={{ padding: '8px' }}>{claim.status === 'CANDIDATE' && (attendance?.profile_id === user.id ? <span className="muted">Reviewer lain diperlukan</span> : <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}><button type="button" className="outline-button" onClick={() => { setReviewNote(''); setOvertimeReview({ claim, decision: 'APPROVED' }); }} style={{ padding: '5px 8px', fontSize: '11px' }}>Setujui</button><button type="button" className="outline-button" onClick={() => { setReviewNote(''); setOvertimeReview({ claim, decision: 'REJECTED' }); }} style={{ padding: '5px 8px', fontSize: '11px', color: '#b91c1c', borderColor: '#fecaca' }}>Tolak</button></div>)}</td></tr>;
                  })}</tbody>
                </table>
              </div>}
            </div>
          </div>
        )}

        {/* 3. PAYROLL & EXCEL */}
        {tab === 'payroll' && !isInvestor && (
          <div className="section-card">
            <div className="section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
              <div>
                <p className="eyebrow">REKAP GAJI & BONUS OMZET</p>
                <h2>Payroll Evidence & Lifecycle</h2>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <label style={{ fontSize: '13px', fontWeight: 600 }}>Periode:</label>
                <input
                  type="month"
                  value={payrollPeriod}
                  onChange={(e) => setPayrollPeriod(e.target.value)}
                  style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid #cddcd4', fontSize: '13px' }}
                />
              </div>
            </div>

            {/* Run Status Banner */}
            <div style={{ margin: '16px 0', padding: '16px', background: '#f8faf9', borderRadius: '8px', border: '1px solid #e0ece6' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                <div>
                  <span style={{ fontSize: '12px', color: '#6b8378', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Status Siklus:</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                    <span className={`tag ${
                      payrollRun?.status === 'PAID' ? 'good' :
                      payrollRun?.status === 'FINALIZED' ? 'good' :
                      payrollRun?.status === 'REVIEWED' ? 'neutral' :
                      payrollRun?.status === 'DRAFT' ? 'warn' : 'neutral'
                    }`} style={{ fontSize: '13px', fontWeight: 700 }}>
                      {payrollRun ? taskLabel(payrollRun.status) : 'Belum dibuat'}
                    </span>
                    {payrollRun && (
                      <span style={{ fontSize: '12px', color: '#6b8378' }}>
                        (Versi {payrollRun.version} • {payrollEntries.length} Karyawan)
                      </span>
                    )}
                  </div>
                </div>

                {/* Lifecycle Action Buttons */}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {/* Generate / Rebuild Draft */}
                  {(!payrollRun || payrollRun.status === 'DRAFT') && (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={handlePreviewPayroll}
                      disabled={payrollLoading}
                      style={{ fontSize: '12px', padding: '6px 12px' }}
                    >
                      {payrollLoading ? 'Menghitung...' : payrollRun ? 'Hitung Ulang Draft' : 'Buat Draft Payroll'}
                    </button>
                  )}

                  {/* Move Draft to Reviewed */}
                  {payrollRun?.status === 'DRAFT' && (
                    <button
                      type="button"
                      className="outline-button"
                      onClick={handleReviewPayroll}
                      disabled={payrollLoading}
                      style={{ fontSize: '12px', padding: '6px 12px', borderColor: '#2563eb', color: '#2563eb' }}
                    >
                      Selesaikan Review
                    </button>
                  )}

                  {/* Owner Finalize */}
                  {isOwner && payrollRun?.status === 'REVIEWED' && (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => setShowFinalizeModal(true)}
                      disabled={payrollLoading}
                      style={{ fontSize: '12px', padding: '6px 12px', background: '#059669' }}
                    >
                      Kunci Payroll
                    </button>
                  )}

                  {/* Owner Mark Paid */}
                  {isOwner && payrollRun?.status === 'FINALIZED' && (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => setShowPayModal(true)}
                      disabled={payrollLoading}
                      style={{ fontSize: '12px', padding: '6px 12px', background: '#0d9488' }}
                    >
                      Tandai Sudah Dibayar
                    </button>
                  )}

                  {/* Owner Void */}
                  {isOwner && payrollRun && ['REVIEWED', 'FINALIZED', 'PAID'].includes(payrollRun.status) && (
                    <button
                      type="button"
                      className="outline-button"
                      onClick={() => setShowVoidModal(true)}
                      disabled={payrollLoading}
                      style={{ fontSize: '12px', padding: '6px 12px', borderColor: '#dc2626', color: '#dc2626' }}
                    >
                      Batalkan Payroll
                    </button>
                  )}

                  {/* Export XLSX */}
                  <button
                    type="button"
                    className="outline-button"
                    onClick={handleExportPayroll}
                    disabled={payrollLoading || !payrollRun || !['REVIEWED', 'FINALIZED', 'PAID'].includes(payrollRun.status)}
                    style={{ fontSize: '12px', padding: '6px 12px' }}
                  >
                    Ekspor XLSX
                  </button>
                </div>
              </div>

              {payrollRun?.payload_checksum && (
                <p style={{ margin: '8px 0 0', fontSize: '11px', color: '#6b8378', fontFamily: 'monospace' }}>
                  Checksum SHA-256: {payrollRun.payload_checksum.slice(0, 24)}...
                </p>
              )}
            </div>

            {/* Entries Table */}
            {payrollEntries.length > 0 ? (
              <div className="table-responsive" style={{ marginTop: '16px' }}>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #cddcd4', color: '#6b8378' }}>
                      <th style={{ padding: '8px' }}>Karyawan</th>
                      <th style={{ padding: '8px' }}>Jabatan</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Gaji Pokok</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Lembur</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Potongan</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Bonus Omzet</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Gaji Bruto</th>
                      <th style={{ padding: '8px', textAlign: 'center' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payrollEntries.map((e) => (
                      <tr key={e.id} style={{ borderBottom: '1px solid #eef3f0' }}>
                        <td style={{ padding: '8px', fontWeight: 600 }}>{e.profiles?.display_name}</td>
                        <td style={{ padding: '8px', color: '#6b8378' }}>{e.profiles?.job_title || 'STAFF'}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>{fmtRupiah(e.base_amount)}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>{fmtRupiah(e.approved_overtime_amount)}</td>
                        <td style={{ padding: '8px', textAlign: 'right', color: Number(e.absence_deduction) > 0 ? '#dc2626' : undefined }}>
                          {fmtRupiah(e.absence_deduction)}
                        </td>
                        <td style={{ padding: '8px', textAlign: 'right', color: '#059669' }}>{fmtRupiah(e.bonus_amount)}</td>
                        <td style={{ padding: '8px', textAlign: 'right', fontWeight: 700 }}>
                          {fmtRupiah(payrollRun?.status === 'FINALIZED' || payrollRun?.status === 'PAID' ? e.final_gross : e.proposed_gross)}
                        </td>
                        <td style={{ padding: '8px', textAlign: 'center' }}>
                          <span className={`tag ${e.status === 'APPROVED' ? 'good' : 'neutral'}`} style={{ fontSize: '11px' }}>
                            {taskLabel(e.status)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted" style={{ padding: '24px', textAlign: 'center' }}>
                {payrollRun ? 'Belum ada entri karyawan terdaftar pada payroll ini.' : 'Pilih periode dan klik "Buat Draft Payroll" untuk menghitung kompensasi.'}
              </p>
            )}

            {payrollLoading && <p role="status" className="muted" style={{ padding: '12px', textAlign: 'center' }}>Memproses payroll...</p>}

            {/* Modal Mark Paid */}
            {showPayModal && (
              <Dialog titleId="payroll-paid-title" title="Catat Payroll Sudah Dibayar" onClose={() => setShowPayModal(false)}>
                  <p className="muted" style={{ fontSize: '12px', margin: '0 0 16px' }}>
                    Pastikan seluruh transfer telah berhasil dieksekusi sebelum mencatat bukti pembayaran.
                  </p>
                  <label style={labelStyle} htmlFor="payment-reference">Referensi pembayaran</label>
                  <input
                    id="payment-reference"
                    type="text"
                    value={paymentRef}
                    onChange={(e) => setPaymentRef(e.target.value)}
                    placeholder="Contoh: BCA-TRX-20260903-8891"
                    style={{ ...inputStyle, marginBottom: '12px' }}
                  />
                  <label style={labelStyle} htmlFor="payment-reason">Keterangan pembayaran</label>
                  <textarea
                    id="payment-reason"
                    value={paymentReason}
                    onChange={(e) => setPaymentReason(e.target.value)}
                    placeholder="Contoh: Pembayaran payroll via transfer batch BCA."
                    rows={3}
                    style={{ ...inputStyle, marginBottom: '16px', resize: 'vertical' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                    <button type="button" className="outline-button" onClick={() => setShowPayModal(false)}>Batal</button>
                    <button type="button" className="primary-button" onClick={handleMarkPaid} disabled={payrollLoading}>
                      {payrollLoading ? 'Menyimpan...' : 'Simpan Bukti Pembayaran'}
                    </button>
                  </div>
              </Dialog>
            )}

            {/* Modal Void */}
            {showVoidModal && (
              <Dialog titleId="payroll-void-title" title="Batalkan Payroll" onClose={() => setShowVoidModal(false)}>
                  <p className="muted" style={{ fontSize: '12px', margin: '0 0 16px' }}>
                    Payroll saat ini akan dinonaktifkan secara permanen dan sistem akan membuat satu draft pengganti baru.
                  </p>
                  <label style={labelStyle} htmlFor="void-reason">Alasan pembatalan</label>
                  <textarea
                    id="void-reason"
                    value={voidReason}
                    onChange={(e) => setVoidReason(e.target.value)}
                    placeholder="Contoh: Ada koreksi absensi susulan untuk shift malam tgl 28."
                    rows={3}
                    style={{ ...inputStyle, marginBottom: '16px', resize: 'vertical' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                    <button type="button" className="outline-button" onClick={() => setShowVoidModal(false)}>Batal</button>
                    <button type="button" className="primary-button" onClick={handleVoidPayroll} disabled={payrollLoading} style={{ background: '#dc2626' }}>
                      {payrollLoading ? 'Membatalkan...' : 'Batalkan dan Buat Draft Pengganti'}
                    </button>
                  </div>
              </Dialog>
            )}

            {showFinalizeModal && (
              <Dialog titleId="payroll-finalize-title" title="Kunci Payroll?" onClose={() => setShowFinalizeModal(false)}>
                <p className="muted" style={{ fontSize: '13px', margin: '0 0 18px' }}>Seluruh entri dan nilai gaji periode {payrollPeriod} akan dikunci. Tindakan ini tidak dapat dibatalkan lewat hitung ulang.</p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}><button type="button" className="outline-button" onClick={() => setShowFinalizeModal(false)}>Kembali</button><button type="button" className="primary-button" onClick={handleFinalizePayroll} disabled={payrollLoading}>{payrollLoading ? 'Mengunci...' : 'Ya, Kunci Payroll'}</button></div>
              </Dialog>
            )}
          </div>
        )}

        {/* 4. USERS MANAGEMENT */}
        {tab === 'users' && !isInvestor && (
          <div className="section-card">
            <div className="section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
              <div>
                <p className="eyebrow">MANAJEMEN PENGGUNA</p>
                <h2>Daftar Akun & Hak Akses</h2>
              </div>
              {isOwner && (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    setNewUsername('');
                    setNewDisplayName('');
                    setNewRole('OPERATOR');
                    setNewJobTitle('BARISTA');
                    setShowCreateUserModal(true);
                  }}
                   style={{ fontSize: '12px', padding: '7px 14px' }}
                 >
                  Tambah Pengguna
                 </button>
               )}
             </div>

            {!loading && !viewError && usersList.length === 0 ? (
              <p className="muted" style={{ padding: '24px', textAlign: 'center' }}>Tidak ada akun yang dapat dikelola.</p>
            ) : <div className="table-responsive" style={{ marginTop: '16px' }}>
              <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #cddcd4', color: '#6b8378' }}>
                    <th style={{ padding: '8px' }}>Nama Lengkap</th>
                    <th style={{ padding: '8px' }}>Username</th>
                    <th style={{ padding: '8px' }}>Akses & jabatan</th>
                    <th style={{ padding: '8px' }}>Status PIN</th>
                    <th style={{ padding: '8px', textAlign: 'right' }}>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {usersList.map((u) => (
                    <tr key={u.id} style={{ borderBottom: '1px solid #eef3f0' }}>
                      <td style={{ padding: '8px', fontWeight: 600 }}>{u.display_name}</td>
                      <td style={{ padding: '8px' }}>{u.username}</td>
                      <td style={{ padding: '8px' }}>
                        <span className="tag neutral">{taskLabel(u.role)}</span><br /><span className="muted">{u.job_title || 'Jabatan belum diisi'}</span>
                      </td>
                      <td style={{ padding: '8px' }}>
                        {u.force_pin_change ? <span style={{ color: '#d97706' }}>Wajib Ganti</span> : 'Aktif'}
                      </td>
                      <td style={{ padding: '8px', textAlign: 'right' }}>
                        {isOwner ? <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', flexWrap: 'wrap' }}>
                          <button type="button" className="outline-button" onClick={() => setUserEdit({ ...u })} style={{ fontSize: '11px', padding: '5px 8px' }}>Ubah</button>
                          {u.id !== user.id && <button type="button" className="outline-button" onClick={() => setResetTarget(u)} style={{ fontSize: '11px', padding: '5px 8px' }}>Reset PIN</button>}
                          {u.id !== user.id && <button type="button" className="outline-button" onClick={() => { setDeactivateReason(''); setDeactivateTarget(u); }} style={{ fontSize: '11px', padding: '5px 8px', color: '#b91c1c', borderColor: '#fecaca' }}>Nonaktifkan</button>}
                        </div> : <span className="muted">Hanya dapat dilihat</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}

            {/* Modal Tambah User */}
            {showCreateUserModal && (
              <Dialog titleId="create-user-title" title="Tambah Pengguna" onClose={() => setShowCreateUserModal(false)}>
                  <p className="muted" style={{ fontSize: '12px', margin: '0 0 16px' }}>
                    Pengguna baru akan otomatis mendapatkan PIN sementara 6 digit untuk login pertama kali.
                  </p>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (!newUsername.trim() || !newDisplayName.trim()) {
                          showError('Username dan nama tampilan wajib diisi.');
                          return;
                        }
                        setActionLoading('create-user');
                        try {
                          const res = await api.createUser({
                            username: newUsername.trim().toLowerCase(),
                            display_name: newDisplayName.trim(),
                            role: newRole,
                            job_title: newJobTitle.trim() || 'STAFF',
                          });
                          setShowCreateUserModal(false);
                          setOneTimeSecret({ username: res.user.username, pin: res.initial_pin });
                          await loadData();
                        } catch (err: any) {
                          showError(err.message || 'Gagal membuat pengguna baru.');
                        } finally {
                          setActionLoading('');
                        }
                      }}
                    >
                      <label style={labelStyle} htmlFor="new-display-name">Nama lengkap</label>
                      <input
                        id="new-display-name"
                        type="text"
                        value={newDisplayName}
                        onChange={(e) => setNewDisplayName(e.target.value)}
                        placeholder="Contoh: Jezy Supervisor"
                        required
                        style={{ ...inputStyle, marginBottom: '12px' }}
                      />

                      <label style={labelStyle} htmlFor="new-username">Username</label>
                      <input
                        id="new-username"
                        type="text"
                        value={newUsername}
                        onChange={(e) => setNewUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
                        placeholder="Contoh: jezy"
                        required
                        style={{ ...inputStyle, marginBottom: '12px' }}
                      />

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
                        <div>
                          <label style={labelStyle} htmlFor="new-role">Hak akses</label>
                          <select
                            id="new-role"
                            value={newRole}
                            onChange={(e) => setNewRole(e.target.value as any)}
                            style={inputStyle}
                          >
                            <option value="OPERATOR">Operator</option>
                            <option value="SUPERVISOR">Supervisor</option>
                            <option value="INVESTOR">Investor</option>
                            <option value="OWNER">Pemilik</option>
                          </select>
                        </div>
                        <div>
                          <label style={labelStyle} htmlFor="new-job-title">Jabatan</label>
                          <input
                            id="new-job-title"
                            type="text"
                            value={newJobTitle}
                            onChange={(e) => setNewJobTitle(e.target.value)}
                            placeholder="Contoh: BARISTA"
                            style={inputStyle}
                          />
                        </div>
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                        <button type="button" className="outline-button" onClick={() => setShowCreateUserModal(false)}>Batal</button>
                        <button type="submit" className="primary-button" disabled={actionLoading === 'create-user'}>
                          {actionLoading === 'create-user' ? 'Membuat Akun...' : 'Simpan Pengguna'}
                        </button>
                      </div>
                    </form>
              </Dialog>
            )}
          </div>
        )}

        {/* 5. SETTINGS */}
        {tab === 'settings' && !isInvestor && (
          <div className="section-card">
            <div className="section-heading">
              <div><p className="eyebrow">KONFIGURASI OUTLET · VERSI {settings?.version ?? '-'}</p><h2>{isOwner ? 'Ubah Pengaturan Operasional' : 'Lihat Pengaturan Operasional'}</h2></div>
            </div>
            {!loading && !viewError && !settingsDraft ? <p className="muted" style={{ padding: '24px', textAlign: 'center' }}>Pengaturan outlet belum tersedia.</p> : settingsDraft && (
              <form onSubmit={handleUpdateSettings} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '12px', marginTop: '16px' }}>
                <label style={labelStyle}>Mode sistem<select disabled={!isOwner} value={settingsDraft.system_mode} onChange={(event) => setSettingsDraft({ ...settingsDraft, system_mode: event.target.value as Settings['system_mode'] })} style={{ ...inputStyle, marginTop: '4px' }}><option value="PRODUCTION">Produksi</option><option value="PILOT">Uji coba</option><option value="MAINTENANCE">Pemeliharaan</option></select></label>
                <label style={labelStyle}>Latitude<input disabled={!isOwner} required={isOwner} type="number" min={-90} max={90} step="any" value={settingsDraft.latitude ?? ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, latitude: event.target.value === '' ? null : Number(event.target.value) })} placeholder={isOwner ? '-6.200000' : 'Disembunyikan untuk Supervisor'} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                <label style={labelStyle}>Longitude<input disabled={!isOwner} required={isOwner} type="number" min={-180} max={180} step="any" value={settingsDraft.longitude ?? ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, longitude: event.target.value === '' ? null : Number(event.target.value) })} placeholder={isOwner ? '106.816666' : 'Disembunyikan untuk Supervisor'} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                <label style={labelStyle}>Radius geofence (10-10.000 meter)<input disabled={!isOwner} required type="number" min={10} max={10000} value={settingsDraft.geofence_radius_m} onChange={(event) => setSettingsDraft({ ...settingsDraft, geofence_radius_m: Number(event.target.value) })} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                <label style={labelStyle}>Akurasi GPS maksimum (5-500 meter)<input disabled={!isOwner} required type="number" min={5} max={500} value={settingsDraft.max_accuracy_m} onChange={(event) => setSettingsDraft({ ...settingsDraft, max_accuracy_m: Number(event.target.value) })} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                <label style={labelStyle}>Jumlah sampel GPS (1-10)<input disabled={!isOwner} required type="number" min={1} max={10} value={settingsDraft.gps_sample_limit} onChange={(event) => setSettingsDraft({ ...settingsDraft, gps_sample_limit: Number(event.target.value) })} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                <label style={labelStyle}>Batas waktu GPS (5-60 detik)<input disabled={!isOwner} required type="number" min={5} max={60} value={settingsDraft.gps_timeout_seconds} onChange={(event) => setSettingsDraft({ ...settingsDraft, gps_timeout_seconds: Number(event.target.value) })} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                <label style={labelStyle}>Toleransi terlambat (0-1.440 menit)<input disabled={!isOwner} required type="number" min={0} max={1440} value={settingsDraft.late_grace_minutes} onChange={(event) => setSettingsDraft({ ...settingsDraft, late_grace_minutes: Number(event.target.value) })} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                <label style={labelStyle}>Ambang lembur (0-1.440 menit)<input disabled={!isOwner} required type="number" min={0} max={1440} value={settingsDraft.overtime_threshold_minutes} onChange={(event) => setSettingsDraft({ ...settingsDraft, overtime_threshold_minutes: Number(event.target.value) })} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                <label style={labelStyle}>Retensi GPS mentah (7-365 hari)<input disabled={!isOwner} required type="number" min={7} max={365} value={settingsDraft.raw_gps_retention_days} onChange={(event) => setSettingsDraft({ ...settingsDraft, raw_gps_retention_days: Number(event.target.value) })} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                <label style={labelStyle}>Versi onboarding<input disabled={!isOwner} required type="number" min={1} value={settingsDraft.onboarding_version} onChange={(event) => setSettingsDraft({ ...settingsDraft, onboarding_version: Number(event.target.value) })} style={{ ...inputStyle, marginTop: '4px' }} /></label>
                <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>{isOwner ? <><button type="submit" className="primary-button" disabled={actionLoading === 'settings'}>{actionLoading === 'settings' ? 'Menyimpan...' : 'Simpan Pengaturan'}</button><button type="button" className="outline-button" onClick={() => setSettingsDraft(settings)}>Batalkan Perubahan</button></> : <p className="muted">Koordinat presisi disembunyikan. Hanya Pemilik dapat mengubah pengaturan.</p>}</div>
              </form>
            )}
          </div>
        )}

        {/* 6. INVESTOR REPORTS VIEW */}
        {(tab === 'reports' || isInvestor) && (
          <div className="section-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">REKAP OPERASIONAL OUTLET</p>
                <h2>Laporan Harian Diterima</h2>
              </div>
            </div>

            <div style={{ display: 'grid', gap: '16px', marginTop: '16px' }}>
              {!loading && !viewError && investorReports.length === 0 ? (
                <p className="muted" style={{ padding: '24px', textAlign: 'center' }}>Belum ada laporan harian yang diserahkan.</p>
              ) : (
                investorReports.map((rep) => {
                  const rev = rep.daily_report_revisions?.[0];
                  const fin = rev?.daily_report_finance;

                  return (
                    <div key={rep.id} style={{ padding: '16px', background: '#f8faf9', borderRadius: '10px', border: '1px solid #e0ece6' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <div>
                          <strong>{rep.work_date}</strong>
                          <span style={{ marginLeft: '8px', fontSize: '12px', color: '#6b8378' }}>
                            Revisi #{rep.current_revision} ({rev?.public_id || 'HOP-R01'})
                          </span>
                        </div>
                        <span className={`tag ${rep.status === 'APPROVED' ? 'good' : 'neutral'}`}>
                          {rep.status === 'APPROVED' ? 'Telah Diverifikasi' : 'Belum Ditinjau'}
                        </span>
                      </div>

                      {fin && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px', fontSize: '13px' }}>
                          <div><span className="muted">Total Transaksi:</span> <b>{fmtRupiah(fin.recorded_total)}</b></div>
                          <div><span className="muted">Uang Aktual:</span> <b>{fmtRupiah(fin.received_total)}</b></div>
                          <div><span className="muted">Selisih Kas:</span> <b style={{ color: fin.cash_difference < 0 ? '#b91c1c' : '#1e5b48' }}>{fmtRupiah(fin.cash_difference)}</b></div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {attendanceReview && (
          <Dialog titleId="attendance-review-title" title={`${attendanceReview.decision === 'APPROVED' ? 'Setujui' : 'Tolak'} Koreksi Kehadiran`} onClose={() => { setAttendanceReview(null); setReviewNote(''); }}>
            <p style={{ margin: '0 0 4px' }}><strong>{attendanceReview.attendance.profiles?.display_name}</strong> · {attendanceReview.attendance.work_date}</p>
            <p className="muted" style={{ fontSize: '13px', margin: '0 0 16px' }}>{taskLabel(attendanceReview.correction.correction_type)} menjadi <strong>{proposedLabel(attendanceReview.correction)}</strong>. Alasan pemohon: {attendanceReview.correction.reason}</p>
            <label style={labelStyle} htmlFor="attendance-review-note">Catatan keputusan</label>
            <textarea id="attendance-review-note" required maxLength={1000} rows={3} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="Tuliskan dasar keputusan review." style={{ ...inputStyle, resize: 'vertical', marginBottom: '16px' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}><button type="button" className="outline-button" onClick={() => { setAttendanceReview(null); setReviewNote(''); }}>Batal</button><button type="button" className="primary-button" onClick={handleAttendanceReview} disabled={actionLoading === 'attendance-review'} style={attendanceReview.decision === 'REJECTED' ? { background: '#b91c1c' } : undefined}>{actionLoading === 'attendance-review' ? 'Menyimpan...' : attendanceReview.decision === 'APPROVED' ? 'Setujui Koreksi' : 'Tolak Koreksi'}</button></div>
          </Dialog>
        )}

        {overtimeReview && (
          <Dialog titleId="overtime-review-title" title={`${overtimeReview.decision === 'APPROVED' ? 'Setujui' : 'Tolak'} Lembur`} onClose={() => { setOvertimeReview(null); setReviewNote(''); }}>
            <p style={{ margin: '0 0 4px' }}><strong>{overtimeReview.claim.attendance_records?.profiles?.display_name}</strong> · {overtimeReview.claim.attendance_records?.work_date}</p>
            <p className="muted" style={{ fontSize: '13px', margin: '0 0 16px' }}>{overtimeReview.claim.raw_extra_minutes} menit tambahan terdeteksi. Kredit server: {overtimeReview.claim.credited_hours} jam.</p>
            <label style={labelStyle} htmlFor="overtime-review-note">Alasan keputusan</label>
            <textarea id="overtime-review-note" required maxLength={1000} rows={3} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="Tuliskan dasar keputusan lembur." style={{ ...inputStyle, resize: 'vertical', marginBottom: '16px' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}><button type="button" className="outline-button" onClick={() => { setOvertimeReview(null); setReviewNote(''); }}>Batal</button><button type="button" className="primary-button" onClick={handleOvertimeReview} disabled={actionLoading === 'overtime-review'} style={overtimeReview.decision === 'REJECTED' ? { background: '#b91c1c' } : undefined}>{actionLoading === 'overtime-review' ? 'Menyimpan...' : overtimeReview.decision === 'APPROVED' ? 'Setujui Lembur' : 'Tolak Lembur'}</button></div>
          </Dialog>
        )}

        {userEdit && (
          <Dialog titleId="edit-user-title" title="Ubah Pengguna" onClose={() => setUserEdit(null)}>
            <form onSubmit={handleUpdateUser}>
              <p className="muted" style={{ fontSize: '13px', margin: '0 0 16px' }}>Username <strong>{userEdit.username}</strong> · versi {userEdit.version}</p>
              <label style={labelStyle} htmlFor="edit-display-name">Nama lengkap</label>
              <input id="edit-display-name" required maxLength={100} value={userEdit.display_name} onChange={(event) => setUserEdit({ ...userEdit, display_name: event.target.value })} style={{ ...inputStyle, marginBottom: '12px' }} />
              <label style={labelStyle} htmlFor="edit-role">Hak akses</label>
              <select id="edit-role" value={userEdit.role} onChange={(event) => setUserEdit({ ...userEdit, role: event.target.value })} style={{ ...inputStyle, marginBottom: '12px' }}><option value="OPERATOR">Operator</option><option value="SUPERVISOR">Supervisor</option><option value="INVESTOR">Investor</option><option value="OWNER">Pemilik</option></select>
              <label style={labelStyle} htmlFor="edit-job-title">Jabatan</label>
              <input id="edit-job-title" required maxLength={100} value={userEdit.job_title ?? ''} onChange={(event) => setUserEdit({ ...userEdit, job_title: event.target.value })} style={{ ...inputStyle, marginBottom: '16px' }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}><button type="button" className="outline-button" onClick={() => setUserEdit(null)}>Batal</button><button type="submit" className="primary-button" disabled={actionLoading === 'update-user'}>{actionLoading === 'update-user' ? 'Menyimpan...' : 'Simpan Perubahan'}</button></div>
            </form>
          </Dialog>
        )}

        {deactivateTarget && (
          <Dialog titleId="deactivate-user-title" title="Nonaktifkan Akun?" onClose={() => { setDeactivateTarget(null); setDeactivateReason(''); }}>
            <p className="muted" style={{ fontSize: '13px', margin: '0 0 16px' }}>Akun <strong>{deactivateTarget.display_name}</strong> tidak dapat login. Sesi, perangkat, roster mendatang, dan pertukaran aktif dapat dibatalkan.</p>
            <label style={labelStyle} htmlFor="deactivate-reason">Alasan penonaktifan</label>
            <textarea id="deactivate-reason" required maxLength={500} rows={3} value={deactivateReason} onChange={(event) => setDeactivateReason(event.target.value)} placeholder="Contoh: Pengguna tidak lagi bertugas di outlet." style={{ ...inputStyle, resize: 'vertical', marginBottom: '16px' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}><button type="button" className="outline-button" onClick={() => { setDeactivateTarget(null); setDeactivateReason(''); }}>Batal</button><button type="button" className="primary-button" onClick={handleDeactivateUser} disabled={actionLoading === 'deactivate-user'} style={{ background: '#b91c1c' }}>{actionLoading === 'deactivate-user' ? 'Menonaktifkan...' : 'Nonaktifkan Akun'}</button></div>
          </Dialog>
        )}

        {resetTarget && (
          <Dialog titleId="reset-pin-title" title="Reset PIN Pengguna?" onClose={() => setResetTarget(null)}>
            <p className="muted" style={{ fontSize: '13px', margin: '0 0 18px' }}>PIN <strong>{resetTarget.display_name}</strong> akan diganti. Semua sesi pengguna tersebut dicabut. PIN sementara hanya ditampilkan satu kali.</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}><button type="button" className="outline-button" onClick={() => setResetTarget(null)}>Batal</button><button type="button" className="primary-button" onClick={handleResetPin} disabled={actionLoading === 'reset-pin'}>{actionLoading === 'reset-pin' ? 'Mereset...' : 'Reset dan Tampilkan PIN'}</button></div>
          </Dialog>
        )}

        {oneTimeSecret && (
          <Dialog titleId="one-time-pin-title" title="Catat PIN Sementara Sekarang" onClose={() => setOneTimeSecret(null)}>
            <div role="status" style={{ padding: '16px', borderRadius: '8px', border: '1px solid #bbf7d0', background: '#f0fdf4', marginBottom: '16px' }}>
              <p style={{ margin: '0 0 6px' }}><strong>Username:</strong> {oneTimeSecret.username}</p>
              <p style={{ margin: 0 }}><strong>PIN sementara:</strong> <code style={{ background: '#dcfce7', padding: '4px 9px', borderRadius: '4px', fontSize: '18px', letterSpacing: '2px' }}>{oneTimeSecret.pin}</code></p>
            </div>
            <p className="muted" style={{ fontSize: '13px', margin: '0 0 16px' }}>Berikan langsung kepada pengguna. PIN ini tidak dapat ditampilkan kembali setelah dialog ditutup; pengguna wajib menggantinya saat login.</p>
            <button type="button" className="primary-button" onClick={() => setOneTimeSecret(null)} style={{ width: '100%' }}>Saya Sudah Mencatat PIN</button>
          </Dialog>
        )}
      </main>
    </div>
  );
}
