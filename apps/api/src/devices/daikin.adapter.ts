import { Device } from '@prisma/client';
import {
  buildControlQuery,
  parseControlInfo,
  parseDayPower,
  parseSensorInfo,
} from './daikin';
import { DeviceAdapter, DeviceState } from './types';

const TIMEOUT_MS = 3_000;

async function get(host: string, path: string): Promise<string> {
  const response = await fetch(`http://${host}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { connection: 'close' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/**
 * Daikin air conditioners with a legacy Wi-Fi adaptor.
 *
 * The point of supporting these is energy: they report real daily kilowatt-hours,
 * which almost nothing else in HVAC does. What they do NOT report is instantaneous
 * power — the history is hourly buckets quantised to 0.1 kWh — so `powerW` stays null
 * rather than being back-computed into a number that would look live and be an hour
 * stale.
 *
 * Everything is plain unauthenticated HTTP, so a poll is three small requests.
 */
export class DaikinAdapter implements DeviceAdapter {
  vendor = 'daikin';

  async poll(device: Device): Promise<DeviceState> {
    try {
      const [control, sensors, power] = await Promise.all([
        get(device.host, '/aircon/get_control_info').then(parseControlInfo),
        get(device.host, '/aircon/get_sensor_info').then(parseSensorInfo),
        // Energy is the reason this adapter exists, but it is also the endpoint most
        // likely to be missing on an odd firmware. A failure here must not cost us the
        // temperatures and on/off state, which the other two calls already have.
        get(device.host, '/aircon/get_day_power_ex')
          .then(parseDayPower)
          .catch(() => null),
      ]);
      return {
        reachable: true,
        on: control?.on,
        temperatureC: sensors?.indoorC ?? null,
        setpointC: control?.targetC ?? null,
        // No instantaneous power exists on this hardware. Null says so.
        powerW: null,
        energyTodayWh: power,
      };
    } catch {
      return { reachable: false };
    }
  }

  async setOn(device: Device, on: boolean): Promise<void> {
    await this.applyControl(device, { on });
  }

  async setTargetTemperature(device: Device, celsius: number): Promise<void> {
    await this.applyControl(device, { targetC: celsius });
  }

  /**
   * Read-modify-write, because Daikin's set endpoint applies exactly what it is sent.
   *
   * Sending only the field being changed silently resets the others — a setpoint
   * change alone would also alter mode and fan speed. So the current state is fetched
   * first, and a change is refused outright if that read fails or comes back
   * incomplete. Refusing is the safe failure: the alternative is reconfiguring
   * someone's air conditioner from a guess.
   */
  private async applyControl(
    device: Device,
    changes: { on?: boolean; targetC?: number },
  ): Promise<void> {
    const current = parseControlInfo(await get(device.host, '/aircon/get_control_info'));
    if (!current) throw new Error('could not read current state; refusing to change it');
    const query = buildControlQuery(current, changes);
    if (!query) throw new Error('device did not report a full control set; refusing to change it');
    const body = await get(device.host, `/aircon/set_control_info?${query}`);
    if (!body.startsWith('ret=OK')) throw new Error(`device rejected the change: ${body.trim()}`);
  }
}
