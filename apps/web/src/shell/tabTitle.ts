/**
 * What the browser tab says.
 *
 * A dashboard like this lives in a background tab, where the title is the only thing
 * visible. Money leads because it is what the glance is for; output follows while there
 * is any.
 *
 * Pulled out of the component so it can be tested without mounting the app, and because
 * the rules below are the kind that get quietly broken by an edit that looks harmless.
 */

/** Below this the array is idle rather than producing, and the kW is noise. */
const IDLE_KW = 0.05;

/** Below this there is nothing yet worth announcing — a day that has just rolled over. */
const NOTHING_YET = 0.005;

export function tabTitle(powerW: number, todayRevenue: number): string {
  const kw = powerW / 1000;
  const producing = kw >= IDLE_KW;
  // Cents throughout. A tab is glanced at, and a figure whose width changes as it passes
  // ten dollars draws the eye for no reason.
  const money = `$${todayRevenue.toFixed(2)}`;

  if (todayRevenue < NOTHING_YET) {
    return producing ? `${kw.toFixed(1)} kW · Solar` : 'Solar Dashboard';
  }
  return producing ? `${money} · ${kw.toFixed(1)} kW · Solar` : `${money} · Solar`;
}
