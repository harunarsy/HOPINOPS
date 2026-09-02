import type { ShiftType, Area, Item, StockStatus } from './types';

export const shiftOptions: Record<ShiftType, { label: string; hours: string }> = {
  SIANG: { label: 'Shift Siang', hours: '11.00–17.00 WIB' },
  MALAM: { label: 'Shift Malam', hours: '17.00–23.00 WIB' },
  FULL: { label: 'Full Shift', hours: '11.00–23.00 WIB' },
};

export const fmtNumber = (value: number) =>
  new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(value);

export const fmtRupiah = (value: number) =>
  new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value);

export const wibTime = (date = new Date()) =>
  new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);

export const wibDate = (date = new Date()) =>
  new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);

export const wibDateKey = (date = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

export const shiftLabel = (shift: ShiftType) => shiftOptions[shift]?.label || shift;
export const areaLabel = (area: Area) => (area === 'BAR' ? 'Bar' : 'Kitchen');

export function statusOfStock(closingQty: number | null, lowThreshold: number): StockStatus {
  if (closingQty === null || closingQty === undefined) return 'Belum diisi';
  if (closingQty <= 0) return 'Habis';
  if (closingQty <= lowThreshold) return 'Hampir habis';
  return 'Aman';
}

export function calculateBonusPool(recordedTotal: number): { percent: number; pool: number } {
  let percent = 0;
  if (recordedTotal >= 1200000) percent = 7;
  else if (recordedTotal >= 1000000) percent = 6;
  else if (recordedTotal >= 600000) percent = 5;
  const pool = Math.round((recordedTotal * percent) / 100);
  return { percent, pool };
}

export function calculateCreditedOvertime(extraMinutes: number): number {
  if (extraMinutes <= 30) return 0;
  return Math.floor((extraMinutes + 29) / 60);
}

export function movementCategoryLabel(category: string): string {
  const map: Record<string, string> = {
    PURCHASE: 'Pembelian',
    RETURN_IN: 'Retur Masuk',
    TRANSFER_IN: 'Pindahan Masuk',
    USAGE: 'Pemakaian',
    INTERNAL: 'Pemakaian Internal',
    TRANSFER_OUT: 'Pindahan Keluar',
    WASTE: 'Waste / Rusak',
  };
  return map[category] ?? category;
}
