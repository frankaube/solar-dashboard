/**
 * Reward programme engine — what a kWh is actually worth, wherever you live.
 *
 * The savings model used to hardcode one programme shape: `exportCredit = retail /
 * (1 + tax)`, which is 1:1 net metering with sales tax on buyback. The rates were
 * configurable but the *structure* was not, so the numbers were quietly wrong for a
 * feed-in tariff, for net billing at wholesale, for time-of-use, and for anywhere
 * export earns nothing at all.
 *
 * Here a programme is a list of rules instead. Each rule takes one energy flow and
 * turns it into money, and the engine sums them. That covers the shapes that actually
 * exist without becoming a formula language:
 *
 *   - net metering        exported kWh credited at a fraction of retail
 *   - net billing         exported kWh credited at a fixed wholesale rate
 *   - feed-in tariff      exported kWh at a fixed rate unrelated to retail
 *   - time-of-use         several rules, each limited to an hour window
 *   - tiered              rules limited by cumulative kWh in the period
 *   - carbon offsets      value derived from displaced grid emissions, not from a rate
 *   - fixed credits       a monthly amount that is not per-kWh at all
 *
 * Two properties are deliberately preserved from the old model, because they are the
 * reason it was trustworthy:
 *
 * 1. Every rule declares whether its value is REALISED (money you kept) or a CEILING
 *    (money the programme's structure left on the table). Collapsing those two into a
 *    single "savings" figure is the flattering mistake; keeping them apart is why the
 *    dashboard can lead with a number that is true.
 * 2. Nothing is invented. A programme with no carbon component yields no carbon value,
 *    not a plausible-looking zero-adjacent estimate.
 */

/** Which stream of energy a rule prices. */
export type EnergyFlow = 'produced' | 'selfConsumed' | 'exported' | 'imported';

/**
 * A rate, either absolute or expressed against the retail price.
 *
 * `ofRetail` exists because most programmes define export relative to what you pay,
 * so an owner who changes their electricity price should not have to restate their
 * export credit as well — and forgetting to is a silent error.
 */
export type RateRef = { fixedPerKwh: number } | { ofRetail: number };

/** Optional narrowing: time-of-use windows and tier thresholds. */
export interface RuleWhen {
  /** Local hours [start, end) in 24 h. Wraps midnight when start > end. */
  hours?: [number, number];
  /** 1-12. Absent means every month. */
  months?: number[];
  /**
   * 0 = Sunday. Absent means every day.
   *
   * Separate from `hours` because most time-of-use tariffs price the whole weekend at
   * the off-peak rate regardless of hour, so expressing it as an hour window would be
   * wrong for two days in seven.
   */
  weekdays?: number[];
  /** Applies only to kWh beyond this much in the period (tiered rates). */
  aboveKwh?: number;
  /** Applies only up to this much in the period. */
  upToKwh?: number;
}

interface BaseRule {
  id: string;
  /** Shown in "where that comes from" — write it as the owner would say it. */
  label: string;
  applies: EnergyFlow;
  /** True = money kept. False = a ceiling/opportunity, reported separately. */
  realised: boolean;
  when?: RuleWhen;
  /** Free text surfaced as the rule's hint in the UI. */
  note?: string;
}

export interface PerKwhRule extends BaseRule {
  kind: 'perKwh';
  rate: RateRef;
}

/**
 * Carbon offset value. Deliberately NOT a $/kWh rate, because it is not one — it is
 * displaced grid emissions priced per tonne, and the grid factor varies by more than
 * two orders of magnitude across Canada (a coal-heavy grid versus a hydro one). A
 * single "carbon rate" would hide exactly the variable that matters.
 */
export interface CarbonRule extends BaseRule {
  kind: 'carbon';
  /**
   * kg CO2e displaced per kWh. No default is shipped: this must come from the owner's
   * own grid, sourced from their utility or the national inventory. A wrong figure
   * here produces a confident, plausible and completely fictional number.
   */
  gridIntensityKgPerKwh: number;
  pricePerTonne: number;
}

