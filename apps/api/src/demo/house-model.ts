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
 * Turn a described house into a year of energy flows, then into money.
 *
 * This is the first caller `reward-programs.ts` has ever had. That engine was written,
 * tested, and then left unimported while the live savings path kept its hardcoded
 * single-utility formula — so the "works under any tariff" claim was true of a library
 * nobody ran. Routing the builder through it makes the claim demonstrable, and gives
 * the engine a second consumer to be designed against before the live path moves over.
 *
 * Everything below is a MODEL and the numbers are shaped, not measured. See the honesty
 * rule at the top of house-spec.ts.
 */

/**
 * Average clear-sky fraction actually delivered, across weather.
 *
 * The per-day generator applies its own autocorrelated cloud; this is the annual mean
 * equivalent, used for the closed-form yearly figures the builder compares. Keeping
 * them consistent matters: a comparison screen that disagreed with the dashboard it
 * links to would be worse than no comparison.
 */
const WEATHER_YIELD = 0.62;

/**
 * Share of production consumed as it is made, with no battery.
 *
 * Real solar homes without storage land around 25–35%: the roof peaks at midday and
 * the house does not. Scaled by how much load there is to absorb it, so a big array on
 * a small house self-consumes less of its output than a small array on a big one.
 */
const DIRECT_OVERLAP = 0.32;

/** Round-trip losses charging and discharging a home battery. */
const BATTERY_ROUND_TRIP = 0.88;

/**
 * Nobody self-consumes everything, however big the battery.
 *
 * Without this the Stockholm preset came out at exactly 100%: a 13.5 kWh pack can
 * absorb a whole northern summer surplus on paper, because the annual arithmetic never
 * sees the instants where the roof out-produces both the load and the charger's power
 * limit. A round 100% reads as a bug to anyone who owns a battery, and it is one.
 */
const MAX_SELF_CONSUMPTION = 0.95;

export interface AnnualFlows {
  producedKwh: number;
  consumedKwh: number;
  selfConsumedKwh: number;
  exportedKwh: number;
  importedKwh: number;
  /** Of everything produced, the share used at home. The battery's whole job. */
  selfConsumptionPct: number;
}

/** Production for a whole year, weather and first-year degradation included. */
export function annualProductionKwh(spec: HouseSpec): number {
  if (!spec.solar) return 0;
  let total = 0;
  for (let doy = 1; doy <= 365; doy++) total += clearSkyKwh(spec, doy);
  return total * WEATHER_YIELD * (1 - DEGRADATION_PER_YEAR);
}

/**
 * Where a year's energy goes.
 *
 * The battery earns its keep by moving surplus that would have been exported into load
 * that would have been imported — so it is capped by three separate things, and the
 * binding one differs per house. That is the point of the exercise: a battery on a
 * house with no evening load, or no surplus, does close to nothing, and a model that
 * always returned "batteries are great" would be worthless as a decision aid.
 */
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

  // Direct use is bounded by both sides: you cannot use more than you make, or more
  // than you need.
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
  /** Extra money kept per year. Negative is a real answer and must be shown as one. */
  realisedDeltaPerYear: number;
  producedDeltaKwh: number;
  selfConsumptionDeltaPct: number;
  /**
   * Years to repay `capitalCost` from the extra money kept, or null when the change
   * never pays back. Null is the honest answer for a battery on a house that had
   * nothing to store, and the UI must render it as "never", not as a blank.
   */
  paybackYears: number | null;
}

/**
 * Compare two houses — the actual product idea.
 *
 * "Here is a house with a battery" is a screenshot. "Here is what the battery changes,
 * and how long it takes to pay for itself" is a reason to open the app before buying
 * anything, which is the only thing that makes a demo worth more than a video.
 */
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
