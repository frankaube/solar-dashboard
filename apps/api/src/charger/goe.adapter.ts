/**
 * go-e Charger, local HTTP API v2.
 *
 * The best-documented local charger API going: unauthenticated, on the LAN, with a
 * published key reference. Field meanings below are from go-e's own apikeys-en.md.
 *
 *   car  carState — Unknown/Error=0, Idle=1, Charging=2, WaitCar=3, Complete=4, Error=5
 *   alw  whether the car is allowed to charge right now
 *   amp  requested current, A
 *   wh   energy since the car was connected, Wh
 *   eto  energy_total, Wh
 *   nrg  U(L1,L2,L3,N), I(L1,L2,L3), P(L1,L2,L3,N,Total), pf(L1,L2,L3,N)
 *
 * So `nrg[11]` is total power. Its unit is the one thing the reference does not pin down,
 * and guessing wrong is a 1000x error in a dollar figure — see `totalPowerW`.
 */

export const GOE_STATUS_FILTER = 'car,alw,amp,wh,eto,nrg,fna';

export interface GoeStatus {
  /** Charger's own name, when set. */
  name: string | null;
  carState: number | null;
  connected: boolean;
  charging: boolean;
  allowedToCharge: boolean;
  requestedCurrentA: number | null;
  sessionEnergyWh: number | null;
  lifetimeEnergyWh: number | null;
  powerW: number | null;
  voltageV: number | null;
  currentA: number | null;
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

const NRG = { voltageL1: 0, currentL1: 4, powerTotal: 11 } as const;

/**
 * Total power in watts, with the unit derived rather than assumed.
 *
 * go-e's key reference documents the `nrg` layout but not the scale of its power entries,
 * and v1 of this API reported power in a scaled form that caught people out. Rather than
 * pick one and be wrong on half the firmware versions, the expected magnitude is computed
 * from the voltage and current the same array reports: a charger drawing 32 A at 240 V is
 * near 7.7 kW, so a reported `7.36` must be kilowatts and `7360` must be watts.
 *
 * Falls back to treating the value as watts when there is no current flowing, which is
 * the only case where the cross-check has nothing to say — and also the case where the
 * answer is zero either way.
 */
export function totalPowerW(nrg: unknown[]): number | null {
  const raw = num(nrg[NRG.powerTotal]);
  if (raw === null) return null;
  if (raw === 0) return 0;
  const volts = num(nrg[NRG.voltageL1]) ?? 0;
  const amps = num(nrg[NRG.currentL1]) ?? 0;
  const expected = volts * amps;
  if (expected <= 0) return raw;
  // Whichever interpretation lands closer to V x I wins.
  return Math.abs(raw - expected) <= Math.abs(raw * 1000 - expected) ? raw : raw * 1000;
}

export function parseGoeStatus(body: unknown): GoeStatus {
  const s = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const nrg = Array.isArray(s.nrg) ? s.nrg : [];
  const carState = num(s.car);
  return {
    name: typeof s.fna === 'string' && s.fna.trim() !== '' ? s.fna.trim() : null,
    carState,
    /*
      Idle (1) means no car. Every other known state means something is plugged in —
      including Complete (4), where the cable is still attached and a schedule may yet
      resume charging.
    */
    connected: carState !== null && carState !== 0 && carState !== 1,
    charging: carState === 2,
    allowedToCharge: s.alw === true,
    requestedCurrentA: num(s.amp),
    sessionEnergyWh: num(s.wh),
    lifetimeEnergyWh: num(s.eto),
    powerW: totalPowerW(nrg),
    voltageV: num(nrg[NRG.voltageL1]),
    currentA: num(nrg[NRG.currentL1]),
  };
}

/** Human label for a carState, for the UI and the logs. */
export function describeCarState(state: number | null): string {
  switch (state) {
    case 1:
      return 'no car';
    case 2:
      return 'charging';
    case 3:
      return 'waiting for car';
    case 4:
      return 'complete';
    case 5:
      return 'error';
    case 0:
      return 'unknown';
    default:
      return 'no data';
  }
}

export function goeStatusUrl(host: string): string {
  /*
    Filtered deliberately. go-e's own documentation asks for it to reduce load on the
    charger, and an unfiltered status on a V4 is a large document fetched every poll.
  */
  return `http://${host}/api/status?filter=${GOE_STATUS_FILTER}`;
}
