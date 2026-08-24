import { Census, CensusFinding } from './array-census';

/**
 * A shareable account of what this install looks like, what the app concluded, and how.
 *
 * Meant to survive leaving the machine — an installer, a forum thread, a GitHub issue,
 * or the next person trying to work out whether their array adds up. So the governing
 * constraint is that it must be safe to paste in public.
 *
 * THE RULE THAT MAKES THAT TRUE: everything here is built by naming fields one at a
 * time. Nothing walks the settings table, nothing spreads an object, nothing serialises
 * a config. A redaction list would be a promise that quietly breaks the first time
 * somebody adds a setting called `apiKey` — an allowlist cannot leak a field nobody
 * added to it, which is the only version of this that stays true without supervision.
 *
 * The report also says what it left out, so a reader can tell it has been redacted and
 * an owner can check the claim rather than trust it.
 */

export interface ReportInput {
  version: string;
  generatedAt: string;
  /**
   * The offset, not the zone name.
   *
   * "America/Toronto" would name a city, and this report
   * promises no location. What actually matters for reproducing a daily-bucketing bug is
   * how far from UTC the day boundary sits and whether it moves twice a year — both of
   * which survive dropping the name.
   */
  utcOffsetMinutes: number;
  observesDst: boolean;
  solarVendorName: string | null;
  chargerVendorName: string | null;
  vehicleSourceName: string | null;
  pollIntervalMs: number | null;
  census: Census;
  /** Ports per inverter, sorted, so the shape shows without naming any unit. */
  portsPerInverter: number[];
  production: {
    daysObserved: number;
    lifetimeKwh: number;
    bestDayKwh: number | null;
    peakPowerW: number | null;
    peakPerPanelW: number | null;
    firstDate: string | null;
    lastDate: string | null;
  };
  /**
   * Smart devices found on the network, grouped so no single unit is identifiable.
   *
   * Deliberately vendor and kind only. The device table holds an IP, a MAC address, a
   * user-chosen name and a room for every one of them — four kinds of identifying data
   * in one row — so this reports how many of what, and what they can measure, and
   * nothing else.
   */
  devices: Array<{
    vendor: string;
    kind: string;
    count: number;
    /** Whether any of them actually report watts, as opposed to on/off or temperature. */
    metersPower: boolean;
    readings: number;
  }>;
  /**
   * Whether this process can hear the network it is scanning.
   *
   * A boolean, not the explanation. The version of this shown in the UI names the
   * container subnet and the gateway address, which is genuinely the most useful phrasing
   * on your own screen and exactly what this report promises not to carry — the test for
   * "no IP addresses" caught it being passed through. The sentence below is written here
   * instead, from the flag, so the redaction decision stays in the file that made the
   * promise.
   */
  discovery: { onDeviceSubnet: boolean };
  alerts: Array<{ type: string; open: number; closedEver: number }>;
  collectionGaps: Array<{ startedAt: string; minutes: number }>;
  tariff: {
    programName: string;
    /** A ratio, not a price: what a self-consumed kWh is worth against an exported one. */
    selfConsumptionPremium: number | null;
    priceIncludesTax: boolean;
    selfConsumptionPct: number | null;
    selfConsumptionEstimated: boolean;
  };
}

/**
 * What is deliberately absent, stated in the report itself.
 *
 * Listed rather than merely omitted because a reader cannot tell the difference between
 * "this install has no location" and "the location was removed", and the person deciding
 * whether to paste this into a public thread needs to know which.
 */
export const EXCLUDED_FROM_REPORT = [
  'Street address, site name, latitude, longitude and time-zone name',
  'IP addresses, hostnames and network ranges',
  'Inverter and panel serial numbers (replaced by position numbers)',
  'Credentials of every kind — API tokens, cloud keys, OAuth clients, webhook targets',
  'Backup destinations, bucket names and file paths',
  'System cost, bills and any dollar figure',
  'Vehicle names, odometer readings and trip history',
];

/** "UTC-03:00" — enough to reason about day boundaries, not enough to place anyone. */
function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function line(label: string, value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? '' : `- **${label}:** ${value}\n`;
}

