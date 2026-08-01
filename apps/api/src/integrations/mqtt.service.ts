import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { MqttClient } from 'mqtt';
import { connect } from 'mqtt';
import { SystemSnapshot } from '../hoymiles/types';

const BASE_TOPIC = 'hoymiles';
const DISCOVERY_PREFIX = 'homeassistant';

/** What a subscriber is handed: the topic that matched, and the payload as text. */
export type MqttHandler = (topic: string, payload: string) => void;

interface Subscription {
  filter: string;
  handler: MqttHandler;
}

/**
 * Publishes snapshots to MQTT with Home Assistant discovery, when MQTT_URL is set
 * (e.g. mqtt://homeassistant.local:1883). Optional MQTT_USERNAME / MQTT_PASSWORD.
 *
 * Also reads. Publishing was all this did for a long time, and the one-way street ruled
 * out a whole class of integration that is otherwise nearly free: OVMS puts a car's own
 * CAN data on a broker, and evcc mirrors its entire state there. Both are already on the
 * network of anyone who runs them, and both were unreachable purely because nothing here
 * had ever called `subscribe`.
 */
@Injectable()
export class MqttService implements OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client: MqttClient | null = null;
  private discoveryPublished = false;
  private readonly subscriptions: Subscription[] = [];

  constructor() {
    const url = process.env.MQTT_URL;
    if (!url) return;
    this.client = connect(url, {
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      reconnectPeriod: 30_000,
    });
    this.client.on('connect', () => {
      this.logger.log(`Connected to MQTT broker ${url}`);
      /*
        Re-subscribe on every connect, not just the first.

        A broker restart or a dropped link silently loses server-side subscriptions while
        the client object stays perfectly valid, so a service that subscribed once at boot
        goes quiet for good and looks like a device that stopped publishing.
      */
      for (const { filter } of this.subscriptions) this.resubscribe(filter);
    });
    this.client.on('error', (error) => this.logger.warn(`MQTT: ${error.message}`));
    this.client.on('message', (topic, payload) => this.dispatch(topic, payload.toString()));
  }

  onModuleDestroy(): void {
    this.client?.end();
  }

  /** Whether a broker is configured at all, so callers can explain their own absence. */
  get available(): boolean {
    return this.client !== null;
  }

  /**
   * Listen to a topic filter. Safe to call before the connection is up.
   *
   * Registration is kept locally and replayed on connect, so subscribing during module
   * init works whether or not the broker happens to be reachable at that moment.
   */
  subscribe(filter: string, handler: MqttHandler): void {
    this.subscriptions.push({ filter, handler });
    if (this.client?.connected) this.resubscribe(filter);
  }

  private resubscribe(filter: string): void {
    this.client?.subscribe(filter, (error) => {
      if (error) this.logger.warn(`MQTT subscribe ${filter}: ${error.message}`);
      else this.logger.log(`Subscribed to ${filter}`);
    });
  }

  private dispatch(topic: string, payload: string): void {
    for (const { filter, handler } of this.subscriptions) {
      if (!topicMatches(filter, topic)) continue;
      try {
        handler(topic, payload);
      } catch (error) {
        // One bad payload must not take down the connection or starve other subscribers.
        this.logger.warn(`MQTT handler for ${filter} threw: ${(error as Error).message}`);
      }
    }
  }

  publishSnapshot(snapshot: SystemSnapshot): void {
    if (!this.client?.connected) return;
    if (!this.discoveryPublished) {
      this.publishDiscovery(snapshot);
      this.discoveryPublished = true;
    }
    this.client.publish(
      `${BASE_TOPIC}/system/state`,
      JSON.stringify({
        power_w: snapshot.totalPower,
        daily_energy_wh: snapshot.dailyEnergyWh,
        taken_at: snapshot.takenAt.toISOString(),
      }),
      { retain: true },
    );
    for (const inverter of snapshot.inverters) {
      this.client.publish(
        `${BASE_TOPIC}/inverter/${inverter.serialNumber}/state`,
        JSON.stringify({
          power_w: inverter.activePower,
          temperature_c: inverter.temperature,
          grid_voltage_v: inverter.gridVoltage,
          online: inverter.linkStatus === 1,
        }),
        { retain: true },
      );
    }
  }

  private publishDiscovery(snapshot: SystemSnapshot): void {
    if (!this.client) return;
    const device = {
      identifiers: [`hoymiles_${snapshot.dtuSerialNumber}`],
      name: 'Hoymiles Solar',
      manufacturer: 'Hoymiles',
      model: 'DTU-Pro-S',
    };
    const sensors: Array<[string, object]> = [
      [
        `${DISCOVERY_PREFIX}/sensor/hoymiles_power/config`,
        {
          name: 'Solar Power',
          unique_id: `hoymiles_${snapshot.dtuSerialNumber}_power`,
          state_topic: `${BASE_TOPIC}/system/state`,
          value_template: '{{ value_json.power_w }}',
          unit_of_measurement: 'W',
          device_class: 'power',
          state_class: 'measurement',
          device,
        },
      ],
      [
        `${DISCOVERY_PREFIX}/sensor/hoymiles_daily_energy/config`,
        {
          name: 'Solar Energy Today',
          unique_id: `hoymiles_${snapshot.dtuSerialNumber}_daily_energy`,
          state_topic: `${BASE_TOPIC}/system/state`,
          value_template: '{{ value_json.daily_energy_wh }}',
          unit_of_measurement: 'Wh',
          device_class: 'energy',
          state_class: 'total_increasing',
          device,
        },
      ],
    ];
    for (const [topic, payload] of sensors) {
      this.client.publish(topic, JSON.stringify(payload), { retain: true });
    }
    this.logger.log('Published Home Assistant discovery configs');
  }
}

/**
 * MQTT topic-filter matching: `+` is one level, `#` is the rest.
 *
 * The client library filters server-side, but a process with several subscriptions
 * receives every message on one `message` event with no indication of which filter it
 * arrived for. Without matching here, an OVMS handler would be handed evcc's payloads
 * and would spend its time failing to parse them.
 */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] === '+') continue;
    if (f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}
