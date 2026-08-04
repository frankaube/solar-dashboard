import { describe, expect, it } from 'vitest';
import { buildCensus } from '../src/system/array-census';

/**
 * A measured array, not an invented one — the shape that exposed every finding below.
 *
 * Nine four-port inverters and two single-port ones, with four registered panels not
 * reporting. Kept as recorded because the interesting cases here are the ones a tidy
 * fixture would not produce: a nameplate that disagrees with the panel count, and a
 * port layout that is not uniform.
 */
const REAL = {
  configuredRatedKw: 24,
  registeredPanels: 42,
  reportingPanels: 38,
  expectedInverters: 12,
  reportingInverters: 11,
  portsPerInverter: [4, 4, 4, 4, 4, 4, 4, 4, 4, 1, 1],
  observedPeakW: 14142,
  observedPeakPerPanelW: 387,
  daysObserved: 30,
};

describe('the census against the install that motivated it', () => {
  it('flags 24 kW over 42 panels without any paperwork at all', () => {
    /*
      The whole point. From telemetry alone — no contract, no installer — the best a
      single panel ever managed sizes it at 500 W, 24 kW would then need 48 panels, and
      the gateway has 42. That is the sentence that starts the right conversation.
    */
    const census = buildCensus({ ...REAL, contract: null });
    const finding = census.findings.find((f) => f.id === 'nameplate-vs-panel-count');
    expect(finding?.severity).toBe('serious');
    expect(finding?.headline).toBe('24 kW needs 48 panels; your gateway has 42');
    expect(finding?.detail).toContain('about a 500 W panel');
    expect(finding?.detail).toContain('21 kW');
  });

  it('still flags the four unregistered panels after the nameplate is corrected to 23 kW', () => {
    // Fixing the rated size must not silence the real fault underneath it.
    const census = buildCensus({ ...REAL, configuredRatedKw: 23, contract: null });
    const finding = census.findings.find((f) => f.id === 'nameplate-vs-panel-count');
    expect(finding?.headline).toBe('23 kW needs 46 panels; your gateway has 42');
  });

  it('goes quiet once the numbers actually agree', () => {
    const census = buildCensus({ ...REAL, configuredRatedKw: 21, contract: null });
    expect(census.findings.find((f) => f.id === 'nameplate-vs-panel-count')).toBeUndefined();
  });

  it('finds the four panels the gateway never knew about, once the contract is entered', () => {
    const census = buildCensus({ ...REAL, contract: { panels: 46, wattsPerPanel: 500 } });
    const finding = census.findings.find((f) => f.id === 'panels-unregistered');
    expect(finding?.severity).toBe('serious');
    expect(finding?.headline).toBe('4 panels your gateway has never seen');
  });

  it('separates them from the four that are registered but silent', () => {
    // Two different faults with two different fixes; one message covering both would
    // have sent someone looking for the wrong thing.
    const census = buildCensus({ ...REAL, contract: { panels: 46, wattsPerPanel: 500 } });
    expect(census.findings.find((f) => f.id === 'panels-silent')?.headline).toBe(
      '4 registered panels send no detail',
    );
  });

  it('spots the two odd inverters from their shape alone', () => {
    const census = buildCensus({ ...REAL, contract: null });
    const finding = census.findings.find((f) => f.id === 'inverter-port-shape');
    expect(finding?.headline).toBe('2 inverters have fewer panels than the rest');
    expect(finding?.detail).toContain('6 panels');
  });

  it('names 23 kW as the size to believe', () => {
    const census = buildCensus({ ...REAL, contract: { panels: 46, wattsPerPanel: 500 } });
    expect(census.believedRatedKw).toBe(23);
    expect(census.believedFrom).toBe('your paperwork');
  });

  it('says the configured size disagrees with the paperwork', () => {
    const census = buildCensus({ ...REAL, contract: { panels: 46, wattsPerPanel: 500 } });
    expect(census.findings.find((f) => f.id === 'nameplate-disagrees-with-paperwork')).toBeDefined();
  });
});

describe('what reaches a phone', () => {
  /*
    Only "serious" findings become alerts. The silent-panel and odd-inverter findings are
    true of this install every minute of every day — as notifications they would be a
    permanent unread badge, which is how someone learns to ignore the next one. They
    belong on the page, not in a text message.
  */
  const REAL_WITH_CONTRACT = {
    configuredRatedKw: 23,
    registeredPanels: 42,
    reportingPanels: 38,
    expectedInverters: 12,
    reportingInverters: 11,
    portsPerInverter: [4, 4, 4, 4, 4, 4, 4, 4, 4, 1, 1],
    observedPeakW: 14142,
    observedPeakPerPanelW: 387,
  daysObserved: 30,
    contract: { panels: 46, wattsPerPanel: 500 },
  };

  it('alerts on the two findings that need action, and no others', () => {
    const serious = buildCensus(REAL_WITH_CONTRACT)
      .findings.filter((f) => f.severity === 'serious')
      .map((f) => f.id)
      .sort();
    expect(serious).toEqual(['nameplate-vs-panel-count', 'panels-unregistered']);
  });

  it('goes completely quiet on an install where everything lines up', () => {
    // 40 panels at 500 W, all registered, all reporting, peaking where they should.
    const healthy = buildCensus({
      configuredRatedKw: 20,
      registeredPanels: 40,
      reportingPanels: 40,
      expectedInverters: 10,
      reportingInverters: 10,
      portsPerInverter: Array(10).fill(4),
      observedPeakW: 16000,
      observedPeakPerPanelW: 390,
      daysObserved: 30,
      contract: { panels: 40, wattsPerPanel: 500 },
    });
    expect(healthy.findings).toEqual([]);
    expect(healthy.believedRatedKw).toBe(20);
  });
});
