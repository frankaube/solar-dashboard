import { describe, expect, it } from 'vitest';
import { parseEcoFlowQuota } from '../src/battery/ecoflow.client';
import { DEMO_FIXTURES, fixtureCatalogue, findFixture } from '../src/demo/fixtures';

// Fixtures go through the same parser production uses: it is the only feedback available
// for hardware nobody here owns.
describe('demo fixtures run through the real parser', () => {
  it('parses a mid-charge DELTA Pro', () => {
    const state = parseEcoFlowQuota(findFixture('ecoflow-delta-pro')!.payload);
    expect(state).toMatchObject({ present: true, soc: 64, cycles: 143, reservePct: 15 });
    // 1180 W in, 240 W out -> net charging.
    expect(state!.powerW).toBe(940);
    expect(state!.capacityKwh).toBeCloseTo(3.6, 3);
  });

  it('gives a negative power when discharging, not an absolute value', () => {
    // Sign convention: discharging at 780 W must not render identically to charging at 780 W.
    const state = parseEcoFlowQuota(findFixture('ecoflow-discharging')!.payload);
    expect(state!.powerW).toBe(-780);
    expect(state!.soc).toBe(31);
  });

  it('parses the Smart Home Panel 2 from its own field tree', () => {
    // SHP2 uses neither pd.wattsInSum nor bms_bmsStatus.soc; falling through every
    // candidate yields a confident 0% at 0 W.
    const state = parseEcoFlowQuota(findFixture('ecoflow-shp2')!.payload);
    expect(state).toMatchObject({ present: true, soc: 78, reservePct: 20 });
    // Two packs discharging at 820 + 720 W.
    expect(state!.powerW).toBe(-1540);
  });

  it('returns null for a payload it does not understand', () => {
    // Reachable but unparseable must stay null; 0% would be a confident lie about a
    // battery that might be full.
    expect(parseEcoFlowQuota(findFixture('ecoflow-unrecognised')!.payload)).toBeNull();
  });
});

describe('fixture catalogue integrity', () => {
  it('gives every fixture a unique id', () => {
    const ids = DEMO_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('requires a provenance and a source citation on every fixture', () => {
    // A fixture with no stated origin is a guess; adding one without a citation must fail.
    for (const f of DEMO_FIXTURES) {
      expect(['captured', 'documented', 'synthetic']).toContain(f.provenance);
      expect(f.source.trim().length).toBeGreaterThan(20);
    }
  });

  it('claims nothing as captured that was not recorded from hardware', () => {
    // None of these came off a real device. Promoting one to `captured` must be a
    // deliberate act, so it has to change this test too.
    expect(DEMO_FIXTURES.filter((f) => f.provenance === 'captured')).toHaveLength(0);
  });

  it('omits payloads from the catalogue so the picker stays small', () => {
    const listed = fixtureCatalogue();
    expect(listed).toHaveLength(DEMO_FIXTURES.length);
    expect(listed.every((f) => !('payload' in f))).toBe(true);
  });

  it('returns undefined for an unknown or missing id', () => {
    expect(findFixture('nope')).toBeUndefined();
    expect(findFixture(undefined)).toBeUndefined();
  });
});
