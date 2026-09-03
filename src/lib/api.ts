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

  // Items
  listItems: () => request<{ items: any[] }>('/api/app?action=items.list').then(r => r.items),
  createItem: (item: any) => request('/api/app?action=items.create', { method: 'POST', body: JSON.stringify(item) }),
  updateItem: (item: any) => request('/api/app?action=items.update', { method: 'POST', body: JSON.stringify(item) }),

  // Roster & Swap
  listRoster: (month?: string) => request<{ roster: any[] }>(`/api/app?action=roster.list${month ? `&month=${month}` : ''}`).then(r => r.roster),
  saveRoster: (entry: any) => request('/api/app?action=roster.save', { method: 'POST', body: JSON.stringify(entry) }),
  requestSwap: (roster_entry_id: string, offered_to: string, expected_version: number) => request('/api/app?action=swap.request', { method: 'POST', body: JSON.stringify({ roster_entry_id, offered_to, expected_version }) }),
  respondSwap: (swap_id: string, accept: boolean, expected_version: number) => request('/api/app?action=swap.respond', { method: 'POST', body: JSON.stringify({ swap_id, accept, expected_version }) }),

  // Assignment
  claimAssignment: (data: { work_date?: string; shift_code: string; area_code: string; duty_role: string }) =>
    request<{ assignment: any; cycle: any }>('/api/app?action=assignment.claim', { method: 'POST', body: JSON.stringify(data) }),
  resetAssignment: (assignment_id: string, reason: string, expected_version: number) =>
    request('/api/app?action=assignment.reset', { method: 'POST', body: JSON.stringify({ assignment_id, reason, expected_version }) }),

  // Attendance & GPS
  requestChallenge: (action: 'CHECK_IN' | 'CHECK_OUT') =>
    request<{ challengeId: string; nonce: string }>('/api/app?action=attendance.challenge', { method: 'POST', body: JSON.stringify({ action }) }),
  checkIn: (data: { challengeId: string; idempotencyKey: string; assignmentId?: string; samples: LocationSample[]; locationFailure?: LocationFailure; note?: string }) =>
    request('/api/app?action=attendance.checkIn', { method: 'POST', body: JSON.stringify(data) }),
  checkOut: (data: { challengeId: string; idempotencyKey: string; samples: LocationSample[]; locationFailure?: LocationFailure; note?: string }) =>
    request('/api/app?action=attendance.checkOut', { method: 'POST', body: JSON.stringify(data) }),

  // Stock Cycles
  getCycle: (cycle_id: string) => request<any>(`/api/app?action=cycle.get&cycle_id=${cycle_id}`),
  confirmOpening: (cycle_id: string, lines: any[]) => request('/api/app?action=opening.confirm', { method: 'POST', body: JSON.stringify({ cycle_id, lines }) }),
  createMovement: (movement: { cycle_id: string; item_id: string; direction: 'IN' | 'OUT'; category: string; quantity: number; client_occurred_at: string; idempotency_key: string; expected_version: number; correction_of_id?: string; correction_reason?: string }) =>
    request<{ movement: any & { cycle_version: number } }>('/api/app?action=movement.create', { method: 'POST', body: JSON.stringify(movement) }),
  completeHandover: (cycle_id: string) => request<{ handover: any }>('/api/app?action=handover.complete', { method: 'POST', body: JSON.stringify({ cycle_id }) }),
  confirmClosing: (cycle_id: string, lines: any[]) => request('/api/app?action=closing.confirm', { method: 'POST', body: JSON.stringify({ cycle_id, lines }) }),

  // Reports & Bonus & Payroll
  submitReport: (work_date: string, finance: any) => request('/api/app?action=report.submit', { method: 'POST', body: JSON.stringify({ work_date, finance }) }),
  reviewReport: (revision_id: string, status: 'APPROVED' | 'NEEDS_CLARIFICATION', note?: string) =>
    request('/api/app?action=report.review', { method: 'POST', body: JSON.stringify({ revision_id, status, note }) }),
  finalizeBonus: (report_revision_id: string) => request('/api/app?action=bonus.finalize', { method: 'POST', body: JSON.stringify({ report_revision_id }) }),

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
  completeOnboarding: (version = 1) => request('/api/app?action=onboarding.complete', { method: 'POST', body: JSON.stringify({ version }) }),
  listUsers: () => request<{ users: any[] }>('/api/app?action=users.list').then(r => r.users),
  createUser: (user: any) => request('/api/app?action=users.create', { method: 'POST', body: JSON.stringify(user) }),
};
