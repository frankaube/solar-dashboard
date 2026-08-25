/**
 * Turning a forecast into kilowatt-hours this roof will actually make.
 *
 * Driven by irradiance, not the WMO weather code, which describes precipitation rather than
 * insolation. The factor is `wattsPerIrradiance` — watts of AC per W/m², learned by pairing
 * measured power with measured irradiance — so it carries this roof's orientation, losses
 * and shading rather than modelling a generic array.
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
 * Expected output for each forecast day. Empty when the factor is unknown, rather than
 * substituting a nameplate guess that would be wrong by the array's real losses.
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
 * How a day's expectation reads against what this roof normally does. Compared to the
 * array's own best day rather than a fixed threshold, and graded loosely.
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
