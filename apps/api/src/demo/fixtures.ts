/**
 * Vendor payloads, run through the SAME parser production uses, so a parser regression
 * breaks the demo. Provenance is mandatory: only `captured` says the integration works.
 */

export type Provenance =
  /** Recorded from real hardware. The only kind that validates the integration. */
  | 'captured'
  /** Built from the vendor's published field names. Real keys, constructed values. */
  | 'documented'
  /** Invented to exercise a shape. Proves nothing about the vendor at all. */
  | 'synthetic';

export interface DemoFixture {
  id: string;
  vendor: string;
  /** Product name as an owner would recognise it. */
  device: string;
  kind: 'battery' | 'panel' | 'meter' | 'inverter' | 'thermostat';
  /** One line on what this fixture is for. */
  summary: string;
  provenance: Provenance;
  /** Where the payload came from. Required — a fixture with no citation is a guess. */
  source: string;
  /** Raw vendor response, exactly as the adapter would receive it. */
  payload: Record<string, number>;
}

/** EcoFlow DELTA Pro. Key names from the published quota docs; mid-charge pack taking solar. */
const ECOFLOW_DELTA_PRO: DemoFixture = {
  id: 'ecoflow-delta-pro',
  vendor: 'ecoflow',
  device: 'EcoFlow DELTA Pro',
  kind: 'battery',
  summary: 'Portable power station, mid-charge, charging from surplus solar',
  provenance: 'documented',
  source: 'Field names from the EcoFlow IoT Open API quota documentation; values constructed.',
  payload: {
    'bms_bmsStatus.soc': 64,
    'bms_bmsStatus.designCap': 3600,
    'bms_bmsStatus.cycles': 143,
    'bms_emsStatus.minDsgSoc': 15,
    'pd.wattsInSum': 1180,
    'pd.wattsOutSum': 240,
  },
};

/**
 * EcoFlow Smart Home Panel 2 — NOT in EcoFlow's documentation. Field names from the
 * reverse-engineered tolwi/hassio-ecoflow-cloud mapping, so the least certain fixture here.
 * Reports per-circuit WATTS but no per-circuit kWh.
 */
const ECOFLOW_SHP2: DemoFixture = {
  id: 'ecoflow-shp2',
  vendor: 'ecoflow',
  device: 'EcoFlow Smart Home Panel 2',
  kind: 'panel',
  summary: 'Whole-home panel, 12 circuits, grid-connected with batteries at 78%',
  provenance: 'documented',
  source:
    'Field names from the reverse-engineered SHP2 mapping in tolwi/hassio-ecoflow-cloud; undocumented by EcoFlow. Values constructed.',
  payload: {
    'backupIncreInfo.backupBatPer': 78,
    'backupIncreInfo.backupReserveSoc': 20,
    'wattInfo.gridWatt': 1420,
    'wattInfo.allHallWatt': 2960,
    'wattInfo.chWatt[0]': -820,
    'wattInfo.chWatt[1]': -720,
    'wattInfo.chWatt[2]': 0,
    'loadInfo.hall1Watt[0]': 1180, // mini splits
    'loadInfo.hall1Watt[1]': 940, // water heater
    'loadInfo.hall1Watt[2]': 410, // kitchen
    'loadInfo.hall1Watt[3]': 180,
    'loadInfo.hall1Watt[4]': 120,
    'loadInfo.hall1Watt[5]': 90,
    'loadInfo.hall1Watt[6]': 40,
    'loadInfo.hall1Watt[7]': 0,
    'loadInfo.hall1Watt[8]': 0,
    'loadInfo.hall1Watt[9]': 0,
    'loadInfo.hall1Watt[10]': 0,
    'loadInfo.hall1Watt[11]': 0,
  },
};

/** A pack discharging overnight — the case where powerW must come out negative. */
const ECOFLOW_DISCHARGING: DemoFixture = {
  id: 'ecoflow-discharging',
  vendor: 'ecoflow',
  device: 'EcoFlow DELTA Pro (overnight)',
  kind: 'battery',
  summary: 'Discharging after dark — the case where sign convention matters',
  provenance: 'documented',
  source: 'Field names from the EcoFlow IoT Open API quota documentation; values constructed.',
  payload: {
    'bms_bmsStatus.soc': 31,
    'bms_bmsStatus.designCap': 3600,
    'bms_bmsStatus.cycles': 144,
    'bms_emsStatus.minDsgSoc': 15,
    'pd.wattsInSum': 0,
    'pd.wattsOutSum': 780,
  },
};

/** No recognised key — the reachable-but-unparseable path. Must not render as an empty battery. */
const ECOFLOW_UNKNOWN: DemoFixture = {
  id: 'ecoflow-unrecognised',
  vendor: 'ecoflow',
  device: 'EcoFlow (unsupported model)',
  kind: 'battery',
  summary: 'Reachable but unparseable — what an unsupported product should look like',
  provenance: 'synthetic',
  source: 'Invented. Exercises the parse-miss path, not any real device.',
  payload: { 'someNewTree.unknownField': 42 },
};

export const DEMO_FIXTURES: DemoFixture[] = [
  ECOFLOW_DELTA_PRO,
  ECOFLOW_SHP2,
  ECOFLOW_DISCHARGING,
  ECOFLOW_UNKNOWN,
];

export function findFixture(id: string | undefined): DemoFixture | undefined {
  return id ? DEMO_FIXTURES.find((f) => f.id === id) : undefined;
}

/** Catalogue for the picker — everything except the payloads themselves. */
export function fixtureCatalogue(): Array<Omit<DemoFixture, 'payload'>> {
  return DEMO_FIXTURES.map(({ payload: _payload, ...rest }) => rest);
}
