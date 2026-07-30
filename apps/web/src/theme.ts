import { alpha, createTheme } from '@mui/material/styles';

const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
// Georgia is on every machine (no CDN) — the "answer" voice for plain-language lines.
const SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const tnum = {
  fontVariantNumeric: 'tabular-nums lining-nums',
  fontFeatureSettings: '"tnum" 1, "lnum" 1',
} as const;

/**
 * Sunhouse — "warm ledger, not control room." Every grey is warm-shifted; the dark
 * theme is a lamp-lit room. Colour means which energy this is (sun/house/battery/
 * car/grid) or how healthy something is — never decoration. See docs/ui-audit.md.
 */
export const solar = {
  // Energy identities + weather. `production` is the sun/gold accent.
  series: {
    production: '#e5a52f',
    irradiance: '#c98a5a',
    financial: '#c8933a',
    expected: '#7e766a',
    money: '#7fc79c',
    battery: '#7fc79c',
    car: '#8ba9d6',
    // Distinct from ink.dim/status.info, which it used to duplicate exactly — an energy
    // identity should never be the same value as "disabled text".
    grid: '#9c8f7a',
    house: '#d69a6a',
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
  // surfaces it is also used on — below AA. Nudged up so it clears 4.5:1 on both (4.87:1 on
  // inset, 5.28:1 on card) while staying in the same warm family.
  ink: { pri: '#f6f2ec', sec: '#b0a79b', dim: '#968c7e', faint: '#7e766a' },
  accent: { gold: '#e5a52f', link: '#c8933a' },
  grid: { line: '#241f1b', axis: '#35302a' },
  font: { serif: SERIF, sans: SANS, mono: MONO },
  radius: { control: 10, card: 16, hero: 22, pill: 999 },
  ramp: {
    power: ['#1b1917', '#6b4a24', '#e5a52f'],
    temp: ['#2a2018', '#c98a5a', '#c8933a'],
    energy: ['#201c18', '#5aa87a', '#7fc79c'],
  } as Record<string, string[]>,
  stale: { opacity: 0.55, border: '1px dashed #35302a' },
  dims: { rail: 76, topbar: 64, tabbar: 72 },
};

/** 3-stop ramp interpolation (t clamped 0..1). */
export function rampColor(stops: string[], t: number): string {
  const clamp = Math.max(0, Math.min(1, t));
  const hx = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a: string, b: string, u: number): string => {
    const A = hx(a);
    const B = hx(b);
    return `#${[0, 1, 2].map((i) => Math.round(A[i] + (B[i] - A[i]) * u).toString(16).padStart(2, '0')).join('')}`;
  };
  return clamp < 0.5 ? mix(stops[0], stops[1], clamp * 2) : mix(stops[1], stops[2], (clamp - 0.5) * 2);
}

declare module '@mui/material/styles' {
  interface TypographyVariants {
    metricHero: React.CSSProperties;
    metricLg: React.CSSProperties;
    metricMd: React.CSSProperties;
    mono: React.CSSProperties;
    answer: React.CSSProperties;
  }
  interface TypographyVariantsOptions {
    metricHero?: React.CSSProperties;
    metricLg?: React.CSSProperties;
    metricMd?: React.CSSProperties;
    mono?: React.CSSProperties;
    answer?: React.CSSProperties;
  }
}

declare module '@mui/material/Typography' {
  interface TypographyPropsVariantOverrides {
    metricHero: true;
    metricLg: true;
    metricMd: true;
    mono: true;
    answer: true;
  }
}

export const theme = createTheme({
  spacing: 4,
  shape: { borderRadius: 16 },
  palette: {
    mode: 'dark',
    background: { default: '#0e0d0b', paper: '#1b1917' },
    divider: '#2e2a25',
    text: { primary: '#f6f2ec', secondary: '#b0a79b', disabled: '#968c7e' },
    primary: { main: '#e5a52f', contrastText: '#1b1917' },
    secondary: { main: '#c98a5a', contrastText: '#1b1917' },
    success: { main: '#5aa87a' },
    warning: { main: '#e0a05a' },
    error: { main: '#e58b86' },
    info: { main: '#8a8073' },
    action: { hover: alpha('#f6f2ec', 0.04), selected: alpha('#f6f2ec', 0.08) },
  },
  typography: {
    fontFamily: SANS,
    // Serif "answer" voice for plain-language lines — you're being told something.
    answer: { fontFamily: SERIF, fontSize: 22, fontWeight: 400, lineHeight: 1.4 },
    // One 64px hero per screen; everything numeric is tabular.
    metricHero: { fontFamily: SANS, fontSize: 64, fontWeight: 300, lineHeight: 1, letterSpacing: '-0.03em', ...tnum },
    metricLg: { fontFamily: SANS, fontSize: 30, fontWeight: 500, lineHeight: 1, ...tnum },
    metricMd: { fontFamily: SANS, fontSize: 22, fontWeight: 500, lineHeight: 1, ...tnum },
    h5: { fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' },
    subtitle1: { fontSize: 15, fontWeight: 600 },
    body2: { fontSize: 13.5, lineHeight: 1.6 },
    caption: { fontSize: 12 },
    overline: {
      fontFamily: SANS,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      lineHeight: 1,
    },
    mono: { fontFamily: MONO, fontSize: 12, ...tnum },
  },
  components: {
    MuiCssBaseline: { styleOverrides: { body: { WebkitFontSmoothing: 'antialiased' } } },
    MuiTypography: {
      // The topbar page title was an <h5> and the custom variants fell back to <span>,
      // so no screen had an <h1> and the document had no heading outline at all.
      defaultProps: { variantMapping: { h5: 'h1', subtitle1: 'h3' } },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: { root: { backgroundImage: 'none', border: '1px solid #2e2a25' } },
    },
    MuiCard: { styleOverrides: { root: { borderRadius: 16 } } },
    MuiCardContent: {
      styleOverrides: { root: { padding: 20, '&:last-child': { paddingBottom: 20 } } },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { textTransform: 'none', fontWeight: 500, borderRadius: 10, minHeight: 36 } },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: { textTransform: 'none', fontWeight: 500, border: 0, borderRadius: 8, padding: '6px 13px' },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { background: '#24211d', border: '1px solid #35302a', fontSize: 12, padding: '9px 11px', borderRadius: 10 },
      },
    },
    MuiDivider: { styleOverrides: { root: { borderColor: '#2e2a25' } } },
  },
});
