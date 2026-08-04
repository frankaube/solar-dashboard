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
 * Answers mDNS queries for a fixed `.local` name, so the dashboard has a URL that is
 * the same on every machine it is installed on.
 *
 * Windows already answers for its own machine name, which is why this looked
 * unnecessary at first. It is not good enough for two reasons. The name differs on
 * every install, so nothing generic can be written in a README or an installer; and
 * a dev box answers `desktop.local` with nine addresses, three of them Hyper-V and
 * WSL virtual adapters — a phone can be handed 172.31.112.1 and simply fail. This
 * responder answers with one address: the LAN address the query arrived on.
 *
 * Deliberately a responder only. `mdns.ts` next door does one-shot unicast queries and
 * says it avoids the multicast socket on purpose; this is the other half, and the two
 * do not share a socket.
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
 * The IPv4 address on the same subnet as whoever asked.
 *
 * Answering with every local address is what makes the OS responder unreliable here —
 * a querying phone has no way to know that 172.31.112.1 is a WSL adapter it can never
 * reach. Matching the asker's subnet picks the one address that is actually routable
 * from where the question came from.
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
      /*
        reuseAddr is not optional here: three processes were already bound to 5353 on
        the dev machine (Docker, Bonjour, and one other). Without it, binding throws
        EADDRINUSE and the app would fail to boot on any machine running iTunes,
        Docker Desktop, or a printer utility.
      */
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.once('error', reject);
      socket.on('message', (msg, rinfo) => this.onQuery(msg, rinfo));
      socket.bind(MDNS_PORT, () => {
        /*
          Join on every interface, not just the default one.

          `addMembership(group)` with no interface joins whichever one the routing
          table prefers. On a machine with Hyper-V or WSL installed that is routinely
          a virtual adapter, and the responder then never receives queries arriving
          over the real LAN — measured here: a query from the Hyper-V interface was
          answered, an identical query from the LAN interface got silence. Since a
          phone can only ask over the LAN, that is the only case that matters.
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
   * Unsolicited announcement so caches learn the name without being asked.
   *
   * One per interface, each carrying that interface's own address — not one packet
   * repeated everywhere. The records carry the cache-flush bit, so announcing
   * "solar-dashboard.local is 10.0.0.231" out of the WSL adapter would tell listeners
   * there to overwrite a perfectly good answer with an address they cannot route to.
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
   * Send out the interface that owns `via`.
   *
   * Without setMulticastInterface every packet leaves through whichever interface the
   * routing table prefers, which on this machine is a Hyper-V adapter — so a reply
   * addressed to a phone's question would go out an interface the phone cannot see.
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
   * Goodbye packet, then close.
   *
   * A TTL of zero tells every cache on the network to drop the name immediately.
   * Without it the name keeps resolving to a dead address for up to TTL seconds after
   * the service stops — which looks exactly like the app being broken.
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
