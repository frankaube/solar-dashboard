/**
 * Home Assistant MQTT discovery, as a device source.
 *
 * The device describes itself. It publishes a config payload naming every sensor it has —
 * the topic to read, the unit, what kind of quantity it is — and a consumer that
 * understands that one convention understands every device speaking it. That is the whole
 * bet, and it is the same one SunSpec was: implement a published convention once instead of
 * a vendor at a time.
 *
 * Written for the Pila Mesh battery, which has no HTTP API and publishes nothing but MQTT.
 * Its own integration repository contains no Python at all — it is documentation plus
 * dashboard examples, because the battery emits discovery and Home Assistant reads the
 * schema out of it at runtime.
 *
 * The reach is narrower than it first looks, and worth stating plainly: Shelly, Tasmota,
 * ESPHome and Daikin are already read over plain HTTP by their own adapters, with no
 * broker involved. What this actually adds is devices with no other way in — Pila, and
 * Zigbee sensors that have no IP address at all and exist only behind a Zigbee2MQTT
 * bridge.
 *
 * Nothing here is guessed from a vendor's screenshots. Where the convention is ambiguous
 * this refuses rather than interprets — see `readTemplate`.
 */

/** HA abbreviates discovery keys to keep payloads small. Expanded before anything reads them. */
const ABBREVIATIONS: Record<string, string> = {
  '~': 'topic_prefix',
  avty_t: 'availability_topic',
  cmps: 'components',
  dev: 'device',
  dev_cla: 'device_class',
  ic: 'icon',
  mdl: 'model',
  name: 'name',
  p: 'platform',
  stat_cla: 'state_class',
  stat_t: 'state_topic',
  unit_of_meas: 'unit_of_measurement',
  uniq_id: 'unique_id',
  val_tpl: 'value_template',
};

export interface DiscoveredEntity {
  /** Stable across restarts — the device's own id for this sensor. */
  uniqueId: string;
  name: string;
  /** Where the value arrives. */
  stateTopic: string;
  /** How to pull it out of the payload, if the payload is JSON. */
  valueTemplate: string | null;
  unit: string | null;
  /** HA's classification: `battery`, `power`, `energy`, … */
  deviceClass: string | null;
  deviceName: string | null;
  deviceModel: string | null;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** Expand abbreviated keys one level; nested objects are expanded by their own callers. */
function expand(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[ABBREVIATIONS[key] ?? key] = value;
  }
  return out;
}

/**
 * `~` is HA's base-topic shorthand: a state topic of "~/state" means prefix + "/state".
 * Ignoring it yields a topic that never matches, and a sensor that silently never updates.
 */
function resolveTopic(topic: string | null, prefix: string | null): string | null {
  if (!topic) return null;
  if (!prefix) return topic.includes('~') ? null : topic;
  return topic.replace(/~/g, prefix.replace(/\/$/, ''));
}

/**
 * Turn one discovery payload into the entities it declares.
 *
 * Handles both shapes: the long-standing one config per component, and the newer
 * device-based payload that carries a `components` map. Pila publishes the latter.
 *
 * Returns `[]` for anything unusable rather than a partially-populated entity — a sensor
 * with no state topic is not a sensor we can read, and pretending otherwise puts a name on
 * a screen that will never show a number.
 */
