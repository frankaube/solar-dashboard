import { describe, expect, it } from 'vitest';
import { MATCH_WINDOW_MS, sameClockYesterday, yesterdayFor } from '../src/readings/yesterday';

/*
  "What was it doing at this time yesterday".

  Both invariants are about not inventing a number: a gap in yesterday's record comes back
  as null rather than the nearest reading that happens to exist, and the match is on the
  wall clock, not elapsed hours — across a DST boundary those differ by an hour of sun.
*/

const ZONE = 'America/Halifax';

describe('sameClockYesterday', () => {
  it('is the same wall-clock time, one day back', () => {
    // 11:07 ADT on the 6th is 14:07 UTC; the answer is 11:07 ADT on the 5th.
    const at = new Date('2026-08-06T14:07:00Z');
    expect(sameClockYesterday(at, ZONE).toISOString()).toBe('2026-08-05T14:07:00.000Z');
  });

  it('holds the clock across the spring-forward boundary, not the elapsed hours', () => {
    // Clocks go forward on 8 March 2026 in this zone, so the day is 23 h long. A flat 24
    // would answer 11:00 on the 7th for a question asked at 12:00 on the 8th.
    const at = new Date('2026-03-08T15:00:00Z'); // 12:00 ADT, after the change
    const answer = sameClockYesterday(at, ZONE);
    const elapsedHours = (at.getTime() - answer.getTime()) / 3_600_000;
    expect(elapsedHours).toBeCloseTo(23, 5);

    const wall = new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(answer);
    expect(wall).toBe('12:00');
  });

  it('holds the clock across the autumn boundary too', () => {
    const at = new Date('2026-11-01T15:00:00Z'); // 11:00 AST, after falling back
    const answer = sameClockYesterday(at, ZONE);
    expect((at.getTime() - answer.getTime()) / 3_600_000).toBeCloseTo(25, 5);
  });
});

describe('yesterdayFor', () => {
  const history = [
    { t: '2026-08-05T14:05:00Z', powerW: 9000 },
    { t: '2026-08-05T14:10:00Z', powerW: 9500 },
    { t: '2026-08-06T14:05:00Z', powerW: 10_500 },
  ];

  it('finds the reading nearest the same time yesterday', () => {
    const answer = yesterdayFor([{ t: '2026-08-06T14:07:00Z' }], history, ZONE);
    // 14:07 is two minutes from 14:05 and three from 14:10.
    expect(answer).toEqual([9000]);
  });

  it('answers null where yesterday has no reading near that moment', () => {
    // Collector outages leave hours-wide gaps; pairing them against the closest reading
    // that exists would draw a comparison from a number nobody recorded at that time.
    const answer = yesterdayFor([{ t: '2026-08-06T18:00:00Z' }], history, ZONE);
    expect(answer).toEqual([null]);
  });

  it('refuses a match just outside the window rather than stretching to it', () => {
    const justOutside = [
      { t: new Date(Date.parse('2026-08-05T14:07:00Z') - MATCH_WINDOW_MS - 1000).toISOString(), powerW: 1 },
    ];
    expect(yesterdayFor([{ t: '2026-08-06T14:07:00Z' }], justOutside, ZONE)).toEqual([null]);
  });

  it('is empty-safe at both ends', () => {
    expect(yesterdayFor([], history, ZONE)).toEqual([]);
    expect(yesterdayFor([{ t: '2026-08-06T14:07:00Z' }], [], ZONE)).toEqual([null]);
  });

  it('ignores an unparseable timestamp instead of throwing', () => {
    // History comes from a database this app also lets people import into.
    const answer = yesterdayFor([{ t: '2026-08-06T14:07:00Z' }], [{ t: 'not a date', powerW: 5 }], ZONE);
    expect(answer).toEqual([null]);
  });
});
