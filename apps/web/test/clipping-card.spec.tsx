import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Clipping, PanelMeta, Snapshot, Summary } from '../src/api';

/*
  The clipping card cannot be checked against this array, because this array does not clip —
  conversion holds at 94.81% from 600 W to 1500 W with no rolloff at all. So the only way to
  know the card works is to hand it a finding.

  The other half matters as much: it must be absent on the empty list, which is the answer
  every day of the year here. A card that renders an "all clear" would be one more permanent
  thing to read past on a page that already had that problem.
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
    // Every day on this roof so far. Silence is the feature.
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

  it('shows the efficiency drop that proved it', async () => {
    /*
      Both numbers, not just the low one. "87.2% flat out against 94.8% the rest of the time"
      is the entire argument for calling this clipping rather than a broken inverter.
    */
    show([finding()]);
    await waitFor(() => expect(screen.getByText(/87\.2% flat out/)).toBeTruthy());
    expect(screen.getByText(/against 94\.8%/)).toBeTruthy();
  });

  it('puts the cost in kWh per day', async () => {
    show([finding({ lostWhPerDay: 240 })]);
    await waitFor(() => expect(screen.getByText(/0\.24 kWh\/day/)).toBeTruthy());
  });

  it('says a one-panel unit has a panel, not panels', async () => {
    show([finding({ ports: 1, label: '19D9', ceilingAcW: 400 })]);
    await waitFor(() => expect(screen.getByText(/its panel makes more than it can pass/)).toBeTruthy());
  });

  it('counts more than one', async () => {
    show([finding(), finding({ inverterSerial: '2', label: '89B5' })]);
    await waitFor(() => expect(screen.getByText('2 inverters')).toBeTruthy());
  });

  it('explains that clipping is design rather than a fault', async () => {
    // Without this the card reads as a defect report about hardware working as intended.
    show([finding()]);
    await waitFor(() => expect(screen.getByText(/normal design, not a fault/i)).toBeTruthy());
  });
});
