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
