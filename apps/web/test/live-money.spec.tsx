import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useLiveMoney } from '../src/shell/motion';

/*
  The money counter that ticks between polls. The array earns continuously and the app hears
  about it every five minutes, so what is drawn in between is a projection of the last
  measured power. Two rules keep it honest: never render a decrease, and stop dead when
  nothing is being made.
*/

function Probe(props: {
  settled: number;
  powerW: number;
  pricePerKwh?: number;
  enabled?: boolean;
  dayKey?: string;
}): JSX.Element {
  const shown = useLiveMoney({
    settled: props.settled,
    powerW: props.powerW,
    pricePerKwh: props.pricePerKwh ?? 0.1539,
    enabled: props.enabled ?? true,
    dayKey: props.dayKey ?? 'day-1',
  });
  return <span data-testid="fig">{shown}</span>;
}

const figure = (): number => Number(screen.getByTestId('fig').textContent!.replace('$', ''));

/*
  Vitest's fake timers already stand in for requestAnimationFrame and performance.now, so
  advancing the clock advances the frame loop and the hook's own sense of time together.
  Hand-rolled stubs for those fight the built-ins and throw on cleanup.
*/
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLiveMoney', () => {
  it('ticks upward while the roof is producing', () => {
    // 6,253 W at 15.39c/kWh is about $0.96 an hour, so a second is worth a hair over 2/100c.
    render(<Probe settled={1.6684} powerW={6253} />);
    const start = figure();
    advance(4_000);
    expect(figure()).toBeGreaterThan(start);
  });

  it('projects at the rate the power implies, not some arbitrary crawl', () => {
    render(<Probe settled={1} powerW={6253} />);
    advance(10_000);
    // $0.9624/hr over ten seconds is $0.00267. Loose bounds: order, not frame count.
    expect(figure()).toBeGreaterThan(1.002);
    expect(figure()).toBeLessThan(1.004);
  });

  it('never renders a decrease when a poll lands under the projection', () => {
    // A cloud arrives and the app does not find out for up to five minutes.
    const view = render(<Probe settled={2} powerW={6253} />);
    advance(20_000);
    const beforePoll = figure();

    view.rerender(<Probe settled={1.99} powerW={1400} />);
    advance(2_000);
    expect(figure()).toBeGreaterThanOrEqual(beforePoll);
  });

  it('holds flat while it waits, and resumes once the measurement passes it', () => {
    // The cost of never going backwards: after a large drop the figure sits still until the
    // measurement overtakes it. Creeping upward meanwhile only lengthens the reconciliation.
    const view = render(<Probe settled={2} powerW={6253} />);
    advance(20_000);
    view.rerender(<Probe settled={1.9} powerW={1400} />);
    advance(2_000);
    const held = figure();
    advance(5_000);
    expect(figure()).toBe(held);

    view.rerender(<Probe settled={held + 0.01} powerW={1400} />);
    advance(500);
    expect(figure()).toBeGreaterThan(held);
  });

  it('stops dead when nothing is being produced', () => {
    render(<Probe settled={4.2} powerW={0} />);
    const start = figure();
    advance(10_000);
    expect(figure()).toBe(start);
  });

  it('settles down to the measurement at sunset rather than snapping', () => {
    /*
      Sunset is the steepest decline of the day, so the projection is most likely to be
      running ahead there. It has to land on the measurement, or the day's total stays
      overstated all night — but not in one frame, which reads as a backwards tick.
    */
    const view = render(<Probe settled={4} powerW={9000} />);
    advance(30_000);
    const ahead = figure();
    expect(ahead).toBeGreaterThan(4);

    view.rerender(<Probe settled={4} powerW={0} />);
    advance(120);
    const midway = figure();
    expect(midway).toBeLessThan(ahead);   // it is coming down
    expect(midway).toBeGreaterThan(4);    // but has not arrived in one frame

    advance(1_500);
    expect(screen.getByTestId('fig').textContent).toBe('$4.00');
  });

  it('shows plain cents when it is not ticking, and finer digits when it is', () => {
    const view = render(<Probe settled={4.2} powerW={0} />);
    expect(screen.getByTestId('fig').textContent).toBe('$4.20');
    view.rerender(<Probe settled={4.2} powerW={6253} />);
    advance(200);
    expect(screen.getByTestId('fig').textContent).toMatch(/^\$4\.2\d{3}$/);
  });

  it('sits still under reduced motion, at the measured figure', () => {
    render(<Probe settled={1.6684} powerW={6253} enabled={false} />);
    expect(screen.getByTestId('fig').textContent).toBe('$1.67');
    advance(10_000);
    expect(screen.getByTestId('fig').textContent).toBe('$1.67');
  });

  it('follows a poll upward immediately, which is the ordinary case', () => {
    const view = render(<Probe settled={1} powerW={6253} />);
    advance(1_000);
    view.rerender(<Probe settled={1.5} powerW={6253} />);
    advance(200);
    expect(figure()).toBeGreaterThanOrEqual(1.5);
  });
});

describe('crossing a day boundary', () => {
  /*
    The ratchet is right inside one day and wrong across two. This tile shows yesterday's
    finished total overnight and switches back to today at sunrise, so it crosses the boundary
    twice; without a day key it holds yesterday's dollars against today's energy.
  */
  it('drops to the new day rather than holding yesterday’s money', () => {
    const { rerender } = render(<Probe settled={10.01} powerW={0} dayKey="2026-08-24" />);
    advance(1000);
    expect(figure()).toBeCloseTo(10.01, 2);

    rerender(<Probe settled={0.31} powerW={3500} dayKey="2026-08-25" />);
    advance(200);
    expect(figure()).toBeLessThan(1);
  });

  it('lands on the new day immediately, without easing down through it', () => {
    // Easing exists to stop a figure looking corrected; a new day is not a correction.
    const { rerender } = render(<Probe settled={10.01} powerW={0} dayKey="2026-08-24" />);
    advance(1000);
    rerender(<Probe settled={0} powerW={0} dayKey="2026-08-25" />);
    advance(0);
    expect(figure()).toBeCloseTo(0, 2);
  });

  it('still refuses to go backwards within one day', () => {
    // The original rule has to survive the day-key fix.
    const { rerender } = render(<Probe settled={5} powerW={4000} dayKey="2026-08-25" />);
    advance(2000);
    const peak = figure();
    rerender(<Probe settled={4.9} powerW={4000} dayKey="2026-08-25" />);
    advance(100);
    expect(figure()).toBeGreaterThanOrEqual(peak);
  });

  it('treats a change back to yesterday as a day change too', () => {
    const { rerender } = render(<Probe settled={0.31} powerW={3500} dayKey="2026-08-25" />);
    advance(500);
    rerender(<Probe settled={9.0} powerW={0} dayKey="2026-08-24" />);
    advance(50);
    expect(figure()).toBeCloseTo(9.0, 1);
  });
});