/** How each finding was reached, so a reader can disagree with the method, not just the number. */
function methodFor(finding: CensusFinding): string {
  switch (finding.id) {
    case 'nameplate-vs-panel-count':
      return 'A panel’s best recorded output is divided by 0.78 — roughly what a panel reaches against its own rating in a temperate climate — and snapped to a 25 W size. The configured array size divided by that gives an expected panel count, compared against what the gateway has registered. Needs at least five days of data before it will size anything.';
    case 'panels-unregistered':
      return 'The owner’s stated panel count against the gateway’s registered count. This is the only check that can see panels the gateway was never told about; nothing in the telemetry can, because their output is absent from its totals rather than hidden in them.';
    case 'panels-silent':
      return 'Panels the gateway counts, against panels appearing in its per-panel data.';
    case 'inverters-silent':
      return 'Inverters the gateway says are registered, against inverters returning per-unit data.';
    case 'inverter-port-shape':
      return 'Each inverter’s port count against the fleet median. A unit carrying fewer panels than its identical siblings is either a different model or missing wiring.';
    case 'peak-below-nameplate':
      return 'Best instantaneous output ever recorded against the configured array size. Arrays usually reach 75–85% of nameplate; shading and orientation can explain a shortfall, so this is reported as context rather than a fault.';
    default:
      return 'See array-census.ts for the rule behind this finding.';
  }
}

