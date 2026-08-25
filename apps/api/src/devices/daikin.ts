import * as dgram from 'node:dgram';

/**
 * Daikin air conditioners with a legacy Wi-Fi adaptor (BRP069A/B4x, BRP072A4x).
 *
 * These report NATIVE daily and yearly kilowatt-hours; Mitsubishi, Gree, LG, Toshiba and
 * Fujitsu expose no energy at all. Two ways in: a UDP broadcast, the better probe but one
 * that cannot cross a Docker bridge, and plain unauthenticated HTTP on port 80.
 *
 * LEGACY adaptors only. Newer firmware (BRP069C4x 2.x) is cloud-only and the BRP084
 * generation uses a different local scheme; neither answers this probe.
 */

const DISCOVERY_PORT = 30050;
const PROBE = 'DAIKIN_UDP/common/basic_info';
const DEFAULT_LISTEN_MS = 3_000;
const HTTP_TIMEOUT_MS = 3_000;

export interface DaikinInfo {
  /** Owner-set name, URL-encoded on the wire. */
  name: string;
  mac: string;
  firmware?: string;
  /** Region code the adaptor reports (eu, jp, us…). */
  region?: string;
  powerOn?: boolean;
}

/**
 * Parse Daikin's response format: comma-separated `key=value` pairs beginning with `ret=OK`.
 * Anything else, `ret=PARAM NG` included, is not a usable answer. The name is percent-encoded
 * per byte (`%4c%69%76%69%6e%67`) and can break decodeURIComponent, so a decode failure keeps
 * the raw value.
 */
export function parseBasicInfo(body: string): DaikinInfo | null {
  if (!body.startsWith('ret=OK')) return null;
  const fields = new Map<string, string>();
  for (const pair of body.trim().split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) fields.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  // `type=aircon` separates a Daikin adaptor from anything else answering key=value pairs.
  if (fields.get('type') !== 'aircon') return null;
  const mac = fields.get('mac');
  if (!mac) return null;

  const rawName = fields.get('name') ?? '';
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    /* malformed encoding — a wrong name beats no device */
  }

  return {
    name: name || 'Daikin',
    mac,
    firmware: fields.get('ver')?.replace(/_/g, '.'),
    region: fields.get('reg'),
    // `pow` is 0/1. Absent on some firmware, which is unknown rather than off.
    powerOn: fields.has('pow') ? fields.get('pow') === '1' : undefined,
  };
}

/** Split Daikin's `key=value,key=value` body into a map. */
export function parseFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  if (!body.startsWith('ret=OK')) return fields;
  for (const pair of body.trim().split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) fields.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return fields;
}

/**
 * A temperature field, or null. Daikin writes "-" for a sensor it does not have — humidity
 * on most units, outdoor temperature on some indoor-only adaptors — and Number("-") is NaN.
 */
function temperature(raw: string | undefined): number | null {
  if (raw === undefined || raw === '-' || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export interface DaikinSensors {
  indoorC: number | null;
  outdoorC: number | null;
}

export function parseSensorInfo(body: string): DaikinSensors | null {
  const fields = parseFields(body);
  if (fields.size === 0) return null;
  return {
    indoorC: temperature(fields.get('htemp')),
    outdoorC: temperature(fields.get('otemp')),
  };
}

export interface DaikinControl {
  on: boolean;
  targetC: number | null;
  /** Every field the device returned, needed to write a change back safely. */
  raw: Map<string, string>;
}

export function parseControlInfo(body: string): DaikinControl | null {
  const fields = parseFields(body);
  if (fields.size === 0 || !fields.has('pow')) return null;
  return {
    on: fields.get('pow') === '1',
    // In fan-only and some auto modes the setpoint reads "M" or "--".
    targetC: temperature(fields.get('stemp')),
    raw: fields,
  };
}

/**
 * Build the query for a control change. Daikin's set endpoint is NOT a patch: it applies
 * exactly the fields sent and omitting one resets it to a default, so sending only `stemp`
 * also switches mode and fan speed. Every change is a read-modify-write of the full control
 * set, and this refuses a control block that did not come off the device.
 */
export function buildControlQuery(
  current: DaikinControl,
  changes: { on?: boolean; targetC?: number },
): string | null {
  const required = ['mode', 'stemp', 'shum', 'f_rate', 'f_dir'];
  if (required.some((key) => !current.raw.has(key))) return null;

  const pow = changes.on === undefined ? (current.on ? '1' : '0') : changes.on ? '1' : '0';
  const stemp =
    changes.targetC === undefined ? current.raw.get('stemp')! : changes.targetC.toFixed(1);
  const params = new URLSearchParams({
    pow,
    mode: current.raw.get('mode')!,
    stemp,
    shum: current.raw.get('shum')!,
    f_rate: current.raw.get('f_rate')!,
    f_dir: current.raw.get('f_dir')!,
  });
  return params.toString();
}

/**
 * Today's energy from the hourly power history. `curr_day_heat` and `curr_day_cool` are 24
 * slash-separated hourly buckets of 0.1 kWh each, so a small head drawing a few hundred
 * watts carries 15–30% granularity error per hour: fine daily, useless as live power.
 */
export function parseDayPower(body: string): number | null {
  const fields = parseFields(body);
  if (fields.size === 0) return null;
  const sumOf = (key: string): number | null => {
    const raw = fields.get(key);
    if (!raw) return null;
    let total = 0;
    let seen = false;
    for (const part of raw.split('/')) {
      const value = Number(part);
      if (!Number.isFinite(value)) continue;
      total += value;
      seen = true;
    }
    return seen ? total : null;
  };
  const heat = sumOf('curr_day_heat');
  const cool = sumOf('curr_day_cool');
  if (heat === null && cool === null) return null;
  // 0.1 kWh per unit -> 100 Wh.
  return ((heat ?? 0) + (cool ?? 0)) * 100;
}

/** Ask one host over HTTP. Works through NAT, unlike the broadcast below. */
export async function daikinIdentify(host: string): Promise<DaikinInfo | null> {
  try {
    const response = await fetch(`http://${host}/common/basic_info`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { connection: 'close' },
    });
    if (!response.ok) return null;
    return parseBasicInfo(await response.text());
  } catch {
    return null;
  }
}

/**
 * Broadcast for Daikin adaptors and collect the replies. Active rather than passive: unlike
 * Tuya these do not announce themselves. Cannot cross a Docker bridge, unlike the HTTP path.
 */
export function sweepDaikin(listenMs = DEFAULT_LISTEN_MS): Promise<Array<DaikinInfo & { host: string }>> {
  return new Promise((resolve) => {
    const found = new Map<string, DaikinInfo & { host: string }>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('message', (msg, rinfo) => {
      const info = parseBasicInfo(msg.toString('utf8'));
      if (info) found.set(info.mac, { ...info, host: rinfo.address });
    });
    socket.on('error', () => {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      resolve([...found.values()]);
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.send(Buffer.from(PROBE), DISCOVERY_PORT, '255.255.255.255');
      } catch {
        /* no broadcast permission — the HTTP probe still covers it */
      }
    });

    setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...found.values()]);
    }, listenMs);
  });
}
