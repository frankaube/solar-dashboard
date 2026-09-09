/**
 * The hover line under "Made today": how far along the roof was at this same hour yesterday.
 * The caption beside it is a whole day, which says nothing against a part-day before sunset.
 */

/** kWh to one decimal below ten, whole numbers above, matching the tile it hangs off. */
const kwh = (wh: number): string => (wh / 1000).toFixed(wh < 10_000 ? 1 : 0);

/** Below this the two totals are the same number once rounded, so name it rather than imply a gap. */
const LEVEL_WH = 100;

export function madeTodayHint(
  shownEnergyWh: number,
  yesterdayAtThisTimeWh: number | null,
  /** True after dark, when the tile has flipped to showing yesterday's total. */
  showingYesterday: boolean,
): string | undefined {
  // Two silences. Once the tile shows yesterday's whole day, "by this time yesterday" would
  // describe a different day from the number above it; and a null means the server could not
  // say — an install younger than a day, or a gap across that moment.
  if (showingYesterday || yesterdayAtThisTimeWh === null) return undefined;

  const deltaWh = shownEnergyWh - yesterdayAtThisTimeWh;
  const standing =
    Math.abs(deltaWh) < LEVEL_WH
      ? 'about level'
      : `${kwh(Math.abs(deltaWh))} kWh ${deltaWh > 0 ? 'ahead' : 'behind'}`;
  return `${kwh(yesterdayAtThisTimeWh)} kWh by this time yesterday · ${standing}`;
}
