import { describe, expect, it } from 'vitest';
import { deriveBank } from '../src/readings/credit-derivation';

/*
  A change is not a balance. That distinction is the whole point of this file: a bank
  balance is a running total that predates anything this app has seen, so without a bill to
  anchor to, the change since the meter data begins is wrong by exactly whatever was
  already in the bank. Reporting one as the other would be a confident number nobody could
  check until the next bill arrived.
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
    /*
      Seven days from the 27th: 286 imported against 339 exported, a 53 kWh surplus. The
      anchor day itself is excluded — the bill already accounts for it, and counting it
      again is the commonest way a derived total drifts a day's worth every period.
    */
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
    /*
      Netting a whole period in one subtraction would carry a deficit forward that never
      existed — the bank runs out and the rest is bought with money. Folding day by day is
      the only way to see that boundary at all.
    */
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
    /*
      A gap is not slightly wrong. Missing days are almost always high-consumption ones
      nobody exported on, so the omission biases the balance upward rather than randomly.
    */
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
    /*
      The 109 kWh produced on the 26th is not pending credit — the utility recorded no
      export, so it is not in their bank either and never will be. It is carried because a
      figure that is correct and lower than someone expects needs its explanation attached,
      or it reads as a bug in this arithmetic.
    */
    const bank = deriveBank({ date: '2026-07-25', balanceKwh: 0 }, DAYS, PRODUCED);
    expect(bank.neverCreditedKwh).toBe(109.3);
    /*
      The 26th contributes its 78 kWh import and no export, exactly as the utility saw it —
      driving an empty bank to zero rather than into credit — and the following week
      rebuilds it to 53. Had that day's 109 kWh been metered the balance would be far
      higher, which is the entire point of reporting the two figures side by side.
    */
    expect(bank.emptied).toBe(true);
    expect(bank.balanceKwh).toBe(53);
  });

  it('is zero when every producing day was metered', () => {
    expect(deriveBank(null, DAYS.slice(1), PRODUCED).neverCreditedKwh).toBe(0);
  });
});
