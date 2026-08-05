/**
 * What an assistant is allowed to ask this dashboard, and how the answer is worded.
 *
 * Every tool here is read-only. The API has plenty of PUT and POST routes — set the
 * tariff, adopt a device, acknowledge an alert, command a smart plug — and none of them
 * are reachable from this file. That is the same line the MQTT integration draws and for
 * the same reason: a model that misreads a question and turns off the pool pump has done
 * something a model that misreads a question and says a wrong number has not. Reading is
 * recoverable. Acting is not.
 *
 * Each tool is a plan plus a renderer, and both halves are pure — `plan` says which URLs
 * to GET, `render` turns the JSON into prose. The fetching lives in server.mjs, so
 * everything that decides what gets said can be tested without a network.
 *
 * The renderers carry three distinctions across, because losing any of them turns a
 * careful figure into a confident wrong one:
 *
 *   - measured vs estimated (device energy, self-consumption)
 *   - realised vs foregone (savings: what you kept, versus a ceiling you did not)
 *   - complete vs part-period (a month you are living in is not a month you can compare)
 *
 * The dashboard already draws all three. An assistant that flattens them is worse than no
 * assistant, because it sounds the same either way.
 */

import {
  UNKNOWN,
  ageMs,
  hertz,
  instant,
  kw,
  kwh,
  kwhDirect,
  lines,
  money,
  num,
  pct,
  volts,
  watts,
} from './format.mjs';

/**
 * Past this, a "current" reading is described as historical rather than live.
 *
 * The default poll is five minutes, so thirty is six missed polls — comfortably beyond a
 * blip and comfortably short of a screen sitting on a frozen number for an afternoon,
 * which is a failure this project has actually shipped.
 */
export const STALE_AFTER_MS = 30 * 60_000;

class ArgumentError extends Error {}

/** A bounded integer argument, refused locally rather than turned into a 400. */
function integerArg(args, name, { min, max, fallback }) {
  const raw = args?.[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ArgumentError(`${name} must be a whole number between ${min} and ${max}`);
  }
  return value;
}

