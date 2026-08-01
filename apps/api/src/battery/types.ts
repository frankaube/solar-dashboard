/**
 * What a battery source has to provide, and how the UI learns to ask for it.
 *
 * The battery page hardcoded one vendor's setup form: a heading that said EcoFlow, two
 * fields named access key and secret key, and a paragraph promising three others "on
 * the roadmap". Adding a second vendor meant editing the page, and a vendor that
 * connects by IP rather than by API key had nowhere to put its address at all.
 *
 * A vendor now describes its own connection, the same way `INVERTER_VENDORS` describes
 * a solar gateway and the probe registry describes what a scan looks for. The page
 * renders whatever the registry contains.
 */

export interface BatteryReading {
  /** State of charge, 0-100. */
  soc: number;
  /** Positive charging, negative discharging — the sign convention the whole app uses. */
  powerW: number;
  capacityKwh?: number | null;
  /** Reserve below which the pack will not discharge, if the vendor reports one. */
  reservePct?: number | null;
  cycles?: number | null;
  model?: string;
  name?: string;
}

/** Anything that can answer "what is the battery doing right now". */
export interface BatterySource {
  read(): Promise<BatteryReading>;
}

/**
 * How an owner connects this vendor.
 *
 * `local` needs a host on their network. `cloud` needs credentials, because the vendor
 * offers no way to reach the hardware directly — a fact worth stating in the UI rather
 * than hiding behind a form that looks like every other form.
 */
export type BatteryConnection = 'local' | 'cloud';

export interface BatteryField {
  /** Key stored in settings, and the name used in the config payload. */
  key: string;
  label: string;
  /** Masked in the UI and never echoed back by the API. */
  secret?: boolean;
  placeholder?: string;
  help?: string;
}

/**
 * How well we actually know this integration works.
 *
 * Same distinction `fixtures.ts` draws and for the same reason: implementing a
 * published spec proves we parse what the document says, and proves nothing about what
 * the device sends. Saying so in the picker is cheaper than an owner discovering it.
 */
export type VendorConfidence = 'verified' | 'documented';

export interface BatteryVendor {
  id: string;
  name: string;
  connection: BatteryConnection;
  confidence: VendorConfidence;
  /** One line the picker shows under the name. */
  summary: string;
  /** Longer explanation of what the owner has to do, shown once selected. */
  setupHint: string;
  fields: BatteryField[];
  /** Built from the stored settings; null when they are missing or unusable. */
  createSource(config: Record<string, string>): BatterySource | null;
}
