/**
 * Demo fixtures — recorded vendor payloads, run through the real adapters.
 *
 * Demo mode used to show one generated house. A fixture catalogue makes it a
 * showroom instead: pick a device, see what the dashboard looks like with it. That is
 * useful three ways, and the third is the reason this exists at all.
 *
 *  1. Someone deciding whether to buy can see their gear before installing anything.
 *  2. Every fixture is a regression test, because the payload goes through the SAME
 *     parser production uses rather than a demo-only shortcut. A parser change that
 *     breaks a device shows up as a broken demo.
 *  3. A vendor can be shown their own hardware running in this dashboard before they
 *     have sent any. That inverts the usual problem — no hardware means no
 *     integration means no reason to send hardware.
 *
 * PROVENANCE IS NOT DECORATION. Every fixture must declare where its numbers came
 * from, because "the demo works" and "the integration works" are different claims and
 * only `captured` fixtures support the second one. A fixture reconstructed from a
 * vendor's published field list proves we parse what the docs SAY; it proves nothing
 * about what the device actually sends. Conflating those is how an integration ships
 * broken and looks tested — which is exactly what happened to the EcoFlow signer
 * before it met EcoFlow's own test vector.
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

/**
 * EcoFlow DELTA Pro. Key names are EcoFlow's own, from the published quota
 * documentation; the values describe a mid-charge pack taking solar.
 */
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
 * EcoFlow Smart Home Panel 2. Note this device is NOT in EcoFlow's published
 * documentation at all — the field names below come from the reverse-engineered
 * mapping in the Home Assistant integration, which makes them the least certain
 * fixture here and the one most likely to break on a firmware update.
 *
 * Also worth seeing in the demo: per-circuit WATTS but no per-circuit kWh. Energy has
 * to be integrated on our side, which is the same accumulation path the CT work uses.
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

/**
 * A payload with no key we recognise. Deliberately included: the interesting failure
 * is not "device offline", it is "device connected and talking, and we do not
 * understand a word of it" — which is what a new EcoFlow product looks like on the
 * day it ships. The dashboard must say so rather than draw an empty battery.
 */
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
