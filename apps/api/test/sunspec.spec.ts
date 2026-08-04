import { describe, expect, it } from 'vitest';
import {
  applyScale,
  buildReadRequest,
  findModel,
  MAX_REGISTERS_PER_READ,
  parseCommonModel,
  parseInverterModel,
  parseReadResponse,
  readString,
} from '../src/devices/sunspec';

/** Pack an ASCII string into a fixed number of registers, null-padded like a device. */
function packString(text: string, registerCount: number): Buffer {
  const buf = Buffer.alloc(registerCount * 2);
  buf.write(text.slice(0, registerCount * 2), 'ascii');
  return buf;
}

/** A Common Model block as a compliant inverter would present it. */
function commonModel(
  manufacturer = 'Fronius',
  model = 'Primo 8.2-1',
  version = '1.2.3',
  serial = 'SN12345678',
): Buffer {
  const data = Buffer.alloc(70 * 2);
  data.write('SunS', 0, 'ascii');
  data.writeUInt16BE(1, 4); // model id 1 = Common
  data.writeUInt16BE(66, 6); // length
  packString(manufacturer, 16).copy(data, 8);
  packString(model, 16).copy(data, 40);
  packString(version, 8).copy(data, 88);
  packString(serial, 16).copy(data, 104);
  return data;
}

