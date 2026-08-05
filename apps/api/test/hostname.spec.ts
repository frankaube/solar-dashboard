import { describe, expect, it } from 'vitest';
import { MAX_LABEL, checkHostname, localName } from '../src/devices/hostname';

/*
  A bad hostname does not fail loudly — the responder binds, answers nothing anyone asked
  for, and the owner sees a name that will not resolve with nothing on screen saying why.
  From the outside that is indistinguishable from mDNS being broken on their network. So
  every refusal here has to happen before the name is stored, and has to say what is wrong.
*/

describe('checkHostname', () => {
  it('accepts an ordinary name', () => {
    expect(checkHostname('solar')).toEqual({ ok: true, hostname: 'solar' });
    expect(checkHostname('solar-dashboard')).toEqual({ ok: true, hostname: 'solar-dashboard' });
    expect(checkHostname('pv2')).toEqual({ ok: true, hostname: 'pv2' });
  });

  it('lowercases rather than complaining about a capital', () => {
    // Case is not significant in DNS, so refusing "Solar" would be a validation error
    // somebody has to think about for no reason at all.
    expect(checkHostname('Solar')).toEqual({ ok: true, hostname: 'solar' });
    expect(checkHostname('  SolarPi  ')).toEqual({ ok: true, hostname: 'solarpi' });
  });

  it('catches the ".local" people will inevitably type', () => {
    const result = checkHostname('solar.local');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/added for you/i);
  });

  it('explains dots rather than just rejecting them', () => {
    /*
      "solar.home" looks like a hostname and is a different thing entirely. mDNS answers
      for a single label under .local, so that name would never be asked for — and the
      failure would look like the feature not working.
    */
    const result = checkHostname('solar.home');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/no dots/i);
  });

  it('refuses a leading or trailing hyphen', () => {
    expect(checkHostname('-solar').ok).toBe(false);
    expect(checkHostname('solar-').ok).toBe(false);
    // But not one in the middle, which is the common and legal case.
    expect(checkHostname('solar-pi').ok).toBe(true);
  });

  it('refuses characters DNS has no answer for', () => {
    for (const bad of ['solar pi', 'solar_pi', 'solaré', 'solar!', 'solar/pi']) {
      expect(checkHostname(bad).ok, bad).toBe(false);
    }
  });

  it('holds the label to 63 octets', () => {
    expect(checkHostname('a'.repeat(MAX_LABEL)).ok).toBe(true);
    const tooLong = checkHostname('a'.repeat(MAX_LABEL + 1));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.ok === false && tooLong.reason).toMatch(/too long/i);
  });

  it('refuses nothing at all rather than storing an empty name', () => {
    expect(checkHostname('').ok).toBe(false);
    expect(checkHostname('   ').ok).toBe(false);
  });
});

describe('localName', () => {
  it('is what a browser gets pointed at', () => {
    expect(localName('solar')).toBe('solar.local');
  });
});
