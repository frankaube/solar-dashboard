import { describe, expect, it } from 'vitest';
import { describeTools, findTool } from '../src/tools.mjs';

/*
  These test the wording, not the plumbing, because the wording is the product. A renderer
  that quietly drops "estimated" or "part-period" produces text that reads exactly like the
  measured version and is wrong in a way nobody downstream can detect.
*/

const NOW = Date.parse('2026-08-04T12:00:00Z');
const render = (name, data, args) => {
  const tool = findTool(name);
  return tool.render(data, NOW, tool.args ? tool.args(args ?? {}) : {});
};

describe('the catalogue', () => {
  it('exposes no tool that changes anything', () => {
    /*
      The line this server draws. The API has PUT and POST routes for tariffs, devices,
      alert acknowledgement and plug control; none of them are reachable from here.
    */
    for (const tool of describeTools()) {
      expect(tool.name).toMatch(/^get_/);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it('plans only paths under /api', () => {
    for (const { name } of describeTools()) {
      const tool = findTool(name);
      for (const spec of tool.plan(tool.args ? tool.args({}) : {})) {
        expect(spec.path, name).toMatch(/^\/api\//);
      }
    }
  });
});

describe('get_current_status', () => {
  const summary = {
    updatedAt: '2026-08-04T11:59:19Z',
    currentPowerW: 4180,
    todayEnergyWh: 21_400,
    gridVoltage: 243.05,
    gridFrequency: 60.01,
    invertersOnline: 9,
    invertersTotal: 10,
    ratedKw: 8.4,
    ratedKwConfigured: true,
    panelsTotal: 42,
  };

  it('reports the reading with its units and its age', () => {
    const text = render('get_current_status', { summary, status: { collector: {}, openAlerts: 0 } });
    expect(text).toContain('Producing now: 4,180 W');
    expect(text).toContain('Produced today: 21.4 kWh');
    expect(text).toContain('9 of 10');
    expect(text).toContain('41 s ago');
  });

  it('calls a stale reading stale', () => {
    /*
      The failure this project has actually shipped: a source went offline and three days
      of frozen figures sat on screen looking like a quiet week. An assistant repeating
      them without the caveat is the same bug with a friendlier voice.
    */
    const text = render('get_current_status', {
      summary: { ...summary, updatedAt: '2026-08-04T08:00:00Z' },
      status: { collector: {} },
    });
    expect(text).toContain('STALE');
    expect(text).toContain('history, not a live figure');
  });

  it('says when the array size is an estimate rather than the owner\'s figure', () => {
    const text = render('get_current_status', {
      summary: { ...summary, ratedKwConfigured: false },
      status: {},
    });
    expect(text).toContain("estimated from panel count — not the owner's figure");
  });

  it('surfaces a collector that is failing', () => {
    const text = render('get_current_status', {
      summary,
      status: { collector: { consecutiveFailures: 7, dtuHost: '10.0.0.50' } },
    });
    expect(text).toContain('failed 7 polls in a row');
  });

  it('renders without the optional status call', () => {
    expect(render('get_current_status', { summary })).toContain('4,180 W');
  });
});

describe('get_energy_totals', () => {
  const stats = { todayWh: 8_900, monthWh: 195_700, yearWh: 921_100, lifetimeWh: 921_100, co2SavedKg: 267.1, systemCostCad: null, paybackProgressPct: null };
  const records = { daysCollecting: 13, firstDate: '2026-07-23', avgDayWh: 70_900, bestDay: { date: '2026-08-03', wh: 109_900 }, peakPowerW: 14_842, producingStreak: 13 };

  it('reports specific yield against the configured capacity', () => {
    const text = render('get_energy_totals', {
      stats: { ...stats, specificYield: { ratedKw: 23, todayKwhPerKwp: 0.39, rollingKwhPerKwp: 3.08, rollingDays: 12, bestDayKwhPerKwp: 4.78, bestDayDate: '2026-08-03' } },
      records,
    });
    expect(text).toContain('4.78 kWh/kWp on 2026-08-03');
    expect(text).toContain('23.0 kW of installed capacity');
  });

  it('will not grade the yield against a remembered industry average', () => {
    /*
      Whether 4.78 is good depends on latitude, tilt, azimuth and shading. Comparing an
      array against its own history is honest; comparing it against a number the model
      half-remembers is the more confident-sounding of the two and the wrong one.
    */
    const text = render('get_energy_totals', {
      stats: { ...stats, specificYield: { ratedKw: 23, todayKwhPerKwp: 0.39, rollingKwhPerKwp: 3.08, rollingDays: 12, bestDayKwhPerKwp: 4.78, bestDayDate: '2026-08-03' } },
      records,
    });
    expect(text).toContain("this array's own history");
  });

  it('says why the yield is missing rather than omitting it', () => {
    // Silence would read as "this array has no yield" instead of "the divisor is a guess".
    const text = render('get_energy_totals', { stats: { ...stats, specificYield: null }, records });
    expect(text).toContain('estimated from panel count');
    expect(text).toContain('Set the system size in Settings');
  });

  it('tells the model not to read a trend off too few months', () => {
    const text = render('get_energy_totals', {
      stats: { ...stats, specificYield: null },
      records,
      degradation: { monthsRecorded: 1, monthsNeeded: 24, annualChangePct: null, summary: '1 month of record.', snapshots: [] },
    });
    expect(text).toContain('Do not read a trend');
    expect(text).toContain('measuring the calendar');
  });

  it('reports a measured rate once there is one', () => {
    const text = render('get_energy_totals', {
      stats: { ...stats, specificYield: null },
      records,
      degradation: { monthsRecorded: 26, monthsNeeded: 24, annualChangePct: -0.46, summary: 'Over 26 months of record, this array is losing about 0.46% of its output per year.', snapshots: [] },
    });
    expect(text).toContain('losing about 0.46%');
    expect(text).toContain("not a manufacturer's warranty figure");
  });

  it('renders without the degradation call at all', () => {
    expect(render('get_energy_totals', { stats: { ...stats, specificYield: null }, records })).toContain('ENERGY PRODUCED');
  });
});

describe('get_savings', () => {
  const dto = {
    rates: {
      retailPerKwh: 0.1483,
      hstRate: 0.15,
      perKwh: [
        { ruleId: 'export', label: 'Export credits', ratePerKwh: 0.1483, applies: 'exported', realised: true, timed: false },
        { ruleId: 'foregone', label: 'Not realised', ratePerKwh: 0.0223, applies: 'exported', realised: false, timed: false },
      ],
      marginal: { selfConsumedPerKwh: 0.1706, exportedPerKwh: 0.1483, selfConsumedLowPerKwh: 0.1706, exportedLowPerKwh: 0.1483, varies: false },
    },
    month: {
      producedKwh: 640.2,
      selfConsumedKwh: 192.1,
      exportedKwh: 448.1,
      grossValue: 94.94,
      realizedSaved: 66.45,
      bonusForegone: 9.97,
      selfConsumptionPct: 30,
      selfConsumptionEstimated: true,
      programName: 'NB Power net metering',
      lines: [
        { id: 'self', label: 'Used at home instead of buying', amount: 32.76, realised: true },
        { id: 'tax', label: 'Sales tax not paid on buyback', amount: 9.97, realised: false, note: 'a ceiling, not a loss' },
      ],
    },
    systemCostCad: 18_500,
    paybackProgressPct: 12.4,
  };

  it('leads with what was kept, not the optimistic ceiling', () => {
    const text = render('get_savings', { savings: dto }, { period: 'month' });
    expect(text).toContain('Actually kept: $66.45');
    expect(text).toContain('honest headline');
    expect(text).toContain('Optimistic ceiling');
  });

  it('marks an unrealised line as a ceiling', () => {
    const text = render('get_savings', { savings: dto }, { period: 'month' });
    expect(text).toContain('a ceiling; this was not actually kept');
    expect(text).toContain('a ceiling, not a loss');
  });

  it('prints the per-kWh rates with their real values, and names the flow in words', () => {
    // `applies` is an identifier — "selfConsumed" reaching prose is a leaked field name.
    const text = render('get_savings', { savings: dto }, { period: 'month' });
    expect(text).toContain('Export credits: $0.15/kWh on energy exported to the grid');
    expect(text).not.toContain('unknown/kWh');
    expect(text).not.toContain('selfConsumed');
  });

  it('answers the question owners actually ask — use it or export it', () => {
    const text = render('get_savings', { savings: dto }, { period: 'month' });
    expect(text).toContain('One more kWh is worth:');
    expect(text).toContain('used at home: $0.17');
    expect(text).toContain('exported:     $0.15');
  });

  it('warns that time-of-use rates are alternatives, not a sum', () => {
    /*
      Timed rates on one flow are mutually exclusive — a kWh earns exactly one. Adding a
      set of time-of-use windows together reports a kWh as worth several times what it is.
    */
    const tou = {
      ...dto,
      rates: {
        ...dto.rates,
        perKwh: [
          { ruleId: 'peak', label: 'Peak export', ratePerKwh: 0.22, applies: 'exported', realised: true, timed: true },
          { ruleId: 'off', label: 'Off-peak export', ratePerKwh: 0.08, applies: 'exported', realised: true, timed: true },
        ],
      },
    };
    const text = render('get_savings', { savings: tou }, { period: 'month' });
    expect(text).toContain('[time-limited]');
    expect(text).toContain('do not add them together');
  });

  it('says when self-consumption is an estimate rather than a meter reading', () => {
    /*
      An estimate and a measurement printed in the same typeface cannot be told apart
      later. The distinction has to survive into the sentence.
    */
    const text = render('get_savings', { savings: dto }, { period: 'month' });
    expect(text).toContain('ESTIMATED by the owner, not metered');
  });

  it('says so plainly when self-consumption is metered', () => {
    const metered = { ...dto, month: { ...dto.month, selfConsumptionEstimated: false } };
    expect(render('get_savings', { savings: metered }, { period: 'month' })).toContain('— metered');
  });

  it('refuses an unknown period rather than defaulting quietly', () => {
    expect(() => findTool('get_savings').args({ period: 'decade' })).toThrow(/one of/);
  });
});

describe('get_production_history', () => {
  it('flags a part-period so it is not compared with a whole one', () => {
    /*
      The single easiest way to read a false collapse off this data: August has four days
      in it and July has thirty-one, drawn as plain bars side by side.
    */
    const text = render(
      'get_production_history',
      {
        grouped: {
          grouping: 'month',
          summary: 'One complete month, and 1 part-period shown lighter.',
          buckets: [
            { key: '2026-07', label: 'Jul 2026', energyWh: 620_000, daysWithData: 31, daysInPeriod: 31, complete: true },
            { key: '2026-08', label: 'Aug 2026', energyWh: 82_000, daysWithData: 4, daysInPeriod: 31, complete: false },
          ],
        },
      },
      { grouping: 'month' },
    );
    expect(text).toContain('Jul 2026  620.0 kWh');
    expect(text).toContain('PART-PERIOD: 4 of 31 days recorded');
    expect(text).toContain('Not comparable');
  });

  it('warns that today is still in progress on the daily view', () => {
    const text = render(
      'get_production_history',
      { daily: [{ date: '2026-08-03', energyWh: 24_100 }, { date: '2026-08-04', energyWh: 9_200 }] },
      { days: 2 },
    );
    expect(text).toContain('Best in this window: 24.1 kWh on 2026-08-03');
    expect(text).toContain('will read low until the sun goes down');
  });

  it('bounds the window instead of passing a bad value through to a 400', () => {
    expect(() => findTool('get_production_history').args({ days: 99_999 })).toThrow(/between 1 and 3660/);
    expect(() => findTool('get_production_history').args({ days: 1.5 })).toThrow(/whole number/);
  });

  it('picks the endpoint that matches the grouping', () => {
    const tool = findTool('get_production_history');
    expect(tool.plan(tool.args({ grouping: 'day', days: 7 }))[0].path).toBe('/api/history/energy?days=7');
    expect(tool.plan(tool.args({ grouping: 'year' }))[0].path).toBe('/api/history/production?grouping=year');
  });
});

describe('get_power_history', () => {
  const points = [
    { t: '2026-08-04T10:00:00Z', powerW: 3000 },
    { t: '2026-08-04T10:30:00Z', powerW: 5000 },
    { t: '2026-08-04T11:00:00Z', powerW: 6200 },
    { t: '2026-08-04T11:30:00Z', powerW: 1000, source: 'cloud' },
  ];

  it('summarises by hour rather than dumping every sample', () => {
    const text = render('get_power_history', { points }, { hours: 24 });
    expect(text).toContain('Peak 6,200 W at 2026-08-04T11:00:00Z');
    expect(text).toContain('2026-08-04 10:00');
    expect(text.split('\n').length).toBeLessThan(15);
  });

  it('declines to produce a second energy total for the same day', () => {
    /*
      Integrating these samples would give a figure that looks like the day's production
      and disagrees with the recorded one. Two totals for one day is worse than one.
    */
    const text = render('get_power_history', { points }, { hours: 24 });
    expect(text).toContain('use get_production_history');
    expect(text).not.toMatch(/across the window/);
  });

  it('says which samples were backfilled rather than polled', () => {
    expect(render('get_power_history', { points }, {})).toContain('1 of these samples were backfilled');
  });
});

describe('get_panel_health', () => {
  it('reports the expected result plainly when nothing is wrong', () => {
    const text = render('get_panel_health', { insights: [] }, { days: 7 });
    expect(text).toContain('No panel is underperforming');
    expect(text).toContain('only reports outliers');
  });

  it('distinguishes shading from a hardware shortfall', () => {
    const text = render(
      'get_panel_health',
      {
        insights: [
          { portId: 3, panel: 'Roof south 4', deficitPct: 22.5, lostWhPerDay: 640, diagnosis: 'Deficit concentrated in the afternoon.', pattern: 'shading' },
        ],
      },
      { days: 7 },
    );
    expect(text).toContain('22.5% below its neighbours');
    expect(text).toContain('consistent with shading');
  });
});

describe('get_ev_charging', () => {
  it('will not claim the car is away when no home has been set', () => {
    /*
      atHome is null, not false, when nobody has told the app where home is. A screen — or
      a sentence — has to be able to tell those apart.
    */
    const text = render(
      'get_ev_charging',
      {
        live: {
          vehicle: { name: 'Car', model: 'Model 3', state: 'online', batteryLevel: 64, rangeKm: 300, odometerKm: 42_000, charging: null, motion: { driving: false, speedKmh: null, since: null }, atHome: null, lastSeenAt: '2026-08-04T11:58:00Z' },
          live: null,
        },
        sessions: { sessions: [], totals: null },
      },
      { days: 30 },
    );
    expect(text).toContain('no home location has been set');
    expect(text).not.toContain('away from home');
  });

  it('reports driving from the drive record, not from the API state', () => {
    // TeslaMate reported "online" throughout a drive demonstrably in progress at 47 km/h.
    const text = render(
      'get_ev_charging',
      {
        live: {
          vehicle: { name: 'Car', model: 'Model 3', state: 'online', batteryLevel: 51, rangeKm: 240, odometerKm: 42_100, charging: null, motion: { driving: true, speedKmh: 47, since: '2026-08-04T11:40:00Z' }, atHome: false, lastSeenAt: '2026-08-04T11:59:00Z' },
          live: null,
        },
        sessions: { sessions: [], totals: { energyWh: 0, solarWh: 0, solarPct: 0 } },
      },
      {},
    );
    expect(text).toContain('driving at 47 km/h');
  });

  it('describes the solar share as an overlap, not as provenance', () => {
    const text = render(
      'get_ev_charging',
      { live: null, sessions: { sessions: [], totals: { energyWh: 48_000, solarWh: 21_000, solarPct: 43.75 } } },
      {},
    );
    expect(text).toContain('44%');
    expect(text).toContain('not a claim that those electrons went to the car');
  });

  it('says data is absent rather than rendering an empty car', () => {
    const text = render('get_ev_charging', {}, {});
    expect(text).toContain('No vehicle data is available');
    expect(text).toContain('No wall charger data is available');
  });
});

describe('get_alerts', () => {
  it('states the healthy case as a fact, not as an empty list', () => {
    expect(render('get_alerts', { alerts: { active: [], recentlyClosed: [] } })).toContain(
      'Nothing the dashboard watches for is currently wrong',
    );
  });

  it('gives each open alert its severity and its age', () => {
    const text = render('get_alerts', {
      alerts: {
        active: [{ id: 1, type: 'source-silence', severity: 'serious', subjectKey: 'charger', message: 'The wall charger has stopped reporting.', openedAt: '2026-08-01T12:00:00Z', closedAt: null, ackedAt: null }],
        recentlyClosed: [],
      },
    });
    expect(text).toContain('[serious]');
    expect(text).toContain('3 days ago');
    expect(text).toContain('not acknowledged');
  });
});

describe('get_device_usage', () => {
  it('marks an inferred figure as an estimate and names its confidence', () => {
    const text = render(
      'get_device_usage',
      {
        usage: [
          { deviceId: 1, name: 'Pool pump', kind: 'plug', onHoursPerDay: 8.2, energyKwh: 61.4, metered: false, estimated: true, confidence: 'rough', loadLabel: 'Pool pump', observations: [] },
          { deviceId: 2, name: 'Panel meter', kind: 'meter', onHoursPerDay: 24, energyKwh: 302.8, metered: true, returnedKwh: 41.2, observations: ['Two circuits carry most of the load.'], channels: [{ channel: 1, label: 'Dryer', energyKwh: 88.1, sharePct: 29.1 }] },
        ],
      },
      { days: 30 },
    );
    expect(text).toContain('ESTIMATED from 8.2 h/day');
    expect(text).toContain('confidence "rough"');
    expect(text).toContain('— measured');
    expect(text).toContain('1 measured, 1 estimated from run time, 0 reporting no energy figure');
  });

  it('does not describe a device that reports nothing as an estimate', () => {
    /*
      A real install has three of these — a switch and two thermostats that publish no
      power at all. Counting them as "inferred" describes an absence as a guess, which is
      the same collapse as printing a missing value as zero.
    */
    const text = render(
      'get_device_usage',
      { usage: [{ deviceId: 9, name: 'Garage lights', kind: 'switch', onHoursPerDay: 3, energyKwh: null, metered: false, observations: [] }] },
      {},
    );
    expect(text).toContain('0 measured, 0 estimated from run time, 1 reporting no energy figure');
    expect(text).toContain('Do not treat it as zero');
  });

  it('keeps energy sent back separate from energy consumed', () => {
    // Netting them produces a smaller consumption figure that looks like a saving.
    const text = render(
      'get_device_usage',
      { usage: [{ deviceId: 2, name: 'Meter', kind: 'meter', onHoursPerDay: 24, energyKwh: 100, metered: true, returnedKwh: 40, observations: [] }] },
      {},
    );
    expect(text).toContain('never netted against it');
  });

  it('says this is not whole-home consumption', () => {
    const text = render('get_device_usage', { usage: [{ deviceId: 1, name: 'X', kind: 'plug', onHoursPerDay: 1, energyKwh: 1, metered: true, observations: [] }] }, {});
    expect(text).toContain('not whole-home consumption');
  });
});
