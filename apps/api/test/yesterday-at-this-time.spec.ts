import { describe, expect, it, vi } from 'vitest';
import { ReadingsService } from '../src/readings/readings.service';

/*
  "How much had the roof made by this time yesterday" — the number the hero tile's caption
  cannot give you.

  "85 yesterday" is a whole day, and a part-day held against a whole one says nothing before
  sunset: at nine in the morning every day looks like a disaster. This is the comparison that
  answers it, and the two things worth pinning are both about not inventing it.
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
  The zone is passed rather than inherited. Every expectation below is an Atlantic answer,
  and a suite that took the zone from the machine would be green on this laptop and wrong in
  CI, which runs UTC. That is precisely how `localHourOf` shipped broken.
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
      The rule that keeps the number honest, and it lives in the query rather than in a
      comparison afterwards, so this is where it has to be asserted.

      The gateway's counter is cumulative, so "how much by 11:07" is the newest reading up to
      11:07. The nearest reading could sit two minutes AFTER it and carry energy that had not
      been made yet — a comparison the roof would then appear to be losing.
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
    // An install younger than a day. Not a yesterday that produced nothing.
    const { service } = serviceReturning(null);
    expect(await ask(service)).toBeNull();
  });

  it('refuses a reading stale enough to be describing a different hour', async () => {
    /*
      The failure this guard exists for. The counter survives a gap because it lives on the
      gateway, but the last reading BEFORE a gap does not: if yesterday went quiet from 10:00
      until 15:00, the newest row at or before 11:07 holds the ten-o'clock total, and showing
      it would present a five-hour hole as a bad morning.
    */
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
      Asked ON the spring-forward day, which is the only place the two methods diverge.

      Clocks go forward at 02:00 on 8 March 2026 in this zone, so that calendar day is 23
      hours long. At 11:00 ADT the day before was 11:00 AST, which is 15:00 UTC — while
      subtracting a flat 24 hours lands on 14:00 UTC, an hour earlier by the clock and a
      different sun angle, which is the entire basis of the comparison.

      A case a day later would pass either way, because the transition no longer falls
      between the two instants. This one does not.
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
