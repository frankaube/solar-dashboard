import { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { fetchBattery, fetchCharger, fetchSummary, usePolling } from '../api';
import { solar } from '../theme';

const POLL_MS = 30_000;
/** The render is 1024x1024; the overlay shares its coordinate space exactly. */
const CANVAS = 1024;

/**
 * The house, with live values pinned to it.
 *
 * A static isometric render carries the geometry and an SVG overlay carries
 * everything that changes — the same split the reference apps use, and the reason
 * this can show live watts at all. An illustration alone could never say "1.2 kW".
 *
 * Anchor points below are measured against the render. If the artwork is ever
 * replaced, these are the only numbers that need revisiting.
 */
const ANCHOR = {
  solar: { x: 360, y: 320 },
  car: { x: 150, y: 640 },
  battery: { x: 795, y: 557 },
  grid: { x: 900, y: 500 },
};

/**
 * The panel array, found by its own seams.
 *
 * Absolute luminance was the wrong signal — the render has a lighting gradient across
 * the roof, so "how bright is this pixel" says more about where the light is than
 * about what the surface is. Averaging the DERIVATIVE along each axis cancels that
 * gradient and leaves only real edges, which turn out to be the panel seams, evenly
 * spaced:
 *
 *   across the ridge   0.02  0.19  0.36  0.53  0.69  0.86     six columns
 *   down the rake      0.01  0.22  0.45  0.68  0.90           four rows
 *
 * So the array runs u 0.02..1.00 and v 0.01..0.90 in roof space. The previous guess
 * inset 7% uniformly, which pulled the wash in from the top and right where there is
 * no trim at all — hence the skew.
 */
const SOLAR_PLANE = '297,200 598,278 447,463 145,385';

/**
 * Three lines down the roof, along the rake, for the flow animation.
 *
 * Dashes travelling toward the eave read as energy leaving the panels and heading
 * into the house. A pulse said only "something is on"; this says which way it is
 * going, which is the thing worth showing.
 */
const FLOW_LINES = [
  { from: [360, 226], to: [219, 399] },
  { from: [437, 246], to: [296, 419] },
  { from: [514, 266], to: [373, 439] },
];

/**
 * Where a wall-mounted battery would go.
 *
 * The artwork has no battery, so this draws one. It sits on the large unbroken wall
 * on the right — confirmed empty by sampling the render, and clear of the utility box
 * further along. Horizontal edges follow the building's own axis (dy/dx = -0.50,
 * measured from the base slab); vertical edges stay vertical, as they do on a wall.
 */
const BATTERY_UNIT = '760,520 830,485 830,595 760,630';

type Tone = 'live' | 'idle' | 'unknown';

const TONE: Record<Tone, string> = {
  live: solar.accent.gold,
  idle: solar.ink.sec,
  unknown: solar.ink.faint,
};

/**
 * One labelled reading with a leader line to the thing it describes.
 *
 * `unknown` is a first-class state, not an empty string. A dim value and a dashed
 * leader say "we cannot see this" — which is true of three of the five nodes here,
 * and is the difference between an honest picture and a broken-looking one.
 */
function Reading({
  x,
  y,
  labelY,
  value,
  caption,
  tone,
}: {
  x: number;
  y: number;
  labelY: number;
  value: string;
  caption: string;
  tone: Tone;
}): ReactElement {
  const above = labelY < y;
  return (
    <g>
      <line
        x1={x}
        y1={above ? labelY + 26 : labelY - 46}
        x2={x}
        y2={y}
        stroke={tone === 'unknown' ? solar.ink.faint : solar.surface.borderStrong}
        strokeWidth={1.5}
        strokeDasharray={tone === 'unknown' ? '6 5' : undefined}
        opacity={tone === 'unknown' ? 0.65 : 0.9}
      />
      <circle cx={x} cy={y} r={4} fill={TONE[tone]} opacity={tone === 'unknown' ? 0.5 : 1} />
      <text
        x={x}
        y={labelY}
        textAnchor="middle"
        fill={TONE[tone]}
        style={{ font: `600 30px/1 ${solar.font.sans}` }}
      >
        {value}
      </text>
      <text
        x={x}
        y={labelY + 26}
        textAnchor="middle"
        fill={solar.ink.dim}
        style={{ font: `600 19px/1 ${solar.font.sans}`, letterSpacing: '0.12em' }}
      >
        {caption}
      </text>
    </g>
  );
}

export function HouseFlow(): ReactElement {
  const { data: summary } = usePolling(fetchSummary, POLL_MS);
  const { data: charger } = usePolling(fetchCharger, POLL_MS);
  const { data: battery } = usePolling(fetchBattery, POLL_MS);

  const solarW = summary?.currentPowerW ?? 0;
  const producing = solarW > 50;
  const vehicle = charger?.vehicle ?? null;
  const charging = charger?.live?.charging ?? false;
  const hasBattery = battery?.present ?? false;
  /*
    Faster when the roof is making more. Clamped at both ends: below ~1s the dashes
    blur into a solid line and stop reading as discrete packets, and above ~3s the
    movement is slow enough to look stalled.
  */
  const flowSeconds = Math.max(1, Math.min(3, 3.2 - (solarW / 24000) * 2.4)).toFixed(2);

  const carValue = vehicle
    ? `${vehicle.batteryLevel ?? '—'}%`
    : charger?.live
      ? 'Idle'
      : '—';
  const carCaption = vehicle?.name?.toUpperCase() ?? 'CAR';

  return (
    <Box sx={{ position: 'relative', width: '100%' }}>
      <Box
        component="img"
        src="/house.png"
        alt=""
        sx={{ width: '100%', display: 'block' }}
      />
      <Box
        component="svg"
        viewBox={`0 0 ${CANVAS} ${CANVAS}`}
        sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        role="img"
        aria-label={`Solar ${producing ? `${(solarW / 1000).toFixed(1)} kilowatts` : 'idle'}. House load and grid are not measured. No battery installed. Car ${carValue}.`}
      >
        {/*
          The roof, lit by what it is making.

          Two layers doing different jobs: the group's opacity is the MAGNITUDE — a
          dawn trickle and a midday flood must not look alike — while the polygon
          inside breathes to say the panels are working rather than merely present.
          Separating them means the pulse never changes what the number means.

          The animation stops for anyone who has asked their system for less motion.
          A slow glow on a dashboard someone glances at all day is exactly the kind of
          thing that should be easy to switch off.
        */}
        {/*
          The wash is now steady — magnitude only. It says how much the roof is making;
          the moving dashes below say that it is moving and where to. Making one mark
          carry both jobs was why the pulse read as decoration.
        */}
        <polygon
          points={SOLAR_PLANE}
          fill={solar.accent.gold}
          opacity={producing ? Math.min(0.2, 0.07 + (solarW / 24000) * 0.4) : 0}
          style={{ transition: 'opacity 1.2s ease' }}
        />

        {/*
          Flow, the way a charging cable shows it: dashes travelling down the rake
          toward the house. Speed scales with output, so a bright noon visibly hurries
          and a dim evening crawls — the rate carries information rather than being a
          fixed decorative loop.

          Stops under prefers-reduced-motion. Continuous movement in the corner of the
          eye is the first thing that becomes unbearable on a screen left open all day.
        */}
        {producing &&
          FLOW_LINES.map((l, i) => (
            <Box
              key={i}
              component="line"
              x1={l.from[0]}
              y1={l.from[1]}
              x2={l.to[0]}
              y2={l.to[1]}
              stroke={solar.accent.gold}
              strokeWidth={5}
              strokeLinecap="round"
              strokeDasharray="10 30"
              sx={{
                opacity: 0.85,
                '@keyframes solarFlow': { to: { strokeDashoffset: -40 } },
                animation: `solarFlow ${flowSeconds}s linear infinite`,
                animationDelay: `${i * -0.35}s`,
                '@media (prefers-reduced-motion: reduce)': { animation: 'none', opacity: 0.35 },
              }}
            />
          ))}

        {/*
          The battery. Drawn rather than rendered, because the artwork has none — and a
          slot you can see is more useful than a label pointing at bare wall. Dashed and
          dim while absent; it fills in and lights its strip once one is connected.
        */}
        <polygon
          points={BATTERY_UNIT}
          fill={hasBattery ? solar.surface.raised : 'none'}
          fillOpacity={hasBattery ? 0.9 : 0}
          stroke={hasBattery ? solar.series.money : solar.ink.faint}
          strokeWidth={2.5}
          strokeDasharray={hasBattery ? undefined : '9 7'}
          strokeLinejoin="round"
        />
        {hasBattery && (
          <polyline
            points="770,600 770,545"
            stroke={solar.series.money}
            strokeWidth={5}
            strokeLinecap="round"
          />
        )}

        <Reading
          x={ANCHOR.solar.x}
          y={ANCHOR.solar.y}
          labelY={132}
          value={producing ? `${(solarW / 1000).toFixed(1)} kW` : '0 kW'}
          caption="SOLAR"
          tone={producing ? 'live' : 'idle'}
        />
        {/*
          No HOME label. The house is the thing you are looking at, so pointing a
          leader line at it to say "home" was a label for its own sake — and a dash
          beside it said nothing except that a sensor is missing, which the caption
          below already says once, properly.
        */}
        <Reading
          x={ANCHOR.car.x}
          y={ANCHOR.car.y}
          labelY={904}
          value={carValue}
          caption={carCaption}
          tone={charging ? 'live' : 'idle'}
        />
        <Reading
          x={ANCHOR.battery.x}
          y={ANCHOR.battery.y}
          labelY={904}
          value={hasBattery ? `${battery?.soc ?? 0}%` : '—'}
          caption="BATTERY"
          tone={hasBattery ? 'live' : 'unknown'}
        />
        <Reading
          x={ANCHOR.grid.x}
          y={ANCHOR.grid.y}
          labelY={904}
          value="—"
          caption="GRID"
          tone="unknown"
        />
      </Box>
      {/*
        Says plainly why three readings are blank, and what would fill them. Without
        this the dashes read as a bug rather than as a missing sensor.
      */}
      <Typography
        variant="caption"
        color="text.disabled"
        sx={{ display: 'block', textAlign: 'center', mt: 1 }}
      >
        Home and grid need a whole-home meter · battery not installed
      </Typography>
    </Box>
  );
}
