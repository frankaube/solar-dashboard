/**
 * Specific yield — kWh per kWp of installed capacity, per day.
 *
 * The only production figure that means anything outside this house. "109 kWh" says
 * nothing without knowing the roof is 23 kW; 4.8 kWh/kWp is a number another owner with a
 * 6 kW array can hold up against their own. It is also the number that makes a bad year
 * legible: output falls every autumn whatever the hardware does, and dividing by capacity
 * does not fix that, but it does let this year's October be compared with last year's.
 *
 * Refused outright when the array size was estimated rather than configured. The estimate
 * is panel count times an assumed 500 W, so a specific yield computed from it is a
 * measurement divided by a guess — and it would print in the same typeface as the real
 * one. `ratedKwConfigured` already exists precisely to tell those apart; this honours it.
 *
 * Deliberately no verdict. Whether 4.8 is good depends on latitude, tilt, azimuth, shading
 * and the weather that particular week, none of which this app knows well enough to grade
 * on. Comparing an array against its own history is honest; comparing it against a
 * remembered industry average is not, and would be the more confident-sounding of the two.
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
 * Today, the recent average, and the best day — all per kWp.
 *
 * `configured` is the caller's `ratedKwConfigured`. False returns null rather than a
 * number derived from an assumed panel wattage: see the note at the top of this file.
 */
export function summariseYield(
  daily: DailyEnergyDto[],
  ratedKw: number,
  configured: boolean,
  today: string,
): SpecificYieldDto | null {
  if (!configured || !Number.isFinite(ratedKw) || ratedKw <= 0) return null;

  /*
    Today is excluded from the rolling mean and from the best-day search. A day still in
    progress is not a day, and letting one into either would drag the average down every
    morning and make "best day" unwinnable until sunset.
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
