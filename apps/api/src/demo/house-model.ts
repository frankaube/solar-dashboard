import {
  FlowTotals,
  ProgramValuation,
  RewardProgram,
  feedInTariffProgram,
  netMeteringProgram,
  valueProgram,
} from '../readings/reward-programs';
import {
  DEGRADATION_PER_YEAR,
  HouseSpec,
  annualConsumptionKwh,
  clearSkyKwh,
  systemKw,
} from './house-spec';

/**
 * A described house into a year of energy flows, then money, via `reward-programs.ts`.
 * Everything here is a MODEL — see the honesty rule in house-spec.ts.
 */

/** Annual mean clear-sky fraction delivered. Must agree with the per-day generator's cloud model. */
const WEATHER_YIELD = 0.62;

/** Share consumed as made, no battery. Real homes without storage: 25–35%. Scaled below by load. */
const DIRECT_OVERLAP = 0.32;

/** Round-trip losses charging and discharging a home battery. */
const BATTERY_ROUND_TRIP = 0.88;

/** Ceiling: the annual arithmetic misses instantaneous charger and load limits, so it reaches 100%. */
const MAX_SELF_CONSUMPTION = 0.95;

export interface AnnualFlows {
  producedKwh: number;
  consumedKwh: number;
  selfConsumedKwh: number;
  exportedKwh: number;
  importedKwh: number;
  /** Of everything produced, the share used at home. */
  selfConsumptionPct: number;
}

/** Production for a whole year, weather and first-year degradation included. */
export function annualProductionKwh(spec: HouseSpec): number {
  if (!spec.solar) return 0;
  let total = 0;
  for (let doy = 1; doy <= 365; doy++) total += clearSkyKwh(spec, doy);
  return total * WEATHER_YIELD * (1 - DEGRADATION_PER_YEAR);
}

/** Where a year's energy goes. Stored energy is capped by surplus, unmet load and throughput. */
export function annualFlows(spec: HouseSpec): AnnualFlows {
  const producedKwh = annualProductionKwh(spec);
  const consumedKwh = annualConsumptionKwh(spec);

  if (producedKwh === 0) {
    return {
      producedKwh: 0,
      consumedKwh,
      selfConsumedKwh: 0,
      exportedKwh: 0,
      importedKwh: consumedKwh,
      selfConsumptionPct: 0,
    };
  }

  // Bounded by both production and load.
  const direct = Math.min(producedKwh, consumedKwh) * DIRECT_OVERLAP;
  const surplus = producedKwh - direct;
  const unmetLoad = consumedKwh - direct;

  let stored = 0;
  if (spec.battery && spec.battery.capacityKwh > 0) {
    const usablePerDay = spec.battery.capacityKwh * spec.battery.usableFraction;
    const throughput = usablePerDay * 365 * BATTERY_ROUND_TRIP;
    stored = Math.min(surplus, unmetLoad, throughput);
  }

  const selfConsumedKwh = Math.min(direct + stored, producedKwh * MAX_SELF_CONSUMPTION);
  return {
    producedKwh,
    consumedKwh,
    selfConsumedKwh,
    exportedKwh: Math.max(0, producedKwh - selfConsumedKwh),
    importedKwh: Math.max(0, consumedKwh - selfConsumedKwh),
    selfConsumptionPct: (selfConsumedKwh / producedKwh) * 100,
  };
}

/** Resolve the spec's programme id into a programme the engine can value. */
export function programFor(spec: HouseSpec): RewardProgram {
  if (spec.tariff.programId === 'feed-in-tariff') {
    // A feed-in tariff pays a fixed rate for export; 60% of retail is a common shape.
    return feedInTariffProgram(spec.tariff.retailPerKwh * 0.6);
  }
  return netMeteringProgram(spec.tariff.taxRate);
}

export interface HouseValuation {
  spec: HouseSpec;
  flows: AnnualFlows;
  valuation: ProgramValuation & { unsupported: string[] };
  systemKw: number;
  /** What the house would have paid with no solar at all. */
  billWithoutSolarPerYear: number;
  /** What it pays now. Never below zero — utilities do not send cheques for this. */
  billWithSolarPerYear: number;
}

export function valueHouse(spec: HouseSpec): HouseValuation {
  const flows = annualFlows(spec);
  const totals: FlowTotals = {
    producedKwh: flows.producedKwh,
    selfConsumedKwh: flows.selfConsumedKwh,
    exportedKwh: flows.exportedKwh,
    importedKwh: flows.importedKwh,
    months: 12,
  };
  const valuation = valueProgram(programFor(spec), totals, spec.tariff.retailPerKwh);
  const billWithoutSolarPerYear = flows.consumedKwh * spec.tariff.retailPerKwh;
  return {
    spec,
    flows,
    valuation,
    systemKw: systemKw(spec),
    billWithoutSolarPerYear,
    billWithSolarPerYear: Math.max(0, billWithoutSolarPerYear - valuation.realised),
  };
}

export interface HouseComparison {
  before: HouseValuation;
  after: HouseValuation;
  /** Extra money kept per year. Negative is a real answer. */
  realisedDeltaPerYear: number;
  producedDeltaKwh: number;
  selfConsumptionDeltaPct: number;
  /** Years to repay `capitalCost`; null when it never pays back — the UI renders null as "never". */
  paybackYears: number | null;
}

/** Compare two houses: what the change moves, and how long it takes to pay back. */
export function compareHouses(
  before: HouseSpec,
  after: HouseSpec,
  capitalCost = 0,
): HouseComparison {
  const a = valueHouse(before);
  const b = valueHouse(after);
  const realisedDeltaPerYear = b.valuation.realised - a.valuation.realised;
  return {
    before: a,
    after: b,
    realisedDeltaPerYear,
    producedDeltaKwh: b.flows.producedKwh - a.flows.producedKwh,
    selfConsumptionDeltaPct: b.flows.selfConsumptionPct - a.flows.selfConsumptionPct,
    paybackYears:
      capitalCost > 0 && realisedDeltaPerYear > 0 ? capitalCost / realisedDeltaPerYear : null,
  };
}
