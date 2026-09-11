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
type DraftLine = { item_id: string; counted_qty: number; reason_code?: string | null; notes?: string | null };
type ReportFinance = { cash_real: number; cash_app: number; qris_mandiri: number; debit_mandiri: number };
type StockSnapshotLine = { item_id: string; counted_qty: number; reason_code?: string | null; notes?: string | null };
type PhysicalBaselineLine = { item_id: string; counted_qty: number };
type PayrollExportReceipt = { export_id: string; filename: string; file_path?: string; checksum: string; label: 'DRAFT' | 'FINALIZED'; idempotent_replay?: boolean };

const DEFAULT_TIMEOUT_MS = 15_000;
const EXPORT_TIMEOUT_MS = 60_000;

const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function validIsoMonth(value?: string) {
  return value && ISO_MONTH.test(value) ? value : undefined;
}

function validIsoDate(value?: string) {
  if (!value || !ISO_DATE.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : value;
}

export type RequestOptions = RequestInit & {
  timeoutMs?: number;
};

async function request<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const isMutation = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
  const isLongOperation = path.includes('payroll.export') || path.includes('report.export');
  const timeoutMs = options.timeoutMs ?? (isLongOperation ? EXPORT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      options.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        controller.abort();
      });
    }
  }

  try {
    const res = await fetch(path, {
      ...options,
      signal: controller.signal,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      const err = new Error(
        res.ok
          ? 'Respons server tidak valid (bukan JSON).'
          : `Layanan server mengalami kendala (${res.status}). Mohon coba lagi nanti.`
      ) as any;
      err.code = 'NON_JSON_RESPONSE';
      err.status = res.status;
      throw err;
    }

    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      const err = new Error('Respons server tidak valid.') as any;
      err.code = 'INVALID_JSON_RESPONSE';
      err.status = res.status;
      throw err;
    }

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

    if (json.ok !== undefined && json.ok !== true) {
      const err = new Error('Respons server tidak valid.') as any;
      err.code = 'INVALID_API_RESPONSE';
      err.status = res.status;
      throw err;
    }
    return (json.data ?? json) as T;
  } catch (err: any) {
    if (timedOut) {
      const message = isMutation
        ? 'Hasil transaksi belum terkonfirmasi karena batas waktu jaringan. Mohon periksa status operasional sebelum mencoba kembali.'
        : `Permintaan melebihi batas waktu (${timeoutMs / 1000}s). Periksa koneksi Anda lalu coba lagi.`;
      const timeoutErr = new Error(message) as any;
      timeoutErr.code = isMutation ? 'MUTATION_TIMEOUT' : 'REQUEST_TIMEOUT';
      timeoutErr.status = 504;
      timeoutErr.isTimeout = true;
      timeoutErr.isMutation = isMutation;
      throw timeoutErr;
    }
    if (err.name === 'AbortError' && options.signal?.aborted) {
      const abortErr = new Error('Permintaan dibatalkan oleh pengguna.') as any;
      abortErr.code = 'REQUEST_ABORTED';
      throw abortErr;
    }
    if (err?.name === 'TypeError' && /failed to fetch|networkerror|network request failed/i.test(String(err?.message || ''))) {
      const networkErr = new Error('Server tidak dapat dijangkau.') as any;
      networkErr.code = 'NETWORK_ERROR';
      networkErr.cause = err;
      throw networkErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  request: <T = any>(path: string, options?: RequestOptions) => request<T>(path, options),

  // Auth
  getLoginOptions: (options?: RequestOptions) => request<{ options: { username: string; display_name: string }[] }>('/api/auth?action=options', options).then(r => r.options),
  getCurrentUser: (options?: RequestOptions) => request<{ user: any }>('/api/auth?action=me', options).then(r => r.user),
  login: (username: string, pin: string) => request<{ user: any }>('/api/auth?action=login', { method: 'POST', body: JSON.stringify({ username, pin }) }).then(r => r.user),
  changePin: (oldPin: string, newPin: string, confirmPin?: string) => request('/api/auth?action=changePin', { method: 'POST', body: JSON.stringify({ oldPin, newPin, confirmPin }) }),
  resetPin: (username: string) => request<{ ok: boolean; tempPin: string; username: string }>('/api/auth?action=resetPin', { method: 'POST', body: JSON.stringify({ username }) }),
  logout: () => request('/api/auth?action=logout', { method: 'POST' }),

  // Sessions
  listSessions: () => request<{ sessions: { session_id: string; created_at: string; last_seen_at: string; expires_at: string; version: number }[] }>('/api/app?action=sessions.list').then(r => r.sessions),
  revokeSessions: (session_ids: string[], expected_versions: number[], idempotency_key = crypto.randomUUID()) =>
    request<{ revoked_count: number; idempotent_replay: boolean }>('/api/app?action=sessions.revoke', { method: 'POST', body: JSON.stringify({ session_ids, expected_versions, idempotency_key }) }),

  // Bootstrap & Settings
  bootstrap: () => request<any>('/api/app?action=bootstrap'),
  getDashboard: (date?: string) => request<any>(`/api/app?action=dashboard.get${date ? `&date=${date}` : ''}`),
  getManagementStockReadiness: (date?: string) => request<{ work_date: string; cycles: any[] }>(`/api/app?action=management.stock.readiness${date ? `&date=${encodeURIComponent(date)}` : ''}`),
  getInvestorReports: () => request<{ reports: any[] }>('/api/app?action=investor.reports').then(r => r.reports),
  getSettings: () => request<{ outlet_id: string; version: number; latitude?: number | null; longitude?: number | null; geofence_radius_m: number; max_accuracy_m: number; gps_sample_limit: number; gps_timeout_seconds: number; late_grace_minutes: number; overtime_threshold_minutes: number; raw_gps_retention_days: number; system_mode: 'PRODUCTION' | 'PILOT' | 'MAINTENANCE'; onboarding_version: number }>('/api/app?action=settings.get'),
  updateSettings: (expected_version: number, settings: { latitude?: number | null; longitude?: number | null; geofence_radius_m?: number; max_accuracy_m?: number; gps_sample_limit?: number; gps_timeout_seconds?: number; late_grace_minutes?: number; overtime_threshold_minutes?: number; raw_gps_retention_days?: number; system_mode?: 'PRODUCTION' | 'PILOT' | 'MAINTENANCE'; onboarding_version?: number }) =>
    request<{ outlet_id: string; version: number }>('/api/app?action=settings.update', { method: 'POST', body: JSON.stringify({ expected_version, settings }) }),

  // Catalog master
  listItems: (includeArchived = false) => request<{ items: any[] }>(`/api/app?action=items.list${includeArchived ? '&include_archived=1' : ''}`).then(r => r.items),
  createItem: (item: { area_code: 'BAR' | 'KITCHEN'; name: string; unit_code: string; low_threshold: number; section_id?: string | null }) =>
    request('/api/app?action=items.create', { method: 'POST', body: JSON.stringify(item) }),
  updateItem: (item: { id: string; name: string; unit_code: string; low_threshold: number }) =>
    request('/api/app?action=items.update', { method: 'POST', body: JSON.stringify(item) }),
  archiveItem: (id: string, reason: string) => request('/api/app?action=items.archive', { method: 'POST', body: JSON.stringify({ id, reason }) }),
  restoreItem: (id: string, reason: string) => request('/api/app?action=items.restore', { method: 'POST', body: JSON.stringify({ id, reason }) }),
  itemHistory: (id: string) => request<{ revisions: any[] }>(`/api/app?action=items.history&id=${encodeURIComponent(id)}`).then(r => r.revisions),
  operatorCreateItem: (item: { area_code: 'BAR' | 'KITCHEN'; name: string; unit_code: string; low_threshold: number; section_id?: string | null }) =>
    request('/api/app?action=items.operatorCreate', { method: 'POST', body: JSON.stringify(item) }),
  operatorUpdateItem: (item: { id: string; name: string; unit_code: string; low_threshold: number }) =>
    request('/api/app?action=items.operatorUpdate', { method: 'POST', body: JSON.stringify(item) }),
  operatorArchiveItem: (id: string, reason: string) => request('/api/app?action=items.operatorArchive', { method: 'POST', body: JSON.stringify({ id, reason }) }),
  listUnitOptions: (includeArchived = false) => request<{ units: any[] }>(`/api/app?action=units.list${includeArchived ? '&include_archived=1' : ''}`).then(r => r.units),
  createUnitOption: (unit: { code: string; label: string; decimal_scale: number; sort_order?: number }) =>
    request('/api/app?action=units.create', { method: 'POST', body: JSON.stringify(unit) }),
  archiveUnitOption: (code: string, reason: string) => request('/api/app?action=units.archive', { method: 'POST', body: JSON.stringify({ code, reason }) }),
  restoreUnitOption: (code: string) => request('/api/app?action=units.restore', { method: 'POST', body: JSON.stringify({ code }) }),
  unitHistory: (code: string) => request<{ revisions: any[] }>(`/api/app?action=units.history&code=${encodeURIComponent(code)}`).then(r => r.revisions),

  // Checklist layout server-owned
  getChecklistLayout: (area_code: 'BAR' | 'KITCHEN') => request<{ version: number; pending?: boolean; pending_version?: number | null; effective_next_cycle?: boolean; sections: { id: string; name: string; position: number; active: boolean }[]; placements: { item_id: string; section_id: string; position: number }[] }>(`/api/app?action=checklist.layout&area_code=${area_code}`),
  upsertChecklistSection: (area_code: 'BAR' | 'KITCHEN', name: string, section_id: string | null, idempotency_key: string) =>
    request<{ section: any; idempotent_replay: boolean }>('/api/app?action=checklist.section.upsert', { method: 'POST', body: JSON.stringify({ area_code, name, section_id, idempotency_key }) }),
  moveChecklistItem: (area_code: 'BAR' | 'KITCHEN', item_id: string, section_id: string, position: number, expected_layout_version: number, idempotency_key: string) =>
    request<{ item_id: string; section_id: string; position: number; layout_version: number; idempotent_replay: boolean }>('/api/app?action=checklist.item.move', { method: 'POST', body: JSON.stringify({ area_code, item_id, section_id, position, expected_layout_version, idempotency_key }) }),

  // Roster & Swap
  listRoster: (month?: string) => {
    const validMonth = validIsoMonth(month);
    return request<{ roster: any[] }>(`/api/app?action=roster.list${validMonth ? `&month=${encodeURIComponent(validMonth)}` : ''}`).then(r => r.roster);
  },
  saveRoster: (entry: { work_date: string; shift_code: 'SIANG' | 'MALAM' | 'FULL'; profile_id: string; expected_area?: 'BAR' | 'KITCHEN' | null; pay_treatment?: 'BASE' | 'EXTRA' | 'MAKEUP'; override_reason?: string | null } & ({ id?: null; expected_version?: null } | { id: string; expected_version: number })) =>
    request<{ id: string; version: number }>('/api/app?action=roster.save', { method: 'POST', body: JSON.stringify(entry) }),
  cancelRoster: (id: string, expected_version: number, reason: string) =>
    request<{ id: string; version: number; status: 'CANCELLED' }>('/api/app?action=roster.cancel', { method: 'POST', body: JSON.stringify({ id, expected_version, reason }) }),
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
  listAttendanceExceptions: (from?: string, to?: string) => {
    const validFrom = validIsoDate(from);
    const validTo = validIsoDate(to);
    return request<{ exceptions: any[] }>(`/api/app?action=attendance.exceptions${validFrom ? `&from=${encodeURIComponent(validFrom)}` : ''}${validTo ? `&to=${encodeURIComponent(validTo)}` : ''}`).then(r => r.exceptions);
  },
  emergencyCheckout: (attendance_id: string, expected_version: number, reason: string, idempotency_key: string) =>
    request<{ attendance_id: string; event_id: string; status: 'REVIEW_REQUIRED'; exception_status: 'PENDING_REVIEW'; version: number; idempotent_replay: boolean }>('/api/app?action=attendance.emergencyCheckout', { method: 'POST', body: JSON.stringify({ attendance_id, expected_attendance_version: expected_version, reason, idempotency_key }) }),
  selfEmergencyCheckout: (expected_version: number, reason: string, idempotency_key: string) =>
    request<{ attendance_id: string; event_id: string; status: 'REVIEW_REQUIRED'; exception_status: 'PENDING_REVIEW'; version: number; idempotent_replay: boolean }>('/api/app?action=attendance.selfEmergencyCheckout', { method: 'POST', body: JSON.stringify({ expected_attendance_version: expected_version, reason, idempotency_key }) }),
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
  listOvertime: (filters: { from?: string; to?: string; status?: 'CANDIDATE' | 'APPROVED' | 'REJECTED' } = {}) => {
    const from = validIsoDate(filters.from);
    const to = validIsoDate(filters.to);
    const status = filters.status && ['CANDIDATE', 'APPROVED', 'REJECTED'].includes(filters.status) ? filters.status : undefined;
    return request<{ overtime: any[] }>(`/api/app?action=overtime.list${from ? `&from=${encodeURIComponent(from)}` : ''}${to ? `&to=${encodeURIComponent(to)}` : ''}${status ? `&status=${encodeURIComponent(status)}` : ''}`).then(r => r.overtime);
  },
  reviewOvertime: (claim_id: string, expected_version: number, status: 'APPROVED' | 'REJECTED', reason: string) =>
    request<{ id: string; status: 'APPROVED' | 'REJECTED'; version: number }>('/api/app?action=overtime.review', { method: 'POST', body: JSON.stringify({ claim_id, expected_version, status, reason }) }),

  // Stock Cycles
  getCycle: (cycle_id: string) => request<any>(`/api/app?action=cycle.get&cycle_id=${cycle_id}`),
  getCyclePhysicalBaseline: (cycle_id: string) => request<{ cycle_id: string; state: 'AVAILABLE' | 'REQUIRED' | 'PENDING_REVIEW'; lines: StockSnapshotLine[] }>(`/api/app?action=cycle.baseline&cycle_id=${encodeURIComponent(cycle_id)}`),
  recordCyclePhysicalBaseline: (cycle_id: string, expected_version: number, lines: PhysicalBaselineLine[], reason: string, idempotency_key: string) =>
    request<{ cycle_id: string; version: number; idempotent_replay: boolean }>('/api/app?action=cycle.baseline.record', { method: 'POST', body: JSON.stringify({ cycle_id, expected_version, lines, reason, idempotency_key }) }),
  correctCyclePhysicalBaseline: (cycle_id: string, expected_version: number, lines: PhysicalBaselineLine[], reason: string, idempotency_key: string) =>
    request<{ cycle_id: string; version: number; idempotent_replay: boolean }>('/api/app?action=cycle.baseline.correct', { method: 'POST', body: JSON.stringify({ cycle_id, expected_version, lines, reason, idempotency_key }) }),
  getStockDrafts: (cycle_id: string) => request<{ opening_draft: { id: string; lines: DraftLine[]; version: number; updated_at: string } | null; closing_draft: { id: string; lines: DraftLine[]; version: number; updated_at: string } | null }>(`/api/app?action=stock.drafts&cycle_id=${cycle_id}`),
  getOpeningReference: (cycle_id: string) => request<{ state: 'AVAILABLE' | 'INITIALIZATION_REQUIRED'; source_type: 'HANDOVER' | 'CLOSING' | 'INITIALIZATION' | null; source_id: string | null; warning_code: string | null; lines: { item_id: string; reference_qty: number | null }[] }>(`/api/app?action=opening.reference&cycle_id=${cycle_id}`),
  saveOpeningDraft: (cycle_id: string, expected_version: number | null, lines: DraftLine[], idempotency_key: string) =>
    request<{ draft_id: string; cycle_id: string; owner_id: string; version: number; line_count: number; updated_at: string; idempotent_replay: boolean }>('/api/app?action=opening.saveDraft', { method: 'POST', body: JSON.stringify({ cycle_id, expected_version, lines, idempotency_key }) }),
  confirmOpening: (cycle_id: string, lines: StockSnapshotLine[]) => request('/api/app?action=opening.confirm', { method: 'POST', body: JSON.stringify({ cycle_id, lines }) }),
  createMovement: (movement: { cycle_id: string; item_id: string; direction: 'IN' | 'OUT'; category: string; quantity: number; client_occurred_at: string; idempotency_key: string; expected_version: number; correction_of_id?: string; correction_reason?: string }) =>
    request<{ movement: any & { cycle_version: number } }>('/api/app?action=movement.create', { method: 'POST', body: JSON.stringify(movement) }),
  correctMovement: (movement: { cycle_id: string; expected_version: number; original_movement_id: string; quantity: number; idempotency_key: string; reason: string } & ({ direction: 'IN'; category: 'PURCHASE' | 'RETURN_IN' | 'TRANSFER_IN' } | { direction: 'OUT'; category: 'USAGE' | 'INTERNAL' | 'TRANSFER_OUT' | 'WASTE' })) =>
    request<{ movement: { id: string; cycle_id: string; correction_of_id: string; cycle_version: number; idempotent_replay: boolean } }>('/api/app?action=movement.correct', { method: 'POST', body: JSON.stringify(movement) }),
  completeHandover: (cycle_id: string) => request<{ handover: any }>('/api/app?action=handover.complete', { method: 'POST', body: JSON.stringify({ cycle_id }) }),
  saveClosingDraft: (cycle_id: string, expected_version: number | null, lines: DraftLine[], idempotency_key: string) =>
    request<{ draft_id: string; cycle_id: string; owner_id: string; version: number; line_count: number; updated_at: string; idempotent_replay: boolean }>('/api/app?action=closing.saveDraft', { method: 'POST', body: JSON.stringify({ cycle_id, expected_version, lines, idempotency_key }) }),
  confirmClosing: (cycle_id: string, lines: StockSnapshotLine[]) => request('/api/app?action=closing.confirm', { method: 'POST', body: JSON.stringify({ cycle_id, lines }) }),

  // Reports & Bonus & Payroll
  getReport: (work_date: string) => request<{ report: any | null; revision: any | null; finance: any | null; stock_lines: any[]; finance_draft: any | null }>(`/api/app?action=report.get&date=${encodeURIComponent(work_date)}`),
  saveReportFinance: (work_date: string, expected_version: number | null, finance: ReportFinance, idempotency_key: string) =>
    request<{ draft_id: string; outlet_id: string; work_date: string; owner_id: string; version: number; updated_at: string; idempotent_replay: boolean }>('/api/app?action=report.finance.save', { method: 'POST', body: JSON.stringify({ work_date, expected_version, finance, idempotency_key }) }),
  shareReport: (revision_id: string, expected_report_version: number, recipient_id: string, reason: string | null, idempotency_key: string) =>
    request<{ share_id: string; revision_id: string; recipient_id: string; shared_at: string; already_shared: boolean; idempotent_replay: boolean }>('/api/app?action=report.share', { method: 'POST', body: JSON.stringify({ revision_id, expected_report_version, recipient_id, reason, idempotency_key }) }),
  submitReport: (work_date: string, finance: any) => request('/api/app?action=report.submit', { method: 'POST', body: JSON.stringify({ work_date, finance }) }),
  reviewReport: (revision_id: string, status: 'APPROVED' | 'NEEDS_CLARIFICATION', note?: string) =>
    request('/api/app?action=report.review', { method: 'POST', body: JSON.stringify({ revision_id, status, note }) }),
  listReports: (from?: string) => request<{ reports: { id: string; work_date: string; status: string; current_revision: number; updated_at: string }[] }>(`/api/app?action=report.list${from ? `&from=${encodeURIComponent(from)}` : ''}`).then(r => r.reports),
  finalizeBonus: (report_revision_id: string) => request('/api/app?action=bonus.finalize', { method: 'POST', body: JSON.stringify({ report_revision_id }) }),
  previewBonus: (date?: string) => request<{ report: { id: string; work_date: string; status: string } | null; preview?: { recorded_total: number; tier_percent: number; pool_amount: number; participant_count: number }; pool: any | null; blockers: any[] }>(`/api/app?action=bonus.preview${date ? `&date=${encodeURIComponent(date)}` : ''}`),

  // Payroll Lifecycle
  getPayrollRun: (period?: string) => request<{ run: any | null; entries: any[]; adjustments: any[] }>(`/api/app?action=payroll.get${period ? `&period=${period}` : ''}`),
  previewPayroll: (period_month: string, expected_version?: number) =>
    request<{ run_id: string; status: string; version: number; entry_count: number; blockers: any[] }>('/api/app?action=payroll.preview', { method: 'POST', body: JSON.stringify({ period_month, expected_version }) }),
  adjustPayrollEntry: (entry_id: string, expected_entry_version: number, adjustment_type: string, amount: number, reason: string, idempotency_key: string) =>
    request<{ adjustment_id: string; entry_id: string; status: 'PENDING'; version: number; adjustment_type: string; amount: number; entry_version: number; idempotent_replay: boolean }>('/api/app?action=payroll.entry.adjust', { method: 'POST', body: JSON.stringify({ entry_id, expected_entry_version, adjustment_type, amount, reason, idempotency_key }) }),
  reviewPayrollAdjustment: (adjustment_id: string, expected_adjustment_version: number, expected_entry_version: number, status: 'APPROVED' | 'REJECTED', note: string, idempotency_key: string) =>
    request<{ adjustment_id: string; entry_id: string; status: 'APPROVED' | 'REJECTED'; version: number; reviewed_at: string; entry_version: number; idempotent_replay: boolean }>('/api/app?action=payroll.adjustment.review', { method: 'POST', body: JSON.stringify({ adjustment_id, expected_adjustment_version, expected_entry_version, status, note, idempotency_key }) }),
  reviewPayroll: (run_id: string, expected_version: number) =>
    request<{ run_id: string; status: string; version: number }>('/api/app?action=payroll.review', { method: 'POST', body: JSON.stringify({ run_id, expected_version }) }),
  finalizePayroll: (run_id: string, expected_version: number) =>
    request<{ run_id: string; status: string; version: number; payload_checksum: string; entry_count: number }>('/api/app?action=payroll.finalize', { method: 'POST', body: JSON.stringify({ run_id, expected_version }) }),
  markPayrollPaid: (run_id: string, expected_version: number, payment_reference: string, payment_reason: string) =>
    request<{ run_id: string; status: string; version: number; payment_reference: string; paid_at: string }>('/api/app?action=payroll.markPaid', { method: 'POST', body: JSON.stringify({ run_id, expected_version, payment_reference, payment_reason }) }),
  voidPayroll: (run_id: string, expected_version: number, void_reason: string) =>
    request<{ run_id: string; status: string; version: number; replacement_run_id: string; replacement_version: number }>('/api/app?action=payroll.void', { method: 'POST', body: JSON.stringify({ run_id, expected_version, void_reason }) }),
  exportPayrollXlsx: (run_id: string, expected_version: number, idempotency_key: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotency_key ?? '')) {
      const err = new Error('Idempotency key export wajib UUID valid dan dibuat sekali per operasi; retry wajib memakai key yang sama.') as any;
      err.code = 'VALIDATION_FAILED';
      err.status = 400;
      return Promise.reject(err);
    }
    return request<PayrollExportReceipt>('/api/app?action=payroll.export.xlsx', { method: 'POST', body: JSON.stringify({ run_id, expected_version, idempotency_key }) });
  },
  downloadPayrollExport: (export_id: string, expected_export_version: number, idempotency_key: string) =>
    request<{ url: string; expires_at: string }>('/api/app?action=payroll.export.download', { method: 'POST', body: JSON.stringify({ export_id, expected_run_version: expected_export_version, idempotency_key }) }).then(r => ({ signed_url: r.url, expires_at: r.expires_at })),

  // Onboarding & Users
  getOnboarding: () => request<{
    onboarding_version: number;
    progress: any | null;
    reset_required: boolean;
    reset_deferred: boolean;
    reset_requested_at: string | null;
  }>('/api/app?action=onboarding.get'),
  completeOnboarding: (version?: number) => request('/api/app?action=onboarding.complete', { method: 'POST', body: JSON.stringify(version ? { version } : {}) }),
  replayOnboarding: (version: number) => request<{ profile_id: string; onboarding_version: number; replay_count: number }>('/api/app?action=onboarding.replay', { method: 'POST', body: JSON.stringify({ version }) }),
  resetOnboarding: (profile_id: string, reason: string) => request<{
    reset_id: string;
    profile_id: string;
    onboarding_version: number;
    requested_at: string;
    effective: 'NEXT_BOOTSTRAP' | 'AFTER_SHIFT';
  }>('/api/app?action=onboarding.reset', { method: 'POST', body: JSON.stringify({ profile_id, reason }) }),
  listUsers: () => request<{ users: any[] }>('/api/app?action=users.list').then(r => r.users),
  createUser: (user: any) => request('/api/app?action=users.create', { method: 'POST', body: JSON.stringify(user) }),
  updateUser: (user: { id: string; expected_version: number; display_name: string; role: 'OPERATOR' | 'SUPERVISOR' | 'OWNER' | 'INVESTOR'; job_title: string }) =>
    request<{ id: string; role: 'OPERATOR' | 'SUPERVISOR' | 'OWNER' | 'INVESTOR'; version: number }>('/api/app?action=users.update', { method: 'POST', body: JSON.stringify(user) }),
  deactivateUser: (id: string, expected_version: number, reason: string) =>
    request<{ id: string; active: false; version: number; revoked_sessions: number; revoked_devices: number; cancelled_rosters: number; cancelled_swaps: number }>('/api/app?action=users.deactivate', { method: 'POST', body: JSON.stringify({ id, expected_version, reason }) }),
};
