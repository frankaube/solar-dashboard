import * as net from 'node:net';

/**
 * SunSpec discovery over Modbus TCP.
 *
 * SunSpec is the one genuinely multi-vendor standard in this space: Fronius, SMA,
 * SolarEdge, Delta, ABB and others implement the same register layout, so a single
 * probe covers hardware we could never test individually. That is exactly the trade
 * the Prime plug argued for — platform-level discovery over per-brand support.
 *
 * A compliant device begins its map with the ASCII marker "SunS", followed by the
 * Common Model: manufacturer, model, version and serial number. That is enough to
 * name a device honestly without knowing anything else about it.
 *
 * Modbus is hand-rolled rather than pulled in as a dependency. This reads a single
 * block of holding registers and never writes, which is a few dozen lines — the same
 * call the Tasmota and Shelly adapters make about their own protocols.
 */

const MODBUS_PORT = 502;
const READ_HOLDING_REGISTERS = 0x03;
const TIMEOUT_MS = 3_000;
/** ASCII "SunS" — the marker that says the rest of this map is SunSpec. */
const SUNS_MARKER = 0x53756e53;

/**
 * Where the marker is allowed to live, per the specification. Devices differ, and
 * there is no way to know which without asking — SolarEdge answers at 40000, some
 * SMA equipment at 50000.
 */
export const BASE_ADDRESSES = [40000, 50000, 0];

/**
 * Registers to read for identification: the marker, the model header, and all of the
 * Common Model. Comfortably inside the 125-register limit on a single read, so
 * discovery stays one round trip per base address.
 */
const COMMON_MODEL_REGISTERS = 70;

export interface SunSpecInfo {
  manufacturer: string;
  model: string;
  version: string;
  serial: string;
  /** Which base address answered — worth keeping, the adapter will need it. */
  baseAddress: number;
}

/** Build a Modbus TCP read-holding-registers request. */
export function buildReadRequest(
  transactionId: number,
  unitId: number,
  address: number,
  count: number,
): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(transactionId, 0);
  buf.writeUInt16BE(0, 2); // protocol id: always 0 for Modbus TCP
  buf.writeUInt16BE(6, 4); // byte count of everything after this field
  buf.writeUInt8(unitId, 6);
  buf.writeUInt8(READ_HOLDING_REGISTERS, 7);
  buf.writeUInt16BE(address, 8);
  buf.writeUInt16BE(count, 10);
  return buf;
}

/**
 * Pull the register payload out of a Modbus TCP response.
 *
 * Returns null for anything that is not a well-formed successful read — including
 * Modbus exception responses, which set the high bit of the function code and are a
 * completely normal answer from a device that has no register at that address.
 */
export function parseReadResponse(buf: Buffer): Buffer | null {
  if (buf.length < 9) return null;
  if (buf.readUInt16BE(2) !== 0) return null; // not Modbus TCP
  const fn = buf.readUInt8(7);
  if (fn !== READ_HOLDING_REGISTERS) return null; // exception, or a different call
  const byteCount = buf.readUInt8(8);
  if (byteCount === 0 || buf.length < 9 + byteCount) return null;
  return buf.subarray(9, 9 + byteCount);
}

/**
 * Read a fixed-length SunSpec string.
 *
 * Two registers per four characters, big-endian, padded with nulls or spaces. Some
 * devices pad with 0xFF, so anything outside printable ASCII is dropped rather than
 * rendered as mojibake in a device name.
 */
export function readString(data: Buffer, registerOffset: number, registerCount: number): string {
  const start = registerOffset * 2;
  const end = start + registerCount * 2;
  if (end > data.length) return '';
  let out = '';
  for (const byte of data.subarray(start, end)) {
    if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
  }
  return out.trim();
}

/**
 * Identify a SunSpec Common Model block.
 *
 * Offsets are register indices from the marker: "SunS" occupies two, then the model
 * id and length, then the fixed-width strings.
 */
