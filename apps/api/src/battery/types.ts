/** What a battery source provides. Vendors describe their own connection; the page renders the registry. */

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

export interface BatterySource {
  read(): Promise<BatteryReading>;
}

/** `local` needs a LAN host; `cloud` needs credentials — no direct access exists. Shown in the UI. */
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

/** `documented` = parses what the spec says, no evidence about what the device sends. Shown in the picker. */
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
