import { describe, expect, it } from 'vitest';
import { buildCensus, estimatePanelWatts } from '../src/system/array-census';

const base = {
  reportingPanels: 38,
  expectedInverters: 12,
  reportingInverters: 11,
  portsPerInverter: [4, 4, 4, 4, 4, 4, 4, 4, 4, 1, 1],
  contract: null,
  observedPeakW: 14142,
  daysObserved: 30,
};
const nameplate = (over: Partial<Parameters<typeof buildCensus>[0]>): string =>
  buildCensus({ ...base, configuredRatedKw: 24, registeredPanels: 42, observedPeakPerPanelW: 387,
  daysObserved: 30, ...over })
    .findings.find((f) => f.id === 'nameplate-vs-panel-count')?.headline ?? '(silent)';

describe('what the census can and cannot catch', () => {
  it('says nothing at all when no rated size was ever configured', () => {
    // The check compares a configured claim against the hardware: no claim, no check.
    expect(nameplate({ configuredRatedKw: null })).toBe('(silent)');
  });

  it('misses a nameplate that is wrong by only two panels', () => {
    // 24 kW implies 48 panels against 46 registered — 4.2%, under the 5% floor. A 1 kW
    // nameplate error is not detectable on its own.
    expect(nameplate({ registeredPanels: 46 })).toBe('(silent)');
  });

  it('stays quiet in the first days rather than guessing loudly', () => {
    // A cloudy first day peaks a panel at 250 W, sizing it at 325 and implying a 74-panel
    // array, so the check needs at least five days of observation.
    expect(estimatePanelWatts(250)).toBe(325);
    expect(nameplate({ observedPeakPerPanelW: 250, daysObserved: 2 })).toBe('(silent)');
    expect(nameplate({ daysObserved: 4 })).toBe('(silent)');
    expect(nameplate({ daysObserved: 5 })).toBe('24 kW needs 48 panels; your gateway has 42');
  });

  it('names the right count only once a panel has seen a genuinely good hour', () => {
    // The estimate is coarse — 370 W reads as a 475 W panel, 410 W as 525 W — so only the
    // direction (more panels than the gateway has) is asserted across the range.
    expect(estimatePanelWatts(370)).toBe(475);
    expect(estimatePanelWatts(387)).toBe(500);
    expect(estimatePanelWatts(410)).toBe(525);
    for (const peak of [300, 340, 370, 387, 410]) {
      expect(nameplate({ observedPeakPerPanelW: peak }), `peak ${peak}`).toMatch(
        /needs [0-9]+ panels; your gateway has 42/,
      );
    }
  });

  it('needs the contract to name the four unregistered panels', () => {
    const blind = buildCensus({ ...base, configuredRatedKw: 23, registeredPanels: 42, observedPeakPerPanelW: 387 });
    expect(blind.findings.find((f) => f.id === 'panels-unregistered')).toBeUndefined();
    const told = buildCensus({
      ...base,
      configuredRatedKw: 23,
      registeredPanels: 42,
      observedPeakPerPanelW: 387,
  daysObserved: 30,
      contract: { panels: 46, wattsPerPanel: 500 },
    });
    expect(told.findings.find((f) => f.id === 'panels-unregistered')?.headline).toBe(
      '4 panels your gateway has never seen',
    );
  });
});
