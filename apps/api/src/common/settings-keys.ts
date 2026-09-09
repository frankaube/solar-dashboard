/**
 * Not on a service: ReadingsService already depends on CollectorService, so exporting a key
 * from either makes the import circular, which Nest resolves as undefined at boot.
 */

/**
 * Panels the DTU says exist — not the number there is data for. A registered inverter can be
 * absent from the per-inverter response while still counting toward the DTU's totals.
 */
export const PV_COUNT_SETTING_KEY = 'dtuPvCount';

/** Inverters the DTU says are registered. Persisted so the census survives a restart. */
export const INVERTER_COUNT_SETTING_KEY = 'dtuInverterCount';
