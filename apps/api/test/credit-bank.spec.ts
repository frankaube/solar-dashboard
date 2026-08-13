import { describe, expect, it } from 'vitest';
import {
  CreditReading,
  DEFAULT_EXPIRY,
  bankStatus,
  daysUntil,
  nextExpiry,
} from '../src/readings/credit-bank';

const at = (iso: string, balanceKwh: number): CreditReading => ({
  readAt: new Date(iso),
  balanceKwh,
});

/** Pre-tax retail at 15.39c and 15% tax — what a banked kWh returns when redeemed. */
const REDEEM = 0.1539 / 1.15;

describe('nextExpiry', () => {
  it('finds this year when the date is still ahead', () => {
    expect(nextExpiry(new Date('2026-01-15T00:00:00Z')).toISOString()).toMatch(/^2026-03-31/);
  });

  it('rolls to next year once it has passed', () => {
    expect(nextExpiry(new Date('2026-04-01T00:00:00Z')).toISOString()).toMatch(/^2027-03-31/);
  });

  it('treats the expiry day itself as still open', () => {
    // A bill dated 31 March has not lost its balance yet; midnight that night is the edge.
    expect(nextExpiry(new Date('2026-03-31T09:00:00Z')).toISOString()).toMatch(/^2026-03-31/);
  });

  it('honours a different utility calendar', () => {
    const october = nextExpiry(new Date('2026-01-15T00:00:00Z'), { month: 10, day: 1 });
    expect(october.toISOString()).toMatch(/^2026-10-01/);
  });

  it('counts whole days remaining, never negative', () => {
    const expiry = nextExpiry(new Date('2026-03-01T00:00:00Z'));
    expect(daysUntil(new Date('2026-03-01T00:00:00Z'), expiry)).toBe(31);
    expect(daysUntil(new Date('2027-01-01T00:00:00Z'), expiry)).toBe(0);
  });
});

describe('with nothing recorded', () => {
  it('explains what to do rather than showing a zero', () => {
    const status = bankStatus({ readings: [], now: new Date('2026-08-01T00:00:00Z'), redeemedRatePerKwh: REDEEM });
    expect(status.balanceKwh).toBeNull();
    expect(status.basis).toBe('none');
    expect(status.message).toMatch(/enter the balance from a bill/i);
    // A zero balance and an unknown balance are different things, and only one of them is
    // reassuring. This must never render as "0 kWh banked".
    expect(status.message).not.toMatch(/^0 kWh/);
  });
});

describe('refusing to project', () => {
  it('will not draw a trend through one reading', () => {
    const status = bankStatus({
      readings: [at('2026-07-01T00:00:00Z', 900)],
      now: new Date('2026-07-02T00:00:00Z'),
      redeemedRatePerKwh: REDEEM,
    });
    expect(status.balanceKwh).toBe(900);
    expect(status.projectedKwh).toBeNull();
    expect(status.basis).toBe('single-reading');
  });

  it('will not project from a fortnight of readings', () => {
    const status = bankStatus({
      readings: [at('2026-06-01T00:00:00Z', 800), at('2026-06-15T00:00:00Z', 950)],
      now: new Date('2026-06-15T00:00:00Z'),
      redeemedRatePerKwh: REDEEM,
    });
    expect(status.basis).toBe('too-short');
    expect(status.projectedKwh).toBeNull();
    expect(status.message).toMatch(/not enough to project/i);
  });

  it('refuses when the road to expiry crosses months it has never seen', () => {
    /*
      The trap this exists for: months of summer readings, all rising, extrapolated to
      March. Credits build in summer and drain in winter, so that line is confident and
      wrong — it would report a large forfeiture for a bank that actually empties in
      February.
    */
    const readings = [
      at('2026-05-01T00:00:00Z', 400),
      at('2026-06-01T00:00:00Z', 700),
      at('2026-07-01T00:00:00Z', 1000),
      at('2026-08-01T00:00:00Z', 1300),
    ];
    const status = bankStatus({ readings, now: new Date('2026-08-01T00:00:00Z'), redeemedRatePerKwh: REDEEM });
    expect(status.basis).toBe('crosses-unseen-winter');
    expect(status.projectedKwh).toBeNull();
    expect(status.atRiskValue).toBeNull();
    expect(status.message).toMatch(/never recorded|guesswork/i);
  });
});

