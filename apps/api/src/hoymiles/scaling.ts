import { DataSourceInfo, SystemSnapshot } from './types';

/**
 * Raw wire values are scaled integers; factors verified against live readings
 * (see docs/dtu-research.md).
 */
const TENTHS = 10;
const HUNDREDTHS = 100;
const THOUSANDTHS = 1000;
const MILLISECONDS_PER_SECOND = 1000;

export interface RawSgs {
  serialNumber: string;
  voltage: number;
  frequency: number;
  activePower: number;
  reactivePower: number;
  current: number;
  powerFactor: number;
  temperature: number;
  warningNumber: number;
  linkStatus: number;
  powerLimit: number;
  modulationIndexSignal: number;
}

export interface RawPv {
  serialNumber: string;
  portNumber: number;
  voltage: number;
  current: number;
  power: number;
  energyTotal: number;
  energyDaily: number;
  errorCode: number;
}

export interface RawRealData {
  deviceSerialNumber: string;
  timestamp: number;
  ap: number;
  cp: number;
  sgsData?: RawSgs[];
  pvData?: RawPv[];
  dtuPower?: string;
  dtuDailyEnergy?: string;
}

export interface RawAppInfo {
  dtuSerialNumber: string;
  deviceNumber: number;
  pvNumber: number;
  dtuInfo?: {
    dtuSwVersion: number;
    dtuHwVersion: number;
    wifiVersion: string;
    signalStrength: number;
  };
}

/** 38411 = 0x960B → "H09.06.11" (nibble.nibble.byte, as printed on the label). */
export function formatHardwareVersion(raw: number): string {
  const major = (raw >> 12) & 0xf;
  const minor = (raw >> 8) & 0xf;
  const patch = raw & 0xff;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `H${pad(major)}.${pad(minor)}.${pad(patch)}`;
}

export function toSystemSnapshot(raw: RawRealData): SystemSnapshot {
  return {
    dtuSerialNumber: raw.deviceSerialNumber,
    takenAt: new Date(raw.timestamp * MILLISECONDS_PER_SECOND),
    totalPower: Number(raw.dtuPower ?? 0) / TENTHS,
    dailyEnergyWh: Number(raw.dtuDailyEnergy ?? 0),
    inverters: (raw.sgsData ?? []).map((sgs) => ({
      serialNumber: sgs.serialNumber,
      gridVoltage: sgs.voltage / TENTHS,
      gridFrequency: sgs.frequency / HUNDREDTHS,
      activePower: sgs.activePower / TENTHS,
      reactivePower: sgs.reactivePower / TENTHS,
      current: sgs.current / HUNDREDTHS,
      powerFactor: sgs.powerFactor / THOUSANDTHS,
      temperature: sgs.temperature / TENTHS,
      powerLimitPct: sgs.powerLimit / TENTHS,
      warningNumber: sgs.warningNumber,
      linkStatus: sgs.linkStatus,
      rfSignal: sgs.modulationIndexSignal,
    })),
    ports: (raw.pvData ?? []).map((pv) => ({
      inverterSerialNumber: pv.serialNumber,
      portNumber: pv.portNumber,
      voltage: pv.voltage / TENTHS,
      current: pv.current / HUNDREDTHS,
      power: pv.power / TENTHS,
      energyDailyWh: pv.energyDaily,
      energyTotalWh: pv.energyTotal,
      errorCode: pv.errorCode,
    })),
  };
}

export function toDataSourceInfo(raw: RawAppInfo): DataSourceInfo {
  return {
    serialNumber: raw.dtuSerialNumber,
    hardwareVersion: raw.dtuInfo ? formatHardwareVersion(raw.dtuInfo.dtuHwVersion) : undefined,
    softwareVersion: raw.dtuInfo ? String(raw.dtuInfo.dtuSwVersion) : undefined,
    inverterCount: raw.deviceNumber,
    pvCount: raw.pvNumber,
  };
}