/** Wrap register data in a Modbus TCP response frame. */
function response(data: Buffer, fn = 0x03): Buffer {
  const head = Buffer.alloc(9);
  head.writeUInt16BE(1, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(3 + data.length, 4);
  head.writeUInt8(1, 6);
  head.writeUInt8(fn, 7);
  head.writeUInt8(data.length, 8);
  return Buffer.concat([head, data]);
}

describe('Modbus TCP framing', () => {
  it('builds a read-holding-registers request', () => {
    const req = buildReadRequest(7, 1, 40000, 70);
    expect(req.readUInt16BE(0)).toBe(7); // transaction id
    expect(req.readUInt16BE(2)).toBe(0); // protocol id is always 0
    expect(req.readUInt16BE(4)).toBe(6); // length of what follows
    expect(req.readUInt8(7)).toBe(0x03);
    expect(req.readUInt16BE(8)).toBe(40000);
    expect(req.readUInt16BE(10)).toBe(70);
  });

  it('extracts the register payload from a response', () => {
    const data = Buffer.from([0x00, 0x2a, 0x00, 0x2b]);
    expect(parseReadResponse(response(data))).toEqual(data);
  });

  it('treats a Modbus exception as no answer, not a crash', () => {
    // A device with no register at that address replies with the function code plus
    // the high bit set. Entirely normal — we try the next base address.
    expect(parseReadResponse(response(Buffer.from([0x02]), 0x83))).toBeNull();
  });

  it('rejects frames that are not Modbus TCP', () => {
    const notModbus = response(Buffer.from([0x00, 0x01]));
    notModbus.writeUInt16BE(9, 2); // non-zero protocol id
    expect(parseReadResponse(notModbus)).toBeNull();
  });

  it('rejects a truncated frame rather than reading past the end', () => {
    // Embedded stacks split frames; a half-arrived response must not be parsed.
    const full = response(commonModel());
    expect(parseReadResponse(full.subarray(0, 20))).toBeNull();
    expect(parseReadResponse(Buffer.alloc(4))).toBeNull();
  });
});

describe('Modbus read limits', () => {
  it('caps a single read at 125 registers', () => {
    // The response byte-count field is ONE byte, so 125 registers (250 bytes) is the
    // hard ceiling. This was originally wrong — the client asked for 190 and a
    // simulated inverter crashed encoding a 380-byte count, which on real hardware
    // would have come back as an exception and read as "no SunSpec device here".
    expect(MAX_REGISTERS_PER_READ).toBe(125);
    expect(MAX_REGISTERS_PER_READ * 2).toBeLessThanOrEqual(255);
  });

  it('keeps identification inside one round trip', () => {
    // Discovery reads the Common Model in a single request; if that ever grew past
    // the limit it would silently start costing two.
    const req = buildReadRequest(1, 1, 40000, 70);
    expect(req.readUInt16BE(10)).toBeLessThanOrEqual(MAX_REGISTERS_PER_READ);
  });
});

describe('SunSpec Common Model', () => {
  it('identifies a compliant inverter', () => {
    const info = parseCommonModel(commonModel(), 40000)!;
    expect(info).toMatchObject({
      manufacturer: 'Fronius',
      model: 'Primo 8.2-1',
      version: '1.2.3',
      serial: 'SN12345678',
      baseAddress: 40000,
    });
  });

  it('refuses a block without the SunS marker', () => {
    // Port 502 is Modbus generally, not SunSpec — plenty of equipment answers there
    // with an unrelated register map, and claiming those as inverters would be worse
    // than missing them.
    const notSunspec = commonModel();
    notSunspec.write('XXXX', 0, 'ascii');
    expect(parseCommonModel(notSunspec, 40000)).toBeNull();
  });

  it('refuses a map whose first model is not the Common Model', () => {
    const odd = commonModel();
    odd.writeUInt16BE(103, 4);
    expect(parseCommonModel(odd, 40000)).toBeNull();
  });

  it('refuses a nameless device', () => {
    // The marker matching is not enough to put a device in front of someone if we
    // cannot say what it is.
    expect(parseCommonModel(commonModel(''), 40000)).toBeNull();
  });

  it('survives a short read', () => {
    expect(parseCommonModel(Buffer.alloc(4), 40000)).toBeNull();
    expect(parseCommonModel(Buffer.alloc(0), 40000)).toBeNull();
  });
});

/** A model 103 inverter block, written at a register offset within a buffer. */
function inverterBlock(
  data: Buffer,
  offset: number,
  values: { powerW?: number; wh?: number; volts?: number; hz?: number; amps?: number; tempC?: number | null },
): void {
  const w = (reg: number, v: number): void => data.writeUInt16BE(v & 0xffff, (offset + reg) * 2);
  const wi = (reg: number, v: number): void => data.writeInt16BE(v, (offset + reg) * 2);
  w(0, 103); // three-phase inverter model
  w(1, 50); // length
  w(2, (values.amps ?? 12.3) * 10);
  wi(6, -1); // A_SF
  w(10, values.volts ?? 240);
  wi(13, 0); // V_SF
  wi(14, (values.powerW ?? 4200) / 10);
  wi(15, 1); // W_SF -> value x 10
  w(16, (values.hz ?? 59.98) * 100);
  wi(17, -2); // Hz_SF
  wi(22, 99);
  wi(23, -2); // PF_SF
  // WH_SF of 1 means the device stores tens of watt-hours, so only multiples of 10
  // are representable. Rounding here rather than truncating silently keeps the
  // fixture honest about what real hardware could actually report.
  data.writeUInt32BE(Math.round((values.wh ?? 123450) / 10), (offset + 24) * 2);
  wi(26, 1); // WH_SF
  // 0x8000 is the SunSpec "not implemented" marker for a signed register.
  wi(33, values.tempC === null ? -32768 : (values.tempC ?? 41.5) * 10);
  wi(34, -32768);
  wi(37, -1); // Tmp_SF
}

describe('SunSpec inverter model', () => {
  it('applies scale factors to reach real units', () => {
    const data = Buffer.alloc(200 * 2);
    inverterBlock(data, 70, { powerW: 4200, wh: 123450, volts: 240, hz: 59.98, tempC: 41.5 });
    const r = parseInverterModel(data, 70)!;
    expect(r.modelId).toBe(103);
    expect(r.acPowerW).toBeCloseTo(4200, 6);
    expect(r.lifetimeWh).toBeCloseTo(123450, 6);
    expect(r.voltage).toBeCloseTo(240, 6);
    expect(r.frequency).toBeCloseTo(59.98, 6);
    expect(r.current).toBeCloseTo(12.3, 6);
    expect(r.powerFactor).toBeCloseTo(0.99, 6);
    expect(r.temperature).toBeCloseTo(41.5, 6);
  });

  it('reports an unimplemented register as null, not zero', () => {
    // Many string inverters publish no temperature. SunSpec marks that explicitly, and
    // reading the marker as a number would put a confident 0 °C on a chart — the same
    // fault this project keeps finding.
    const data = Buffer.alloc(200 * 2);
    inverterBlock(data, 70, { tempC: null });
    expect(parseInverterModel(data, 70)!.temperature).toBeNull();
  });

  it('refuses a block that is not an inverter model', () => {
    const data = Buffer.alloc(200 * 2);
    data.writeUInt16BE(203, 70 * 2); // a meter model
    expect(parseInverterModel(data, 70)).toBeNull();
  });

  it('scales by powers of ten in both directions', () => {
    expect(applyScale(42, 0)).toBe(42);
    expect(applyScale(42, 2)).toBe(4200);
    expect(applyScale(4200, -2)).toBeCloseTo(42, 9);
    expect(applyScale(null, 1)).toBeNull();
    expect(applyScale(42, null)).toBeNull();
  });
});

describe('SunSpec model chain', () => {
  it('walks past other models to find the inverter', () => {
    // Devices publish different models in different orders, so the position of the
    // inverter block cannot be assumed.
    const data = Buffer.alloc(300 * 2);
    data.writeUInt16BE(1, 2 * 2); // Common Model
    data.writeUInt16BE(66, 3 * 2);
    inverterBlock(data, 70, {});
    const found = findModel(data, 2, [101, 102, 103])!;
    expect(found).toMatchObject({ id: 103, offset: 70 });
  });

  it('stops at the end-of-map marker instead of running off', () => {
    const data = Buffer.alloc(100 * 2);
    data.writeUInt16BE(0xffff, 2 * 2);
    expect(findModel(data, 2, [103])).toBeNull();
  });

  it('stops on an implausible length rather than looping', () => {
    // A misread length could otherwise walk forever or index wildly.
    const data = Buffer.alloc(100 * 2);
    data.writeUInt16BE(5, 2 * 2);
    data.writeUInt16BE(60000, 3 * 2);
    expect(findModel(data, 2, [103])).toBeNull();
  });

  it('returns null when the wanted model simply is not there', () => {
    const data = Buffer.alloc(300 * 2);
    data.writeUInt16BE(1, 2 * 2);
    data.writeUInt16BE(66, 3 * 2);
    data.writeUInt16BE(203, 70 * 2); // a meter, no inverter
    data.writeUInt16BE(105, 71 * 2);
    expect(findModel(data, 2, [101, 102, 103])).toBeNull();
  });
});

describe('SunSpec strings', () => {
  it('trims null padding', () => {
    expect(readString(packString('SMA', 16), 0, 16)).toBe('SMA');
  });

  it('drops non-printable padding rather than rendering mojibake', () => {
    // Some devices pad with 0xFF instead of nulls, which would otherwise show up in
    // the device name the user sees.
    const buf = Buffer.alloc(8, 0xff);
    buf.write('ABB', 0, 'ascii');
    expect(readString(buf, 0, 4)).toBe('ABB');
  });

  it('reads a full-width string with no padding at all', () => {
    const text = 'ABCDEFGH';
    expect(readString(packString(text, 4), 0, 4)).toBe(text);
  });

  it('returns empty rather than reading past the buffer', () => {
    expect(readString(Buffer.alloc(4), 0, 16)).toBe('');
  });
});
