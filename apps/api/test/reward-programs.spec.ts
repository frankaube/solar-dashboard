import { describe, expect, it } from 'vitest';
import {
  carbonOffsetRule,
  feedInTariffProgram,
  needsHourlyData,
  netBillingProgram,
  netMeteringProgram,
  resolveRate,
  RewardProgram,
  tieredKwh,
  valueProgram,
} from '../src/readings/reward-programs';

const RETAIL = 0.16;
const HST = 0.15;

const flows = (producedKwh: number, selfConsumedKwh: number) => ({
  producedKwh,
  selfConsumedKwh,
  exportedKwh: Math.max(0, producedKwh - selfConsumedKwh),
});

/**
 * The engine replaces a hardcoded formula that was already correct for one utility,
 * so the bar is not "does it look right" — it is "does it produce the identical
 * number". A generalisation that quietly shifts someone's savings figure is a
 * regression wearing a feature's clothes.
 */
describe('parity with the previous hardcoded model', () => {
  const legacy = (producedKwh: number, selfConsumedKwh: number) => {
    const exportCredit = RETAIL / (1 + HST);
    const premium = RETAIL - exportCredit;
    const exportedKwh = Math.max(0, producedKwh - selfConsumedKwh);
    return {
      netMeteringValue: producedKwh * exportCredit,
      bonusCaptured: selfConsumedKwh * premium,
      bonusForegone: exportedKwh * premium,
      realizedSaved: exportedKwh * exportCredit + selfConsumedKwh * RETAIL,
    };
  };

  for (const [produced, self] of [
    [376.6, 4.9],
    [1000, 0],
    [1000, 1000],
    [0, 0],
    [12_345.6, 3_210.9],
  ] as const) {
    it(`matches the old formula for ${produced} kWh produced / ${self} self-consumed`, () => {
      const old = legacy(produced, self);
      const out = valueProgram(netMeteringProgram(HST), flows(produced, self), RETAIL);
      const line = (id: string) => out.lines.find((l) => l.ruleId === id)?.amount ?? 0;

      expect(line('export-credit')).toBeCloseTo(old.netMeteringValue, 10);
      expect(line('tax-kept')).toBeCloseTo(old.bonusCaptured, 10);
      expect(line('tax-foregone')).toBeCloseTo(old.bonusForegone, 10);
      // The identity the old model guaranteed: realised = export credits + tax kept.
      expect(out.realised).toBeCloseTo(old.realizedSaved, 10);
      expect(out.foregone).toBeCloseTo(old.bonusForegone, 10);
    });
  }

  it('keeps the gross identity: realised + foregone == produced x retail', () => {
    const out = valueProgram(netMeteringProgram(HST), flows(376.6, 4.9), RETAIL);
    expect(out.ceiling).toBeCloseTo(376.6 * RETAIL, 10);
  });

  it('degrades to plain retail avoidance when there is no sales tax', () => {
    // A zero-tax jurisdiction should show no self-consumption premium at all, rather
    // than a tiny artefact of the formula.
    const out = valueProgram(netMeteringProgram(0), flows(100, 50), RETAIL);
    expect(out.lines.find((l) => l.ruleId === 'tax-kept')?.amount).toBe(0);
    expect(out.foregone).toBe(0);
    expect(out.realised).toBeCloseTo(100 * RETAIL, 10);
  });
});

describe('programme shapes the old model got wrong', () => {
  it('values a feed-in tariff independently of the retail price', () => {
    // The old model derived export value from retail. Under a FIT they are unrelated,
    // so a retail price change must not move the feed-in payment at all.
    const program = feedInTariffProgram(0.4);
    const cheap = valueProgram(program, flows(100, 20), 0.1);
    const dear = valueProgram(program, flows(100, 20), 0.9);
    const fit = (v: typeof cheap) => v.lines.find((l) => l.ruleId === 'fit-export')?.amount;
    expect(fit(cheap)).toBeCloseTo(80 * 0.4, 10);
    expect(fit(dear)).toBeCloseTo(80 * 0.4, 10);
  });

  it('shows the large self-consumption gap that net billing creates', () => {
    // Export at 3c against 16c retail: the spread is the point of the programme and
    // the old model could not express it.
    const out = valueProgram(netBillingProgram(0.03), flows(100, 0), RETAIL);
    expect(out.lines.find((l) => l.ruleId === 'billing-export')?.amount).toBeCloseTo(3, 10);
    expect(out.foregone).toBeCloseTo(100 * RETAIL, 10);
    expect(out.realised).toBeLessThan(out.foregone);
  });
});

