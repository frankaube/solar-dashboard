import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PanelMeta, Snapshot, Summary } from '../src/api';

/*
  How many panels does the owner have?

  The Roof hero used to answer that with the panels that send per-panel detail, and said
  "38 of your 42 panels are keeping up" to someone with 46 on the roof. The gateway registers
  46; four of them have never reported individually. The same mistake the Health card made
  with the inverters — a denominator taken from whatever happens to be talking.

  The correction is not simply swapping 42 for 46, because the four silent panels are not
  known to be healthy. They are counted apart, and named.
*/

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    fetchPanelInsights: vi.fn().mockResolvedValue([]),
    fetchPortHistory: vi.fn().mockResolvedValue([]),
  };
});

const api = await import('../src/api');
const { RoofPage } = await import('../src/pages/RoofPage');

const summary = (panelsTotal: number | null): Summary =>
  ({ panelsTotal, currentPowerW: 8000, invertersOnline: 11, invertersTotal: 13 }) as Summary;

/** `reporting` panels, each with a position so they become cells on the map. */
const panels = (reporting: number): PanelMeta[] =>
  Array.from({ length: reporting }, (_, i) => ({
    id: i + 1,
    portNumber: i + 1,
    inverterSerial: `1140${i}`,
    label: null,
    ratedW: 500,
    gridX: i % 11,
    gridY: Math.floor(i / 11),
  })) as unknown as PanelMeta[];

const live = (reporting: number): Snapshot =>
  ({
    dtuSerialNumber: 'x',
    takenAt: new Date().toISOString(),
    totalPower: 8000,
    dailyEnergyWh: 40_000,
    inverters: [],
    ports: Array.from({ length: reporting }, (_, i) => ({
      portNumber: i + 1,
      inverterSerial: `1140${i}`,
      power: 209,
      temperature: 40,
      energyDaily: 900,
    })),
  }) as unknown as Snapshot;

function show(options: {
  registered: number | null;
  reporting: number;
  underperforming: number;
}) {
  const { registered, reporting, underperforming } = options;
  vi.mocked(api.fetchPanelInsights).mockResolvedValue(
    Array.from({ length: underperforming }, (_, i) => ({
      portId: i + 1,
      pattern: 'shading',
    })) as never,
  );
  render(
    <MemoryRouter>
      <RoofPage
        live={live(reporting)}
        panels={panels(reporting)}
        summary={summary(registered)}
        refreshPanels={() => {}}
      />
    </MemoryRouter>,
  );
}

describe('the roof hero', () => {
  it('counts against the roof the gateway registered, not the panels that report', async () => {
    // The bug, in one assertion: 46 on the roof, 42 reporting, and it used to say 42.
    show({ registered: 46, reporting: 42, underperforming: 4 });
    await waitFor(() => {
      expect(screen.getByText(/of your 46 panels are keeping up/)).toBeTruthy();
    });
    expect(screen.queryByText(/of your 42 panels/)).toBeNull();
  });

  it('does not count a silent panel as a healthy one', async () => {
    /*
      38 is reporting minus underperforming. Taking it from the registered count instead would
      make it 42 and quietly vouch for four panels nothing has been heard from.
    */
    show({ registered: 46, reporting: 42, underperforming: 4 });
    await waitFor(() => {
      expect(screen.getByText(/^38 of your 46 panels are keeping up/)).toBeTruthy();
    });
  });

  it('says out loud that the rest send nothing', async () => {
    show({ registered: 46, reporting: 42, underperforming: 4 });
    await waitFor(() => {
      expect(screen.getByText(/4 more send no detail at all/)).toBeTruthy();
    });
  });

  it('still mentions the silent ones when everything reporting is keeping up', async () => {
    // The all-clear used to be unconditional, which would hide the four entirely.
    show({ registered: 46, reporting: 42, underperforming: 0 });
    await waitFor(() => {
      expect(screen.getByText(/All 42 panels that report are keeping up/)).toBeTruthy();
    });
    expect(screen.getByText(/4 more send no detail at all/)).toBeTruthy();
  });

  it('says nothing about silence when every panel reports', async () => {
    show({ registered: 42, reporting: 42, underperforming: 0 });
    await waitFor(() => {
      expect(screen.getByText(/All 42 panels that report are keeping up/)).toBeTruthy();
    });
    expect(screen.queryByText(/send no detail/)).toBeNull();
  });

  it('falls back to the panels it can see when the gateway has never said', async () => {
    show({ registered: null, reporting: 42, underperforming: 4 });
    await waitFor(() => {
      expect(screen.getByText(/of your 42 panels are keeping up/)).toBeTruthy();
    });
    expect(screen.queryByText(/send no detail/)).toBeNull();
  });

  it('does not vouch for a placed panel that has stopped reporting', async () => {
    /*
      A saved position is not a reading. One microinverter here has four panels on the map and
      has dropped out of the snapshot entirely, so the map draws four cells at zero watts.
      Counting map cells made those four "keeping up"; only 38 of the 46 are sending anything.
    */
    vi.mocked(api.fetchPanelInsights).mockResolvedValue(
      Array.from({ length: 4 }, (_, i) => ({ portId: i + 1, pattern: 'shading' })) as never,
    );
    render(
      <MemoryRouter>
        <RoofPage
          live={live(38)}
          panels={panels(42)}
          summary={summary(46)}
          refreshPanels={() => {}}
        />
      </MemoryRouter>,
    );
    // 34 is 38 reporting less 4 shaded. Counting the 42 map cells would have said 38.
    await waitFor(() => {
      expect(screen.getByText(/^34 of your 46 panels are keeping up/)).toBeTruthy();
    });
    expect(screen.getByText(/8 more send no detail at all/)).toBeTruthy();
  });
});