function enumArg(args, name, allowed, fallback) {
  const raw = args?.[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (!allowed.includes(raw)) {
    throw new ArgumentError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return raw;
}

/** A freshness line, or a loud one when the reading is too old to call current. */
function freshness(iso, now, label = 'Reading') {
  const age = ageMs(iso, now);
  if (age === null) return `${label} timestamp: ${UNKNOWN} — treat these figures with suspicion.`;
  if (age > STALE_AFTER_MS) {
    return `${label} taken ${instant(iso, now)} — STALE. Nothing has been recorded since, so this is history, not a live figure. Say so if you report it.`;
  }
  return `${label} taken ${instant(iso, now)}.`;
}

const arr = (value) => (Array.isArray(value) ? value : []);

/** The API's flow identifiers, said the way an owner would say them. */
const FLOW_WORDS = {
  produced: 'everything produced',
  selfConsumed: 'energy used at home',
  exported: 'energy exported to the grid',
  imported: 'energy bought from the grid',
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const currentStatus = {
  name: 'get_current_status',
  title: 'Current solar output',
  description:
    'What the solar array is doing right now: instantaneous power, energy produced so far today, how many inverters are reporting, grid voltage and frequency, and how fresh the reading is. Use this for "how much am I making right now" and for checking whether the system is actually online.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  plan: () => [
    { key: 'summary', path: '/api/summary' },
    // Collector health is context, not the answer — a status route that fails should not
    // suppress a perfectly good power reading.
    { key: 'status', path: '/api/status', optional: true },
  ],
  render: ({ summary, status }, now) => {
    const collector = status?.collector ?? {};
    const rated = summary?.ratedKwConfigured
      ? `${kw(summary?.ratedKw)} (configured by the owner)`
      : `${kw(summary?.ratedKw)} (estimated from panel count — not the owner's figure)`;
    return lines(
      'CURRENT SOLAR OUTPUT',
      `Producing now: ${watts(summary?.currentPowerW)}`,
      `Produced today: ${kwh(summary?.todayEnergyWh)}`,
      `Array size: ${rated}`,
      `Inverters reporting: ${num(summary?.invertersOnline)} of ${num(summary?.invertersTotal)}`,
      `Panels registered by the gateway: ${num(summary?.panelsTotal)}`,
      `Grid: ${volts(summary?.gridVoltage)}, ${hertz(summary?.gridFrequency)}`,
      '',
      freshness(summary?.updatedAt, now),
      collector.consecutiveFailures
        ? `The collector has failed ${num(collector.consecutiveFailures)} polls in a row against ${collector.dtuHost ?? 'its configured gateway'}. The figures above may be the last good ones rather than the present.`
        : null,
      typeof status?.openAlerts === 'number' && status.openAlerts > 0
        ? `${num(status.openAlerts)} alert(s) are open — call get_alerts for what they are.`
        : null,
    );
  },
};

const energyTotals = {
  name: 'get_energy_totals',
  title: 'Energy totals and records',
  description:
    'Lifetime, year, month and today energy production in kWh, CO2 avoided, payback progress, all-time records (best day, best month, peak power, longest producing streak), specific yield in kWh per kWp, and measured panel degradation. Use this for "how much have I generated", "what is my best day", "how is my array performing per kW installed" and "are my panels degrading".',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  plan: () => [
    { key: 'stats', path: '/api/stats' },
    { key: 'records', path: '/api/records' },
    // Degradation is a long game and an install may predate the table entirely.
    { key: 'degradation', path: '/api/analytics/degradation', optional: true },
  ],
  render: ({ stats, records, degradation }) => {
    const best = records?.bestDay;
    const yieldDto = stats?.specificYield;
    const bestMonth = records?.bestMonth;
    const bestWeek = records?.bestWeek;
    const next = records?.nextMwh;
    return lines(
      'ENERGY PRODUCED',
      `Today: ${kwh(stats?.todayWh)}`,
      `This month: ${kwh(stats?.monthWh)}`,
      `This year: ${kwh(stats?.yearWh)}`,
      `Lifetime: ${kwh(stats?.lifetimeWh)} over ${num(records?.daysCollecting)} days of collecting${records?.firstDate ? `, since ${records.firstDate}` : ''}`,
      `Daily average: ${kwh(records?.avgDayWh)}`,
      `CO2 avoided: ${num(stats?.co2SavedKg, 1)} kg (using an approximate national grid intensity, not a measured local one)`,
      stats?.systemCostCad !== null && stats?.systemCostCad !== undefined
        ? `System cost ${money(stats.systemCostCad)}, payback ${pct(stats?.paybackProgressPct, 1)} recovered`
        : 'System cost is not configured, so there is no payback figure.',
      '',
      'RECORDS',
      best ? `Best day: ${kwh(best.wh)} on ${best.date}` : 'Best day: nothing recorded yet',
      bestMonth ? `Best month: ${kwh(bestMonth.wh)} in ${bestMonth.month}` : null,
      bestWeek ? `Best 7-day run: ${kwh(bestWeek.wh)} ending ${bestWeek.endDate}` : null,
      `Peak power: ${watts(records?.peakPowerW)}${records?.peakPowerAt ? ` at ${records.peakPowerAt}` : ''}`,
      `Current producing streak: ${num(records?.producingStreak)} days`,
      records?.todayIsRecord ? 'Today is currently a record day.' : null,
      next ? `Next milestone: ${pct(next.pct, 1)} of the way to ${num(next.targetMwh)} MWh.` : null,
      '',
      'SPECIFIC YIELD — kWh per kWp, the only production figure comparable with another house',
      yieldDto
        ? lines(
            `Against ${kw(yieldDto.ratedKw)} of installed capacity:`,
            `  Today so far: ${num(yieldDto.todayKwhPerKwp, 2)} kWh/kWp (rises until sunset)`,
            `  Last ${num(yieldDto.rollingDays)} whole days: ${num(yieldDto.rollingKwhPerKwp, 2)} kWh/kWp per day`,
            yieldDto.bestDayKwhPerKwp !== null
              ? `  Best day: ${num(yieldDto.bestDayKwhPerKwp, 2)} kWh/kWp on ${yieldDto.bestDayDate}`
              : null,
            'Whether a given figure is good depends on latitude, tilt, azimuth and shading, none of which this system knows. Compare it against this array\'s own history, not against a remembered industry average.',
          )
        : 'Not available: the array size is estimated from panel count rather than configured by the owner, and a yield divided by a guess would read exactly like a measured one. Set the system size in Settings to enable it.',
      degradation
        ? lines(
            '',
            'PANEL DEGRADATION',
            degradation.summary,
            degradation.annualChangePct === null
              ? `${num(degradation.monthsRecorded)} of about ${num(degradation.monthsNeeded)} months recorded. Do not read a trend off the months so far — over a short window the seasonal sun angle dominates, and any slope would be measuring the calendar.`
              : `Measured over ${num(degradation.monthsRecorded)} months of this array's own learned response, not a manufacturer's warranty figure.`,
          )
        : null,
    );
  },
};

const savings = {
  name: 'get_savings',
  title: 'Money saved',
  description:
    'What the array is worth in money for a period, itemised by the rules of the tariff programme in use. Distinguishes what was actually kept from optimistic ceilings, and says when self-consumption is the owner\'s estimate rather than a meter reading. Use this for "how much have I saved" and questions about payback.',
  inputSchema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['today', 'month', 'year', 'lifetime'],
        description: 'Which period to itemise. Defaults to month.',
      },
    },
    additionalProperties: false,
  },
  plan: () => [{ key: 'savings', path: '/api/savings' }],
  args: (args) => ({ period: enumArg(args, 'period', ['today', 'month', 'year', 'lifetime'], 'month') }),
  render: ({ savings: dto }, _now, { period }) => {
    const p = dto?.[period];
    if (!p) return `No savings data for "${period}".`;
    const itemised = arr(p.lines).map(
      (line) =>
        `  - ${line.label}: ${money(line.amount)}${line.realised ? '' : ' — a ceiling; this was not actually kept'}${line.note ? ` (${line.note})` : ''}`,
    );
    const perKwh = arr(dto?.rates?.perKwh);
    const rates = perKwh.map(
      (rate) =>
        `  - ${rate.label}: ${money(rate.ratePerKwh)}/kWh on ${FLOW_WORDS[rate.applies] ?? rate.applies}${rate.realised ? '' : ' (a ceiling, not something earned)'}${rate.timed ? ' [time-limited]' : ''}`,
    );
    /*
      Timed rates on the same flow are alternatives — a kWh earns exactly one of them.
      Adding them up reports a kWh as worth several times what it is, which is the whole
      reason `timed` exists on the rate.
    */
    const timedCaveat = perKwh.some((rate) => rate.timed)
      ? 'Rates marked [time-limited] apply only in certain hours or months, and a given kWh earns exactly one rate per flow — do not add them together.'
      : null;
    const marginal = dto?.rates?.marginal;
    return lines(
      `SAVINGS — ${period.toUpperCase()}, under "${p.programName ?? UNKNOWN}"`,
      `Actually kept: ${money(p.realizedSaved)}   <- this is the honest headline`,
      `Optimistic ceiling (all production at retail): ${money(p.grossValue)}`,
      p.bonusForegone
        ? `Not captured: ${money(p.bonusForegone)} — a ceiling on what more self-consumption could have been worth, not money lost.`
        : null,
      '',
      `Produced: ${kwhDirect(p.producedKwh)}`,
      `Used at home: ${kwhDirect(p.selfConsumedKwh)} (${pct(p.selfConsumptionPct)})${p.selfConsumptionEstimated ? ' — ESTIMATED by the owner, not metered. Do not present it as a measurement.' : ' — metered'}`,
      `Exported: ${kwhDirect(p.exportedKwh)}`,
      itemised.length ? '' : null,
      itemised.length ? 'Itemised:' : null,
      itemised,
      rates.length ? '' : null,
      rates.length ? 'Rates in force:' : null,
      rates,
      dto?.rates?.retailPerKwh !== undefined
        ? `  - retail price paid for grid power: ${money(dto.rates.retailPerKwh)}/kWh`
        : null,
      timedCaveat ? `  ${timedCaveat}` : null,
      marginal
        ? lines(
            '',
            'One more kWh is worth:',
            `  used at home: ${money(marginal.selfConsumedPerKwh)}${marginal.varies ? ` (down to ${money(marginal.selfConsumedLowPerKwh)} depending on when)` : ''}`,
            `  exported:     ${money(marginal.exportedPerKwh)}${marginal.varies ? ` (down to ${money(marginal.exportedLowPerKwh)} depending on when)` : ''}`,
          )
        : null,
      '',
      dto?.systemCostCad !== null && dto?.systemCostCad !== undefined
        ? `System cost ${money(dto.systemCostCad)}; ${pct(dto?.paybackProgressPct, 1)} recovered so far.`
        : 'System cost is not configured, so there is no payback figure.',
      'Amounts are in the currency of the configured tariff (CAD in this deployment).',
    );
  },
};

