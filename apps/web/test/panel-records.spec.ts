import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRoofCells } from '../src/components/RoofCanvas';
import type { PanelMeta, Snapshot } from '../src/api';

/*
  The "Best ever" view of the roof. Panels peak within a few watts of each other — 384 to 388
  on a 500 W module — so painting by share of nameplate gives identical squares; the colour
  is stretched across the range the roof actually reached instead.

  useRoofCells wraps its work in useMemo, so it needs a render context — hence renderHook.
*/

const panel = (id: number): PanelMeta =>
  ({
    id,
    portNumber: ((id - 1) % 4) + 1,
    inverterSerial: `1140${Math.floor((id - 1) / 4)}`,
    label: null,
    wattage: 500,
    gridX: (id - 1) % 11,
    gridY: Math.floor((id - 1) / 11),
  }) as unknown as PanelMeta;

const panels = (n: number): PanelMeta[] => Array.from({ length: n }, (_, i) => panel(i + 1));

const snapshot = (n: number): Snapshot =>
  ({
    dtuSerialNumber: 'x',
    takenAt: new Date().toISOString(),
    totalPower: 8000,
    dailyEnergyWh: 40_000,
    inverters: [],
    ports: Array.from({ length: n }, (_, i) => ({
      portNumber: (i % 4) + 1,
      inverterSerialNumber: `1140${Math.floor(i / 4)}`,
      power: 200,
      energyDailyWh: 900,
    })),
  }) as unknown as Snapshot;

/** The real spread: a tight cluster near 387, and one panel far behind. */
const REAL_BESTS = new Map<number, number>([
  [1, 387.6],
  [2, 387.4],
  [3, 386.4],
  [4, 385.9],
  [5, 318.2],
]);

const cellsFor = (records: Map<number, number> | null) =>
  renderHook(() => useRoofCells(panels(5), snapshot(5), 'peak', records)).result.current;

describe('the best-ever map', () => {
  it('shows each panel its own record, in watts', () => {
    const cells = cellsFor(REAL_BESTS);
    expect(cells.map((c) => c.value)).toEqual(['388', '387', '386', '386', '318']);
  });

  it('stretches the colour across the roof’s own range, not against nameplate', () => {
    // Scaled to a 500 W rating these land at 0.64 to 0.78; scaled to the roof, the laggard
    // is 0 and the champion is 1.
    const cells = cellsFor(REAL_BESTS);
    expect(cells[0].t).toBeCloseTo(1, 5);
    expect(cells[4].t).toBeCloseTo(0, 5);
    expect(cells[1].t).toBeGreaterThan(0.9);
  });

  it('keeps the laggard visibly apart from the pack', () => {
    // 318 against a cluster at 386-388 must read as a different colour, not a shade of one.
    const cells = cellsFor(REAL_BESTS);
    const pack = Math.min(cells[0].t, cells[1].t, cells[2].t, cells[3].t);
    expect(pack - cells[4].t).toBeGreaterThan(0.9);
  });

  it('draws an em dash rather than a zero for a panel with no record', () => {
    // "0" would read as a measured zero.
    const partial = new Map(REAL_BESTS);
    partial.delete(3);
    expect(cellsFor(partial)[2].value).toBe('—');
  });

  it('does not colour a panel it has no record for', () => {
    const partial = new Map(REAL_BESTS);
    partial.delete(3);
    expect(cellsFor(partial)[2].t).toBe(0);
  });

  it('waits rather than blanking while the records are still loading', () => {
    // usePolling holds null until the first response; the map must not claim zeros meanwhile.
    const cells = cellsFor(null);
    expect(cells.every((c) => c.value === '—')).toBe(true);
  });

  it('survives every panel having the identical record', () => {
    // A flat roof of equals must not divide by a zero span and paint NaN.
    const flat = new Map([1, 2, 3, 4, 5].map((id) => [id, 380] as const));
    const cells = cellsFor(new Map(flat));
    expect(cells.every((c) => Number.isFinite(c.t))).toBe(true);
    expect(cells.every((c) => c.value === '380')).toBe(true);
  });
});
