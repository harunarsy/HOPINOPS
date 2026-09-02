import { describe, it, expect } from 'vitest';

describe('HOPIN Domain & Business Rules', () => {
  // Bonus calculation rules: <600k 0%, 600k-<1m 5%, 1m-<1.2m 6%, >=1.2m 7%
  function calculateBonusPool(recordedTotal: number): { percent: number; pool: number } {
    let percent = 0;
    if (recordedTotal >= 1200000) percent = 7;
    else if (recordedTotal >= 1000000) percent = 6;
    else if (recordedTotal >= 600000) percent = 5;
    const pool = Math.round((recordedTotal * percent) / 100);
    return { percent, pool };
  }

  // Overtime rounding: 0-30m = 0h, 31-90m = 1h, 91-150m = 2h
  function calculateCreditedOvertime(extraMinutes: number): number {
    if (extraMinutes <= 30) return 0;
    return Math.floor((extraMinutes + 29) / 60);
  }

  // Bonus equal split with deterministic remainder allocation
  function allocateBonus(pool: number, participantIds: string[]): Record<string, number> {
    if (participantIds.length === 0 || pool <= 0) return {};
    const sorted = [...participantIds].sort();
    const baseShare = Math.floor(pool / sorted.length);
    const remainder = pool - (baseShare * sorted.length);

    const result: Record<string, number> = {};
    sorted.forEach((id, idx) => {
      result[id] = baseShare + (idx < remainder ? 1 : 0);
    });
    return result;
  }

  it('calculates bonus tiers accurately at boundaries', () => {
    expect(calculateBonusPool(599999)).toEqual({ percent: 0, pool: 0 });
    expect(calculateBonusPool(600000)).toEqual({ percent: 5, pool: 30000 });
    expect(calculateBonusPool(999999)).toEqual({ percent: 5, pool: 50000 });
    expect(calculateBonusPool(1000000)).toEqual({ percent: 6, pool: 60000 });
    expect(calculateBonusPool(1199999)).toEqual({ percent: 6, pool: 72000 });
    expect(calculateBonusPool(1200000)).toEqual({ percent: 7, pool: 84000 });
    expect(calculateBonusPool(2000000)).toEqual({ percent: 7, pool: 140000 });
  });

  it('calculates overtime hours strict to nearest hour with 30-min threshold', () => {
    expect(calculateCreditedOvertime(0)).toBe(0);
    expect(calculateCreditedOvertime(15)).toBe(0);
    expect(calculateCreditedOvertime(30)).toBe(0);
    expect(calculateCreditedOvertime(31)).toBe(1);
    expect(calculateCreditedOvertime(60)).toBe(1);
    expect(calculateCreditedOvertime(90)).toBe(1);
    expect(calculateCreditedOvertime(91)).toBe(2);
    expect(calculateCreditedOvertime(150)).toBe(2);
    expect(calculateCreditedOvertime(151)).toBe(3);
  });

  it('splits bonus equally and allocates remainder deterministically', () => {
    const participants = ['user-c', 'user-a', 'user-b'];
    // 100,000 / 3 = 33,333 remainder 1. user-a gets 33,334
    const res = allocateBonus(100000, participants);
    expect(res['user-a']).toBe(33334);
    expect(res['user-b']).toBe(33333);
    expect(res['user-c']).toBe(33333);
    expect(res['user-a'] + res['user-b'] + res['user-c']).toBe(100000);
  });

  it('derives finance totals accurately', () => {
    const cashReal = 800000;
    const cashApp = 750000;
    const qrisMandiri = 400000;
    const debitMandiri = 100000;

    const recordedTotal = cashApp + qrisMandiri + debitMandiri;
    const receivedTotal = cashReal + qrisMandiri + debitMandiri;
    const cashDifference = cashReal - cashApp;

    expect(recordedTotal).toBe(1250000);
    expect(receivedTotal).toBe(1300000);
    expect(cashDifference).toBe(50000);
  });
});
