/**
 * Green Button, the one format that is actually a standard.
 *
 * ESPI, published by NAESB as REQ.21, carried in an Atom feed. Ontario has required every
 * electric and gas utility to implement it since November 2023; elsewhere it is common in
 * the United States and absent in most of the rest of the world. Where it exists it is far
 * better than a spreadsheet, because the meaning of each number is declared in the file
 * rather than guessed from a column heading.
 *
 * The shape, stripped to what matters here:
 *
 *   <entry>
 *     <content><UsagePoint>…</UsagePoint></content>       ← what is being measured
 *     <content><MeterReading>…</MeterReading></content>
 *     <content><IntervalBlock>
 *       <IntervalReading>
 *         <timePeriod><start>epoch seconds</start><duration>…</duration></timePeriod>
 *         <value>…</value>                                 ← in the ReadingType's units
 *       </IntervalReading>
 *     </IntervalBlock></content>
 *   </entry>
 *
 * The direction — consumption or generation — lives in a `ReadingType`, whose `flowDirection`
 * is 1 for forward (drawn from the grid) and 19 for reverse (sent back). A file carrying
 * both has two blocks, each linked to its own ReadingType. Which is exactly the ambiguity
 * a spreadsheet's "Delivered" column leaves unresolved, settled here by the format itself.
 */

export interface GreenButtonDay {
  date: string;
  importedKwh: number;
  exportedKwh: number;
}

/** ESPI flow directions. The rest of the enumeration is irrelevant to a domestic meter. */
const FORWARD = 1;
const REVERSE = 19;
/** ESPI unit of measure: 72 is watt-hours, which is what domestic meters publish. */
const WATT_HOURS = 72;
const WH_PER_KWH = 1000;

const tag = (name: string): RegExp =>
  new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'g');

const first = (xml: string, name: string): string | null => {
  const match = tag(name).exec(xml);
  return match ? match[1].trim() : null;
};

const firstNumber = (xml: string, name: string): number | null => {
  const raw = first(xml, name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

interface ReadingType {
  flowDirection: number | null;
  unit: number | null;
  /** Power of ten the values are scaled by, e.g. -3 for milli. */
  multiplier: number;
}

/**
 * Parse a Green Button (ESPI) feed into daily import and export.
 *
 * Interval readings are usually hourly or quarter-hourly, so they are summed into local
 * days. `localDateOf` is injected for the same reason it is everywhere else in this
 * codebase: a reading at 23:45 belongs to the day the house was living in, not the day UTC
 * happened to be having.
 *
 * Returns an empty array for anything that is not a Green Button feed, so a caller can try
 * this first and fall through to the tabular reader without needing to sniff the file.
 */
export function parseGreenButton(
  xml: string,
  localDateOf: (date: Date) => string,
): { readings: GreenButtonDay[]; problems: string[] } {
  const problems: string[] = [];
  if (!/IntervalReading/.test(xml)) return { readings: [], problems: [] };

  /*
    Reading types, keyed by the id in their self link.

    An IntervalBlock points at its ReadingType by URL, and both live as sibling entries in
    one feed. Matching them by the trailing id is what lets a file that carries consumption
    and generation together be read as two directions rather than one doubled total.
  */
  const readingTypes = new Map<string, ReadingType>();
  const entries = [...xml.matchAll(tag('entry'))].map((match) => match[1]);
  for (const entry of entries) {
    if (!/<(?:\w+:)?ReadingType\b/.test(entry)) continue;
    const id = /ReadingType\/(\d+)/.exec(entry)?.[1] ?? 'default';
    readingTypes.set(id, {
      flowDirection: firstNumber(entry, 'flowDirection'),
      unit: firstNumber(entry, 'uom'),
      multiplier: firstNumber(entry, 'powerOfTenMultiplier') ?? 0,
    });
  }

  const imported = new Map<string, number>();
  const exported = new Map<string, number>();
  let sawBlock = false;

  for (const entry of entries) {
    if (!/<(?:\w+:)?IntervalBlock\b/.test(entry)) continue;
    sawBlock = true;
    const linked = /ReadingType\/(\d+)/.exec(entry)?.[1];
    const type =
      (linked ? readingTypes.get(linked) : undefined) ??
      (readingTypes.size === 1 ? [...readingTypes.values()][0] : undefined);

    if (!type || type.flowDirection === null) {
      /*
        Refused rather than assumed to be consumption. A block whose direction cannot be
        established would, taken as import, turn every exported kilowatt-hour into a
        purchased one — the same figure with the sign of the whole savings calculation
        inverted, and nothing on any page to reveal it.
      */
      problems.push('an interval block declares no flow direction — skipped');
      continue;
    }
    if (type.unit !== null && type.unit !== WATT_HOURS) {
      problems.push(`an interval block reports unit ${type.unit}, which this does not read`);
      continue;
    }
    const scale = 10 ** type.multiplier;
    const bucket =
      type.flowDirection === REVERSE ? exported : type.flowDirection === FORWARD ? imported : null;
    if (!bucket) {
      problems.push(`an interval block declares flow direction ${type.flowDirection} — skipped`);
      continue;
    }

    for (const [, reading] of entry.matchAll(tag('IntervalReading'))) {
      const start = firstNumber(reading, 'start');
      const value = firstNumber(reading, 'value');
      if (start === null || value === null) continue;
      // ESPI timestamps are epoch SECONDS, and reading them as milliseconds lands every
      // reading in January 1970 — where they would silently form one enormous day.
      const date = localDateOf(new Date(start * 1000));
      bucket.set(date, (bucket.get(date) ?? 0) + (value * scale) / WH_PER_KWH);
    }
  }

  if (!sawBlock) return { readings: [], problems: [] };

  const round = (value: number): number => Math.round(value * 1000) / 1000;
  const dates = [...new Set([...imported.keys(), ...exported.keys()])].sort();
  return {
    readings: dates.map((date) => ({
      date,
      importedKwh: round(imported.get(date) ?? 0),
      exportedKwh: round(exported.get(date) ?? 0),
    })),
    problems,
  };
}
