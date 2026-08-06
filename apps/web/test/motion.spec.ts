import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChanged, useCountUp, useEntranceDelay, usePrefersReducedMotion } from '../src/shell/motion';

/*
  The two rules every animation in this app goes through. Both are about restraint rather
  than motion: refuse it when the browser has asked for none, and light something up only
  when it has genuinely moved.
*/

/** A controllable `prefers-reduced-motion` query. */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const query = {
    matches,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', () => query);
  return {
    change(next: boolean) {
      query.matches = next;
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
    },
  };
}

describe('usePrefersReducedMotion', () => {
  it('respects the setting at mount', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
    vi.unstubAllGlobals();
  });

  it('listens, so turning it on mid-session takes effect without a reload', () => {
    /*
      Somebody who enables this partway through did it because something on screen was
      bothering them. Reading it only at mount makes them reload to be listened to.
    */
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => media.change(true));
    expect(result.current).toBe(true);
    vi.unstubAllGlobals();
  });

  it('assumes motion is fine where the query does not exist', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('useChanged', () => {
  it('is quiet on first render', () => {
    /*
      Everything is new when a page loads. Lighting the whole screen up says nothing — the
      signal is a change against something already seen.
    */
    const { result } = renderHook(({ v }) => useChanged(v), { initialProps: { v: 42 } });
    expect(result.current).toBe(false);
  });

  it('fires when the value actually moves', () => {
    const { result, rerender } = renderHook(({ v }) => useChanged(v), {
      initialProps: { v: 42 },
    });
    rerender({ v: 43 });
    expect(result.current).toBe(true);
  });

  it('stays quiet when a poll returns the same number', () => {
    // A dashboard polls every five minutes and most of the time nothing has moved. A pulse
    // on every tick is a pulse that means nothing.
    const { result, rerender } = renderHook(({ v }) => useChanged(v), {
      initialProps: { v: 42 },
    });
    rerender({ v: 42 });
    expect(result.current).toBe(false);
  });

  it('clears itself after the hold', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useChanged(v, 1000), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1100));
    expect(result.current).toBe(false);
    vi.useRealTimers();
  });
});

describe('useCountUp', () => {
  it('cuts rather than tweening when motion is refused', () => {
    const { result } = renderHook(({ v }) => useCountUp(v, false), { initialProps: { v: '10.7' } });
    expect(result.current).toBe('10.7');
  });

  it('keeps whatever surrounded the number', async () => {
    /*
      `Metric` is handed a string that is already formatted. A tween that rebuilt the number
      from scratch would drop the currency, the separators, or the decimals — and a figure
      that gains a digit mid-animation reads as a rendering fault.
    */
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useCountUp(v, true), {
      initialProps: { v: '$1,000' },
    });
    rerender({ v: '$2,000' });
    // Mid-flight it is still a dollar figure with grouping and no decimals.
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toMatch(/^\$[\d,]+$/);
    vi.useRealTimers();
  });

  it('leaves a value that is not a lone number alone', () => {
    // "11 / 12" and "—" have nothing to travel between; inventing a path is worse than a cut.
    const { result, rerender } = renderHook(({ v }) => useCountUp(v, true), {
      initialProps: { v: '11 / 12' },
    });
    rerender({ v: '10 / 12' });
    expect(result.current).toBe('10 / 12');
  });

  it('does nothing when the figure has not moved', () => {
    const { result, rerender } = renderHook(({ v }) => useCountUp(v, true), {
      initialProps: { v: '76.8' },
    });
    rerender({ v: '76.8' });
    expect(result.current).toBe('76.8');
  });
});

describe('useEntranceDelay', () => {
  it('is zero when motion is refused', () => {
    const { result } = renderHook(() => useEntranceDelay(false));
    expect(result.current).toBe(0);
  });

  it('staggers cards mounting together and caps the wait', () => {
    /*
      The cap matters more than the step. Without it a page with twenty cards keeps the last
      one waiting most of a second, which stops being a cascade and becomes a page that
      loads slowly.
    */
    const delays = Array.from({ length: 20 }, () => renderHook(() => useEntranceDelay(true)).result.current);
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(320);
  });
});
