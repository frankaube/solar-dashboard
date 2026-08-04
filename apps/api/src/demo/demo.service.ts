import { Injectable } from '@nestjs/common';
import { parseEcoFlowQuota } from '../battery/ecoflow.client';
import { SavingsDto, SavingsPeriod } from '../readings/savings.service';
import { marginalValue, programRates, valueProgram } from '../readings/reward-programs';
import { findFixture } from './fixtures';
import { annualFlows, programFor } from './house-model';
import {
  DEFAULT_HOUSE,
  DEGRADATION_PER_YEAR,
  HouseSpec,
  clearSkyKwh,
  dayLength,
  systemKw,
} from './house-spec';

/**
 * Generates ~2 years of realistic, deterministic sample data on the fly — never
 * touching the real database. Powers demo mode: a prospective user (or a
 * developer with only days of real data) can explore a fully-populated app,
 * including a home battery no one has to own.
 *
 * Everything derives from one seasonal production model + a battery/EV/weather
 * model, hashed by date so the "history" is stable across requests.
 */

const SUMMER_SOLSTICE_DOY = 172;
const WINTER_SOLSTICE_DOY = 355;
const HISTORY_DAYS = 730;
const CO2_PER_KWH = 0.29;

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - start) / 86_400_000);
}

/**
 * Sunrise/sunset hours (local) for a latitude.
 *
 * Delegates to house-spec's `dayLength` rather than keeping the second copy of the
 * declination maths that used to live here. The copy was subtly worse: it fed an
 * unclamped ratio to acos(), so any latitude inside the polar circles produced NaN
 * and silently poisoned every derived number. Sharing one implementation is also
 * what makes the builder and the generated dataset agree.
 */
function daylight(doy: number, latitude: number): { sunrise: number; sunset: number } {
  const hours = dayLength(latitude, doy);
  return { sunrise: 12 - hours / 2, sunset: 12 + hours / 2 };
}

export interface DemoDay {
  date: string;
  kwh: number;
  peakW: number;
  cloud: number;
}

/**
 * One generated house.
 *
 * This used to be the service itself, with its parameters as module constants — one
 * 24 kW home with a Powerwall, and no way to ask for any other. Binding a
 * `HouseSpec` at construction is what lets the builder's output BE the demo dataset
 * rather than a separate calculator alongside it.
 *
 * The seasonal envelope now comes from `clearSkyKwh`, the same geometry the builder
 * quotes, so the two cannot drift apart. That is the point of the change and it does
 * move the numbers slightly: the old peak/trough were hand-tuned constants (135/26)
 * and the model reproduces them to within about 7%.
 */
export class DemoHouse {
  private days: DemoDay[] | null = null;

  private readonly lat: number;
  private readonly systemKw: number;
  private readonly panelCount: number;
  private readonly batteryKwh: number;
  private readonly price: number;
  private readonly hstRate: number;
  private readonly ratedPeak: number;
  private readonly ratedTrough: number;
  private readonly evShare: number;
  private readonly batteryShare: number;
  private readonly selfConsumption: number;

  constructor(readonly spec: HouseSpec = DEFAULT_HOUSE) {
    this.lat = spec.location.latitude;
    this.systemKw = systemKw(spec);
    this.panelCount = spec.solar?.panelCount ?? 0;
    this.batteryKwh = spec.battery?.capacityKwh ?? 0;
    this.price = spec.tariff.retailPerKwh;
    this.hstRate = spec.tariff.taxRate;
    this.ratedPeak = clearSkyKwh(spec, SUMMER_SOLSTICE_DOY);
    this.ratedTrough = clearSkyKwh(spec, WINTER_SOLSTICE_DOY);

    /*
      Self-consumption comes from the shared flow model rather than the two fixed
      shares this file used to carry (0.12 EV + 0.26 battery). Those were reasonable
      for the one house that was hardcoded and meaningless for any other — a house
      with no battery would still have claimed to store 26% of its output.

      The split between EV and battery is proportional to what each can absorb, so a
      spec with no EV attributes nothing to one.
    */
    const flows = annualFlows(spec);
    this.selfConsumption = flows.producedKwh > 0 ? flows.selfConsumedKwh / flows.producedKwh : 0;
    const evLoad = spec.ev ? spec.ev.kmPerYear * spec.ev.kwhPerKm : 0;
    const batteryLoad = spec.battery ? spec.battery.capacityKwh * spec.battery.usableFraction * 365 : 0;
    const totalAbsorber = evLoad + batteryLoad;
    this.evShare = totalAbsorber > 0 ? this.selfConsumption * (evLoad / totalAbsorber) : 0;
    this.batteryShare = totalAbsorber > 0 ? this.selfConsumption * (batteryLoad / totalAbsorber) : 0;
  }