describe('carbon offsets', () => {
  it('prices displaced emissions per tonne, not per kWh', () => {
    // 1000 kWh on a 0.5 kg/kWh grid = 0.5 t; at $80/t that is $40.
    const program: RewardProgram = {
      id: 'ab',
      name: 'test',
      rules: [carbonOffsetRule(0.5, 80)],
    };
    const out = valueProgram(program, flows(1000, 0), RETAIL);
    expect(out.lines[0].amount).toBeCloseTo(40, 10);
  });

  it('makes grid intensity the variable that matters', () => {
    // The same kWh on a coal grid versus a hydro one. A flat "carbon rate" would hide
    // this, and it is a ~500x difference.
    const at = (intensity: number) =>
      valueProgram(
        { id: 'x', name: 't', rules: [carbonOffsetRule(intensity, 80)] },
        flows(1000, 0),
        RETAIL,
      ).lines[0].amount;
    expect(at(0.5)).toBeCloseTo(40, 10);
    expect(at(0.001)).toBeCloseTo(0.08, 10);
  });

  it('counts carbon as unrealised, since most households cannot sell offsets', () => {
    const out = valueProgram(
      { id: 'x', name: 't', rules: [carbonOffsetRule(0.5, 80)] },
      flows(1000, 0),
      RETAIL,
    );
    expect(out.realised).toBe(0);
    expect(out.foregone).toBeCloseTo(40, 10);
  });
});

describe('tiers and time windows', () => {
  it('applies a tier threshold to the flow', () => {
    expect(tieredKwh(1000, { aboveKwh: 400 })).toBe(600);
    expect(tieredKwh(1000, { upToKwh: 400 })).toBe(400);
    expect(tieredKwh(1000, { aboveKwh: 400, upToKwh: 700 })).toBe(300);
    expect(tieredKwh(200, { aboveKwh: 400 })).toBe(0);
    expect(tieredKwh(1000, undefined)).toBe(1000);
  });

  it('refuses to approximate a time-of-use rule from a period total', () => {
    // Prorating a daily total across an hour window would manufacture precision the
    // data cannot support — exactly the error class this engine exists to remove. So
    // the rule is reported as unsupported and contributes nothing.
    const program: RewardProgram = {
      id: 'tou',
      name: 'Time of use',
      rules: [
        {
          kind: 'perKwh',
          id: 'peak',
          label: 'Peak export',
          applies: 'exported',
          rate: { fixedPerKwh: 0.3 },
          realised: true,
          when: { hours: [16, 20] },
        },
      ],
    };
    const out = valueProgram(program, flows(100, 0), RETAIL);
    expect(out.unsupported).toEqual(['peak']);
    expect(out.lines).toHaveLength(0);
    expect(out.realised).toBe(0);
  });

  it('flags hour and month rules as needing hourly data', () => {
    const base = { kind: 'perKwh', id: 'r', label: 'r', applies: 'exported', rate: { fixedPerKwh: 1 }, realised: true } as const;
    expect(needsHourlyData({ ...base })).toBe(false);
    expect(needsHourlyData({ ...base, when: { hours: [1, 2] } })).toBe(true);
    expect(needsHourlyData({ ...base, when: { months: [6] } })).toBe(true);
    expect(needsHourlyData({ ...base, when: { aboveKwh: 10 } })).toBe(false);
  });
});

describe('robustness', () => {
  it('resolves both rate forms', () => {
    expect(resolveRate({ fixedPerKwh: 0.4 }, 0.16)).toBe(0.4);
    expect(resolveRate({ ofRetail: 0.5 }, 0.16)).toBeCloseTo(0.08, 10);
  });

  it('drops a rule whose rate is not finite rather than poisoning the total', () => {
    // A NaN from bad stored config used to make every money field null and the page
    // render blank. One broken rule must not take the rest down with it.
    const program: RewardProgram = {
      id: 'x',
      name: 't',
      rules: [
        { kind: 'perKwh', id: 'bad', label: 'bad', applies: 'produced', rate: { fixedPerKwh: NaN }, realised: true },
        { kind: 'perKwh', id: 'good', label: 'good', applies: 'produced', rate: { fixedPerKwh: 0.1 }, realised: true },
      ],
    };
    const out = valueProgram(program, flows(100, 0), RETAIL);
    expect(out.lines.map((l) => l.ruleId)).toEqual(['good']);
    expect(out.realised).toBeCloseTo(10, 10);
  });

  it('pays fixed monthly credits by whole months, and nothing without them', () => {
    const program: RewardProgram = {
      id: 'x',
      name: 't',
      rules: [{ kind: 'fixedMonthly', id: 'credit', label: 'Standing credit', applies: 'produced', amount: 5, realised: true }],
    };
    expect(valueProgram(program, { ...flows(100, 0), months: 12 }, RETAIL).realised).toBe(60);
    expect(valueProgram(program, flows(100, 0), RETAIL).realised).toBe(0);
  });

  it('values an empty programme at zero rather than throwing', () => {
    const out = valueProgram({ id: 'x', name: 'none', rules: [] }, flows(500, 100), RETAIL);
    expect(out).toMatchObject({ realised: 0, foregone: 0, ceiling: 0 });
  });
});
