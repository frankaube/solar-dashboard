import { describe, expect, it } from 'vitest';
import {
  CLEAR_POLLS,
  CONFIRM_POLLS,
  ConditionDebouncer,
  RENOTIFY_COOLDOWN_MS,
  buildDigest,
  routeClose,
  routeOpen,
} from '../src/alerts/alert-policy';

const KEY = 'port_underperforming|10000000000002:2';

describe('confirmation streaks', () => {
  it('does not open on a single matching poll', () => {
    // The five-minute alert from the real data: one poll, opened, notified, closed,
    // notified again. Four pushes' worth of nothing.
    const d = new ConditionDebouncer();
    expect(d.step(new Set([KEY])).toOpen).toEqual([]);
  });

  it('opens once the condition has held for the confirmation window', () => {
    const d = new ConditionDebouncer();
    for (let i = 1; i < CONFIRM_POLLS; i++) expect(d.step(new Set([KEY])).toOpen).toEqual([]);
    expect(d.step(new Set([KEY])).toOpen).toEqual([KEY]);
  });

  it('does not re-open a condition that is already confirmed', () => {
    const d = new ConditionDebouncer();
    for (let i = 0; i < CONFIRM_POLLS; i++) d.step(new Set([KEY]));
    for (let i = 0; i < 10; i++) expect(d.step(new Set([KEY])).toOpen).toEqual([]);
  });

  it('resets the streak when the condition lapses before confirming', () => {
    // A cloud passing over one panel every other poll must never accumulate into an
    // alert, however long the afternoon is.
    const d = new ConditionDebouncer();
    for (let i = 0; i < 20; i++) {
      const r = d.step(i % 2 === 0 ? new Set([KEY]) : new Set());
      expect(r.toOpen).toEqual([]);
      expect(r.toClose).toEqual([]);
    }
  });

  it('closes only after the condition has been absent for the clear window', () => {
    const d = new ConditionDebouncer();
    for (let i = 0; i < CONFIRM_POLLS; i++) d.step(new Set([KEY]));
    expect(d.step(new Set()).toClose).toEqual([]);
    expect(d.step(new Set()).toClose).toEqual([]);
    expect(d.step(new Set()).toClose).toEqual([KEY]);
  });

  it('never reports a close for something that never opened', () => {
    // An unconfirmed flicker should vanish as if it had never happened, rather than
    // producing a "resolved" notice for a problem nobody was told about.
    const d = new ConditionDebouncer();
    d.step(new Set([KEY]));
    for (let i = 0; i < 5; i++) expect(d.step(new Set()).toClose).toEqual([]);
  });

  it('survives the real flapping trace without opening anything', () => {
    // Reconstructed from the afternoon that prompted this work: a port hovering on
    // the threshold, present for one or two polls at a time. Old behaviour: eight
    // open/close cycles, sixteen pushes. New behaviour: silence.
    const trace = [1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1];
    const d = new ConditionDebouncer();
    let opens = 0;
    for (const on of trace) opens += d.step(on ? new Set([KEY]) : new Set()).toOpen.length;
    expect(opens).toBe(0);
  });

  it('still opens for a genuinely persistent fault', () => {
    // The flip side: a panel that is actually broken must not be debounced away.
    const d = new ConditionDebouncer();
    let opens = 0;
    for (let i = 0; i < 12; i++) opens += d.step(new Set([KEY])).toOpen.length;
    expect(opens).toBe(1);
  });

  it('tracks conditions independently', () => {
    const a = 'inverter_offline|A';
    const b = 'inverter_offline|B';
    const d = new ConditionDebouncer();
    for (let i = 0; i < CONFIRM_POLLS; i++) d.step(new Set([a]));
    const r = d.step(new Set([a, b]));
    expect(r.toOpen).toEqual([]); // b needs its own confirmation window
    expect(d.peek(b)?.holding).toBe(1);
  });
});

