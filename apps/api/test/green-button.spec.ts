import { describe, expect, it } from 'vitest';
import { parseGreenButton } from '../src/readings/green-button';
import { evaluateUtilityStaleness } from '../src/alerts/utility-staleness';

/*
  Green Button is the one format where direction is declared rather than inferred. These
  pin that the declaration is actually honoured — and that a block which fails to make one
  is refused, since read as consumption it turns every exported kilowatt-hour into a
  purchased one and inverts the sign of the whole savings calculation.
*/

const localDateOf = (date: Date): string => date.toISOString().slice(0, 10);

/** Epoch seconds for an instant — ESPI's own unit. */
const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const feed = (entries: string[]): string =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`;

const readingType = (id: number, flowDirection: number, extra = ''): string => `
  <entry><link rel="self" href="/espi/ReadingType/${id}"/><content>
    <ReadingType><flowDirection>${flowDirection}</flowDirection><uom>72</uom>${extra}</ReadingType>
  </content></entry>`;

const block = (readingTypeId: number, readings: Array<[string, number]>): string => `
  <entry><link rel="related" href="/espi/ReadingType/${readingTypeId}"/><content>
    <IntervalBlock>${readings
      .map(
        ([iso, value]) =>
          `<IntervalReading><timePeriod><duration>3600</duration><start>${at(iso)}</start></timePeriod><value>${value}</value></IntervalReading>`,
      )
      .join('')}</IntervalBlock>
  </content></entry>`;

describe('parseGreenButton', () => {
  it('reads forward and reverse as import and export', () => {
    const xml = feed([
      readingType(1, 1),
      readingType(2, 19),
      block(1, [['2026-07-27T10:00:00Z', 30_000], ['2026-07-27T11:00:00Z', 33_000]]),
      block(2, [['2026-07-27T12:00:00Z', 83_000]]),
    ]);
    const { readings, problems } = parseGreenButton(xml, localDateOf);
    expect(readings).toEqual([{ date: '2026-07-27', importedKwh: 63, exportedKwh: 83 }]);
    expect(problems).toEqual([]);
  });

  it('sums interval readings into local days', () => {
    // Quarter-hourly and hourly feeds both collapse to the day the house was living in.
    const xml = feed([
      readingType(1, 1),
      block(1, [
        ['2026-07-27T10:00:00Z', 1000],
        ['2026-07-27T10:15:00Z', 1000],
        ['2026-07-28T10:00:00Z', 5000],
      ]),
    ]);
    const { readings } = parseGreenButton(xml, localDateOf);
    expect(readings).toEqual([
      { date: '2026-07-27', importedKwh: 2, exportedKwh: 0 },
      { date: '2026-07-28', importedKwh: 5, exportedKwh: 0 },
    ]);
  });

  it('reads timestamps as epoch seconds', () => {
    /*
      ESPI counts seconds. Read as milliseconds every reading lands in January 1970, where
      they would silently pile into one enormous day rather than failing.
    */
    const { readings } = parseGreenButton(
      feed([readingType(1, 1), block(1, [['2026-07-27T10:00:00Z', 1000]])]),
      localDateOf,
    );
    expect(readings[0].date).toBe('2026-07-27');
  });

  it('honours the power-of-ten multiplier', () => {
    // A meter publishing in milliwatt-hours is off by a factor of a thousand otherwise.
    const xml = feed([
      readingType(1, 1, '<powerOfTenMultiplier>3</powerOfTenMultiplier>'),
      block(1, [['2026-07-27T10:00:00Z', 63]]),
    ]);
    expect(parseGreenButton(xml, localDateOf).readings[0].importedKwh).toBe(63);
  });

  it('refuses a block that declares no direction', () => {
    /*
      Taken as import it would turn every exported kilowatt-hour into a purchased one —
      the same magnitudes with the sign of the savings calculation inverted, and nothing
      on any page to reveal it.
    */
    const xml = feed([block(9, [['2026-07-27T10:00:00Z', 1000]])]);
    const { readings, problems } = parseGreenButton(xml, localDateOf);
    expect(readings).toEqual([]);
    expect(problems[0]).toContain('no flow direction');
  });

  it('refuses a unit it does not read', () => {
    const xml = feed([
      '<entry><link rel="self" href="/espi/ReadingType/1"/><content><ReadingType><flowDirection>1</flowDirection><uom>38</uom></ReadingType></content></entry>',
      block(1, [['2026-07-27T10:00:00Z', 1000]]),
    ]);
    const { readings, problems } = parseGreenButton(xml, localDateOf);
    expect(readings).toEqual([]);
    expect(problems[0]).toContain('unit 38');
  });

  it('says nothing at all about a file that is not Green Button', () => {
    // So a caller can try this first and fall through without sniffing the file itself.
    for (const junk of ['', 'Date,Usage\n2026-07-27,63', '<html><body>Sign in</body></html>']) {
      expect(parseGreenButton(junk, localDateOf)).toEqual({ readings: [], problems: [] });
    }
  });
});

describe('evaluateUtilityStaleness', () => {
  const now = new Date('2026-09-15T12:00:00Z');

  it('asks once a billing period has plausibly been published', () => {
    const alerts = evaluateUtilityStaleness({ newestDate: '2026-08-02' }, now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('utility_data_stale');
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].message).toContain('2026-08-02');
    expect(alerts[0].message).toContain('falls back to the share estimated');
  });

  it('stays quiet inside the window', () => {
    /*
      Not thirty days. A period is about a month and its export appears days-to-weeks after
      it closes, so a thirty-day timer fires while the file does not exist yet — and a
      reminder that is usually wrong is ignored on the occasion it is right.
    */
    expect(evaluateUtilityStaleness({ newestDate: '2026-08-20' }, now)).toEqual([]);
  });

  it('says nothing to an install that has never imported anything', () => {
    // Not a lapsed habit — a feature the owner has not chosen. Nagging about one is how a
    // notifier gets muted for everything else too.
    expect(evaluateUtilityStaleness({ newestDate: null }, now)).toEqual([]);
  });

  it('ignores a date it cannot read rather than counting from the epoch', () => {
    expect(evaluateUtilityStaleness({ newestDate: 'last month' }, now)).toEqual([]);
  });
});
