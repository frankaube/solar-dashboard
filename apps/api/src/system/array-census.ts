/**
 * Reconciles four claims about array size: configured rating, gateway-registered count,
 * panels sending detail, and measured production. THE LIMIT: a gateway cannot report
 * hardware it has never heard of — such panels are absent from its totals, so only
 * `contract` can reveal them.
 */

/** Panel wattages that are actually sold. Used to sanity-check an implied size. */
const PLAUSIBLE_PANEL_W = { min: 150, max: 800 };

/**
 * Real panels top out at 75–85% of rated watts, so an observed peak over ~0.78 estimates
 * the nameplate. Round-size arithmetic fails: 24 kW over 42 panels is 571.4 W → 570.
 */
const TYPICAL_PANEL_PEAK_RATIO = 0.78;

/** Panels are sold in 25 W steps at residential sizes; snap the estimate to one. */
const PANEL_SIZE_STEP = 25;

/** Ignore a panel-count disagreement smaller than this — estimates are estimates. */
const PANEL_COUNT_TOLERANCE = 2;

/**
 * Days before the panel-size estimate is worth acting on: a 250 W peak sizes a panel at
 * 325 W and implies 74 panels; by 380–400 W it lands on 500 W and the count is right.
 */
const MIN_DAYS_FOR_SIZING = 5;

/**
 * DC nameplate is rated at 1000 W/m² and 25 °C, which does not happen on a roof; real
 * arrays peak at 75–85% of it. Below 65%, something is not contributing.
 */
const PEAK_RATIO_FLOOR = 0.65;

export interface CensusInput {
  /** Rated kW the owner configured, if any. */
  configuredRatedKw: number | null;
  /** Panels the gateway says are registered (AppInfo-style count). */
  registeredPanels: number | null;
  /** Panels we hold per-panel data for. */
  reportingPanels: number;
  /** Inverters the gateway says exist, and how many send detail. */
  expectedInverters: number | null;
  reportingInverters: number;
  /** Ports per reporting inverter, to spot a unit shaped unlike the rest of the fleet. */
  portsPerInverter: number[];
  /** What the owner's paperwork says. The only source that can see unregistered panels. */
  contract: { panels: number; wattsPerPanel: number } | null;
  /** Best instantaneous output ever recorded for the whole array, in watts. */
  observedPeakW: number | null;
  /** Best a single panel has ever produced. This is what sizes the panels. */
  observedPeakPerPanelW: number | null;
  /** Distinct days of data. Too few and the peak above has not been earned yet. */
  daysObserved: number;
}

export type CensusSeverity = 'info' | 'warning' | 'serious';

export interface CensusFinding {
  id: string;
  severity: CensusSeverity;
  headline: string;
  detail: string;
}

export interface Census {
  /** What each source claims, for display side by side. */
  claims: Array<{ source: string; panels: number | null; ratedKw: number | null }>;
  findings: CensusFinding[];
  /** The size we believe, and why. Null when nothing is trustworthy enough to say. */
  believedRatedKw: number | null;
  believedFrom: string | null;
}

