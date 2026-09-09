import { describe, expect, it } from 'vitest';
import { DailySummaryService } from '../src/alerts/daily-summary.service';

/*
  When the day is over. The rule under test is only "is the sun down" — output alone cannot
  decide it, since anything that stops the array mid-afternoon looks the same. Whether there
  is anything worth sending is decided elsewhere.
*/

const ZONE = 'America/Halifax';

/** A service with nothing wired but the forecast the sunset comes from. */
function withForecast(forecast: Array<{ date: string; sunset: string | null }>): DailySummaryService {
  const weather = { getWeather: () => ({ current: null, hourly: null, daily: null, forecast }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new DailySummaryService({} as any, {} as any, {} as any, {} as any, {} as any, weather as any);
}

/*
  The zone is passed, never inherited. The fallback reads a clock, so a suite that let it
  read the machine's would pass on a laptop and fail in CI, which runs UTC.
*/
const dayIsOver = (service: DailySummaryService, now: Date): boolean =>
  service['dayIsOver'](now, ZONE);

/** 14 August 2026, sunset 20:11 local (23:11Z at UTC-3). */
const TODAY = '2026-08-14';
const SUNSET_LOCAL = '2026-08-14T20:11:00-03:00';

describe('dayIsOver', () => {
  it('says no in the middle of the afternoon, whatever the array is doing', () => {
    const service = withForecast([{ date: TODAY, sunset: SUNSET_LOCAL }]);
    expect(dayIsOver(service, new Date('2026-08-14T18:00:00Z'))).toBe(false); // 15:00 local
  });

  it('says yes once the sun has actually set', () => {
    const service = withForecast([{ date: TODAY, sunset: SUNSET_LOCAL }]);
    expect(dayIsOver(service, new Date('2026-08-14T23:20:00Z'))).toBe(true); // 20:20 local
  });

  it('is still no a minute before sunset', () => {
    const service = withForecast([{ date: TODAY, sunset: SUNSET_LOCAL }]);
    expect(dayIsOver(service, new Date('2026-08-14T23:10:00Z'))).toBe(false);
  });

  it('uses today’s sunset rather than whichever day the forecast happens to start with', () => {
    // The forecast is several days long and day 0 is not always today after a restart.
    const service = withForecast([
      { date: '2026-08-13', sunset: '2026-08-13T20:13:00-03:00' },
      { date: TODAY, sunset: SUNSET_LOCAL },
      { date: '2026-08-15', sunset: '2026-08-15T20:09:00-03:00' },
    ]);
    expect(dayIsOver(service, new Date('2026-08-14T22:00:00Z'))).toBe(false); // 19:00 local
  });

  it('falls back to a late hour when there is no forecast to ask', () => {
    // An install with no site location has no sunset. The fallback only has to never be
    // mid-afternoon; late is harmless.
    const service = withForecast([]);
    expect(dayIsOver(service, new Date('2026-08-14T18:00:00Z'))).toBe(false);
  });

  it('falls back rather than trusting a sunset it cannot parse', () => {
    const service = withForecast([{ date: TODAY, sunset: 'not a time' }]);
    expect(dayIsOver(service, new Date('2026-08-14T18:00:00Z'))).toBe(false);
  });

  it('falls back when the forecast has today but no sunset for it', () => {
    const service = withForecast([{ date: TODAY, sunset: null }]);
    expect(dayIsOver(service, new Date('2026-08-14T18:00:00Z'))).toBe(false);
  });
});


describe('the fallback hour', () => {
  it('is the site’s evening, not the host machine’s', () => {
    // A container has no timezone unless given one, so on a UTC host 23:00 machine-local is
    // 20:00 Atlantic — still daylight in June.
    const service = withForecast([]);
    // 23:30 UTC is 20:30 in Halifax: the site's evening, but not yet its 23:00.
    expect(dayIsOver(service, new Date('2026-08-14T23:30:00Z'))).toBe(false);
    // 02:30 UTC the next day is 23:30 in Halifax.
    expect(dayIsOver(service, new Date('2026-08-15T02:30:00Z'))).toBe(true);
  });
});