const productionHistory = {
  name: 'get_production_history',
  title: 'Production over time',
  description:
    'Energy produced per day, per calendar month, or per calendar year, for comparing periods. Part-periods (the month you are living in, or a month the system only partly recorded) are marked, because comparing one against a whole period is the single easiest way to read a false collapse off this data.',
  inputSchema: {
    type: 'object',
    properties: {
      grouping: {
        type: 'string',
        enum: ['day', 'month', 'year'],
        description: 'Totals per day, calendar month, or calendar year. Defaults to day.',
      },
      days: {
        type: 'integer',
        description: 'How many days back to cover. Only applies when grouping is "day". 1-3660, defaults to 30.',
      },
    },
    additionalProperties: false,
  },
  args: (args) => ({
    grouping: enumArg(args, 'grouping', ['day', 'month', 'year'], 'day'),
    days: integerArg(args, 'days', { min: 1, max: 3660, fallback: 30 }),
  }),
  plan: ({ grouping, days }) =>
    grouping === 'day'
      ? [{ key: 'daily', path: `/api/history/energy?days=${days}` }]
      : [{ key: 'grouped', path: `/api/history/production?grouping=${grouping}` }],
  render: (data, _now, { grouping, days }) => {
    if (grouping === 'day') {
      const rows = arr(data.daily);
      if (!rows.length) return `No production recorded in the last ${days} days.`;
      const total = rows.reduce((sum, row) => sum + (row.energyWh ?? 0), 0);
      const best = rows.reduce((a, b) => ((b.energyWh ?? 0) > (a.energyWh ?? 0) ? b : a));
      return lines(
        `DAILY PRODUCTION — last ${days} days, ${rows.length} days with data`,
        `Total ${kwh(total)}, averaging ${kwh(total / rows.length)} per day with data.`,
        `Best in this window: ${kwh(best.energyWh)} on ${best.date}.`,
        '',
        ...rows.map((row) => `${row.date}  ${kwh(row.energyWh)}`),
        '',
        'Today is in progress and will read low until the sun goes down.',
      );
    }
    const buckets = arr(data.grouped?.buckets);
    if (!buckets.length) return 'Nothing recorded yet.';
    return lines(
      `PRODUCTION BY ${grouping.toUpperCase()}`,
      data.grouped?.summary ?? null,
      '',
      ...buckets.map((b) => {
        const caveat = b.complete
          ? ''
          : `  <- PART-PERIOD: ${num(b.daysWithData)} of ${num(b.daysInPeriod)} days recorded. Not comparable with a complete one.`;
        return `${b.label}  ${kwh(b.energyWh)}${caveat}`;
      }),
    );
  },
};

