import { describe, expect, it } from 'vitest';
import { SavingsService } from '../src/readings/savings.service';
import { localDateOf } from '../src/common/localdate';

/**
 * The savings model has two invariants worth pinning:
 *   gross     === netMeteringCredit + bonusCaptured + bonusForegone
 *   realized  === netMeteringCredit + bonusCaptured
 * plus: self-consumption can never exceed production, and it must be summed over the SAME
 * calendar buckets as production (the rolling-window mismatch is what this suite exists to
 * catch — the previous version's mock ignored the window argument and could not).
 */

interface Opts {
  todayWh: number;
  monthWh?: number;
  lifetimeWh: number;
  retail: number;
  hst: number;
  /** Charge sessions as [ISO start, solar Wh]. */
  sessions?: Array<[string, number]>;
  /** Battery samples as [ISO instant, watts] — negative watts = discharging. */
  battery?: Array<[string, number]>;
  systemCostCad?: number | null;
}

function makeService(opts: Opts): SavingsService {
  const readings = {
    getEnergyStats: async () => ({
      todayWh: opts.todayWh,
      monthWh: opts.monthWh ?? opts.lifetimeWh,
      yearWh: opts.lifetimeWh,
      lifetimeWh: opts.lifetimeWh,
      systemCostCad: opts.systemCostCad === undefined ? 60000 : opts.systemCostCad,
    }),
    getConfig: async () => ({
      electricityPricePerKwh: opts.retail,
      systemCostCad: opts.systemCostCad === undefined ? 60000 : opts.systemCostCad,
      hstRate: opts.hst,
    }),
  };
  const charger = {
    getSessions: async () => ({
      sessions: (opts.sessions ?? []).map(([startedAt, solarWh]) => ({
        startedAt,
        endedAt: startedAt,
        energyWh: solarWh,
        solarWh,
        solarPct: 100,
        peakW: 0,
      })),
      totals: { energyWh: 0, solarWh: 0, solarPct: 0 },
    }),
  };
  const prisma = {
    batteryReading: {
      findMany: async () =>
        (opts.battery ?? []).map(([takenAt, powerW]) => ({ takenAt: new Date(takenAt), powerW })),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SavingsService(prisma as any, readings as any, charger as any);
}

/** An ISO instant `hoursAgo` before now — used to place charges in specific local days. */
const ago = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3600_000).toISOString();
const agoMin = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/*
  Read off the programme, via the marginal value of a kWh.

  The first attempt looked for a rule that applies to "exported" and found nothing:
  net metering credits *produced* at the pre-tax rate and adds the tax back only for
  self-consumption, so exporting looked worthless when it is worth retail/(1+tax).
  marginalValue() folds produced-rules into both sides, which is the only reading that
  survives changing programme.
*/
const exportRate = (r: { rates: { marginal: { exportedPerKwh: number } } }) =>
  r.rates.marginal.exportedPerKwh;
const premiumRate = (r: {
  rates: { marginal: { selfConsumedPerKwh: number; exportedPerKwh: number } };
}) => r.rates.marginal.selfConsumedPerKwh - r.rates.marginal.exportedPerKwh;

describe("SavingsService.getSavings", () => {
  it('derives rates: exported worth retail / (1 + HST), premium is the HST gap', async () => {
    const s = await makeService({ todayWh: 0, lifetimeWh: 1_000_000, retail: 0.16, hst: 0.15 }).getSavings();
    // Read off the programme now, not off two net-metering-shaped DTO fields.
    expect(exportRate(s)).toBeCloseTo(0.16 / 1.15, 5);
    expect(premiumRate(s)).toBeCloseTo(0.16 - 0.16 / 1.15, 5);
  });

  it('splits gross value cleanly into credit + captured + foregone', async () => {
    const s = await makeService({
      todayWh: 0,
      lifetimeWh: 5_000_000,
      retail: 0.16,
      hst: 0.15,
      sessions: [[ago(2), 5000]],
    }).getSavings();
    const { grossValue, netMeteringValue, bonusCaptured, bonusForegone, realizedSaved } = s.lifetime;
    expect(netMeteringValue + bonusCaptured + bonusForegone).toBeCloseTo(grossValue, 4);
    expect(realizedSaved).toBeCloseTo(netMeteringValue + bonusCaptured, 4);
    expect(s.lifetime.selfConsumedKwh).toBeCloseTo(5, 3);
    expect(s.lifetime.exportedKwh).toBeCloseTo(4995, 1);
  });

  // The regression test for the rolling-vs-calendar bug: a charge that happened
  // yesterday must not be attributed to today, or "today" reports a fake 100%.
  it('attributes self-consumption to the calendar day it happened on', async () => {
    const s = await makeService({
      todayWh: 4_000, // 4 kWh produced so far today
      lifetimeWh: 100_000,
      retail: 0.16,
      hst: 0.15,
      sessions: [[ago(30), 28_000]], // 28 kWh of solar charging — yesterday
    }).getSavings();
    // Yesterday's charge must NOT land in today's bucket.
    expect(s.today.selfConsumedKwh).toBe(0);
    expect(s.today.selfConsumptionPct).toBe(0);
    expect(s.today.exportedKwh).toBeCloseTo(4, 3);
    expect(s.today.bonusForegone).toBeGreaterThan(0);
    // It is still counted over the lifetime window.
    expect(s.lifetime.selfConsumedKwh).toBeCloseTo(28, 3);
  });

  it('counts a charge that happened today in today’s bucket', async () => {
    const s = await makeService({
      todayWh: 10_000,
      lifetimeWh: 10_000,
      retail: 0.16,
      hst: 0.15,
      sessions: [[ago(1), 6_000]],
    }).getSavings();
    expect(s.today.selfConsumedKwh).toBeCloseTo(6, 3);
    expect(s.today.selfConsumptionPct).toBe(60);
  });

  it('integrates battery discharge only, ignoring charging', async () => {
    // Samples at the real 60 s poll cadence. Discharging 2 kW across six 1-minute
    // intervals = 2000 W x 0.1 h = 0.2 kWh; the charging samples must contribute nothing.
    const start = 3 * 60; // minutes ago
    const battery: Array<[string, number]> = [];
    for (let i = 0; i <= 6; i++) battery.push([agoMin(start - i), -2000]);
    for (let i = 7; i <= 10; i++) battery.push([agoMin(start - i), 3000]); // charging
    const s = await makeService({
      todayWh: 20_000,
      lifetimeWh: 20_000,
      retail: 0.16,
      hst: 0.15,
      battery,
    }).getSavings();
    expect(s.measured.batteryDischargeKwhLifetime).toBeCloseTo(0.2, 2);
    expect(s.today.selfConsumedKwh).toBeCloseTo(0.2, 2);
  });

  it('does not integrate across a long gap in battery samples', async () => {
    // A two-hour hole between samples must not be counted as two hours of discharge —
    // MAX_SAMPLE_GAP_MS caps each interval at 10 minutes.
    const s = await makeService({
      todayWh: 20_000,
      lifetimeWh: 20_000,
      retail: 0.16,
      hst: 0.15,
      battery: [
        [agoMin(180), -2000],
        [agoMin(60), -2000],
      ],
    }).getSavings();
    // 2000 W capped at a 10-minute interval = 0.333 kWh, surfaced rounded to 1 dp.
    expect(s.measured.batteryDischargeKwhLifetime).toBeCloseTo(0.3, 2);
  });

  it('caps self-consumption at production without silently claiming 100%', async () => {
    // Over-claiming is clamped so the identities hold, but this should be rare now that
    // the buckets align — it is a guard, not the normal path.
    const s = await makeService({
      todayWh: 1000,
      lifetimeWh: 1_000_000,
      retail: 0.16,
      hst: 0.15,
      sessions: [[ago(1), 5000]],
    }).getSavings();
    expect(s.today.selfConsumedKwh).toBeCloseTo(1, 3);
    expect(s.today.exportedKwh).toBeCloseTo(0, 3);
    expect(s.today.grossValue).toBeCloseTo(
      s.today.netMeteringValue + s.today.bonusCaptured + s.today.bonusForegone,
      6,
    );
  });

  it('handles a zero tax rate without dividing by zero', async () => {
    const s = await makeService({ todayWh: 0, lifetimeWh: 1_000_000, retail: 0.16, hst: 0 }).getSavings();
    expect(exportRate(s)).toBeCloseTo(0.16, 6);
    expect(premiumRate(s)).toBeCloseTo(0, 6);
    expect(s.lifetime.bonusForegone).toBeCloseTo(0, 6);
    expect(s.lifetime.realizedSaved).toBeCloseTo(s.lifetime.grossValue, 6);
  });

  it('rejects a nonsensical stored tax rate instead of emitting NaN/Infinity', async () => {
    const s = await makeService({ todayWh: 0, lifetimeWh: 1_000_000, retail: 0.16, hst: -1 }).getSavings();
    expect(s.rates.perKwh.every((r) => Number.isFinite(r.ratePerKwh))).toBe(true);
    expect(Number.isFinite(s.lifetime.grossValue)).toBe(true);
    expect(Number.isFinite(s.lifetime.realizedSaved)).toBe(true);
  });

  it('produces a coherent zero-production period', async () => {
    const s = await makeService({ todayWh: 0, lifetimeWh: 0, retail: 0.16, hst: 0.15 }).getSavings();
    expect(s.today.producedKwh).toBe(0);
    expect(s.today.selfConsumptionPct).toBe(0);
    expect(s.today.grossValue).toBe(0);
    expect(s.today.realizedSaved).toBe(0);
  });

  it('bases payback on gross lifetime value and tolerates a missing system cost', async () => {
    const s = await makeService({ todayWh: 0, lifetimeWh: 5_000_000, retail: 0.16, hst: 0.15 }).getSavings();
    expect(s.lifetime.grossValue).toBeCloseTo(800, 2);
    expect(s.paybackProgressPct).toBeCloseTo((800 / 60000) * 100, 4);

    const none = await makeService({
      todayWh: 0,
      lifetimeWh: 5_000_000,
      retail: 0.16,
      hst: 0.15,
      systemCostCad: null,
    }).getSavings();
    expect(none.paybackProgressPct).toBeNull();
  });
});
