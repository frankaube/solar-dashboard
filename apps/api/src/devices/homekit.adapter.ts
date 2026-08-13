import { Device } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { HapCharacteristic, listCharacteristics, matches, withClient } from './mysa.adapter';
import { DeviceAdapter, DeviceState } from './types';

// Apple-defined characteristics.
const ON = '00000025-0000-1000-8000-0026BB765291';
const CURRENT_TEMPERATURE = '00000011-0000-1000-8000-0026BB765291';
const TARGET_TEMPERATURE = '00000035-0000-1000-8000-0026BB765291';
const CURRENT_HEATING_STATE = '0000000F-0000-1000-8000-0026BB765291';

/**
 * Eve's vendor characteristics for metering outlets. `10D` (watts) is confirmed;
 * `10C` (cumulative kWh) is widely used by community integrations but I could not
 * verify it against a primary source, so a nonsensical value is discarded rather
 * than recorded as energy.
 */
const EVE_WATTS = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
const EVE_KWH = 'E863F10C-079E-48FF-8F27-9C2605A29F52';
const WH_PER_KWH = 1000;

/**
 * Any paired HomeKit accessory, read by whatever characteristics it advertises.
 *
 * The scan already labels non-Mysa HAP responders as vendor `homekit` and the
 * pairing flow works for them — but no adapter was ever registered under that
 * name, so those devices adopted successfully and were then skipped forever by
 * the poller. This closes that hole, and picks up Eve's metering outlets for free
 * since the pairing machinery is identical.
 */
export class HomeKitAdapter implements DeviceAdapter {
  vendor = 'homekit';
  private readonly logger = new Logger(HomeKitAdapter.name);

  async poll(device: Device): Promise<DeviceState> {
    try {
      return await withClient(device, async (client) => {
        const characteristics = await listCharacteristics(client);
        const byType = (uuid: string): HapCharacteristic | undefined =>
          characteristics.find((c) => matches(c.type, uuid));
        const num = (c: HapCharacteristic | undefined): number | null => {
          const value = Number(c?.value);
          return c && Number.isFinite(value) ? value : null;
        };

        const on = byType(ON);
        const watts = num(byType(EVE_WATTS));
        const kwh = num(byType(EVE_KWH));
        const heat = byType(CURRENT_HEATING_STATE);

        return {
          reachable: true,
          on: on ? Boolean(on.value) : undefined,
          powerW: watts,
          energyWh: kwh !== null && kwh >= 0 ? kwh * WH_PER_KWH : null,
          temperatureC: num(byType(CURRENT_TEMPERATURE)),
          setpointC: num(byType(TARGET_TEMPERATURE)),
          heating: heat ? Number(heat.value) === 1 : undefined,
        };
      });
    } catch (error) {
      this.logger.debug(`poll ${device.name}: ${(error as Error).message}`);
      return { reachable: false };
    }
  }

  async setOn(device: Device, on: boolean): Promise<void> {
    await withClient(device, async (client) => {
      const characteristics = await listCharacteristics(client);
      const target = characteristics.find((c) => matches(c.type, ON));
      if (!target) throw new Error('accessory has no On characteristic');
      await client.setCharacteristics({ [`${target.aid}.${target.iid}`]: on });
    });
  }

  async setTargetTemperature(device: Device, celsius: number): Promise<void> {
    await withClient(device, async (client) => {
      const characteristics = await listCharacteristics(client);
      const target = characteristics.find((c) => matches(c.type, TARGET_TEMPERATURE));
      if (!target) throw new Error('accessory has no target-temperature characteristic');
      await client.setCharacteristics({ [`${target.aid}.${target.iid}`]: celsius });
    });
  }
}
