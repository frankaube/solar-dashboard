import { Device } from '@prisma/client';
import { classifyEsphomeEntities, EsphomeEntity } from './metering';
import { DeviceAdapter, DeviceState } from './types';

const TIMEOUT_MS = 3_000;
/**
 * How long to hold the SSE stream open. ESPHome replays the current state of every
 * entity immediately on connect, so this only has to cover that initial burst — it
 * is not a sampling window.
 */
const EVENT_COLLECT_MS = 1_200;
const HTTP_PORT = 80;

/**
 * ESPHome devices over the `web_server` component's local HTTP API.
 *
 * This is the single highest-leverage adapter in the registry, because ESPHome is
 * how a protocol we cannot speak becomes one we can: a $15 ESP32 bridges CN105
 * (Mitsubishi mini splits), Modbus, RS-485, 1-Wire or a bare GPIO and re-publishes
 * it as plain HTTP JSON. No npm package speaks CN105 — a registry search returns
 * nothing — so hand-rolling it in Node would mean a serial framer and a physical
 * cable at the indoor unit. This turns that HARD integration into an EASY one.
 *
 * Deliberately NOT the native API (protobuf over 6053) and NOT MQTT. The native API
 * would add a single-maintainer dependency and is a streaming connection, which fits
 * our `poll(device)` contract badly. MQTT would need a broker, which cuts against
 * local-first. `web_server` is one `fetch()` and zero new dependencies — structurally
 * the same shape as the Tasmota adapter.
 *
 * Implemented from ESPHome's documented web API; no hardware on hand to exercise it
 * against yet, so treat field-level behaviour as unverified until one is adopted.
 * Note `web_server` is not enabled by default and must be added to the device YAML.
 */
export class EsphomeAdapter implements DeviceAdapter {
  vendor = 'esphome';

  async poll(device: Device): Promise<DeviceState> {
    try {
      const entities = await readEntities(device.host, device.port || HTTP_PORT);
      if (!entities.length) return { reachable: true };
      const roles = classifyEsphomeEntities(entities, entityOverrides(device));
      const climate = entities.find((e) => e.domain === 'climate');
      return {
        reachable: true,
        on: entities.find((e) => e.domain === 'switch')?.on,
        powerW: roles.powerW,
        energyWh: roles.energyWh,
        temperatureC: climate?.currentTemperatureC ?? roles.temperatureC,
        setpointC: climate?.targetTemperatureC ?? null,
        // ESPHome reports what the unit is actually DOING (`action`), which is the
        // honest signal — a heat pump can be in HEAT mode while idle.
        ...(climate?.action !== undefined ? { heating: climate.action === 'HEATING' } : {}),
        rssi: roles.rssi,
      };
    } catch {
      return { reachable: false };
    }
  }

  async setOn(device: Device, on: boolean): Promise<void> {
    const entity = (await readEntities(device.host, device.port || HTTP_PORT)).find(
      (e) => e.domain === 'switch',
    );
    if (!entity) throw new Error('device exposes no switch entity');
    await post(device.host, device.port || HTTP_PORT, `/switch/${entity.objectId}/turn_${on ? 'on' : 'off'}`);
  }

  async setTargetTemperature(device: Device, celsius: number): Promise<void> {
    const entity = (await readEntities(device.host, device.port || HTTP_PORT)).find(
      (e) => e.domain === 'climate',
    );
    if (!entity) throw new Error('device exposes no climate entity');
    await post(
      device.host,
      device.port || HTTP_PORT,
      `/climate/${entity.objectId}/set?target_temperature=${celsius}`,
    );
  }
}

/** Explicit entity pinning from device config, for a unit with several same-unit sensors. */
function entityOverrides(device: Device): Record<string, string> {
  try {
    const config = device.config ? (JSON.parse(device.config) as { entities?: unknown }) : {};
    return (config.entities ?? {}) as Record<string, string>;
  } catch {
    return {};
  }
}

async function post(host: string, port: number, path: string): Promise<void> {
  const response = await fetch(`http://${host}:${port}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { connection: 'close' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export interface EsphomeInfo {
  name?: string;
  entities: number;
  /** True when any entity reports power or energy, i.e. it can contribute real kWh. */
  metered: boolean;
}

/** Identity probe, also the LAN discovery fingerprint. */
export async function esphomeInfo(host: string, port = HTTP_PORT): Promise<EsphomeInfo> {
  const entities = await readEntities(host, port);
  if (!entities.length) throw new Error('not ESPHome');
  const roles = classifyEsphomeEntities(entities, {});
  return {
    name: entities.find((e) => e.domain === 'climate')?.name ?? entities[0]?.name,
    entities: entities.length,
    metered: roles.powerW !== null || roles.energyWh !== null,
  };
}

/**
 * Read every entity's current state in one connection.
 *
 * `/events` is an SSE stream, and ESPHome replays the full current state on connect —
 * so one request returns everything, without us needing to know the entity names in
 * advance. That matters: entity names are author-chosen in YAML, so a per-name fetch
 * would require configuring each device by hand before it could be polled at all.
 */
export async function readEntities(host: string, port = HTTP_PORT): Promise<EsphomeEntity[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EVENT_COLLECT_MS);
  try {
    const response = await fetch(`http://${host}:${port}/events`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream', connection: 'close' },
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    let buffer = '';
    const decoder = new TextDecoder();
    // The stream never ends on its own, so we always leave early. The timeout is the
    // backstop; the fast path is the first `ping`, which ESPHome only sends once the
    // initial state replay is done. Without that check every poll would cost the full
    // collect window even though the data arrives in milliseconds.
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        if (/^event:\s*ping\s*$/m.test(buffer) && /^event:\s*state\s*$/m.test(buffer)) break;
      }
    } catch {
      /* aborted at the backstop, as intended */
    }
    return parseEventStream(buffer);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse SSE frames into entities. Frames look like:
 *   event: state
 *   data: {"id":"sensor-input_power","name":"Input power","state":"412 W","value":412}
 *
 * Only `state` events carry entity data; `log` and `ping` are ignored. A device that
 * republishes an entity mid-burst wins with its later value.
 */
export function parseEventStream(text: string): EsphomeEntity[] {
  const byId = new Map<string, EsphomeEntity>();
  for (const frame of text.split(/\n\n/)) {
    if (!/^event:\s*state\s*$/m.test(frame)) continue;
    const data = frame.match(/^data:\s*(.+)$/m)?.[1];
    if (!data) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue; // a frame truncated by the abort — expected on the last one
    }
    const id = typeof parsed.id === 'string' ? parsed.id : null;
    if (!id) continue;
    const dash = id.indexOf('-');
    if (dash <= 0) continue;
    byId.set(id, {
      id,
      domain: id.slice(0, dash),
      objectId: id.slice(dash + 1),
      name: typeof parsed.name === 'string' ? parsed.name : id.slice(dash + 1),
      state: typeof parsed.state === 'string' ? parsed.state : null,
      value: typeof parsed.value === 'number' ? parsed.value : null,
      on: typeof parsed.value === 'boolean' ? parsed.value : undefined,
      currentTemperatureC:
        typeof parsed.current_temperature === 'number' ? parsed.current_temperature : undefined,
      targetTemperatureC:
        typeof parsed.target_temperature === 'number' ? parsed.target_temperature : undefined,
      action: typeof parsed.action === 'string' ? parsed.action : undefined,
    });
  }
  return [...byId.values()];
}
