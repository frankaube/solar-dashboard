import { describe, expect, it } from 'vitest';
import { standingLine, weighAlerts } from '../src/pages/alertWeight';
import type { Alert } from '../src/api';

/*
  Which fault is allowed to take the widest line on the page.

  The Overview hero surrendered its headline to any open alert, so an EV charger unreachable
  for three days owned it — and would own it the next day, and the one after. The production
  sentence disappeared entirely; nothing on that band said the roof was fine while it made
  8 kW.

  The rule is not severity and it is not age. It is whether the fault costs production now.
*/

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: 1,
  type: 'source_silent',
  severity: 'warning',
  subjectKey: 'charger',
  message: 'The EV charger has not reported for 3 days',
  openedAt: '2026-08-13T12:00:00Z',
  closedAt: null,
  ackedAt: null,
  ...over,
});

describe('weighAlerts', () => {
  it('keeps a silent device out of the headline', () => {
    // The bug, in one assertion.
    const { headline, standing } = weighAlerts([alert()]);
    expect(headline).toBeNull();
    expect(standing).toHaveLength(1);
  });

  it('gives the headline to an array that has gone dark', () => {
    const dark = alert({ id: 2, type: 'array_dark', severity: 'serious', message: 'dark' });
    const { headline, standing } = weighAlerts([alert(), dark]);
    expect(headline).toBe(dark);
    expect(standing.map((a) => a.id)).toEqual([1]);
  });

  it('does not demote a dark array just because it has been dark for days', () => {
    /*
      A time-based rule would have silenced this on day two, which is precisely when it has
      cost the most. Age is not the signal; whether it is losing money right now is.
    */
    const old = alert({ type: 'array_dark', openedAt: '2026-01-01T00:00:00Z' });
    expect(weighAlerts([old]).headline).toBe(old);
  });

  it('demotes anything the owner has acknowledged', () => {
    // That is what the button is for: you have seen it and decided. It should stop asking.
    const acked = alert({ type: 'array_dark', ackedAt: '2026-08-14T09:00:00Z' });
    const { headline, standing } = weighAlerts([acked]);
    expect(headline).toBeNull();
    expect(standing).toEqual([acked]);
  });

  it('prefers serious over warning for the headline', () => {
    const warn = alert({ id: 1, type: 'snow_cover', severity: 'warning' });
    const bad = alert({ id: 2, type: 'inverter_offline', severity: 'serious' });
    expect(weighAlerts([warn, bad]).headline).toBe(bad);
  });

  it('breaks a tie with the one that has been wrong longest', () => {
    const older = alert({ id: 1, type: 'array_dark', openedAt: '2026-08-10T00:00:00Z' });
    const newer = alert({ id: 2, type: 'array_dark', openedAt: '2026-08-16T00:00:00Z' });
    expect(weighAlerts([newer, older]).headline).toBe(older);
  });

  it('holds the headline to exactly one, with the rest standing', () => {
    const a = alert({ id: 1, type: 'array_dark' });
    const b = alert({ id: 2, type: 'inverter_offline' });
    const { headline, standing } = weighAlerts([a, b]);
    expect(headline).toBe(a);
    expect(standing).toHaveLength(1);
  });

  it('says nothing at all when nothing is open', () => {
    expect(weighAlerts([])).toEqual({ headline: null, standing: [] });
  });

  it('starts an unrecognised type quiet', () => {
    /*
      A rule added later should not silently seize the headline. The loud list is the one
      that is enumerated, so being wrong about a new type is being too quiet, not too loud.
    */
    expect(weighAlerts([alert({ type: 'something_new_entirely' })]).headline).toBeNull();
  });
});

describe('standingLine', () => {
  it('names one', () => {
    expect(standingLine([alert({ message: 'EV charger silent' })])).toBe('EV charger silent');
  });

  it('names two', () => {
    const line = standingLine([alert({ message: 'a' }), alert({ message: 'b' })]);
    expect(line).toBe('a · b');
  });

  it('names the first and counts the rest past two', () => {
    // A list long enough to wrap has stopped being a glance.
    const line = standingLine([
      alert({ message: 'a' }),
      alert({ message: 'b' }),
      alert({ message: 'c' }),
    ]);
    expect(line).toBe('a · and 2 more');
  });

  it('is empty when there is nothing standing', () => {
    expect(standingLine([])).toBe('');
  });

  it('drops the explanation an alert message carries after its claim', () => {
    /*
      Both real messages, verbatim. Joined whole they overran the line by four times and the
      ellipsis cut the first one mid-word.
    */
    const line = standingLine([
      alert({
        message:
          'The EV charger has not reported for 3 days — its figures are frozen at the last reading',
      }),
      alert({
        message:
          '2 of 13 inverters send no detail, but their 2016 W is still in the system total — energy and savings are unaffected',
      }),
    ]);
    expect(line).toBe('The EV charger has not reported for 3 days · 2 of 13 inverters send no detail');
  });

  it('does not cut a message at a thousands separator', () => {
    // "12,000" has no space after the comma, which is what keeps this whole.
    expect(standingLine([alert({ message: 'Only 12,000 Wh recorded' })])).toBe(
      'Only 12,000 Wh recorded',
    );
  });

  it('leaves a message with no explanation alone', () => {
    expect(standingLine([alert({ message: 'The gateway is unreachable' })])).toBe(
      'The gateway is unreachable',
    );
  });
});