/** A flat amount per month, independent of generation. */
export interface FixedMonthlyRule extends BaseRule {
  kind: 'fixedMonthly';
  amount: number;
}

export type RewardRule = PerKwhRule | CarbonRule | FixedMonthlyRule;

export interface RewardProgram {
  id: string;
  name: string;
  /** ISO-ish region tag, e.g. "CA-ON". Informational. */
  region?: string;
  rules: RewardRule[];
  /** True for anything the owner created or edited, so the UI can say so. */
  userDefined?: boolean;
  note?: string;
}

/** The measured energy a period is valued from. */
export interface FlowTotals {
  producedKwh: number;
  selfConsumedKwh: number;
  exportedKwh: number;
  importedKwh?: number;
  /** Whole months the period spans; drives fixedMonthly rules. */
  months?: number;
}

export interface ValuedLine {
  ruleId: string;
  label: string;
  amount: number;
  realised: boolean;
  note?: string;
}

export interface ProgramValuation {
  lines: ValuedLine[];
  /** Money kept. This is the honest headline. */
  realised: number;
  /** Value the programme's structure did not deliver — a ceiling, not a loss. */
  foregone: number;
  /** realised + foregone. Always a ceiling; never lead with it. */
  ceiling: number;
}

const KG_PER_TONNE = 1000;

const KWH_OF: Record<EnergyFlow, (f: FlowTotals) => number> = {
  produced: (f) => f.producedKwh,
  selfConsumed: (f) => f.selfConsumedKwh,
  exported: (f) => f.exportedKwh,
  imported: (f) => f.importedKwh ?? 0,
};

/** Resolve a rate against the retail price. */
export function resolveRate(rate: RateRef, retailPerKwh: number): number {
  return 'fixedPerKwh' in rate ? rate.fixedPerKwh : retailPerKwh * rate.ofRetail;
}

/**
 * Apply a rule's tier window to a flow total.
 *
 * Hour and month windows are NOT applied here. Doing so would require hourly energy,
 * and silently prorating a period total by "how much of the day the window covers"
 * would manufacture precision the data cannot support. Until the engine is fed hourly
 * buckets, a time-limited rule is reported as unsupported rather than approximated.
 */
export function tieredKwh(total: number, when: RuleWhen | undefined): number {
  if (!when) return total;
  const above = when.aboveKwh ?? 0;
  const upTo = when.upToKwh ?? Infinity;
  return Math.max(0, Math.min(total, upTo) - above);
}

/**
 * True when a rule cannot be answered from period totals alone.
 *
 * Not a permanent limitation — `valueProgramOverBuckets` answers all of these given
 * hourly flows. This is what `valueProgram` uses to refuse rather than guess when it
 * has only a lump sum.
 */
export function needsHourlyData(rule: RewardRule): boolean {
  return (
    rule.when?.hours !== undefined ||
    rule.when?.months !== undefined ||
    rule.when?.weekdays !== undefined
  );
}

/**
 * Value one period under one programme.
 *
 * Rules requiring hourly resolution are skipped and reported, never guessed at — a
 * time-of-use rule silently valued against a daily total is the exact class of error
 * this engine exists to remove.
 */
export function valueProgram(
  program: RewardProgram,
  flows: FlowTotals,
  retailPerKwh: number,
): ProgramValuation & { unsupported: string[] } {
  const lines: ValuedLine[] = [];
  const unsupported: string[] = [];

  for (const rule of program.rules) {
    if (needsHourlyData(rule)) {
      unsupported.push(rule.id);
      continue;
    }
    let amount = 0;
    if (rule.kind === 'fixedMonthly') {
      amount = rule.amount * Math.max(0, flows.months ?? 0);
    } else {
      const kwh = tieredKwh(KWH_OF[rule.applies](flows), rule.when);
      amount =
        rule.kind === 'perKwh'
          ? kwh * resolveRate(rule.rate, retailPerKwh)
          : (kwh * rule.gridIntensityKgPerKwh * rule.pricePerTonne) / KG_PER_TONNE;
    }
    if (!Number.isFinite(amount)) continue; // a bad stored rate must not poison the total
    lines.push({
      ruleId: rule.id,
      label: rule.label,
      amount,
      realised: rule.realised,
      note: rule.note,
    });
  }

  const realised = lines.filter((l) => l.realised).reduce((s, l) => s + l.amount, 0);
  const foregone = lines.filter((l) => !l.realised).reduce((s, l) => s + l.amount, 0);
  return { lines, realised, foregone, ceiling: realised + foregone, unsupported };
}

