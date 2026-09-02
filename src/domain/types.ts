export type Area = 'BAR' | 'KITCHEN';
export type ShiftType = 'SIANG' | 'MALAM' | 'FULL';
export type DutyRole = 'PRIMARY' | 'HELPER';
export type AppRole = 'OPERATOR' | 'SUPERVISOR' | 'OWNER' | 'INVESTOR';

export type UserProfile = {
  id: string;
  username: string;
  display_name: string;
  role: AppRole;
  force_pin_change?: boolean;
};

export type StockStatus = 'Belum diisi' | 'Aman' | 'Hampir habis' | 'Habis';
export type ReportStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'NEEDS_CLARIFICATION';

export type Item = {
  id: string;
  area_code: Area;
  name: string;
  unit_code: string;
  decimal_scale: number;
  low_threshold: number;
  active?: boolean;
};

export type WorkCycle = {
  id: string;
  outlet_id: string;
  work_date: string;
  shift_code: ShiftType;
  area_code: Area;
  status: 'AVAILABLE' | 'ACTIVE' | 'OPEN' | 'HANDOVER_READY' | 'CLOSING_READY' | 'COMPLETED' | 'RESET';
  movement_cutoff_at?: string;
  version: number;
};

export type WorkAssignment = {
  id: string;
  cycle_id: string;
  work_date: string;
  profile_id: string;
  duty_role: DutyRole;
  status: 'ACTIVE' | 'PENDING_TASKS' | 'COMPLETED' | 'RESET';
  schedule_deviation: boolean;
  assigned_at: string;
  work_cycles?: WorkCycle;
};

export type AttendanceRecord = {
  id: string;
  outlet_id: string;
  work_date: string;
  profile_id: string;
  status: 'NOT_STARTED' | 'CHECKED_IN' | 'CHECKED_OUT' | 'MISSING_CHECKOUT' | 'REVIEW_REQUIRED' | 'APPROVED';
  scheduled_start_at?: string;
  scheduled_end_at?: string;
  lateness_status: 'ON_TIME' | 'LATE' | 'EXCUSED';
  exception_status: 'NONE' | 'PENDING_REVIEW' | 'RESOLVED' | 'REJECTED';
};

export type StockMovement = {
  id: string;
  cycle_id: string;
  item_id: string;
  direction: 'IN' | 'OUT';
  category: string;
  quantity: number;
  unit_code_snapshot: string;
  client_occurred_at?: string;
  server_occurred_at?: string;
  idempotency_key: string;
};

export type FinanceData = {
  cash_real: number;
  cash_app: number;
  qris_mandiri: number;
  debit_mandiri: number;
};
