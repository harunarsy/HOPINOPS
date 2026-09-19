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

export const wibClock = (value?: string | Date | null) => {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
};

export const wibDateTimeShort = (value?: string | Date | null) => {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
};

export const wibDateShort = (value?: string | Date | null) => {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' }).format(date);
};

export const shiftLabel = (shift: ShiftType) => shiftOptions[shift]?.label || shift;
export const areaLabel = (area: Area) => (area === 'BAR' ? 'Bar' : 'Kitchen');

function roundToScale(value: number, decimalScale: number) {
  const scale = Math.min(6, Math.max(0, Math.trunc(decimalScale)));
  return Number(value.toFixed(scale));
}

/**
 * Operator mengetik jumlah dengan koma ATAU titik sebagai pemisah desimal:
 * "1,234" dan "1.234" sama-sama dibaca 1,234 (mis. 1 kilo 234 gram).
 * "1.234.567" (pemisah berulang) selalu dibaca ribuan.
 *
 * Satu titik dengan tepat 3 angka di belakang juga dibaca ribuan — gaya
 * penulisan Indonesia — kecuali pada satuan berskala 3 (kilo), karena di sana
 * tiga angka desimal memang sah. Tanpa aturan ini, operator yang mengetik ulang
 * angka yang tampil di layar ("2.443") akan tercatat 1000x lebih kecil.
 */
export function parseQuantityInput(raw: string | null | undefined, decimalScale = 2): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/[\s\u00a0]/g, '');
  if (text === '' || !/^[0-9.,]+$/.test(text)) return null;

  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  let normalized = text;

  if (dots > 0 && commas > 0) {
    const decimalSeparator = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    const thousandsSeparator = decimalSeparator === '.' ? ',' : '.';
    normalized = text.split(thousandsSeparator).join('');
    if (decimalSeparator === ',') normalized = normalized.replace(',', '.');
  } else if (dots > 1) {
    normalized = text.split('.').join('');
  } else if (commas > 1) {
    normalized = text.split(',').join('');
  } else if (dots === 1) {
    const [whole, fraction] = text.split('.');
    const looksLikeThousands = fraction.length === 3 && /^[0-9]{1,3}$/.test(whole);
    normalized = decimalScale < 3 && looksLikeThousands ? `${whole}${fraction}` : text;
  } else if (commas === 1) {
    normalized = text.replace(',', '.');
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return roundToScale(value, decimalScale);
}

/** Bentuk tampilan kolom input setelah operator selesai mengetik (gaya Indonesia). */
export function formatQuantityInput(raw: string | null | undefined, decimalScale = 2): string {
  const value = parseQuantityInput(raw, decimalScale);
  if (value === null) return typeof raw === 'string' ? raw.trim() : '';
  return value.toFixed(Math.min(6, Math.max(0, Math.trunc(decimalScale)))).replace('.', ',');
}

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
