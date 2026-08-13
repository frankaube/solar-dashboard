/**
 * Published fuel prices, from Statistics Canada.
 *
 * Table 18-10-0001: monthly average retail prices for gasoline and fuel oil, by geography.
 * Public, unauthenticated, JSON over POST — no key, no account, no terms to accept. The
 * only thing that leaves the house is a request for a price; nothing about this
 * installation goes with it.
 *
 * Chosen over the provincial regulator, which publishes a *weekly* regulated maximum and
 * is therefore the better number. The board that publishes it uses an HTML page with no
 * export of any kind, so using it means scraping a government web page — which breaks
 * silently whenever they touch their markup — and serves exactly one province. This
 * project already spent a release removing assumptions that only held in one province.
 *
 * The cost of that choice is honest and unavoidable: monthly resolution, released about
 * six weeks in arrears. `fuel-prices.ts` is what stops that lag from being invisible.
 */

const WDS = 'https://www150.statcan.gc.ca/t1/wds/rest';
const PRODUCT_ID = 18100001;
/**
 * Regular unleaded at self-service stations.
 *
 * The full-service figure exists in the same table and is consistently higher, which would
 * flatter every comparison this feeds. Self-serve is what almost everyone actually pays.
 */
const FUEL_MEMBER = 2;

/**
 * The geographies the table covers, as its own member ids.
 *
 * Hardcoded rather than fetched: it is a fixed list of census metropolitan areas that has
 * not changed in years, and a settings page that cannot offer its options until a
 * government API answers is a settings page that is broken whenever the internet is.
 *
 * Provinces are abbreviated, and that is not a style choice — please do not "tidy" it by
 * spelling them out. Two entries in this list are Saint John and St. John's, a thousand
 * kilometres apart and one keystroke different, so the province cannot simply be dropped
 * either. The postal codes keep them distinguishable at a glance while leaving the list
 * free of any full province name.
 *
 * `id` is what goes to Statistics Canada; `name` is only ever shown to a person, so the
 * labels can be changed freely without touching what the API is asked for.
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
 * Read the price points out of a WDS response.
 *
 * Separate from the fetch so the shape can be tested without a network, and defensive
 * because this is somebody else's JSON: a point missing its value or carrying a
 * non-numeric one is dropped rather than turned into a zero, which would enter the series
 * as a month when fuel was free.
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
 * Fetch the last `months` monthly averages for one geography.
 *
 * Throws rather than returning an empty series on failure. An empty series and an
 * unreachable one are different answers — the first says fuel has no published price, the
 * second says we could not ask — and the caller keeps whatever it already stored.
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
