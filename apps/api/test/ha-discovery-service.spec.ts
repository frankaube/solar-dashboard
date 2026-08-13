import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HaDiscoveryService } from '../src/integrations/ha-discovery.service';
import { MqttService } from '../src/integrations/mqtt.service';

/*
  The wiring, against a fake broker.

  ha-discovery.spec.ts pins the reading of the convention; this pins what happens when
  messages actually arrive in the order a device sends them — discovery first, values
  after, sometimes a removal. Still unverified against real hardware: a fake broker proves
  the plumbing, not that a Pila sends what its documentation says.
*/

/** A broker that records subscriptions and lets a test deliver messages to them. */
function fakeBroker(): { mqtt: MqttService; send: (topic: string, payload: string) => void; filters: string[] } {
  const subs: Array<{ filter: string; handler: (t: string, p: string) => void }> = [];
  const matches = (filter: string, topic: string): boolean => {
    if (filter === topic) return true;
    if (filter.endsWith('/#')) return topic.startsWith(filter.slice(0, -2) + '/');
    return false;
  };
  const mqtt = {
    available: true,
    subscribe: (filter: string, handler: (t: string, p: string) => void) => subs.push({ filter, handler }),
  } as unknown as MqttService;
  return {
    mqtt,
    filters: subs.map((s) => s.filter),
    send: (topic, payload) => {
      for (const s of subs) if (matches(s.filter, topic)) s.handler(topic, payload);
    },
  };
}

const DISCOVERY = 'homeassistant/device/pila/abc/config';
const CONFIG = JSON.stringify({
  dev: { name: 'Pila Mesh', mdl: 'Mesh Home Battery' },
  '~': 'pila/state/abc',
  cmps: {
    soc: { p: 'sensor', name: 'SoC', uniq_id: 'pila-soc', stat_t: '~', val_tpl: '{{ value_json.soc }}', unit_of_meas: '%', dev_cla: 'battery' },
    pw: { p: 'sensor', name: 'Power', uniq_id: 'pila-pw', stat_t: '~', val_tpl: '{{ value_json.power_w }}', unit_of_meas: 'W', dev_cla: 'power' },
  },
});

describe('HaDiscoveryService', () => {
  let broker: ReturnType<typeof fakeBroker>;
  let service: HaDiscoveryService;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
    broker = fakeBroker();
    service = new HaDiscoveryService(broker.mqtt);
    service.onModuleInit();
  });

  it('reports nothing until a value actually arrives', () => {
    broker.send(DISCOVERY, CONFIG);
    /*
      Discovery alone means "something announced itself", which is not "something is
      reporting". Only one of those belongs on a screen as a live figure.
    */
    expect(service.devices()).toEqual([]);
    expect(service.battery()).toBeNull();
    expect(service.summary().entities).toBe(2);
    expect(service.summary().reporting).toBe(0);
  });

  it('reads a battery once it publishes', () => {
    broker.send(DISCOVERY, CONFIG);
    broker.send('pila/state/abc', JSON.stringify({ soc: 64, power_w: -820 }));
    const battery = service.battery();
    expect(battery?.name).toBe('Pila Mesh');
    expect(battery?.model).toBe('Mesh Home Battery');
    expect(battery?.socPct).toBe(64);
    // Negative is discharging — the sign convention the rest of the app uses.
    expect(battery?.powerW).toBe(-820);
  });

  it('stops reporting a device that has gone quiet', () => {
    broker.send(DISCOVERY, CONFIG);
    broker.send('pila/state/abc', JSON.stringify({ soc: 64, power_w: -820 }));
    expect(service.battery()).not.toBeNull();

    vi.setSystemTime(new Date('2026-08-04T12:11:00Z')); // past the staleness window
    /*
      The failure this app already had once: a charger went offline and three days of
      frozen figures sat on screen looking like a quiet week. A stale reading must
      disappear rather than persist.
    */
    expect(service.battery()).toBeNull();
    expect(service.summary().reporting).toBe(0);
  });

  it('forgets a device when discovery is cleared', () => {
    broker.send(DISCOVERY, CONFIG);
    broker.send('pila/state/abc', JSON.stringify({ soc: 64, power_w: -820 }));
    // An empty retained config is how HA says the device is gone.
    broker.send(DISCOVERY, '');
    expect(service.battery()).toBeNull();
    expect(service.summary().entities).toBe(0);
  });

  it('counts a sensor it cannot read instead of dropping it silently', () => {
    broker.send(
      'homeassistant/sensor/x/config',
      JSON.stringify({ name: 'Odd', uniq_id: 'odd', stat_t: 'x/s', val_tpl: '{{ value_json.p | float * 1000 }}' }),
    );
    // Refusing is correct; refusing invisibly is not — the count is how the gap gets fixed.
    expect(service.summary().refused).toBe(1);
    expect(service.summary().entities).toBe(0);
  });

  it('ignores a power reading whose unit it does not recognise', () => {
    broker.send(
      'homeassistant/sensor/y/config',
      JSON.stringify({
        dev: { name: 'Odd meter' },
        name: 'P', uniq_id: 'y-p', stat_t: 'y/s', dev_cla: 'power', unit_of_meas: 'furlongs',
      }),
    );
    broker.send('y/s', '5');
    // Present, but with no power figure: guessing watts could be wrong by 1000x.
    expect(service.devices()[0].powerW).toBeNull();
  });

  it('does not re-subscribe when the same device re-announces', () => {
    // Devices republish discovery whenever they reconnect, and on every HA restart.
    broker.send(DISCOVERY, CONFIG);
    broker.send(DISCOVERY, CONFIG);
    broker.send('pila/state/abc', JSON.stringify({ soc: 30, power_w: 100 }));
    expect(service.summary().entities).toBe(2);
    expect(service.battery()?.socPct).toBe(30);
  });

  it('keeps a real zero', () => {
    broker.send(DISCOVERY, CONFIG);
    broker.send('pila/state/abc', JSON.stringify({ soc: 0, power_w: 0 }));
    // An idle battery at 0 W is a measurement, not an absence.
    expect(service.battery()?.powerW).toBe(0);
    expect(service.battery()?.socPct).toBe(0);
  });

  it('stays idle with no broker', () => {
    const idle = new HaDiscoveryService({ available: false, subscribe: () => undefined } as unknown as MqttService);
    idle.onModuleInit();
    expect(idle.devices()).toEqual([]);
    expect(idle.summary().entities).toBe(0);
  });
});
