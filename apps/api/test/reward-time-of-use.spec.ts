import { describe, expect, it } from 'vitest';
import {
  FlowBucket,
  marginalValue,
  matchesWhen,
  needsHourlyData,
  programRates,
  resolveProgram,
  timeOfUseProgram,
  valueProgram,
  valueProgramOverBuckets,
} from '../src/readings/reward-programs';

const bucket = (over: Partial<FlowBucket> = {}): FlowBucket => ({
  hour: 12,
  month: 6,
  weekday: 3,
  producedKwh: 0,
  selfConsumedKwh: 0,
  exportedKwh: 0,
  ...over,
});

/**
 * The midnight wrap is why this is a function rather than an inline comparison.
 *
 * An off-peak window of [21, 7) means 21, 22, 23, 0, 1 … 6. A naive
 * `hour >= start && hour < end` matches NOTHING for that window, which would silently
 * price every overnight kWh at zero and make a battery look worthless.
 */
describe('matchesWhen', () => {
  it('matches a normal daytime window', () => {
    expect(matchesWhen(bucket({ hour: 12 }), { hours: [7, 16] })).toBe(true);
    expect(matchesWhen(bucket({ hour: 6 }), { hours: [7, 16] })).toBe(false);
  });

  it('treats the window as half-open, so adjacent windows cannot double-count', () => {
    expect(matchesWhen(bucket({ hour: 7 }), { hours: [7, 16] })).toBe(true);
    expect(matchesWhen(bucket({ hour: 16 }), { hours: [7, 16] })).toBe(false);
  });

  it('wraps midnight', () => {
    for (const hour of [21, 22, 23, 0, 3, 6]) {
      expect(matchesWhen(bucket({ hour }), { hours: [21, 7] })).toBe(true);
    }
    for (const hour of [7, 12, 20]) {
      expect(matchesWhen(bucket({ hour }), { hours: [21, 7] })).toBe(false);
    }
  });

  it('filters by month, for seasonal rates', () => {
    expect(matchesWhen(bucket({ month: 1 }), { months: [12, 1, 2] })).toBe(true);
    expect(matchesWhen(bucket({ month: 7 }), { months: [12, 1, 2] })).toBe(false);
  });

  it('filters by weekday, for weekend rates', () => {
    expect(matchesWhen(bucket({ weekday: 0 }), { weekdays: [0, 6] })).toBe(true);
    expect(matchesWhen(bucket({ weekday: 3 }), { weekdays: [0, 6] })).toBe(false);
  });

  it('requires every stated condition, not any of them', () => {
    const when = { hours: [16, 21] as [number, number], weekdays: [1, 2, 3, 4, 5] };
    expect(matchesWhen(bucket({ hour: 18, weekday: 3 }), when)).toBe(true);
    expect(matchesWhen(bucket({ hour: 18, weekday: 0 }), when)).toBe(false); // right hour, weekend
    expect(matchesWhen(bucket({ hour: 10, weekday: 3 }), when)).toBe(false); // weekday, wrong hour
  });

  it('matches everything when unconstrained', () => {
    expect(matchesWhen(bucket(), undefined)).toBe(true);
    expect(matchesWhen(bucket(), {})).toBe(true);
  });
});

describe('the time-of-use programme', () => {
  const RETAIL = 0.16;
  const program = timeOfUseProgram(0.15);

  it('cannot be valued from period totals, and says so instead of guessing', () => {
    const flat = valueProgram(
      program,
      { producedKwh: 100, selfConsumedKwh: 40, exportedKwh: 60 },
      RETAIL,
    );
    // Four of the five rules are time-limited; pricing them against a daily lump
    // would be exactly the error the engine exists to prevent.
    expect(flat.unsupported.length).toBeGreaterThan(0);
    expect(program.rules.filter(needsHourlyData).length).toBe(flat.unsupported.length);
  });

  it('values the same kWh differently depending on when it was used', () => {
    const kwh = 10;
    const at = (hour: number, weekday = 3): number =>
      valueProgramOverBuckets(
        program,
        [bucket({ hour, weekday, selfConsumedKwh: kwh })],
        RETAIL,
      ).realised;

    const peak = at(18);
    const shoulder = at(10);
    const overnight = at(2);
    expect(peak).toBeGreaterThan(shoulder);
    expect(shoulder).toBeGreaterThan(overnight);
    // The whole point: a peak kWh is worth well over twice an overnight one.
    expect(peak / overnight).toBeGreaterThan(2);
  });

  it('prices a weekend evening as off-peak, not as peak', () => {
    const weekdayEvening = valueProgramOverBuckets(
      program,
      [bucket({ hour: 18, weekday: 3, selfConsumedKwh: 10 })],
      RETAIL,
    ).realised;
    const sundayEvening = valueProgramOverBuckets(
      program,
      [bucket({ hour: 18, weekday: 0, selfConsumedKwh: 10 })],
      RETAIL,
    ).realised;
    expect(sundayEvening).toBeLessThan(weekdayEvening);
  });

  it('prices every hour of the week exactly once', () => {
    /*
      The failure this catches is silent and expensive in both directions: a gap
      leaves some hours worth nothing, an overlap pays twice for the same kWh. Sweep
      the whole week with 1 kWh per hour and check each is counted once.
    */
    for (let weekday = 0; weekday < 7; weekday++) {
      for (let hour = 0; hour < 24; hour++) {
        const buckets = [bucket({ hour, weekday, selfConsumedKwh: 1 })];
        const matching = program.rules.filter(
          (rule) => rule.applies === 'selfConsumed' && matchesWhen(buckets[0], rule.when),
        );
        expect(
          matching.length,
          `weekday ${weekday} hour ${hour} matched ${matching.length} rules: ${matching
            .map((r) => r.id)
            .join(', ')}`,
        ).toBe(1);
      }
    }
  });

  it('settles export at one rate whatever the hour', () => {
    // Pricing export at the peak rate is a common and expensive misreading.
    const at = (hour: number): number =>
      valueProgramOverBuckets(program, [bucket({ hour, exportedKwh: 10 })], RETAIL).realised;
    expect(at(18)).toBeCloseTo(at(3), 9);
  });

  it('sums across buckets rather than valuing only the first', () => {
    const one = valueProgramOverBuckets(
      program,
      [bucket({ hour: 18, selfConsumedKwh: 10 })],
      RETAIL,
    ).realised;
    const three = valueProgramOverBuckets(
      program,
      [
        bucket({ hour: 18, selfConsumedKwh: 10 }),
        bucket({ hour: 18, selfConsumedKwh: 10 }),
        bucket({ hour: 18, selfConsumedKwh: 10 }),
      ],
      RETAIL,
    ).realised;
    expect(three).toBeCloseTo(one * 3, 9);
  });

  it('reports nothing unsupported, which is the point of taking buckets', () => {
    const valued = valueProgramOverBuckets(
      program,
      [bucket({ hour: 18, selfConsumedKwh: 5 })],
      RETAIL,
    );
    expect(valued.unsupported).toEqual([]);
  });

  it('handles an empty period without dividing by anything', () => {
    const valued = valueProgramOverBuckets(program, [], RETAIL);
    expect(valued.realised).toBe(0);
    expect(valued.ceiling).toBe(0);
    expect(valued.lines.every((l) => l.amount === 0)).toBe(true);
  });
});

