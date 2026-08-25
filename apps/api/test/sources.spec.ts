import { describe, expect, it } from 'vitest';
import {
  attemptsFrom,
  cadenceText,
  headlineFor,
  stateOf,
  tallyOf,
  type SourceGroup,
  type SourceRow,
} from '../src/system/sources';

/*
  Whether the dashboard is being told anything. The two states worth the machinery are
  "never" — adopted and enabled but has never returned a reading — and "partial", a source
  answering on time with less than it should be carrying.
*/

const NOW = new Date('2026-08-14T18:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;

describe('stateOf', () => {
  it('calls a source live while it is answering within its own interval', () => {
    expect(stateOf({ configured: true, lastSeenAt: ago(41_000), cadenceMs: 5 * MINUTE }, NOW))
      .toBe('live');
  });

  it('separates never-answered from answered-and-stopped', () => {
    // "Silent" implies it once worked, so a source that has never returned a reading needs
    // its own state.
    expect(stateOf({ configured: true, lastSeenAt: null, cadenceMs: MINUTE }, NOW)).toBe('never');
    expect(stateOf({ configured: true, lastSeenAt: ago(18 * 60 * MINUTE), cadenceMs: 30_000 }, NOW))
      .toBe('silent');
  });

  it('says nothing is expected rather than reporting a fault', () => {
    // There is no battery here. "No data" would suggest one that is failing to answer.
    expect(stateOf({ configured: false, lastSeenAt: null, cadenceMs: null }, NOW)).toBe('off');
  });

  it('calls a source that answers on time but incompletely partial, not late', () => {
    // A gateway can reply on schedule with panels missing from the reply; calling that
    // "late" points the diagnosis at the network, which is the one place the fault is not.
    const timing = { configured: true, lastSeenAt: ago(41_000), cadenceMs: 5 * MINUTE, incomplete: true };
    expect(stateOf(timing, NOW)).toBe('partial');
  });

  it('lets silence outrank incompleteness, because stopping is the worse news', () => {
    const timing = { configured: true, lastSeenAt: ago(90 * MINUTE), cadenceMs: 5 * MINUTE, incomplete: true };
    expect(stateOf(timing, NOW)).toBe('silent');
  });

  it('tolerates one missed poll before saying anything', () => {
    // A single miss is a normal Tuesday; flagging it trains people to ignore the page.
    expect(stateOf({ configured: true, lastSeenAt: ago(7 * MINUTE), cadenceMs: 5 * MINUTE }, NOW))
      .toBe('live');
    expect(stateOf({ configured: true, lastSeenAt: ago(12 * MINUTE), cadenceMs: 5 * MINUTE }, NOW))
      .toBe('late');
  });

  it('does not call a fast-polled source silent within minutes of a nap', () => {
    // At a 30 s cadence ten intervals is five minutes, which is a car asleep rather than a
    // fault, so silence is gated on an absolute floor as well as a multiple of the cadence.
    expect(stateOf({ configured: true, lastSeenAt: ago(6 * MINUTE), cadenceMs: 30_000 }, NOW))
      .toBe('late');
    expect(stateOf({ configured: true, lastSeenAt: ago(45 * MINUTE), cadenceMs: 30_000 }, NOW))
      .toBe('silent');
  });

  it('treats a source with no cadence as current once it has been fed', () => {
    // A utility export is imported by hand; there is no interval it can be late against.
    expect(stateOf({ configured: true, lastSeenAt: ago(3 * 24 * 60 * MINUTE), cadenceMs: null }, NOW))
      .toBe('live');
  });
});

describe('attemptsFrom', () => {
  const cadence = 5 * MINUTE;

  it('marks a window that landed a reading and one that did not', () => {
    // Readings for the three most recent windows only.
    const times = [ago(1 * MINUTE), ago(6 * MINUTE), ago(11 * MINUTE)];
    const attempts = attemptsFrom(times, cadence, 5, NOW);
    expect(attempts).toEqual(['miss', 'miss', 'ok', 'ok', 'ok']);
  });

  it('reads oldest first, so the strip runs left to right as time', () => {
    const attempts = attemptsFrom([ago(1 * MINUTE)], cadence, 3, NOW);
    expect(attempts[attempts.length - 1]).toBe('ok');
    expect(attempts[0]).toBe('miss');
  });

  it('counts a reading on a window boundary once, for the newer window', () => {
    // A poller on a fixed interval lands on the boundary every time, so an off-by-one here
    // shows a permanent miss on a source answering perfectly.
    const attempts = attemptsFrom([ago(cadence)], cadence, 3, NOW);
    expect(attempts.filter((a) => a === 'ok')).toHaveLength(1);
    expect(attempts[1]).toBe('ok');
  });

  it('shows a source that has never answered as all misses, not as an empty strip', () => {
    // It should have answered twelve times and did not. That is a row of failures.
    expect(attemptsFrom([], cadence, 12, NOW).every((a) => a === 'miss')).toBe(true);
  });

  it('refuses to invent windows for a source with no interval', () => {
    expect(attemptsFrom([ago(MINUTE)], 0, 4, NOW)).toEqual(['none', 'none', 'none', 'none']);
  });
});

describe('cadenceText', () => {
  it('reads in the unit a person would say it in', () => {
    expect(cadenceText(30_000)).toBe('30 s');
    expect(cadenceText(5 * MINUTE)).toBe('5 min');
    expect(cadenceText(6 * 60 * MINUTE)).toBe('6 h');
    expect(cadenceText(null)).toBe('—');
  });
});

const row = (over: Partial<SourceRow>): SourceRow => ({
  id: 'x', name: 'Something', detail: '', state: 'live', lastSeenAt: null,
  cadenceMs: MINUTE, cadenceText: '1 min', attempts: [], ...over,
});
const group = (sources: SourceRow[]): SourceGroup[] => [{ id: 'g', title: 'G', sources }];

describe('tallyOf', () => {
  it('counts partial with late rather than with healthy', () => {
    // A partial source is not answering fully; the summary must not count it as healthy.
    const tally = tallyOf(group([
      row({ state: 'live' }), row({ state: 'partial' }), row({ state: 'late' }),
      row({ state: 'silent' }), row({ state: 'never' }), row({ state: 'off' }),
    ]));
    expect(tally).toEqual({ answering: 1, late: 2, silent: 1, never: 1, off: 1 });
  });
});

describe('headlineFor', () => {
  it('names what is wrong instead of counting it', () => {
    const headline = headlineFor(group([
      row({ state: 'live' }),
      row({ name: 'Tesla Wall Connector', state: 'silent' }),
    ]));
    expect(headline).toBe('Tesla Wall Connector has stopped reporting.');
  });

  it('says both kinds of nothing when both are present', () => {
    const headline = headlineFor(group([
      row({ name: 'Tesla Wall Connector', state: 'silent' }),
      row({ state: 'never' }), row({ state: 'never' }),
    ]));
    expect(headline).toContain('has stopped reporting');
    expect(headline).toContain('2 adopted devices have never answered once');
  });

  it('does not raise a headline for lateness alone', () => {
    // One missed poll is not news, and a page that says so every day gets ignored.
    expect(headlineFor(group([row({ state: 'live' }), row({ state: 'late' })])))
      .toBe('All 2 sources are reporting.');
  });

  it('stays quiet when nothing is expected of anything', () => {
    expect(headlineFor(group([row({ state: 'off' })]))).toBeNull();
  });
});
