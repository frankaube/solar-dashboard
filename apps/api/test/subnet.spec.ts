import { describe, expect, it } from 'vitest';
import { subnetOf, subnetSuggestions } from '../src/setup/subnet';

/**
 * The scan covers one /24 at a time, so picking the wrong one means finding nothing
 * and having no way to tell that from an empty network. Ranking these by how much
 * evidence there is behind each guess is the whole point.
 */
describe('subnetSuggestions', () => {
  it('puts a subnet with adopted devices first', () => {
    // The strongest evidence available: we are already talking to something there.
    const out = subnetSuggestions({ deviceHosts: ['10.0.0.30', '10.0.0.244'] });
    expect(out[0]).toMatchObject({ subnet: '10.0.0', confidence: 'known' });
    expect(out[0].reason).toContain('2 adopted devices');
  });

  it('ranks a busier subnet above a quieter one', () => {
    const out = subnetSuggestions({
      deviceHosts: ['192.168.5.10', '10.0.0.30', '10.0.0.31', '10.0.0.32'],
    });
    expect(out.map((s) => s.subnet).slice(0, 2)).toEqual(['10.0.0', '192.168.5']);
  });

  it('counts one device in the singular', () => {
    expect(subnetSuggestions({ deviceHosts: ['10.0.0.5'] })[0].reason).toContain('1 adopted device here');
  });

  it('falls back to configured gateways when nothing is adopted yet', () => {
    const out = subnetSuggestions({ configuredHosts: ['192.168.4.50'] });
    expect(out[0]).toMatchObject({ subnet: '192.168.4', confidence: 'known' });
  });

  it('always offers the common defaults somewhere in the list', () => {
    // Present so a fresh install has somewhere to start, but never dressed up as
    // knowledge — the old single suggestion often WAS just 192.168.1 and looked
    // authoritative.
    //
    // Asserted on membership, not on confidence: a default that happens to match the
    // machine's own network is promoted to 'likely' and deduped out of the guesses,
    // which is correct and which made the first version of this test pass or fail
    // depending on whose LAN it ran on.
    const subnets = subnetSuggestions().map((s) => s.subnet);
    for (const common of ['192.168.1', '192.168.0', '10.0.0']) {
      expect(subnets).toContain(common);
    }
    expect(subnetSuggestions().some((s) => s.confidence === 'guess')).toBe(true);
  });

  it('never repeats a subnet', () => {
    const out = subnetSuggestions({
      deviceHosts: ['10.0.0.1', '10.0.0.2'],
      configuredHosts: ['10.0.0.3'],
    });
    expect(out.filter((s) => s.subnet === '10.0.0')).toHaveLength(1);
  });

  it('ignores hosts that are not addresses', () => {
    const out = subnetSuggestions({ deviceHosts: ['demo', '', null, undefined, 'not.an.ip.here'] });
    expect(out.every((s) => s.confidence === 'guess' || s.confidence === 'likely')).toBe(true);
  });

  it('gives every suggestion a reason', () => {
    // A bare list of subnets is what made the old version unhelpful — the user could
    // not tell a solid inference from a default.
    for (const s of subnetSuggestions({ deviceHosts: ['10.0.0.5'] })) {
      expect(s.reason.length).toBeGreaterThan(5);
    }
  });
});

describe('subnetOf', () => {
  it('takes the /24 of an address', () => {
    expect(subnetOf('192.168.1.42')).toBe('192.168.1');
  });

  it('rejects anything that is not a plain IPv4 host', () => {
    expect(subnetOf('192.168.1')).toBeNull();
    expect(subnetOf('demo')).toBeNull();
    expect(subnetOf('')).toBeNull();
    expect(subnetOf(null)).toBeNull();
    expect(subnetOf('192.168.1.42:8080')).toBeNull();
  });
});
