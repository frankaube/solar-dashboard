import { describe, expect, it } from 'vitest';
import { buildResponse, parseQuestions, pickAddressFor } from '../src/devices/mdns-responder';

/** Encode a name the way a querying client would. */
function name(value: string): Buffer {
  const parts = value.split('.').filter(Boolean);
  return Buffer.concat([
    ...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])),
    Buffer.from([0]),
  ]);
}

function query(qname: string, type = 1): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, name(qname), tail]);
}

describe('parseQuestions', () => {
  it('reads the name and type out of a query', () => {
    expect(parseQuestions(query('solar-dashboard.local'))).toEqual([
      { name: 'solar-dashboard.local', type: 1 },
    ]);
  });

  it('lowercases names, because DNS matching is case-insensitive', () => {
    expect(parseQuestions(query('Solar-Dashboard.LOCAL'))[0].name).toBe('solar-dashboard.local');
  });

  it('ignores responses', () => {
    // Answering another responder's announcement would start a broadcast storm.
    const response = query('solar-dashboard.local');
    response.writeUInt16BE(0x8400, 2); // QR + AA
    expect(parseQuestions(response)).toEqual([]);
  });

  it('survives truncated and empty packets rather than throwing', () => {
    // These arrive from anything on the LAN; a crash here would take the app down.
    expect(parseQuestions(Buffer.alloc(0))).toEqual([]);
    expect(parseQuestions(Buffer.alloc(4))).toEqual([]);
    expect(parseQuestions(query('solar-dashboard.local').subarray(0, 16))).toEqual([]);
  });

  it('reads multiple questions in one packet', () => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(2, 4);
    const q = (n: string, t: number): Buffer => {
      const tail = Buffer.alloc(4);
      tail.writeUInt16BE(t, 0);
      tail.writeUInt16BE(1, 2);
      return Buffer.concat([name(n), tail]);
    };
    const packet = Buffer.concat([header, q('solar-dashboard.local', 1), q('_http._tcp.local', 12)]);
    expect(parseQuestions(packet)).toEqual([
      { name: 'solar-dashboard.local', type: 1 },
      { name: '_http._tcp.local', type: 12 },
    ]);
  });
});

describe('buildResponse', () => {
  it('marks the packet as an authoritative response', () => {
    const packet = buildResponse([Buffer.from([0xde, 0xad])]);
    expect(packet.readUInt16BE(2) & 0x8000).toBe(0x8000); // QR
    expect(packet.readUInt16BE(2) & 0x0400).toBe(0x0400); // AA
    expect(packet.readUInt16BE(6)).toBe(1); // answer count
  });

  it('counts every answer', () => {
    expect(buildResponse([Buffer.alloc(2), Buffer.alloc(2), Buffer.alloc(2)]).readUInt16BE(6)).toBe(3);
  });
});

/**
 * The whole reason this responder exists. Windows answers for its own machine name
 * with every address it has — on the dev machine that was nine, including Hyper-V and
 * WSL adapters. A phone handed 172.31.112.1 cannot reach it and the name looks broken.
 */
describe('pickAddressFor', () => {
  const IFACES = [
    { address: '127.0.0.1', netmask: '255.0.0.0', internal: true },
    { address: '172.29.48.1', netmask: '255.255.240.0', internal: false }, // Hyper-V
    { address: '172.31.112.1', netmask: '255.255.240.0', internal: false }, // WSL
    { address: '10.0.0.231', netmask: '255.255.255.0', internal: false }, // the real LAN
  ];

  it('answers a LAN client with the LAN address, not a virtual adapter', () => {
    expect(pickAddressFor('10.0.0.55', IFACES)).toBe('10.0.0.231');
  });

  it('answers a WSL client with the WSL address', () => {
    // Same rule, the other direction: whoever asks gets the address that reaches us.
    expect(pickAddressFor('172.31.112.9', IFACES)).toBe('172.31.112.1');
  });

  it('never answers with a loopback address', () => {
    expect(pickAddressFor('10.0.0.55', IFACES)).not.toBe('127.0.0.1');
    expect(pickAddressFor('8.8.8.8', IFACES)).not.toBe('127.0.0.1');
  });

  it('falls back to the first real address when no subnet matches', () => {
    expect(pickAddressFor('8.8.8.8', IFACES)).toBe('172.29.48.1');
  });

  it('returns null when there is nothing but loopback', () => {
    expect(pickAddressFor('10.0.0.55', [IFACES[0]])).toBeNull();
  });
});
