import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { fmtRupiah, wibDate } from '../../domain/rules';

type Tab = 'dashboard' | 'roster' | 'exceptions' | 'payroll' | 'users' | 'reports';

type Props = {
  user: any;
  onLogout: () => void;
  onEnterOperatorMode?: () => void;
};

export function ManagementView({ user, onLogout, onEnterOperatorMode }: Props) {
  const [tab, setTab] = useState<Tab>(user.role === 'INVESTOR' ? 'reports' : 'dashboard');
  const [loading, setLoading] = useState(false);
  const [dashboardData, setDashboardData] = useState<any>(null);
  const [investorReports, setInvestorReports] = useState<any[]>([]);
  const [usersList, setUsersList] = useState<any[]>([]);
  const [toast, setToast] = useState('');

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

  // Create user state
  const [showCreateUserModal, setShowCreateUserModal] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<'OPERATOR' | 'SUPERVISOR' | 'INVESTOR' | 'OWNER'>('OPERATOR');
  const [newJobTitle, setNewJobTitle] = useState('STAFF');
  const [createdUserResult, setCreatedUserResult] = useState<{ username: string; initial_pin: string } | null>(null);

  const isInvestor = user.role === 'INVESTOR';
  const isOwner = user.role === 'OWNER';

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const loadData = async () => {
    setLoading(true);
    try {
      if (isInvestor) {
        const reps = await api.getInvestorReports();
        setInvestorReports(reps);
      } else {
        const d = await api.getDashboard();
        setDashboardData(d);
        if (isOwner || user.role === 'SUPERVISOR') {
          const u = await api.listUsers();
          setUsersList(u);
        }
        if (tab === 'payroll') {
          await loadPayroll(payrollPeriod);
        }
      }
    } catch (e: any) {
      showToast(e.message || 'Gagal memuat data manajemen');
    } finally {
      setLoading(false);
    }
  };

  const loadPayroll = async (period: string) => {
    setPayrollLoading(true);
    try {
      const { run, entries } = await api.getPayrollRun(period);
      setPayrollRun(run);
      setPayrollEntries(entries || []);
    } catch (e: any) {
      showToast(e.message || 'Gagal memuat data payroll');
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
      showToast(e.message || 'Gagal preview payroll');
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
      showToast(e.message || 'Gagal review payroll');
    } finally {
      setPayrollLoading(false);
    }
  };

  const handleFinalizePayroll = async () => {
    if (!payrollRun) return;
    if (!confirm('Finalisasi payroll akan mengunci seluruh entri dan data gaji secara permanen. Lanjutkan?')) return;
    setPayrollLoading(true);
    try {
      await api.finalizePayroll(payrollRun.id, payrollRun.version);
      showToast('Payroll berhasil di-FINALISASI.');
      await loadPayroll(payrollPeriod);
    } catch (e: any) {
      showToast(e.message || 'Gagal finalisasi payroll');
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
      showToast(e.message || 'Gagal menandai payroll dibayar');
    } finally {
      setPayrollLoading(false);
    }
  };

  const handleVoidPayroll = async () => {
    if (!payrollRun || !voidReason.trim()) {
      showToast('Alasan pembatalan (VOID) wajib diisi.');
      return;
    }
    if (!confirm('Pembatalan akan meng-VOID payroll ini dan membuat draft pengganti baru. Lanjutkan?')) return;
    setPayrollLoading(true);
    try {
      await api.voidPayroll(payrollRun.id, payrollRun.version, voidReason.trim());
      showToast('Payroll telah di-VOID dan draft pengganti dibuat.');
      setShowVoidModal(false);
      setVoidReason('');
      await loadPayroll(payrollPeriod);
    } catch (e: any) {
      showToast(e.message || 'Gagal membatalkan payroll');
    } finally {
      setPayrollLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [tab]);

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
      showToast(e.message || 'Gagal ekspor payroll');
    } finally {
      setPayrollLoading(false);
    }
  };

  const handleResetPin = async (targetUsername: string) => {
    if (!confirm(`Reset PIN untuk user ${targetUsername}?`)) return;
    try {
      const res = await api.resetPin(targetUsername);
      alert(`PIN berhasil di-reset!\nUser: ${res.username}\nPIN Sementara: ${res.tempPin}\n\nHarap berikan PIN ini langsung ke operator.`);
      await loadData();
    } catch (err: any) {
      showToast(err.message || 'Gagal reset PIN');
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
            <button className={tab === 'exceptions' ? 'active' : ''} onClick={() => setTab('exceptions')}>Kehadiran & Review</button>
            <button className={tab === 'payroll' ? 'active' : ''} onClick={() => setTab('payroll')}>Payroll & Excel</button>
            <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Kelola Akun</button>
          </nav>
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

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px', marginTop: '16px' }}>
                {(dashboardData?.cycles ?? []).map((c: any) => {
                  const assigned = c.work_assignments ?? [];
                  const primary = assigned.find((a: any) => a.duty_role === 'PRIMARY');
                  const helpers = assigned.filter((a: any) => a.duty_role === 'HELPER');

                  return (
                    <div key={c.id} style={{ padding: '14px', background: '#f8faf9', borderRadius: '10px', border: '1px solid #e0ece6' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <strong>{c.shift_code} · {c.area_code}</strong>
                        <span className={`tag ${c.status === 'COMPLETED' ? 'good' : 'neutral'}`}>{c.status}</span>
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
              </div>
            </div>
          </div>
        )}

        {/* 2. EXCEPTIONS & ATTENDANCE */}
        {tab === 'exceptions' && !isInvestor && (
          <div className="section-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">AUDIT KEHADIRAN & GPS</p>
                <h2>Daftar Review Kehadiran</h2>
              </div>
            </div>

            <div className="table-responsive" style={{ marginTop: '16px' }}>
              <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #cddcd4', color: '#6b8378' }}>
                    <th style={{ padding: '8px' }}>Tanggal</th>
                    <th style={{ padding: '8px' }}>Nama Operator</th>
                    <th style={{ padding: '8px' }}>Status</th>
                    <th style={{ padding: '8px' }}>Keterlambatan</th>
                    <th style={{ padding: '8px' }}>Catatan / Alasan</th>
                  </tr>
                </thead>
                <tbody>
                  {(dashboardData?.attendance ?? []).map((att: any) => (
                    <tr key={att.id} style={{ borderBottom: '1px solid #eef3f0' }}>
                      <td style={{ padding: '8px' }}>{att.work_date}</td>
                      <td style={{ padding: '8px', fontWeight: 600 }}>{att.profiles?.display_name}</td>
                      <td style={{ padding: '8px' }}>
                        <span className={`tag ${att.status === 'APPROVED' || att.status === 'CHECKED_OUT' ? 'good' : 'warn'}`}>
                          {att.status}
                        </span>
                      </td>
                      <td style={{ padding: '8px' }}>{att.lateness_status}</td>
                      <td style={{ padding: '8px', color: '#6b8378' }}>
                        {att.attendance_events?.[0]?.note || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                  onChange={(e) => {
                    setPayrollPeriod(e.target.value);
                    void loadPayroll(e.target.value);
                  }}
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
                      {payrollRun?.status || 'BELUM DIBUAT'}
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
                      {payrollLoading ? 'Menghitung...' : payrollRun ? '🔄 Hitung Ulang Draft' : '➕ Buat Draft Payroll'}
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
                      ✓ Setujui Review
                    </button>
                  )}

                  {/* Owner Finalize */}
                  {isOwner && payrollRun?.status === 'REVIEWED' && (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={handleFinalizePayroll}
                      disabled={payrollLoading}
                      style={{ fontSize: '12px', padding: '6px 12px', background: '#059669' }}
                    >
                      🔒 Finalisasi (Owner)
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
                      💵 Tandai Lunas (PAID)
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
                      ✕ Batalkan (VOID)
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
                    📥 Ekspor XLSX
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
                            {e.status}
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

            {/* Modal Mark Paid */}
            {showPayModal && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px' }}>
                <div style={{ background: '#fff', padding: '24px', borderRadius: '12px', maxWidth: '440px', width: '100%', boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}>
                  <h3 style={{ margin: '0 0 8px' }}>Tandai Payroll Dibayar (PAID)</h3>
                  <p className="muted" style={{ fontSize: '12px', margin: '0 0 16px' }}>
                    Pastikan seluruh transfer telah berhasil dieksekusi sebelum mencatat bukti pembayaran.
                  </p>
                  <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Referensi Pembayaran (Nomor Transaksi / Bukti Bank):</label>
                  <input
                    type="text"
                    value={paymentRef}
                    onChange={(e) => setPaymentRef(e.target.value)}
                    placeholder="Contoh: BCA-TRX-20260903-8891"
                    style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cddcd4', marginBottom: '12px', fontSize: '13px' }}
                  />
                  <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Keterangan / Alasan:</label>
                  <textarea
                    value={paymentReason}
                    onChange={(e) => setPaymentReason(e.target.value)}
                    placeholder="Contoh: Pembayaran payroll via transfer batch BCA."
                    rows={3}
                    style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cddcd4', marginBottom: '16px', fontSize: '13px' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                    <button type="button" className="outline-button" onClick={() => setShowPayModal(false)}>Batal</button>
                    <button type="button" className="primary-button" onClick={handleMarkPaid} disabled={payrollLoading}>
                      {payrollLoading ? 'Menyimpan...' : 'Simpan Status PAID'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Modal Void */}
            {showVoidModal && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px' }}>
                <div style={{ background: '#fff', padding: '24px', borderRadius: '12px', maxWidth: '440px', width: '100%', boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}>
                  <h3 style={{ margin: '0 0 8px', color: '#dc2626' }}>Batalkan Payroll (VOID)</h3>
                  <p className="muted" style={{ fontSize: '12px', margin: '0 0 16px' }}>
                    Payroll saat ini akan dinonaktifkan secara permanen dan sistem akan membuat satu draft pengganti baru.
                  </p>
                  <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Alasan Pembatalan (Wajib):</label>
                  <textarea
                    value={voidReason}
                    onChange={(e) => setVoidReason(e.target.value)}
                    placeholder="Contoh: Ada koreksi absensi susulan untuk shift malam tgl 28."
                    rows={3}
                    style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cddcd4', marginBottom: '16px', fontSize: '13px' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                    <button type="button" className="outline-button" onClick={() => setShowVoidModal(false)}>Batal</button>
                    <button type="button" className="primary-button" onClick={handleVoidPayroll} disabled={payrollLoading} style={{ background: '#dc2626' }}>
                      {payrollLoading ? 'Membatalkan...' : 'Konfirmasi VOID'}
                    </button>
                  </div>
                </div>
              </div>
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
                    setCreatedUserResult(null);
                    setShowCreateUserModal(true);
                  }}
                  style={{ fontSize: '12px', padding: '7px 14px' }}
                >
                  ➕ Tambah Pengguna Baru
                </button>
              )}
            </div>

            <div className="table-responsive" style={{ marginTop: '16px' }}>
              <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #cddcd4', color: '#6b8378' }}>
                    <th style={{ padding: '8px' }}>Nama Lengkap</th>
                    <th style={{ padding: '8px' }}>Username</th>
                    <th style={{ padding: '8px' }}>Role</th>
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
                        <span className="tag neutral">{u.role}</span>
                      </td>
                      <td style={{ padding: '8px' }}>
                        {u.force_pin_change ? <span style={{ color: '#d97706' }}>Wajib Ganti</span> : 'Aktif'}
                      </td>
                      <td style={{ padding: '8px', textAlign: 'right' }}>
                        {isOwner && (
                          <button
                            type="button"
                            className="outline-button"
                            onClick={() => handleResetPin(u.username)}
                            style={{ fontSize: '11px', padding: '4px 8px' }}
                          >
                            Reset PIN
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Modal Tambah User */}
            {showCreateUserModal && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px' }}>
                <div style={{ background: '#fff', padding: '24px', borderRadius: '12px', maxWidth: '440px', width: '100%', boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}>
                  <h3 style={{ margin: '0 0 8px' }}>Tambah Pengguna Baru</h3>
                  <p className="muted" style={{ fontSize: '12px', margin: '0 0 16px' }}>
                    Pengguna baru akan otomatis mendapatkan PIN sementara 6 digit untuk login pertama kali.
                  </p>

                  {createdUserResult ? (
                    <div style={{ padding: '16px', background: '#f0fdf4', borderRadius: '8px', border: '1px solid #bbf7d0', marginBottom: '16px' }}>
                      <p style={{ margin: '0 0 6px', color: '#166534', fontWeight: 700 }}>Akun Berhasil Dibuat!</p>
                      <p style={{ margin: '0 0 4px', fontSize: '13px' }}><strong>Username:</strong> {createdUserResult.username}</p>
                      <p style={{ margin: '0 0 8px', fontSize: '15px' }}>
                        <strong>PIN Sementara:</strong> <code style={{ background: '#dcfce7', padding: '2px 8px', borderRadius: '4px', fontSize: '16px', letterSpacing: '2px' }}>{createdUserResult.initial_pin}</code>
                      </p>
                      <p className="muted" style={{ fontSize: '11px', color: '#15803d', margin: 0 }}>
                        Catat dan berikan PIN ini ke operator. Pengguna akan diminta mengganti PIN saat pertama kali login.
                      </p>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => {
                          setShowCreateUserModal(false);
                          setCreatedUserResult(null);
                        }}
                        style={{ width: '100%', marginTop: '16px', fontSize: '13px' }}
                      >
                        Selesai
                      </button>
                    </div>
                  ) : (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (!newUsername.trim() || !newDisplayName.trim()) {
                          showToast('Username dan nama tampilan wajib diisi.');
                          return;
                        }
                        setLoading(true);
                        try {
                          const res = await api.createUser({
                            username: newUsername.trim().toLowerCase(),
                            display_name: newDisplayName.trim(),
                            role: newRole,
                            job_title: newJobTitle.trim() || 'STAFF',
                          });
                          setCreatedUserResult({
                            username: res.user.username,
                            initial_pin: res.initial_pin,
                          });
                          await loadData();
                        } catch (err: any) {
                          showToast(err.message || 'Gagal membuat user baru');
                        } finally {
                          setLoading(false);
                        }
                      }}
                    >
                      <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Nama Lengkap Tampilan:</label>
                      <input
                        type="text"
                        value={newDisplayName}
                        onChange={(e) => setNewDisplayName(e.target.value)}
                        placeholder="Contoh: Jezy Supervisor"
                        required
                        style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cddcd4', marginBottom: '12px', fontSize: '13px' }}
                      />

                      <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Username (huruf kecil):</label>
                      <input
                        type="text"
                        value={newUsername}
                        onChange={(e) => setNewUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
                        placeholder="Contoh: jezy"
                        required
                        style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cddcd4', marginBottom: '12px', fontSize: '13px' }}
                      />

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
                        <div>
                          <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Role / Hak Akses:</label>
                          <select
                            value={newRole}
                            onChange={(e) => setNewRole(e.target.value as any)}
                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cddcd4', fontSize: '13px' }}
                          >
                            <option value="OPERATOR">OPERATOR</option>
                            <option value="SUPERVISOR">SUPERVISOR</option>
                            <option value="INVESTOR">INVESTOR</option>
                            <option value="OWNER">OWNER</option>
                          </select>
                        </div>
                        <div>
                          <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Posisi / Jabatan:</label>
                          <input
                            type="text"
                            value={newJobTitle}
                            onChange={(e) => setNewJobTitle(e.target.value)}
                            placeholder="Contoh: BARISTA"
                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #cddcd4', fontSize: '13px' }}
                          />
                        </div>
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                        <button type="button" className="outline-button" onClick={() => setShowCreateUserModal(false)}>Batal</button>
                        <button type="submit" className="primary-button" disabled={loading}>
                          {loading ? 'Membuat Akun...' : 'Simpan Pengguna'}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 5. INVESTOR REPORTS VIEW */}
        {(tab === 'reports' || isInvestor) && (
          <div className="section-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">REKAP OPERASIONAL OUTLET</p>
                <h2>Laporan Harian Diterima</h2>
              </div>
            </div>

            <div style={{ display: 'grid', gap: '16px', marginTop: '16px' }}>
              {investorReports.length === 0 ? (
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
      </main>

      {toast && <div className="live-region" role="status">{toast}</div>}
    </div>
  );
}
