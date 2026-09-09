/**
 * Published fuel prices, from Statistics Canada. Table 18-10-0001: monthly average retail
 * prices for gasoline and fuel oil, by geography. Public, unauthenticated, JSON over POST,
 * and the request carries nothing about this installation.
 *
 * The provincial regulator publishes a better number — a *weekly* regulated maximum — but
 * only as scrapeable HTML, and only for one province. The cost here is monthly resolution
 * released about six weeks in arrears; `fuel-prices.ts` stops that lag being invisible.
 */

const WDS = 'https://www150.statcan.gc.ca/t1/wds/rest';
const PRODUCT_ID = 18100001;
/**
 * Regular unleaded at self-service stations. The full-service figure is in the same table
 * and consistently higher, which would flatter every comparison this feeds.
 */
const FUEL_MEMBER = 2;

/**
 * The geographies the table covers, as its own member ids.
 *
 * Hardcoded rather than fetched: a fixed list of census metropolitan areas, and a settings
 * page whose options need a government API to answer is broken whenever the internet is.
 *
 * Province abbreviations are load-bearing, not style: Saint John and St. John's are a
 * thousand kilometres apart and one keystroke different, so the province cannot be dropped
 * and must not be spelled out either.
 *
 * `id` is what goes to Statistics Canada; `name` is only ever shown to a person.
 */
export const FUEL_GEOGRAPHIES: Array<{ id: string; name: string }> = [
  { id: '20', name: 'Canada (national average)' },
  { id: '2', name: "St. John's, NL" },
  { id: '3', name: 'Charlottetown and Summerside, PE' },
  { id: '4', name: 'Halifax, NS' },
  { id: '5', name: 'Saint John, NB' },
  { id: '6', name: 'Québec, QC' },
  { id: '7', name: 'Montréal, QC' },
  { id: '8', name: 'Ottawa-Gatineau, ON/QC' },
  { id: '9', name: 'Toronto, ON' },
  { id: '10', name: 'Thunder Bay, ON' },
  { id: '11', name: 'Winnipeg, MB' },
  { id: '12', name: 'Regina, SK' },
  { id: '13', name: 'Saskatoon, SK' },
  { id: '14', name: 'Edmonton, AB' },
  { id: '15', name: 'Calgary, AB' },
  { id: '16', name: 'Vancouver, BC' },
  { id: '17', name: 'Victoria, BC' },
  { id: '18', name: 'Whitehorse, YT' },
  { id: '19', name: 'Yellowknife, NT' },
];

export const isKnownGeography = (id: string): boolean =>
  FUEL_GEOGRAPHIES.some((geography) => geography.id === id);

/** The table's coordinate string: geography, fuel type, then eight unused dimensions. */
export const coordinateFor = (geographyId: string): string =>
  `${geographyId}.${FUEL_MEMBER}.0.0.0.0.0.0.0.0`;

export interface PublishedPrice {
  month: string;
  centsPerLitre: number;
}

/**
 * Read the price points out of a WDS response. Separate from the fetch so the shape can be
 * tested without a network. A point missing or carrying a non-numeric value is dropped, not
 * zeroed — a zero would enter the series as a month when fuel was free.
 */
export function parsePrices(body: unknown): PublishedPrice[] {
  if (!Array.isArray(body)) return [];
  const out: PublishedPrice[] = [];
  for (const entry of body) {
    const record = entry as { status?: unknown; object?: { vectorDataPoint?: unknown } };
    if (record?.status !== 'SUCCESS') continue;
    const points = record.object?.vectorDataPoint;
    if (!Array.isArray(points)) continue;
    for (const raw of points) {
      const point = raw as { refPer?: unknown; value?: unknown };
      const refPer = typeof point.refPer === 'string' ? point.refPer : null;
      const value = typeof point.value === 'number' ? point.value : Number(point.value);
      if (!refPer || !/^\d{4}-\d{2}/.test(refPer)) continue;
      if (!Number.isFinite(value) || value <= 0) continue;
      out.push({ month: refPer.slice(0, 7), centsPerLitre: value });
    }
  }
  return out;
}

/**
 * Fetch the last `months` monthly averages for one geography. Throws rather than returning
 * an empty series: "no published price" and "could not ask" are different answers, and the
 * caller keeps whatever it already stored.
 */
export async function fetchPrices(
  geographyId: string,
  months: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<PublishedPrice[]> {
  const response = await fetchImpl(`${WDS}/getDataFromCubePidCoordAndLatestNPeriods`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify([
      { productId: PRODUCT_ID, coordinate: coordinateFor(geographyId), latestN: months },
    ]),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Statistics Canada answered ${response.status}`);
  return parsePrices(await response.json());
}