describe('seasonal rates', () => {
  it('applies a winter-only rule only in winter', () => {
    const program = {
      id: 'winter',
      name: 'Winter premium',
      rules: [
        {
          kind: 'perKwh' as const,
          id: 'winter-only',
          label: 'Winter',
          applies: 'selfConsumed' as const,
          when: { months: [12, 1, 2] },
          rate: { fixedPerKwh: 1 },
          realised: true,
        },
      ],
    };
    const january = valueProgramOverBuckets(
      program,
      [bucket({ month: 1, selfConsumedKwh: 10 })],
      0.16,
    );
    const july = valueProgramOverBuckets(
      program,
      [bucket({ month: 7, selfConsumedKwh: 10 })],
      0.16,
    );
    expect(january.realised).toBe(10);
    expect(july.realised).toBe(0);
  });
});

/**
 * Timed rules are ALTERNATIVES; untimed ones STACK.
 *
 * Summing the four time-of-use windows reported a kWh used at home as worth 60.8c at a
 * 16c retail price — nearly four times retail — because it added peak, mid-peak,
 * off-peak and weekend together. A kWh earns exactly one of them.
 */
describe('marginalValue under a time-varying programme', () => {
  const RETAIL = 0.16;

  it('reports a range rather than a sum', () => {
    const m = marginalValue(timeOfUseProgram(0.15), RETAIL);
    expect(m.varies).toBe(true);
    // High = peak (1.5x retail), low = off-peak (0.65x). Never their sum.
    expect(m.selfConsumedPerKwh).toBeCloseTo(RETAIL * 1.5, 9);
    expect(m.selfConsumedLowPerKwh).toBeCloseTo(RETAIL * 0.65, 9);
  });

  it('never exceeds the most generous single window', () => {
    const m = marginalValue(timeOfUseProgram(0.15), RETAIL);
    const rates = programRates(timeOfUseProgram(0.15), RETAIL)
      .filter((r) => r.applies === 'selfConsumed')
      .map((r) => r.ratePerKwh);
    expect(m.selfConsumedPerKwh).toBeCloseTo(Math.max(...rates), 9);
  });

  it('leaves flat programmes reporting a single value', () => {
    for (const id of ['net-metering', 'feed-in-tariff', 'no-export']) {
      const m = marginalValue(resolveProgram(id, { taxRate: 0.15, retailPerKwh: RETAIL }), RETAIL);
      expect(m.varies).toBe(false);
      expect(m.selfConsumedLowPerKwh).toBeCloseTo(m.selfConsumedPerKwh, 9);
      expect(m.exportedLowPerKwh).toBeCloseTo(m.exportedPerKwh, 9);
    }
  });

  it('still stacks untimed rules, which genuinely add', () => {
    // Net metering credits `produced` and adds a self-use premium on top.
    const m = marginalValue(resolveProgram('net-metering', { taxRate: 0.15, retailPerKwh: RETAIL }), RETAIL);
    expect(m.selfConsumedPerKwh).toBeCloseTo(RETAIL, 9);
  });

  it('keeps export flat under time-of-use, since export settles at one rate', () => {
    const m = marginalValue(timeOfUseProgram(0.15), RETAIL);
    expect(m.exportedLowPerKwh).toBeCloseTo(m.exportedPerKwh, 9);
  });
});
