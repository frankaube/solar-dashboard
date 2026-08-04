import { describe, expect, it } from 'vitest';
import { topicMatches } from '../src/integrations/mqtt.service';

/**
 * Why this exists at all: the client library filters server-side, but every message
 * arrives on one `message` event with no indication of which subscription it belongs to.
 * Two subscribers means each one sees the other's traffic unless something matches here.
 */
describe('MQTT topic matching', () => {
  it('matches an exact topic', () => {
    expect(topicMatches('evcc/site/pvPower', 'evcc/site/pvPower')).toBe(true);
  });

  it('treats + as exactly one level', () => {
    expect(topicMatches('evcc/loadpoints/+/chargePower', 'evcc/loadpoints/1/chargePower')).toBe(true);
    // Not two levels, and not zero.
    expect(topicMatches('evcc/loadpoints/+/chargePower', 'evcc/loadpoints/1/2/chargePower')).toBe(false);
    expect(topicMatches('evcc/loadpoints/+/chargePower', 'evcc/loadpoints/chargePower')).toBe(false);
  });

  it('treats # as the remainder, however deep', () => {
    expect(topicMatches('evcc/#', 'evcc/site/pvPower')).toBe(true);
    expect(topicMatches('evcc/#', 'evcc/loadpoints/1/vehicleSoc')).toBe(true);
  });

  it('does not match a shorter or longer topic without a wildcard', () => {
    expect(topicMatches('evcc/site/pvPower', 'evcc/site')).toBe(false);
    expect(topicMatches('evcc/site', 'evcc/site/pvPower')).toBe(false);
  });

  it('keeps two subscribers apart', () => {
    /*
      The bug this prevents: an OVMS handler being handed evcc payloads and quietly
      failing to parse them, which looks like OVMS not publishing.
    */
    expect(topicMatches('ovms/#', 'evcc/site/pvPower')).toBe(false);
    expect(topicMatches('evcc/#', 'ovms/user/car/metric/v/b/soc')).toBe(false);
  });
});
