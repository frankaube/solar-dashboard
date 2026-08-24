import { describe, expect, it } from 'vitest';
import {
  FREQUENCIES,
  describeSchedule,
  findFrequency,
  isDue,
  normaliseHour,
} from '../src/backup/schedule';

/*
  A zone at UTC-4 that goes to UTC-3 in summer, chosen for the offset rather than the
  place: large enough that any accidental UTC arithmetic shows up as a wrong day rather
  than passing by luck, and it observes DST so the transition cases below are real.
*/
const TZ = 'Atlantic/Bermuda';

/** Local wall-clock in TZ, written as the UTC instant it corresponds to (ADT = UTC-3). */
const at = (iso: string): Date => new Date(`${iso}-03:00`);

const due = (
  now: string,
  lastSuccess: string | null,
  frequency: string,
  hour = 3,
): boolean =>
  isDue({
    now: at(now),
    lastSuccess: lastSuccess ? at(lastSuccess) : null,
    frequency,
    hour,
    timeZone: TZ,
  });

describe('the frequency registry', () => {
  it('keeps the ids the old off/daily/weekly setting stored', () => {
    /*
      These strings are already in the database of a running install. Renaming one would
      leave that install with a frequency the registry does not know, which resolves to
      "never" — a backup that stops the day it is upgraded.
    */
    const ids = FREQUENCIES.map((f) => f.id);
    expect(ids).toContain('off');
    expect(ids).toContain('daily');
    expect(ids).toContain('weekly');
  });

  it('anchors nothing shorter than a day', () => {
    // A preferred hour is meaningless for an interval that comes round several times
    // within one, and offering it would only be a way to configure a contradiction.
    for (const frequency of FREQUENCIES) {
      expect(frequency.anchored, frequency.id).toBe(frequency.ms >= 86_400_000);
    }
  });

  it('rejects an id it does not know', () => {
    expect(findFrequency('hourly')).toBeUndefined();
    expect(findFrequency(null)).toBeUndefined();
  });
});

describe('normaliseHour', () => {
  it('accepts every real hour including midnight', () => {
    expect(normaliseHour(0)).toBe(0);
    expect(normaliseHour(23)).toBe(23);
  });

  it('falls back rather than storing an hour that never arrives', () => {
    // A stored 24 would mean the slot never matched and the backup silently never ran.
    for (const bad of [24, -1, 99, 'x', null, undefined, NaN]) {
      expect(normaliseHour(bad), String(bad)).toBe(3);
    }
  });
});

describe('when a backup is due', () => {
  it('never runs when the schedule is off', () => {
    expect(due('2026-07-29T03:00', '2026-01-01T03:00', 'off')).toBe(false);
  });

  it('never runs on a frequency the registry does not know', () => {
    // Safer than defaulting to daily: an unrecognised value means something is wrong,
    // and quietly inventing a schedule would hide it.
    expect(due('2026-07-29T03:00', null, 'hourly')).toBe(false);
  });

  it('runs immediately when nothing has ever been backed up', () => {
    // Waiting for the first 03:00 would leave a brand-new install unprotected all day.
    expect(due('2026-07-29T14:22', null, 'daily')).toBe(true);
  });

  describe('sub-daily intervals measure elapsed time only', () => {
    it('waits for the full interval', () => {
      expect(due('2026-07-29T15:59', '2026-07-29T10:00', '6h')).toBe(false);
      expect(due('2026-07-29T16:00', '2026-07-29T10:00', '6h')).toBe(true);
    });

    it('ignores the preferred hour', () => {
      expect(due('2026-07-29T22:00', '2026-07-29T10:00', '12h', 3)).toBe(true);
    });
  });

  describe('daily anchors to the chosen hour', () => {
    it('runs at the slot even though a full 24 h has not elapsed', () => {
      /*
        Yesterday's run landed at 03:07, because the checks are every 15 minutes and not
        aligned to the hour. Requiring a full interval would push today's to tomorrow,
        and from then on it would run every other day.
      */
      expect(due('2026-07-29T03:00', '2026-07-28T03:07', 'daily')).toBe(true);
    });

    it('does not run twice in one slot', () => {
      expect(due('2026-07-29T03:15', '2026-07-29T03:00', 'daily')).toBe(false);
      expect(due('2026-07-29T23:59', '2026-07-29T03:00', 'daily')).toBe(false);
    });

    it('waits for the hour rather than firing at midnight', () => {
      // 22 h have elapsed and the calendar day has turned, but 03:00 has not arrived.
      expect(due('2026-07-29T01:00', '2026-07-28T03:00', 'daily')).toBe(false);
      expect(due('2026-07-29T03:00', '2026-07-28T03:00', 'daily')).toBe(true);
    });

    it('will not fire early just because the day changed', () => {
      /*
        Saved at 14:30, so the first run happens then. Today's 03:00 is only 12.5 h later
        — the slot has passed but the interval has not, and running would halve it.
      */
      expect(due('2026-07-29T03:00', '2026-07-28T14:30', 'daily')).toBe(false);
      expect(due('2026-07-30T03:00', '2026-07-28T14:30', 'daily')).toBe(true);
    });

    it('honours midnight as an hour', () => {
      expect(due('2026-07-29T00:00', '2026-07-28T00:05', 'daily', 0)).toBe(true);
      expect(due('2026-07-28T23:00', '2026-07-28T00:05', 'daily', 0)).toBe(false);
    });
  });

  describe('weekly and monthly hold their interval', () => {
    it('does not fire on day four', () => {
      /*
        The slot condition is satisfied every single day — only the elapsed check holds
        the week. A grace proportional to the interval would have turned "weekly" into
        "every three and a half days" here.
      */
      expect(due('2026-07-29T03:00', '2026-07-25T03:00', 'weekly')).toBe(false);
      expect(due('2026-07-29T03:00', '2026-07-22T03:07', 'weekly')).toBe(true);
    });

    it('holds a month the same way', () => {
      expect(due('2026-07-29T03:00', '2026-07-10T03:00', 'monthly')).toBe(false);
      expect(due('2026-07-29T03:00', '2026-06-29T03:05', 'monthly')).toBe(true);
    });
  });

  describe('across a daylight-saving change', () => {
    /*
      Clocks go forward on 8 March 2026 at 02:00, so that local day is 23 h
      long. Comparing local (day, hour) pairs rather than converting a wall-clock time
      into an instant is what makes this uneventful — the day is simply shorter.
    */
    it('still runs once on the short day', () => {
      const springForward = (iso: string, offset: string): Date => new Date(`${iso}${offset}`);
      const ran = springForward('2026-03-07T03:05', '-04:00'); // AST, before the change
      const check = springForward('2026-03-08T03:00', '-03:00'); // ADT, after it
      expect(
        isDue({ now: check, lastSuccess: ran, frequency: 'daily', hour: 3, timeZone: TZ }),
      ).toBe(true);
      // And not again later the same local day.
      const later = springForward('2026-03-08T20:00', '-03:00');
      expect(
        isDue({
          now: later,
          lastSuccess: springForward('2026-03-08T03:00', '-03:00'),
          frequency: 'daily',
          hour: 3,
          timeZone: TZ,
        }),
      ).toBe(false);
    });
  });
});

