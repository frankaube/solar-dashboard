import { describe, expect, it, vi } from 'vitest';
import { NetworkScanner } from '../src/devices/discovery/scanner';
import { DiscoveryProbe, ListenProbe, PortProbe } from '../src/devices/discovery/types';
import { DiscoveredDevice } from '../src/devices/types';

const ctx = { isAdopted: () => false };

const device = (vendor: string, host: string, extra: Partial<DiscoveredDevice> = {}): DiscoveredDevice => ({
  vendor,
  kind: 'plug',
  name: `${vendor} at ${host}`,
  host,
  adopted: false,
  ...extra,
});

function portProbe(
  vendor: string,
  port: number,
  matches: (host: string) => boolean,
  priority?: number,
): PortProbe {
  return {
    vendor,
    label: vendor,
    port,
    priority,
    identify: async (host) => (matches(host) ? device(vendor, host) : null),
  };
}

/** Only the last octet matters; keeps the fake network readable. */
const openOn = (port: number, lastOctets: number[]) => (host: string, p: number) =>
  Promise.resolve(p === port && lastOctets.includes(Number(host.split('.')[3])));

describe('NetworkScanner', () => {
  it('sweeps each port once however many probes want it', async () => {
    // The reason the engine plans the network work instead of letting probes scan for
    // themselves: three probes on port 80 must not mean three sweeps of 254 hosts.
    const tcp = vi.fn(openOn(80, [5]));
    const probes = [
      portProbe('a', 80, () => false, 1),
      portProbe('b', 80, () => false, 2),
      portProbe('c', 80, (h) => h.endsWith('.5'), 3),
    ];
    const result = await new NetworkScanner(probes, tcp, { pacingMs: 0 }).scan('10.0.0', ctx);
    expect(tcp).toHaveBeenCalledTimes(254); // one pass, not three
    expect(result.devices.map((d) => d.vendor)).toEqual(['c']);
  });

  it('lets the first matching probe claim a host, in priority order', async () => {
    // Shelly, Tasmota and ESPHome all answer on 80 and only one is right.
    const probes = [
      portProbe('tasmota', 80, () => true, 2),
      portProbe('shelly', 80, () => true, 1),
    ];
    const result = await new NetworkScanner(probes, openOn(80, [7]), { pacingMs: 0 }).scan('10.0.0', ctx);
    expect(result.devices.map((d) => d.vendor)).toEqual(['shelly']);
  });

  it('moves on when a probe throws rather than losing the sweep', async () => {
    const exploding: PortProbe = {
      vendor: 'bad',
      label: 'bad',
      port: 80,
      priority: 1,
      identify: async () => {
        throw new Error('connection reset');
      },
    };
    const probes = [exploding, portProbe('good', 80, () => true, 2)];
    const result = await new NetworkScanner(probes, openOn(80, [9]), { pacingMs: 0 }).scan('10.0.0', ctx);
    expect(result.devices.map((d) => d.vendor)).toEqual(['good']);
  });

  it('prefers a listener result over a port result for the same device', async () => {
    // Tuya announces itself AND accepts TCP 6668. Same device, so it must appear once,
    // and the announcement is the record that carries an id and protocol version.
    const listener: ListenProbe = {
      vendor: 'tuya',
      label: 'Tuya',
      listen: async () => [device('tuya', '10.0.0.115', { hardwareId: 'gw123', model: 'Tuya v3.3' })],
    };
    const probes: DiscoveryProbe[] = [listener, portProbe('tuya', 6668, () => true)];
    const result = await new NetworkScanner(probes, openOn(6668, [115]), { pacingMs: 0 }).scan('10.0.0', ctx);
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].hardwareId).toBe('gw123');
  });

  it('keeps a port result the listener did not report', async () => {
    // The Docker case: broadcasts never arrive, so the TCP probe is all there is.
    const deaf: ListenProbe = { vendor: 'tuya', label: 'Tuya', listen: async () => [] };
    const probes: DiscoveryProbe[] = [deaf, portProbe('tuya', 6668, () => true)];
    const result = await new NetworkScanner(probes, openOn(6668, [115]), { pacingMs: 0 }).scan('10.0.0', ctx);
    expect(result.devices.map((d) => d.host)).toEqual(['10.0.0.115']);
  });

  it('does not let one failing listener take down the scan', async () => {
    const broken: ListenProbe = {
      vendor: 'x',
      label: 'x',
      listen: async () => {
        throw new Error('port in use');
      },
    };
    const probes: DiscoveryProbe[] = [broken, portProbe('kasa', 9999, () => true)];
    const result = await new NetworkScanner(probes, openOn(9999, [244]), { pacingMs: 0 }).scan('10.0.0', ctx);
    expect(result.devices.map((d) => d.vendor)).toEqual(['kasa']);
  });

  it('reports what it looked for, so "not found" can be distinguished from "never checked"', async () => {
    const probes: DiscoveryProbe[] = [
      portProbe('kasa', 9999, () => false),
      { vendor: 'tuya', label: 'Tuya', listen: async () => [] },
    ];
    const result = await new NetworkScanner(probes, () => Promise.resolve(false), { pacingMs: 0 }).scan('10.0.0', ctx);
    expect(result.devices).toEqual([]);
    expect(result.lookedFor).toEqual(['Tuya', 'kasa']);
  });

  it('never probes a port no probe asked for', async () => {
    const tcp = vi.fn(() => Promise.resolve(false));
    await new NetworkScanner([portProbe('kasa', 9999, () => false)], tcp, { pacingMs: 0 }).scan('10.0.0', ctx);
    expect(tcp.mock.calls.every(([, port]) => port === 9999)).toBe(true);
  });
});
