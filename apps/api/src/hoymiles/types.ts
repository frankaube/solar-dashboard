/**
 * Vendor-neutral reading types. Everything is in real physical units
 * (V, A, W, Hz, °C, Wh) — raw integer scaling is the data source's concern.
 */

export interface InverterSnapshot {
  serialNumber: string;
  gridVoltage: number;
  gridFrequency: number;
  activePower: number;
  reactivePower: number;
  current: number;
  powerFactor: number;
  /**
   * Optional because string inverters often don't report them. They used to be
   * written as 0, which is indistinguishable from a real zero — a missing reading
   * would plot as 0 °C on a chart.
   */
  temperature?: number;
  powerLimitPct?: number;
  warningNumber?: number;
  linkStatus?: number;
  rfSignal?: number;
}

/**
 * Whole-site power flows, where the gateway reports them. Microinverter setups
 * (Hoymiles, OpenDTU) know only their own production; hybrids and gateways with a
 * meter (Fronius, SunSpec 802, Powerwall, Victron) also know grid, house load and
 * battery — which is exactly what self-consumption accounting needs, and what the
 * savings model currently has to estimate. Sign convention: gridW positive =
 * importing, batteryW positive = charging.
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

/** Contract every inverter vendor integration implements. */
export interface InverterDataSource {
  fetchSnapshot(): Promise<SystemSnapshot>;
  fetchInfo(): Promise<DataSourceInfo>;
  getHost(): string;
  setHost(host: string): void;
  /**
   * Optional lifecycle for connection-oriented transports. This is a correctness
   * requirement, not a nicety: SolarEdge's Modbus server accepts exactly one
   * concurrent connection, so a leaked socket locks the inverter out of every other
   * tool on the owner's LAN. HTTP adapters simply don't implement these.
   */
  connect?(): Promise<void>;
  close?(): Promise<void>;
}
