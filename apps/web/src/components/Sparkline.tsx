import { ReactElement } from 'react';
import Box from '@mui/material/Box';
import { PowerPoint } from '../api';
import { usePrefersReducedMotion } from '../shell/motion';
import { solar } from '../theme';

/**
 * The shape of the last few hours, beside the number for right now.
 *
 * A figure on its own says nothing about direction: 10.7 kW is a fine morning on the way up
 * and a disappointing afternoon on the way down, and the hero tile cannot tell them apart.
 * The full chart on Trends answers it properly; this answers it without leaving the page.
 *
 * Drawn from the same readings the chart uses — no interpolation, no smoothing. The line
 * bends where a sample was taken and nowhere else, so a gap in collection reads as a flat
 * run rather than as an invented curve through it.
 */

const HOURS = 3;
/** Below this there is no shape, only a couple of dots pretending to be a trend. */
const MIN_POINTS = 4;

export function Sparkline({
  history,
  width = 132,
  height = 30,
}: {
  history: PowerPoint[] | null;
  width?: number;
  height?: number;
}): ReactElement | null {
  const reducedMotion = usePrefersReducedMotion();
  const since = Date.now() - HOURS * 3_600_000;
  const points = (history ?? [])
    .filter((p) => Date.parse(p.t) >= since && Number.isFinite(p.powerW))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

  if (points.length < MIN_POINTS) return null;

  const values = points.map((p) => p.powerW);
  const peak = Math.max(...values, 1);
  const first = Date.parse(points[0].t);
  const span = Math.max(1, Date.parse(points[points.length - 1].t) - first);

  const xy = points.map((p) => {
    const x = ((Date.parse(p.t) - first) / span) * width;
    // Scaled to this window's own peak, not to the array's rating: the question is the
    // shape of the morning, and against 23 kW a cloudy day is a flat line at the bottom.
    const y = height - (p.powerW / peak) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = `M ${xy.join(' L ')}`;
  const area = `${line} L ${width},${height} L 0,${height} Z`;
  const last = points[points.length - 1];
  const lastX = width;
  const lastY = height - (last.powerW / peak) * (height - 2) - 1;

  return (
    <Box
      component="svg"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-label={`Output over the last ${HOURS} hours, peaking at ${(peak / 1000).toFixed(1)} kW`}
      sx={{ display: 'block', overflow: 'visible' }}
    >
      <path d={area} fill={solar.series.production} opacity={0.14} />
      <path d={line} fill="none" stroke={solar.series.production} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      {/*
        The head of the trace, pulsing gently — the only part of this that moves, and it
        marks where "now" is rather than decorating the whole line.
      */}
      <circle cx={lastX} cy={lastY} r={2.4} fill={solar.series.production}>
        {!reducedMotion && (
          <animate attributeName="r" values="2.4;3.6;2.4" dur="2.4s" repeatCount="indefinite" />
        )}
      </circle>
    </Box>
  );
}