export function parseDiscovery(payload: string): DiscoveredEntity[] {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];

  const root = expand(raw as Record<string, unknown>);
  const prefix = str(root.topic_prefix);
  const device = (typeof root.device === 'object' && root.device !== null
    ? expand(root.device as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const deviceName = str(device.name);
  const deviceModel = str(device.model);

  const build = (
    node: Record<string, unknown>,
    fallbackId: string | null,
  ): DiscoveredEntity | null => {
    const stateTopic = resolveTopic(str(node.state_topic), prefix);
    const uniqueId = str(node.unique_id) ?? fallbackId;
    if (!stateTopic || !uniqueId) return null;
    // Only read-only numeric-ish things. Switches and buttons are a control surface, and
    // this app does not command other people's hardware.
    const platform = str(node.platform);
    if (platform !== null && platform !== 'sensor' && platform !== 'binary_sensor') return null;
    return {
      uniqueId,
      name: str(node.name) ?? uniqueId,
      stateTopic,
      valueTemplate: str(node.value_template),
      unit: str(node.unit_of_measurement),
      deviceClass: str(node.device_class),
      deviceName,
      deviceModel,
    };
  };

  const components = root.components;
  if (typeof components === 'object' && components !== null && !Array.isArray(components)) {
    const out: DiscoveredEntity[] = [];
    for (const [id, value] of Object.entries(components as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const merged = { ...expand(value as Record<string, unknown>) };
      // A component inherits the device's base topic and availability, not its own.
      const entity = build(merged, id);
      if (entity) out.push(entity);
    }
    return out;
  }

  const single = build(root, null);
  return single ? [single] : [];
}

export type TemplateResult =
  | { kind: 'value'; value: string }
  | { kind: 'raw' }
  | { kind: 'unsupported'; template: string };

/**
 * Evaluate the sliver of Jinja that discovery payloads actually use.
 *
 * `{{ value_json.battery.soc }}`, `{{ value_json['a']['b'] }}` and `{{ value }}` cover the
 * overwhelming majority, and are unambiguous. Everything else — filters, arithmetic,
 * conditionals, `is_defined`, loops — is reported as unsupported and the sensor is dropped.
 *
 * That refusal is the point. A template engine that half-works produces a number that
 * looks like a reading and is not one, and no screen can tell the difference. Refusing to
 * read a sensor is visible; misreading it is not.
 */
export function readTemplate(template: string | null): TemplateResult {
  if (template === null) return { kind: 'raw' };
  const trimmed = template.trim();
  const match = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(trimmed);
  if (!match) return { kind: 'unsupported', template: trimmed };

  const expression = match[1].trim();
  if (expression === 'value') return { kind: 'raw' };
  if (!expression.startsWith('value_json')) return { kind: 'unsupported', template: trimmed };

  // Only dotted keys and bracketed string keys, nothing else — no filters (`|`), no
  // operators, no calls.
  const path = expression.slice('value_json'.length);
  if (path === '') return { kind: 'raw' };
  if (!/^(\.[A-Za-z_][A-Za-z0-9_]*|\['[^']*'\]|\["[^"]*"\])+$/.test(path)) {
    return { kind: 'unsupported', template: trimmed };
  }
  return { kind: 'value', value: path };
}

/** Walk a parsed path like `.a['b'].c` into a payload. Missing → null, never a guess. */
export function extract(payload: unknown, path: string): unknown {
  let current = payload;
  const steps = path.match(/\.[A-Za-z_][A-Za-z0-9_]*|\['[^']*'\]|\["[^"]*"\]/g) ?? [];
  for (const step of steps) {
    const key = step.startsWith('.') ? step.slice(1) : step.slice(2, -2);
    if (typeof current !== 'object' || current === null) return null;
    current = (current as Record<string, unknown>)[key];
    if (current === undefined) return null;
  }
  return current;
}

/**
 * The value a state message carries for one entity, as a number.
 *
 * Returns null whenever the answer is not knowable: an unsupported template, a missing
 * key, a payload that is not JSON when the template expects one, a non-numeric result.
 */
export function readValue(entity: DiscoveredEntity, payload: string): number | null {
  const template = readTemplate(entity.valueTemplate);
  if (template.kind === 'unsupported') return null;

  let text: unknown = payload;
  if (template.kind === 'value') {
    try {
      text = extract(JSON.parse(payload), template.value);
    } catch {
      return null;
    }
  }
  if (text === null || text === undefined || typeof text === 'boolean') return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

/**
 * Watts, from whatever unit the device declared.
 *
 * kW and W are both common and differ by a factor of a thousand, which is the kind of
 * error that looks plausible on a chart for months. Unknown units are refused.
 */
export function toWatts(value: number, unit: string | null): number | null {
  switch ((unit ?? '').trim().toUpperCase()) {
    case 'W':
      return value;
    case 'KW':
      return value * 1000;
    case 'MW':
      return value * 1_000_000;
    default:
      return null;
  }
}

/** Watt-hours, same reasoning. */
export function toWattHours(value: number, unit: string | null): number | null {
  switch ((unit ?? '').trim().toUpperCase()) {
    case 'WH':
      return value;
    case 'KWH':
      return value * 1000;
    case 'MWH':
      return value * 1_000_000;
    default:
      return null;
  }
}
