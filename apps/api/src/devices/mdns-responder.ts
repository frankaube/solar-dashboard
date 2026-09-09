import * as dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';

const MDNS_PORT = 5353;
const MDNS_GROUP = '224.0.0.251';
/** Seconds. Short enough that a moved install stops answering quickly. */
const TTL = 120;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const TYPE_ANY = 255;
const CLASS_IN = 1;
/** Top bit of the class field: "this is the authoritative answer, flush your cache". */
const FLUSH = 0x8000;

/**
 * Answers mDNS queries for a fixed `.local` name, so the dashboard has the same URL on
 * every machine. The OS responder differs per install and answers with every local address
 * — a dev box offers nine, three of them Hyper-V and WSL adapters a phone can never reach.
 * This answers with one: the LAN address the query arrived on.
 *
 * A responder only; `mdns.ts` does the one-shot unicast queries, on its own socket.
 */
export interface MdnsResponderOptions {
  /** Bare label — "solar-dashboard" becomes "solar-dashboard.local". */
  hostname: string;
  port: number;
  /** Shown in service browsers (Bonjour, Android, "Network" in Explorer). */
  serviceName?: string;
}

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  return Buffer.concat([
    ...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])),
    Buffer.from([0]),
  ]);
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

export interface Question {
  name: string;
  type: number;
}

/** Pull the questions out of a query; answers/authority sections are ignored. */
export function parseQuestions(msg: Buffer): Question[] {
  if (msg.length < 12) return [];
  const flags = msg.readUInt16BE(2);
  // QR bit set means this is a response, not a question for us to answer.
  if ((flags & 0x8000) !== 0) return [];
  const count = msg.readUInt16BE(4);
  const out: Question[] = [];
  let offset = 12;
  for (let i = 0; i < count && offset < msg.length; i++) {
    const { name, next } = readName(msg, offset);
    if (next + 4 > msg.length) break;
    out.push({ name: name.toLowerCase(), type: msg.readUInt16BE(next) });
    offset = next + 4;
  }
  return out;
}

function record(name: string, type: number, rdata: Buffer, flush = true): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(flush ? CLASS_IN | FLUSH : CLASS_IN, 2);
  head.writeUInt32BE(TTL, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), head, rdata]);
}

/** Build a response packet carrying the given answer records. */
export function buildResponse(answers: Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  // QR=1 (response) + AA=1 (authoritative), which is what mDNS requires.
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(answers.length, 6);
  return Buffer.concat([header, ...answers]);
}

/**
 * The IPv4 address on the same subnet as whoever asked: a querying phone has no way to know
 * that 172.31.112.1 is a WSL adapter it can never reach.
 */
export function pickAddressFor(
  remote: string,
  interfaces: Array<{ address: string; netmask: string; internal: boolean }>,
): string | null {
  const toInt = (ip: string): number =>
    ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
  const candidates = interfaces.filter((i) => !i.internal);
  const remoteInt = toInt(remote);
  for (const iface of candidates) {
    const mask = toInt(iface.netmask);
    if ((toInt(iface.address) & mask) === (remoteInt & mask)) return iface.address;
  }
  return candidates[0]?.address ?? null;
}

function ipv4Interfaces(): Array<{ address: string; netmask: string; internal: boolean }> {
  const out: Array<{ address: string; netmask: string; internal: boolean }> = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4') {
        out.push({ address: iface.address, netmask: iface.netmask, internal: iface.internal });
      }
    }
  }
  return out;
}

export class MdnsResponder {
  private socket: dgram.Socket | null = null;
  private readonly host: string;
  private readonly instance: string;
  private readonly port: number;

  constructor(options: MdnsResponderOptions) {
    this.host = `${options.hostname}.local`;
    this.instance = `${options.serviceName ?? 'Solar Dashboard'}._http._tcp.local`;
    this.port = options.port;
  }

