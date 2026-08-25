import { describe, expect, it } from 'vitest';
import { netMeteringProgram, valueProgram } from '../src/readings/reward-programs';

/**
 * Parity between savings.service.ts's hardcoded formula and the general engine, which are
 * algebraically identical despite looking different:
 *
 *   live   = exported×credit + self×retail
 *   engine = produced×credit + self×premium
 *
 * With produced = self + exported and credit + premium = retail, they reduce to each other.
 * An edit to either side has to break a case here.
 */
function legacy(producedKwh: number, selfConsumedKwh: number, retail: number, taxRate: number) {
  const exportCredit = retail / (1 + taxRate);
  const premium = retail - exportCredit;
  const exportedKwh = Math.max(0, producedKwh - selfConsumedKwh);
  return {
    netMeteringValue: producedKwh * exportCredit,
    bonusCaptured: selfConsumedKwh * premium,
    realizedSaved: exportedKwh * exportCredit + selfConsumedKwh * retail,
    bonusForegone: exportedKwh * premium,
  };
}

function viaEngine(producedKwh: number, selfConsumedKwh: number, retail: number, taxRate: number) {
  const exportedKwh = Math.max(0, producedKwh - selfConsumedKwh);
  const valued = valueProgram(
    netMeteringProgram(taxRate),
    { producedKwh, selfConsumedKwh, exportedKwh },
    retail,
  );
  const line = (id: string): number => valued.lines.find((l) => l.ruleId === id)?.amount ?? 0;
  return {
    netMeteringValue: line('export-credit'),
    bonusCaptured: line('tax-kept'),
    realizedSaved: valued.realised,
    bonusForegone: line('tax-foregone'),
  };
}

describe('engine parity with the original hardcoded model', () => {
  const cases: Array<[string, number, number, number, number]> = [
    ['a typical day', 120, 40, 0.16, 0.15],
    ['everything exported', 120, 0, 0.16, 0.15],
    ['everything self-consumed', 120, 120, 0.16, 0.15],
    ['nothing produced', 0, 0, 0.16, 0.15],
    ['a lifetime total', 42528, 21528, 0.16, 0.15],
    ['Quebec tax rate', 500, 210, 0.0736, 0.14975],
    ['no sales tax at all', 500, 210, 0.11, 0],
    ['an expensive European rate', 500, 210, 0.42, 0.25],
  ];

  for (const [name, produced, self, retail, tax] of cases) {
    it(`matches for ${name}`, () => {
      const a = legacy(produced, self, retail, tax);
      const b = viaEngine(produced, self, retail, tax);
      expect(b.realizedSaved).toBeCloseTo(a.realizedSaved, 9);
      expect(b.netMeteringValue).toBeCloseTo(a.netMeteringValue, 9);
      expect(b.bonusCaptured).toBeCloseTo(a.bonusCaptured, 9);
      expect(b.bonusForegone).toBeCloseTo(a.bonusForegone, 9);
    });
  }

  it('keeps the foregone tax out of the realised total', () => {
    // A ceiling is not money kept.
    const valued = valueProgram(
      netMeteringProgram(0.15),
      { producedKwh: 120, selfConsumedKwh: 40, exportedKwh: 80 },
      0.16,
    );
    expect(valued.ceiling).toBeGreaterThan(valued.realised);
    expect(valued.foregone).toBeCloseTo(valued.ceiling - valued.realised, 9);
  });

  it('has no rule that needs hourly data, so daily totals are safe to value', () => {
    const valued = valueProgram(
      netMeteringProgram(0.15),
      { producedKwh: 120, selfConsumedKwh: 40, exportedKwh: 80 },
      0.16,
    );
    expect(valued.unsupported).toEqual([]);
  });
});
