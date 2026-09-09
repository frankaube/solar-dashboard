/**
 * What the browser tab says. Money leads, output follows while there is any.
 *
 * Pulled out of the component so it can be tested without mounting the app.
 */

/** Below this the array is idle rather than producing, and the kW is noise. */
const IDLE_KW = 0.05;

/** Below this there is nothing yet worth announcing — a day that has just rolled over. */
const NOTHING_YET = 0.005;

export function tabTitle(powerW: number, todayRevenue: number): string {
  const kw = powerW / 1000;
  const producing = kw >= IDLE_KW;
  // Cents throughout: a figure whose width changes as it passes ten dollars draws the eye.
  const money = `$${todayRevenue.toFixed(2)}`;

  if (todayRevenue < NOTHING_YET) {
    return producing ? `${kw.toFixed(1)} kW · Solar` : 'Solar Dashboard';
  }
  return producing ? `${money} · ${kw.toFixed(1)} kW · Solar` : `${money} · Solar`;
}
