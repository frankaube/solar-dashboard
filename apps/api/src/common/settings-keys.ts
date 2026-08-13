/**
 * Settings-table keys shared across modules.
 *
 * They live here rather than on a service because both the collector (which writes
 * some of them) and ReadingsService (which reads them) need the names — and
 * ReadingsService already depends on CollectorService, so exporting a key from either
 * one makes the import circular. Nest resolves that as an undefined dependency at
 * boot, which takes the whole API down rather than failing in the module that caused
 * it.
 */

/**
 * Panels the DTU says exist.
 *
 * Distinct from the number of panels we hold data for: a registered inverter can be
 * absent from the per-inverter response while still counting toward the DTU's totals.
 */
export const PV_COUNT_SETTING_KEY = 'dtuPvCount';

/**
 * Inverters the DTU says are registered.
 *
 * Persisted next to the panel count for the same reason: it is the array's true shape,
 * not the number of units we happen to have data for, and the census needs it after a
 * restart rather than only once the DTU has been asked again.
 */
export const INVERTER_COUNT_SETTING_KEY = 'dtuInverterCount';
