import { describe, expect, it } from 'vitest';
import { deriveMotion } from '../src/charger/teslamate.service';

/*
  The Car page claimed "Parked in the garage" while the car was doing 47 km/h, because it
  read the Wall Connector — charging? plugged in? no? then it must be in the garage — and
  never asked the car. These cover the rule that replaced that guess.
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
    // Nothing in the signature takes a state — the omission is the point, so assert that
    // an open drive alone is enough to call it driving.
    expect(deriveMotion({ start_date: START, end_date: null }, undefined).driving).toBe(true);
  });

  it('reports parked since the drive ended, not since it started', () => {
    const m = deriveMotion({ start_date: START, end_date: END }, { speed: null });
    expect(m.driving).toBe(false);
    expect(m.since).toBe(new Date(END).toISOString());
  });

  it('keeps a stop-light zero apart from a parked null', () => {
    /*
      0 km/h while driving is a real measurement — the car is at a red light. Collapsing it
      into "not moving" would end the drive on every intersection.
    */
    const stopped = deriveMotion({ start_date: START, end_date: null }, { speed: 0 });
    expect(stopped.driving).toBe(true);
    expect(stopped.speedKmh).toBe(0);

    const parked = deriveMotion({ start_date: START, end_date: END }, { speed: 0 });
    expect(parked.speedKmh).toBeNull();
  });

  it('has no opinion when the car has never driven', () => {
    // A fresh install knows nothing. "Parked since just now" would be a lie on day one.
    const m = deriveMotion(undefined, { speed: null });
    expect(m).toEqual({ driving: false, speedKmh: null, since: null });
  });

  it('takes Date objects as pg hands them over, not just strings', () => {
    // node-postgres returns timestamps as Date; a string-only implementation would have
    // passed every test above and failed against the real database.
    const m = deriveMotion({ start_date: new Date(START), end_date: null }, { speed: 51 });
    expect(m.since).toBe(new Date(START).toISOString());
    expect(m.driving).toBe(true);
  });

  it('does not report a speed for a parked car even if the sample carries one', () => {
    // Position rows keep the last speed on some samples; reporting it would show a parked
    // car doing 60.
    expect(deriveMotion({ start_date: START, end_date: END }, { speed: 60 }).speedKmh).toBeNull();
  });
});
