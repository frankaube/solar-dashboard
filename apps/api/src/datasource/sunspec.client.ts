import { DataSourceInfo, InverterDataSource, SystemSnapshot } from '../hoymiles/types';
import {
  BASE_ADDRESSES,
  INVERTER_MODEL_IDS,
  InverterReading,
  SUNSPEC_PORT,
  SunSpecInfo,
  findModel,
  parseCommonModel,
  parseInverterModel,
  readRegisters,
} from '../devices/sunspec';

/**
 * SunSpec over Modbus TCP — Fronius, SMA, SolarEdge, Delta, ABB. Runs against hardware
 * nobody here can test, so anything unreadable comes back null, not a plausible number.
 * The map is cached: a device's layout does not move, and the link is often slow.
 */

/** Enough registers to cover the Common Model plus the inverter block after it. */
const MAP_REGISTERS = 190;

export class SunSpecClient implements InverterDataSource {
  private host: string;
  private readonly port: number;
  private readonly unitId: number;
  /** Base address and inverter-model offset, once found. */
  private layout: { base: number; modelOffset: number } | null = null;
  private identity: SunSpecInfo | null = null;
  private transactionId = 0;

  constructor(host: string, port = SUNSPEC_PORT, unitId = 1) {
    this.host = host;
    this.port = port;
    this.unitId = unitId;
  }

  getHost(): string {
    return this.host;
  }

  setHost(host: string): void {
    this.host = host;
    // A different device is not necessarily laid out like the old one.
    this.layout = null;
    this.identity = null;
  }

  private nextTransactionId(): number {
    this.transactionId = (this.transactionId + 1) % 0xffff;
    return this.transactionId + 1;
  }

  private async readMap(): Promise<{ data: Buffer; base: number; modelOffset: number }> {
    const bases = this.layout ? [this.layout.base] : BASE_ADDRESSES;
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
      this.identity = identity;
      // Common Model starts at register 2, after the "SunS" marker; findModel walks the chain.
      const model = findModel(data, 2, INVERTER_MODEL_IDS);
      if (!model) {
        throw new Error('SunSpec device exposes no inverter model (101/102/103)');
      }
      this.layout = { base, modelOffset: model.offset };
      return { data, base, modelOffset: model.offset };
    }
    throw new Error(`No SunSpec device answered at ${this.host}:${this.port}`);
  }

  async fetchSnapshot(): Promise<SystemSnapshot> {
    const { data, modelOffset } = await this.readMap();
    const reading = parseInverterModel(data, modelOffset);
    if (!reading) throw new Error('SunSpec inverter model could not be read');

    const serial = this.identity?.serial || this.host;
    return {
      dtuSerialNumber: serial,
      takenAt: new Date(),
      totalPower: reading.acPowerW ?? 0,
      // Lifetime accumulator (WH), no daily counter — daily stays 0, today derived downstream.
      dailyEnergyWh: 0,
      totalEnergyWh: reading.lifetimeWh ?? undefined,
      inverters: [
        {
          serialNumber: serial,
          gridVoltage: reading.voltage ?? 0,
          gridFrequency: reading.frequency ?? 0,
          activePower: reading.acPowerW ?? 0,
          // SunSpec's VAr register is separate from the fields read here.
          reactivePower: 0,
          current: reading.current ?? 0,
          powerFactor: reading.powerFactor ?? 0,
          // Optional in the contract so a missing reading is absent, not 0 °C.
          ...(reading.temperature !== null ? { temperature: reading.temperature } : {}),
          linkStatus: 1,
        },
      ],
      // The inverter model is an AC-side summary — no per-string detail exists.
      ports: [],
    };
  }

  async fetchInfo(): Promise<DataSourceInfo> {
    if (!this.identity) await this.readMap();
    const identity = this.identity;
    return {
      serialNumber: identity?.serial || this.host,
      model: [identity?.manufacturer, identity?.model].filter(Boolean).join(' ') || 'SunSpec device',
      ...(identity?.version ? { softwareVersion: identity.version } : {}),
      inverterCount: 1,
      pvCount: 0,
    };
  }
}

export type { InverterReading };
