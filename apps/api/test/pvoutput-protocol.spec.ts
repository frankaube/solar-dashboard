import { describe, expect, it } from 'vitest';
import {
  authHeaders,
  FREE_LIMIT_PER_HOUR,
  canUpload,
  interpret,
  maySpend,
  outputParams,
  readRateState,
  statusParams,
} from '../src/pvoutput/pvoutput-protocol';

/*
  This is the only thing in the app that sends data OUT, to a server that turns it into a
  public page. So the test that matters most is not about formatting — it is that nothing
  leaves without the owner having switched it on and pasted their own credentials.
*/

const headersOf = (map: Record<string, string>) => ({
  get: (name: string) => map[name] ?? null,
});

describe('permission to upload', () => {
  it('refuses by default', () => {
    expect(canUpload({ enabled: false, apiKey: null, systemId: null })).toBe(false);
  });

  it('refuses when switched on but not configured', () => {
    // The dangerous shape: a toggle that appears to work and silently sends nothing, or
    // worse, sends with an empty key and fails against someone else's account.
    expect(canUpload({ enabled: true, apiKey: null, systemId: '123' })).toBe(false);
    expect(canUpload({ enabled: true, apiKey: 'abc', systemId: null })).toBe(false);
    expect(canUpload({ enabled: true, apiKey: '   ', systemId: '123' })).toBe(false);
    expect(canUpload({ enabled: true, apiKey: 'abc', systemId: '  ' })).toBe(false);
  });

  it('refuses when configured but not switched on', () => {
    expect(canUpload({ enabled: false, apiKey: 'abc', systemId: '123' })).toBe(false);
  });

  it('allows only both together', () => {
    expect(canUpload({ enabled: true, apiKey: 'abc', systemId: '123' })).toBe(true);
  });
});

describe('statusParams', () => {
  it('sends the date, time, energy and power PVOutput asks for', () => {
    const params = statusParams({
      date: '2026-08-04',
      time: '14:35',
      energyWh: 41234.6,
      powerW: 10456.2,
    });
    expect(params.get('d')).toBe('20260804');
    expect(params.get('t')).toBe('14:35');
    expect(params.get('v1')).toBe('41235');
    expect(params.get('v2')).toBe('10456');
  });

  it('omits what nothing measured rather than sending an empty field', () => {
    /*
      An empty `v5` is not "no temperature" to a form parser — it is zero degrees, which on
      a January afternoon is both plausible and wrong, and would be published as a reading.
    */
    const params = statusParams({
      date: '2026-08-04',
      time: '14:35',
      energyWh: 100,
      powerW: 50,
      temperatureC: null,
      voltage: undefined,
    });
    expect(params.has('v5')).toBe(false);
    expect(params.has('v6')).toBe(false);
  });

  it('keeps a temperature of zero, which is a reading and not an absence', () => {
    const params = statusParams({
      date: '2026-01-04',
      time: '09:00',
      energyWh: 10,
      powerW: 5,
      temperatureC: 0,
    });
    expect(params.get('v5')).toBe('0.0');
  });

  it('never sends a negative figure', () => {
    // A clamp reading backwards, or a counter resetting, must not become a negative
    // generation figure on a public page.
    const params = statusParams({ date: '2026-08-04', time: '05:00', energyWh: -5, powerW: -120 });
    expect(params.get('v1')).toBe('0');
    expect(params.get('v2')).toBe('0');
  });
});

describe('outputParams', () => {
  it('sends the day and what it generated', () => {
    const params = outputParams({ date: '2026-08-02', generatedWh: 109_300 });
    expect(params.get('d')).toBe('20260802');
    expect(params.get('g')).toBe('109300');
  });

  it('sends export only where a meter actually measured it', () => {
    /*
      Absent means unmeasured, and must stay absent. Sent as zero it would publish "this
      house exported nothing", which is a claim about the meter rather than about the day.
    */
    expect(outputParams({ date: '2026-08-02', generatedWh: 100 }).has('e')).toBe(false);
    expect(outputParams({ date: '2026-08-02', generatedWh: 100, exportedWh: null }).has('e')).toBe(false);
    expect(outputParams({ date: '2026-08-02', generatedWh: 100, exportedWh: 0 }).get('e')).toBe('0');
  });

  it('carries the peak when it is known', () => {
    const params = outputParams({
      date: '2026-08-03',
      generatedWh: 90_000,
      peakPowerW: 14_840.4,
      peakTime: '14:10',
    });
    expect(params.get('pp')).toBe('14840');
    expect(params.get('pt')).toBe('14:10');
  });
});

