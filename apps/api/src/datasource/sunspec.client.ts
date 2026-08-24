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
 * SunSpec inverters over Modbus TCP.
 *
 * One client for Fronius, SMA, SolarEdge, Delta, ABB and anything else implementing
 * the standard — the single highest-leverage source in the registry, because it works
 * on hardware nobody here can test. That is also the reason for the care below: this
 * will meet devices we have never seen, so anything it cannot read has to come back
 * as null rather than as a plausible number.
 *
 * The map is read once and cached. A SunSpec device's layout does not move between
 * polls, so re-walking the model chain every five minutes would be pure overhead on
 * a link that is often deliberately slow.
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
    // The new device is not necessarily laid out like the old one.
    this.layout = null;
    this.identity = null;
  }

  private nextTransactionId(): number {
    this.transactionId = (this.transactionId + 1) % 0xffff;
    return this.transactionId + 1;
  }

  /** Read the whole map from whichever base address answers, caching what we learn. */
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
      // The Common Model starts at register 2 (after the "SunS" marker) and the
      // chain continues from there; findModel walks it rather than assuming.
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
      /*
        SunSpec publishes a LIFETIME accumulator (WH) and no daily counter. Deriving
        today's figure means differencing against the day's first reading, which is
        already how the rest of the app treats accumulators — see the DTU work, where
        taking the day's max fixed a $1.01 day. So the honest thing here is to pass
        the lifetime figure through totalEnergyWh and leave the daily field at zero
        rather than inventing a number this device never reported.
      */
      dailyEnergyWh: 0,
      totalEnergyWh: reading.lifetimeWh ?? undefined,
      inverters: [
        {
          serialNumber: serial,
          gridVoltage: reading.voltage ?? 0,
          gridFrequency: reading.frequency ?? 0,
          activePower: reading.acPowerW ?? 0,
          // SunSpec's VAr register is separate from the fields read here; not
          // pretending to a value we did not fetch.
          reactivePower: 0,
          current: reading.current ?? 0,
          powerFactor: reading.powerFactor ?? 0,
          // Optional in the contract precisely so a missing reading is absent rather
          // than plotted as 0 °C.
          ...(reading.temperature !== null ? { temperature: reading.temperature } : {}),
          linkStatus: 1,
        },
      ],
      // SunSpec's inverter model is an AC-side summary: it has no per-string or
      // per-panel detail, so there is nothing honest to put here. An empty list is
      // correct — the roof view will simply have nothing to draw, which is true.
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
      // One AC-side inverter model, and no per-string detail in it.
      inverterCount: 1,
      pvCount: 0,
    };
  }
}

export type { InverterReading };
