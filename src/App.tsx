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

export default function App() {
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [loginOptions, setLoginOptions] = useState<{ username: string; display_name: string }[]>([]);
  const [authLoading, setAuthLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

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
    try {
      const data = await api.bootstrap();
      setCurrentUser(data.user);
      setOutletId(data.outlet?.id || '');
      setItems(data.items || []);
      setActiveAssignment(data.activeAssignment || null);
      setActiveAttendance(data.activeAttendance || null);
      setOnboardingProgress(data.onboarding || null);
      setWorkDate(data.workDate || '');

      if (data.activeAssignment?.cycle_id) {
        const c = await api.getCycle(data.activeAssignment.cycle_id);
        setCycleData(c);
      }
    } catch (e: any) {
      console.error('Bootstrap failed', e);
    }
  };

  const loadInitialAuth = async () => {
    try {
      const [options, user] = await Promise.all([
        api.getLoginOptions().catch(() => []),
        api.getCurrentUser().catch(() => null),
      ]);
      setLoginOptions(options);
      if (user) {
        setCurrentUser(user);
        await loadBootstrap();
      }
    } catch {
      setLoginError('Layanan autentikasi belum siap.');
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
      setCurrentUser(user);
      await loadBootstrap();
    } catch (err: any) {
      setLoginError(err.message || 'Nama user atau PIN salah.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {}
    setCurrentUser(null);
    setOutletId('');
    setActiveAssignment(null);
    setActiveAttendance(null);
    setCycleData(null);
    setForceShiftMode(false);
    const options = await api.getLoginOptions().catch(() => []);
    setLoginOptions(options);
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
      setShowCheckInModal(true);
    } catch (err: any) {
      alert(err.message || 'Gagal mengambil penugasan.');
    } finally {
      setAuthLoading(false);
    }
  };

  // 1. UNAUTHENTICATED -> LOGIN
  if (!currentUser) {
    return (
      <Login
        options={loginOptions}
        onLogin={handleLogin}
        loading={authLoading}
        error={loginError}
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
  if (isManagement && !forceShiftMode && !activeAssignment) {
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
      <AssignmentScreen
        name={currentUser.display_name}
        onClaim={handleClaimAssignment}
        loading={authLoading}
        onLogout={handleLogout}
      />
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
          <button className="outline-button" onClick={() => setShowReportsView(true)} style={{ fontSize: '12px', padding: '6px 10px' }}>
            Laporan Harian ➔
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
