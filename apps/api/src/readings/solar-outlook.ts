/**
 * Turning a forecast into kilowatt-hours this roof will actually make.
 *
 * The weather card used to describe each day with a word derived from the WMO weather
 * code — "poor for solar" for anything with rain in it. That is a statement about
 * precipitation, not insolation, and the two part company often: the same screen showed
 * "poor for solar" beside an internally computed 81 kWh, which would have been a good day
 * against a 110 kWh record. One of them had to go, and the one calibrated against this
 * array's own measured response is the one worth keeping.
 *
 * The factor comes from `wattsPerIrradiance` — watts of AC output per W/m² of irradiance,
 * learned by pairing measured power with measured irradiance. So this is not a generic
 * model of a generic array; it is this roof, including its orientation, its losses, and
 * whatever shading it lives with.
 */

/**
 * Open-Meteo reports daily shortwave radiation as a sum in MJ/m². One megajoule is
 * 1,000,000 joules, one watt-hour is 3,600 joules: 1 MJ/m² = 277.78 Wh/m².
 */
const WH_PER_MJ = 1_000_000 / 3600;

export interface DayOutlook {
  date: string;
  expectedWh: number;
}

/**
 * Expected output for each forecast day.
 *
 * Returns an empty list when the factor is unknown rather than substituting a nameplate
 * guess. A number derived from someone's rated kilowatts would look identical to a learned
 * one on screen and be wrong by whatever the array's real losses are — and this figure's
 * only value is that it is measured.
 */
export function dailyOutlook(
  forecast: Array<{ date: string; radiationSum: number | null }>,
  wattsPerIrradiance: number | null,
): DayOutlook[] {
  if (wattsPerIrradiance === null || wattsPerIrradiance <= 0) return [];
  const out: DayOutlook[] = [];
  for (const day of forecast) {
    if (day.radiationSum === null || day.radiationSum < 0) continue;
    out.push({
      date: day.date,
      expectedWh: Math.round(day.radiationSum * WH_PER_MJ * wattsPerIrradiance),
    });
  }
  return out;
}

/**
 * How a day's expectation reads against what this roof normally does.
 *
 * Compared to the array's own best day rather than to a fixed threshold: "70 kWh" means
 * nothing without knowing whether that is a good day here. Thresholds are deliberately
 * generous — the point is to separate "worth planning around" from "do the laundry
 * tomorrow instead", not to grade the weather.
 */
export function describeOutlook(expectedWh: number, bestDayWh: number | null): string {
  if (!bestDayWh || bestDayWh <= 0) return `~${Math.round(expectedWh / 1000)} kWh expected`;
  const share = expectedWh / bestDayWh;
  const kwh = Math.round(expectedWh / 1000);
  if (share >= 0.85) return `~${kwh} kWh — near your best`;
  if (share >= 0.6) return `~${kwh} kWh — a good day`;
  if (share >= 0.35) return `~${kwh} kWh — moderate`;
  return `~${kwh} kWh — poor`;
}
