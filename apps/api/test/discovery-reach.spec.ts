import { describe, expect, it } from 'vitest';
import { assessDiscoveryReach } from '../src/devices/discovery-reach';

/** What this install actually looks like from inside its container. */
const BRIDGED = [
  { address: '172.18.0.4', netmask: '255.255.0.0', internal: false, family: 'IPv4' },
  { address: '127.0.0.1', netmask: '255.0.0.0', internal: true, family: 'IPv4' },
];
const ON_LAN = [{ address: '10.0.0.50', netmask: '255.255.255.0', internal: false, family: 'IPv4' }];

describe('whether broadcast discovery can work at all', () => {
  it('spots a container that cannot hear the network it is scanning', () => {
    /*
      The real finding: a Tuya plug announcing itself on 10.0.0.115 was heard twice in
      fourteen seconds by the host and never once by the container. The scan reported no
      such device, which reads as "you do not have one".
    */
    const reach = assessDiscoveryReach(BRIDGED, '10.0.0.213');
    expect(reach.onDeviceSubnet).toBe(false);
    expect(reach.broadcastBlindReason).toContain('172.18.0.0/16');
    expect(reach.broadcastBlindReason).toContain('10.0.0.213');
  });

  it('says nothing when the app is on the same network as the gear', () => {
    const reach = assessDiscoveryReach(ON_LAN, '10.0.0.213');
    expect(reach.onDeviceSubnet).toBe(true);
    expect(reach.broadcastBlindReason).toBeNull();
    expect(reach.deviceSubnet).toBe('10.0.0.0/24');
  });

  it('makes no claim before anything is configured', () => {
    // With no known-good address there is nothing to compare against, and guessing would
    // put a scary warning on a fresh install that has done nothing wrong.
    expect(assessDiscoveryReach(BRIDGED, null).broadcastBlindReason).toBeNull();
  });

  it('ignores loopback and IPv6 when deciding', () => {
    const noisy = [
      ...ON_LAN,
      { address: '::1', netmask: 'ffff:ffff:ffff:ffff::', internal: true, family: 'IPv6' },
    ];
    expect(assessDiscoveryReach(noisy, '10.0.0.213').localSubnets).toEqual(['10.0.0.0/24']);
  });

  it('handles a host with several interfaces, one of which is right', () => {
    // A Windows box with Hyper-V has three or four; only one carries the LAN.
    const many = [
      { address: '172.28.0.1', netmask: '255.255.240.0', internal: false, family: 'IPv4' },
      ...ON_LAN,
    ];
    expect(assessDiscoveryReach(many, '10.0.0.213').onDeviceSubnet).toBe(true);
  });

  it('does not crash on a malformed address', () => {
    const junk = [{ address: 'not-an-ip', netmask: '255.255.255.0', internal: false, family: 'IPv4' }];
    expect(assessDiscoveryReach(junk, '10.0.0.213').onDeviceSubnet).toBe(false);
  });
});
