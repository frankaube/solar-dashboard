import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Alerts, PowerPoint, Snapshot, Summary } from '../src/api';

/*
  Render tests for the page whose whole job is to be glanced at.

  Every bug this page shipped was found by opening it rather than by a test: a card heading
  that asked for work already triaged, acknowledged rows distinguishable only by opacity, a
  census finding listed twice under two wordings. The pure functions behind them were green
  throughout — `mergeIssues` and `verdict` have had tests since the day they were written.
  What was missing was anything that rendered them.
*/

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    // The page fetches these on mount; neither is what is under test here.
    fetchCensus: vi.fn().mockResolvedValue({
      claims: [],
      findings: [],
      believedRatedKw: 23,
      believedFrom: 'you',
    }),
    fetchNotificationHistory: vi.fn().mockResolvedValue([]),
    ackAlert: vi.fn().mockResolvedValue(undefined),
  };
});

const { HealthPage } = await import('../src/pages/HealthPage');

const summary = (over: Partial<Summary> = {}): Summary =>
  ({
    updatedAt: new Date().toISOString(),
    currentPowerW: 2000,
    todayEnergyWh: 40_000,
    todayRevenue: 6,
    pricePerKwh: 0.16,
    gridVoltage: 240,
    gridFrequency: 60,
    invertersOnline: 11,
    invertersTotal: 11,
    ratedKw: 23,
    ratedKwConfigured: true,
    panelsTotal: 42,
    ...over,
  }) as Summary;

const live = (ports = 42): Snapshot =>
  ({
    dtuSerialNumber: 'x',
    takenAt: new Date().toISOString(),
    totalPower: 2000,
    dailyEnergyWh: 40_000,
    inverters: [{ rfSignal: -60 }],
    ports: Array.from({ length: ports }, () => ({})),
  }) as unknown as Snapshot;

const alerts = (active: unknown[] = []): Alerts =>
  ({ active, recentlyClosed: [] }) as unknown as Alerts;

const alert = (over: Record<string, unknown> = {}) => ({
  id: 1,
  type: 'inverter_offline',
  severity: 'serious',
  subjectKey: 'inverter:ABC:1',
  message: 'An inverter is offline',
  openedAt: '2026-08-04T10:00:00Z',
  closedAt: null,
  ackedAt: null,
  ...over,
});

const history: PowerPoint[] = [{ t: new Date().toISOString(), powerW: 2000 }];

const draw = (props: Partial<Parameters<typeof HealthPage>[0]> = {}) =>
  render(
    <MemoryRouter>
      <HealthPage
        summary={summary()}
        live={live()}
        alerts={alerts()}
        history={history}
        refreshAlerts={() => undefined}
        {...props}
      />
    </MemoryRouter>,
  );

describe('the verdict', () => {
  it('says all clear with nothing wrong', async () => {
    draw();
    expect(await screen.findByText('All clear')).toBeDefined();
  });

  it('leads with the worst thing present', async () => {
    draw({ alerts: alerts([alert()]) });
    expect(await screen.findByText('Needs attention')).toBeDefined();
  });

  it('demotes to a look when the only problems are acknowledged', async () => {
    /*
      Acknowledging says "I have seen this", so the page stops shouting — but the issue
      stays listed, because a page that hid it would report all clear over a dead inverter
      somebody nodded at last Tuesday.
    */
    draw({ alerts: alerts([alert({ ackedAt: '2026-08-04T11:00:00Z' })]) });
    expect(await screen.findByText('All clear')).toBeDefined();
    expect(screen.getByText('An inverter is offline')).toBeDefined();
    expect(screen.getByText('acknowledged')).toBeDefined();
  });
});

describe('stale readings', () => {
  it('outrank the verdict entirely', async () => {
    /*
      The one failure a health page must never have. "All clear" computed from readings that
      stopped arriving hours ago is not health — it is the last health the app saw, and the
      two are indistinguishable until somebody checks a timestamp nobody reads.
    */
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
    draw({ summary: summary({ updatedAt: old }) });
    expect(await screen.findByText('Not hearing from the array')).toBeDefined();
    expect(screen.queryByText('All clear')).toBeNull();
  });
});

describe('the issue list heading', () => {
  it('counts what is outstanding, not how many rows are drawn', async () => {
    /*
      The bug, rendered. "2 to look at" over a list where one is triaged asks for work that
      is done, which is how a page teaches somebody to stop reading its headings.
    */
    draw({
      alerts: alerts([
        alert({ id: 1, message: 'live one' }),
        alert({ id: 2, message: 'seen one', ackedAt: '2026-08-04T11:00:00Z' }),
      ]),
    });
    expect(await screen.findByText('1 to look at · 1 acknowledged')).toBeDefined();
  });
});

describe('vital signs', () => {
  it('marks a short panel count rather than printing it plainly', async () => {
    draw({ live: live(38) });
    expect(await screen.findByText('38 / 42')).toBeDefined();
  });
});
