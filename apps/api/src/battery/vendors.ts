import { EcoFlowClient } from './ecoflow.client';
import { SunSpecBatteryClient } from './sunspec-battery';
import { PowerwallClient } from './tesla-powerwall';
import { VictronClient } from './victron';
import { EnphaseClient } from './enphase';
import { BatterySource, BatteryVendor } from './types';

/**
 * The batteries this app can connect to, and what each one needs.
 *
 * The page used to hardcode EcoFlow's two-key form and list "Tesla Powerwall, Victron,
 * and Enphase" as roadmap prose — a promise with no code behind it and no way for an
 * owner to tell which of the four they could actually use today. A registry makes the
 * list honest: what is here works, and what is not here is not offered.
 *
 * Ordered local-first deliberately. This app's claim is that nothing leaves the house,
 * so a cloud vendor should look like the compromise it is rather than the default.
 */

/** An EcoFlow serial is chosen after the credentials list the account's devices. */
export const ECOFLOW_FIELDS = [
  {
    key: 'accessKey',
    label: 'Access key',
    secret: true,
    help: 'From developer.ecoflow.com → IoT platform → generate an access key.',
  },
  { key: 'secretKey', label: 'Secret key', secret: true },
];

export const BATTERY_VENDORS: BatteryVendor[] = [
  {
    id: 'sunspec',
    name: 'SunSpec battery (Modbus TCP)',
    connection: 'local',
    confidence: 'documented',
    summary: 'Any battery or hybrid inverter exposing SunSpec storage models, on your own network.',
    setupHint:
      'Enter the device address on your LAN. Most hybrid inverters expose Modbus TCP on port 502, often behind a "Modbus" or "third-party control" toggle in the vendor app. Nothing leaves your network.',
    fields: [
      {
        key: 'host',
        label: 'IP address',
        placeholder: '192.168.1.50',
        help: 'The inverter or battery on your network. Find it in your router, or in the vendor app.',
      },
    ],
    createSource(config): BatterySource | null {
      const host = config.host?.trim();
      return host ? new SunSpecBatteryClient(host) : null;
    },
  },
  {
    id: 'powerwall',
    name: 'Tesla Powerwall',
    connection: 'local',
    confidence: 'documented',
    summary: 'Powerwall 2 and 3, read from the Gateway on your own network.',
    setupHint:
      'Enter the Gateway address. Firmware 20.49 and later needs the customer email you registered with and the Gateway password — by default the last five characters of its serial, printed inside the door. Nothing goes to Tesla.',
    fields: [
      { key: 'host', label: 'Gateway IP address', placeholder: '192.168.1.20' },
      { key: 'email', label: 'Customer email', help: 'The address the system is registered to.' },
      {
        key: 'password',
        label: 'Gateway password',
        secret: true,
        help: 'Last five characters of the Gateway serial, unless it was changed.',
      },
    ],
    createSource(config): BatterySource | null {
      const host = config.host?.trim();
      if (!host) return null;
      return new PowerwallClient(host, config.email?.trim() ?? '', config.password?.trim() ?? '');
    },
  },
  {
    id: 'victron',
    name: 'Victron (Cerbo GX / Venus OS)',
    connection: 'local',
    confidence: 'documented',
    summary: 'Any battery managed by a GX device, over Modbus TCP.',
    setupHint:
      'Enter the GX device address. Turn on Settings → Services → Modbus TCP on the GX first. Victron publishes its register list, so this reads the system battery directly with no account involved.',
    fields: [
      { key: 'host', label: 'GX device IP address', placeholder: '192.168.1.30' },
      {
        key: 'unitId',
        label: 'Modbus unit ID',
        placeholder: '100',
        help: 'Leave blank unless you have changed it. 100 is the system service.',
      },
    ],
    createSource(config): BatterySource | null {
      const host = config.host?.trim();
      if (!host) return null;
      const unit = Number(config.unitId?.trim());
      return new VictronClient(host, 502, Number.isFinite(unit) && unit > 0 ? unit : undefined);
    },
  },
  {
    id: 'enphase',
    name: 'Enphase IQ Battery',
    connection: 'local',
    confidence: 'documented',
    summary: 'Encharge and IQ Battery, read from the Envoy gateway.',
    setupHint:
      'Enter the Envoy address. Firmware D7 and later needs an access token, which you generate once from your Enlighten account — Enphase provides no way to mint one locally, so the token is their condition for local access, not ours.',
    fields: [
      { key: 'host', label: 'Envoy IP address', placeholder: '192.168.1.40' },
      {
        key: 'token',
        label: 'Enlighten token',
        secret: true,
        help: 'Only needed on firmware D7 and later. Leave blank on older Envoys.',
      },
    ],
    createSource(config): BatterySource | null {
      const host = config.host?.trim();
      if (!host) return null;
      return new EnphaseClient(host, config.token?.trim() || null);
    },
  },
  {
    id: 'ecoflow',
    name: 'EcoFlow',
    connection: 'cloud',
    confidence: 'documented',
    summary: 'DELTA Pro, PowerOcean and similar. Requires EcoFlow developer keys.',
    setupHint:
      'EcoFlow publishes no local API, so this reads your battery through their developer cloud. Your keys are stored on this machine and used only to read the battery — but the request does leave your network, which is EcoFlow’s constraint, not ours.',
    fields: [
      ...ECOFLOW_FIELDS,
      {
        key: 'sn',
        label: 'Serial number',
        help: 'Filled in for you after the keys find your devices.',
      },
    ],
    createSource(config): BatterySource | null {
      const { accessKey, secretKey, sn } = config;
      if (!accessKey?.trim() || !secretKey?.trim() || !sn?.trim()) return null;
      const client = new EcoFlowClient(accessKey.trim(), secretKey.trim());
      return {
        async read() {
          const state = await client.fetchState(sn.trim());
          /*
            A null here means the credentials worked but that serial returned nothing —
            usually a device that has been removed from the account. Throwing keeps the
            distinction between "no battery configured" and "configured but unreachable",
            which the page renders differently.
          */
          if (!state) throw new Error(`EcoFlow returned no state for ${sn.trim()}`);
          return state;
        },
      };
    },
  },
];

export function findBatteryVendor(id: string | null | undefined): BatteryVendor | undefined {
  return BATTERY_VENDORS.find((vendor) => vendor.id === id);
}

/** The catalogue the UI renders, without the factory functions. */
export function batteryVendorCatalogue(): Array<Omit<BatteryVendor, 'createSource'>> {
  return BATTERY_VENDORS.map(({ createSource: _createSource, ...rest }) => rest);
}
