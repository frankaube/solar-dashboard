import { describe, expect, it } from 'vitest';
import {
  buildControlQuery,
  parseBasicInfo,
  parseControlInfo,
  parseDayPower,
  parseSensorInfo,
} from '../src/devices/daikin';
import { sumDailyMaxima } from '../src/devices/load-estimate';

/** A real-shaped basic_info response. */
const REAL =
  'ret=OK,type=aircon,reg=eu,dst=1,ver=3_3_9,rev=A2AF2F1,pow=1,err=0,location=0,' +
  'name=%4c%69%76%69%6e%67%20%72%6f%6f%6d,icon=0,method=home only,port=30050,id=,pw=,' +
  'lpw_flag=0,adp_kind=3,pv=3,cpv=3,cpv_minor=00,led=1,en_setzone=1,' +
  'mac=D0C5D3A1B2C3,adp_mode=run,en_hol=0,en_grp=0';

describe('parseBasicInfo', () => {
  it('reads a real adaptor response', () => {
    expect(parseBasicInfo(REAL)).toEqual({
      name: 'Living room',
      mac: 'D0C5D3A1B2C3',
      firmware: '3.3.9',
      region: 'eu',
      powerOn: true,
    });
  });

  it('decodes the percent-encoded name', () => {
    // Daikin encodes per byte, so even plain ASCII names arrive escaped.
    expect(parseBasicInfo(REAL)!.name).toBe('Living room');
  });

  it('keeps a malformed name rather than losing the device', () => {
    // A broken encoding is a cosmetic problem; refusing the whole device over it
    // would hide a working air conditioner.
    const odd = REAL.replace('name=%4c%69%76%69%6e%67%20%72%6f%6f%6d', 'name=%zz%not');
    const info = parseBasicInfo(odd)!;
    expect(info.mac).toBe('D0C5D3A1B2C3');
    expect(info.name).toBe('%zz%not');
  });

  it('rejects a failure response', () => {
    expect(parseBasicInfo('ret=PARAM NG')).toBeNull();
    expect(parseBasicInfo('ret=ADV NG,type=aircon,mac=AA')).toBeNull();
  });

  it('rejects anything that is not an air conditioner', () => {
    // Other Daikin kit answers the same endpoint shape; only aircon adaptors expose
    // the energy endpoints this is being added for.
    expect(parseBasicInfo('ret=OK,type=branch,mac=D0C5D3A1B2C3')).toBeNull();
  });

  it('rejects a response with no MAC', () => {
    // Without it there is no stable id to adopt against; the IP can move.
    expect(parseBasicInfo('ret=OK,type=aircon,name=x')).toBeNull();
  });

  it('rejects unrelated text on the same port', () => {
    expect(parseBasicInfo('')).toBeNull();
    expect(parseBasicInfo('<html><body>hello</body></html>')).toBeNull();
    expect(parseBasicInfo('{"json":true}')).toBeNull();
  });

  it('treats a missing power flag as unknown, not off', () => {
    const noPow = 'ret=OK,type=aircon,mac=D0C5D3A1B2C3,name=x';
    expect(parseBasicInfo(noPow)!.powerOn).toBeUndefined();
  });

  it('reads power off distinctly from unknown', () => {
    const off = 'ret=OK,type=aircon,mac=D0C5D3A1B2C3,pow=0';
    expect(parseBasicInfo(off)!.powerOn).toBe(false);
  });

  it('survives values containing spaces', () => {
    // `method=home only` is a real field with a space in it, and splitting naively on
    // whitespace would corrupt everything after it.
    expect(parseBasicInfo(REAL)!.mac).toBe('D0C5D3A1B2C3');
  });
});

describe('sensors', () => {
  it('reads indoor and outdoor temperature', () => {
    const body = 'ret=OK,htemp=24.0,hhum=-,otemp=21.5,err=0,cmpfreq=42';
    expect(parseSensorInfo(body)).toEqual({ indoorC: 24, outdoorC: 21.5 });
  });

  it('treats an absent sensor as unknown, not zero', () => {
    // Daikin writes "-" for hardware it does not have. Number("-") is NaN, and
    // reading that as a value would put a 0 °C where a real measurement belongs.
    const body = 'ret=OK,htemp=24.0,hhum=-,otemp=-,err=0';
    expect(parseSensorInfo(body)).toEqual({ indoorC: 24, outdoorC: null });
  });

  it('rejects a failure response', () => {
    expect(parseSensorInfo('ret=PARAM NG')).toBeNull();
  });
});