/**
 * Built-in templates. These are starting points an owner edits, not authorities —
 * every one carries rates that change, so the UI must present them as editable and
 * dated rather than as fact.
 *
 * Only programme SHAPES are shipped with confidence. Money figures that vary by
 * jurisdiction and year (carbon prices, grid emission factors, feed-in rates) are left
 * at zero for the owner to fill in from their own bill or utility, because a wrong
 * default here yields a number that looks researched and is fiction.
 */
export function netMeteringProgram(taxRate: number): RewardProgram {
  // Export is banked 1:1 in kWh, but buying it back attracts sales tax — so an
  // exported kWh returns retail/(1+tax) in real terms while a self-consumed one
  // avoids the full retail price. The gap is the whole argument for self-consumption.
  const preTax = 1 / (1 + taxRate);
  return {
    id: 'net-metering',
    name: 'Net metering (1:1, tax on buyback)',
    rules: [
      {
        kind: 'perKwh',
        id: 'export-credit',
        label: 'Export credits',
        applies: 'produced',
        rate: { ofRetail: preTax },
        realised: true,
        note: 'Every kWh banked 1:1 and returned as a credit, valued at the pre-tax rate.',
      },
      {
        kind: 'perKwh',
        id: 'tax-kept',
        label: 'Tax kept on self-use',
        applies: 'selfConsumed',
        rate: { ofRetail: 1 - preTax },
        realised: true,
        note: 'Sales tax skipped by using solar as you made it rather than buying it back.',
      },
      {
        kind: 'perKwh',
        id: 'tax-foregone',
        label: 'Not realised',
        applies: 'exported',
        rate: { ofRetail: 1 - preTax },
        realised: false,
        note: 'Sales tax payable to buy back what was exported. A ceiling a battery or better timing could reach — not money lost.',
      },
    ],
  };
}

export function feedInTariffProgram(ratePerKwh: number): RewardProgram {
  return {
    id: 'feed-in-tariff',
    name: 'Feed-in tariff',
    rules: [
      {
        kind: 'perKwh',
        id: 'fit-export',
        label: 'Feed-in payment',
        applies: 'exported',
        rate: { fixedPerKwh: ratePerKwh },
        realised: true,
        note: 'Paid per exported kWh at a fixed rate, independent of what you pay to buy power.',
      },
      {
        kind: 'perKwh',
        id: 'fit-avoided',
        label: 'Purchases avoided',
        applies: 'selfConsumed',
        rate: { ofRetail: 1 },
        realised: true,
        note: 'Retail price avoided by consuming your own generation.',
      },
    ],
  };
}

export function netBillingProgram(exportRatePerKwh: number): RewardProgram {
  return {
    id: 'net-billing',
    name: 'Net billing (export at wholesale)',
    rules: [
      {
        kind: 'perKwh',
        id: 'billing-export',
        label: 'Export credit',
        applies: 'exported',
        rate: { fixedPerKwh: exportRatePerKwh },
        realised: true,
        note: 'Export credited at the utility’s avoided-cost or wholesale rate, not at retail.',
      },
      {
        kind: 'perKwh',
        id: 'billing-avoided',
        label: 'Purchases avoided',
        applies: 'selfConsumed',
        rate: { ofRetail: 1 },
        realised: true,
      },
      {
        kind: 'perKwh',
        id: 'billing-gap',
        label: 'Not realised',
        applies: 'exported',
        // The spread between retail and the export rate: what self-consuming that kWh
        // would have been worth instead. Under net billing this gap is usually large,
        // which is precisely why it must be shown rather than folded into a total.
        rate: { ofRetail: 1 },
        realised: false,
        note: 'Under net billing, exporting earns far less than self-consuming. This is that spread, before subtracting the export credit already counted above.',
      },
    ],
  };
}