const powerHistory = {
  name: 'get_power_history',
  title: 'Power output through the day',
  description:
    'Instantaneous power output over recent hours, summarised hour by hour rather than sample by sample. Use this for the shape of a day — when production peaked, whether it was cut short, whether there is a midday dip.',
  inputSchema: {
    type: 'object',
    properties: {
      hours: {
        type: 'integer',
        description: 'How many hours back to cover. 1-744, defaults to 24.',
      },
    },
    additionalProperties: false,
  },
  args: (args) => ({ hours: integerArg(args, 'hours', { min: 1, max: 744, fallback: 24 }) }),
  plan: ({ hours }) => [{ key: 'points', path: `/api/history/power?hours=${hours}` }],
  render: ({ points }, _now, { hours }) => {
    const rows = arr(points);
    if (!rows.length) return `No power readings in the last ${hours} hours.`;
    const buckets = new Map();
    let peak = rows[0];
    let imported = 0;
    for (const row of rows) {
      if (row.source === 'cloud') imported += 1;
      if ((row.powerW ?? 0) > (peak.powerW ?? 0)) peak = row;
      const key = String(row.t).slice(0, 13); // YYYY-MM-DDTHH
      const bucket = buckets.get(key) ?? { key, max: 0, sum: 0, n: 0 };
      bucket.max = Math.max(bucket.max, row.powerW ?? 0);
      bucket.sum += row.powerW ?? 0;
      bucket.n += 1;
      buckets.set(key, bucket);
    }
    const ordered = [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
    /*
      No energy total here on purpose. Integrating these samples would give a number that
      looks like the day's production and disagrees with the one the rest of the app
      reports, because the first and last hours of any window are partial and the sample
      spacing is not guaranteed. Two different totals for the same day is worse than one.
    */
    return lines(
      `POWER OUTPUT — last ${hours} hours, ${num(rows.length)} samples`,
      `Peak ${watts(peak.powerW)} at ${peak.t}.`,
      'For energy totals use get_production_history — integrating these samples would produce a second, slightly different figure for the same day.',
      imported
        ? `${num(imported)} of these samples were backfilled from the vendor cloud rather than polled locally.`
        : null,
      '',
      'Hour (start)        peak      average',
      ...ordered.map(
        (b) => `${b.key.replace('T', ' ')}:00   ${watts(b.max).padStart(9)}   ${watts(b.sum / b.n).padStart(9)}`,
      ),
    );
  },
};

const panelHealth = {
  name: 'get_panel_health',
  title: 'Underperforming panels',
  description:
    'Panels producing measurably less than their neighbours, with a diagnosis of whether the pattern looks like shading (a deficit at particular times of day) or an all-day shortfall (which points at the hardware). Reports nothing when nothing is wrong.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: 'Days of history to judge on. 1-90, defaults to 7.' },
    },
    additionalProperties: false,
  },
  args: (args) => ({ days: integerArg(args, 'days', { min: 1, max: 90, fallback: 7 }) }),
  plan: ({ days }) => [{ key: 'insights', path: `/api/analytics/panels?days=${days}` }],
  render: ({ insights }, _now, { days }) => {
    const rows = arr(insights);
    if (!rows.length) {
      return `No panel is underperforming its neighbours over the last ${days} days. That is the expected result — this only reports outliers.`;
    }
    return lines(
      `UNDERPERFORMING PANELS — judged over ${days} days`,
      ...rows.map((row) =>
        lines(
          `${row.panel}: ${pct(row.deficitPct, 1)} below its neighbours, losing about ${kwh(row.lostWhPerDay)} a day`,
          `  Pattern: ${row.pattern === 'shading' ? 'time-of-day deficit, consistent with shading' : 'all-day shortfall, which points at the panel or its connection rather than shade'}`,
          row.diagnosis ? `  ${row.diagnosis}` : null,
        ),
      ),
      '',
      'A deficit is measured against the other panels on this roof, so it survives cloudy weather but not a whole-array problem.',
    );
  },
};