describe('projecting once a full year has been seen', () => {
  const fullYear = (): CreditReading[] => {
    // A year of monthly readings: builds through summer, drains through winter, and ends
    // the cycle with a surplus that would be forfeited.
    const curve: Array<[string, number]> = [
      ['2025-04-01', 100], ['2025-05-01', 400], ['2025-06-01', 800], ['2025-07-01', 1200],
      ['2025-08-01', 1500], ['2025-09-01', 1700], ['2025-10-01', 1650], ['2025-11-01', 1400],
      ['2025-12-01', 1100], ['2026-01-01', 900], ['2026-02-01', 800], ['2026-03-01', 780],
    ];
    return curve.map(([d, v]) => at(`${d}T00:00:00Z`, v));
  };

  it('projects and prices what would be lost', () => {
    const status = bankStatus({
      readings: fullYear(),
      now: new Date('2026-03-01T00:00:00Z'),
      redeemedRatePerKwh: REDEEM,
    });
    expect(status.basis).toBe('trend');
    expect(status.projectedKwh).not.toBeNull();
    expect(status.atRiskValue).not.toBeNull();
    expect(status.atRiskValue!).toBeGreaterThan(0);
    expect(status.message).toMatch(/forfeited/i);
  });

  it('values a forfeit at the redeem rate, not the retail rate', () => {
    // A banked kWh returns pre-tax retail, because buying it back attracts tax. Pricing
    // the loss at full retail would overstate it by the tax rate.
    const status = bankStatus({
      readings: fullYear(),
      now: new Date('2026-03-01T00:00:00Z'),
      redeemedRatePerKwh: REDEEM,
    });
    const implied = status.atRiskValue! / status.atRiskKwh!;
    expect(implied).toBeCloseTo(REDEEM, 4);
    expect(implied).toBeLessThan(0.1539);
  });

  it('says nothing is lost when the bank drains in time', () => {
    const draining = fullYear().map((r, i) => ({ ...r, balanceKwh: Math.max(0, 1500 - i * 140) }));
    const status = bankStatus({
      readings: draining,
      now: new Date('2026-03-01T00:00:00Z'),
      redeemedRatePerKwh: REDEEM,
    });
    expect(status.atRiskKwh).toBe(0);
    expect(status.message).toMatch(/nothing is forfeited/i);
  });

  it('never projects a negative bank', () => {
    // A steep drain extrapolated past zero would otherwise report a negative balance,
    // which is not a thing a utility does.
    const steep = [
      at('2025-06-01T00:00:00Z', 900),
      at('2025-09-01T00:00:00Z', 600),
      at('2025-12-01T00:00:00Z', 200),
      at('2026-03-01T00:00:00Z', 40),
    ];
    const status = bankStatus({
      readings: steep,
      now: new Date('2026-03-01T00:00:00Z'),
      redeemedRatePerKwh: REDEEM,
    });
    expect(status.projectedKwh).toBeGreaterThanOrEqual(0);
  });
});

describe('reading order', () => {
  it('does not care what order readings arrive in', () => {
    const shuffled = [
      at('2026-03-01T00:00:00Z', 780),
      at('2025-04-01T00:00:00Z', 100),
      at('2025-09-01T00:00:00Z', 1700),
    ];
    const status = bankStatus({
      readings: shuffled,
      now: new Date('2026-03-01T00:00:00Z'),
      redeemedRatePerKwh: REDEEM,
    });
    // Latest by date, not last in the array.
    expect(status.balanceKwh).toBe(780);
  });
});

describe('the expiry rule is a property of the tariff', () => {
  it('is not hardcoded to March', () => {
    expect(DEFAULT_EXPIRY).toEqual({ month: 3, day: 31 });
    const status = bankStatus({
      readings: [at('2026-01-01T00:00:00Z', 500)],
      now: new Date('2026-01-01T00:00:00Z'),
      redeemedRatePerKwh: REDEEM,
      rule: { month: 9, day: 30 },
    });
    expect(status.expiresAt).toMatch(/^2026-09-30/);
  });
});