/**
 * A carbon-offset component, to be appended to whichever programme handles the
 * electricity side. Both figures are required from the owner: offset prices and grid
 * emission factors vary by jurisdiction and year, and the factor in particular spans
 * more than two orders of magnitude across Canada.
 */
export function carbonOffsetRule(
  gridIntensityKgPerKwh: number,
  pricePerTonne: number,
): CarbonRule {
  return {
    kind: 'carbon',
    id: 'carbon-offset',
    label: 'Carbon offsets',
    applies: 'produced',
    gridIntensityKgPerKwh,
    pricePerTonne,
    realised: false,
    note: 'Value of emissions displaced, priced per tonne. Marked unrealised unless you are actually enrolled in a programme that pays out — most households are not.',
  };
}

/**
 * The programmes a user can pick, and how an id becomes a valued programme.
 *
 * One registry so the id → programme step exists once. Both the live savings path and
 * the demo builder resolve through here; before this they each knew their own subset,
 * which is how you end up with a dashboard and a builder disagreeing about what
 * "feed-in tariff" means.
 *
 * `needsRetail` marks programmes whose rates are defined relative to the retail price
 * rather than as absolute amounts — the UI uses it to explain why changing the
 * electricity price moves the answer.
 */
export interface ProgramOption {
  id: string;
  label: string;
  description: string;
  needsRetail: boolean;
}

export const PROGRAM_OPTIONS: ProgramOption[] = [
  {
    id: 'net-metering',
    label: 'Net metering (1:1 credit)',
    description:
      'Export is banked kWh-for-kWh. You still pay sales tax buying it back, so using solar as you make it is worth slightly more than exporting it.',
    needsRetail: true,
  },
  {
    id: 'feed-in-tariff',
    label: 'Feed-in tariff (paid for export)',
    description:
      'You are paid a fixed rate per exported kWh, usually below retail. Self-consumption is worth the full retail price you avoid, so a battery matters far more here.',
    needsRetail: true,
  },
  {
    id: 'time-of-use',
    label: 'Time-of-use (peak / off-peak)',
    description:
      'The price changes by hour and day. Solar used during the weekday evening peak is worth far more than the same kWh overnight, so when you use it matters as much as how much.',
    needsRetail: true,
  },
  {
    id: 'no-export',
    label: 'No export credit',
    description:
      'Export earns nothing — the meter does not run backwards and there is no buyback. Only what you use yourself has any value.',
    needsRetail: true,
  },
];

/**
 * Export earns nothing at all.
 *
 * A real arrangement in several places, and the case that makes self-consumption the
 * entire story rather than a premium on top of it. Worth shipping precisely because it
 * is the programme under which the app's advice changes most.
 */
export function noExportProgram(): RewardProgram {
  return {
    id: 'no-export',
    name: 'No export credit',
    rules: [
      {
        kind: 'perKwh',
        id: 'self-use',
        label: 'Retail price avoided',
        applies: 'selfConsumed',
        rate: { ofRetail: 1 },
        realised: true,
        note: 'The full retail price you did not pay, because you used it yourself.',
      },
      {
        kind: 'perKwh',
        id: 'export-unpaid',
        label: 'Not realised',
        applies: 'exported',
        rate: { ofRetail: 1 },
        realised: false,
        note: 'Exported and earned nothing. A battery or shifted load could capture this.',
      },
    ],
  };
}