const evCharging = {
  name: 'get_ev_charging',
  title: 'EV charging and vehicle state',
  description:
    'The car: where it is, whether it is driving, charging or parked, its battery level, plus recent home charging sessions and how much of that charging came off the roof rather than the grid. Use this for "is the car charging", "did I charge on solar", "where is the car".',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: 'Days of charging history. 1-366, defaults to 30.' },
    },
    additionalProperties: false,
  },
  args: (args) => ({ days: integerArg(args, 'days', { min: 1, max: 366, fallback: 30 }) }),
  // Both optional: a house with no EV and no wall charger is a normal install, and the
  // renderer already knows how to say "no vehicle data" without inventing one.
  plan: ({ days }) => [
    { key: 'live', path: '/api/charger', optional: true },
    { key: 'sessions', path: `/api/charger/sessions?days=${days}`, optional: true },
  ],
  render: ({ live, sessions }, now, { days }) => {
    const vehicle = live?.vehicle ?? null;
    const charger = live?.live ?? null;
    const totals = sessions?.totals ?? null;
    const recent = arr(sessions?.sessions).slice(-10).reverse();

    const where =
      vehicle?.atHome === null || vehicle?.atHome === undefined
        ? 'unknown — no home location has been set in Settings, so this cannot say whether the car is home'
        : vehicle.atHome
          ? 'at home'
          : 'away from home';
    const doing = vehicle?.motion?.driving
      ? `driving${vehicle.motion.speedKmh !== null && vehicle.motion.speedKmh !== undefined ? ` at ${num(vehicle.motion.speedKmh)} km/h` : ''}${vehicle.motion.since ? `, since ${vehicle.motion.since}` : ''}`
      : vehicle?.charging
        ? `charging, ${kwhDirect(vehicle.charging.energyAddedKwh)} added since ${vehicle.charging.startedAt}`
        : `parked${vehicle?.motion?.since ? ` since ${vehicle.motion.since}` : ''}`;

    return lines(
      'VEHICLE',
      vehicle
        ? lines(
            `${vehicle.name ?? 'Car'} (${vehicle.model ?? UNKNOWN}) is ${doing}, ${where}.`,
            `Battery ${pct(vehicle.batteryLevel)}, range ${num(vehicle.rangeKm)} km, odometer ${num(vehicle.odometerKm)} km.`,
            `Reported state from the vehicle API: ${vehicle.state ?? UNKNOWN}.`,
            freshness(vehicle.lastSeenAt, now, 'Newest position sample'),
          )
        : 'No vehicle data is available — TeslaMate is not configured or not reachable.',
      '',
      'WALL CHARGER',
      charger
        ? lines(
            charger.charging
              ? `Charging now at ${watts(charger.powerW)}; ${kwh(charger.sessionEnergyWh)} this session.`
              : charger.vehicleConnected
                ? 'A vehicle is plugged in but not drawing power.'
                : 'Nothing is plugged in.',
            `Grid at the charger: ${volts(charger.gridVoltage)}, ${hertz(charger.gridFrequency)}. Handle ${num(charger.handleTempC, 1)} degC.`,
            freshness(charger.updatedAt, now),
          )
        : 'No wall charger data is available.',
      '',
      `HOME CHARGING — last ${days} days`,
      totals
        ? `${kwh(totals.energyWh)} delivered, of which ${kwh(totals.solarWh)} (${pct(totals.solarPct)}) overlapped with solar production.`
        : 'No charging sessions recorded.',
      recent.length ? '' : null,
      recent.length ? 'Most recent sessions:' : null,
      ...recent.map(
        (s) => `  ${s.startedAt} to ${s.endedAt}  ${kwh(s.energyWh)}, ${pct(s.solarPct)} solar, peak ${watts(s.peakW)}`,
      ),
      '',
      'The solar share is an overlap between what the charger drew and what the roof made at the same moment. It is not a claim that those electrons went to the car.',
    );
  },
};