function round(value: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/** Panel size from its best recorded output, snapped to a size panels are sold at. */
export function estimatePanelWatts(observedPeakPerPanelW: number): number {
  const raw = observedPeakPerPanelW / TYPICAL_PANEL_PEAK_RATIO;
  return Math.round(raw / PANEL_SIZE_STEP) * PANEL_SIZE_STEP;
}

export function buildCensus(input: CensusInput): Census {
  const findings: CensusFinding[] = [];
  const {
    configuredRatedKw,
    registeredPanels,
    reportingPanels,
    expectedInverters,
    reportingInverters,
    portsPerInverter,
    contract,
    observedPeakW,
    observedPeakPerPanelW,
    daysObserved,
  } = input;

  const contractKw = contract ? (contract.panels * contract.wattsPerPanel) / 1000 : null;

  const claims = [
    { source: 'You configured', panels: null as number | null, ratedKw: configuredRatedKw },
    { source: 'Your paperwork', panels: contract?.panels ?? null, ratedKw: contractKw },
    { source: 'Gateway registered', panels: registeredPanels, ratedKw: null as number | null },
    { source: 'Sending detail', panels: reportingPanels, ratedKw: null as number | null },
  ];

  // The one check that can see panels the gateway cannot.
  if (contract && registeredPanels !== null && contract.panels > registeredPanels) {
    const missing = contract.panels - registeredPanels;
    findings.push({
      id: 'panels-unregistered',
      severity: 'serious',
      headline: `${missing} panel${missing === 1 ? '' : 's'} your gateway has never seen`,
      detail:
        `Your paperwork lists ${contract.panels} panels; the gateway has ${registeredPanels} registered. ` +
        `A gateway cannot report hardware it does not know about, so ${missing} panel${missing === 1 ? "'s" : "s'"} ` +
        `output is missing from every figure in this app — not hidden, absent. Ask your installer to ` +
        `check whether ${missing === 1 ? 'that panel is' : 'those panels are'} wired to a microinverter that was ever paired with the gateway.`,
    });
  }

  if (registeredPanels !== null && reportingPanels < registeredPanels) {
    const silent = registeredPanels - reportingPanels;
    findings.push({
      id: 'panels-silent',
      severity: 'warning',
      headline: `${silent} registered panel${silent === 1 ? '' : 's'} send no detail`,
      detail:
        `The gateway counts ${registeredPanels} panels but only ${reportingPanels} appear in the per-panel data. ` +
        `Their output is usually still inside the system total, so energy and savings stay right — ` +
        `but you cannot see those panels individually, and a fault on one of them would go unnoticed.`,
    });
  }

  if (expectedInverters !== null && reportingInverters < expectedInverters) {
    const quiet = expectedInverters - reportingInverters;
    findings.push({
      id: 'inverters-silent',
      severity: 'warning',
      headline: `${quiet} of ${expectedInverters} inverters send no detail`,
      detail: `${reportingInverters} inverters report per-unit data. The rest are registered but quiet.`,
    });
  }

  // Identical microinverters should have identical port counts.
  if (portsPerInverter.length >= 3) {
    const sorted = [...portsPerInverter].sort((a, b) => b - a);
    const typical = sorted[Math.floor(sorted.length / 2)];
    const odd = portsPerInverter.filter((count) => count < typical);
    if (odd.length && typical > 1) {
      const shortfall = odd.reduce((sum, count) => sum + (typical - count), 0);
      findings.push({
        id: 'inverter-port-shape',
        severity: 'warning',
        headline: `${odd.length} inverter${odd.length === 1 ? ' has' : 's have'} fewer panels than the rest`,
        detail:
          `Most of your inverters carry ${typical} panels; ${odd.length} carr${odd.length === 1 ? 'ies' : 'y'} ` +
          `${odd.join(', ')}. If they are the same model, that is ${shortfall} panel${shortfall === 1 ? '' : 's'} ` +
          `either unwired or not reporting.`,
      });
    }
  }

  // Nameplate against telemetry: panel size implies a count the gateway either has or not.
  const sizedEnough = daysObserved >= MIN_DAYS_FOR_SIZING;
  const panelW = observedPeakPerPanelW && sizedEnough ? estimatePanelWatts(observedPeakPerPanelW) : null;
  if (
    configuredRatedKw &&
    registeredPanels &&
    panelW &&
    panelW >= PLAUSIBLE_PANEL_W.min &&
    panelW <= PLAUSIBLE_PANEL_W.max
  ) {
    const impliedPanels = Math.round((configuredRatedKw * 1000) / panelW);
    const diff = impliedPanels - registeredPanels;
    const relative = Math.abs(diff) / impliedPanels;
    if (Math.abs(diff) >= PANEL_COUNT_TOLERANCE && relative >= 0.05) {
      findings.push({
        id: 'nameplate-vs-panel-count',
        severity: 'serious',
        headline:
          diff > 0
            ? `${configuredRatedKw} kW needs ${impliedPanels} panels; your gateway has ${registeredPanels}`
            : `${configuredRatedKw} kW only accounts for ${impliedPanels} of your ${registeredPanels} panels`,
        detail:
          `Your best-performing panel has reached ${Math.round(observedPeakPerPanelW!)} W, which makes it about a ` +
          `${panelW} W panel. At that size ${configuredRatedKw} kW would be ${impliedPanels} panels, but the gateway ` +
          `has ${registeredPanels} registered — a difference of ${Math.abs(diff)}. ` +
          `Either ${Math.abs(diff)} panel${Math.abs(diff) === 1 ? ' is' : 's are'} missing from the gateway, or your ` +
          `array is ${round((registeredPanels * panelW) / 1000, 2)} kW rather than ${configuredRatedKw} kW. ` +
          `Worth settling against your contract — every dollar figure here scales off that number.`,
      });
    }
  }

  if (configuredRatedKw && contractKw && Math.abs(configuredRatedKw - contractKw) > 0.05) {
    findings.push({
      id: 'nameplate-disagrees-with-paperwork',
      severity: 'warning',
      headline: `Rated size says ${configuredRatedKw} kW, your paperwork says ${round(contractKw, 2)} kW`,
      detail:
        `${contract!.panels} panels × ${contract!.wattsPerPanel} W is ${round(contractKw, 2)} kW. ` +
        `Every dollar and percentage figure in this app scales off the rated size, so the wrong one ` +
        `quietly biases your capacity gauge and payback.`,
    });
  }

  // Physics rather than paperwork, and generous: a shaded roof is not a fault.
  if (configuredRatedKw && observedPeakW && observedPeakW > 0) {
    const ratio = observedPeakW / (configuredRatedKw * 1000);
    if (ratio < PEAK_RATIO_FLOOR) {
      findings.push({
        id: 'peak-below-nameplate',
        severity: 'info',
        headline: `Best output ever is ${Math.round(ratio * 100)}% of the rated size`,
        detail:
          `Peak recorded is ${round(observedPeakW / 1000, 2)} kW against a configured ${configuredRatedKw} kW. ` +
          `Arrays usually reach 75–85% of nameplate at their best. Shading or orientation can explain this, ` +
          `but so can a rated size that is too high or panels that are not contributing.`,
      });
    }
  }

  // Paperwork beats the portal, which beats arithmetic on a count that may be short.
  let believedRatedKw: number | null = null;
  let believedFrom: string | null = null;
  if (contractKw) {
    believedRatedKw = round(contractKw, 2);
    believedFrom = 'your paperwork';
  } else if (configuredRatedKw && !findings.some((f) => f.id === 'nameplate-vs-panel-count')) {
    believedRatedKw = configuredRatedKw;
    believedFrom = 'the rated size you configured';
  }

  return { claims, findings, believedRatedKw, believedFrom };
}