describe('rate limiting', () => {
  it('spends freely before the server has said anything', () => {
    expect(maySpend({ remaining: null, resetAt: null }, 1000)).toBe(true);
  });

  it('stops at the share this app allows itself, well before the account runs dry', () => {
    /*
      A third of the allowance, not all of it. The key belongs to a person who may have a
      phone widget or an inverter script on the same account; spending the lot leaves those
      failing with nothing to say why.
    */
    expect(maySpend({ remaining: FREE_LIMIT_PER_HOUR, resetAt: null }, 1000)).toBe(true);
    expect(maySpend({ remaining: 41, resetAt: null }, 1000)).toBe(true);
    expect(maySpend({ remaining: 40, resetAt: null }, 1000)).toBe(false);
    expect(maySpend({ remaining: 0, resetAt: null }, 1000)).toBe(false);
  });

  it('starts again once the window the server named has rolled over', () => {
    expect(maySpend({ remaining: 0, resetAt: 5_000 }, 4_999)).toBe(false);
    expect(maySpend({ remaining: 0, resetAt: 5_000 }, 5_000)).toBe(true);
  });

  it('reads the quota off the response rather than counting locally', () => {
    // A local counter drifts the moment anything else uses the same key — which is exactly
    // the traffic this app cannot see.
    const state = readRateState(
      headersOf({ 'X-Rate-Limit-Remaining': '17', 'X-Rate-Limit-Reset': '1780000' }),
    );
    expect(state.remaining).toBe(17);
    expect(state.resetAt).toBe(1_780_000_000);
  });

  it('treats missing or unparseable headers as unknown, not as zero', () => {
    expect(readRateState(headersOf({})).remaining).toBeNull();
    expect(readRateState(headersOf({ 'X-Rate-Limit-Remaining': 'soon' })).remaining).toBeNull();
  });
});

describe('interpret', () => {
  it('accepts a 200', () => {
    expect(interpret(200, 'OK 200: Added Status')).toEqual({ ok: true });
  });

  it('does not retry a rejected key', () => {
    /*
      The distinction the caller acts on. A wrong key is wrong again in five minutes, so
      retrying turns one typo into a permanent stream of failed requests against an account
      that is not even this owner's if they mistyped the digits.
    */
    const outcome = interpret(401, 'Unauthorized: Invalid System ID');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.retryable).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('key or system id');
  });

  it('does not retry data the far end refused', () => {
    const outcome = interpret(400, 'Bad request: Date is too far in the past');
    expect(outcome.ok === false && outcome.retryable).toBe(false);
  });

  it('retries the far end having a bad moment', () => {
    const outcome = interpret(503, 'Service Unavailable');
    expect(outcome.ok === false && outcome.retryable).toBe(true);
  });

  it('keeps the server s own words, bounded', () => {
    const outcome = interpret(500, 'x'.repeat(500));
    expect(outcome.ok === false && outcome.reason.length).toBeLessThanOrEqual(200);
  });
});

describe('authHeaders', () => {
  const config = { enabled: true, apiKey: ' abc ', systemId: ' 42 ' };

  it('carries the credentials, trimmed', () => {
    const headers = authHeaders(config);
    expect(headers['X-Pvoutput-Apikey']).toBe('abc');
    expect(headers['X-Pvoutput-SystemId']).toBe('42');
  });

  it('asks for the rate-limit headers, which are opt-in', () => {
    /*
      The regression this exists to prevent, because it already happened once and was
      invisible: PVOutput returns the quota headers only when the request says
      `X-Rate-Limit: 1`. Without it every response is silent, `readRateState` reads nulls,
      and `maySpend` — true on null — never holds anything back. The throttle shipped
      unable to engage, and nothing failed to say so.
    */
    expect(authHeaders(config)['X-Rate-Limit']).toBe('1');
  });
});
