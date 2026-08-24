/**
 * The two palettes.
 *
 * Light is authored, not derived. Inverting the dark set gives gold text at 1.9:1 on paper
 * and a "money" green that vanishes — the accents that carry meaning here are tuned for a
 * lamp-lit room and have to be re-picked for a bright one, at the same jobs. Every value
 * that carries text is contrast-checked against the surface it actually sits on; see
 * test/contrast.spec.ts, which fails the build rather than trusting the eye.
 *
 * Both sets have identical shape. That is load-bearing: `solar` in theme.ts exposes one
 * group at a time through getters, so 363 call sites read the active mode without knowing
 * a mode exists — including the ones that hand colours to a canvas, where a CSS variable
 * would arrive as the literal string "var(--x)" and paint nothing.
 */

export interface Pill {
  bg: string;
  border: string;
  fg: string;
}

export interface TokenSet {
  series: Record<
    'production' | 'irradiance' | 'financial' | 'expected' | 'money' | 'battery' | 'car' | 'grid' | 'house',
    string
  >;
  status: Record<'ok' | 'warn' | 'critical' | 'info', string>;
  surface: Record<'rail' | 'app' | 'raised' | 'card' | 'hero' | 'inset' | 'border' | 'borderStrong', string>;
  ink: Record<'pri' | 'sec' | 'dim' | 'faint', string>;
  accent: Record<'gold' | 'link', string>;
  grid: Record<'line' | 'axis', string>;
  /** Status/state chips: three values that must be picked together, per state. */
  pill: Record<'ok' | 'warn' | 'bad' | 'neutral' | 'charging' | 'driving', Pill>;
  /** Text laid on a saturated fill, where the page's ink would disappear. */
  on: Record<'gold' | 'cool', string>;
  ramp: Record<'power' | 'temp' | 'energy', string[]>;
  stale: { opacity: number; border: string };
}

export const DARK: TokenSet = {
  series: {
    production: '#e5a52f',
    irradiance: '#c98a5a',
    financial: '#c8933a',
    expected: '#7e766a',
    money: '#7fc79c',
    battery: '#7fc79c',
    // Nudged bluer: at #8ba9d6 it sat ΔE 13.8 from the battery/money green it is drawn
    // beside in 'Where it's going' — below the 15 floor for two marks in one chart.
    car: '#86a6e8',
    // Distinct from ink.dim/status.info, which it used to duplicate exactly — an energy
    // identity should never be the same value as "disabled text".
    grid: '#9c8f7a',
    // ΔE 14.9 from the battery green at #d69a6a — just under the floor for two marks in
    // the same sankey. Nudged warmer to 16.4.
    house: '#dd9560',
  },
  status: { ok: '#5aa87a', warn: '#e0a05a', critical: '#e58b86', info: '#8a8073' },
  surface: {
    rail: '#100f0d',
    app: '#131210',
    raised: '#24211d',
    card: '#1b1917',
    hero: '#1b1917',
    inset: '#24211d',
    border: '#2e2a25',
    borderStrong: '#35302a',
  },
  // `dim` was #8a8073, which measured 4.52:1 on the card but only 4.13:1 on the raised/inset
  // surfaces it is also used on — below AA. Nudged up so it clears 4.5:1 on both.
  ink: { pri: '#f6f2ec', sec: '#b0a79b', dim: '#968c7e', faint: '#7e766a' },
  accent: { gold: '#e5a52f', link: '#c8933a' },
  grid: { line: '#241f1b', axis: '#35302a' },
  pill: {
    ok: { bg: '#1e2f24', border: '#2f5a41', fg: '#7fc79c' },
    warn: { bg: '#332417', border: '#6b4a24', fg: '#e0a05a' },
    bad: { bg: '#331d1c', border: '#6b3330', fg: '#e58b86' },
    neutral: { bg: '#24211d', border: '#3a352e', fg: '#a49887' },
    charging: { bg: '#251f33', border: '#4a3d68', fg: '#b3a3e0' },
    driving: { bg: '#1d2a2b', border: '#2f5257', fg: '#7fc3c9' },
  },
  on: { gold: '#241a05', cool: '#0d1620' },
  ramp: {
    power: ['#1b1917', '#6b4a24', '#e5a52f'],
    temp: ['#2a2018', '#c98a5a', '#c8933a'],
    energy: ['#201c18', '#5aa87a', '#7fc79c'],
  },
  stale: { opacity: 0.55, border: '1px dashed #35302a' },
};

