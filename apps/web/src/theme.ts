import { alpha, createTheme } from '@mui/material/styles';
import { TOKENS, ThemeMode, TokenSet } from './tokens';

export type { ThemeMode };

const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
// Georgia is on every machine (no CDN) — the "answer" voice for plain-language lines.
const SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const tnum = {
  fontVariantNumeric: 'tabular-nums lining-nums',
  fontFeatureSettings: '"tnum" 1, "lnum" 1',
} as const;

const STORAGE_KEY = 'solar.theme';

let active: TokenSet = TOKENS.dark;

/**
 * Sunhouse — "warm ledger, not control room." Every grey is warm-shifted; dark is a
 * lamp-lit room and light is paper, not a control panel painted white. Colour means which
 * energy this is (sun/house/battery/car/grid) or how healthy something is — never
 * decoration.
 *
 * The colour groups are getters over the active token set rather than fixed values.
 *
 * That is not cleverness for its own sake — it is what lets a second mode exist without
 * editing 363 call sites. The obvious alternative, CSS custom properties, works for
 * everything in the DOM and silently fails for the two-thirds of these reads that end up
 * on a canvas: ECharts would receive the string "var(--series-production)" and paint
 * nothing.
 *
 * The trade is that `solar.series` is not referentially stable across a mode change, so
 * nothing may capture a group in a memo that outlives one. Chart options here are rebuilt
 * on every render, which is why this holds.
 */
export const solar = {
  get series() {
    return active.series;
  },
  get status() {
    return active.status;
  },
  get surface() {
    return active.surface;
  },
  get ink() {
    return active.ink;
  },
  get accent() {
    return active.accent;
  },
  get grid() {
    return active.grid;
  },
  get pill() {
    return active.pill;
  },
  get on() {
    return active.on;
  },
  get ramp() {
    return active.ramp;
  },
  get stale() {
    return active.stale;
  },
  // Mode-independent: shape and type do not change with the light.
  font: { serif: SERIF, sans: SANS, mono: MONO },
  radius: { control: 10, card: 16, hero: 22, pill: 999 },
  dims: { rail: 76, topbar: 64, tabbar: 72 },
};

/** What was chosen last, else what the system asks for. */
export function initialThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Private browsing or a blocked store — fall through to the system preference.
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

/**
 * Swap the palette.
 *
 * Must run before the render that reads it, which the provider guarantees by calling it
 * during the state update rather than from an effect — effects run after paint, so the
 * first frame of a toggle would be the new surfaces under the old ink.
 */
export function setThemeMode(mode: ThemeMode): void {
  active = TOKENS[mode];
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = mode;
    // Tells the browser what to paint behind the app — visible when the content is
    // shorter than the viewport, and behind the rubber-band scroll on iOS.
    document.documentElement.style.colorScheme = mode;
  }
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Failing to remember the choice is not a reason to refuse it.
  }
}

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

/**
 * The MUI theme for a mode.
 *
 * Built from the same tokens `solar` serves, so the two cannot disagree. Every colour
 * below used to be a hard-coded hex repeating a palette value — which is exactly how a
 * theme ends up half-changed.
 */
export function buildTheme(mode: ThemeMode): ReturnType<typeof createTheme> {
  const t = TOKENS[mode];
  return createTheme({
    spacing: 4,
    shape: { borderRadius: 16 },
    palette: {
      mode,
      // The app background is a shade below the rail in dark, and the paper tone in light.
      background: { default: mode === 'dark' ? '#0e0d0b' : t.surface.app, paper: t.surface.card },
      divider: t.surface.border,
      text: { primary: t.ink.pri, secondary: t.ink.sec, disabled: t.ink.dim },
      primary: { main: t.accent.gold, contrastText: t.on.gold },
      secondary: { main: t.series.irradiance, contrastText: t.on.gold },
      success: { main: t.status.ok },
      warning: { main: t.status.warn },
      error: { main: t.status.critical },
      info: { main: t.status.info },
      action: { hover: alpha(t.ink.pri, 0.04), selected: alpha(t.ink.pri, 0.08) },
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
        styleOverrides: { root: { backgroundImage: 'none', border: `1px solid ${t.surface.border}` } },
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
          tooltip: {
            background: t.surface.raised,
            color: t.ink.pri,
            border: `1px solid ${t.surface.borderStrong}`,
            fontSize: 12,
            padding: '9px 11px',
            borderRadius: 10,
          },
        },
      },
      MuiDivider: { styleOverrides: { root: { borderColor: t.surface.border } } },
    },
  });
}
