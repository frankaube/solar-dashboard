import { describe, expect, it } from 'vitest';
import { readSky, solarOutlook } from '../src/components/weatherCodes';

/**
 * WMO weather codes are not contiguous — 66/67 are freezing rain, 77 is snow grains,
 * 85/86 are snow showers — so a lookup table is easy to get subtly wrong in a way
 * nobody notices until it snows.
 */
describe('readSky', () => {
  it('maps the common daytime codes', () => {
    expect(readSky(0)).toMatchObject({ kind: 'clear', label: 'clear sky' });
    expect(readSky(2)).toMatchObject({ kind: 'partly' });
    expect(readSky(3)).toMatchObject({ kind: 'cloudy', label: 'overcast' });
  });

  it('groups every precipitation family correctly', () => {
    // The awkward ones: 66/67 are freezing rain and belong with rain; 77 is snow
    // grains and 85/86 snow showers, all of which belong with snow.
    for (const code of [51, 53, 55, 56, 57]) expect(readSky(code).kind).toBe('drizzle');
    for (const code of [61, 63, 65, 66, 67, 80, 81, 82]) expect(readSky(code).kind).toBe('rain');
    for (const code of [71, 73, 75, 77, 85, 86]) expect(readSky(code).kind).toBe('snow');
    for (const code of [95, 96, 99]) expect(readSky(code).kind).toBe('storm');
  });

  it('says nothing rather than guessing when there is no code', () => {
    // A missing forecast is not a cloudy day. The label is an em dash so the card
    // shows an absence rather than a confident condition.
    expect(readSky(undefined).label).toBe('—');
    expect(readSky(null).label).toBe('—');
  });

  it('is honest about a code it does not recognise', () => {
    // WMO adds codes; "unsettled" claims less than naming a specific condition would.
    expect(readSky(4)).toMatchObject({ label: 'unsettled' });
    expect(readSky(999).label).toBe('unsettled');
  });

  it('never leaves the label empty', () => {
    // The card renders this directly, so a blank would be an invisible failure.
    for (const code of [0, 1, 2, 3, 45, 48, 51, 61, 71, 80, 95, 4, -1, 12345]) {
      expect(readSky(code).label.length).toBeGreaterThan(0);
    }
  });
});

describe('solarOutlook', () => {
  it('ranks the sky by how much sun it implies', () => {
    expect(solarOutlook('clear')).toBe('strong sun');
    expect(solarOutlook('partly')).toBe('some sun');
    expect(solarOutlook('cloudy')).toBe('little sun');
  });

  it('treats fog as a poor solar day, not a clear one', () => {
    // Fog reads as bright to a person and is dreadful for a panel; grouping it with
    // "clear" would make the expected-vs-actual comparison look like underperformance.
    expect(solarOutlook('fog')).toBe('little sun');
  });

  it('has an answer for every sky it can produce', () => {
    for (const kind of ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'storm'] as const) {
      expect(solarOutlook(kind).length).toBeGreaterThan(0);
    }
  });
});