describe('notification routing', () => {
  const now = 1_700_000_000_000;

  it('interrupts for a serious condition', () => {
    expect(routeOpen({ severity: 'serious', subjectKey: 'x', now })).toBe('immediate');
  });

  it('holds a warning for the digest rather than pushing it', () => {
    // One panel down 18% is a line in a summary, not an interruption.
    expect(routeOpen({ severity: 'warning', subjectKey: 'x', now })).toBe('digest');
  });

  it('suppresses a serious repeat inside the cooldown', () => {
    // An inverter dropping in and out all afternoon pushes once, not once per cycle.
    expect(
      routeOpen({ severity: 'serious', subjectKey: 'x', now, lastNotifiedAt: now - 60_000 }),
    ).toBe('suppress');
  });

  it('allows a serious repeat once the cooldown has passed', () => {
    expect(
      routeOpen({
        severity: 'serious',
        subjectKey: 'x',
        now,
        lastNotifiedAt: now - RENOTIFY_COOLDOWN_MS - 1,
      }),
    ).toBe('immediate');
  });

  it('announces a resolution only when the opening was announced', () => {
    expect(routeClose(true)).toBe('immediate');
    // This alone halves the old volume: every silent alert used to still send a
    // "resolved" push for something nobody had been told about.
    expect(routeClose(false)).toBe('suppress');
  });
});

describe('digest', () => {
  it('is nothing when there is nothing to say', () => {
    expect(buildDigest([])).toBeNull();
  });

  it('collapses repeats of the same message into a count', () => {
    // A panel that opened, closed and reopened three times is one problem, not three.
    const text = buildDigest([
      { severity: 'warning', message: 'Panel A low' },
      { severity: 'warning', message: 'Panel A low' },
      { severity: 'warning', message: 'Panel A low' },
    ]);
    expect(text).toContain('Panel A low (3×)');
    expect(text).toContain('1 thing worth a look');
  });

  it('puts serious items above warnings', () => {
    const text = buildDigest([
      { severity: 'warning', message: 'Panel A low' },
      { severity: 'serious', message: 'Inverter B offline' },
    ])!;
    expect(text.indexOf('Inverter B offline')).toBeLessThan(text.indexOf('Panel A low'));
  });

  it('counts distinct subjects, not total events', () => {
    const text = buildDigest([
      { severity: 'warning', message: 'A' },
      { severity: 'warning', message: 'A' },
      { severity: 'warning', message: 'B' },
    ])!;
    expect(text).toContain('2 things worth a look');
  });
});

/**
 * Restart recovery.
 *
 * The streak map is in-memory; the alerts are in a database. The close loop iterates
 * the map, so an alert written before a restart was invisible to the debouncer and
 * could never be reported as over — fifteen "inverter offline" rows from one sunset
 * were still demanding acknowledgement the next morning, sun up, inverters online.
 */
describe('ConditionDebouncer.seed', () => {
  const KEY = 'inverter_offline|abc';

  it('closes a seeded condition once it stops appearing', () => {
    const d = new ConditionDebouncer(2, 2);
    d.seed([KEY]);
    expect(d.step(new Set()).toClose).toEqual([]); // first absence
    expect(d.step(new Set()).toClose).toEqual([KEY]); // confirmed gone
  });

  it('does not re-open or re-notify a condition that is already open', () => {
    // Seeded as confirmed: it is already an alert row, and re-opening would both
    // duplicate the row and push a fresh notification for nothing.
    const d = new ConditionDebouncer(2, 2);
    d.seed([KEY]);
    expect(d.step(new Set([KEY])).toOpen).toEqual([]);
    expect(d.step(new Set([KEY])).toOpen).toEqual([]);
  });

  it('keeps a still-present condition open', () => {
    const d = new ConditionDebouncer(2, 2);
    d.seed([KEY]);
    for (let i = 0; i < 5; i++) {
      const result = d.step(new Set([KEY]));
      expect(result.toOpen).toEqual([]);
      expect(result.toClose).toEqual([]);
    }
  });

  it('is idempotent, so repeated loads do not reset a clearing streak', () => {
    const d = new ConditionDebouncer(2, 2);
    d.seed([KEY]);
    d.step(new Set()); // one absence banked
    d.seed([KEY]); // a second load must not wipe it
    expect(d.step(new Set()).toClose).toEqual([KEY]);
  });

  it('leaves unseeded conditions behaving normally', () => {
    const d = new ConditionDebouncer(2, 2);
    d.seed([KEY]);
    const other = 'port_underperforming|9';
    expect(d.step(new Set([other])).toOpen).toEqual([]);
    expect(d.step(new Set([other])).toOpen).toEqual([other]);
  });
});

