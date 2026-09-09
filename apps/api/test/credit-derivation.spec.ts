import { describe, expect, it } from 'vitest';
import { deriveBank } from '../src/readings/credit-derivation';

/*
  A change is not a balance. The bank is a running total predating any data this app has,
  so without a bill to anchor to, the change since the meter data begins is wrong by
  whatever was already banked.
*/

/** The real meter data from one install's usage export. */
const DAYS = [
  { date: '2026-07-26', importedKwh: 78, exportedKwh: 0, unmetered: true },
  { date: '2026-07-27', importedKwh: 63, exportedKwh: 83 },
  { date: '2026-07-28', importedKwh: 42, exportedKwh: 67 },
  { date: '2026-07-29', importedKwh: 43, exportedKwh: 78 },
  { date: '2026-07-30', importedKwh: 46, exportedKwh: 4 },
  { date: '2026-07-31', importedKwh: 41, exportedKwh: 23 },
  { date: '2026-08-01', importedKwh: 23, exportedKwh: 28 },
  { date: '2026-08-02', importedKwh: 28, exportedKwh: 56 },
];
const PRODUCED = new Map([['2026-07-26', 109.3]]);

describe('with nothing to anchor to', () => {
  it('reports the change and refuses to call it a balance', () => {
    const bank = deriveBank(null, DAYS, PRODUCED);
    expect(bank.balanceKwh).toBeNull();
    expect(bank.basis).toBe('change-only');
    // 339 exported against 364 imported across the eight days, including the unmetered one.
    expect(bank.netKwh).toBe(-25);
    expect(bank.summary).toContain('not the balance');
  });

  it('says nothing at all with no data and no anchor', () => {
    const bank = deriveBank(null, []);
    expect(bank.basis).toBe('none');
    expect(bank.balanceKwh).toBeNull();
  });
});

describe('anchored to a bill', () => {
  const anchor = { date: '2026-07-26', balanceKwh: 100 };

  it('counts the metered days forward from the balance', () => {
    // Seven days from the 27th: 286 imported against 339 exported, a 53 kWh surplus. The
    // anchor day is excluded because the bill already accounts for it.
    const bank = deriveBank(anchor, DAYS, PRODUCED);
    expect(bank.basis).toBe('derived');
    expect(bank.netKwh).toBe(53);
    expect(bank.balanceKwh).toBe(153);
    expect(bank.throughDate).toBe('2026-08-02');
  });

  it('keeps the balance when no meter data follows the bill', () => {
    const bank = deriveBank({ date: '2026-09-01', balanceKwh: 240 }, DAYS);
    expect(bank.balanceKwh).toBe(240);
    expect(bank.summary).toContain('still stands');
  });

  it('empties the bank rather than carrying an overdraft', () => {
    // The fold must run day by day: netting a whole period in one subtraction carries a
    // deficit forward that never existed, since a bank that empties buys the rest with money.
    const heavy = [
      { date: '2026-07-27', importedKwh: 200, exportedKwh: 0 },
      { date: '2026-07-28', importedKwh: 200, exportedKwh: 0 },
      { date: '2026-07-29', importedKwh: 0, exportedKwh: 40 },
    ];
    const bank = deriveBank({ date: '2026-07-26', balanceKwh: 50 }, heavy);
    expect(bank.balanceKwh).toBe(40);
    expect(bank.emptied).toBe(true);
    expect(bank.summary).toContain('emptied at least once');
  });

  it('counts the days it is missing', () => {
    // Missing days are usually high-consumption ones with no export, so a gap biases the
    // balance upward rather than randomly.
    const sparse = [
      { date: '2026-07-27', importedKwh: 63, exportedKwh: 83 },
      { date: '2026-08-02', importedKwh: 28, exportedKwh: 56 },
    ];
    const bank = deriveBank(anchor, sparse);
    expect(bank.missingDays).toBe(5);
    expect(bank.summary).toContain('no meter reading');
  });
});

describe('energy the meter never counted', () => {
  it('reports it separately and keeps it out of the balance', () => {
    // The 109 kWh produced on the 26th is not pending credit: the utility recorded no
    // export, so it is not in their bank and never will be. Reported separately so a
    // correct-but-low balance carries its explanation.
    const bank = deriveBank({ date: '2026-07-25', balanceKwh: 0 }, DAYS, PRODUCED);
    expect(bank.neverCreditedKwh).toBe(109.3);
    // The 26th contributes its 78 kWh import and no export, as the utility saw it, so an
    // empty bank stays at zero rather than going into credit; the next week rebuilds it to 53.
    expect(bank.emptied).toBe(true);
    expect(bank.balanceKwh).toBe(53);
  });

  it('is zero when every producing day was metered', () => {
    expect(deriveBank(null, DAYS.slice(1), PRODUCED).neverCreditedKwh).toBe(0);
  });
});
