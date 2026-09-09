import { describe, expect, it } from 'vitest';
import { deriveMotion } from '../src/charger/teslamate.service';

/*
  Motion comes from the drive record, never inferred from the Wall Connector's plugged-in
  state: not charging does not mean parked.
*/

const START = '2026-07-31T18:42:58.000Z';
const END = '2026-07-31T19:10:00.000Z';

describe('deriveMotion', () => {
  it('calls an unended drive driving, and reports the speed', () => {
    const m = deriveMotion({ start_date: START, end_date: null }, { speed: 47 });
    expect(m.driving).toBe(true);
    expect(m.speedKmh).toBe(47);
    expect(m.since).toBe(new Date(START).toISOString());
  });

  it('does not trust states.state, which said "online" through that whole drive', () => {
    // `states.state` reads "online" throughout a drive; an open drive alone must suffice.
    expect(deriveMotion({ start_date: START, end_date: null }, undefined).driving).toBe(true);
  });

  it('reports parked since the drive ended, not since it started', () => {
    const m = deriveMotion({ start_date: START, end_date: END }, { speed: null });
    expect(m.driving).toBe(false);
    expect(m.since).toBe(new Date(END).toISOString());
  });

  it('keeps a stop-light zero apart from a parked null', () => {
    // 0 km/h while driving is a red light; collapsing it into "not moving" ends the drive at
    // every intersection.
    const stopped = deriveMotion({ start_date: START, end_date: null }, { speed: 0 });
    expect(stopped.driving).toBe(true);
    expect(stopped.speedKmh).toBe(0);

    const parked = deriveMotion({ start_date: START, end_date: END }, { speed: 0 });
    expect(parked.speedKmh).toBeNull();
  });

  it('has no opinion when the car has never driven', () => {
    // "Parked since just now" would be wrong on a fresh install.
    const m = deriveMotion(undefined, { speed: null });
    expect(m).toEqual({ driving: false, speedKmh: null, since: null });
  });

  it('takes Date objects as pg hands them over, not just strings', () => {
    // node-postgres returns timestamps as Date; a string-only implementation passes every
    // other case here and fails against the real database.
    const m = deriveMotion({ start_date: new Date(START), end_date: null }, { speed: 51 });
    expect(m.since).toBe(new Date(START).toISOString());
    expect(m.driving).toBe(true);
  });

  it('does not report a speed for a parked car even if the sample carries one', () => {
    // Position rows keep the last speed on some samples.
    expect(deriveMotion({ start_date: START, end_date: END }, { speed: 60 }).speedKmh).toBeNull();
  });
});
