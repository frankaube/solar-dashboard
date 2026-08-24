import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useLiveMoney } from '../src/shell/motion';

/*
  The money counter that ticks between polls.

  The array earns continuously and the app hears about it every five minutes, so everything
  drawn in between is a projection of the last measured power. The tests that matter are the
  two rules that keep that honest: it never renders a decrease, and it stops dead when there
  is nothing being made.
*/

function Probe(props: {
  settled: number;
  powerW: number;
  pricePerKwh?: number;
  enabled?: boolean;
}): JSX.Element {
  const shown = useLiveMoney({
    settled: props.settled,
    powerW: props.powerW,
    pricePerKwh: props.pricePerKwh ?? 0.1539,
    enabled: props.enabled ?? true,
  });
  return <span data-testid="fig">{shown}</span>;
}

const figure = (): number => Number(screen.getByTestId('fig').textContent!.replace('$', ''));

/*
  Vitest's fake timers already stand in for requestAnimationFrame and performance.now, so
  advancing the clock advances the frame loop and the hook's own sense of time together.
  Hand-rolled stubs for those fought the built-ins and threw on cleanup.
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
    // $0.9624/hr over ten seconds is $0.00267. Loose bounds: the point is the order, not the frame count.
    expect(figure()).toBeGreaterThan(1.002);
    expect(figure()).toBeLessThan(1.004);
  });

  it('never renders a decrease when a poll lands under the projection', () => {
    /*
      The rule the whole design rests on. A cloud arrives, the app does not find out for up
      to five minutes, and by then the counter has spent money that was never earned. A money
      counter running backwards is the app confessing it was guessing.
    */
    const view = render(<Probe settled={2} powerW={6253} />);
    advance(20_000);
    const beforePoll = figure();

    // The poll arrives: less was actually earned, and the roof is now barely producing.
    view.rerender(<Probe settled={1.99} powerW={1400} />);
    advance(2_000);
    expect(figure()).toBeGreaterThanOrEqual(beforePoll);
  });

  it('holds flat while it waits, and resumes once the measurement passes it', () => {
    /*
      The wait is a genuine cost of never going backwards: after a large drop the figure can
      sit still for a while. An earlier version crept upward so it would not look frozen,
      which was invisible at four decimals and made the reconciliation take longer, so this
      simply holds — and then picks up again the moment the truth overtakes it.
    */
    const view = render(<Probe settled={2} powerW={6253} />);
    advance(20_000);
    view.rerender(<Probe settled={1.9} powerW={1400} />);
    advance(2_000);
    const held = figure();
    advance(5_000);
    expect(figure()).toBe(held);

    // A later poll, by which time more has genuinely been earned than the figure shows.
    view.rerender(<Probe settled={held + 0.01} powerW={1400} />);
    advance(500);
    expect(figure()).toBeGreaterThan(held);
  });

  it('stops dead when nothing is being produced', () => {
    // After sunset there is nothing accruing, so a counter still moving would be inventing.
    render(<Probe settled={4.2} powerW={0} />);
    const start = figure();
    advance(10_000);
    expect(figure()).toBe(start);
  });

  it('settles down to the measurement at sunset rather than snapping', () => {
    /*
      The bug this exists for. Sunset is the steepest decline of the day, so it is the moment
      the projection is most likely to be running ahead — and the first version snapped
      straight to the measured total, putting a visible backwards tick at dusk every clear
      evening. It has to land on the measurement, or the day's total stays overstated all
      night; it just must not arrive there in one frame.
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
    // Rests on the measurement, in the plain cents a finished day is shown in.
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