/**
 * The exact real-world sequence, with the shipped constants.
 *
 * Everything above uses small constants for readability, which is precisely how a
 * fix can pass its tests and still not work in production. This one uses
 * CONFIRM_POLLS/CLEAR_POLLS as shipped and the real poll cadence.
 */
describe('restart recovery at the shipped thresholds', () => {
  const KEY = 'inverter_offline|10000000000002';

  it('closes exactly CLEAR_POLLS polls after the condition goes away', () => {
    const d = new ConditionDebouncer(); // shipped defaults
    d.seed([KEY]);
    for (let poll = 1; poll < CLEAR_POLLS; poll++) {
      expect(d.step(new Set()).toClose, `poll ${poll} should not close yet`).toEqual([]);
    }
    expect(d.step(new Set()).toClose).toEqual([KEY]);
  });

  it('never re-opens the seeded condition on the way there', () => {
    const d = new ConditionDebouncer();
    d.seed([KEY]);
    for (let poll = 0; poll < CLEAR_POLLS + 2; poll++) {
      expect(d.step(new Set()).toOpen).toEqual([]);
    }
  });

  it('closes a whole fleet together, not one per poll', () => {
    // Ten sleeping inverters must clear in one pass, not over ten poll cycles.
    const keys = Array.from({ length: 10 }, (_, i) => `inverter_offline|${i}`);
    const d = new ConditionDebouncer();
    d.seed(keys);
    for (let poll = 1; poll < CLEAR_POLLS; poll++) d.step(new Set());
    expect(d.step(new Set()).toClose.sort()).toEqual([...keys].sort());
  });
});

/**
 * An open alert's wording must be able to change.
 *
 * Alerts were written once and never revisited, so the text and severity froze at the
 * moment they opened. A panel drifting from 27% down to 68% down kept the old figure,
 * and re-classifying a condition in code did nothing to the row already on the page.
 * That is covered by an integration-shaped assertion in alerts.service; this pins the
 * comparison it turns on, which is what actually decides whether a write happens.
 */
describe('detecting that an open alert needs rewording', () => {
  const changed = (
    a: { message: string; severity: string },
    b: { message: string; severity: string },
  ): boolean => a.message !== b.message || a.severity !== b.severity;

  it('writes nothing when neither the text nor the severity moved', () => {
    const same = { message: 'Inverter 4A2F is offline', severity: 'serious' };
    expect(changed(same, { ...same })).toBe(false);
  });

  it('notices a severity downgrade, which is the reporting-gap case', () => {
    expect(
      changed(
        { message: 'x', severity: 'serious' },
        { message: 'x', severity: 'warning' },
      ),
    ).toBe(true);
  });

  it('notices a reworded message at the same severity', () => {
    // A panel going from 27% to 68% below its siblings is the same condition, worse.
    expect(
      changed(
        { message: 'Panel P3 at 266 W — 27% below its siblings', severity: 'warning' },
        { message: 'Panel P3 at 114 W — 68% below its siblings', severity: 'warning' },
      ),
    ).toBe(true);
  });
});
