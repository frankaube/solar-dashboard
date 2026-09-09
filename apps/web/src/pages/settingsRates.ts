/**
 * The money settings: their units, their limits, and the checks that run before a save.
 *
 * Apart from the page so the rules can be tested without mounting a form. The server
 * enforces all of it too; this only points a mistake at the field that caused it.
 */

export type RateKey = 'price' | 'ratedKw' | 'cost' | 'hstPct' | 'selfPct';

export interface RateField {
  key: RateKey;
  label: string;
  /** Optional: a field whose label and adornments already say it needs none. */
  help?: string;
  prefix?: string;
  suffix?: string;
  step: string;
  /** Blank is allowed for the optional ones; price is what every dollar figure needs. */
  required?: boolean;
  max?: number;
  maxMessage?: string;
}

/** `hstPct` is a percentage here but a fraction on the wire. */
export const RATE_FIELDS: RateField[] = [
  {
    key: 'price',
    label: 'Electricity price',
    prefix: '$',
    suffix: '/kWh',
    step: '0.0001',
    required: true,
    max: 5,
    maxMessage: 'That looks like dollars per kWh — most rates are well under $1.',
  },
  {
    key: 'ratedKw',
    label: 'System size',
    help: "Sets the capacity gauge — nothing reports this automatically.",
    suffix: 'kW',
    step: '0.1',
    max: 1000,
    maxMessage: 'Expected kilowatts, not watts.',
  },
  {
    key: 'cost',
    label: 'System cost',
    help: 'What the install cost, for payback tracking. Leave blank to hide payback.',
    prefix: '$',
    step: '100',
  },
  {
    key: 'hstPct',
    label: 'Sales tax on power',
    help: 'Tax you pay buying power back — sets how much more self-consumed solar is worth than exported.',
    suffix: '%',
    // Fine enough for 14.975: a coarser step makes the browser mark that value
    // stepMismatch and paint the field invalid even though it is exactly right.
    step: '0.001',
    max: 99,
    maxMessage: 'Enter a percentage, e.g. 15.',
  },
  {
    key: 'selfPct',
    label: 'Solar used as you make it',
    // Deliberately generic: the rest of the sentence depends on what the install can
    // measure, so it is composed at render time from what the server reports.
    help: 'Rough share used at home rather than exported.',
    suffix: '%',
    step: '1',
    max: 100,
    maxMessage: 'Enter a percentage, e.g. 35.',
  },
];

/**
 * Stored fraction → the percentage shown in the field.
 *
 * Six decimal places of percent, not two: two cleans up the float noise (0.15 * 100 is
 * 15.000000000000002) but rewrites 14.975% — Quebec's combined GST+QST — as 14.98%.
 */
export function hstToPercent(fraction: number): string {
  return String(Math.round(fraction * 1e8) / 1e6);
}

/** The percentage typed in the field → the fraction the endpoint expects. */
export function hstToFraction(percent: string): number {
  return Number(percent) / 100;
}

export function validateRates(
  values: Partial<Record<RateKey, string>>,
): Partial<Record<RateKey, string>> {
  const errors: Partial<Record<RateKey, string>> = {};
  for (const field of RATE_FIELDS) {
    const raw = values[field.key]?.trim() ?? '';
    if (!raw) {
      if (field.required) errors[field.key] = 'Required.';
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) errors[field.key] = 'Must be a number.';
    else if (value <= 0) errors[field.key] = 'Must be greater than zero.';
    else if (field.max !== undefined && value > field.max) {
      errors[field.key] = field.maxMessage ?? `Must be ${field.max} or less.`;
    }
  }
  return errors;
}
