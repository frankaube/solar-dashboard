import { describe, expect, it } from 'vitest';
import {
  extract,
  parseDiscovery,
  readTemplate,
  readValue,
  toWattHours,
  toWatts,
} from '../src/integrations/ha-discovery';

/*
  Built for the Pila Mesh battery, which publishes MQTT and nothing else — no HTTP API, and
  an integration repository containing no code, because the device emits Home Assistant
  discovery and HA reads the schema out of it at runtime.

  None of this has been run against a real unit. The payloads below are built from the
  published convention, which is exactly the distinction `VendorConfidence` draws: parsing
  what the document says proves nothing about what the hardware sends. These tests pin the
  reading of the convention; the hardware is still owed.
*/

/** The device-based shape, abbreviated the way HA actually publishes it. */
const PILA_STYLE = JSON.stringify({
  dev: { name: 'Pila Mesh', mdl: 'Mesh Home Battery', ids: ['pila-abc'] },
  o: { name: 'pila' },
  '~': 'pila/state/abc',
  cmps: {
    soc: {
      p: 'sensor',
      name: 'State of charge',
      uniq_id: 'pila-abc-soc',
      stat_t: '~',
      val_tpl: '{{ value_json.battery.soc }}',
      unit_of_meas: '%',
      dev_cla: 'battery',
    },
    power: {
      p: 'sensor',
      name: 'Battery power',
      uniq_id: 'pila-abc-power',
      stat_t: '~',
      val_tpl: '{{ value_json.battery.power_w }}',
      unit_of_meas: 'W',
      dev_cla: 'power',
    },
    outlet: {
      p: 'switch',
      name: 'Outlet',
      uniq_id: 'pila-abc-outlet',
      stat_t: '~',
      cmd_t: 'pila/switch/outlet/abc',
    },
  },
});

describe('parseDiscovery', () => {
  it('reads the device-based payload Pila publishes', () => {
    const entities = parseDiscovery(PILA_STYLE);
    expect(entities.map((e) => e.uniqueId).sort()).toEqual(['pila-abc-power', 'pila-abc-soc']);
    const soc = entities.find((e) => e.deviceClass === 'battery');
    expect(soc?.unit).toBe('%');
    expect(soc?.deviceName).toBe('Pila Mesh');
    expect(soc?.deviceModel).toBe('Mesh Home Battery');
  });

  it('drops the switch', () => {
    /*
      Controls are deliberately out of scope: this app reads other people's hardware and
      does not command it. A switch that appeared as a sensor would also publish a value
      that is not a measurement of anything.
    */
    expect(parseDiscovery(PILA_STYLE).some((e) => e.uniqueId.endsWith('outlet'))).toBe(false);
  });

  it('resolves the ~ base-topic shorthand', () => {
    // Left literal, "~/state" matches no topic and the sensor silently never updates.
    const [entity] = parseDiscovery(
      JSON.stringify({ '~': 'x/y', stat_t: '~/state', uniq_id: 'a', name: 'A' }),
    );
    expect(entity.stateTopic).toBe('x/y/state');
  });

  it('refuses an entity whose ~ cannot be resolved', () => {
    expect(parseDiscovery(JSON.stringify({ stat_t: '~/state', uniq_id: 'a' }))).toEqual([]);
  });

  it('reads the older one-config-per-component shape too', () => {
    const [entity] = parseDiscovery(
      JSON.stringify({
        name: 'Power',
        state_topic: 'tele/x/SENSOR',
        unique_id: 'x-power',
        device_class: 'power',
        unit_of_measurement: 'W',
      }),
    );
    expect(entity.stateTopic).toBe('tele/x/SENSOR');
    expect(entity.deviceClass).toBe('power');
  });

  it('drops an entity with no state topic rather than half-populating one', () => {
    // A named sensor that can never show a number is worse than no sensor.
    expect(parseDiscovery(JSON.stringify({ name: 'Ghost', uniq_id: 'g' }))).toEqual([]);
  });

  it('survives payloads that are not discovery at all', () => {
    for (const junk of ['', 'not json', '[]', 'null', '42']) {
      expect(parseDiscovery(junk)).toEqual([]);
    }
  });
});

