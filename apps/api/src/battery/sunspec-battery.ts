import {
  BASE_ADDRESSES,
  SUNSPEC_PORT,
  applyScale,
  findModel,
  parseCommonModel,
  readRegisters,
} from '../devices/sunspec';
import { BatteryReading, BatterySource } from './types';

/** Read span, deliberately over Modbus's 125-register per-read cap — `readRegisters` chunks. */
const MAP_REGISTERS = 190;

/** 802 is the battery base model; 803-805 add chemistry detail. soc/power/capacity are in the base block. */
const STORAGE_MODEL_IDS = [802, 803, 804, 805];

/**
 * Field offsets in the 802 block, registers from the model id word, per the SunSpec
 * Energy Storage spec. Header (id + length) is 0-1, payload starts at 2.
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
  // 0x8000 is "not implemented" for signed 16-bit, not a -32768 W discharge.
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

/** Parse a storage model out of a register map. Exported to be tested against a synthetic block. */
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

/** Battery over Modbus TCP from any SunSpec storage device. Shares the solar side's transport. */
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
 * Does this SunSpec device also store energy? Lives here, not in `devices/sunspec`, because
 * the storage parser does — moving it would make the two modules import each other. Returns
 * false rather than throwing: an exception aborts the whole subnet sweep.
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
