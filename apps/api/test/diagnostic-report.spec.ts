import { describe, expect, it } from 'vitest';
import { EXCLUDED_FROM_REPORT, ReportInput, buildReportMarkdown } from '../src/system/diagnostic-report';
import { buildCensus } from '../src/system/array-census';

/**
 * Everything the report must never contain, in the shapes a real install holds it.
 *
 * The point of the test below is not that these particular strings are absent — it is
 * that the builder has no way to reach them. It takes a named input for each field it
 * prints, so there is no path from the settings table into the output at all.
 *
 * The values are synthetic on purpose. They used to be this developer's own: a street
 * address, coordinates to four decimal places, an email, real hardware serials. A test
 * that proves a report cannot leak an address is not worth publishing an address for,
 * and the assertions below care about shape, never about whose data it is.
 */
const SECRETS = [
  '10.0.0.213',
  '10.0.0.222',
  '1 Example Street',
  'Springfield',
  '45.1234',
  '-63.5678',
  '10000000000003',
  'AABBCCDDEEFF',
  'my-solar-a1b2c3',
  'AKIASTORED',
  'testsecret123',
  'solar-backups',
  's3.us-west-002.backblazeb2.com',
  '/backups',
  '1234567890-abc.apps.googleusercontent.com',
  '84000',
  '0.1539',
  'owner@example.com',
  'Garage lights',
  '10.0.0.244',
  '0C:80:63:E6:2C:2F',
  'Mysa (006da0)',
  'BD:F0:3E:69:B2:7D',
];
const census = buildCensus({
  configuredRatedKw: 23,
  registeredPanels: 42,
  reportingPanels: 38,
  expectedInverters: 12,
  reportingInverters: 11,
  portsPerInverter: [4, 4, 4, 4, 4, 4, 4, 4, 4, 1, 1],
  contract: { panels: 46, wattsPerPanel: 500 },
  observedPeakW: 14142,
  observedPeakPerPanelW: 387,
  daysObserved: 30,
});

