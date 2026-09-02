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
      }
    } catch (e: any) {
      showToast(e.message || 'Gagal memuat data manajemen');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [tab]);

  const handleExportPayroll = async () => {
    setLoading(true);
    try {
      const res = await api.exportPayrollXlsx();
      const byteCharacters = atob(res.file_base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      a.click();
      showToast('File Excel Payroll berhasil diunduh.');
    } catch (e: any) {
      showToast(e.message || 'Gagal ekspor payroll');
    } finally {
      setLoading(false);
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
            <div className="section-heading">
              <div>
                <p className="eyebrow">REKAP GAJI & BONUS OMZET</p>
                <h2>Payroll Evidence & Ekspor</h2>
              </div>
            </div>

            <p className="muted" style={{ margin: '12px 0' }}>
              File Excel mencakup 7 sheet lengkap: Summary, Attendance, Exceptions, Overtime, Bonus, Adjustments, dan Audit log.
            </p>

            <button
              className="primary-button"
              onClick={handleExportPayroll}
              disabled={loading}
              style={{ marginTop: '12px' }}
            >
              {loading ? 'Membuat Spreadsheet...' : '📥 Ekspor Laporan Payroll (.xlsx)'}
            </button>
          </div>
        )}

        {/* 4. USERS MANAGEMENT */}
        {tab === 'users' && !isInvestor && (
          <div className="section-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">MANAJEMEN PENGGUNA</p>
                <h2>Daftar Akun & Reset PIN</h2>
              </div>
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
                        <button
                          type="button"
                          className="outline-button"
                          onClick={() => handleResetPin(u.username)}
                          style={{ fontSize: '11px', padding: '4px 8px' }}
                        >
                          Reset PIN
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