  private build(): DemoDay[] {
    if (this.days) return this.days;
    const out: DemoDay[] = [];
    const today = new Date();
    for (let i = HISTORY_DAYS; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86_400_000);
      const iso = d.toISOString().slice(0, 10);
      const doy = dayOfYear(d);
      const seasonal =
        (this.ratedPeak + this.ratedTrough) / 2 +
        ((this.ratedPeak - this.ratedTrough) / 2) *
          Math.cos(((doy - SUMMER_SOLSTICE_DOY) / 365) * 2 * Math.PI);
      // Weather: autocorrelated-ish cloudiness.
      const cloud = 0.15 + 0.8 * hash(`${iso}-cloud`) * hash(`${iso}-c2`);
      // Occasional winter snow days near zero.
      const snow = doy < 75 || doy > 330 ? (hash(`${iso}-snow`) > 0.85 ? 0.08 : 1) : 1;
      const ageYears = i / 365;
      const degr = 1 - DEGRADATION_PER_YEAR * (2 - ageYears);
      const kwh = Math.max(0, seasonal * (1 - cloud * 0.75) * snow * degr);
      const { sunrise, sunset } = daylight(doy, this.lat);
      const hours = Math.max(1, sunset - sunrise);
      const peakW = (kwh / hours) * 1.55 * 1000;
      out.push({ date: iso, kwh: Math.round(kwh * 1000), peakW: Math.round(peakW), cloud });
    }
    this.days = out;
    return out;
  }

  private todayDay(): DemoDay {
    const days = this.build();
    return days[days.length - 1];
  }

  /** Instantaneous production at a given instant using the day's bell curve. */
  private powerAt(date: Date): number {
    const day = this.build().find((d) => d.date === date.toISOString().slice(0, 10));
    if (!day) return 0;
    const { sunrise, sunset } = daylight(dayOfYear(date), this.lat);
    const h = date.getUTCHours() - 3 + date.getUTCMinutes() / 60; // ADT
    if (h <= sunrise || h >= sunset) return 0;
    const u = (h - sunrise) / (sunset - sunrise);
    const shape = Math.pow(Math.sin(Math.PI * u), 1.35);
    const flicker = 1 - day.cloud * 0.5 * hash(`${date.toISOString().slice(0, 13)}-${date.getUTCMinutes()}`);
    return Math.max(0, day.peakW * shape * flicker);
  }

  // ---------- endpoint shapes ----------

  summary(): object {
    const now = new Date();
    const power = this.powerAt(now);
    const day = this.todayDay();
    return {
      updatedAt: now.toISOString(),
      currentPowerW: Math.round(power),
      todayEnergyWh: day.kwh,
      todayRevenue: (day.kwh / 1000) * this.price,
      pricePerKwh: this.price,
      gridVoltage: 249 + hash(`${now.getMinutes()}`) * 3,
      gridFrequency: 59.97 + hash(`${now.getMinutes()}f`) * 0.05,
      invertersOnline: 12,
      invertersTotal: 12,
      ratedKw: this.systemKw,
      ratedKwConfigured: true,
      panelsTotal: this.panelCount,
    };
  }

  private inverterFleet(): Array<{ serial: string; power: number; temp: number; ports: number }> {
    const now = new Date();
    const base = this.powerAt(now) / 12;
    return Array.from({ length: 12 }, (_, i) => ({
      serial: String(112600000000000 + i * 1111),
      power: Math.max(0, base * (0.9 + 0.2 * hash(`inv${i}-${now.getHours()}`))),
      temp: 20 + this.powerAt(now) / 900 + 8 * hash(`t${i}`),
      ports: i < 2 ? 1 : 4,
    }));
  }

  live(): object {
    const now = new Date();
    const invs = this.inverterFleet();
    const inverters = invs.map((inv) => ({
      serialNumber: inv.serial,
      gridVoltage: 250,
      gridFrequency: 60,
      activePower: Math.round(inv.power),
      temperature: Math.round(inv.temp * 10) / 10,
      linkStatus: 1,
      rfSignal: -55 - Math.round(20 * hash(inv.serial)),
    }));
    const ports: object[] = [];
    for (const inv of invs) {
      for (let p = 1; p <= inv.ports; p++) {
        const shade = 1 - (hash(`${inv.serial}-${p}`) > 0.94 ? 0.3 : 0);
        ports.push({
          inverterSerialNumber: inv.serial,
          portNumber: p,
          voltage: 32 + 2 * hash(`${inv.serial}v${p}`),
          current: (inv.power / inv.ports / 32) * shade,
          power: Math.round((inv.power / inv.ports) * shade),
          energyDailyWh: Math.round((this.todayDay().kwh / 42) * shade),
        });
      }
    }
    return {
      snapshot: {
        dtuSerialNumber: 'DEMO-24KW',
        takenAt: now.toISOString(),
        totalPower: Math.round(this.powerAt(now)),
        dailyEnergyWh: this.todayDay().kwh,
        inverters,
        ports,
      },
    };
  }

  powerHistory(hours: number): object[] {
    const now = Date.now();
    const out: object[] = [];
    for (let m = hours * 60; m >= 0; m -= 5) {
      const t = new Date(now - m * 60_000);
      out.push({ t: t.toISOString(), powerW: Math.round(this.powerAt(t)) });
    }
    return out;
  }

  energyHistory(days: number): object[] {
    return this.build()
      .slice(-days)
      .map((d) => ({ date: d.date, energyWh: d.kwh }));
  }

  stats(): object {
    const days = this.build();
    const today = this.todayDay();
    const todayIso = today.date;
    const monthPrefix = todayIso.slice(0, 7);
    const yearPrefix = todayIso.slice(0, 4);
    const sum = (pred: (d: DemoDay) => boolean): number =>
      days.filter(pred).reduce((a, d) => a + d.kwh, 0);
    const lifetimeWh = days.reduce((a, d) => a + d.kwh, 0);
    const peak = days.reduce((m, d) => Math.max(m, d.peakW), 0);
    const bestDay = days.reduce((b, d) => (d.kwh > b.kwh ? d : b));
    const cost = 62000;
    const lifeSavings = (lifetimeWh / 1000) * this.price;
    return {
      todayWh: today.kwh,
      monthWh: sum((d) => d.date.startsWith(monthPrefix)),
      yearWh: sum((d) => d.date.startsWith(yearPrefix)),
      lifetimeWh,
      pricePerKwh: this.price,
      savings: {
        today: (today.kwh / 1000) * this.price,
        month: (sum((d) => d.date.startsWith(monthPrefix)) / 1000) * this.price,
        year: (sum((d) => d.date.startsWith(yearPrefix)) / 1000) * this.price,
        lifetime: lifeSavings,
      },
      systemCostCad: cost,
      paybackProgressPct: (lifeSavings / cost) * 100,
      co2SavedKg: (lifetimeWh / 1000) * CO2_PER_KWH,
      records: {
        bestDayDate: bestDay.date,
        bestDayWh: bestDay.kwh,
        peakPowerW: peak,
        peakPowerAt: null,
        daysCollecting: days.length,
      },
    };
  }

  records(): object {
    const days = this.build();
    const bestDay = days.reduce((b, d) => (d.kwh > b.kwh ? d : b));
    const byMonth = new Map<string, number>();
    for (const d of days) byMonth.set(d.date.slice(0, 7), (byMonth.get(d.date.slice(0, 7)) ?? 0) + d.kwh);
    let bestMonth: { month: string; wh: number } | null = null;
    for (const [month, wh] of byMonth) if (!bestMonth || wh > bestMonth.wh) bestMonth = { month, wh };
    let bestWeek: { endDate: string; wh: number } | null = null;
    for (let i = 6; i < days.length; i++) {
      let s = 0;
      for (let j = i - 6; j <= i; j++) s += days[j].kwh;
      if (!bestWeek || s > bestWeek.wh) bestWeek = { endDate: days[i].date, wh: s };
    }
    const lifetimeWh = days.reduce((a, d) => a + d.kwh, 0);
    const peak = days.reduce((m, d) => Math.max(m, d.peakW), 0);
    const nextTarget = Math.floor(lifetimeWh / 1_000_000) + 1;
    return {
      daysCollecting: days.length,
      firstDate: days[0].date,
      lifetimeWh,
      lifetimeCo2Kg: (lifetimeWh / 1000) * CO2_PER_KWH,
      avgDayWh: Math.round(lifetimeWh / days.length),
      bestDay: { date: bestDay.date, wh: bestDay.kwh },
      bestMonth,
      bestWeek,
      peakPowerW: peak,
      peakPowerAt: null,
      todayIsRecord: false,
      producingStreak: 5,
      nextMwh: { targetMwh: nextTarget, pct: (lifetimeWh / (nextTarget * 1_000_000)) * 100 },
    };
  }

  analyticsProduction(hours: number): object {
    const now = Date.now();
    const points: object[] = [];
    for (let m = hours * 60; m >= 0; m -= 15) {
      const t = new Date(now - m * 60_000);
      const actual = this.powerAt(t);
      points.push({ t: t.toISOString(), actualW: Math.round(actual), expectedW: Math.round(actual / (1 - this.todayDay().cloud * 0.4)) });
    }
    return { wattsPerIrradiance: 14.2, points, tomorrowForecastWh: Math.round(this.todayDay().kwh * 0.95), chargeWindow: null };
  }

  tempPower(): object[] {
    return Array.from({ length: 90 }, (_, i) => ({
      temperature: 25 + 40 * hash(`tp${i}`),
      powerW: 200 + 1200 * hash(`tpw${i}`),
    }));
  }

  voltagePower(): object[] {
    // Voltage rises gently with output (line-voltage rise under export).
    return Array.from({ length: 90 }, (_, i) => {
      const p = 200 + 12000 * hash(`vpw${i}`);
      return { voltage: 244 + (p / 13000) * 8 + 1.5 * hash(`vn${i}`), powerW: p };
    });
  }

  weather(): object {
    const now = new Date();
    const doy = dayOfYear(now);
    const { sunrise, sunset } = daylight(doy, this.lat);
    const toIso = (h: number): string => {
      const d = new Date(now);
      d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
      return d.toISOString().slice(0, 16);
    };
    return {
      current: {
        takenAt: now.toISOString().slice(0, 16),
        temperature: 22,
        cloudCover: Math.round(this.todayDay().cloud * 100),
        windSpeed: 14,
        weatherCode: this.todayDay().cloud > 0.5 ? 3 : 0,
        shortwaveRadiation: Math.round(this.powerAt(now) / 24),
      },
      daily: { sunrise: [toIso(sunrise)], sunset: [toIso(sunset)] },
      // Day 0 is today, matching the real service. Codes are derived from the same
      // seeded cloudiness that drives generated production, so the icons agree with
      // the curve rather than contradicting it.
      forecast: Array.from({ length: 4 }, (_, i) => {
        const d = new Date(now.getTime() + i * 86_400_000);
        const iso = d.toISOString().slice(0, 10);
        const cloud = hash(`${iso}-cloud`);
        const { sunrise: sr, sunset: ss } = daylight(dayOfYear(d), this.lat);
        const dayIso = (h: number): string => {
          const x = new Date(d);
          x.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
          return x.toISOString().slice(0, 16);
        };
        return {
          date: iso,
          weatherCode: cloud > 0.7 ? 61 : cloud > 0.45 ? 3 : cloud > 0.2 ? 2 : 0,
          tempMax: Math.round(20 + 8 * hash(`${iso}-tmax`)),
          tempMin: Math.round(9 + 6 * hash(`${iso}-tmin`)),
          radiationSum: Math.round((1 - cloud) * 28 * 10) / 10,
          sunrise: dayIso(sr),
          sunset: dayIso(ss),
        };
      }),
    };
  }

  config(): object {
    return {
      electricityPricePerKwh: this.price,
      systemCostCad: 62000,
      hstRate: this.hstRate,
      systemRatedKw: this.systemKw,
    };
  }

  /**
   * Money-saved breakdown under net metering with tax on buyback. A demo home with a battery
   * and an EV self-consumes a believable share; the rest exports at the pre-tax
   * credit. Mirrors the real SavingsService shape so the Savings page populates.
   */
  savings(): SavingsDto {
    const stats = this.stats() as {
      todayWh: number;
      monthWh: number;
      yearWh: number;
      lifetimeWh: number;
    };
    const retail = this.price;
    /*
      Valued by the same engine and the same programme the real Savings page now uses,
      rather than by a third copy of the arithmetic. The demo is a regression test for
      the live path only if the two share the code.
    */
    const program = programFor(this.spec);
    const r1 = (n: number): number => Math.round(n * 10) / 10;
    const period = (wh: number): SavingsPeriod => {
      const producedKwh = wh / 1000;
      const selfConsumedKwh = producedKwh * this.selfConsumption;
      const exportedKwh = producedKwh - selfConsumedKwh;
      const valued = valueProgram(program, { producedKwh, selfConsumedKwh, exportedKwh }, retail);
      const line = (id: string): number => valued.lines.find((l) => l.ruleId === id)?.amount ?? 0;
      return {
        producedKwh: r1(producedKwh),
        selfConsumedKwh: r1(selfConsumedKwh),
        exportedKwh: r1(exportedKwh),
        grossValue: producedKwh * retail,
        netMeteringValue: line('export-credit'),
        bonusCaptured: line('tax-kept'),
        realizedSaved: valued.realised,
        bonusForegone: line('tax-foregone'),
        selfConsumptionPct: Math.round(this.selfConsumption * 100),
        // The demo house has a battery and a charger, so its self-consumption is a
        // modelled measurement rather than an owner's guess — no estimate marker.
        selfConsumptionEstimated: false,
        lines: valued.lines.map((l) => ({
          id: l.ruleId,
          label: l.label,
          amount: l.amount,
          realised: l.realised,
          note: l.note,
          })),
        programName: program.name,
      };
    };
    const lifetimeKwh = stats.lifetimeWh / 1000;
    return {
      rates: {
        retailPerKwh: retail,
        hstRate: this.hstRate,
        perKwh: programRates(program, retail),
        marginal: marginalValue(program, retail),
      },
      today: period(stats.todayWh),
      month: period(stats.monthWh),
      year: period(stats.yearWh),
      lifetime: period(stats.lifetimeWh),
      measured: {
        evSolarKwhLifetime: r1(lifetimeKwh * this.evShare),
        batteryDischargeKwhLifetime: r1(lifetimeKwh * this.batteryShare),
      },
      systemCostCad: 62000,
      paybackProgressPct: ((lifetimeKwh * retail) / 62000) * 100,
    };
  }

  onboarding(): object {
    return {
      complete: true,
      solar: { configured: true, host: 'demo', inverterCount: 12 },
      charger: { configured: true, host: 'demo' },
      devices: { count: 4 },
      preferences: { priceSet: true, notifySet: true },
      suggestedSubnet: '192.168.1',
      subnetSuggestions: ['192.168.1'],
    };
  }

  /** Battery SoC over the day: discharge overnight, charge from midday surplus. */
  private socAt(date: Date): number {
    const h = date.getUTCHours() - 3 + date.getUTCMinutes() / 60;
    const { sunrise, sunset } = daylight(dayOfYear(date), this.lat);
    const midday = (sunrise + sunset) / 2;
    if (h < sunrise) return Math.max(20, 55 - (sunrise - h) * 5); // overnight drain toward reserve
    if (h < midday) return Math.min(100, 30 + ((h - sunrise) / (midday - sunrise)) * 70); // charging
    if (h < sunset) return 100; // full, exporting surplus
    return Math.max(20, 100 - (h - sunset) * 12); // evening discharge to cover the house
  }

  /**
   * A fixture-backed battery, when one is selected.
   *
   * The payload goes through the production parser rather than a demo-only shortcut,
   * so what you see here is genuinely what the adapter would produce from that device.
   * The provenance travels with it: the UI must be able to say whether these numbers
   * came off real hardware or were reconstructed from a vendor's field list, because
   * only the first tells you the integration works.
   */
  batteryFixture(id: string): object | null {
    const fixture = findFixture(id);
    if (!fixture) return null;
    const state = parseEcoFlowQuota(fixture.payload);
    const meta = {
      fixture: { id: fixture.id, device: fixture.device, provenance: fixture.provenance, source: fixture.source },
    };
    // A parse miss is a real outcome worth demonstrating, not an error to hide: the
    // device is reachable and talking, and we do not understand it.
    if (!state) return { present: false, unparsed: true, name: fixture.device, ...meta };
    return {
      ...state,
      name: fixture.device,
      model: fixture.device,
      todayChargedKwh: null,
      todayDischargedKwh: null,
      roundTripPct: null,
      series: [],
      ...meta,
    };
  }

  battery(): object {
    /*
      A house with no battery must say so. `present: true` with `capacityKwh: 0` was
      what fell out of the refactor, and it is worse than either honest answer: the
      Battery page would render a pack that charges, discharges and holds a state of
      charge it does not have. The old code could not hit this because every demo
      house had a Powerwall by construction.
    */
    if (!this.spec.battery || this.batteryKwh <= 0) {
      return { present: false };
    }
    const now = new Date();
    const soc = this.socAt(now);
    const h = now.getUTCHours() - 3;
    const { sunrise, sunset } = daylight(dayOfYear(now), this.lat);
    const midday = (sunrise + sunset) / 2;
    let powerW = 0; // + charging, − discharging
    if (h > sunrise && h < midday && soc < 100) powerW = 3800;
    else if (h > sunset || h < sunrise) powerW = -1400;
    const series: object[] = [];
    for (let m = 24 * 60; m >= 0; m -= 15) {
      const t = new Date(now.getTime() - m * 60_000);
      series.push({ t: t.toISOString(), soc: Math.round(this.socAt(t)), powerW: 0 });
    }
    return {
      present: true,
      // Named from the spec, so picking an EcoFlow does not show you a Powerwall.
      name: this.spec.battery.label,
      model: this.spec.battery.label,
      capacityKwh: this.batteryKwh,
      soc: Math.round(soc),
      powerW,
      reservePct: 20,
      todayChargedKwh: 11.2,
      todayDischargedKwh: 9.8,
      cycles: 486,
      roundTripPct: 90,
      series,
    };
  }

  charger(): object {
    // Same rule as the battery: a house with no EV must not show one charging.
    if (!this.spec.ev) return { live: null, vehicle: null };
    const now = new Date();
    const h = now.getUTCHours() - 3;
    const charging = h > 11 && h < 15;
    return {
      live: {
        vehicleConnected: charging,
        charging,
        powerW: charging ? 7200 : 0,
        sessionEnergyWh: charging ? 6400 : 15600,
        sessionSeconds: charging ? 3200 : 0,
        gridVoltage: 241,
        gridFrequency: 60,
        handleTempC: 27,
        lifetimeEnergyWh: 4_200_000,
        chargeStarts: 512,
        updatedAt: now.toISOString(),
      },
      vehicle: {
        name: 'Demo EV',
        model: 'Model Y LR AWD',
        state: charging ? 'charging' : 'online',
        batteryLevel: charging ? 68 : 74,
        rangeKm: 372,
        odometerKm: 28450,
        charging: null,
        updatedAt: now.toISOString(),
      },
    };
  }

  chargerSessions(days: number): object {
    const sessions: object[] = [];
    let energy = 0;
    let solar = 0;
    for (let i = 0; i < Math.min(days / 3, 30); i++) {
      const d = new Date(Date.now() - i * 3 * 86_400_000);
      const wh = 20000 + Math.round(20000 * hash(`sess${i}`));
      const pct = Math.round(30 + 60 * hash(`solar${i}`));
      energy += wh;
      solar += (wh * pct) / 100;
      sessions.push({
        startedAt: new Date(d.getTime() - 4 * 3600_000).toISOString(),
        endedAt: d.toISOString(),
        energyWh: wh,
        solarWh: Math.round((wh * pct) / 100),
        solarPct: pct,
        peakW: 11000,
      });
    }
    return {
      sessions,
      totals: { energyWh: energy, solarWh: Math.round(solar), solarPct: energy ? Math.round((solar / energy) * 100) : 0 },
    };
  }

  vehicleDetails(): object {
    const battery: object[] = [];
    for (let i = 168; i >= 0; i--) {
      const t = new Date(Date.now() - i * 3600_000);
      battery.push({ t: t.toISOString(), level: Math.round(45 + 45 * Math.abs(Math.sin(i / 9))) });
    }
    const drives = Array.from({ length: 12 }, (_, i) => ({
      startedAt: new Date(Date.now() - i * 18 * 3600_000).toISOString(),
      from: 'Home',
      // Generic on purpose: sample data ships to everyone, so no real place belongs in it.
      to: ['Work', 'Grocery', 'The beach', 'Gym'][i % 4],
      distanceKm: 8 + Math.round(60 * hash(`drv${i}`)),
      durationMin: 12 + Math.round(40 * hash(`dur${i}`)),
      consumptionKwh: 2 + 8 * hash(`con${i}`),
      outsideTempC: 18 + 10 * hash(`temp${i}`),
      speedMaxKmh: 90 + Math.round(30 * hash(`spd${i}`)),
    }));
    const demoCharges = (this.chargerSessions(90) as { sessions: object[] }).sessions
      .slice(0, 10)
      .map((s, i) => {
        const energyWh = (s as { energyWh: number }).energyWh;
        // Evening charges are mostly grid; the odd daytime top-up is mostly roof.
        const solarPct = i % 3 === 0 ? 8 + Math.round(70 * hash(`sun${i}`)) : Math.round(6 * hash(`sun${i}`));
        return {
          startedAt: (s as { startedAt: string }).startedAt,
          location: 'Home',
          energyAddedKwh: energyWh / 1000,
          energyUsedKwh: energyWh / 1000 / 0.9,
          durationMin: 240,
          startLevel: 40,
          endLevel: 80,
          fast: false,
          solarPct,
          solarWh: Math.round((energyWh * solarPct) / 100),
        };
      });

    return {
      details: {
        vehicle: (this.charger() as { vehicle: object }).vehicle,
        battery,
        drives,
        charges: demoCharges,
        /*
          The real payload carries these, so demo has to as well.

          Without them the Car page fell to "Charging history appears once the car logs a
          charge" while ten charges were listed directly underneath it — demo mode showing
          a state the app can no longer be in.
        */
        chargeTotals: {
          energyWh: Math.round(demoCharges.reduce((a, c) => a + c.energyAddedKwh, 0) * 1000),
          solarWh: Math.round(demoCharges.reduce((a, c) => a + (c.solarWh ?? 0), 0)),
          solarPct: (() => {
            const total = demoCharges.reduce((a, c) => a + c.energyAddedKwh * 1000, 0);
            const sun = demoCharges.reduce((a, c) => a + (c.solarWh ?? 0), 0);
            return total > 0 ? Math.round((sun / total) * 100) : 0;
          })(),
          count: demoCharges.length,
        },
        updates: [{ installedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), version: '2026.20.5' }],
        stats: { days: 30, drivenKm: 1240, driveCount: 42, energyUsedKwh: 232.5, energyAddedKwh: 258, avgConsumptionWhKm: 187 },
        phantomDrain: { avgPctPerDay: 1.2, worstGap: null },
        lastChargeCurve: [],
      },
    };
  }

  panels(): object[] {
    const out: object[] = [];
    let id = 1;
    for (let inv = 0; inv < 12; inv++) {
      const ports = inv < 2 ? 1 : 4;
      for (let p = 1; p <= ports; p++) {
        out.push({
          id: id++,
          portNumber: p,
          label: null,
          wattage: 500,
          gridX: (id - 2) % 12,
          gridY: Math.floor((id - 2) / 12),
          inverterSerial: String(112600000000000 + inv * 1111),
        });
      }
    }
    return out;
  }

  devices(): object[] {
    return [
      { id: 1, vendor: 'kasa', kind: 'switch', name: 'Garage lights', host: 'demo', room: 'Garage', critical: false, enabled: true, config: null, capabilities: ['setOn'], state: { reachable: true, on: false, rssi: -52, updatedAt: new Date().toISOString() } },
      { id: 2, vendor: 'mysa', kind: 'thermostat', name: 'Living room', host: 'demo', room: 'Living room', critical: false, enabled: true, config: '{}', capabilities: ['setTargetTemperature'], state: { reachable: true, temperatureC: 21.4, setpointC: 21, heating: false, updatedAt: new Date().toISOString() } },
      { id: 3, vendor: 'mysa', kind: 'thermostat', name: 'Bedroom', host: 'demo', room: 'Bedroom', critical: false, enabled: true, config: '{}', capabilities: ['setTargetTemperature'], state: { reachable: true, temperatureC: 19.8, setpointC: 20, heating: true, updatedAt: new Date().toISOString() } },
      { id: 4, vendor: 'shelly', kind: 'plug', name: 'Freezer', host: 'demo', room: 'Basement', critical: true, enabled: true, config: null, capabilities: ['setOn'], state: { reachable: true, on: true, powerW: 68, updatedAt: new Date().toISOString() } },
    ];
  }

  deviceUsage(): object[] {
    return [
      { deviceId: 4, name: 'Freezer', kind: 'plug', onHoursPerDay: 24, energyKwh: 11.4, metered: true, observations: ['Steady 68 W — normal for a chest freezer.'] },
      { deviceId: 1, name: 'Garage lights', kind: 'switch', onHoursPerDay: 13.2, energyKwh: null, metered: false, observations: ['On ~13.2 h/day — a sunset/sunrise schedule (device-side) could trim this.'] },
      { deviceId: 5, name: 'TV + console', kind: 'plug', onHoursPerDay: 4.1, energyKwh: 2.2, metered: true, observations: ['Draws standby power while off — a candidate for a true-off schedule.'] },
    ];
  }

  panelInsights(): object[] {
    return [
      {
        portId: 34,
        panel: 'South · row 3 · #4',
        deficitPct: 41,
        lostWhPerDay: 620,
        diagnosis: 'Shading — losses concentrate 15:00–17:00',
        pattern: 'shading',
      },
      {
        portId: 12,
        panel: 'West · row 1 · #2',
        deficitPct: 18,
        lostWhPerDay: 240,
        diagnosis: 'Soiling or mild all-day loss',
        pattern: 'all-day',
      },
    ];
  }

  alerts(): object {
    const now = Date.now();
    return {
      active: [
        {
          id: 1,
          type: 'port_underperforming',
          severity: 'warning',
          subjectKey: '1420:2',
          message: 'Panel S12 at 178 W — 34% below its siblings (partial shade)',
          openedAt: new Date(now - 3 * 3600_000).toISOString(),
          closedAt: null,
          ackedAt: null,
        },
      ],
      recentlyClosed: [
        {
          id: 2,
          type: 'inverter_offline',
          severity: 'serious',
          subjectKey: '1420A',
          message: 'Inverter B3 offline',
          openedAt: new Date(now - 40 * 3600_000).toISOString(),
          closedAt: new Date(now - 38 * 3600_000).toISOString(),
          ackedAt: null,
        },
      ],
    };
  }
}

/**
 * Resolves a spec to a generated house, memoised.
 *
 * Deliberately holds no "current" house. The spec arrives with each request, so one
 * public demo instance can serve many visitors each exploring a different home
 * without any of them changing what the others see — which is the whole point of the
 * hosted-demo plan, and impossible with server-side session state.
 *
 * The cache is bounded because the key is attacker-supplied: a public instance would
 * otherwise let anyone grow it without limit by varying one field.
 */
const MAX_CACHED_HOUSES = 32;

@Injectable()
export class DemoService {
  private readonly cache = new Map<string, DemoHouse>();

  for(spec: HouseSpec = DEFAULT_HOUSE): DemoHouse {
    const key = JSON.stringify(spec);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const house = new DemoHouse(spec);
    if (this.cache.size >= MAX_CACHED_HOUSES) {
      // Oldest insertion first — Map preserves insertion order.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, house);
    return house;
  }
}