/**
 * Warm paper, not clinical white — the same "warm ledger" the dark set is, lit differently.
 *
 * The accents are darker than their dark-mode counterparts wherever they carry text: gold
 * at #e5a52f measures 1.9:1 on paper, so the reading of "83% sun" would be a suggestion
 * rather than a word. Chart fills tolerate the lighter value; text does not, and one token
 * serves both, so the text requirement wins.
 */
export const LIGHT: TokenSet = {
  series: {
    production: '#9c6a06',
    irradiance: '#9a5c2b',
    financial: '#845f10',
    expected: '#8a8175',
    money: '#26714a',
    battery: '#26714a',
    car: '#37578c',
    // Lighter than a text colour would allow, and that is correct: this one is only ever
    // a sankey node and a 10 px swatch, never a word. Holding it to 4.5:1 forced it dark
    // enough to collide with the car blue at ΔE 10.9.
    grid: '#8f8578',
    // Redder than the dark set's house: on paper the browns collapse into the greys, and
    // this had to clear the utility-grid colour it shares a sankey with.
    house: '#bf4a12',
  },
  status: { ok: '#26714a', warn: '#8a5406', critical: '#a83b35', info: '#6b6153' },
  surface: {
    rail: '#efe9dc',
    app: '#f4f0e6',
    raised: '#f2ece1',
    card: '#fffdf7',
    hero: '#fffdf7',
    inset: '#efe9dc',
    border: '#e3dcce',
    borderStrong: '#d1c8b6',
  },
  ink: { pri: '#211e19', sec: '#524a3e', dim: '#6b6153', faint: '#847a6b' },
  accent: { gold: '#9c6a06', link: '#845f10' },
  grid: { line: '#eae3d4', axis: '#d1c8b6' },
  pill: {
    ok: { bg: '#e7f2ea', border: '#a5ccb7', fg: '#1c603d' },
    warn: { bg: '#fbf0dc', border: '#ddbe84', fg: '#7d4c05' },
    bad: { bg: '#fbebea', border: '#e6a5a1', fg: '#8f2f2a' },
    neutral: { bg: '#f0ece3', border: '#cec5b4', fg: '#5f5648' },
    charging: { bg: '#eee9f8', border: '#bfb2e3', fg: '#4c3890' },
    driving: { bg: '#e5f1f2', border: '#a4c9cd', fg: '#1b565d' },
  },
  /*
    Light, not dark — I had assumed these could be shared between the modes because they
    sit on a saturated fill, and the contrast test disagreed at 3.66:1. The fill is not the
    same colour in both: light-mode gold is #9c6a06, dark enough for text on paper, which
    makes it too dark to carry near-black text. When the accent moves, what sits on it
    moves with it.
  */
  on: { gold: '#fffdf7', cool: '#f4f0e6' },
  ramp: {
    power: ['#fdf7e8', '#e0b25e', '#9c6a06'],
    temp: ['#fbf2e9', '#c98a5a', '#845f10'],
    energy: ['#eef6f0', '#5aa87a', '#26714a'],
  },
  stale: { opacity: 0.6, border: '1px dashed #d1c8b6' },
};

export type ThemeMode = 'dark' | 'light';

export const TOKENS: Record<ThemeMode, TokenSet> = { dark: DARK, light: LIGHT };
