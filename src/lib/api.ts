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
  requestSwap: (roster_entry_id: string, offered_to: string) => request('/api/app?action=swap.request', { method: 'POST', body: JSON.stringify({ roster_entry_id, offered_to }) }),
  respondSwap: (swap_id: string, accept: boolean) => request('/api/app?action=swap.respond', { method: 'POST', body: JSON.stringify({ swap_id, accept }) }),

  // Assignment
  claimAssignment: (data: { work_date?: string; shift_code: string; area_code: string; duty_role: string }) =>
    request<{ assignment: any; cycle: any }>('/api/app?action=assignment.claim', { method: 'POST', body: JSON.stringify(data) }),
  resetAssignment: (assignment_id: string, reason: string) =>
    request('/api/app?action=assignment.reset', { method: 'POST', body: JSON.stringify({ assignment_id, reason }) }),

  // Attendance & GPS
  requestChallenge: (action: 'CHECK_IN' | 'CHECK_OUT') =>
    request<{ challengeId: string; nonce: string }>('/api/app?action=attendance.challenge', { method: 'POST', body: JSON.stringify({ action }) }),
  checkIn: (data: { challengeId: string; samples: any[]; note?: string; assignmentId?: string }) =>
    request('/api/app?action=attendance.checkIn', { method: 'POST', body: JSON.stringify(data) }),
  checkOut: (data: { samples?: any[]; note?: string }) =>
    request('/api/app?action=attendance.checkOut', { method: 'POST', body: JSON.stringify(data) }),

  // Stock Cycles
  getCycle: (cycle_id: string) => request<any>(`/api/app?action=cycle.get&cycle_id=${cycle_id}`),
  confirmOpening: (cycle_id: string, lines: any[]) => request('/api/app?action=opening.confirm', { method: 'POST', body: JSON.stringify({ cycle_id, lines }) }),
  createMovement: (movement: any) => request('/api/app?action=movement.create', { method: 'POST', body: JSON.stringify(movement) }),
  confirmClosing: (cycle_id: string, lines: any[]) => request('/api/app?action=closing.confirm', { method: 'POST', body: JSON.stringify({ cycle_id, lines }) }),

  // Reports & Bonus & Payroll
  submitReport: (work_date: string, finance: any) => request('/api/app?action=report.submit', { method: 'POST', body: JSON.stringify({ work_date, finance }) }),
  reviewReport: (revision_id: string, status: 'APPROVED' | 'NEEDS_CLARIFICATION', note?: string) =>
    request('/api/app?action=report.review', { method: 'POST', body: JSON.stringify({ revision_id, status, note }) }),
  finalizeBonus: (report_revision_id: string) => request('/api/app?action=bonus.finalize', { method: 'POST', body: JSON.stringify({ report_revision_id }) }),
  exportPayrollXlsx: (period_month?: string) => request<{ filename: string; file_base64: string }>('/api/app?action=payroll.export.xlsx', { method: 'POST', body: JSON.stringify({ period_month }) }),

  // Onboarding & Users
  completeOnboarding: (version = 1) => request('/api/app?action=onboarding.complete', { method: 'POST', body: JSON.stringify({ version }) }),
  listUsers: () => request<{ users: any[] }>('/api/app?action=users.list').then(r => r.users),
  createUser: (user: any) => request('/api/app?action=users.create', { method: 'POST', body: JSON.stringify(user) }),
};
