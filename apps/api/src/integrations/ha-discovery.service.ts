import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MqttService } from './mqtt.service';
import {
  DiscoveredEntity,
  parseDiscovery,
  readTemplate,
  readValue,
  toWatts,
} from './ha-discovery';

/** Discovery is published under this prefix by convention; HA's own default. */
const DISCOVERY_FILTER = 'homeassistant/#';

/**
 * A reading is only current for so long. A device that stops publishing must stop being
 * reported as present rather than freezing its last value on a screen — the failure this
 * app already had once, when a charger went offline and three days of stale figures sat
 * there looking like a quiet week.
 */
const STALE_AFTER_MS = 10 * 60_000;

interface Sample {
  value: number;
  at: number;
}

export interface HaDevice {
  name: string;
  model: string | null;
  socPct: number | null;
  powerW: number | null;
  /** Newest sample across this device's entities. */
  lastSeenAt: string | null;
}

/**
 * Listens for Home Assistant MQTT discovery and reads whatever describes itself.
 *
 * Devices publish a config payload naming their sensors, then publish values to the topics
 * it named. What that reaches, precisely: devices with no other way in. The Pila Mesh
 * battery, which offers no other protocol, and Zigbee sensors behind a Zigbee2MQTT bridge,
 * which have no IP address to poll. Shelly, Tasmota and ESPHome are already read over HTTP
 * by their own adapters and gain nothing here.
 *
 * Read-only, and deliberately: discovery also advertises switches and buttons, and this
 * app does not command other people's hardware.
 *
 * UNVERIFIED against real hardware. Built from the published convention, which proves the
 * parsing is faithful to the document and proves nothing about what any given device
 * actually sends — the distinction `VendorConfidence` draws, and the reason this reports
 * itself as `documented` rather than `verified`.
 */