const alerts = {
  name: 'get_alerts',
  title: 'Open alerts',
  description:
    'Problems the dashboard has noticed and not yet seen resolved — an inverter that stopped reporting, a source gone silent, production far below what the weather predicts. Also lists recently closed ones. Use this for "is anything wrong".',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  plan: () => [{ key: 'alerts', path: '/api/alerts' }],
  render: ({ alerts: dto }, now) => {
    const active = arr(dto?.active);
    const closed = arr(dto?.recentlyClosed).slice(0, 5);
    if (!active.length) {
      return lines(
        'No alerts are open. Nothing the dashboard watches for is currently wrong.',
        closed.length ? '' : null,
        closed.length ? 'Recently resolved:' : null,
        ...closed.map((a) => `  ${a.severity}: ${a.message} (closed ${instant(a.closedAt, now)})`),
      );
    }
    return lines(
      `${num(active.length)} OPEN ALERT(S)`,
      ...active.map((a) =>
        `  [${a.severity}] ${a.message}\n    type ${a.type}, subject ${a.subjectKey}, open since ${instant(a.openedAt, now)}${a.ackedAt ? ', acknowledged' : ', not acknowledged'}`,
      ),
      closed.length ? '' : null,
      closed.length ? 'Recently resolved:' : null,
      ...closed.map((a) => `  ${a.severity}: ${a.message} (closed ${instant(a.closedAt, now)})`),
      '',
      'Acknowledging an alert is a change, so it is not available here — do it in the dashboard.',
    );
  },
};