describe('describeSchedule', () => {
  it('names the hour for anchored frequencies', () => {
    expect(describeSchedule('daily', 3)).toBe('Daily at 03:00');
    expect(describeSchedule('weekly', 22)).toBe('Weekly at 22:00');
  });

  it('leaves the hour out where it does not apply', () => {
    expect(describeSchedule('6h', 3)).toBe('Every 6 hours');
  });

  it('says plainly when nothing is scheduled', () => {
    expect(describeSchedule('off', 3)).toBe('Only when you ask');
  });
});

describe('an ad-hoc backup must not move the nightly anchor', () => {
  /*
    Observed on a real Pi: deploy-pi.sh takes a backup before every deploy, so a deploy at
    08:16 left only 18.7 h elapsed when 03:00 came round. The night was skipped, and the
    status panel went on reporting daily backups — which were happening, just not on the
    schedule. Deploy most days and the 03:00 slot never fires at all.
  */
  const daily = { frequency: 'daily', hour: 3, timeZone: TZ };

  it('skips the slot when only lastSuccess is known — the old behaviour, for reference', () => {
    expect(
      isDue({
        now: at('2026-07-31T03:05'),
        lastSuccess: at('2026-07-30T08:16'),
        ...daily,
      }),
    ).toBe(false);
  });

  it('fires on the slot when the anchor is a day old, whatever ad-hoc runs happened since', () => {
    expect(
      isDue({
        now: at('2026-07-31T03:05'),
        // A deploy backed up eight hours ago…
        lastSuccess: at('2026-07-30T19:00'),
        // …but the schedule last ran at its slot yesterday, which is what counts.
        lastScheduled: at('2026-07-30T03:02'),
        ...daily,
      }),
    ).toBe(true);
  });

  it('still will not fire twice against the same anchor', () => {
    expect(
      isDue({
        now: at('2026-07-30T03:40'),
        lastSuccess: at('2026-07-30T03:02'),
        lastScheduled: at('2026-07-30T03:02'),
        ...daily,
      }),
    ).toBe(false);
  });

  it('holds a weekly interval even when ad-hoc backups happen daily', () => {
    // The bug the first attempt at this introduced: with no anchor it fired on the slot
    // alone, turning weekly into daily.
    expect(
      isDue({
        now: at('2026-07-31T03:05'),
        lastSuccess: at('2026-07-30T19:00'),
        lastScheduled: at('2026-07-28T03:02'),
        frequency: 'weekly',
        hour: 3,
        timeZone: TZ,
      }),
    ).toBe(false);
  });

  it('survives the spring-forward night', () => {
    /*
      Clocks go forward on 8 March 2026, so that local day is 23 hours. Anchored to 03:02
      on the 8th, the 03:00 slot on the 9th is only 23 h later — inside the two-hour grace,
      so it must still fire. Without the grace an anchored schedule loses a day every
      spring and nobody notices until the backups are a day out.
    */
    expect(
      isDue({
        now: at('2026-03-09T03:05'),
        lastSuccess: at('2026-03-08T03:02'),
        lastScheduled: at('2026-03-08T03:02'),
        ...daily,
      }),
    ).toBe(true);
  });

  it('and the autumn 25-hour day', () => {
    expect(
      isDue({
        now: at('2026-11-02T03:05'),
        lastSuccess: at('2026-11-01T03:02'),
        lastScheduled: at('2026-11-01T03:02'),
        ...daily,
      }),
    ).toBe(true);
  });
});
