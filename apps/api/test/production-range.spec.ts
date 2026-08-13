import { describe, expect, it, vi } from 'vitest';
import { ReadingsController } from '../src/readings/readings.controller';

/*
  The range selector on the Trends page reached exactly one panel out of six, and not the
  chart directly beneath it — which reads as a broken control rather than a narrow one.
  These pin that the endpoint behind that chart now honours the range, and that honouring
  it cannot be turned into a scan of the whole reading table.
*/

/** A controller with only the collaborator this endpoint touches. */
function controllerWith(spy: (days: number) => void): ReadingsController {
  const readings = {
    getDailyEnergy: async (days: number) => {
      spy(days);
      return [];
    },
  };
  return new ReadingsController(
    readings as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('GET /api/history/production', () => {
  it('asks for the window the caller requested', async () => {
    const spy = vi.fn();
    await controllerWith(spy).getProduction('day', '90');
    expect(spy).toHaveBeenCalledWith(90);
  });

  it('keeps its old default when no range is given', async () => {
    // Every existing caller passes only a grouping; none of them should change behaviour.
    const spy = vi.fn();
    await controllerWith(spy).getProduction('day');
    expect(spy).toHaveBeenCalledWith(120);
  });

  it('clamps a day view to something a Raspberry Pi can group', async () => {
    /*
      The ceiling is the whole reason the window was derived from the grouping in the first
      place: an unbounded day view is a groupBy over the entire reading table, on a
      five-minute poll, per open tab. A range selector must not be able to ask for that.
    */
    const spy = vi.fn();
    await controllerWith(spy).getProduction('day', '999999');
    expect(spy.mock.calls[0][0]).toBeLessThanOrEqual(400);
  });

  it('lets a year view reach back as far as it always could', async () => {
    const spy = vi.fn();
    await controllerWith(spy).getProduction('year');
    expect(spy.mock.calls[0][0]).toBeGreaterThan(3000);
  });

  it('ignores a range that is not a number rather than asking for NaN days', async () => {
    for (const bad of ['', 'soon', '-30', '0']) {
      const spy = vi.fn();
      await controllerWith(spy).getProduction('day', bad);
      expect(spy).toHaveBeenCalledWith(120);
    }
  });
});
