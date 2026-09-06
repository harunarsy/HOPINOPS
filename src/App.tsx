import { useEffect, useRef, useState } from 'react';
import type { ShiftType, Area, DutyRole, Item, UserProfile } from './domain/types';
import { api } from './lib/api';
import { Login } from './features/auth/Login';
import { ForcedPinChange } from './features/auth/ForcedPinChange';
import { StaffOnboarding } from './features/onboarding/StaffOnboarding';
import { AssignmentScreen } from './features/assignment/AssignmentScreen';
import { SwipeAttendance } from './features/attendance/SwipeAttendance';
import { StockWorkspace } from './features/stock/StockWorkspace';
import { ReportsView } from './features/reports/ReportsView';
import { ManagementView } from './features/management/ManagementView';

type AppStatus = 'BOOTING' | 'READY' | 'SERVICE_UNAVAILABLE' | 'SESSION_EXPIRED';

function requestErrorMessage(error: any, fallback: string) {
  const message = error?.message || fallback;
  const context = [error?.code, error?.status ? `HTTP ${error.status}` : '', error?.request_id || error?.details?.request_id]
    .filter(Boolean)
    .join(' · ');
  return context ? `${message} (${context})` : message;
}

function isSessionError(error: any) {
  return error?.status === 401 || ['AUTH_REQUIRED', 'INVALID_SESSION', 'INVALID_DEVICE'].includes(error?.code);
}