export function parseCommonModel(data: Buffer, baseAddress: number): SunSpecInfo | null {
  if (data.length < 8) return null;
  if (data.readUInt32BE(0) !== SUNS_MARKER) return null;
  // Model 1 is the Common Model. Anything else here means a map we cannot read.
  if (data.readUInt16BE(4) !== 1) return null;
  const manufacturer = readString(data, 4, 16);
  const model = readString(data, 20, 16);
  const version = readString(data, 44, 8);
  const serial = readString(data, 52, 16);
  // A block with no manufacturer is not usable as an identification, even if the
  // marker matched — better to report nothing than a nameless device.
  if (!manufacturer) return null;
  return { manufacturer, model, version, serial, baseAddress };
}

/**
 * SunSpec "not implemented" sentinels.
 *
 * A register a device does not populate is not zero — it is explicitly marked
 * unavailable, and reading it as a number would put a confident 0 W or 0 °C on a
 * chart. Same rule this codebase applies everywhere: unknown is null.
 */
const NA_INT16 = 0x8000;
const NA_UINT16 = 0xffff;
const NA_UINT32 = 0xffffffff;

/** Register offsets within an inverter model (101 single, 102 split, 103 three-phase). */
const INV = {
  current: 2,
  currentSf: 6,
  voltage: 10,
  voltageSf: 13,
  power: 14,
  powerSf: 15,
  frequency: 16,
  frequencySf: 17,
  powerFactor: 22,
  powerFactorSf: 23,
  lifetimeWh: 24,
  lifetimeWhSf: 26,
  tempCabinet: 33,
  tempSink: 34,
  tempSf: 37,
} as const;

export const INVERTER_MODEL_IDS = [101, 102, 103];

export interface InverterReading {
  acPowerW: number | null;
  lifetimeWh: number | null;
  voltage: number | null;
  frequency: number | null;
  current: number | null;
  powerFactor: number | null;
  temperature: number | null;
  modelId: number;
}

/** Apply a SunSpec scale factor: the value is raw x 10^sf. */
export function applyScale(raw: number | null, sf: number | null): number | null {
  if (raw === null || sf === null) return null;
  return raw * 10 ** sf;
}

function int16(data: Buffer, offset: number): number | null {
  const at = offset * 2;
  if (at + 2 > data.length) return null;
  const raw = data.readUInt16BE(at);
  if (raw === NA_INT16) return null;
  return data.readInt16BE(at);
}

function uint16(data: Buffer, offset: number): number | null {
  const at = offset * 2;
  if (at + 2 > data.length) return null;
  const raw = data.readUInt16BE(at);
  return raw === NA_UINT16 ? null : raw;
}

function uint32(data: Buffer, offset: number): number | null {
  const at = offset * 2;
  if (at + 4 > data.length) return null;
  const raw = data.readUInt32BE(at);
  return raw === NA_UINT32 ? null : raw;
}

/**
 * Walk the model chain to find the first inverter block.
 *
 * A SunSpec map is a linked list: each block is an id, a length, then that many
 * registers. Devices differ in what they publish and in what order, so the position
 * of the inverter model cannot be assumed — it has to be walked.
 */
export function findModel(
  data: Buffer,
  startOffset: number,
  wantedIds: number[],
  maxBlocks = 32,
): { id: number; offset: number; length: number } | null {
  let offset = startOffset;
  for (let i = 0; i < maxBlocks; i++) {
    if ((offset + 2) * 2 > data.length) return null;
    const id = data.readUInt16BE(offset * 2);
    const length = data.readUInt16BE((offset + 1) * 2);
    // 0xFFFF is the documented end-of-map marker.
    if (id === 0xffff) return null;
    if (length === 0 || length > 1000) return null; // implausible; stop rather than loop
    if (wantedIds.includes(id)) return { id, offset, length };
    offset += length + 2;
  }
  return null;
}