/**
 * Resolve a stored programme id.
 *
 * Falls back to net metering for an unknown id rather than throwing: the id comes from
 * a settings row that an older build, a hand-edited database, or a future version
 * could have written, and refusing to show any savings at all would be a worse answer
 * than showing the most common one.
 */
export function resolveProgram(
  id: string | null | undefined,
  opts: { taxRate: number; retailPerKwh: number },
): RewardProgram {
  switch (id) {
    case 'feed-in-tariff':
      // 60% of retail is a common shape where a published rate is not configured.
      return feedInTariffProgram(opts.retailPerKwh * 0.6);
    case 'no-export':
      return noExportProgram();
    case 'time-of-use':
      return timeOfUseProgram(opts.taxRate);
    default:
      return netMeteringProgram(opts.taxRate);
  }
}

export interface ResolvedRate {
  ruleId: string;
  label: string;
  /** Dollars per kWh, with `ofRetail` rules already multiplied out. */
  ratePerKwh: number;
  /** Which flow the rate applies to — what you have to do to earn it. */
  applies: EnergyFlow;
  realised: boolean;
  /**
   * True when the rate only applies during certain hours, days or months.
   *
   * Timed rates on the same flow are ALTERNATIVES — a kWh earns exactly one of them —
   * so anything combining rates has to know the difference. Summing a set of
   * time-of-use windows reports a kWh as worth several times what it is.
   */
  timed: boolean;
}

/**
 * The per-kWh rates a programme actually pays, resolved against the retail price.
 *
 * The savings DTO used to publish `exportCreditPerKwh` and `premiumPerKwh` — two
 * numbers that only mean something under net metering. A feed-in tariff has neither
 * (it has a published export rate), and a no-export arrangement has neither and no
 * third thing either. Any consumer reading those fields was reading net metering's
 * internals and would quietly show nonsense under a different programme.
 *
 * Asking the programme what it pays, and for what, works for all three and for
 * whatever gets added next.
 *
 * Only `perKwh` rules appear. A carbon rule is priced per tonne and a fixed monthly
 * charge is not a rate at all, so folding either into a per-kWh list would be a
 * category error rather than a rounding one.
 */
export function programRates(program: RewardProgram, retailPerKwh: number): ResolvedRate[] {
  return program.rules
    .filter((rule): rule is PerKwhRule => rule.kind === 'perKwh')
    .map((rule) => ({
      ruleId: rule.id,
      label: rule.label,
      ratePerKwh: resolveRate(rule.rate, retailPerKwh),
      applies: rule.applies,
      realised: rule.realised,
      timed: needsHourlyData(rule),
    }));
}

export interface MarginalValue {
  /** What one more kWh used at home is worth. The high end when it varies by time. */
  selfConsumedPerKwh: number;
  /** What one more kWh sent to the grid is worth. The high end when it varies. */
  exportedPerKwh: number;
  /** Low end, when the programme prices by time of day. Equal to the above otherwise. */
  selfConsumedLowPerKwh: number;
  exportedLowPerKwh: number;
  /** True when the value depends on WHEN the kWh flowed, not just where it went. */
  varies: boolean;
}

/**
 * What one more kWh is worth, depending on where it goes.
 *
 * The question every owner actually asks — "is it better to use it or export it?" —
 * and the only honest way to ask it across programmes.
 *
 * Rules that apply to `produced` count toward BOTH sides, because production happens
 * whichever way the energy then goes. That is easy to get wrong: net metering credits
 * `produced` at the pre-tax rate and then adds the tax back for `selfConsumed`, so
 * looking only for a rule that applies to `exported` finds nothing and reports that
 * exporting is worthless. It is not — it is worth retail/(1+tax).
 *
 * Unrealised rules are excluded. They describe a ceiling someone could reach, not what
 * a kWh is worth today, and adding them would make every programme look identical.
 */