const deviceUsage = {
  name: 'get_device_usage',
  title: 'What the house is using',
  description:
    'Energy used by monitored devices and circuits — smart plugs, energy meters, thermostats — over a window, with per-circuit breakdown where a meter has channels. States clearly which figures are measured and which are inferred from run time against a rated wattage, since only the first kind can be trusted to the digit.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: 'Window in days. 1-90, defaults to 7.' },
    },
    additionalProperties: false,
  },
  args: (args) => ({ days: integerArg(args, 'days', { min: 1, max: 90, fallback: 7 }) }),
  plan: ({ days }) => [{ key: 'usage', path: `/api/devices/usage?days=${days}` }],
  render: ({ usage }, _now, { days }) => {
    const rows = arr(usage);
    if (!rows.length) return `No monitored devices reported anything over the last ${days} days.`;
    /*
      Three categories, not two. An earlier version said "N of M are metered, the rest are
      inferred", which on this install printed "0 of 3 are metered, the rest are inferred"
      above three devices whose energy read "unknown" — describing an absence as an
      estimate. A device that reports nothing has not estimated anything.
    */
    const has = (row) => typeof row.energyKwh === 'number' && Number.isFinite(row.energyKwh);
    const measured = rows.filter((r) => has(r) && r.metered && !r.estimated);
    const estimated = rows.filter((r) => has(r) && r.estimated);
    const silent = rows.filter((r) => !has(r));
    return lines(
      `DEVICE USAGE — last ${days} days`,
      ...rows.map((row) =>
        lines(
          `${row.name}${row.loadLabel ? ` (${row.loadLabel})` : ''} — ${row.kind}`,
          `  Energy: ${kwhDirect(row.energyKwh, 2)}${
            row.estimated
              ? ` — ESTIMATED from ${num(row.onHoursPerDay, 1)} h/day of run time against a rated wattage, confidence "${row.confidence ?? 'unstated'}". Not a measurement.`
              : row.metered
                ? ' — measured'
                : ''
          }`,
          row.returnedKwh
            ? `  Sent back to the grid: ${kwhDirect(row.returnedKwh, 2)} (kept separate from consumption, never netted against it)`
            : null,
          row.heatingHours !== undefined ? `  Called for heat: ${num(row.heatingHours, 1)} h` : null,
          ...arr(row.channels).map(
            (c) =>
              `    circuit ${c.channel} "${c.label}": ${kwhDirect(c.energyKwh, 2)}, ${pct(c.sharePct)} of this device${c.voltageMultiplier ? ` (reading corrected by x${c.voltageMultiplier})` : ''}`,
          ),
          ...arr(row.observations).map((o) => `  Note: ${o}`),
        ),
      ),
      '',
      `Of ${num(rows.length)} monitored device(s): ${num(measured.length)} measured, ${num(estimated.length)} estimated from run time, ${num(silent.length)} reporting no energy figure at all.`,
      silent.length
        ? 'A device with no figure has not estimated anything — it simply cannot be counted. Do not treat it as zero.'
        : null,
      'This covers monitored devices only. It is not whole-home consumption — nothing here measures the mains.',
    );
  },
};

export const TOOLS = [
  currentStatus,
  energyTotals,
  savings,
  productionHistory,
  powerHistory,
  panelHealth,
  evCharging,
  alerts,
  deviceUsage,
];

/** The catalogue as the protocol wants it — no plan, no renderer, no functions. */
export function describeTools() {
  return TOOLS.map(({ name, title, description, inputSchema }) => ({
    name,
    title,
    description,
    inputSchema,
  }));
}

export function findTool(name) {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}

export { ArgumentError };
