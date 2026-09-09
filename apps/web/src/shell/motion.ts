import { useEffect, useRef, useState } from 'react';

/**
 * Whether this browser wants motion at all. Everything animated in the app goes through
 * here.
 *
 * Subscribed rather than read once at mount, so turning the OS setting on mid-session
 * takes effect without a reload.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof matchMedia !== 'function') return false;
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

/**
 * True for a moment after `value` changes to something new — the "what just moved"
 * highlight on a dashboard left open.
 *
 * Deliberately not true on first render: everything is new on load, so the signal would
 * be meaningless.
 */
export function useChanged(value: unknown, holdMs = 1400): boolean {
  const previous = useRef<unknown>(undefined);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    const first = previous.current === undefined;
    const moved = !first && !Object.is(previous.current, value);
    previous.current = value;
    if (!moved) return;
    setChanged(true);
    const timer = setTimeout(() => setChanged(false), holdMs);
    return () => clearTimeout(timer);
  }, [value, holdMs]);

  return changed;
}

/**
 * Split a formatted figure into what surrounds the number and the number itself.
 *
 * `Metric` is handed an already-formatted string ("$1,284", "10.7"), so tweening means
 * finding the number inside it and putting it back the way it was found. Anything without
 * exactly one numeric run is left alone.
 */
function parseFigure(text: string): { before: string; value: number; after: string; decimals: number; grouped: boolean } | null {
  const match = /^(\D*?)([\d,]+(?:\.\d+)?)(\D*)$/.exec(text);
  if (!match) return null;
  const [, before, digits, after] = match;
  const value = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const dot = digits.indexOf('.');
  return {
    before,
    value,
    after,
    decimals: dot < 0 ? 0 : digits.length - dot - 1,
    grouped: digits.includes(','),
  };
}

