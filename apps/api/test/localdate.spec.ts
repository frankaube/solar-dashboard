import { describe, expect, it } from 'vitest';
import { isValidTimeZone, localDateOf, resolveSiteTimeZone } from '../src/common/localdate';

describe('resolveSiteTimeZone', () => {
  it('prefers SITE_TIMEZONE', () => {
    expect(resolveSiteTimeZone({ SITE_TIMEZONE: 'America/Toronto' }, 'UTC')).toEqual({
      timeZone: 'America/Toronto',
      source: 'SITE_TIMEZONE',
    });
  });

  it('accepts TZ, which is how a container is conventionally told', () => {
    expect(resolveSiteTimeZone({ TZ: 'Europe/Stockholm' }, 'UTC').timeZone).toBe(
      'Europe/Stockholm',
    );
  });

  it('lets SITE_TIMEZONE win over TZ', () => {
    // TZ also shifts log timestamps; SITE_TIMEZONE is the one that means "the array".
    const r = resolveSiteTimeZone({ SITE_TIMEZONE: 'America/Halifax', TZ: 'UTC' }, 'UTC');
    expect(r.timeZone).toBe('America/Halifax');
    expect(r.source).toBe('SITE_TIMEZONE');
  });

  /**
   * The case that would have silently corrupted a running install.
   *
   * A container has no timezone unless given one, so Intl resolves to UTC. Adopting
   * that as "the system zone" would have moved this install's day boundaries by three
   * hours and mixed new rows in with months of rows bucketed the old way. An unset
   * zone is missing information, not a claim that the site is in UTC.
   */
  it('does not treat a container UTC as a configured system zone', () => {
    const r = resolveSiteTimeZone({}, 'UTC');
    expect(r.source).toBe('fallback');
    expect(r.timeZone).toBe('UTC');
  });

  it('does use a real system zone when there is one', () => {
    // A bare-metal or Pi install with the clock set properly needs no configuration.
    expect(resolveSiteTimeZone({}, 'America/Vancouver')).toEqual({
      timeZone: 'America/Vancouver',
      source: 'system',
    });
  });

  it('falls back and reports rather than throwing on a typo', () => {
    /*
      An invalid zone poisons every Intl call built on it with a RangeError, so the
      dashboard would answer 500s instead of showing a date that is merely wrong.
    */
    const r = resolveSiteTimeZone({ SITE_TIMEZONE: 'America/Monckton' }, 'America/Vancouver');
    expect(r.timeZone).toBe('UTC');
    expect(r.source).toBe('fallback');
    expect(r.rejected).toBe('America/Monckton');
  });

  it('ignores an empty or whitespace value instead of rejecting it', () => {
    // `SITE_TIMEZONE=` in a .env file is "unset", not "invalid".
    expect(resolveSiteTimeZone({ SITE_TIMEZONE: '   ' }, 'America/Vancouver').source).toBe(
      'system',
    );
  });

  it('survives a system with no resolvable zone at all', () => {
    // null, not undefined: a default parameter only fires for undefined, so passing
    // undefined here would resolve the real machine zone and the test would assert
    // the opposite of what it reads as testing.
    expect(resolveSiteTimeZone({}, null).timeZone).toBe('UTC');
  });
});

describe('isValidTimeZone', () => {
  it('accepts real IANA zones and rejects invented ones', () => {
    expect(isValidTimeZone('Atlantic/Bermuda')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/Monckton')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

/**
 * Why any of this matters: the same instant belongs to different days depending on
 * the zone, and that is the number the whole dashboard buckets by.
 */
describe('localDateOf', () => {
  it('puts a late-evening instant on the correct local day', () => {
    // 01:30Z on the 16th is still the 15th at UTC-4.
    const instant = new Date('2026-07-16T01:30:00Z');
    expect(localDateOf(instant, 'Atlantic/Bermuda')).toBe('2026-07-15');
    expect(localDateOf(instant, 'UTC')).toBe('2026-07-16');
  });

  it('disagrees across zones for the same instant, which is the whole point', () => {
    const instant = new Date('2026-07-16T01:30:00Z');
    expect(localDateOf(instant, 'Australia/Sydney')).toBe('2026-07-16');
    expect(localDateOf(instant, 'America/Vancouver')).toBe('2026-07-15');
  });

  it('emits ISO order, which the stored localDate column relies on', () => {
    expect(localDateOf(new Date('2026-01-05T12:00:00Z'), 'UTC')).toBe('2026-01-05');
  });
});
