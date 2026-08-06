/**
 * Turning numbers into text an assistant will read out loud.
 *
 * The whole point of rendering here rather than handing over raw JSON is units. A field
 * called `todayEnergyWh` holding 21400 is unambiguous to a program and a coin-flip to a
 * language model, which will cheerfully report "21,400 kWh" and sound completely certain
 * doing it. Every number that leaves this file carries its unit in the same string.
 *
 * The second rule is the one this project keeps relearning: absent is not zero. A missing
 * grid voltage renders as "unknown", never as "0 V". Zero is a measurement — an idle
 * battery really is at 0 W — and the two must never print the same way, because once they
 * do, nothing downstream can tell them apart again.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WH_PER_KWH = 1000;

/** What every formatter returns when the answer is not knowable. */
export const UNKNOWN = 'unknown';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** A number with thousands separators and a fixed number of decimals, or `unknown`. */
export function num(value, decimals = 0) {
  if (!finite(value)) return UNKNOWN;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function watts(value) {
  return finite(value) ? `${num(value)} W` : UNKNOWN;
}

/** Watt-hours in, kilowatt-hours out — the unit every one of these figures is stored in. */
export function kwh(wattHours, decimals = 1) {
  return finite(wattHours) ? `${num(wattHours / WH_PER_KWH, decimals)} kWh` : UNKNOWN;
}

/** Already in kWh. Kept separate from `kwh` so a caller cannot divide by a thousand twice. */
export function kwhDirect(value, decimals = 1) {
  return finite(value) ? `${num(value, decimals)} kWh` : UNKNOWN;
}

export function kw(value, decimals = 1) {
  return finite(value) ? `${num(value, decimals)} kW` : UNKNOWN;
}

/**
 * Money, to the cent.
 *
 * Rounding to whole dollars beside a cents figure was a real defect in the UI once — "$1"
 * next to "$0.81" reads as a different quantity of precision than it is. Always two places.
 */
export function money(value) {
  return finite(value) ? `$${num(value, 2)}` : UNKNOWN;
}

export function pct(value, decimals = 0) {
  return finite(value) ? `${num(value, decimals)}%` : UNKNOWN;
}

export function volts(value) {
  return finite(value) ? `${num(value, 1)} V` : UNKNOWN;
}

export function hertz(value) {
  return finite(value) ? `${num(value, 2)} Hz` : UNKNOWN;
}

/**
 * How long ago, in words. Null timestamp → null, so callers can omit the clause entirely.
 *
 * Deliberately not a wall-clock rendering. This process runs on whatever machine the
 * assistant is on, which need not share a timezone with the array; "13:22" would then be
 * a plausible-looking lie. An elapsed duration is true in every timezone.
 */
export function ago(iso, now = Date.now()) {
  const at = Date.parse(iso ?? '');
  if (!Number.isFinite(at)) return null;
  const delta = now - at;
  if (delta < 0) return 'in the future (clock skew between this machine and the dashboard)';
  if (delta < MINUTE_MS) return `${Math.round(delta / SECOND_MS)} s ago`;
  if (delta < HOUR_MS) return `${Math.round(delta / MINUTE_MS)} min ago`;
  if (delta < DAY_MS) {
    const hours = Math.floor(delta / HOUR_MS);
    const minutes = Math.round((delta % HOUR_MS) / MINUTE_MS);
    return minutes ? `${hours} h ${minutes} min ago` : `${hours} h ago`;
  }
  return `${Math.floor(delta / DAY_MS)} days ago`;
}

/** An instant, as the unambiguous ISO string plus how long ago it was. */
export function instant(iso, now = Date.now()) {
  const relative = ago(iso, now);
  return relative === null ? UNKNOWN : `${iso} (${relative})`;
}

/** Milliseconds between a timestamp and now, or null if there is no usable timestamp. */
export function ageMs(iso, now = Date.now()) {
  const at = Date.parse(iso ?? '');
  return Number.isFinite(at) ? now - at : null;
}

/** Drop empty lines a renderer produced for a section that had nothing to say. */
export function lines(...parts) {
  return parts.flat().filter((line) => line !== null && line !== undefined).join('\n');
}