/** Read an inverter model block into real units. */
export function parseInverterModel(data: Buffer, offset: number): InverterReading | null {
  const id = uint16(data, offset);
  if (id === null || !INVERTER_MODEL_IDS.includes(id)) return null;
  const at = (field: number): number => offset + field;
  return {
    modelId: id,
    acPowerW: applyScale(int16(data, at(INV.power)), int16(data, at(INV.powerSf))),
    lifetimeWh: applyScale(uint32(data, at(INV.lifetimeWh)), int16(data, at(INV.lifetimeWhSf))),
    voltage: applyScale(uint16(data, at(INV.voltage)), int16(data, at(INV.voltageSf))),
    frequency: applyScale(uint16(data, at(INV.frequency)), int16(data, at(INV.frequencySf))),
    current: applyScale(uint16(data, at(INV.current)), int16(data, at(INV.currentSf))),
    powerFactor: applyScale(int16(data, at(INV.powerFactor)), int16(data, at(INV.powerFactorSf))),
    // Cabinet temperature where given, heatsink otherwise. Many string inverters
    // publish neither, which stays null rather than becoming a 0 °C reading.
    temperature:
      applyScale(int16(data, at(INV.tempCabinet)), int16(data, at(INV.tempSf))) ??
      applyScale(int16(data, at(INV.tempSink)), int16(data, at(INV.tempSf))),
  };
}

/** One request/response over a short-lived TCP connection. */
function request(host: string, port: number, payload: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk: Buffer | string) => {
      // No encoding is set on this socket, so data always arrives as a Buffer — but
      // the type permits a string, and coercing rather than casting keeps the byte
      // offsets below honest if that ever changes.
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk);
      const buf = Buffer.concat(chunks);
      // MBAP length field tells us when the frame is complete; embedded stacks are
      // free to split it across packets.
      if (buf.length >= 6 && buf.length >= 6 + buf.readUInt16BE(4)) finish(buf);
    });
    socket.on('timeout', () => finish(null));
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(chunks.length ? Buffer.concat(chunks) : null));
  });
}

/**
 * Ask a host whether it speaks SunSpec.
 *
 * Tries each documented base address in turn. A device that answers Modbus but has
 * nothing at one address returns an exception, which is ordinary and not an error —
 * so a miss is silent and we simply try the next.
 */
export async function sunspecIdentify(
  host: string,
  port = MODBUS_PORT,
  unitId = 1,
): Promise<SunSpecInfo | null> {
  for (const [i, base] of BASE_ADDRESSES.entries()) {
    const response = await request(
      host,
      port,
      buildReadRequest(i + 1, unitId, base, COMMON_MODEL_REGISTERS),
    );
    if (!response) continue;
    const data = parseReadResponse(response);
    if (!data) continue;
    const info = parseCommonModel(data, base);
    if (info) return info;
  }
  return null;
}

export const SUNSPEC_PORT = MODBUS_PORT;

/**
 * Modbus caps a single read at 125 registers.
 *
 * The byte-count field in the response is ONE byte, so 125 registers (250 bytes) is
 * the hard ceiling — ask for more and a compliant device cannot answer. Found by
 * pointing this client at a simulated inverter, which crashed trying to encode a
 * 380-byte count; a real device would have returned an exception and this would have
 * looked like "no SunSpec here".
 */
export const MAX_REGISTERS_PER_READ = 125;

/**
 * Read a block of registers, splitting into as many requests as the protocol needs.
 *
 * Exposed so the data source can reuse the framing without reimplementing it. Chunks
 * are sequential: these are embedded devices, and several are documented to accept
 * only one connection at a time.
 */
export async function readRegisters(
  host: string,
  port: number,
  unitId: number,
  address: number,
  count: number,
  transactionId = 1,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let read = 0;
  let tid = transactionId;
  while (read < count) {
    const want = Math.min(MAX_REGISTERS_PER_READ, count - read);
    const response = await request(
      host,
      port,
      buildReadRequest(tid, unitId, address + read, want),
    );
    const data = response ? parseReadResponse(response) : null;
    // A failed first chunk means nothing is there; a failed later one means we have
    // read as much as this device will give, which is still worth returning.
    if (!data) return chunks.length ? Buffer.concat(chunks) : null;
    chunks.push(data);
    read += want;
    tid = (tid % 0xffff) + 1;
  }
  return Buffer.concat(chunks);
}

