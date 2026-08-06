import { describe, expect, it } from 'vitest';
import {
  FUEL_GEOGRAPHIES,
  coordinateFor,
  fetchPrices,
  isKnownGeography,
  parsePrices,
} from '../src/charger/statcan';

/*
  Somebody else's JSON. The failures worth guarding are the quiet ones: a point with a
  null value becoming a month when fuel was free, or an error response parsing to an empty
  series that then reads as "no prices exist" rather than "we could not ask".
*/

/** The real response shape, trimmed. */
const ok = (points: Array<[string, number | null]>) => [
  {
    status: 'SUCCESS',
    object: {
      vectorDataPoint: points.map(([refPer, value]) => ({ refPer, value, releaseTime: '2026-07-20' })),
    },
  },
];

describe('parsePrices', () => {
  it('reads the months and values', () => {
    expect(parsePrices(ok([['2026-05-01', 191.1], ['2026-06-01', 172.6]]))).toEqual([
      { month: '2026-05', centsPerLitre: 191.1 },
      { month: '2026-06', centsPerLitre: 172.6 },
    ]);
  });

  it('drops a point with no usable value rather than calling it zero', () => {
    // A zero would enter the series as a month when petrol cost nothing.
    expect(parsePrices(ok([['2026-05-01', null], ['2026-06-01', 0], ['2026-07-01', 170]]))).toEqual([
      { month: '2026-07', centsPerLitre: 170 },
    ]);
  });

  it('ignores a response that did not succeed', () => {
    expect(parsePrices([{ status: 'FAILED', object: 'no such coordinate' }])).toEqual([]);
  });

  it('survives anything that is not the shape we expect', () => {
    for (const junk of [null, undefined, {}, [], '[]', [{ status: 'SUCCESS' }], [{ status: 'SUCCESS', object: {} }]]) {
      expect(parsePrices(junk)).toEqual([]);
    }
  });

  it('refuses a reference period that is not a month', () => {
    expect(parsePrices(ok([['not-a-date', 170]]))).toEqual([]);
  });
});

describe('the geography registry', () => {
  it('covers every province plus a national average', () => {
    expect(FUEL_GEOGRAPHIES.length).toBeGreaterThanOrEqual(19);
    expect(isKnownGeography('20')).toBe(true); // Canada
    expect(isKnownGeography('5')).toBe(true); // a listed city
    expect(isKnownGeography('999')).toBe(false);
  });

  it('builds the table s ten-dimension coordinate', () => {
    // Geography, then regular unleaded self-serve, then eight unused dimensions.
    expect(coordinateFor('5')).toBe('5.2.0.0.0.0.0.0.0.0');
  });
});

describe('fetchPrices', () => {
  it('posts the coordinate and the period count', async () => {
    let seen: { url: string; body: unknown } | null = null;
    await fetchPrices('5', 24, (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return { ok: true, json: async () => ok([['2026-06-01', 172.6]]) };
    }) as unknown as typeof fetch);
    expect(seen!.url).toContain('getDataFromCubePidCoordAndLatestNPeriods');
    expect(seen!.body).toEqual([
      { productId: 18100001, coordinate: '5.2.0.0.0.0.0.0.0.0', latestN: 24 },
    ]);
  });

  it('throws on an HTTP error instead of returning an empty series', async () => {
    /*
      An empty series and an unreachable one are different answers. Collapsing them would
      have the caller replace good stored prices with nothing, the first time Statistics
      Canada had an outage.
    */
    const failing = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(fetchPrices('5', 24, failing)).rejects.toThrow(/503/);
  });
});

describe('the geography labels', () => {
  it('abbreviates the province on every entry that names one', () => {
    /*
      Asserted as a rule rather than as a list of what to avoid, and that is not a style
      preference — the first version of this test enumerated the province names in order to
      search for them, which put a denied string into the tree and made the publish step
      refuse to build. A test guarding a rule must not be written in the vocabulary the
      rule forbids.

      The publish audit greps the tree object it is about to commit, so it catches what a
      grep over the working directory can miss. It is the authority; this is only an early
      warning that fails in a suite rather than in a release.
    */
    for (const { name } of FUEL_GEOGRAPHIES) {
      const parts = name.split(', ');
      if (parts.length === 1) continue; // 'Canada (national average)'
      const suffix = parts[parts.length - 1];
      // Two letters, or two pairs for the region that straddles a boundary.
      expect(suffix, name).toMatch(/^[A-Z]{2}([/][A-Z]{2})?$/);
    }
  });

  it('keeps the two similar cities apart', () => {
    /*
      Why the province is abbreviated rather than dropped. These are a thousand kilometres
      apart, one keystroke different, and adjacent in the menu — without the suffix a
      person picks between them by guesswork.
    */
    const names = FUEL_GEOGRAPHIES.map((g) => g.name);
    expect(names).toContain('Saint John, NB');
    expect(names).toContain("St. John's, NL");
    expect(new Set(names).size).toBe(names.length);
  });
});
