import { describe, it, expect } from 'vitest';
import { getWibDate, getWibMinutesOfDay } from '../../api/app';

describe('WIB Timezone & Lateness Rules', () => {
  it('converts timestamps correctly to Asia/Jakarta (WIB) date regardless of UTC', () => {
    // 2026-08-30 18:00:00 UTC is 2026-08-31 01:00:00 WIB (+7h)
    const d = new Date('2026-08-30T18:00:00.000Z');
    expect(getWibDate(d)).toBe('2026-08-31');
  });

  it('calculates WIB minute of day accurately across midnight', () => {
    // 2026-08-30 04:15:00 UTC is 11:15:00 WIB (11 * 60 + 15 = 675 minutes)
    const siang = new Date('2026-08-30T04:15:00.000Z');
    expect(getWibMinutesOfDay(siang)).toBe(675);

    // 2026-08-30 10:16:00 UTC is 17:16:00 WIB (17 * 60 + 16 = 1036 minutes)
    const malam = new Date('2026-08-30T10:16:00.000Z');
    expect(getWibMinutesOfDay(malam)).toBe(1036);
  });

  it('evaluates lateness per shift schedule (SIANG 11:00 vs MALAM 17:00 with 15m grace)', () => {
    const isLate = (currentWibMinutes: number, scheduledStartMinutes: number, grace = 15) => {
      return currentWibMinutes > scheduledStartMinutes + grace;
    };

    // SIANG (11:00 = 660m)
    expect(isLate(670, 660)).toBe(false); // 11:10 -> ON_TIME
    expect(isLate(675, 660)).toBe(false); // 11:15 -> ON_TIME
    expect(isLate(676, 660)).toBe(true);  // 11:16 -> LATE

    // MALAM (17:00 = 1020m)
    expect(isLate(1030, 1020)).toBe(false); // 17:10 -> ON_TIME
    expect(isLate(1035, 1020)).toBe(false); // 17:15 -> ON_TIME
    expect(isLate(1036, 1020)).toBe(true);  // 17:16 -> LATE
  });
});
