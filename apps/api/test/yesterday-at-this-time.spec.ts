import { describe, expect, it, vi } from 'vitest';
import { ReadingsService } from '../src/readings/readings.service';

/*
  "How much had the roof made by this time yesterday". A part-day held against a whole day
  says nothing before sunset, so the comparison has to be against yesterday at the same wall
  clock.
*/

const ZONE = 'America/Halifax';

/** A service with nothing wired but the one table this reads. */
function serviceReturning(row: { takenAt: Date; dailyEnergy: number } | null): {
  service: ReadingsService;
  findFirst: ReturnType<typeof vi.fn>;
} {
  const findFirst = vi.fn().mockResolvedValue(row);
  const prisma = { dtuReading: { findFirst } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ReadingsService(prisma as any, {} as any);
  return { service, findFirst };
}

/** 11:07 ADT on 6 August. */
const NOW = new Date('2026-08-06T14:07:00Z');

/*
  The zone is passed, never inherited. Every expectation below is an Atlantic answer, and a
  suite that read the host clock would pass on a laptop and fail in CI, which runs UTC.
*/
const ask = (
  service: ReadingsService,
  now: Date = NOW,
): Promise<number | null> => service['yesterdayEnergyAtThisTimeWh'](now, ZONE);

describe('yesterdayEnergyAtThisTimeWh', () => {
  it('answers with the counter as it stood at that moment yesterday', async () => {
    const { service } = serviceReturning({
      takenAt: new Date('2026-08-05T14:05:00Z'),
      dailyEnergy: 12_400,
    });
    expect(await ask(service)).toBe(12_400);
  });

  it('asks for the last reading AT OR BEFORE that moment, not the nearest one', async () => {
    /*
      The counter is cumulative, so "how much by 11:07" is the newest reading up to 11:07. The
      nearest reading could sit two minutes after it and carry energy not yet made. The rule
      lives in the query, so it must be asserted on the query arguments.
    */
    const { service, findFirst } = serviceReturning({
      takenAt: new Date('2026-08-05T14:05:00Z'),
      dailyEnergy: 12_400,
    });
    await ask(service);

    const args = findFirst.mock.calls[0][0];
    expect(args.where.takenAt).toEqual({ lte: new Date('2026-08-05T14:07:00Z') });
    expect(args.orderBy).toEqual({ takenAt: 'desc' });
    // Bounded to yesterday's own local day, so a gap cannot reach back a further day and
    // answer with a different day's total.
    expect(args.where.localDate).toBe('2026-08-05');
  });

  it('says nothing when yesterday has no reading at all', async () => {
    // An install younger than a day, not a yesterday that produced nothing.
    const { service } = serviceReturning(null);
    expect(await ask(service)).toBeNull();
  });

  it('refuses a reading stale enough to be describing a different hour', async () => {
    // If yesterday went quiet from 10:00 to 15:00, the newest row at or before 11:07 holds
    // the ten-o'clock total, and a five-hour hole would read as a bad morning.
    const { service } = serviceReturning({
      takenAt: new Date('2026-08-05T13:00:00Z'), // 67 minutes before the target
      dailyEnergy: 4_000,
    });
    expect(await ask(service)).toBeNull();
  });

  it('tolerates the ordinary case of a poll or two being missed', async () => {
    // Samples arrive every five minutes; a reading 20 minutes old still describes this hour.
    const { service } = serviceReturning({
      takenAt: new Date('2026-08-05T13:47:00Z'),
      dailyEnergy: 11_900,
    });
    expect(await ask(service)).toBe(11_900);
  });

  it('matches on the wall clock across a daylight-saving boundary', async () => {
    /*
      Asked ON the spring-forward day, the only place the two methods diverge — a day later
      the transition no longer falls between the two instants and either would pass.

      Clocks go forward at 02:00 on 8 March 2026 here, so that day is 23 hours long: 11:00 ADT
      maps to 11:00 AST = 15:00 UTC, while a flat 24-hour subtraction lands on 14:00 UTC.
    */
    const { service, findFirst } = serviceReturning({
      takenAt: new Date('2026-03-07T14:58:00Z'),
      dailyEnergy: 3_100,
    });
    // 11:00 ADT on 8 March, the morning the clocks moved.
    await ask(service, new Date('2026-03-08T14:00:00Z'));
    const args = findFirst.mock.calls[0][0];
    expect(args.where.localDate).toBe('2026-03-07');
    expect(args.where.takenAt.lte).toEqual(new Date('2026-03-07T15:00:00Z'));
    // What a flat 24-hour subtraction would have asked for, and did not.
    expect(args.where.takenAt.lte).not.toEqual(new Date('2026-03-07T14:00:00Z'));
  });
});