@Injectable()
export class HaDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(HaDiscoveryService.name);
  /** uniqueId → what the device said about this sensor. */
  private readonly entities = new Map<string, DiscoveredEntity>();
  /** stateTopic → the entities reading from it; several may share one topic. */
  private readonly byTopic = new Map<string, DiscoveredEntity[]>();
  private readonly samples = new Map<string, Sample>();
  /*
    configTopic → the entities it declared.

    Removal needs this. The first attempt matched the config topic's prefix against state
    topics and unique ids, which never matches anything: a device announced at
    `homeassistant/device/pila/abc/config` publishes to `pila/state/abc` with ids like
    `pila-soc`. Clearing a device did nothing, and its last reading stayed on screen
    forever — the exact failure the staleness window exists to prevent, reintroduced by
    the code meant to handle the tidy case.
  */
  private readonly declaredBy = new Map<string, string[]>();
  /** Entities whose template this cannot evaluate — counted, so the gap is visible. */
  private readonly refused = new Set<string>();

  constructor(private readonly mqtt: MqttService) {}

  onModuleInit(): void {
    if (!this.mqtt.available) {
      this.logger.log('No MQTT broker configured — Home Assistant discovery is idle.');
      return;
    }
    /*
      One wildcard rather than a subscription per device: discovery topics are not known
      in advance, which is the entire point of discovery.
    */
    this.mqtt.subscribe(DISCOVERY_FILTER, (topic, payload) => this.onDiscovery(topic, payload));
    this.logger.log('Listening for Home Assistant MQTT discovery.');
  }

  private onDiscovery(topic: string, payload: string): void {
    if (!topic.endsWith('/config')) return;
    /*
      An empty payload is how HA says "this device is gone". Treated as a removal rather
      than ignored, so a battery that has been unplugged stops being reported as present.
    */
    if (payload.trim() === '') {
      this.forget(topic);
      return;
    }

    const declared: string[] = [];
    for (const entity of parseDiscovery(payload)) {
      if (readTemplate(entity.valueTemplate).kind === 'unsupported') {
        // Named, not silently skipped: an unreadable sensor is a known gap, and knowing
        // which one it is turns a bug report into a fix.
        if (!this.refused.has(entity.uniqueId)) {
          this.refused.add(entity.uniqueId);
          this.logger.warn(
            `Ignoring "${entity.name}": value_template ${entity.valueTemplate} is beyond what this reads.`,
          );
        }
        continue;
      }
      declared.push(entity.uniqueId);
      const known = this.entities.get(entity.uniqueId);
      this.entities.set(entity.uniqueId, entity);
      if (known?.stateTopic === entity.stateTopic) continue;

      const list = this.byTopic.get(entity.stateTopic) ?? [];
      list.push(entity);
      this.byTopic.set(entity.stateTopic, list);
      if (list.length === 1) {
        this.mqtt.subscribe(entity.stateTopic, (t, p) => this.onState(t, p));
      }
    }
    if (declared.length) this.declaredBy.set(topic, declared);
  }

  /** Drop exactly what this config topic declared, and unhook its state subscriptions. */
  private forget(configTopic: string): void {
    for (const id of this.declaredBy.get(configTopic) ?? []) {
      const entity = this.entities.get(id);
      this.entities.delete(id);
      this.samples.delete(id);
      this.refused.delete(id);
      if (!entity) continue;
      const remaining = (this.byTopic.get(entity.stateTopic) ?? []).filter((e) => e.uniqueId !== id);
      if (remaining.length) this.byTopic.set(entity.stateTopic, remaining);
      else this.byTopic.delete(entity.stateTopic);
    }
    this.declaredBy.delete(configTopic);
  }

  private onState(topic: string, payload: string): void {
    const at = Date.now();
    for (const entity of this.byTopic.get(topic) ?? []) {
      const value = readValue(entity, payload);
      if (value === null) continue;
      this.samples.set(entity.uniqueId, { value, at });
    }
  }

  private fresh(id: string): number | null {
    const sample = this.samples.get(id);
    if (!sample || Date.now() - sample.at > STALE_AFTER_MS) return null;
    return sample.value;
  }

  /**
   * Devices that have said something recently, grouped by the name they gave themselves.
   *
   * A device appears only once it has published an actual value. Discovery alone means
   * "something announced itself", which is not the same as "something is reporting", and
   * only one of those belongs on a screen as a live figure.
   */
  devices(): HaDevice[] {
    const grouped = new Map<string, HaDevice>();
    for (const [id, entity] of this.entities) {
      const value = this.fresh(id);
      if (value === null) continue;
      const key = entity.deviceName ?? entity.uniqueId;
      const device = grouped.get(key) ?? {
        name: key,
        model: entity.deviceModel,
        socPct: null,
        powerW: null,
        lastSeenAt: null,
      };
      if (entity.deviceClass === 'battery' && (entity.unit ?? '').trim() === '%') {
        device.socPct = value;
      }
      if (entity.deviceClass === 'power') {
        // Refused rather than assumed when the unit is missing: kW and W differ by a
        // thousand, and the wrong one is entirely plausible on a chart.
        const watts = toWatts(value, entity.unit);
        if (watts !== null) device.powerW = watts;
      }
      const sample = this.samples.get(id);
      const seen = sample ? new Date(sample.at).toISOString() : null;
      if (seen && (!device.lastSeenAt || seen > device.lastSeenAt)) device.lastSeenAt = seen;
      grouped.set(key, device);
    }
    return [...grouped.values()];
  }

  /** The first device reporting both a charge level and a power figure, if any. */
  battery(): HaDevice | null {
    return this.devices().find((d) => d.socPct !== null && d.powerW !== null) ?? null;
  }

  /** For the UI: what was found, and what could not be read. */
  summary(): { entities: number; reporting: number; refused: number; devices: HaDevice[] } {
    return {
      entities: this.entities.size,
      reporting: [...this.entities.keys()].filter((id) => this.fresh(id) !== null).length,
      refused: this.refused.size,
      devices: this.devices(),
    };
  }
}
