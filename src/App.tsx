import { useEffect, useState } from 'react';
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
    try {
      await api.logout();
    } catch {}
    setAppStatus('READY');
    setBootstrapError('');
    setCurrentUser(null);
    setLoginOptions([]);
    setAuthLoading(false);
    setLoginError('');
    setLoginLockSeconds(0);
    setAssignmentError('');
    setOutletId('');
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
    try {
      setLoginOptions(await api.getLoginOptions());
    } catch (e: any) {
      setLoginError(requestErrorMessage(e, 'Gagal memuat daftar akun.'));
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
            Data operasional tidak diubah. Coba lagi setelah koneksi atau layanan pulih.
          </p>
          <p className="form-error" role="alert" style={{ width: 'min(100%, 520px)' }}>{bootstrapError}</p>
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
    return <ForcedPinChange onSuccess={() => void loadBootstrap()} />;
  }

  // 4. ONBOARDING FOR OPERATORS
  const needsOnboarding = currentUser.role === 'OPERATOR' && !onboardingProgress?.completed_at;
  if (needsOnboarding) {
    return <StaffOnboarding onComplete={() => void loadBootstrap()} />;
  }

  // 5. MANAGEMENT DASHBOARD (INVESTOR, OWNER, SUPERVISOR)
  const isManagement = currentUser.role === 'OWNER' || currentUser.role === 'SUPERVISOR' || currentUser.role === 'INVESTOR';
  if (isManagement && !forceShiftMode) {
    return (
      <ManagementView
        user={currentUser}
        onLogout={handleLogout}
        onEnterOperatorMode={() => setForceShiftMode(true)}
      />
    );
  }

  // 6. ASSIGNMENT SCREEN
  if (!activeAssignment) {
    return (
      <>
        <AssignmentScreen
          name={currentUser.display_name}
          onClaim={handleClaimAssignment}
          loading={authLoading}
          onLogout={handleLogout}
        />
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

  // 7. SWIPE CHECK-IN IF NOT CHECKED-IN
  const isCheckedIn = activeAttendance?.status === 'CHECKED_IN' || activeAttendance?.status === 'APPROVED' || activeAttendance?.status === 'REVIEW_REQUIRED';
  if (!isCheckedIn || showCheckInModal) {
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
              <button className="outline-button" onClick={() => setForceShiftMode(false)} style={{ fontSize: '11px', padding: '6px 7px' }}>
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
            <button className="logout-button" onClick={handleLogout}>
              <span>Keluar</span>
            </button>
          </div>
        </header>
        <main className="workspace">
          <SwipeAttendance
            actionType="CHECK_OUT"
            assignmentId={activeAssignment.id}
            onSuccess={async () => {
              setShowCheckOutModal(false);
              await handleLogout();
            }}
            onCancel={() => setShowCheckOutModal(false)}
          />
        </main>
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
      <header className="topbar">
        <div className="brand">
          <span><strong>HOPIN</strong><small>CAFE OPERATIONS</small></span>
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
          <button className="outline-button" onClick={() => setShowReportsView(true)} style={{ fontSize: '11px', padding: '6px 7px' }}>
            Laporan ➔
          </button>
          <button className="logout-button" onClick={handleLogout}>
            <span>Keluar</span>
          </button>
        </div>
      </header>

      <StockWorkspace
        profileId={currentUser.id}
        outletId={outletId}
        cycleId={activeAssignment.cycle_id}
        area={activeAssignment.work_cycles?.area_code}
        shift={activeAssignment.work_cycles?.shift_code}
        dutyRole={activeAssignment.duty_role}
        items={currentAreaItems}
        cycleData={cycleData}
        onRefresh={loadBootstrap}
        onCheckOutRequest={() => setShowCheckOutModal(true)}
        onGoReports={() => setShowReportsView(true)}
      />
    </div>
  );
}
