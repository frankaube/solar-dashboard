import { HomeDevice, DeviceUsage } from '../api';

/**
 * The words the Devices page uses, and the arithmetic behind its three numbers.
 *
 * Split out from the page so the naming can be tested without mounting a form — the
 * interesting part of this redesign is which sentence a state produces, not where the
 * div sits.
 *
 * From the Sunhouse design (claude.ai/design "Solar Dashboard UI Overhaul"): a state
 * should say what to do about it. `unreachable` and `no data yet` were both accurate and
 * both useless — one is a fault, the other is a device that has simply not spoken yet,
 * and rendering them in the same weight made every row look equally broken.
 */

export type StateTone = 'ok' | 'warn' | 'bad' | 'idle';

export interface DeviceState {
  label: string;
  tone: StateTone;
  /** The second line under the name — what happened, or when. */
  detail: string | null;
}

export function needsPairing(device: HomeDevice): boolean {
  return device.vendor === 'mysa' && !device.config;
}

/** "3 days ago", "4 hours ago", "just now" — how long since it last said anything. */
export function lastHeard(iso: string | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * What a device's state is called, and what to say underneath it.
 *
 * "Lost contact" rather than "unreachable", because the first names a thing that happened
 * to a device and the second reads like a property of it. "Waiting" rather than "no data
 * yet", because a device that has never reported is not broken and should not be coloured
 * as though it were.
 */
export function describeState(device: HomeDevice, now: Date = new Date()): DeviceState {
  if (needsPairing(device)) {
    return { label: 'Needs pairing', tone: 'warn', detail: 'Enter the code on the device' };
  }
  const state = device.state;
  if (!state) return { label: 'Waiting', tone: 'idle', detail: 'Nothing reported yet' };
  if (!state.reachable) {
    const heard = lastHeard(state.updatedAt, now);
    return { label: 'Lost contact', tone: 'bad', detail: heard ? `Last heard ${heard}` : null };
  }
  if (device.kind === 'thermostat') {
    if (state.temperatureC === null || state.temperatureC === undefined) {
      return { label: 'Waiting', tone: 'idle', detail: 'Paired, no readings yet' };
    }
    const target = state.setpointC === null || state.setpointC === undefined ? null : state.setpointC;
    return {
      label: state.heating ? 'Heating' : 'Idle',
      tone: state.heating ? 'ok' : 'idle',
      detail: `${state.temperatureC.toFixed(1)}°${target === null ? '' : ` → ${target.toFixed(1)}°`}`,
    };
  }
  return {
    label: state.on ? 'On' : 'Off',
    tone: state.on ? 'ok' : 'idle',
    /*
      Deliberately NOT the signal strength. "-55 dBm" was on every row and told a
      homeowner nothing; the design removes it from the surface entirely.
    */
    detail: null,
  };
}

/** Plain-English kind, for the column that replaced three separate card headings. */
export function describeKind(kind: string): string {
  const named: Record<string, string> = {
    thermostat: 'Thermostat',
    switch: 'Switch',
    plug: 'Plug',
    light: 'Light',
    meter: 'Meter',
    battery: 'Battery',
    charger: 'Charger',
  };
  return named[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

export interface DeviceHeadline {
  /** How many are actually reporting, over how many exist. */
  reporting: number;
  total: number;
  /** One sentence a homeowner can act on, or null when nothing is wrong. */
  sentence: string;
  troubled: number;
}

/**
 * The sentence at the top of the page.
 *
 * Names the group rather than listing rows when several of a kind fail together, because
 * "Both thermostats have gone quiet" is a thing you can go and look at, while three
 * separate warnings about three thermostats is a list to work through.
 */
export function headline(devices: HomeDevice[], now: Date = new Date()): DeviceHeadline {
  const total = devices.length;
  const reporting = devices.filter((d) => d.state?.reachable && !needsPairing(d)).length;
  const troubledDevices = devices.filter((d) => {
    const state = describeState(d, now);
    return state.tone === 'bad' || state.tone === 'warn';
  });
  const troubled = troubledDevices.length;

  if (total === 0) {
    return { reporting, total, troubled, sentence: 'No devices yet. Add one to start watching it.' };
  }
  if (troubled === 0) {
    return { reporting, total, troubled, sentence: 'Everything is reporting. Nothing needs a look.' };
  }

  const kinds = new Set(troubledDevices.map((d) => d.kind));
  if (kinds.size === 1) {
    const kind = describeKind([...kinds][0]).toLowerCase();
    const sameKindTotal = devices.filter((d) => d.kind === troubledDevices[0].kind).length;
    const all = troubled === sameKindTotal;
    const subject =
      troubled === 1
        ? `One ${kind} has`
        : all && troubled === 2
          ? `Both ${kind}s have`
          : `${troubled} ${kind}s have`;
    const rest = troubled === total ? '' : ' Nothing else is wrong.';
    return { reporting, total, troubled, sentence: `${subject} gone quiet.${rest}` };
  }
  return {
    reporting,
    total,
    troubled,
    sentence: `${troubled} devices have gone quiet.${troubled === total ? '' : ' Nothing else is wrong.'}`,
  };
}

/** Live draw across everything that can actually measure it, in kW, or null if none can. */
export function usingNowKw(devices: HomeDevice[]): number | null {
  const metered = devices.filter((d) => typeof d.state?.powerW === 'number');
  if (metered.length === 0) return null;
  return metered.reduce((sum, d) => sum + (d.state?.powerW ?? 0), 0) / 1000;
}

/**
 * What these devices cost a month, from a week of observation.
 *
 * Deliberately in cents-or-dollars rather than kWh, because "31¢ a month" is the number
 * that decides whether you care and "1.9 kWh" is not. Returns null rather than zero when
 * nothing has been measured or estimated — a confident 0¢ would be a lie.
 */
export function monthlyCost(usage: DeviceUsage[], retailPerKwh: number): string | null {
  const known = usage.filter((u) => typeof u.energyKwh === 'number');
  if (known.length === 0 || retailPerKwh <= 0) return null;
  const weekly = known.reduce((sum, u) => sum + (u.energyKwh ?? 0), 0);
  const monthly = (weekly / 7) * 30 * retailPerKwh;
  if (monthly < 1) return `${Math.round(monthly * 100)}¢ a month`;
  return `$${monthly.toFixed(monthly < 10 ? 2 : 0)} a month`;
}

/** True when every figure behind the cost was estimated rather than metered. */
export function costIsEstimated(usage: DeviceUsage[]): boolean {
  const known = usage.filter((u) => typeof u.energyKwh === 'number');
  return known.length > 0 && known.every((u) => !u.metered);
}