export default function App() {
  const [appStatus, setAppStatus] = useState<AppStatus>('BOOTING');
  const [bootstrapError, setBootstrapError] = useState('');
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [loginOptions, setLoginOptions] = useState<{ username: string; display_name: string }[]>([]);
  const [authLoading, setAuthLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [loginLockSeconds, setLoginLockSeconds] = useState(0);
  const [assignmentError, setAssignmentError] = useState('');

  // Bootstrap data
  const [outletId, setOutletId] = useState('');
  const [settings, setSettings] = useState<any>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [activeAssignment, setActiveAssignment] = useState<any>(null);
  const [activeAttendance, setActiveAttendance] = useState<any>(null);
  const [onboardingProgress, setOnboardingProgress] = useState<any>(null);
  const [workDate, setWorkDate] = useState<string>('');
  const [cycleData, setCycleData] = useState<any>(null);

  // App UI mode
  const [forceShiftMode, setForceShiftMode] = useState(false);
  const [showCheckInModal, setShowCheckInModal] = useState(false);
  const [showCheckOutModal, setShowCheckOutModal] = useState(false);
  const [showReportsView, setShowReportsView] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [checkoutCompleting, setCheckoutCompleting] = useState(false);
  const [checkoutRecoveryError, setCheckoutRecoveryError] = useState('');
  const [showEmergencyCheckout, setShowEmergencyCheckout] = useState(false);
  const [emergencyReason, setEmergencyReason] = useState('');
  const [emergencyError, setEmergencyError] = useState('');
  const [emergencySubmitting, setEmergencySubmitting] = useState(false);
  const [emergencyReceipt, setEmergencyReceipt] = useState<{
    attendanceId: string;
    eventId: string;
    attendanceStatus: 'REVIEW_REQUIRED';
    assignmentStatus: 'PENDING_TASKS';
  } | null>(null);
  const emergencyIdempotencyKeyRef = useRef<string | null>(null);

  const loadBootstrap = async () => {
    setAppStatus('BOOTING');
    setBootstrapError('');
    try {
      const data = await api.bootstrap();
      if (!data?.user || !data?.outlet?.id) {
        throw new Error('Bootstrap tidak mengembalikan data akun dan outlet yang lengkap.');
      }

      const nextCycleData = data.activeAssignment?.cycle_id
        ? await api.getCycle(data.activeAssignment.cycle_id)
        : null;

      setCurrentUser(data.user);
      setOutletId(data.outlet.id);
      setSettings(data.settings || null);
      setItems(data.items || []);
      setActiveAssignment(data.activeAssignment || null);
      setActiveAttendance(data.activeAttendance || null);
      setOnboardingProgress(data.onboarding || null);
      setWorkDate(data.workDate || '');
      setCycleData(nextCycleData);
      setAssignmentError('');
      setAppStatus('READY');
    } catch (e: any) {
      console.error('Bootstrap failed', e);
      setBootstrapError(requestErrorMessage(e, 'Gagal memuat data operasional.'));
      setAppStatus(isSessionError(e) ? 'SESSION_EXPIRED' : 'SERVICE_UNAVAILABLE');
    }
  };

  const loadInitialAuth = async () => {
    setAppStatus('BOOTING');
    setBootstrapError('');
    try {
      const user = await api.getCurrentUser();
      if (user) {
        setCurrentUser(user);
        await loadBootstrap();
        return;
      }

      setCurrentUser(null);
      setLoginOptions(await api.getLoginOptions());
      setAppStatus('READY');
    } catch (e: any) {
      setBootstrapError(requestErrorMessage(e, 'Layanan autentikasi belum siap.'));
      setAppStatus(isSessionError(e) ? 'SESSION_EXPIRED' : 'SERVICE_UNAVAILABLE');
    }
  };

  useEffect(() => {
    void loadInitialAuth();
  }, []);

  const handleLogin = async (username: string, pin: string) => {
    setLoginError('');
    setAuthLoading(true);
    try {
      const user = await api.login(username, pin);
      setLoginLockSeconds(0);
      setCurrentUser(user);
      await loadBootstrap();
    } catch (err: any) {
      if (err?.status === 429) {
        const seconds = Math.max(1, Number(err?.retryAfterSeconds) || 60);
        setLoginLockSeconds(seconds);
        setLoginError('Terlalu banyak percobaan PIN salah. Silakan tunggu beberapa saat.');
      } else {
        setLoginError(err.message || 'Nama user atau PIN salah.');
      }
    } finally {
      setAuthLoading(false);
    }
  };

  // Server-authoritative lock countdown (survives navigation state, derived from Retry-After).
  useEffect(() => {
    if (loginLockSeconds <= 0) return;
    const timer = setInterval(() => {
      setLoginLockSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [loginLockSeconds > 0]);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError('');
    try {
      await api.logout();
      setAppStatus('READY');
      setBootstrapError('');
      setCurrentUser(null);
      setLoginOptions([]);
      setAuthLoading(false);
      setLoginError('');
      setLoginLockSeconds(0);
      setAssignmentError('');
      setOutletId('');
      setSettings(null);
      setItems([]);
      setActiveAssignment(null);
      setActiveAttendance(null);
      setOnboardingProgress(null);
      setWorkDate('');
      setCycleData(null);
      setForceShiftMode(false);
      setShowCheckInModal(false);
      setShowCheckOutModal(false);
      setShowReportsView(false);
      setCheckoutCompleting(false);
      setCheckoutRecoveryError('');
      setShowEmergencyCheckout(false);
      setEmergencyReason('');
      setEmergencyError('');
      setEmergencySubmitting(false);
      setEmergencyReceipt(null);
      emergencyIdempotencyKeyRef.current = null;
      try {
        setLoginOptions(await api.getLoginOptions());
      } catch (e: any) {
        setLoginError(requestErrorMessage(e, 'Gagal memuat daftar akun.'));
      }
    } catch (err: any) {
      console.error('Logout failed on server', err?.message);
      setLogoutError(`Keluar akun belum terkonfirmasi di server. Jangan tinggalkan perangkat ini. (${err?.message || 'Gagal mencabut sesi'})`);
    } finally {
      setLoggingOut(false);
    }
  };

  const handleClaimAssignment = async (shift: ShiftType, area: Area, duty: DutyRole) => {
    setAuthLoading(true);
    try {
      const res = await api.claimAssignment({
        shift_code: shift,
        area_code: area,
        duty_role: duty,
      });
      setActiveAssignment(res.assignment);
      const c = await api.getCycle(res.assignment.cycle_id);
      setCycleData(c);
      setAssignmentError('');
      setShowCheckInModal(true);
    } catch (err: any) {
      setAssignmentError(requestErrorMessage(err, 'Gagal mengambil penugasan.'));
    } finally {
      setAuthLoading(false);
    }
  };

  const completeAssignmentAndLogout = async () => {
    const assignmentId = activeAssignment?.id;
    const assignmentVersion = activeAssignment?.version;
    if (!assignmentId || !Number.isInteger(assignmentVersion) || assignmentVersion <= 0) {
      setShowCheckOutModal(false);
      setCheckoutRecoveryError('Checkout tercatat, tetapi versi assignment tidak valid. Tetap masuk dan gunakan pemulihan checkout.');
      return;
    }

    setCheckoutCompleting(true);
    try {
      await api.completeAssignment(assignmentId, assignmentVersion);
      setShowCheckOutModal(false);
      await handleLogout();
    } catch (err: any) {
      setShowCheckOutModal(false);
      setCheckoutRecoveryError(requestErrorMessage(
        err,
        'Checkout tercatat, tetapi assignment belum dapat diselesaikan. Anda tetap masuk agar kondisi ini dapat dipulihkan.',
      ));
    } finally {
      setCheckoutCompleting(false);
    }
  };

  const openEmergencyCheckout = () => {
    setEmergencyError('');
    setShowEmergencyCheckout(true);
  };

  const closeEmergencyCheckout = () => {
    if (emergencySubmitting) return;
    setShowEmergencyCheckout(false);
  };

  const handleEmergencyCheckout = async () => {
    const reason = emergencyReason.trim();
    const attendanceId = activeAttendance?.id;
    const attendanceVersion = activeAttendance?.version;

    if (!reason) {
      setEmergencyError('Alasan emergency checkout wajib diisi.');
      return;
    }
    if (!attendanceId || !Number.isInteger(attendanceVersion) || attendanceVersion <= 0) {
      setEmergencyError('Data atau versi attendance aktif tidak valid. Muat ulang sebelum mencoba kembali.');
      return;
    }

    setEmergencySubmitting(true);
    setEmergencyError('');
    emergencyIdempotencyKeyRef.current ??= crypto.randomUUID();
    try {
      const result = await api.emergencyCheckout(
        attendanceId,
        attendanceVersion,
        reason,
        emergencyIdempotencyKeyRef.current,
      );
      setEmergencyReceipt({
        attendanceId: result.attendance_id,
        eventId: result.event_id,
        attendanceStatus: result.status,
        assignmentStatus: 'PENDING_TASKS',
      });
      setCheckoutRecoveryError('');
      setShowCheckOutModal(false);
      setShowReportsView(false);
      setShowEmergencyCheckout(false);
      setEmergencyReason('');
      emergencyIdempotencyKeyRef.current = null;
      await loadBootstrap();
    } catch (err: any) {
      setEmergencyError(requestErrorMessage(
        err,
        'Emergency checkout gagal. Anda tetap masuk; periksa kondisi attendance lalu coba kembali.',
      ));
    } finally {
      setEmergencySubmitting(false);
    }
  };

  const emergencyCheckoutDialog = showEmergencyCheckout && (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="emergency-checkout-title"
        style={{ maxWidth: '480px' }}
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">JALUR PEMULIHAN</p>
            <h2 id="emergency-checkout-title">Emergency Checkout</h2>
          </div>
          <button className="close-button" type="button" onClick={closeEmergencyCheckout} disabled={emergencySubmitting} aria-label="Tutup">
            ×
          </button>
        </div>
        <p className="muted" style={{ marginBottom: '16px' }}>
          Gunakan hanya saat antrean stok atau finalisasi menghalangi checkout normal. Attendance akan memerlukan review dan tugas stok tetap tertunda.
        </p>
        <label htmlFor="emergency-checkout-reason" style={{ display: 'block', fontSize: '12px', fontWeight: 700 }}>
          Alasan (wajib)
        </label>
        <textarea
          id="emergency-checkout-reason"
          value={emergencyReason}
          onChange={(event) => {
            setEmergencyReason(event.target.value);
            setEmergencyError('');
            emergencyIdempotencyKeyRef.current = null;
          }}
          maxLength={1000}
          rows={4}
          disabled={emergencySubmitting}
          placeholder="Jelaskan antrean atau finalisasi yang belum dapat diselesaikan."
          style={{ width: '100%', marginTop: '6px', padding: '10px', border: '1px solid #cddcd4', borderRadius: '8px', resize: 'vertical' }}
        />
        {emergencyError && <p className="form-error" role="alert" style={{ marginTop: '12px' }}>{emergencyError}</p>}
        <div className="modal-actions" style={{ marginTop: '16px' }}>
          <button className="outline-button" type="button" onClick={closeEmergencyCheckout} disabled={emergencySubmitting}>
            Batal
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => void handleEmergencyCheckout()}
            disabled={emergencySubmitting || !emergencyReason.trim()}
          >
            {emergencySubmitting ? 'Mencatat...' : 'Catat Emergency Checkout'}
          </button>
        </div>
      </div>
    </div>
  );

  const effectiveCheckoutRecoveryError = checkoutRecoveryError || (activeAttendance?.status === 'CHECKED_OUT'
    ? 'Checkout sudah tercatat, tetapi assignment masih aktif. Selesaikan assignment sebelum keluar.'
    : '');

  const checkoutRecoveryPanel = effectiveCheckoutRecoveryError && (
    <section
      className="section-card"
      aria-labelledby="checkout-recovery-title"
      style={{ maxWidth: '680px', margin: '20px auto', border: '2px solid #b95745' }}
    >
      <p className="eyebrow">PEMULIHAN CHECKOUT</p>
      <h2 id="checkout-recovery-title" style={{ fontSize: '22px', marginBottom: '8px' }}>Assignment belum selesai</h2>
      <p className="form-error" role="alert">{effectiveCheckoutRecoveryError}</p>
      <p className="muted" style={{ fontSize: '12px', marginBottom: '16px' }}>
        Jangan keluar sebelum assignment berhasil diselesaikan atau kondisi diteruskan melalui jalur emergency.
      </p>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <button
          className="primary-button"
          type="button"
          onClick={() => void completeAssignmentAndLogout()}
          disabled={checkoutCompleting}
        >
          {checkoutCompleting ? 'Menyelesaikan...' : 'Coba Selesaikan Assignment'}
        </button>
        {activeAttendance?.id && (
          <button className="outline-button" type="button" onClick={openEmergencyCheckout} disabled={checkoutCompleting}>
            Emergency Checkout
          </button>
        )}
      </div>
    </section>
  );

  const emergencyReceiptPanel = emergencyReceipt && (
    <section
      className="section-card"
      aria-labelledby="emergency-receipt-title"
      style={{ maxWidth: '680px', margin: '20px auto', border: '2px solid #c98732', background: '#fff3db' }}
    >
      <p className="eyebrow">BUKTI PEMULIHAN</p>
      <h2 id="emergency-receipt-title" style={{ fontSize: '22px', marginBottom: '8px' }}>Emergency checkout tercatat</h2>
      <p role="status" style={{ margin: '0 0 12px' }}>
        Attendance <strong>{emergencyReceipt.attendanceStatus}</strong> dan assignment <strong>{emergencyReceipt.assignmentStatus}</strong>.
        Anda tetap masuk untuk menindaklanjuti tugas dan review.
      </p>
      <div className="muted" style={{ fontFamily: "'DM Mono', monospace", fontSize: '10px', overflowWrap: 'anywhere' }}>
        Attendance: {emergencyReceipt.attendanceId}<br />
        Event: {emergencyReceipt.eventId}
      </div>
    </section>
  );

  const logoutErrorPanel = logoutError && (
    <div
      className="save-error"
      role="alert"
      style={{
        position: 'fixed',
        top: '16px',
        right: '16px',
        left: '16px',
        zIndex: 99999,
        maxWidth: '680px',
        margin: '0 auto',
        borderRadius: '10px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '12px 16px',
        background: '#8f3f34',
        color: '#fff',
      }}
    >
      <span><strong>Peringatan Keamanan:</strong> {logoutError}</span>
      <button
        type="button"
        className="outline-button"
        onClick={() => void handleLogout()}
        disabled={loggingOut}
        style={{
          width: 'auto',
          minHeight: '32px',
          margin: 0,
          padding: '4px 10px',
          fontSize: '11px',
          background: '#fff',
          color: '#8f3f34',
          borderColor: '#fff',
          whiteSpace: 'nowrap',
        }}
      >
        {loggingOut ? 'Mencoba...' : 'Coba Lagi'}
      </button>
    </div>
  );

  // 1. EXPLICIT BOOTSTRAP STATES
  if (appStatus === 'BOOTING') {
    return (
      <div className="login-page">
        <div className="login-panel" style={{ textAlign: 'center', padding: '40px' }}>
          <div className="spinner" style={{ margin: '0 auto 16px' }} />
          <strong>Memuat HOPIN Operations...</strong>
        </div>
      </div>
    );
  }

  if (appStatus === 'SERVICE_UNAVAILABLE' || appStatus === 'SESSION_EXPIRED') {
    return (
      <div className="login-page">
        <div className="login-panel" style={{ textAlign: 'center', padding: '40px' }}>
          <div className="login-brand" style={{ marginBottom: '28px' }}>
            <div><strong>HOPIN</strong><small>CAFE OPERATIONS</small></div>
          </div>
          <h1 style={{ margin: '0 0 10px' }}>
            {appStatus === 'SESSION_EXPIRED' ? 'Sesi berakhir' : 'Layanan belum tersedia'}
          </h1>
          <p className="muted" style={{ marginBottom: '20px' }}>
            {emergencyReceipt
              ? 'Emergency checkout sudah tercatat, tetapi data terbaru belum dapat dimuat. Anda tetap masuk untuk pemulihan.'
              : 'Data operasional tidak diubah. Coba lagi setelah koneksi atau layanan pulih.'}
          </p>
          <p className="form-error" role="alert" style={{ width: 'min(100%, 520px)' }}>{bootstrapError}</p>
          {emergencyReceiptPanel}
          <div style={{ display: 'flex', gap: '10px', width: 'min(100%, 360px)', marginTop: '8px' }}>
            <button className="primary-button" type="button" onClick={() => void loadInitialAuth()} style={{ flex: 1, width: 'auto' }}>
              Coba Lagi
            </button>
            <button className="outline-button" type="button" onClick={() => void handleLogout()} style={{ flex: 1 }}>
              Keluar
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 2. UNAUTHENTICATED -> LOGIN
  if (!currentUser) {
    return (
      <Login
        options={loginOptions}
        onLogin={handleLogin}
        loading={authLoading}
        error={loginError}
        lockoutSeconds={loginLockSeconds}
      />
    );
  }

  // 3. FORCED PIN CHANGE
  if (currentUser.force_pin_change) {
    return (
      <>
        {logoutErrorPanel}
        <ForcedPinChange onSuccess={() => void loadBootstrap()} onLogout={handleLogout} />
      </>
    );
  }

  // 4. ONBOARDING FOR OPERATORS
  const needsOnboarding = currentUser.role === 'OPERATOR' && !onboardingProgress?.completed_at;
  if (needsOnboarding) {
    return (
      <>
        {logoutErrorPanel}
        <StaffOnboarding
          onComplete={() => void loadBootstrap()}
          onLogout={handleLogout}
          onboardingVersion={settings?.onboarding_version}
        />
      </>
    );
  }

  // 5. MANAGEMENT DASHBOARD (INVESTOR, OWNER, SUPERVISOR)
  const isOperationalManager = currentUser.role === 'OWNER' || currentUser.role === 'SUPERVISOR';
  const isInvestor = currentUser.role === 'INVESTOR';
  const isManagement = isOperationalManager || isInvestor;

  if (isManagement && (!forceShiftMode || isInvestor) && !effectiveCheckoutRecoveryError && !showReportsView) {
    return (
      <>
        {logoutErrorPanel}
        <ManagementView
          user={currentUser}
          onLogout={handleLogout}
          onEnterOperatorMode={isOperationalManager ? () => setForceShiftMode(true) : undefined}
          onOpenReports={() => setShowReportsView(true)}
        />
      </>
    );
  }

  // 6. ASSIGNMENT SCREEN (Strictly OPERATIONAL roles: OPERATOR, OWNER, SUPERVISOR - NEVER INVESTOR)
  if (!activeAssignment && !showReportsView && !isInvestor) {
    return (
      <>
        {logoutErrorPanel}
        <AssignmentScreen
          name={currentUser.display_name}
          onClaim={handleClaimAssignment}
          loading={authLoading}
          onLogout={handleLogout}
          onBack={isOperationalManager ? () => setForceShiftMode(false) : undefined}
        />
        {checkoutRecoveryPanel}
        {emergencyReceiptPanel}
        {emergencyCheckoutDialog}
        {assignmentError && (
          <div
            className="save-error"
            role="alert"
            style={{ position: 'fixed', right: '16px', bottom: '16px', left: '16px', zIndex: 100, maxWidth: '680px', margin: '0 auto', borderRadius: '10px' }}
          >
            {assignmentError}
          </div>
        )}
      </>
    );
  }

  if (activeAssignment?.status === 'PENDING_TASKS') {
    const emergencyReviewComplete = activeAttendance?.status === 'APPROVED'
      && activeAttendance?.exception_status === 'RESOLVED';
    return (
      <div className="login-page">
        <div className="login-panel" style={{ textAlign: 'center', padding: '40px' }}>
          <p className="eyebrow">CHECKOUT DALAM REVIEW</p>
          <h1>Assignment menunggu penyelesaian manajemen.</h1>
          <p className="muted">{emergencyReviewComplete
            ? 'Review attendance sudah final. Selesaikan assignment untuk menutup shift dengan bukti server.'
            : 'Checkout darurat sudah tercatat. Jangan lanjut mencatat stok atau mengambil assignment baru sampai manager menyelesaikan review attendance dan tugas shift ini.'}</p>
          {checkoutRecoveryError && <p className="form-error" role="alert">{checkoutRecoveryError}</p>}
          <div style={{ display: 'flex', justifyContent: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {emergencyReviewComplete && <button className="primary-button" type="button" onClick={() => void completeAssignmentAndLogout()} disabled={checkoutCompleting}>{checkoutCompleting ? 'Menyelesaikan...' : 'Selesaikan Assignment'}</button>}
            <button className="outline-button" type="button" onClick={handleLogout} disabled={checkoutCompleting}>Keluar</button>
          </div>
        </div>
      </div>
    );
  }

  // 7. SWIPE CHECK-IN IF NOT CHECKED-IN
  const isCheckedIn = activeAttendance?.status === 'CHECKED_IN' || activeAttendance?.status === 'CHECKED_OUT' || activeAttendance?.status === 'APPROVED' || activeAttendance?.status === 'REVIEW_REQUIRED';
  if ((!isCheckedIn || showCheckInModal) && !showReportsView) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <span><strong>HOPIN</strong><small>ABSENSI GPS</small></span>
          </div>
          <div className="topbar-right">
            <div className="avatar" title={currentUser.display_name} style={{ display: 'grid', placeItems: 'center', fontSize: '12px', fontWeight: 700 }}>
              {currentUser.display_name.slice(0, 2).toUpperCase()}
            </div>
            {isManagement && (
              <button className="outline-button" onClick={() => setForceShiftMode(false)} disabled={checkoutCompleting} style={{ fontSize: '11px', padding: '6px 7px' }}>
                Kelola
              </button>
            )}
            <button className="logout-button" onClick={handleLogout}>
              <span>Keluar</span>
            </button>
          </div>
        </header>
        <main className="workspace">
          <SwipeAttendance
            actionType="CHECK_IN"
            assignmentId={activeAssignment.id}
            onSuccess={async () => {
              setShowCheckInModal(false);
              await loadBootstrap();
            }}
            onCancel={() => setShowCheckInModal(false)}
          />
        </main>
      </div>
    );
  }

  // 8. SWIPE CHECK-OUT MODAL
  if (showCheckOutModal) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <span><strong>HOPIN</strong><small>CHECK-OUT GPS</small></span>
          </div>
          <div className="topbar-right">
            <div className="avatar" title={currentUser.display_name} style={{ display: 'grid', placeItems: 'center', fontSize: '12px', fontWeight: 700 }}>
              {currentUser.display_name.slice(0, 2).toUpperCase()}
            </div>
            {isManagement && (
              <button className="outline-button" onClick={() => setForceShiftMode(false)} style={{ fontSize: '11px', padding: '6px 7px' }}>
                Kelola
              </button>
            )}
            <button className="logout-button" type="button" disabled>
              <span>Keluar</span>
            </button>
          </div>
        </header>
        <main className="workspace">
          <SwipeAttendance
            actionType="CHECK_OUT"
            assignmentId={activeAssignment.id}
            onSuccess={completeAssignmentAndLogout}
            onCancel={() => setShowCheckOutModal(false)}
          />
          {checkoutCompleting && (
            <div role="status" aria-live="polite" style={{ textAlign: 'center', marginTop: '12px' }}>
              <div className="spinner" style={{ margin: '0 auto 8px' }} />
              <strong>Menyelesaikan assignment...</strong>
            </div>
          )}
          <div style={{ maxWidth: '440px', margin: '12px auto 0', textAlign: 'center' }}>
            <button className="outline-button" type="button" onClick={openEmergencyCheckout} disabled={checkoutCompleting}>
              Checkout terhalang? Gunakan Emergency Checkout
            </button>
          </div>
        </main>
        {emergencyCheckoutDialog}
      </div>
    );
  }

  // 9. DAILY REPORTS VIEW
  if (showReportsView) {
    const isBarFinalizer = activeAssignment?.duty_role === 'PRIMARY' &&
      activeAssignment?.work_cycles?.area_code === 'BAR' &&
      (activeAssignment?.work_cycles?.shift_code === 'MALAM' || activeAssignment?.work_cycles?.shift_code === 'FULL');

    return (
      <ReportsView
        isFinalizer={isBarFinalizer || currentUser.role === 'OWNER' || currentUser.role === 'SUPERVISOR'}
        workDate={workDate}
        onRefresh={loadBootstrap}
        onBack={() => setShowReportsView(false)}
      />
    );
  }

  // 10. ACTIVE STOCK WORKSPACE
  const currentAreaItems = items.filter((it) => it.area_code === activeAssignment.work_cycles?.area_code);

  if (!outletId) {
    return (
      <div className="login-page">
        <div className="login-panel" style={{ textAlign: 'center', padding: '40px' }}>
          <strong>Data outlet belum tersedia. Muat ulang setelah koneksi pulih.</strong>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {logoutErrorPanel}
      <header className="topbar">
        <div className="brand">
          <span><strong>HOPIN</strong><small>CAFE OPERATIONS</small></span>
        </div>
        <div className="topbar-right">
          <div className="avatar" title={currentUser.display_name} style={{ display: 'grid', placeItems: 'center', fontSize: '12px', fontWeight: 700 }}>
            {currentUser.display_name.slice(0, 2).toUpperCase()}
          </div>
          {isManagement && (
            <button className="outline-button" onClick={() => setForceShiftMode(false)} disabled={Boolean(effectiveCheckoutRecoveryError)} style={{ fontSize: '11px', padding: '6px 7px' }}>
              Kelola
            </button>
          )}
          <button className="outline-button" onClick={() => setShowReportsView(true)} disabled={Boolean(effectiveCheckoutRecoveryError)} style={{ fontSize: '11px', padding: '6px 7px' }}>
            Laporan ➔
          </button>
          {activeAttendance?.id && (
            <button className="outline-button" type="button" onClick={openEmergencyCheckout} style={{ fontSize: '11px', padding: '6px 7px' }}>
              Checkout Darurat
            </button>
          )}
          <button className="logout-button" onClick={handleLogout} disabled={Boolean(effectiveCheckoutRecoveryError)}>
            <span>Keluar</span>
          </button>
        </div>
      </header>

      {checkoutRecoveryPanel}
      {emergencyReceiptPanel}
      <StockWorkspace
        profileId={currentUser.id}
        outletId={outletId}
        cycleId={activeAssignment.cycle_id}
        area={activeAssignment.work_cycles?.area_code}
        shift={activeAssignment.work_cycles?.shift_code}
        dutyRole={activeAssignment.duty_role}
        items={currentAreaItems}
        cycleData={cycleData}
        canManage={currentUser.role === 'OWNER' || currentUser.role === 'SUPERVISOR'}
        onRefresh={loadBootstrap}
        onCheckOutRequest={() => setShowCheckOutModal(true)}
        onGoReports={() => setShowReportsView(true)}
      />
      {emergencyCheckoutDialog}
    </div>
  );
}
