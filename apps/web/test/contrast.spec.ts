import { describe, expect, it } from 'vitest';
import { DARK, LIGHT, Pill, TokenSet } from '../src/tokens';

/*
  Contrast is computable, so it is computed rather than judged. Gold at #e5a52f is the right
  accent on a dark card and measures 1.9:1 on a light one; inverting a dark palette produces
  exactly that, silently.
*/

const rgb = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Perceptual distance between two colours, OKLab ΔE ×100.
 *
 * Contrast ratio only compares luminance: two colours at the same brightness can be
 * unmistakable, and two greys at different luminance can look identical.
 */
function deltaE(a: string, b: string): number {
  const oklab = (hex: string): [number, number, number] => {
    const [r, g, bl] = rgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
}

const AA = 4.5;
/** Large/bold text and non-text marks. */
const AA_LARGE = 3;

const report = (fg: string, bg: string): string => `${fg} on ${bg} = ${contrast(fg, bg).toFixed(2)}:1`;

describe.each([
  ['dark', DARK],
  ['light', LIGHT],
] as Array<[string, TokenSet]>)('%s theme', (_name, t) => {
  // Every surface, not just the card: `dim` passes at 4.52:1 on the card and fails at
  // 4.13:1 on the raised one.
  const surfaces = [t.surface.card, t.surface.app, t.surface.raised, t.surface.inset, t.surface.rail];

  it('body ink clears AA on every surface it is used on', () => {
    for (const bg of surfaces) {
      for (const ink of [t.ink.pri, t.ink.sec, t.ink.dim]) {
        expect(contrast(ink, bg), report(ink, bg)).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('faint ink is at least legible as large text', () => {
    // `faint` is deliberately the quietest step; it is never body copy.
    for (const bg of surfaces) {
      expect(contrast(t.ink.faint, bg), report(t.ink.faint, bg)).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it('series colours that carry text clear AA on the card', () => {
    // These are read as words — "83% sun", "$1.58", "16% roof" — not only drawn as marks.
    for (const key of ['production', 'money', 'car', 'house'] as const) {
      const c = t.series[key];
      expect(contrast(c, t.surface.card), `series.${key}: ${report(c, t.surface.card)}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('series colours that are only ever marks clear the non-text floor', () => {
    /*
      `grid` is a sankey node and a 10 px swatch, never a word. At the text threshold it
      goes dark enough to collide with the car blue at ΔE 10.9. 3:1 is the bar for a mark.
    */
    expect(
      contrast(t.series.grid, t.surface.card),
      `series.grid: ${report(t.series.grid, t.surface.card)}`,
    ).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it('status colours clear AA on the card', () => {
    for (const key of ['ok', 'warn', 'critical', 'info'] as const) {
      const c = t.status[key];
      expect(contrast(c, t.surface.card), `status.${key}: ${report(c, t.surface.card)}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('the link colour clears AA', () => {
    expect(contrast(t.accent.link, t.surface.card), report(t.accent.link, t.surface.card)).toBeGreaterThanOrEqual(AA);
  });

  it('every pill reads against its own background', () => {
    // A pill picks its three values together; the text must clear its own bg, not the page's.
    for (const [name, pill] of Object.entries(t.pill) as Array<[string, Pill]>) {
      expect(contrast(pill.fg, pill.bg), `pill.${name}: ${report(pill.fg, pill.bg)}`).toBeGreaterThanOrEqual(AA);
      // The border only has to be visible, not readable.
      expect(contrast(pill.border, pill.bg), `pill.${name} border`).toBeGreaterThanOrEqual(1.3);
    }
  });

  it('text on a saturated fill reads', () => {
    // "16% roof" sits inside the gold bar; the page's ink would disappear there.
    expect(contrast(t.on.gold, t.series.production), report(t.on.gold, t.series.production)).toBeGreaterThanOrEqual(AA);
  });

  it('gridlines are visible but recessive', () => {
    const c = contrast(t.grid.line, t.surface.card);
    expect(c, `grid.line: ${report(t.grid.line, t.surface.card)}`).toBeGreaterThan(1.05);
    expect(c, 'gridlines must not compete with the data').toBeLessThan(3);
  });

  it('adjacent series stay distinguishable from each other', () => {
    /*
      Perceptual distance, not WCAG contrast: the dark theme's gold-against-green is 1.08:1
      yet unmistakable. ΔE in OKLab measures whether two marks look alike.

      Only pairs this app actually draws together — the rows of "Where it's going" and the
      sankey nodes. The warm family (production, irradiance, financial, house) sits
      deliberately close and never shares a chart.
    */
    const pairs: Array<[keyof TokenSet['series'], keyof TokenSet['series']]> = [
      ['house', 'car'],
      ['house', 'battery'],
      ['car', 'battery'],
      ['house', 'grid'],
      ['car', 'grid'],
    ];
    /*
      Floor of 10, not the 15 for colour-alone marks. No value clears 15 against house, car
      and battery at once: cool greys collide with the car blue, warm ones with house. 10 is
      legal because every row and every sankey node is labelled — draw these unlabelled and
      it goes back to 15 and the palette loses a colour.
    */
    for (const [a, b] of pairs) {
      const d = deltaE(t.series[a], t.series[b]);
      expect(d, `${a} vs ${b}: ΔE ${d.toFixed(1)}`).toBeGreaterThanOrEqual(10);
    }
  });
});

describe('the two themes', () => {
  it('have identical shape', () => {
    // `solar` swaps one set for the other behind getters, so a key in only one is undefined
    // at runtime in exactly one mode.
    const shape = (t: TokenSet): string =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(t).map(([k, v]) => [
            k,
            typeof v === 'object' && v !== null ? Object.keys(v).sort() : typeof v,
          ]),
        ),
      );
    expect(shape(LIGHT)).toBe(shape(DARK));
  });

  it('are actually different', () => {
    expect(LIGHT.surface.card).not.toBe(DARK.surface.card);
    expect(luminance(LIGHT.surface.card)).toBeGreaterThan(luminance(DARK.surface.card));
    expect(luminance(LIGHT.ink.pri)).toBeLessThan(luminance(DARK.ink.pri));
  });
});
