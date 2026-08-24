import * as dgram from 'node:dgram';

const MDNS_PORT = 5353;
const SWEEP_PACING_MS = 15;
const COLLECT_MS = 6_000;

/**
 * One-shot unicast mDNS sweep of a /24 for HomeKit accessories (_hap._tcp).
 * Unicast-per-host sidesteps the OS-owned multicast socket and is gentle:
 * one tiny UDP packet per host. Returns id/model/category/port per responder.
 */
export interface HapDevice {
  host: string;
  port: number;
  name: string;
  model: string;
  hapId: string;
  category: number;
  paired: boolean;
}

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  return Buffer.concat([
    ...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])),
    Buffer.from([0]),
  ]);
}

function buildQuery(service: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([
    header,
    encodeName(service),
    Buffer.from([0x00, 0x0c, 0x00, 0x01]), // PTR, IN
  ]);
}

/** One mDNS responder, before we know what kind of device it is. */
export interface MdnsResponder {
  host: string;
  port: number;
  /** Instance name with the service suffix stripped. */
  name: string;
  txt: Record<string, string>;
}

/**
 * Unicast mDNS sweep of a /24 for one service type.
 *
 * The service was hardcoded to `_hap._tcp` — which meant ESPHome devices were
 * undiscoverable by mDNS even though we ship an ESPHome adapter, so one with its web
 * server disabled was invisible despite being fully supported.
 *
 * Unicast-per-host rather than multicast sidesteps the OS-owned multicast socket, and
 * is gentle: one small UDP packet per host.
 */
export function sweepMdns(subnetPrefix: string, service: string): Promise<MdnsResponder[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const found = new Map<string, MdnsResponder>();
    const suffix = new RegExp(`\\.${service.replace(/\./g, '\\.')}$`);
    socket.on('message', (msg, rinfo) => {
      try {
        const counts = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
        let off = 12;
        const qd = msg.readUInt16BE(4);
        for (let i = 0; i < qd; i++) off = readName(msg, off).next + 4;
        let port = 0;
        let name = '';
        let txt: Record<string, string> = {};
        for (let i = 0; i < counts; i++) {
          const n = readName(msg, off);
          off = n.next;
          const type = msg.readUInt16BE(off);
          const rdlen = msg.readUInt16BE(off + 8);
          const rdata = msg.subarray(off + 10, off + 10 + rdlen);
          if (type === 33) {
            port = rdata.readUInt16BE(4);
            name = n.name.replace(suffix, '');
          } else if (type === 16 && n.name.includes(service.replace(/\.local$/, ''))) {
            txt = parseTxt(rdata);
          }
          off += 10 + rdlen;
        }
        if (port || Object.keys(txt).length) {
          found.set(rinfo.address, { host: rinfo.address, port, name, txt });
        }
      } catch {
        /* partial packets ignored */
      }
    });
    socket.bind(0, () => {
      const packet = buildQuery(service);
      for (let host = 1; host <= 254; host++) {
        setTimeout(
          () => socket.send(packet, MDNS_PORT, `${subnetPrefix}.${host}`),
          host * SWEEP_PACING_MS,
        );
      }
    });
    setTimeout(() => {
      socket.close();
      resolve([...found.values()]);
    }, COLLECT_MS + 254 * SWEEP_PACING_MS);
  });
}

function readName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let jumped = false;
  let next = offset;
  let guard = 0;
  while (guard++ < 64) {
    const len = buf[offset];
    if (len === undefined || len === 0) {
      if (len === 0) offset += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[offset + 1];
      if (!jumped) next = offset + 2;
      offset = ptr;
      jumped = true;
      continue;
    }
    labels.push(buf.subarray(offset + 1, offset + 1 + len).toString());
    offset += 1 + len;
  }
  return { name: labels.join('.'), next: jumped ? next : offset };
}

function parseTxt(rdata: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (p < rdata.length) {
    const len = rdata[p];
    const entry = rdata.subarray(p + 1, p + 1 + len).toString();
    const eq = entry.indexOf('=');
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    p += 1 + len;
  }
  return out;
}

/** HomeKit accessories. A thin reading of the generic sweep above. */
export async function sweepHap(subnetPrefix: string): Promise<HapDevice[]> {
  const responders = await sweepMdns(subnetPrefix, '_hap._tcp.local');
  return responders
    .filter((r) => r.txt.id)
    .map((r) => ({
      host: r.host,
      port: r.port,
      name: r.name || (r.txt.md ?? 'HomeKit accessory'),
      model: r.txt.md ?? 'unknown',
      hapId: r.txt.id,
      category: Number(r.txt.ci ?? 0),
      paired: r.txt.sf === '0',
    }));
}