const input: ReportInput = {
  version: '0.1.0',
  generatedAt: '2026-07-29T13:00:00.000Z',
  utcOffsetMinutes: -180,
  observesDst: true,
  solarVendorName: 'Hoymiles DTU (local protobuf, port 10081)',
  chargerVendorName: 'Tesla Wall Connector (Gen 3)',
  vehicleSourceName: 'TeslaMate',
  pollIntervalMs: 300_000,
  census,
  portsPerInverter: [1, 1, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  production: {
    daysObserved: 30,
    lifetimeKwh: 582.1,
    bestDayKwh: 109.9,
    peakPowerW: 14142,
    peakPerPanelW: 387,
    firstDate: '2026-06-29',
    lastDate: '2026-07-29',
  },
  devices: [
    { vendor: 'kasa', kind: 'switch', count: 1, metersPower: false, readings: 392 },
    { vendor: 'mysa', kind: 'thermostat', count: 2, metersPower: false, readings: 762 },
  ],
  discovery: { onDeviceSubnet: false },
  alerts: [{ type: 'inverter_silent', open: 1, closedEver: 3 }],
  collectionGaps: [{ startedAt: '2026-07-29T05:17:00.000Z', minutes: 312 }],
  tariff: {
    programName: 'Net metering (1:1, tax on buyback)',
    selfConsumptionPremium: 0.15,
    priceIncludesTax: false,
    selfConsumptionPct: 65,
    selfConsumptionEstimated: true,
  },
};

describe('the report keeps its promise', () => {
  const markdown = buildReportMarkdown(input);

  it('contains none of the things an owner would not want pasted in public', () => {
    for (const secret of SECRETS) {
      expect(markdown, `leaked: ${secret}`).not.toContain(secret);
    }
  });

  it('names no serial number, even the ones its own findings are about', () => {
    /*
      The census speaks in counts rather than identities on purpose. A finding that said
      "inverter 10000000000003 is quiet" would be more useful and less shareable, and
      shareable is what this report is for.
    */
    expect(markdown).not.toMatch(/\b\d{14}\b/);
    expect(markdown).not.toMatch(/\b[0-9A-F]{12}\b/);
  });

  it('carries no dollar figure', () => {
    // The self-consumption premium is a ratio precisely so the tariff can be discussed
    // without publishing what someone pays or what their roof cost.
    expect(markdown).not.toMatch(/\$\s?\d/);
  });

  it('gives the UTC offset without naming the place', () => {
    // A zone name is a city. An offset is a third of the planet.
    expect(markdown).toContain('UTC-03:00');
    expect(markdown).not.toMatch(/America\//);
  });

  it('names no device, and no MAC address', () => {
    /*
      Every device row carries an IP, a MAC, a user-chosen name and a room. Reporting
      "1 kasa switch" keeps what is diagnostic and drops all four.
    */
    expect(markdown).not.toMatch(/[0-9A-F]{2}(:[0-9A-F]{2}){5}/i);
    expect(markdown).toContain('| kasa | switch | 1 |');
    expect(markdown).toContain('| mysa | thermostat | 2 |');
  });

  it('explains that devices which cannot meter are why self-consumption is a guess', () => {
    expect(markdown).toContain('None of these report watts');
    expect(markdown).toContain('tells you a load ran, not how much it drew');
  });

  it('carries no IP address', () => {
    expect(markdown).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it('says what it left out, so the redaction can be checked rather than trusted', () => {
    for (const item of EXCLUDED_FROM_REPORT) {
      expect(markdown).toContain(item);
    }
  });
});

describe('the report is worth sharing', () => {
  const markdown = buildReportMarkdown(input);

  it('states the findings', () => {
    expect(markdown).toContain('4 panels your gateway has never seen');
    expect(markdown).toContain('23 kW needs 46 panels; your gateway has 42');
  });

  it('states how each one was reached, not just what it concluded', () => {
    // The whole value of sending this to an installer: they can argue with the method.
    expect(markdown).toContain('How this was worked out');
    expect(markdown).toContain('divided by 0.78');
  });

  it('shows the array shape without identifying any unit', () => {
    expect(markdown).toContain('1, 1, 4, 4, 4, 4, 4, 4, 4, 4, 4');
  });

  it('marks an estimated figure as estimated', () => {
    expect(markdown).toContain('owner’s estimate, not measured');
  });

  it('warns when the process cannot hear the network it is scanning', () => {
    // Without this, an empty device list reads as "you have no such devices" when it
    // actually means "this process cannot hear them announce themselves".
    expect(markdown).toContain('Some devices cannot be found from here');
    expect(markdown).toContain('container network');
    // And without naming either network, which the IP test above also guards.
    expect(markdown).not.toContain('10.0.0');
  });

  it('says nothing about reach when the app is on the right network', () => {
    const fine = buildReportMarkdown({
      ...input,
      discovery: { onDeviceSubnet: true },
    });
    expect(fine).not.toContain('cannot be found from here');
  });

  it('explains that a collection gap is not lost generation', () => {
    expect(markdown).toContain('not the array not producing');
  });

  it('handles an install where nothing is configured and nothing is wrong', () => {
    const bare = buildReportMarkdown({
      ...input,
      solarVendorName: null,
      chargerVendorName: null,
      vehicleSourceName: null,
      pollIntervalMs: null,
      alerts: [],
      collectionGaps: [],
      devices: [],
      discovery: { onDeviceSubnet: true },
      census: buildCensus({
        configuredRatedKw: 20,
        registeredPanels: 40,
        reportingPanels: 40,
        expectedInverters: 10,
        reportingInverters: 10,
        portsPerInverter: Array(10).fill(4),
        contract: { panels: 40, wattsPerPanel: 500 },
        observedPeakW: 16000,
        observedPeakPerPanelW: 390,
        daysObserved: 30,
      }),
    });
    expect(bare).toContain('Nothing — every source agrees.');
    expect(bare).toContain('No alerts have ever been raised.');
    expect(bare).toContain('none');
  });
});
