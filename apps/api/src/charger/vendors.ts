/**
 * Vehicle loggers and EV chargers this build can talk to.
 *
 * One entry each today, and saying so in a registry rather than in prose is the point.
 * The UI used to hardcode "TeslaMate" and "Tesla Wall Connector" into its copy, which
 * told everyone that this app is for Tesla owners whether or not that was the sentence
 * anybody meant to write. Naming them here means the copy asks what is connected instead
 * of asserting it, and a second adapter is a change to this file rather than a hunt
 * through the pages for strings.
 *
 * evcc changes that. It is a self-hosted application that already speaks to sixteen-odd
 * vehicle brands and dozens of chargers, so bridging to it is worth more than any single
 * native adapter — one entry here inherits its whole ecosystem. The Tesla-only entries
 * remain because a Wall Connector on the LAN needs no second service to read it.
 */

export interface VehicleSource {
  id: string;
  /** What to call it on screen. */
  name: string;
  /** Where an owner goes to finish setting it up, when it has its own UI. */
  setupUrl: string | null;
  /** Named so a page can say what it is rather than assuming the reader knows. */
  summary: string;
}

export interface ChargerVendor {
  id: string;
  name: string;
  summary: string;
}

export const VEHICLE_SOURCES: Record<string, VehicleSource> = {
  ovms: {
    id: 'ovms',
    name: 'OVMS',
    setupUrl: null,
    summary:
      'An OBD2 dongle reading the car’s own CAN bus and publishing over MQTT — the only vehicle source that needs no manufacturer cloud account.',
  },
  evcc: {
    id: 'evcc',
    name: 'evcc',
    setupUrl: null,
    summary:
      'Vehicle state via a self-hosted evcc instance — Audi, BMW, Ford, Hyundai, Kia, Nissan, Renault, Skoda, Tesla, VW, Volvo and more.',
  },
  teslamate: {
    id: 'teslamate',
    name: 'TeslaMate',
    setupUrl: 'http://localhost:4000',
    summary: 'Vehicle history from a local TeslaMate instance, read-only.',
  },
};

export const CHARGER_VENDORS: Record<string, ChargerVendor> = {
  ocpp: {
    id: 'ocpp',
    name: 'OCPP 1.6J charge point',
    summary:
      'Any charger speaking OCPP — Wallbox, ABB, Alfen, ABL, Zaptec and others. The charger connects to us, so nothing needs discovering.',
  },
  goe: {
    id: 'goe',
    name: 'go-e Charger',
    summary: 'Live power and session energy over the charger’s own local HTTP API. No cloud account.',
  },
  evcc: {
    id: 'evcc',
    name: 'evcc',
    summary: 'Charging power and session data from a self-hosted evcc instance.',
  },
  'tesla-wall-connector': {
    id: 'tesla-wall-connector',
    name: 'Tesla Wall Connector (Gen 3)',
    summary: 'Live charging power over the unit’s own local HTTP API.',
  },
};

export const DEFAULT_VEHICLE_SOURCE = 'teslamate';
export const DEFAULT_CHARGER_VENDOR = 'tesla-wall-connector';