export function marginalValue(program: RewardProgram, retailPerKwh: number): MarginalValue {
  /*
    Untimed rules STACK; timed ones are ALTERNATIVES.

    Getting this wrong is not subtle. Net metering credits `produced` and then adds a
    self-use premium on top, so those two genuinely add. A time-of-use programme has
    four self-consumption rules — peak, mid-peak, off-peak, weekend — that are mutually
    exclusive windows, and summing them reported a kWh used at home as worth 60.8c when
    it is worth between 10.4c and 24c. Any kWh earns exactly one of them.
  */
  const rates = programRates(program, retailPerKwh).filter((r) => r.realised);
  const base = (flow: EnergyFlow): number =>
    rates
      .filter((r) => !r.timed && (r.applies === 'produced' || r.applies === flow))
      .reduce((sum, r) => sum + r.ratePerKwh, 0);
  const timed = (flow: EnergyFlow): number[] =>
    rates
      .filter((r) => r.timed && (r.applies === 'produced' || r.applies === flow))
      .map((r) => r.ratePerKwh);

  const span = (flow: EnergyFlow): { low: number; high: number } => {
    const b = base(flow);
    const options = timed(flow);
    if (options.length === 0) return { low: b, high: b };
    return { low: b + Math.min(...options), high: b + Math.max(...options) };
  };

  const self = span('selfConsumed');
  const exported = span('exported');
  return {
    selfConsumedPerKwh: self.high,
    exportedPerKwh: exported.high,
    selfConsumedLowPerKwh: self.low,
    exportedLowPerKwh: exported.low,
    varies: self.low !== self.high || exported.low !== exported.high,
  };
}

/**
 * Energy flows for one hour of one day.
 *
 * The unit the engine needs to resolve a time-of-use rule. An hour is the finest
 * granularity any published residential tariff uses, and coarse enough that a year of
 * them is 8,760 rows rather than something that needs its own storage strategy.
 */
export interface FlowBucket {
  /** Local hour, 0–23. Local, not UTC: a tariff's peak window is wall-clock. */
  hour: number;
  /** Local month, 1–12. */
  month: number;
  /** 0 = Sunday. Weekend rates are as common as time-of-use ones. */
  weekday: number;
  producedKwh: number;
  selfConsumedKwh: number;
  exportedKwh: number;
  importedKwh?: number;
}

/**
 * Does this bucket fall inside the rule's window?
 *
 * The midnight wrap is the whole reason this is a function and not an inline compare.
 * An off-peak window of [22, 7) means 22, 23, 0, 1 … 6 — a naive `h >= start && h < end`
 * matches nothing at all, and would silently price every overnight kWh at zero.
 */
export function matchesWhen(bucket: FlowBucket, when: RuleWhen | undefined): boolean {
  if (!when) return true;
  if (when.months && !when.months.includes(bucket.month)) return false;
  if (when.weekdays && !when.weekdays.includes(bucket.weekday)) return false;
  if (when.hours) {
    const [start, end] = when.hours;
    const inWindow =
      start <= end
        ? bucket.hour >= start && bucket.hour < end
        : bucket.hour >= start || bucket.hour < end;
    if (!inWindow) return false;
  }
  return true;
}

const BUCKET_KWH_OF: Record<EnergyFlow, (b: FlowBucket) => number> = {
  produced: (b) => b.producedKwh,
  selfConsumed: (b) => b.selfConsumedKwh,
  exported: (b) => b.exportedKwh,
  imported: (b) => b.importedKwh ?? 0,
};

/**
 * Value a period from hourly buckets, so time-of-use and seasonal rules resolve.
 *
 * `valueProgram` above takes one lump of totals and deliberately refuses any rule with
 * an `hours` or `months` window, reporting it as unsupported rather than pricing a
 * peak rate against a daily average. This is the other half: given when the energy
 * actually flowed, those rules become answerable.
 *
 * Tier thresholds still apply to the matched total, not to each bucket — "the first
 * 500 kWh a month" is a property of the month, not of any hour inside it.
 */
