import { InverterDataSource } from '../hoymiles/types';
import { HoymilesDtuClient } from '../hoymiles/dtu-client';
import { FroniusClient } from './fronius.client';
import { OpenDtuClient } from './opendtu.client';
import { SunSpecClient } from './sunspec.client';

/**
 * Adding a provider: implement InverterDataSource (snapshots in real physical units), add a
 * fingerprint in setup/discovery.service.ts, register the factory here. See docs/vendors.md.
 */
export interface InverterVendor {
  id: string;
  name: string;
  createSource: (host: string) => InverterDataSource;
}

export const INVERTER_VENDORS: Record<string, InverterVendor> = {
  hoymiles: {
    id: 'hoymiles',
    name: 'Hoymiles DTU (local protobuf, port 10081)',
    createSource: (host) => new HoymilesDtuClient(host),
  },
  fronius: {
    id: 'fronius',
    name: 'Fronius (local Solar API, JSON)',
    createSource: (host) => new FroniusClient(host),
  },
  sunspec: {
    id: 'sunspec',
    name: 'SunSpec inverter (Modbus TCP — Fronius, SMA, SolarEdge, ABB…)',
    createSource: (host) => new SunSpecClient(host),
  },
  opendtu: {
    id: 'opendtu',
    name: 'OpenDTU / AhoyDTU (local REST, per-panel)',
    createSource: (host) => new OpenDtuClient(host),
  },
};

export const DEFAULT_VENDOR = 'hoymiles';
