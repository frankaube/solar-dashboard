/**
 * Home Assistant MQTT discovery: the device publishes a config payload naming every sensor —
 * topic, unit, quantity — so one implementation covers every device speaking it. Written for
 * the Pila Mesh battery, which has no HTTP API. Adds only devices with no other way in: Pila,
 * and Zigbee sensors behind a Zigbee2MQTT bridge. Ambiguous templates are refused rather than
 * interpreted — see `readTemplate`.
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

/** `~` is HA's base-topic shorthand: a state topic of "~/state" means prefix + "/state". */
function resolveTopic(topic: string | null, prefix: string | null): string | null {
  if (!topic) return null;
  if (!prefix) return topic.includes('~') ? null : topic;
  return topic.replace(/~/g, prefix.replace(/\/$/, ''));
}

/**
 * Both payload shapes: one config per component, and the newer device-based payload carrying
 * a `components` map (Pila publishes the latter). `[]` for anything unusable rather than a
 * partial entity — a sensor with no state topic can never be read.
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
    // Sensors only. Switches and buttons are a control surface this app does not use.
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
 * The sliver of Jinja discovery payloads use: `{{ value_json.a.b }}`, `{{ value_json['a'] }}`,
 * `{{ value }}`. Everything else — filters, arithmetic, conditionals, `is_defined`, loops — is
 * unsupported and the sensor dropped: a half-working engine yields a plausible wrong number.
 */
export function readTemplate(template: string | null): TemplateResult {
  if (template === null) return { kind: 'raw' };
  const trimmed = template.trim();
  const match = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(trimmed);
  if (!match) return { kind: 'unsupported', template: trimmed };

  const expression = match[1].trim();
  if (expression === 'value') return { kind: 'raw' };
  if (!expression.startsWith('value_json')) return { kind: 'unsupported', template: trimmed };

  // Dotted and bracketed string keys only — no filters (`|`), operators or calls.
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
 * The entity's value as a number, or null when not knowable: unsupported template, missing
 * key, non-JSON payload where the template expects JSON, non-numeric result.
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

/** Watts from the declared unit. kW and W differ by 1000; unknown units are refused. */
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
