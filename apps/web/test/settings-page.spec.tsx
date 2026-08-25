import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/*
  Not a pin on every string — copy changes — but on two properties: help lives behind the ⓘ
  rather than on the page, and the exceptions to that are deliberate.
*/

const config = {
  electricityPricePerKwh: 0.177,
  systemCostCad: 60000,
  hstRate: 0.15,
  systemRatedKw: 23,
  rewardProgramId: 'net-metering',
  priceIncludesTax: true,
  selfConsumptionPct: 30,
  selfConsumptionAuto: false,
};

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  const stub = <T,>(value: T) => vi.fn().mockResolvedValue(value);
  return {
    ...actual,
    fetchConfig: stub(config),
    fetchPrograms: stub([
      { id: 'net-metering', label: 'Net metering (1:1 credit)', description: 'Banked 1:1.', needsRetail: true },
    ]),
    fetchCapabilities: stub({
      solar: { id: 'hoymiles', name: 'Hoymiles DTU' },
      pollIntervalMs: 300_000,
      metricsPath: '/api/metrics',
      healthPath: '/api/status',
      charger: null,
      vehicle: null,
      selfConsumptionSources: [{ id: 'ev', label: 'EV charging' }],
    }),
    fetchSelfConsumptionEstimate: stub({
      pct: 31,
      days: 7,
      producedKwh: 491,
      selfConsumedKwh: 152,
      reason: null,
      enabled: false,
      configuredPct: 30,
    }),
    fetchNotifications: stub({ webhook: null }),
    // The real shape — dtuHost, chargerHost, suggestedSubnet, vendors — taken from the running
    // API rather than invented; an invented one white-screens the page.
    fetchSetupDevices: stub({
      dtuHost: '10.0.0.213',
      chargerHost: '10.0.0.222',
      suggestedSubnet: '10.0.0',
      vendors: [{ id: 'hoymiles', name: 'Hoymiles DTU' }],
    }),
    fetchMdns: stub({
      hostname: 'solar-dashboard',
      url: 'http://solar-dashboard.local:3001',
      running: true,
      source: 'default',
      address: '10.0.0.140',
      port: 3001,
      error: null,
    }),
    fetchPvoutput: stub({
      enabled: false,
      configured: false,
      systemId: null,
      lastUploadAt: null,
      lastError: null,
      rateRemaining: null,
    }),
    fetchUtilityUsage: stub({ days: 0, firstDate: null, lastDate: null, unmeteredDays: 0, source: null }),
    isDemoMode: () => false,
  };
});

const { SettingsPage } = await import('../src/pages/SettingsPage');

const drawTab = (tab: string) =>
  render(
    <MemoryRouter initialEntries={[`/settings/${tab}`]}>
      <Routes>
        <Route path="/settings/:tab" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('field help', () => {
  it('is reachable, but not printed on the page', async () => {
    // The help still exists and a screen reader reads it; it is not a caption under the field.
    drawTab('rates');
    const help = 'Sets the capacity gauge — nothing reports this automatically.';
    const hint = await screen.findByLabelText(help);
    expect(hint).toBeDefined();
    expect(hint.textContent).toBe('i');
  });

  it('leaves the field labels themselves on the page', async () => {
    drawTab('rates');
    expect(await screen.findByText(/Electricity price/)).toBeDefined();
    expect(screen.getByText(/System size/)).toBeDefined();
  });
});

describe('the measured self-consumption toggle', () => {
  it('offers the measured figure rather than just claiming it can', async () => {
    // The measured share and the days behind it are in the hint.
    drawTab('rates');
    const hint = await screen.findByLabelText(/Your meter puts it at 31%/);
    expect(hint).toBeDefined();
    expect(hint.getAttribute('aria-label')).toContain('7 metered day');
  });
});

describe('tab routing', () => {
  it('sends an unknown tab to the default rather than rendering an empty page', async () => {
    // An unrecognised sub-tab must not draw the tab bar over nothing.
    drawTab('not-a-real-tab');
    await waitFor(() => expect(screen.queryByText(/Electricity price/)).not.toBeNull());
  });

  it('renders the network name card on the hardware tab', async () => {
    drawTab('hardware');
    expect(await screen.findByLabelText('Network name')).toBeDefined();
  });
});