describe('readTemplate', () => {
  it('accepts the forms discovery actually uses', () => {
    expect(readTemplate('{{ value_json.battery.soc }}')).toEqual({ kind: 'value', value: '.battery.soc' });
    expect(readTemplate("{{ value_json['a']['b'] }}")).toEqual({ kind: 'value', value: "['a']['b']" });
    expect(readTemplate('{{ value }}')).toEqual({ kind: 'raw' });
    expect(readTemplate(null)).toEqual({ kind: 'raw' });
  });

  it('refuses anything it would have to interpret', () => {
    /*
      This is the load-bearing test. A template engine that half-works returns a number
      that looks like a reading and is not one — and nothing downstream can tell. Refusing
      a sensor is visible on screen; misreading one is invisible forever.
    */
    for (const template of [
      '{{ value_json.power | float * 1000 }}',
      '{{ value_json.p | round(1) }}',
      '{{ (value_json.a + value_json.b) }}',
      '{% if value_json.x %}1{% endif %}',
      '{{ value_json.items[0] }}',
      '{{ states("sensor.x") }}',
    ]) {
      expect(readTemplate(template).kind, template).toBe('unsupported');
    }
  });
});

describe('readValue', () => {
  const entity = (valueTemplate: string | null, unit = 'W') => ({
    uniqueId: 'e', name: 'e', stateTopic: 't', valueTemplate, unit,
    deviceClass: 'power', deviceName: null, deviceModel: null,
  });

  it('pulls a nested field out of a JSON payload', () => {
    expect(readValue(entity('{{ value_json.battery.power_w }}'), '{"battery":{"power_w":-820}}')).toBe(-820);
  });

  it('reads a bare payload when there is no template', () => {
    expect(readValue(entity(null), '54.5')).toBe(54.5);
  });

  it('returns null rather than a number it had to invent', () => {
    expect(readValue(entity('{{ value_json.a.b }}'), '{"a":{}}')).toBeNull();       // missing
    expect(readValue(entity('{{ value_json.a }}'), 'not json')).toBeNull();          // unparseable
    expect(readValue(entity('{{ value_json.a }}'), '{"a":"charging"}')).toBeNull();  // not numeric
    expect(readValue(entity('{{ value_json.a | float }}'), '{"a":1}')).toBeNull();   // unsupported
    expect(readValue(entity('{{ value_json.a }}'), '{"a":true}')).toBeNull();        // boolean
  });

  it('keeps a real zero', () => {
    // 0 W is a measurement. Treating it as absent is the collapse this project keeps
    // finding elsewhere.
    expect(readValue(entity('{{ value_json.p }}'), '{"p":0}')).toBe(0);
  });
});

describe('unit conversion', () => {
  it('converts the power units devices actually declare', () => {
    expect(toWatts(1.6, 'kW')).toBe(1600);
    expect(toWatts(820, 'W')).toBe(820);
    expect(toWatts(0.5, 'MW')).toBe(500_000);
  });

  it('refuses an unknown unit instead of assuming watts', () => {
    /*
      kW and W differ by a thousand. Guessing produces a chart that is wrong by three
      orders of magnitude and entirely plausible to look at.
    */
    expect(toWatts(5, null)).toBeNull();
    expect(toWatts(5, 'A')).toBeNull();
    expect(toWatts(5, '')).toBeNull();
  });

  it('converts energy the same way', () => {
    expect(toWattHours(1.6, 'kWh')).toBe(1600);
    expect(toWattHours(940, 'Wh')).toBe(940);
    expect(toWattHours(5, 'kW')).toBeNull();
  });

  it('is case- and space-insensitive, because devices are inconsistent', () => {
    expect(toWatts(1, ' kw ')).toBe(1000);
    expect(toWattHours(1, 'KWH')).toBe(1000);
  });
});

describe('extract', () => {
  it('walks both path styles', () => {
    const payload = { a: { b: { c: 7 } }, 'odd key': 3 };
    expect(extract(payload, '.a.b.c')).toBe(7);
    expect(extract(payload, "['odd key']")).toBe(3);
  });

  it('stops at a missing or non-object step', () => {
    expect(extract({ a: 1 }, '.a.b')).toBeNull();
    expect(extract({}, '.a')).toBeNull();
    expect(extract(null, '.a')).toBeNull();
  });
});
