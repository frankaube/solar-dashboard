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

/** A device that stops publishing must stop being reported, not freeze its last value. */
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
 * Read-only: discovery also advertises switches and buttons, which this app does not command.
 * Unverified against real hardware — built from the published convention, which says nothing
 * about what a given device sends, so it reports as `documented`, not `verified`.
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
    configTopic → the entities it declared. A config topic's prefix does not match the state
    topics or ids it declares — `homeassistant/device/pila/abc/config` publishes to
    `pila/state/abc` with ids like `pila-soc` — so removal cannot be done by prefix.
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
    // One wildcard: discovery topics are not known in advance.
    this.mqtt.subscribe(DISCOVERY_FILTER, (topic, payload) => this.onDiscovery(topic, payload));
    this.logger.log('Listening for Home Assistant MQTT discovery.');
  }

  private onDiscovery(topic: string, payload: string): void {
    if (!topic.endsWith('/config')) return;
    // An empty payload is HA's "this device is gone".
    if (payload.trim() === '') {
      this.forget(topic);
      return;
    }

    const declared: string[] = [];
    for (const entity of parseDiscovery(payload)) {
      if (readTemplate(entity.valueTemplate).kind === 'unsupported') {
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

  /** Grouped by self-declared name. A device appears only once it has published a value. */
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
        // Refused rather than assumed when the unit is missing: kW and W differ by 1000.
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