const format = (value: number, decimals: number, grouped: boolean): string =>
  grouped
    ? value.toLocaleString('en-CA', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : value.toFixed(decimals);

/** How long a figure takes to travel. */
const COUNT_MS = 420;

/**
 * A figure that travels to its new value instead of cutting.
 *
 * The intermediate values were never measured — this is a transition between two known
 * numbers. It stays short, and reuses the decimals and grouping of the string it was given
 * rather than rendering more digits than the source had.
 */
export function useCountUp(display: string, enabled = true): string {
  const [shown, setShown] = useState(display);
  const from = useRef(display);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const target = parseFigure(display);
    const start = parseFigure(from.current);
    from.current = display;

    // Not two comparable numbers — a label changed, or the shape did. Cut, do not invent.
    if (!enabled || !target || !start || start.value === target.value) {
      setShown(display);
      return;
    }

    const began = performance.now();
    const step = (nowMs: number): void => {
      const t = Math.min(1, (nowMs - began) / COUNT_MS);
      // Ease out: fast away from the old value, settling into the new one.
      const eased = 1 - (1 - t) ** 3;
      const at = start.value + (target.value - start.value) * eased;
      setShown(`${target.before}${format(at, target.decimals, target.grouped)}${target.after}`);
      if (t < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [display, enabled]);

  return shown;
}

/** Digits past the dollar. Cents alone move only once every half minute or so. */
const LIVE_DECIMALS = 4;

/** How often the figure is repainted; ten a second reads as continuous. */
const PAINT_MS = 100;

/** How long the figure takes to come to rest on the measured total when production stops. */
const SETTLE_MS = 900;

export interface LiveMoneyInput {
  /** Dollars the app has actually measured, as of the last poll. */
  settled: number;
  /** Watts at that same poll. Zero stops the counter dead, which is the night case. */
  powerW: number;
  pricePerKwh: number;
  /** False under reduced motion, or wherever a still figure is wanted. */
  enabled: boolean;
  /**
   * Which day `settled` describes.
   *
   * The no-decrease floor is right inside one day and wrong across two — without this it
   * carries yesterday's dollars into today. Any stable identifier will do; it is only ever
   * compared with the previous one.
   */
  dayKey: string;
}

/**
 * Money accruing between polls, as a figure that ticks.
 *
 * Polls are five minutes apart, so the gap is filled by projecting the last measured power
 * forward. Nothing between polls is measured.
 *
 * It never renders a decrease: when output drops the projection has already run ahead (six
 * or seven cents on this array), so the figure holds while the measurement catches up.
 * It stops dead at zero output — after sunset there is nothing to project.
 */
export function useLiveMoney({ settled, powerW, pricePerKwh, enabled, dayKey }: LiveMoneyInput): string {
  const [shown, setShown] = useState(settled);
  // Refs, not state: the floor must survive the re-render a poll causes, or the clamp that
  // stops the counter reversing is reset by the very update it exists to absorb.
  const floor = useRef(settled);
  const settledAt = useRef(0);
  const lastPaintAt = useRef(0);
  const frame = useRef<number | null>(null);
  const day = useRef(dayKey);

  // A new measurement: note when it arrived so the projection runs from there.
  useEffect(() => {
    settledAt.current = performance.now();
    // A different day is a different quantity, so the floor is replaced rather than
    // ratcheted, and instantly rather than eased.
    if (day.current !== dayKey) {
      day.current = dayKey;
      floor.current = settled;
      setShown(settled);
      return;
    }
    if (settled > floor.current) floor.current = settled;
  }, [settled, dayKey]);

  useEffect(() => {
    if (!enabled || powerW <= 0) {
      /*
        Production stopped, so the figure has to come to rest on the measured total — which
        where the projection ran ahead means coming down. Sunset is the steepest decline of
        the day and the moment it is most likely to be ahead, so this eases down over about
        a second rather than snapping. It must land on the measurement, not hold above it,
        or the day's total stays overstated all night.
      */
      if (floor.current <= settled) {
        floor.current = settled;
        setShown(settled);
        return;
      }
      const from = floor.current;
      const began = performance.now();
      const settle = (now: number): void => {
        const t = Math.min(1, (now - began) / SETTLE_MS);
        const eased = 1 - (1 - t) ** 3;
        floor.current = from + (settled - from) * eased;
        setShown(floor.current);
        if (t < 1) frame.current = requestAnimationFrame(settle);
      };
      frame.current = requestAnimationFrame(settle);
      return () => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
      };
    }
    const perMs = (powerW / 1000) * pricePerKwh / 3_600_000;
    const step = (now: number): void => {
      /*
        Monotonic by construction: where the projection has run ahead of what was earned,
        the figure holds until the measurement passes it again.

        This guarantees only that the figure never goes backwards. It is NOT a lower bound
        on what has been earned — against a day of this array's real curve it runs ahead on
        about a quarter of the intervals, by a median of a quarter of a cent and three and a
        half cents at worst. It re-anchors at every poll, so the day's total is never wrong.
      */
      const projected = settled + perMs * Math.max(0, now - settledAt.current);
      if (projected > floor.current) floor.current = projected;
      // Painted about ten times a second, not per frame: the fourth decimal only turns over
      // two or three times a second on this array.
      if (now - lastPaintAt.current >= PAINT_MS) {
        lastPaintAt.current = now;
        setShown(floor.current);
      }
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [settled, powerW, pricePerKwh, enabled]);

  const live = enabled && powerW > 0;
  return `$${shown.toFixed(live ? LIVE_DECIMALS : 2)}`;
}

/*
  Stagger, for the cards arriving on a page load.

  A module counter rather than an index prop, so nothing is threaded through call sites.
  It resets once the burst of mounts has passed, so a card that appears later — a panel
  expanding, a tab switching — mounts alone and gets no delay.
*/
let mountedInBurst = 0;
let burstReset: ReturnType<typeof setTimeout> | null = null;
/** Enough to read as a cascade, capped so the last card is not kept waiting. */
const STEP_MS = 45;
const MAX_STAGGER_MS = 320;

export function useEntranceDelay(enabled = true): number {
  const [delay] = useState(() => {
    if (!enabled) return 0;
    const at = Math.min(mountedInBurst * STEP_MS, MAX_STAGGER_MS);
    mountedInBurst += 1;
    if (burstReset) clearTimeout(burstReset);
    burstReset = setTimeout(() => {
      mountedInBurst = 0;
      burstReset = null;
    }, 250);
    return at;
  });
  return delay;
}
