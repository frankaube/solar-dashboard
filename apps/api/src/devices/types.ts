import { Device } from '@prisma/client';

/** One measured leg of a multi-channel device: a meter phase, a circuit, an outlet. */
export interface ChannelState {
  /** 1-based; channel 0 is reserved for the device-wide figure. */
  channel: number;
  label?: string;
  /** Signed: negative means exporting. */
  powerW?: number | null;
  energyWh?: number | null;
  energyReturnedWh?: number | null;
}

/** Live state snapshot for any device, in real units. */
export interface DeviceState {
  reachable: boolean;
  on?: boolean;
  /** Device-wide power. Signed on meters — negative is export, not an error. */
  powerW?: number | null;
  /** Cumulative lifetime counter, as most metered hardware reports it. */
  energyWh?: number | null;
  /**
   * Energy so far TODAY, on hardware that reports a resetting daily figure instead of a
   * lifetime counter — Daikin air conditioners do. Kept apart from energyWh: a daily value
   * stored where a monotonic one is expected is differenced into nonsense at midnight.
   */
  energyTodayWh?: number | null;
  energyReturnedWh?: number | null;
  temperatureC?: number | null;
  setpointC?: number | null;
  heating?: boolean;
  rssi?: number | null;
  /** Present only on multi-channel hardware; the fields above stay the total. */
  channels?: ChannelState[];
}

/** A device found on the network but not yet adopted. */
export interface DiscoveredDevice {
  vendor: string;
  kind: string;
  name: string;
  host: string;
  port?: number;
  hardwareId?: string;
  model?: string;
  paired?: boolean;
  adopted: boolean;
  /**
   * Discovered, but not controllable without a credential the device will not give up —
   * Tuya's per-device local key comes from their cloud. "Visible", not "supported".
   */
  needsCloudKey?: boolean;
}

/**
 * Capability contract for a vendor adapter: the service and UI only offer what the adapter
 * implements, so an optional method is a declaration.
 */
export interface DeviceAdapter {
  vendor: string;
  poll(device: Device): Promise<DeviceState>;
  setOn?(device: Device, on: boolean): Promise<void>;
  setTargetTemperature?(device: Device, celsius: number): Promise<void>;
}
