export type ApiResponse<T = any> = {
  ok: boolean;
  request_id?: string;
  data?: T;
  version?: number;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
};

type LocationSample = { latitude: number; longitude: number; accuracy_m: number; client_sampled_at: string };
type LocationFailure = 'DENIED' | 'TIMEOUT' | 'UNAVAILABLE';

async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const json = (await res.json()) as any;
  if (!res.ok || json.ok === false) {
    const message = json.error?.message || json.error || 'Terjadi kesalahan pada request.';
    const err = new Error(message) as any;
    err.code = json.error?.code || 'API_ERROR';
    err.details = json.error?.details;
    err.status = res.status;
    const retryAfter = res.headers.get('Retry-After');
    if (retryAfter && /^\d+$/.test(retryAfter)) {
      err.retryAfterSeconds = Number(retryAfter);
    }
    throw err;
  }

  return (json.data ?? json) as T;
}

export const api = {
  // Auth
  getLoginOptions: () => request<{ options: { username: string; display_name: string }[] }>('/api/auth?action=options').then(r => r.options),
  getCurrentUser: () => request<{ user: any }>('/api/auth?action=me').then(r => r.user),
  login: (username: string, pin: string) => request<{ user: any }>('/api/auth?action=login', { method: 'POST', body: JSON.stringify({ username, pin }) }).then(r => r.user),
  changePin: (oldPin: string, newPin: string, confirmPin?: string) => request('/api/auth?action=changePin', { method: 'POST', body: JSON.stringify({ oldPin, newPin, confirmPin }) }),
  resetPin: (username: string) => request<{ ok: boolean; tempPin: string; username: string }>('/api/auth?action=resetPin', { method: 'POST', body: JSON.stringify({ username }) }),
  logout: () => request('/api/auth?action=logout', { method: 'POST' }),

  // Bootstrap & Settings
  bootstrap: () => request<any>('/api/app?action=bootstrap'),
  getDashboard: (date?: string) => request<any>(`/api/app?action=dashboard.get${date ? `&date=${date}` : ''}`),
  getInvestorReports: () => request<{ reports: any[] }>('/api/app?action=investor.reports').then(r => r.reports),
  getSettings: () => request<{ outlet_id: string; version: number; latitude?: number | null; longitude?: number | null; geofence_radius_m: number; max_accuracy_m: number; gps_sample_limit: number; gps_timeout_seconds: number; late_grace_minutes: number; overtime_threshold_minutes: number; raw_gps_retention_days: number; system_mode: 'PRODUCTION' | 'PILOT' | 'MAINTENANCE'; onboarding_version: number }>('/api/app?action=settings.get'),
  updateSettings: (expected_version: number, settings: { latitude?: number | null; longitude?: number | null; geofence_radius_m?: number; max_accuracy_m?: number; gps_sample_limit?: number; gps_timeout_seconds?: number; late_grace_minutes?: number; overtime_threshold_minutes?: number; raw_gps_retention_days?: number; system_mode?: 'PRODUCTION' | 'PILOT' | 'MAINTENANCE'; onboarding_version?: number }) =>
    request<{ outlet_id: string; version: number }>('/api/app?action=settings.update', { method: 'POST', body: JSON.stringify({ expected_version, settings }) }),

  // Items
  listItems: () => request<{ items: any[] }>('/api/app?action=items.list').then(r => r.items),
  createItem: (item: any) => request('/api/app?action=items.create', { method: 'POST', body: JSON.stringify(item) }),
  updateItem: (item: any) => request('/api/app?action=items.update', { method: 'POST', body: JSON.stringify(item) }),
  archiveItem: (id: string, reason: string) => request('/api/app?action=items.archive', { method: 'POST', body: JSON.stringify({ id, reason }) }),

  // Roster & Swap
  listRoster: (month?: string) => request<{ roster: any[] }>(`/api/app?action=roster.list${month ? `&month=${month}` : ''}`).then(r => r.roster),
  saveRoster: (entry: { work_date: string; shift_code: 'SIANG' | 'MALAM' | 'FULL'; profile_id: string; expected_area?: 'BAR' | 'KITCHEN' | null; pay_treatment?: 'BASE' | 'EXTRA' | 'MAKEUP'; override_reason?: string | null } & ({ id?: null; expected_version?: null } | { id: string; expected_version: number })) =>
    request<{ id: string; version: number }>('/api/app?action=roster.save', { method: 'POST', body: JSON.stringify(entry) }),
  requestSwap: (roster_entry_id: string, offered_to: string, expected_version: number) => request('/api/app?action=swap.request', { method: 'POST', body: JSON.stringify({ roster_entry_id, offered_to, expected_version }) }),
  respondSwap: (swap_id: string, accept: boolean, expected_version: number) => request('/api/app?action=swap.respond', { method: 'POST', body: JSON.stringify({ swap_id, accept, expected_version }) }),
  cancelSwap: (swap_id: string, expected_version: number) =>
    request<{ id: string; status: 'CANCELLED' | 'EXPIRED'; version: number }>('/api/app?action=swap.cancel', { method: 'POST', body: JSON.stringify({ swap_id, expected_version }) }),

  // Assignment
  getActiveAssignments: (date?: string) => request<{ assignments: any[] }>(`/api/app?action=assignment.active${date ? `&date=${encodeURIComponent(date)}` : ''}`).then(r => r.assignments),
  claimAssignment: (data: { work_date?: string; shift_code: string; area_code: string; duty_role: string }) =>
    request<{ assignment: any; cycle: any }>('/api/app?action=assignment.claim', { method: 'POST', body: JSON.stringify(data) }),
  resetAssignment: (assignment_id: string, reason: string, expected_version: number) =>
    request('/api/app?action=assignment.reset', { method: 'POST', body: JSON.stringify({ assignment_id, reason, expected_version }) }),
  completeAssignment: (assignment_id: string, expected_version: number) =>
    request<{ id: string; status: 'COMPLETED'; version: number; cycle_completed: boolean }>('/api/app?action=assignment.complete', { method: 'POST', body: JSON.stringify({ assignment_id, expected_version }) }),

  // Attendance & GPS
  requestChallenge: (action: 'CHECK_IN' | 'CHECK_OUT') =>
    request<{ challengeId: string; nonce: string }>('/api/app?action=attendance.challenge', { method: 'POST', body: JSON.stringify({ action }) }),
  checkIn: (data: { challengeId: string; idempotencyKey: string; assignmentId?: string; samples: LocationSample[]; locationFailure?: LocationFailure; note?: string }) =>
    request('/api/app?action=attendance.checkIn', { method: 'POST', body: JSON.stringify(data) }),
  checkOut: (data: { challengeId: string; idempotencyKey: string; samples: LocationSample[]; locationFailure?: LocationFailure; note?: string }) =>
    request('/api/app?action=attendance.checkOut', { method: 'POST', body: JSON.stringify(data) }),
  getMyAttendance: (from?: string) => request<{ attendance: { id: string; work_date: string; status: string; lateness_status: string | null; exception_status: string | null; scheduled_start_at: string | null; scheduled_end_at: string | null; check_in_event_id: string | null; check_out_event_id: string | null }[] }>(`/api/app?action=attendance.mine${from ? `&from=${encodeURIComponent(from)}` : ''}`).then(r => r.attendance),
  listAttendanceExceptions: (from?: string, to?: string) => request<{ exceptions: any[] }>(`/api/app?action=attendance.exceptions${from ? `&from=${encodeURIComponent(from)}` : ''}${to ? `&to=${encodeURIComponent(to)}` : ''}`).then(r => r.exceptions),
  requestAttendanceCorrection: (correction: { attendance_id: string; correction_type: 'CHECK_IN_TIME' | 'CHECK_OUT_TIME' | 'STATUS' | 'LATENESS' | 'EXCEPTION'; proposed: { occurred_at: string } | { status: 'CHECKED_OUT' | 'APPROVED' } | { lateness_status: 'ON_TIME' | 'LATE' | 'EXCUSED' } | { exception_status: 'RESOLVED' }; reason: string }) =>
    request<{ id: string; attendance_id: string; status: 'PENDING' }>('/api/app?action=attendance.correction.request', { method: 'POST', body: JSON.stringify(correction) }),
  reviewAttendanceCorrection: (correction_id: string, status: 'APPROVED' | 'REJECTED', note: string) =>
    request<{ correction: any; attendance: any }>('/api/app?action=attendance.correction.review', { method: 'POST', body: JSON.stringify({ correction_id, status, note }) }),

  // Leave & Overtime
  requestLeave: (leave: { profile_id?: string; start_date: string; end_date: string; leave_type: 'SICK' | 'OTHER' | 'UNPAID' | 'OTHER_EXCEPTION'; reason: string }) =>
    request<{ id: string; profile_id: string; status: 'PENDING' }>('/api/app?action=leave.request', { method: 'POST', body: JSON.stringify(leave) }),
  cancelLeave: (leave_id: string) => request<{ id: string; status: 'CANCELLED' }>('/api/app?action=leave.cancel', { method: 'POST', body: JSON.stringify({ leave_id }) }),
  reviewLeave: (leave_id: string, status: 'APPROVED' | 'REJECTED', note: string) =>
    request<{ id: string; status: 'APPROVED' | 'REJECTED' }>('/api/app?action=leave.review', { method: 'POST', body: JSON.stringify({ leave_id, status, note }) }),
  listOvertime: (filters: { from?: string; to?: string; status?: 'CANDIDATE' | 'APPROVED' | 'REJECTED' } = {}) =>
    request<{ overtime: any[] }>(`/api/app?action=overtime.list${filters.from ? `&from=${encodeURIComponent(filters.from)}` : ''}${filters.to ? `&to=${encodeURIComponent(filters.to)}` : ''}${filters.status ? `&status=${filters.status}` : ''}`).then(r => r.overtime),
  reviewOvertime: (claim_id: string, expected_version: number, status: 'APPROVED' | 'REJECTED', reason: string) =>
    request<{ id: string; status: 'APPROVED' | 'REJECTED'; version: number }>('/api/app?action=overtime.review', { method: 'POST', body: JSON.stringify({ claim_id, expected_version, status, reason }) }),

  // Stock Cycles
  getCycle: (cycle_id: string) => request<any>(`/api/app?action=cycle.get&cycle_id=${cycle_id}`),
  getOpeningReference: (cycle_id: string) => request<{ state: 'AVAILABLE' | 'INITIALIZATION_REQUIRED'; source_type: 'HANDOVER' | 'CLOSING' | 'INITIALIZATION' | null; source_id: string | null; warning_code: string | null; lines: { item_id: string; reference_qty: number }[] }>(`/api/app?action=opening.reference&cycle_id=${cycle_id}`),
  initializeOpeningReference: (cycle_id: string, expected_version: number, reason: string) => request<{ initialization_id: string; status: 'APPROVED'; duplicate: boolean }>('/api/app?action=opening.initialize', { method: 'POST', body: JSON.stringify({ cycle_id, expected_version, idempotency_key: crypto.randomUUID(), reason }) }),
  confirmOpening: (cycle_id: string, lines: any[]) => request('/api/app?action=opening.confirm', { method: 'POST', body: JSON.stringify({ cycle_id, lines }) }),
  createMovement: (movement: { cycle_id: string; item_id: string; direction: 'IN' | 'OUT'; category: string; quantity: number; client_occurred_at: string; idempotency_key: string; expected_version: number; correction_of_id?: string; correction_reason?: string }) =>
    request<{ movement: any & { cycle_version: number } }>('/api/app?action=movement.create', { method: 'POST', body: JSON.stringify(movement) }),
  correctMovement: (movement: { cycle_id: string; expected_version: number; original_movement_id: string; quantity: number; idempotency_key: string; reason: string } & ({ direction: 'IN'; category: 'PURCHASE' | 'RETURN_IN' | 'TRANSFER_IN' } | { direction: 'OUT'; category: 'USAGE' | 'INTERNAL' | 'TRANSFER_OUT' | 'WASTE' })) =>
    request<{ movement: { id: string; cycle_id: string; correction_of_id: string; cycle_version: number; idempotent_replay: boolean } }>('/api/app?action=movement.correct', { method: 'POST', body: JSON.stringify(movement) }),
  completeHandover: (cycle_id: string) => request<{ handover: any }>('/api/app?action=handover.complete', { method: 'POST', body: JSON.stringify({ cycle_id }) }),
  confirmClosing: (cycle_id: string, lines: any[]) => request('/api/app?action=closing.confirm', { method: 'POST', body: JSON.stringify({ cycle_id, lines }) }),

  // Reports & Bonus & Payroll
  submitReport: (work_date: string, finance: any) => request('/api/app?action=report.submit', { method: 'POST', body: JSON.stringify({ work_date, finance }) }),
  reviewReport: (revision_id: string, status: 'APPROVED' | 'NEEDS_CLARIFICATION', note?: string) =>
    request('/api/app?action=report.review', { method: 'POST', body: JSON.stringify({ revision_id, status, note }) }),
  listReports: (from?: string) => request<{ reports: { id: string; work_date: string; status: string; current_revision: number; updated_at: string }[] }>(`/api/app?action=report.list${from ? `&from=${encodeURIComponent(from)}` : ''}`).then(r => r.reports),
  finalizeBonus: (report_revision_id: string) => request('/api/app?action=bonus.finalize', { method: 'POST', body: JSON.stringify({ report_revision_id }) }),
  previewBonus: (date?: string) => request<{ report: { id: string; work_date: string; status: string } | null; preview?: { recorded_total: number; tier_percent: number; pool_amount: number; participant_count: number }; pool: any | null; blockers: any[] }>(`/api/app?action=bonus.preview${date ? `&date=${encodeURIComponent(date)}` : ''}`),

  // Payroll Lifecycle
  getPayrollRun: (period?: string) => request<{ run: any | null; entries: any[] }>(`/api/app?action=payroll.get${period ? `&period=${period}` : ''}`),
  previewPayroll: (period_month: string, expected_version?: number) =>
    request<{ run_id: string; status: string; version: number; entry_count: number; blockers: any[] }>('/api/app?action=payroll.preview', { method: 'POST', body: JSON.stringify({ period_month, expected_version }) }),
  reviewPayroll: (run_id: string, expected_version: number) =>
    request<{ run_id: string; status: string; version: number }>('/api/app?action=payroll.review', { method: 'POST', body: JSON.stringify({ run_id, expected_version }) }),
  finalizePayroll: (run_id: string, expected_version: number) =>
    request<{ run_id: string; status: string; version: number; payload_checksum: string; entry_count: number }>('/api/app?action=payroll.finalize', { method: 'POST', body: JSON.stringify({ run_id, expected_version }) }),
  markPayrollPaid: (run_id: string, expected_version: number, payment_reference: string, payment_reason: string) =>
    request<{ run_id: string; status: string; version: number; payment_reference: string; paid_at: string }>('/api/app?action=payroll.markPaid', { method: 'POST', body: JSON.stringify({ run_id, expected_version, payment_reference, payment_reason }) }),
  voidPayroll: (run_id: string, expected_version: number, void_reason: string) =>
    request<{ run_id: string; status: string; version: number; replacement_run_id: string; replacement_version: number }>('/api/app?action=payroll.void', { method: 'POST', body: JSON.stringify({ run_id, expected_version, void_reason }) }),
  exportPayrollXlsx: (run_id: string, expected_version: number) => request<{ export_id: string; filename: string; file_path: string; checksum: string; label: 'DRAFT' | 'FINALIZED' }>('/api/app?action=payroll.export.xlsx', { method: 'POST', body: JSON.stringify({ run_id, expected_version }) }),

  // Onboarding & Users
  getOnboarding: () => request<{ onboarding_version: number; progress: any | null }>('/api/app?action=onboarding.get'),
  completeOnboarding: (version = 1) => request('/api/app?action=onboarding.complete', { method: 'POST', body: JSON.stringify({ version }) }),
  replayOnboarding: (version: number) => request<{ profile_id: string; onboarding_version: number; replay_count: number }>('/api/app?action=onboarding.replay', { method: 'POST', body: JSON.stringify({ version }) }),
  listUsers: () => request<{ users: any[] }>('/api/app?action=users.list').then(r => r.users),
  createUser: (user: any) => request('/api/app?action=users.create', { method: 'POST', body: JSON.stringify(user) }),
  updateUser: (user: { id: string; expected_version: number; display_name: string; role: 'OPERATOR' | 'SUPERVISOR' | 'OWNER' | 'INVESTOR'; job_title: string }) =>
    request<{ id: string; role: 'OPERATOR' | 'SUPERVISOR' | 'OWNER' | 'INVESTOR'; version: number }>('/api/app?action=users.update', { method: 'POST', body: JSON.stringify(user) }),
  deactivateUser: (id: string, expected_version: number, reason: string) =>
    request<{ id: string; active: false; version: number; revoked_sessions: number; revoked_devices: number; cancelled_rosters: number; cancelled_swaps: number }>('/api/app?action=users.deactivate', { method: 'POST', body: JSON.stringify({ id, expected_version, reason }) }),
};