  /** Resolves once listening, or rejects if the socket cannot be opened. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      /* reuseAddr is not optional: without it, binding throws EADDRINUSE on any machine
         already running Bonjour, Docker Desktop or a printer utility on 5353. */
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.once('error', reject);
      socket.on('message', (msg, rinfo) => this.onQuery(msg, rinfo));
      socket.bind(MDNS_PORT, () => {
        /*
          Join on every interface, not just the default one.

          `addMembership(group)` with no interface joins whichever one the routing table
          prefers, routinely a Hyper-V or WSL adapter — and queries arriving over the real
          LAN are then never received, which is the only case a phone can produce.
        */
        let joined = 0;
        for (const iface of ipv4Interfaces()) {
          if (iface.internal) continue;
          try {
            socket.addMembership(MDNS_GROUP, iface.address);
            joined += 1;
          } catch {
            // Interface down, already joined, or not multicast-capable — skip it.
          }
        }
        if (joined === 0) {
          try {
            socket.addMembership(MDNS_GROUP);
          } catch {
            // No multicast anywhere: stay bound, answer nothing.
          }
        }
        socket.removeListener('error', reject);
        socket.on('error', () => {
          /* transient send errors must not take the app down */
        });
        this.socket = socket;
        this.announce();
        resolve();
      });
    });
  }

  private onQuery(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    let questions: Question[];
    try {
      questions = parseQuestions(msg);
    } catch {
      return; // Malformed packet from somewhere on the LAN; not our problem.
    }
    const wantsHost = questions.some(
      (q) => q.name === this.host && (q.type === TYPE_A || q.type === TYPE_ANY),
    );
    const wantsService = questions.some(
      (q) => q.name === '_http._tcp.local' && (q.type === TYPE_PTR || q.type === TYPE_ANY),
    );
    if (!wantsHost && !wantsService) return;

    const address = pickAddressFor(rinfo.address, ipv4Interfaces());
    if (!address) return;

    const answers: Buffer[] = [];
    if (wantsHost) answers.push(this.aRecord(address));
    if (wantsService) answers.push(...this.serviceRecords(address));
    this.send(buildResponse(answers), address);
  }

  private aRecord(address: string): Buffer {
    return record(this.host, TYPE_A, Buffer.from(address.split('.').map(Number)));
  }

  private serviceRecords(address: string): Buffer[] {
    const srv = Buffer.alloc(6);
    srv.writeUInt16BE(0, 0); // priority
    srv.writeUInt16BE(0, 2); // weight
    srv.writeUInt16BE(this.port, 4);
    const txt = Buffer.from([0x05, ...Buffer.from('path=/')]);
    return [
      record('_http._tcp.local', TYPE_PTR, encodeName(this.instance), false),
      record(this.instance, TYPE_SRV, Buffer.concat([srv, encodeName(this.host)])),
      record(this.instance, TYPE_TXT, txt),
      this.aRecord(address),
    ];
  }

  /**
   * Unsolicited announcement so caches learn the name without being asked. One per
   * interface, each carrying that interface's own address: the records set the cache-flush
   * bit, so a mismatched pairing overwrites a good cached answer with an unroutable one.
   */
  private announce(): void {
    for (const iface of ipv4Interfaces()) {
      if (iface.internal) continue;
      const packet = buildResponse([
        this.aRecord(iface.address),
        ...this.serviceRecords(iface.address),
      ]);
      this.send(packet, iface.address);
    }
  }

  /**
   * Send out the interface that owns `via`. Without setMulticastInterface every packet
   * leaves through whichever interface the routing table prefers, often one the asker
   * cannot see.
   */
  private send(packet: Buffer, via: string): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.setMulticastInterface(via);
    } catch {
      // Interface vanished between the query and the reply; fall through and try anyway.
    }
    socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_GROUP, () => {
      /* best effort */
    });
  }

  /**
   * Goodbye packet, then close. TTL zero tells every cache to drop the name at once;
   * without it the name resolves to a dead address for up to TTL seconds.
   */
  stop(): void {
    const socket = this.socket;
    if (!socket) return;
    const interfaces = ipv4Interfaces().filter((i) => !i.internal);
    for (const iface of interfaces) {
      const rdata = Buffer.from(iface.address.split('.').map(Number));
      const head = Buffer.alloc(10);
      head.writeUInt16BE(TYPE_A, 0);
      head.writeUInt16BE(CLASS_IN | FLUSH, 2);
      head.writeUInt32BE(0, 4); // TTL 0 = goodbye
      head.writeUInt16BE(rdata.length, 8);
      this.send(buildResponse([Buffer.concat([encodeName(this.host), head, rdata])]), iface.address);
    }
    this.socket = null;
    // Let the goodbye packets leave before tearing the socket down.
    setTimeout(() => socket.close(), 100).unref();
  }
}
