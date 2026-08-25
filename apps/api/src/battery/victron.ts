import { readRegisters } from '../devices/sunspec';
import { BatteryReading, BatterySource } from './types';

/**
 * Victron (Cerbo GX / Venus OS) over Modbus TCP, from the published register list. Modbus
 * TCP is on by default in recent Venus OS under Settings → Services. These are
 * `com.victronenergy.system` registers, so multiple batteries report as one pack.
 */

const VICTRON_PORT = 502;
/**
 * Unit 100. Victron multiplexes services onto Modbus unit IDs, not register ranges, so the
 * unit is part of the address — the same registers on unit 1 reach a different device.
 */
const SYSTEM_UNIT_ID = 100;

/** Register addresses from the Victron CCGX Modbus-TCP register list. */
export const VICTRON_REGISTERS = {
  /** /Dc/Battery/Voltage, 0.1 V per count, unsigned. */
  voltage: 840,
  /** /Dc/Battery/Current, 0.1 A per count, SIGNED. */
  current: 841,
  /** /Dc/Battery/Power, 1 W per count, SIGNED. Positive = charging. */
  power: 842,
  /** /Dc/Battery/Soc, 1 % per count, unsigned. */
  soc: 843,
} as const;

const FIRST_REGISTER = VICTRON_REGISTERS.voltage;
const REGISTER_COUNT = 4;

function wordAt(data: Buffer, register: number): number | null {
  const offset = (register - FIRST_REGISTER) * 2;
  if (offset < 0 || offset + 2 > data.length) return null;
  return data.readUInt16BE(offset);
}

function signedWordAt(data: Buffer, register: number): number | null {
  const offset = (register - FIRST_REGISTER) * 2;
  if (offset < 0 || offset + 2 > data.length) return null;
  return data.readInt16BE(offset);
}

/** Power is SIGNED: read unsigned, a 2 kW discharge (-2000) becomes 63,536 W. */
export function parseVictronBattery(data: Buffer): BatteryReading | null {
  const soc = wordAt(data, VICTRON_REGISTERS.soc);
  if (soc === null) return null;

  const power = signedWordAt(data, VICTRON_REGISTERS.power);
  const voltage = wordAt(data, VICTRON_REGISTERS.voltage);

  return {
    soc: Math.max(0, Math.min(100, soc)),
    // Victron already uses positive = charging; no inversion, unlike Tesla and Enphase.
    powerW: power ?? 0,
    capacityKwh: null,
    reservePct: null,
    cycles: null,
    name: 'Victron battery',
    model: voltage ? `Victron ${Math.round(voltage / 10)} V system` : 'Victron',
  };
}

export class VictronClient implements BatterySource {
  private transactionId = 0;

  constructor(
    private readonly host: string,
    private readonly port: number = VICTRON_PORT,
    private readonly unitId: number = SYSTEM_UNIT_ID,
  ) {}

  async read(): Promise<BatteryReading> {
    this.transactionId = (this.transactionId + 1) % 0xffff;
    const data = await readRegisters(
      this.host,
      this.port,
      this.unitId,
      FIRST_REGISTER,
      REGISTER_COUNT,
      this.transactionId + 1,
    );
    if (!data) {
      throw new Error(
        `No Modbus answer from ${this.host}:${this.port} unit ${this.unitId} — check Settings → Services → Modbus TCP on the GX device`,
      );
    }
    const reading = parseVictronBattery(data);
    if (!reading) throw new Error(`${this.host} answered but reported no state of charge`);
    return reading;
  }
}
