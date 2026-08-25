/**
 * Specific yield — kWh per kWp of installed capacity, per day. The only production figure
 * comparable with another house, and the one that lets this October be held against last.
 *
 * Refused outright when the array size was estimated rather than configured — the estimate
 * is panel count times an assumed 500 W, so the result would be a measurement divided by a
 * guess; `ratedKwConfigured` tells the two apart. No verdict is attached: whether 4.8 is
 * good depends on latitude, tilt, azimuth and shading, none of which this app knows.
 */

import type { DailyEnergyDto } from './readings.service';

const WH_PER_KWH = 1000;
/** A month of whole days — long enough to average out weather, short enough to be current. */
export const ROLLING_DAYS = 30;

export interface SpecificYieldDto {
  /** Capacity the yield is divided by. Always the owner's configured figure. */
  ratedKw: number;
  /** Today so far. Rises through the day; not comparable with a whole day. */
  todayKwhPerKwp: number | null;
  /** Mean over the last whole days, excluding today. */
  rollingKwhPerKwp: number | null;
  /** How many whole days that mean covers — fewer than asked for early on. */
  rollingDays: number;
  bestDayKwhPerKwp: number | null;
  bestDayDate: string | null;
}

/** kWh per kWp for one day's watt-hours, or null when the divisor is unusable. */
export function specificYield(energyWh: number | null | undefined, ratedKw: number): number | null {
  if (!Number.isFinite(energyWh as number) || (energyWh as number) < 0) return null;
  if (!Number.isFinite(ratedKw) || ratedKw <= 0) return null;
  return (energyWh as number) / WH_PER_KWH / ratedKw;
}

const round2 = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 100) / 100;

/**
 * Today, the recent average, and the best day — all per kWp. `configured` is the caller's
 * `ratedKwConfigured`; false returns null. See the note at the top of this file.
 */
export function summariseYield(
  daily: DailyEnergyDto[],
  ratedKw: number,
  configured: boolean,
  today: string,
): SpecificYieldDto | null {
  if (!configured || !Number.isFinite(ratedKw) || ratedKw <= 0) return null;

  /*
    Today is excluded from the rolling mean and the best-day search: a part-day would drag
    the average down every morning and make "best day" unwinnable until sunset.
  */
  const whole = daily.filter((row) => row.date !== today);
  const recent = whole.slice(-ROLLING_DAYS);
  const rollingTotal = recent.reduce((sum, row) => sum + (row.energyWh ?? 0), 0);

  let best: DailyEnergyDto | null = null;
  for (const row of whole) {
    if (best === null || (row.energyWh ?? 0) > (best.energyWh ?? 0)) best = row;
  }

  return {
    ratedKw,
    todayKwhPerKwp: round2(specificYield(daily.find((r) => r.date === today)?.energyWh, ratedKw)),
    rollingKwhPerKwp: recent.length ? round2(rollingTotal / recent.length / WH_PER_KWH / ratedKw) : null,
    rollingDays: recent.length,
    bestDayKwhPerKwp: best ? round2(specificYield(best.energyWh, ratedKw)) : null,
    bestDayDate: best?.date ?? null,
  };
}
