import { describe, expect, it } from 'vitest';
import {
  PROGRAM_OPTIONS,
  marginalValue,
  noExportProgram,
  resolveProgram,
  valueProgram,
} from '../src/readings/reward-programs';

const flows = { producedKwh: 1000, selfConsumedKwh: 300, exportedKwh: 700 };
const RETAIL = 0.16;
const value = (id: string | null | undefined) =>
  valueProgram(resolveProgram(id, { taxRate: 0.15, retailPerKwh: RETAIL }), flows, RETAIL);

describe('resolveProgram', () => {
  it('resolves every id the picker offers', () => {
    // Guards the pairing: an option the UI lists but resolveProgram ignores would
    // silently give that user net metering while showing them their own choice.
    for (const option of PROGRAM_OPTIONS) {
      const program = resolveProgram(option.id, { taxRate: 0.15, retailPerKwh: RETAIL });
      expect(program.id).toBe(option.id);
    }
  });

  it('falls back to net metering for an absent setting', () => {
    // Every install that predates the picker has no row at all.
    expect(resolveProgram(undefined, { taxRate: 0.15, retailPerKwh: RETAIL }).id).toBe(
      'net-metering',
    );
    expect(resolveProgram(null, { taxRate: 0.15, retailPerKwh: RETAIL }).id).toBe('net-metering');
  });

  it('falls back rather than throwing on an unknown id', () => {
    expect(resolveProgram('from-the-future', { taxRate: 0.15, retailPerKwh: RETAIL }).id).toBe(
      'net-metering',
    );
  });
});

describe('the programmes actually differ', () => {
  it('values the same energy differently under each', () => {
    // If two programmes agreed, the picker would be decoration.
    const totals = PROGRAM_OPTIONS.map((o) => value(o.id).realised);
    expect(new Set(totals.map((t) => t.toFixed(4))).size).toBe(PROGRAM_OPTIONS.length);
  });

  it('makes net metering pay the most, and no-export the least', () => {
    expect(value('net-metering').realised).toBeGreaterThan(value('feed-in-tariff').realised);
    expect(value('feed-in-tariff').realised).toBeGreaterThan(value('no-export').realised);
  });

  it('under no-export, only self-consumption is worth anything', () => {
    const valued = value('no-export');
    expect(valued.realised).toBeCloseTo(flows.selfConsumedKwh * RETAIL, 9);
    // And the exported energy shows as a reachable ceiling, not as money kept.
    expect(valued.foregone).toBeCloseTo(flows.exportedKwh * RETAIL, 9);
  });

  it('no-export makes a battery worth far more than net metering does', () => {
    // The reason the picker matters: the app's advice inverts between these two.
    const gain = (id: string): number => {
      const none = valueProgram(
        resolveProgram(id, { taxRate: 0.15, retailPerKwh: RETAIL }),
        { producedKwh: 1000, selfConsumedKwh: 300, exportedKwh: 700 },
        RETAIL,
      ).realised;
      const stored = valueProgram(
        resolveProgram(id, { taxRate: 0.15, retailPerKwh: RETAIL }),
        { producedKwh: 1000, selfConsumedKwh: 600, exportedKwh: 400 },
        RETAIL,
      ).realised;
      return stored - none;
    };
    expect(gain('no-export')).toBeGreaterThan(gain('net-metering') * 5);
  });
});

describe('noExportProgram', () => {
  it('never counts unpaid export as realised', () => {
    const valued = valueProgram(noExportProgram(), flows, RETAIL);
    expect(valued.lines.find((l) => l.ruleId === 'export-unpaid')?.realised).toBe(false);
    expect(valued.realised).toBeLessThan(valued.ceiling);
  });

  it('needs no hourly data', () => {
    expect(valueProgram(noExportProgram(), flows, RETAIL).unsupported).toEqual([]);
  });
});

/**
 * The concept a first attempt got wrong.
 *
 * Looking for "the rule that applies to exported" finds nothing under net metering,
 * because it credits `produced` at the pre-tax rate and adds the tax back only for
 * self-consumption. That reading reports exporting as worthless — and would have put a
 * "Sent to the grid: 0¢/kWh" bar on the Savings page.
 */
describe('marginalValue', () => {
  const RETAIL = 0.16;
  const TAX = 0.15;
  const of = (id: string) =>
    marginalValue(resolveProgram(id, { taxRate: TAX, retailPerKwh: RETAIL }), RETAIL);

  it('values an exported kWh under net metering at the pre-tax rate, not zero', () => {
    expect(of('net-metering').exportedPerKwh).toBeCloseTo(RETAIL / (1 + TAX), 9);
  });

  it('values a self-consumed kWh under net metering at full retail', () => {
    expect(of('net-metering').selfConsumedPerKwh).toBeCloseTo(RETAIL, 9);
  });

  it('makes the gap exactly the tax premium', () => {
    const m = of('net-metering');
    expect(m.selfConsumedPerKwh - m.exportedPerKwh).toBeCloseTo(RETAIL - RETAIL / (1 + TAX), 9);
  });

  it('pays nothing for export under no-export, and full retail for self-use', () => {
    expect(of('no-export').exportedPerKwh).toBe(0);
    expect(of('no-export').selfConsumedPerKwh).toBeCloseTo(RETAIL, 9);
  });

  it('pays the published rate for export under a feed-in tariff', () => {
    expect(of('feed-in-tariff').exportedPerKwh).toBeCloseTo(RETAIL * 0.6, 9);
  });

  it('never makes export worth more than self-use, for any programme we ship', () => {
    // True of all three, and the reason self-consumption is always the advice.
    for (const option of PROGRAM_OPTIONS) {
      const m = of(option.id);
      expect(m.selfConsumedPerKwh).toBeGreaterThanOrEqual(m.exportedPerKwh - 1e-12);
    }
  });

  it('ignores unrealised rules, which are a ceiling rather than a rate', () => {
    // Counting them would make every programme look identically generous.
    expect(of('no-export').exportedPerKwh).toBe(0);
  });
});