describe('control', () => {
  const CONTROL =
    'ret=OK,pow=1,mode=3,adv=,stemp=22.0,shum=0,dt1=25.0,dt3=22.0,f_rate=A,f_dir=0';

  it('reads power and setpoint', () => {
    const c = parseControlInfo(CONTROL)!;
    expect(c.on).toBe(true);
    expect(c.targetC).toBe(22);
  });

  it('treats a non-numeric setpoint as unknown', () => {
    // In fan-only and some auto modes the setpoint reads "M" or "--".
    expect(parseControlInfo(CONTROL.replace('stemp=22.0', 'stemp=M'))!.targetC).toBeNull();
  });

  it('writes back every field, not just the one being changed', () => {
    // Daikin's set endpoint is not a patch: omitting a field resets it. Changing only
    // the setpoint would silently alter mode and fan speed too.
    const query = buildControlQuery(parseControlInfo(CONTROL)!, { targetC: 20 })!;
    const params = new URLSearchParams(query);
    expect(params.get('stemp')).toBe('20.0');
    expect(params.get('mode')).toBe('3');
    expect(params.get('f_rate')).toBe('A');
    expect(params.get('f_dir')).toBe('0');
    expect(params.get('pow')).toBe('1'); // unchanged
  });

  it('turns off without disturbing the other settings', () => {
    const query = buildControlQuery(parseControlInfo(CONTROL)!, { on: false })!;
    const params = new URLSearchParams(query);
    expect(params.get('pow')).toBe('0');
    expect(params.get('stemp')).toBe('22.0');
    expect(params.get('mode')).toBe('3');
  });

  it('refuses to build a request from an incomplete control set', () => {
    // Better to fail than to reconfigure someone's air conditioner from a guess.
    const partial = parseControlInfo('ret=OK,pow=1,stemp=22.0')!;
    expect(buildControlQuery(partial, { on: true })).toBeNull();
  });
});

describe('daily energy', () => {
  it('sums the hourly buckets into watt-hours', () => {
    // 24 buckets, each 0.1 kWh. 3 + 2 units = 0.5 kWh = 500 Wh.
    const heat = ['3', ...Array(23).fill('0')].join('/');
    const cool = ['0', '2', ...Array(22).fill('0')].join('/');
    expect(parseDayPower(`ret=OK,curr_day_heat=${heat},curr_day_cool=${cool}`)).toBe(500);
  });

  it('handles a unit that only ever cools', () => {
    const cool = ['4', ...Array(23).fill('0')].join('/');
    expect(parseDayPower(`ret=OK,curr_day_cool=${cool}`)).toBe(400);
  });

  it('is zero on a day the unit did not run', () => {
    const zeros = Array(24).fill('0').join('/');
    expect(parseDayPower(`ret=OK,curr_day_heat=${zeros},curr_day_cool=${zeros}`)).toBe(0);
  });

  it('returns null when no energy fields are present at all', () => {
    // Distinct from zero: some firmware omits these, and reporting 0 kWh would claim
    // the air conditioner used nothing.
    expect(parseDayPower('ret=OK,something=else')).toBeNull();
    expect(parseDayPower('ret=PARAM NG')).toBeNull();
  });
});

describe('sumDailyMaxima', () => {
  it('takes each day’s peak and adds them', () => {
    // Within a day the counter only climbs, so the peak is that day's total. Summing
    // every reading would multiply the answer by the polling rate.
    expect(
      sumDailyMaxima([
        { localDate: '2026-07-26', energyTodayWh: 300 },
        { localDate: '2026-07-26', energyTodayWh: 900 },
        { localDate: '2026-07-27', energyTodayWh: 200 },
        { localDate: '2026-07-27', energyTodayWh: 1100 },
      ]),
    ).toBe(2000);
  });

  it('ignores readings with no daily figure', () => {
    expect(
      sumDailyMaxima([
        { localDate: '2026-07-27', energyTodayWh: null },
        { localDate: '2026-07-27', energyTodayWh: 500 },
      ]),
    ).toBe(500);
  });

  it('returns null when nothing reported a daily figure', () => {
    // So the caller can fall back to an estimate rather than showing a confident 0.
    expect(sumDailyMaxima([{ localDate: '2026-07-27', energyTodayWh: null }])).toBeNull();
    expect(sumDailyMaxima([])).toBeNull();
  });

  it('ignores impossible values rather than propagating them', () => {
    expect(
      sumDailyMaxima([
        { localDate: '2026-07-27', energyTodayWh: -50 },
        { localDate: '2026-07-27', energyTodayWh: NaN },
        { localDate: '2026-07-27', energyTodayWh: 700 },
      ]),
    ).toBe(700);
  });
});