export function buildReportMarkdown(input: ReportInput): string {
  const { census, production, tariff } = input;
  const out: string[] = [];

  out.push('# Solar Dashboard — install report\n');
  out.push(
    '_Generated by the dashboard itself. Safe to share: it contains no location, no addresses, no serial numbers and no credentials — see “What this leaves out” at the end._\n',
  );

  out.push('\n## The install\n');
  out.push(line('App version', input.version));
  out.push(line('Generated', input.generatedAt));
  out.push(line('UTC offset', `${offsetLabel(input.utcOffsetMinutes)}${input.observesDst ? ', daylight saving observed' : ''}`));
  out.push(line('Solar gateway', input.solarVendorName ?? 'not configured'));
  out.push(line('EV charger', input.chargerVendorName ?? 'none'));
  out.push(line('Vehicle logger', input.vehicleSourceName ?? 'none'));
  out.push(
    line('Poll interval', input.pollIntervalMs ? `${Math.round(input.pollIntervalMs / 1000)} s` : null),
  );

  out.push('\n## The array, as each source describes it\n');
  out.push('| Source | Panels | Rated |\n|---|---|---|\n');
  for (const claim of census.claims) {
    if (claim.panels === null && claim.ratedKw === null) continue;
    out.push(`| ${claim.source} | ${claim.panels ?? '—'} | ${claim.ratedKw ?? '—'} |\n`);
  }
  if (input.portsPerInverter.length) {
    out.push(
      `\nPanels per inverter, sorted: ${input.portsPerInverter.join(', ')} (${input.portsPerInverter.length} inverters reporting)\n`,
    );
  }
  if (census.believedRatedKw) {
    out.push(`\nBest available answer: **${census.believedRatedKw} kW**, from ${census.believedFrom}.\n`);
  }

  out.push('\n## What the app found\n');
  if (!census.findings.length) {
    out.push('\nNothing — every source agrees.\n');
  }
  for (const finding of census.findings) {
    out.push(`\n### ${finding.headline}\n`);
    out.push(`\n**Severity:** ${finding.severity}\n`);
    out.push(`\n${finding.detail}\n`);
    out.push(`\n**How this was worked out:** ${methodFor(finding)}\n`);
  }

  out.push('\n## Production\n');
  out.push(line('Days of data', production.daysObserved));
  out.push(line('First / last day', production.firstDate ? `${production.firstDate} → ${production.lastDate}` : null));
  out.push(line('Lifetime', `${production.lifetimeKwh.toFixed(1)} kWh`));
  out.push(line('Best day', production.bestDayKwh ? `${production.bestDayKwh.toFixed(1)} kWh` : null));
  out.push(line('Peak output', production.peakPowerW ? `${(production.peakPowerW / 1000).toFixed(2)} kW` : null));
  out.push(
    line('Best single panel', production.peakPerPanelW ? `${Math.round(production.peakPerPanelW)} W` : null),
  );

  out.push('\n## How it is valued\n');
  out.push(line('Tariff', tariff.programName));
  out.push(line('Configured price is', tariff.priceIncludesTax ? 'tax-inclusive' : 'pre-tax'));
  out.push(
    line(
      'Self-consumption premium',
      tariff.selfConsumptionPremium !== null
        ? `${(tariff.selfConsumptionPremium * 100).toFixed(1)}% more than exporting`
        : null,
    ),
  );
  out.push(
    line(
      'Self-consumption share',
      tariff.selfConsumptionPct !== null
        ? `${tariff.selfConsumptionPct}%${tariff.selfConsumptionEstimated ? ' (owner’s estimate, not measured)' : ' (measured)'}`
        : 'measured only',
    ),
  );
  out.push('\n_No prices or dollar figures are included; the premium above is a ratio._\n');

  out.push('\n## Smart devices found\n');
  if (!input.devices.length) {
    out.push('\nNone.\n');
  } else {
    out.push('\n| Vendor | Kind | How many | Reports watts | Readings |\n|---|---|---|---|---|\n');
    for (const device of input.devices) {
      out.push(
        `| ${device.vendor} | ${device.kind} | ${device.count} | ${device.metersPower ? 'yes' : 'no'} | ${device.readings} |\n`,
      );
    }
    /*
      The link between this section and the tariff one, stated rather than left for the
      reader to spot. "Why is my self-consumption an estimate?" is answered here: nothing
      in the house is metering, so nothing can be counted.
    */
    const metering = input.devices.filter((device) => device.metersPower);
    out.push(
      metering.length
        ? `\n${metering.map((d) => `${d.count} ${d.vendor} ${d.kind}`).join(', ')} report power, so their consumption can be counted directly.\n`
        : '\nNone of these report watts — they report on/off state, temperature or setpoint. That is why self-consumption above is an estimate rather than a measurement: a switch that cannot meter tells you a load ran, not how much it drew.\n',
    );
  }

  if (!input.discovery.onDeviceSubnet) {
    /*
      Worth its own heading because it changes how the section above should be read: an
      empty device list produced by a process that cannot hear announcements is not
      evidence of an empty house.
    */
    out.push('\n### Some devices cannot be found from here\n');
    out.push(
      '\nThis app is running on a container network, and the equipment is on the house network. ' +
        'Scans that probe addresses directly still work, because they are routed. Scans that listen ' +
        'for announcements — Tuya plugs, mDNS, HomeKit — cannot, because those are broadcast only to ' +
        'the local link and a Docker bridge does not carry them. Devices found that way will be ' +
        'missing from the list above with no error to show for it. Running the app directly on the ' +
        'host, or with host networking, is what makes them visible.\n',
    );
  }

  out.push('\n## Health\n');
  if (input.alerts.length) {
    out.push('\n| Alert | Open now | Raised ever |\n|---|---|---|\n');
    for (const alert of input.alerts) {
      out.push(`| ${alert.type} | ${alert.open} | ${alert.closedEver + alert.open} |\n`);
    }
  } else {
    out.push('\nNo alerts have ever been raised.\n');
  }
  if (input.collectionGaps.length) {
    out.push(
      `\nCollection gaps over 15 minutes: ${input.collectionGaps.length}. Longest ${Math.max(...input.collectionGaps.map((g) => g.minutes))} min.\n`,
    );
    out.push(
      '\nA gap is the dashboard not polling, not the array not producing — a sleeping host, a reboot or a network drop. The gateway’s own daily counter is cumulative, so energy totals survive a gap; only the power history has a hole.\n',
    );
  }

  out.push('\n## What this leaves out\n\n');
  for (const item of EXCLUDED_FROM_REPORT) out.push(`- ${item}\n`);
  out.push(
    '\nThe report is assembled by naming each field it includes, rather than by copying data and removing the sensitive parts. A field nobody added to it cannot appear in it.\n',
  );

  return out.join('');
}
