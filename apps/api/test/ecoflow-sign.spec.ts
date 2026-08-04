import { describe, expect, it } from 'vitest';
import { ecoflowCanonical, ecoflowSign, flattenParams } from '../src/battery/ecoflow-sign';

/**
 * EcoFlow publishes a self-test vector in its developer documentation. Our signer was
 * written from the prose description and never checked against it — so this file is
 * the first time the implementation meets ground truth.
 *
 * Worth having even once it passes: a signing bug is not a subtle wrongness, it is a
 * total failure that only shows up the moment real credentials exist, which is the
 * worst possible time to discover it.
 */
const VECTOR = {
  accessKey: 'Fp4SvIprYSDPXtYJidEtUAd1o',
  secretKey: 'WIbFEKre0s6sLnh4ei7SPUeYnptHG6V',
  nonce: '345164',
  timestamp: '1671171709428',
  body: { sn: '123456789', params: { cmdSet: 11, id: 24, eps: 0 } },
  canonical:
    'params.cmdSet=11&params.eps=0&params.id=24&sn=123456789&accessKey=Fp4SvIprYSDPXtYJidEtUAd1o&nonce=345164&timestamp=1671171709428',
  sign: '07c13b65e037faf3b153d51613638fa80003c4c38d2407379a7f52851af1473e',
};

describe("EcoFlow's published signature vector", () => {
  it('builds the documented canonical string', () => {
    expect(
      ecoflowCanonical(VECTOR.body, {
        accessKey: VECTOR.accessKey,
        nonce: VECTOR.nonce,
        timestamp: VECTOR.timestamp,
      }),
    ).toBe(VECTOR.canonical);
  });

  it('produces the documented signature', () => {
    expect(
      ecoflowSign(VECTOR.body, {
        accessKey: VECTOR.accessKey,
        secretKey: VECTOR.secretKey,
        nonce: VECTOR.nonce,
        timestamp: VECTOR.timestamp,
      }),
    ).toBe(VECTOR.sign);
  });
});

describe('canonical string construction', () => {
  const auth = { accessKey: 'AK', nonce: '111111', timestamp: '1700000000000' };

  it('appends the auth triple AFTER the sorted params, not sorted among them', () => {
    // The bug this catches: sorting accessKey/nonce/timestamp together with the
    // business params puts accessKey first (a < s), which is wrong for every request
    // that carries a parameter — including the one used to read device state.
    expect(ecoflowCanonical({ sn: 'X' }, auth)).toBe(
      'sn=X&accessKey=AK&nonce=111111&timestamp=1700000000000',
    );
  });

  it('sorts business params by ASCII', () => {
    expect(ecoflowCanonical({ b: '2', a: '1', C: '3' }, auth)).toBe(
      'C=3&a=1&b=2&accessKey=AK&nonce=111111&timestamp=1700000000000',
    );
  });

  it('is stable for a request with no params at all', () => {
    // The device-list call. This one worked before purely by coincidence — with no
    // business params, sorted order and appended order happen to agree.
    expect(ecoflowCanonical({}, auth)).toBe('accessKey=AK&nonce=111111&timestamp=1700000000000');
  });
});

describe('parameter flattening', () => {
  it('flattens nested objects with dot notation', () => {
    expect(flattenParams({ deviceInfo: { id: 1 } })).toEqual({ 'deviceInfo.id': '1' });
  });

  it('flattens arrays of scalars with bracket indices', () => {
    expect(flattenParams({ ids: [1, 2, 3] })).toEqual({
      'ids[0]': '1',
      'ids[1]': '2',
      'ids[2]': '3',
    });
  });

  it('flattens arrays of objects', () => {
    expect(flattenParams({ deviceList: [{ id: 1 }, { id: 2 }] })).toEqual({
      'deviceList[0].id': '1',
      'deviceList[1].id': '2',
    });
  });

  it('matches the full example from the documentation', () => {
    expect(
      ecoflowCanonical(
        {
          name: 'demo1',
          ids: [1, 2, 3],
          deviceList: [{ id: 1 }, { id: 2 }],
          deviceInfo: { id: 1 },
        },
        { accessKey: 'AK', nonce: '1', timestamp: '2' },
      ),
    ).toBe(
      'deviceInfo.id=1&deviceList[0].id=1&deviceList[1].id=2&ids[0]=1&ids[1]=2&ids[2]=3&name=demo1&accessKey=AK&nonce=1&timestamp=2',
    );
  });

  it('drops undefined and null rather than signing the string "undefined"', () => {
    expect(flattenParams({ a: 1, b: undefined, c: null })).toEqual({ a: '1' });
  });

  it('preserves boolean and numeric formatting', () => {
    expect(flattenParams({ enabled: true, watts: 0, ratio: 1.5 })).toEqual({
      enabled: 'true',
      watts: '0',
      ratio: '1.5',
    });
  });
});
