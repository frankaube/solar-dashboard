import { useEffect, useRef, useState } from 'react';

/**
 * Whether this browser wants motion at all.
 *
 * Asked rather than assumed, and asked live: somebody who turns the setting on mid-session
 * did it because something on screen was bothering them, and a page that only reads it at
 * mount makes them reload to be listened to.
 *
 * Motion sickness and vestibular disorders are not rare, and animation that cannot be
 * refused is an accessibility problem rather than a preference one. Everything animated in
 * this app goes through here.
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
 * True for a moment after `value` changes to something new.
 *
 * For the "what just moved" highlight on a dashboard somebody leaves open: five minutes
 * pass, four numbers change, and without this you have to have been watching to know which.
 *
 * Deliberately not true on first render. Everything is new when a page loads, and lighting
 * the whole screen up says nothing — the signal is a change against something you had
 * already seen.
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
 * `Metric` is handed a string that is already formatted — "$1,284", "10.7", "76.8" — so
 * tweening means finding the number inside it and putting it back the way it was found.
 * Anything without exactly one numeric run is left alone rather than guessed at.
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

/** How long a figure takes to travel. Short enough to read as a transition, not a countdown. */
const COUNT_MS = 420;

/**
 * A figure that travels to its new value instead of cutting.
 *
 * Worth being plain about what this is: the values it draws on the way were never measured.
 * Between two polls five minutes apart the array was at some sequence of outputs and this is
 * not it — the motion is a transition between two known numbers, not a record of anything.
 * It is display sugar, and it is here because it was asked for after that was said.
 *
 * Kept honest in the two ways available. It is fast, so nothing lingers at a fabricated
 * figure; and it never invents precision, reusing the decimals and grouping of the string it
 * was given rather than rendering more digits than the source had.
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
      // Ease out: fast away from the old value, settling into the new one, which reads as
      // arrival rather than as a counter running down.
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

/** Digits past the dollar. Cents alone move once every half a minute or so, which is not motion. */
const LIVE_DECIMALS = 4;

/** How often the figure is repainted. Ten a second reads as continuous and renders as cheap. */
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
}

/**
 * Money accruing between polls, as a figure that ticks.
 *
 * The array earns continuously and the app hears about it every five minutes, so a counter
 * that only moves on a poll sits still for five minutes at a time and then jumps. This fills
 * the gap by projecting the last measured power forward, which is the only honest thing
 * available: nothing here is measured, it is what the roof would have made had it carried on
 * doing what it was last seen doing.
 *
 * IT NEVER RENDERS A DECREASE, and that is the whole of the design. When a cloud arrives the
 * projection has already spent money that was never earned — six or seven cents on this
 * array — and the next poll would otherwise correct it downwards. A money counter running
 * backwards is the app confessing it was guessing, in the most alarming way it could choose.
 * So the figure holds and creeps while the measurement catches up to it, which makes what is
 * on screen a floor rather than a claim: never more than was earned by now, sometimes less.
 *
 * It stops completely at zero output. There is nothing accruing after sunset, so a counter
 * still moving would be inventing rather than projecting.
 */
export function useLiveMoney({ settled, powerW, pricePerKwh, enabled }: LiveMoneyInput): string {
  const [shown, setShown] = useState(settled);
  /*
    Held in refs, not state. The floor has to survive the re-render a poll causes without
    being recomputed from props, or the clamp that stops the counter reversing would be
    reset by the very update it exists to absorb.
  */
  const floor = useRef(settled);
  const settledAt = useRef(0);
  const lastPaintAt = useRef(0);
  const frame = useRef<number | null>(null);

  // A new measurement: note when it arrived so the projection runs from there.
  useEffect(() => {
    settledAt.current = performance.now();
    if (settled > floor.current) floor.current = settled;
  }, [settled]);

  useEffect(() => {
    if (!enabled || powerW <= 0) {
      /*
        Production has stopped, so nothing is accruing and the figure has to come to rest on
        the measured total. Where the projection had run ahead, that means coming DOWN.

        Sunset is the steepest decline of the day, so this is the moment the counter is most
        likely to be ahead — an earlier version of this comment claimed the opposite and
        snapped, which put a visible backwards tick at dusk every clear evening, which is the
        one thing this whole design exists to prevent.

        So it settles rather than snaps: eased down over about a second, which reads as a
        figure coming to rest instead of a number being corrected. It has to land on the
        measurement rather than hold above it, because the alternative is a day's total that
        stays overstated all night.
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
        Monotonic by construction. Where the projection has run ahead of what was actually
        earned — a cloud arrived and the app did not find out for five minutes — the figure
        simply holds until the measurement passes it again.

        An earlier version crept upward during that wait so it would not look frozen. It was
        a bad trade: at the reduced output the creep is under a hundredth of a cent a second,
        which is invisible at four decimals, and because the truth then has to close a gap
        that is still moving it took minutes longer to reconcile. Holding is simpler.

        What this guarantees is only that the figure never goes backwards. It is NOT a lower
        bound on what has been earned — measured against a day of this array's real curve it
        runs ahead on about a quarter of the intervals, by a median of a quarter of a cent
        and by three and a half cents at worst. It re-anchors to the measurement at every
        poll, so the day's total is never wrong; the wandering is all within the five
        minutes between them.
      */
      const projected = settled + perMs * Math.max(0, now - settledAt.current);
      if (projected > floor.current) floor.current = projected;
      /*
        Painted about ten times a second rather than on every frame. The fourth decimal only
        turns over two or three times a second on this array, so sixty renders a second buys
        nothing visible and costs it on the phone this is usually read on.
      */
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

  A module counter rather than an index prop, so nothing has to be threaded through every
  call site. It resets once the burst of mounts has passed, which is what keeps this to a
  page load: a card that appears later — a panel expanding, a tab switching — mounts alone
  and gets no delay, because a delay there is just lag.
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