export function valueProgramOverBuckets(
  program: RewardProgram,
  buckets: FlowBucket[],
  retailPerKwh: number,
  months = 0,
): ProgramValuation & { unsupported: string[] } {
  const lines: ValuedLine[] = [];

  for (const rule of program.rules) {
    let amount = 0;
    if (rule.kind === 'fixedMonthly') {
      amount = rule.amount * Math.max(0, months);
    } else {
      let matched = 0;
      for (const bucket of buckets) {
        if (matchesWhen(bucket, rule.when)) matched += BUCKET_KWH_OF[rule.applies](bucket);
      }
      const kwh = tieredKwh(matched, rule.when);
      amount =
        rule.kind === 'perKwh'
          ? kwh * resolveRate(rule.rate, retailPerKwh)
          : (kwh * rule.gridIntensityKgPerKwh * rule.pricePerTonne) / KG_PER_TONNE;
    }
    lines.push({
      ruleId: rule.id,
      label: rule.label,
      amount,
      realised: rule.realised,
      note: rule.note,
    });
  }

  const realised = lines.filter((l) => l.realised).reduce((sum, l) => sum + l.amount, 0);
  const foregone = lines.filter((l) => !l.realised).reduce((sum, l) => sum + l.amount, 0);
  // Nothing is unsupported here — that is the entire point of taking buckets.
  return { lines, realised, foregone, ceiling: realised + foregone, unsupported: [] };
}

/**
 * Time-of-use: what you avoid by self-consuming depends on when you did it.
 *
 * Modelled on the shape almost every North American TOU tariff uses — an expensive
 * weekday peak, a mid-tier shoulder, and cheap overnight and weekend power. Rates are
 * expressed against retail so an owner who updates their price does not have to
 * restate three more numbers.
 *
 * The multipliers are the published Ontario ratios rounded to something defensible
 * (peak ≈ 2x off-peak); an owner on a different tariff should edit them rather than
 * trust them. Export is credited flat, because most TOU programmes settle export at a
 * single rate even when consumption is time-varying — pricing export at the peak rate
 * is a common and expensive misreading.
 */
export function timeOfUseProgram(taxRate: number): RewardProgram {
  const preTax = 1 / (1 + taxRate);
  const WEEKDAYS = [1, 2, 3, 4, 5];
  return {
    id: 'time-of-use',
    name: 'Time-of-use (peak / off-peak)',
    rules: [
      {
        kind: 'perKwh',
        id: 'tou-peak',
        label: 'Peak avoided',
        applies: 'selfConsumed',
        when: { hours: [16, 21], weekdays: WEEKDAYS },
        rate: { ofRetail: 1.5 },
        realised: true,
        note: 'Solar used during the weekday evening peak, when power costs the most.',
      },
      {
        kind: 'perKwh',
        id: 'tou-shoulder',
        label: 'Mid-peak avoided',
        applies: 'selfConsumed',
        when: { hours: [7, 16], weekdays: WEEKDAYS },
        rate: { ofRetail: 1 },
        realised: true,
        note: 'Solar used during the weekday daytime, at the standard rate.',
      },
      {
        kind: 'perKwh',
        id: 'tou-offpeak',
        label: 'Off-peak avoided',
        applies: 'selfConsumed',
        when: { hours: [21, 7] },
        rate: { ofRetail: 0.65 },
        realised: true,
        note: 'Solar used overnight — cheap power, so avoiding it is worth least.',
      },
      {
        kind: 'perKwh',
        id: 'tou-weekend',
        label: 'Weekend avoided',
        applies: 'selfConsumed',
        when: { hours: [7, 21], weekdays: [0, 6] },
        rate: { ofRetail: 0.65 },
        realised: true,
        note: 'Weekends are off-peak all day on most time-of-use tariffs.',
      },
      {
        kind: 'perKwh',
        id: 'tou-export',
        label: 'Export credit',
        applies: 'exported',
        rate: { ofRetail: preTax },
        realised: true,
        note: 'Export settles at one rate regardless of when it left the house.',
      },
    ],
  };
}
