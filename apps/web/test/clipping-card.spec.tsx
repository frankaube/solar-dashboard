import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Clipping, PanelMeta, Snapshot, Summary } from '../src/api';

/*
  This array does not clip — conversion holds at 94.81% from 600 W to 1500 W with no rolloff —
  so the card can only be checked against a handed-in finding. The other half is that it must
  be absent on the empty list rather than rendering an "all clear".
*/

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    fetchPanelInsights: vi.fn().mockResolvedValue([]),
    fetchPortHistory: vi.fn().mockResolvedValue([]),
    fetchClipping: vi.fn().mockResolvedValue([]),
  };
});

const api = await import('../src/api');
const { RoofPage } = await import('../src/pages/RoofPage');

/** A four-port unit against a 1600 W ceiling — the case a cold spring day would produce. */
const finding = (over: Partial<Clipping> = {}): Clipping => ({
  inverterSerial: '22137926191684',
  label: '8844',
  ports: 4,
  ceilingAcW: 1600,
  plateauEfficiencyPct: 94.8,
  topEfficiencyPct: 87.2,
  lostWhPerDay: 240,
  firstSeen: '2026-04-02T14:10:00Z',
  lastSeen: '2026-04-09T15:05:00Z',
  ...over,
});

const summary = { panelsTotal: 46 } as Summary;
const panels = Array.from({ length: 42 }, (_, i) => ({
  id: i + 1,
  portNumber: (i % 4) + 1,
  inverterSerial: `1140${Math.floor(i / 4)}`,
  label: null,
  ratedW: 500,
  gridX: i % 11,
  gridY: Math.floor(i / 11),
})) as unknown as PanelMeta[];
const live = {
  dtuSerialNumber: 'x',
  takenAt: new Date().toISOString(),
  totalPower: 8000,
  dailyEnergyWh: 40_000,
  inverters: [],
  ports: Array.from({ length: 38 }, (_, i) => ({
    portNumber: (i % 4) + 1,
    inverterSerialNumber: `1140${Math.floor(i / 4)}`,
    power: 209,
    temperature: 40,
    energyDaily: 900,
  })),
} as unknown as Snapshot;

function show(clipping: Clipping[]) {
  vi.mocked(api.fetchClipping).mockResolvedValue(clipping);
  render(
    <MemoryRouter>
      <RoofPage live={live} panels={panels} summary={summary} refreshPanels={() => {}} />
    </MemoryRouter>,
  );
}

describe('the clipping card', () => {
  it('is not on the page when nothing is clipping', async () => {
    show([]);
    await waitFor(() => expect(screen.getByText(/panels are keeping up|report are keeping up/)).toBeTruthy());
    expect(screen.queryByText(/Hitting their limit/i)).toBeNull();
  });

  it('appears once a unit hits its ceiling', async () => {
    show([finding()]);
    await waitFor(() => expect(screen.getByText(/Hitting their limit/i)).toBeTruthy());
  });

  it('names the unit and its ceiling', async () => {
    show([finding()]);
    await waitFor(() => expect(screen.getByText('8844')).toBeTruthy());
    expect(screen.getByText(/1600 W cap/)).toBeTruthy();
  });

  it('says what the ceiling costs rather than how it was detected', async () => {
    // The efficiency pair is the detection method; the cap and the daily loss are the meaning.
    show([finding()]);
    await waitFor(() => expect(screen.getByText(/1600 W cap/)).toBeTruthy());
    expect(screen.queryByText(/flat out/)).toBeNull();
  });

  it('puts the cost in kWh per day', async () => {
    show([finding({ lostWhPerDay: 240 })]);
    await waitFor(() => expect(screen.getByText(/0\.24 kWh\/day/)).toBeTruthy());
  });

  it('says a one-panel unit has a panel, not panels', async () => {
    show([finding({ ports: 1, label: '19D9', ceilingAcW: 400 })]);
    await waitFor(() => expect(screen.getByText(/Its panel makes more than it can pass/)).toBeTruthy());
  });

  it('counts more than one', async () => {
    show([finding(), finding({ inverterSerial: '2', label: '89B5' })]);
    await waitFor(() => expect(screen.getByText('2 inverters')).toBeTruthy());
  });

  it('explains that clipping is design rather than a fault', async () => {
    show([finding()]);
    await waitFor(() => expect(screen.getByText(/Not a fault/i)).toBeTruthy());
  });
});
