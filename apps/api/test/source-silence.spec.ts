import { describe, expect, it } from 'vitest';
import { SourceHealth, evaluateSourceSilence } from '../src/alerts/source-silence';

/*
  Written after a Tesla Wall Connector stopped serving its API and the app polled it every
  thirty seconds for three days without a word on any screen. The Car page kept rendering
  the last reading, which is the dangerous shape of this failure: stale data that still
  displays is indistinguishable from a quiet afternoon.
*/

const NOW = new Date('2026-07-31T12:00:00Z');
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);

const charger = (over: Partial<SourceHealth> = {}): SourceHealth => ({
  key: 'charger',
  label: 'The EV charger',
  lastSeenAt: ago(1),
  intervalMs: 30_000,
  configured: true,
  ...over,
});

describe('a source that has gone quiet', () => {
  it('says nothing while it is reporting', () => {
    expect(evaluateSourceSilence([charger({ lastSeenAt: ago(0.5) })], NOW)).toEqual([]);
  });

  it('raises once it has been silent for hours', () => {
    const [alert] = evaluateSourceSilence([charger({ lastSeenAt: ago(72) })], NOW);
    expect(alert.type).toBe('source_silent');
    expect(alert.message).toMatch(/The EV charger has not reported for 3 days/);
    // The consequence, not just the fact — this is why it matters.
    expect(alert.message).toMatch(/frozen at the last reading/);
  });

  it('does not fire on a brief blip', () => {
    /*
      A 30-second poll crosses forty missed intervals in twenty minutes, which would fire
      on a Wi-Fi hiccup. The floor is hours, because an alert that cries wolf is worse than
      one that is slow.
    */
    expect(evaluateSourceSilence([charger({ lastSeenAt: ago(0.4) })], NOW)).toEqual([]);
    expect(evaluateSourceSilence([charger({ lastSeenAt: ago(1.9) })], NOW)).toEqual([]);
    expect(evaluateSourceSilence([charger({ lastSeenAt: ago(3) })], NOW)).toHaveLength(1);
  });

  it('scales the threshold to a slow source', () => {
    // Something polled hourly should not be called silent after two hours.
    const hourly = charger({ intervalMs: 3_600_000, lastSeenAt: ago(10) });
    expect(evaluateSourceSilence([hourly], NOW)).toEqual([]);
    expect(evaluateSourceSilence([{ ...hourly, lastSeenAt: ago(41) }], NOW)).toHaveLength(1);
  });

  it('ignores a source that is switched off', () => {
    expect(evaluateSourceSilence([charger({ configured: false, lastSeenAt: ago(500) })], NOW)).toEqual([]);
  });

  it('treats never-reported as a setup problem, not a silence', () => {
    /*
      Otherwise a null timestamp becomes "no data for 56 years", which is the kind of
      output that costs you trust in every other number on the page.
    */
    const [alert] = evaluateSourceSilence([charger({ lastSeenAt: null })], NOW);
    expect(alert.message).toMatch(/never reported/);
    expect(alert.message).not.toMatch(/\d{4,} (hours|days)/);
    expect(alert.message).toMatch(/check the address/);
  });

  it('keys each source stably, so hysteresis can track it', () => {
    // The debouncer matches conditions between polls by this key; a key that moved would
    // open a fresh alert every cycle.
    const twice = [
      evaluateSourceSilence([charger({ lastSeenAt: ago(72) })], NOW)[0].subjectKey,
      evaluateSourceSilence([charger({ lastSeenAt: ago(96) })], NOW)[0].subjectKey,
    ];
    expect(twice[0]).toBe(twice[1]);
  });

  it('reports hours below two days and days above', () => {
    expect(evaluateSourceSilence([charger({ lastSeenAt: ago(5) })], NOW)[0].message).toMatch(/5 hours/);
    expect(evaluateSourceSilence([charger({ lastSeenAt: ago(96) })], NOW)[0].message).toMatch(/4 days/);
  });
});
