import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MqttService } from '../integrations/mqtt.service';
import { EvccState, parseState, primaryLoadpoint, solarChargedWh } from './evcc-state';

/**
 * The evcc bridge.
 *
 * Two ways in, because evcc offers both and they suit different installs:
 *
 *   EVCC_URL         poll GET {url}/api/state every 30 s. Needs nothing but a URL.
 *   EVCC_MQTT_PREFIX ingest evcc's own MQTT tree, if the owner already runs a broker.
 *
 * REST is the default because it has no dependency beyond evcc itself. MQTT costs almost
 * nothing now that MqttService can subscribe, gives sub-second updates, and is the same
 * plumbing OVMS will use — so it is worth having even though few will need it.
 */

const POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;

@Injectable()
export class EvccService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EvccService.name);
  private timer: NodeJS.Timeout | null = null;
  private state: EvccState | null = null;
  private lastError: string | null = null;
  private lastUpdateAt: Date | null = null;
  /** Accumulated MQTT values, since evcc publishes one field per topic. */
  private mqttFields: Record<string, unknown> = {};

  constructor(private readonly mqtt: MqttService) {}

  private get baseUrl(): string | null {
    const raw = process.env.EVCC_URL?.trim();
    return raw ? raw.replace(/\/+$/, '') : null;
  }

  onModuleInit(): void {
    const prefix = process.env.EVCC_MQTT_PREFIX?.trim();
    if (prefix) this.listenOverMqtt(prefix);

    if (!this.baseUrl) {
      if (!prefix) this.logger.log('evcc not configured — set EVCC_URL to enable.');
      return;
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * evcc publishes one value per topic, not a JSON document.
   *
   * So `evcc/loadpoints/1/chargePower` carries the number `7360` and nothing else. The
   * fields are reassembled into the shape the REST parser already understands rather
   * than writing a second parser — one mapping to keep correct instead of two.
   */
  private listenOverMqtt(prefix: string): void {
    if (!this.mqtt.available) {
      this.logger.warn(`EVCC_MQTT_PREFIX is set but MQTT_URL is not — ignoring.`);
      return;
    }
    this.mqtt.subscribe(`${prefix}/#`, (topic, payload) => {
      const path = topic.slice(prefix.length + 1);
      this.mqttFields[path] = payload;
      this.rebuildFromMqtt();
    });
    this.logger.log(`Reading evcc from MQTT under ${prefix}/`);
  }

  private rebuildFromMqtt(): void {
    const loadpoints: Array<Record<string, unknown>> = [];
    const site: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(this.mqttFields)) {
      const lp = /^loadpoints\/(\d+)\/(.+)$/.exec(path);
      if (lp) {
        // evcc numbers from 1; our array is dense from 0.
        const index = Number(lp[1]) - 1;
        loadpoints[index] = { ...(loadpoints[index] ?? {}), [lp[2]]: coerce(value) };
        continue;
      }
      const bare = /^site\/(.+)$/.exec(path) ?? /^(.+)$/.exec(path);
      if (bare) site[bare[1].replace('/', '')] = coerce(value);
    }
    this.state = parseState({ ...site, loadpoints: loadpoints.filter(Boolean) });
    this.lastUpdateAt = new Date();
    this.lastError = null;
  }

  private async poll(): Promise<void> {
    const base = this.baseUrl;
    if (!base) return;
    try {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`${base}/api/state`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.state = parseState(await response.json());
        this.lastUpdateAt = new Date();
        this.lastError = null;
      } finally {
        clearTimeout(abort);
      }
    } catch (error) {
      /*
        Reported, not thrown. evcc being down is a normal condition for an optional
        integration, and it must not take the collector's poll loop with it.
      */
      this.lastError = (error as Error).message;
      this.logger.warn(`evcc poll failed: ${this.lastError}`);
    }
  }

  /** Null when evcc is not configured, so callers can tell that from "configured but down". */
  get configured(): boolean {
    return Boolean(this.baseUrl) || Boolean(process.env.EVCC_MQTT_PREFIX?.trim());
  }

  status(): {
    configured: boolean;
    connected: boolean;
    lastError: string | null;
    lastUpdateAt: string | null;
    siteTitle: string | null;
    vehicleTitles: string[];
    chargePowerW: number | null;
    vehicleSoc: number | null;
    vehicleTitle: string | null;
    solarChargedWh: number | null;
    loadpointCount: number;
  } {
    const primary = this.state ? primaryLoadpoint(this.state) : null;
    return {
      configured: this.configured,
      connected: this.state !== null && this.lastError === null,
      lastError: this.lastError,
      lastUpdateAt: this.lastUpdateAt?.toISOString() ?? null,
      siteTitle: this.state?.siteTitle ?? null,
      vehicleTitles: this.state?.vehicleTitles ?? [],
      chargePowerW: primary?.chargePowerW ?? null,
      vehicleSoc: primary?.vehicleSoc ?? null,
      vehicleTitle: primary?.vehicleTitle ?? null,
      solarChargedWh: this.state ? solarChargedWh(this.state) : null,
      loadpointCount: this.state?.loadpoints.length ?? 0,
    };
  }

  /** The whole parsed state, for anything that wants more than the summary. */
  current(): EvccState | null {
    return this.state;
  }
}

/** MQTT payloads are text; evcc's are numbers, booleans and strings without any marker. */
function coerce(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return value !== '' && Number.isFinite(n) ? n : value;
}
