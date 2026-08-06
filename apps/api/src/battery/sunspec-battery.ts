import {
  BASE_ADDRESSES,
  SUNSPEC_PORT,
  applyScale,
  findModel,
  parseCommonModel,
  readRegisters,
} from '../devices/sunspec';
import { BatteryReading, BatterySource } from './types';

/**
 * Registers pulled in one go, covering the common model plus the models after it.
 *
 * Deliberately larger than Modbus's 125-register limit — `readRegisters` chunks and
 * reassembles. That cap was found only by pointing the client at a simulator, after
 * unit tests had passed against a misunderstanding of the protocol.
 */
const MAP_REGISTERS = 190;

/**
 * SunSpec storage models — the standards-based way to read a home battery locally.
 *
 * 802 is the battery base model; 803-805 add lithium-ion, flow and other chemistry
 * detail on top of it. We look for any of them and read the fields they share, because
 * everything we display (state of charge, power, capacity) lives in the base block.
 *
 * This exists so the battery page has a LOCAL option at all. EcoFlow has no local API,
 * so the only battery anyone could connect went through a vendor cloud — which sits
 * awkwardly in an app whose whole claim is that nothing leaves the house.
 */
const STORAGE_MODEL_IDS = [802, 803, 804, 805];

/**
 * Field offsets within the 802 block, in registers from the block's start.
 *
 * From the SunSpec Energy Storage specification. Offsets are relative to the model id
 * word, so the header (id + length) occupies 0 and 1 and payload starts at 2.
 */
const OFFSET = {
  /** Nameplate energy capacity, Wh. */
  wHRtg: 2,
  wHRtgSf: 3,
  /** State of charge, %. */
  soc: 12,
  socSf: 13,
  /** State of health, %. */
  soh: 14,
  /** Cycle count, uint32. */
  cycleCount: 16,
  /** DC power, W. Signed: positive charging. */
  dcW: 20,
  dcWSf: 21,
} as const;

function readU16(data: Buffer, register: number): number | null {
  const byte = register * 2;
  if (byte + 2 > data.length) return null;
  const raw = data.readUInt16BE(byte);
  // 0xFFFF is SunSpec's "not implemented" for unsigned 16-bit.
  return raw === 0xffff ? null : raw;
}

function readS16(data: Buffer, register: number): number | null {
  const byte = register * 2;
  if (byte + 2 > data.length) return null;
  const raw = data.readInt16BE(byte);
  // 0x8000 is "not implemented" for signed 16-bit — and reading it as a number would
  // report -32768 W, a plausible-looking 32 kW discharge that never happened.
  return raw === -32768 ? null : raw;
}

function readU32(data: Buffer, register: number): number | null {
  const byte = register * 2;
  if (byte + 4 > data.length) return null;
  const raw = data.readUInt32BE(byte);
  return raw === 0xffffffff ? null : raw;
}

/** Scale factors are signed 16-bit; absent means "no scaling", not "zero". */
function readSf(data: Buffer, register: number): number | null {
  const sf = readS16(data, register);
  return sf === null ? 0 : sf;
}

export interface ParsedStorage {
  soc: number;
  powerW: number;
  capacityKwh: number | null;
  cycles: number | null;
  modelId: number;
}

/**
 * Parse a storage model out of a register map.
 *
 * Exported so it can be tested against a synthetic block. There is no hardware here to
 * try it on, so the parser is the only thing that can be held to account — see the
 * `documented` confidence this vendor declares.
 */
export function parseStorageModel(data: Buffer, startOffset: number): ParsedStorage | null {
  const model = findModel(data, startOffset, STORAGE_MODEL_IDS);
  if (!model) return null;
  const at = (offset: number): number => model.offset + offset;

  const soc = applyScale(readU16(data, at(OFFSET.soc)), readSf(data, at(OFFSET.socSf)));
  if (soc === null) return null;

  const dcW = applyScale(readS16(data, at(OFFSET.dcW)), readSf(data, at(OFFSET.dcWSf)));
  const wh = applyScale(readU16(data, at(OFFSET.wHRtg)), readSf(data, at(OFFSET.wHRtgSf)));

  return {
    soc: Math.max(0, Math.min(100, soc)),
    powerW: dcW ?? 0,
    capacityKwh: wh === null ? null : wh / 1000,
    cycles: readU32(data, at(OFFSET.cycleCount)),
    modelId: model.id,
  };
}

/**
 * Reads a battery over Modbus TCP from any device exposing a SunSpec storage model.
 *
 * Reuses the same transport as the solar side, including its 125-register read cap —
 * a limit found only by pointing the client at a simulator, after unit tests had
 * happily passed against a misunderstanding of the protocol.
 */
export class SunSpecBatteryClient implements BatterySource {
  private transactionId = 0;
  private base: number | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number = SUNSPEC_PORT,
    private readonly unitId: number = 1,
  ) {}

  private nextTransactionId(): number {
    this.transactionId = (this.transactionId + 1) % 0xffff;
    return this.transactionId + 1;
  }

  async read(): Promise<BatteryReading> {
    // Remember which base answered; devices differ and re-probing every poll is waste.
    const bases = this.base === null ? BASE_ADDRESSES : [this.base];
    for (const base of bases) {
      const data = await readRegisters(
        this.host,
        this.port,
        this.unitId,
        base,
        MAP_REGISTERS,
        this.nextTransactionId(),
      );
      if (!data) continue;
      const identity = parseCommonModel(data, base);
      if (!identity) continue;
      const storage = parseStorageModel(data, 2);
      if (!storage) {
        throw new Error(
          `${this.host} is a SunSpec device but exposes no storage model (802-805) — it is probably an inverter without a battery`,
        );
      }
      this.base = base;
      return {
        soc: storage.soc,
        powerW: storage.powerW,
        capacityKwh: storage.capacityKwh,
        cycles: storage.cycles,
        model: [identity.manufacturer, identity.model].filter(Boolean).join(' ') || 'SunSpec battery',
        name: identity.model || 'Battery',
      };
    }
    throw new Error(`No SunSpec device answered at ${this.host}:${this.port}`);
  }
}

/**
 * Does this SunSpec device also store energy?
 *
 * Answers the question the network scan needs in order to tell a hybrid inverter from
 * a string one. It lives here rather than in `devices/sunspec` because the storage
 * parser does — putting it there would make the two modules import each other.
 *
 * Returns false rather than throwing when anything goes wrong: this runs inside a
 * subnet sweep, where "could not tell" and "no battery" lead to the same next step,
 * and an exception would abort the scan for every host behind this one.
 */
export async function sunspecHasStorage(
  host: string,
  port: number = SUNSPEC_PORT,
  unitId = 1,
): Promise<boolean> {
  for (const base of BASE_ADDRESSES) {
    try {
      const data = await readRegisters(host, port, unitId, base, MAP_REGISTERS, 1);
      if (!data) continue;
      if (!parseCommonModel(data, base)) continue;
      return parseStorageModel(data, 2) !== null;
    } catch {
      return false;
    }
  }
  return false;
}
