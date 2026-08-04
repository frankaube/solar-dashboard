import { describe, expect, it } from 'vitest';
import { parseStorageModel } from '../src/battery/sunspec-battery';

/**
 * Build a register map containing one model block.
 *
 * There is no battery here to try this against, so a synthetic block is the only thing
 * that can hold the parser to account — which is exactly why this vendor declares
 * `documented` rather than `verified` confidence. These tests prove we read the
 * specification correctly. They prove nothing about what a real device sends.
 */
function mapWith(modelId: number, payload: number[], length = payload.length): Buffer {
  // Register 0-1 would be the "SunS" marker in a real map; findModel starts at 2.
  const words = [0x5375, 0x6e53, modelId, length, ...payload, 0xffff];
  const buf = Buffer.alloc(words.length * 2);
  words.forEach((w, i) => buf.writeUInt16BE(w & 0xffff, i * 2));
  return buf;
}

/** Payload laid out at the offsets the 802 model defines. */
function storagePayload(over: Partial<Record<string, number>> = {}): number[] {
  const p = new Array(24).fill(0);
  const put = (offsetFromBlockStart: number, value: number): void => {
    // OFFSET values are from the model id word; payload starts 2 words later.
    p[offsetFromBlockStart - 2] = value;
  };
  put(2, 0);        // wHRtg
  put(3, 0);        // wHRtgSf
  put(12, 0);       // soc
  put(13, 0);       // socSf
  put(16, 0);       // cycleCount hi
  put(17, 0);       // cycleCount lo
  put(20, 0);       // dcW
  put(21, 0);       // dcWSf
  for (const [k, v] of Object.entries(over)) p[Number(k) - 2] = v!;
  return p;
}

describe('parseStorageModel', () => {
  it('reads state of charge', () => {
    const data = mapWith(802, storagePayload({ 12: 73 }));
    expect(parseStorageModel(data, 2)?.soc).toBe(73);
  });

  it('applies the scale factor rather than reporting the raw value', () => {
    // 735 with sf -1 is 73.5%, not 735%.
    const data = mapWith(802, storagePayload({ 12: 735, 13: 0xffff }));
    expect(parseStorageModel(data, 2)?.soc).toBeCloseTo(73.5, 6);
  });

  it('reads charging as positive and discharging as negative', () => {
    const charging = mapWith(802, storagePayload({ 20: 2500 }));
    expect(parseStorageModel(charging, 2)?.powerW).toBe(2500);
    // -1400 W as a signed 16-bit word.
    const discharging = mapWith(802, storagePayload({ 20: 0x10000 - 1400 }));
    expect(parseStorageModel(discharging, 2)?.powerW).toBe(-1400);
  });

  it('treats the not-implemented sentinel as zero power, not -32768 W', () => {
    /*
      0x8000 is SunSpec's "not implemented" for a signed 16-bit field. Reading it as a
      number reports a 32 kW discharge — a plausible-looking figure from a device that
      simply did not answer.
    */
    const data = mapWith(802, storagePayload({ 20: 0x8000 }));
    expect(parseStorageModel(data, 2)?.powerW).toBe(0);
  });

  it('reports capacity in kWh from the Wh nameplate', () => {
    const data = mapWith(802, storagePayload({ 12: 50, 2: 13500 }));
    expect(parseStorageModel(data, 2)?.capacityKwh).toBeCloseTo(13.5, 6);
  });

  it('reports capacity as null when the device does not implement it', () => {
    // Not the same as zero: a battery of unknown size is not a battery of no size.
    const data = mapWith(802, storagePayload({ 12: 50, 2: 0xffff }));
    expect(parseStorageModel(data, 2)?.capacityKwh).toBeNull();
  });

  it('clamps a nonsense state of charge into range', () => {
    const data = mapWith(802, storagePayload({ 12: 65000 }));
    const soc = parseStorageModel(data, 2)!.soc;
    expect(soc).toBeGreaterThanOrEqual(0);
    expect(soc).toBeLessThanOrEqual(100);
  });

  it('accepts the chemistry-specific models, not only the base one', () => {
    for (const id of [802, 803, 804, 805]) {
      expect(parseStorageModel(mapWith(id, storagePayload({ 12: 42 })), 2)?.modelId).toBe(id);
    }
  });

  it('returns null for a device with no storage model', () => {
    // An inverter without a battery: model 103 and nothing else.
    expect(parseStorageModel(mapWith(103, new Array(50).fill(0)), 2)).toBeNull();
  });

  it('returns null rather than throwing on a truncated map', () => {
    const full = mapWith(802, storagePayload({ 12: 60 }));
    expect(() => parseStorageModel(full.subarray(0, 10), 2)).not.toThrow();
  });

  it('reads the cycle count as a 32-bit value', () => {
    // 100000 cycles = 0x000186A0, split across two registers.
    const data = mapWith(802, storagePayload({ 12: 50, 16: 0x0001, 17: 0x86a0 }));
    expect(parseStorageModel(data, 2)?.cycles).toBe(100000);
  });
});
