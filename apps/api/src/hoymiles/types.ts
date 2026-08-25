/** Vendor-neutral reading types in real units (V, A, W, Hz, °C, Wh); scaling is the source's job. */

export interface InverterSnapshot {
  serialNumber: string;
  gridVoltage: number;
  gridFrequency: number;
  activePower: number;
  reactivePower: number;
  current: number;
  powerFactor: number;
  /** Absent rather than 0 — string inverters often don't report these, and 0 °C plots. */
  temperature?: number;
  powerLimitPct?: number;
  warningNumber?: number;
  linkStatus?: number;
  rfSignal?: number;
}

/**
 * Microinverter setups (Hoymiles, OpenDTU) know only their own production; metered gateways
 * (Fronius, SunSpec 802, Powerwall, Victron) also know grid, load and battery. Signs:
 * gridW positive = importing, batteryW positive = charging.
 */
export interface SiteFlows {
  gridW?: number;
  loadW?: number;
  batteryW?: number;
  batterySocPct?: number;
}

export interface PortSnapshot {
  inverterSerialNumber: string;
  portNumber: number;
  voltage: number;
  current: number;
  power: number;
  energyDailyWh: number;
  energyTotalWh: number;
  errorCode: number;
}

export interface SystemSnapshot {
  dtuSerialNumber: string;
  takenAt: Date;
  totalPower: number;
  dailyEnergyWh: number;
  /** Lifetime production where the gateway reports it (SunSpec WH, Fronius E_Total). */
  totalEnergyWh?: number;
  flows?: SiteFlows;
  inverters: InverterSnapshot[];
  ports: PortSnapshot[];
}

export interface DataSourceInfo {
  serialNumber: string;
  model?: string;
  hardwareVersion?: string;
  softwareVersion?: string;
  inverterCount: number;
  pvCount: number;
}

/**
 * How to reach a gateway. Modbus vendors need more than a hostname — port varies by
 * brand (502 SMA/Sungrow, 1502 SolarEdge/Kostal, 6607 newer Huawei) and so does the
 * unit id (3 SMA-native, 71 Kostal, 85 AlphaESS, 126 SMA-SunSpec).
 */
export interface Endpoint {
  host: string;
  port?: number;
  unitId?: number;
}

export interface InverterDataSource {
  fetchSnapshot(): Promise<SystemSnapshot>;
  fetchInfo(): Promise<DataSourceInfo>;
  getHost(): string;
  setHost(host: string): void;
  /**
   * Optional lifecycle for connection-oriented transports. SolarEdge's Modbus server
   * accepts exactly one concurrent connection, so a leaked socket locks the inverter
   * out of every other tool on the LAN. HTTP adapters don't implement these.
   */
  connect?(): Promise<void>;
  close?(): Promise<void>;
}
