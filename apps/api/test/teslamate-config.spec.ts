import { describe, expect, it } from 'vitest';
import {
  TESLAMATE_DEFAULTS,
  fromConnectionString,
  normalise,
  redact,
  toConnectionString,
  validateConfig,
} from '../src/charger/teslamate-config';

const base = { host: 'db.local', port: 5432, user: 'teslamate', password: 'secret', database: 'teslamate' };

describe('toConnectionString', () => {
  it('builds what pg expects', () => {
    expect(toConnectionString(base)).toBe('postgresql://teslamate:secret@db.local:5432/teslamate');
  });

  it('encodes a password containing URL syntax', () => {
    /*
      `openssl rand -base64 24` produces + / and = routinely, and an unencoded @ or / ends
      the URL early. The failure surfaces as an authentication error, which reads as "wrong
      password" and sends you looking in the wrong place entirely.
    */
    const url = toConnectionString({ ...base, password: 'p@ss/w0rd+x=' });
    expect(url).toBe('postgresql://teslamate:p%40ss%2Fw0rd%2Bx%3D@db.local:5432/teslamate');
    // URL exposes username/password still percent-encoded — which is precisely why
    // fromConnectionString decodes them rather than reading the raw property.
    expect(decodeURIComponent(new URL(url).password)).toBe('p@ss/w0rd+x=');
    expect(new URL(url).hostname).toBe('db.local');
  });

  it('encodes a user and database too', () => {
    const url = toConnectionString({ ...base, user: 'te st', database: 'my db' });
    expect(decodeURIComponent(new URL(url).username)).toBe('te st');
    expect(decodeURIComponent(new URL(url).pathname)).toBe('/my db');
  });

  it('omits the colon when there is no password', () => {
    expect(toConnectionString({ ...base, password: '' })).toBe(
      'postgresql://teslamate@db.local:5432/teslamate',
    );
  });
});

describe('fromConnectionString', () => {
  it('adopts an install that was configured through .env', () => {
    expect(fromConnectionString('postgresql://hoymiles:pw@127.0.0.1:5432/teslamate')).toEqual({
      host: '127.0.0.1',
      port: 5432,
      user: 'hoymiles',
      password: 'pw',
      database: 'teslamate',
    });
  });

  it('round-trips an awkward password', () => {
    const parsed = fromConnectionString(toConnectionString({ ...base, password: 'p@ss/w0rd' }));
    expect(parsed?.password).toBe('p@ss/w0rd');
  });

  it('accepts the postgres:// spelling as well as postgresql://', () => {
    expect(fromConnectionString('postgres://u:p@h:5432/d')?.database).toBe('d');
  });

  it('falls back to the default port when none is given', () => {
    expect(fromConnectionString('postgresql://u:p@h/d')?.port).toBe(TESLAMATE_DEFAULTS.port);
  });

  it('rejects anything that is not a postgres URL', () => {
    for (const bad of ['', 'not a url', 'mysql://u:p@h/d', 'http://h/d', 'postgresql://u:p@h/']) {
      expect(fromConnectionString(bad), bad).toBeNull();
    }
  });
});

describe('validateConfig', () => {
  it('passes a complete config', () => {
    expect(validateConfig(base)).toEqual([]);
  });

  it('names the field that is wrong, not just "invalid"', () => {
    expect(validateConfig({ ...base, host: '  ' })[0]).toMatchObject({ field: 'host' });
    expect(validateConfig({ ...base, user: '' })[0]).toMatchObject({ field: 'user' });
    expect(validateConfig({ ...base, database: '' })[0]).toMatchObject({ field: 'database' });
  });

  it('rejects ports outside the real range', () => {
    for (const port of [0, -1, 65536, 1.5, NaN]) {
      expect(validateConfig({ ...base, port }).some((p) => p.field === 'port'), String(port)).toBe(true);
    }
    expect(validateConfig({ ...base, port: 5432 })).toEqual([]);
  });

  it('allows an empty password — trust auth and peer auth both exist', () => {
    expect(validateConfig({ ...base, password: '' })).toEqual([]);
  });
});

describe('redact', () => {
  it('never carries the password', () => {
    const text = redact(base);
    expect(text).not.toContain('secret');
    expect(text).toBe('postgresql://teslamate:***@db.local:5432/teslamate');
  });
});

describe('normalise', () => {
  it('fills in TeslaMate defaults for anything absent', () => {
    expect(normalise({})).toEqual({ ...TESLAMATE_DEFAULTS, password: '' });
  });

  it('trims fields that get pasted with whitespace', () => {
    expect(normalise({ host: ' 10.0.0.5 ', user: ' tm ' })).toMatchObject({
      host: '10.0.0.5',
      user: 'tm',
    });
  });
});
