import { ReactElement, useId } from 'react';
import Box from '@mui/material/Box';
import { usePrefersReducedMotion } from '../shell/motion';
import { solar } from '../theme';

/**
 * Energy moving right along the bottom edge of the hero card.
 *
 * Chevrons run the whole width and the percentage is read off where they stop being bright,
 * not off where they stop — a strip ending at the fill is a two-chevron stub at eight
 * percent.
 *
 * The brightness boundary carries the percentage; the speed deliberately does not, varying
 * less than two-fold across the whole range. Numbers below were tuned by eye against the
 * real card.
 */

/** Opacity of the chevrons up to the line. */
const BRIGHT = 0.63;
/** And past it — enough to read as continuation, faint enough that the line is obvious. */
const DIM = 0.12;
/** Seconds for one pattern cycle at full output. Slower as the roof does less. */
const TOP_SECONDS = 9.6;
const STROKE = 2.6;

const HEIGHT = 20;
const MID = HEIGHT / 2;
/** Chevron half-height and how far its point reaches. */
const ARM = 5.5;
/** Spacing between chevrons, and the distance the pattern travels before repeating. */
const GAP = 16;
const CYCLE = 96;
/**
 * How far the pattern is drawn, in pixels — there is no viewBox, see the note on the svg
 * element, so the run is drawn out to the widest card this can sit on. AppShell caps content
 * at 1368px and the hero sits inside that; anything past it is drawn for nobody.
 */
const WIDTH = 1500;
/** Below this the strip says nothing worth the motion. */
const MIN_PCT = 2;

function chevrons(opacity: number): ReactElement[] {
  const marks: ReactElement[] = [];
  // From one cycle left of zero, so travelling right never exposes a gap at the leading edge.
  for (let x = -CYCLE; x <= WIDTH + CYCLE; x += GAP) {
    marks.push(
      <path
        key={x}
        d={`M${x},${MID - ARM} L${x + ARM},${MID} L${x},${MID + ARM}`}
        fill="none"
        stroke={solar.ramp.energy[1]}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={opacity}
      />,
    );
  }
  return marks;
}

export function FlowStrip({ pct }: { pct: number }): ReactElement | null {
  const reducedMotion = usePrefersReducedMotion();
  const id = useId().replace(/:/g, '');
  const share = Math.min(1, Math.max(0, pct / 100));

  if (pct < MIN_PCT) return null;

  const seconds = TOP_SECONDS * (1.9 - share * 0.9);

  return (
    <Box
      component="svg"
      /*
        No viewBox, deliberately, so one unit is one pixel at every width. With one plus
        preserveAspectRatio="none" the drawing stretches to the card — on a phone that is a
        0.24 scale, which compresses the chevrons into near-vertical ticks and kills the
        direction cue. The percentage still works because the clip is a percentage of the
        element rather than in drawing units.
      */
      role="img"
      aria-label={`${Math.round(pct)}% of the roof's capacity in use`}
      sx={{
        display: 'block',
        height: HEIGHT,
        // Flush to the card's edges: the hero pads by 7 units at 4px, so the bleed is 28px.
        // Pulled from the same numbers so a padding change cannot leave a gap.
        mx: -7,
        mb: -7,
        width: 'calc(100% + 56px)',
        // The card's own corners: bled to the edges, a square-cornered strip paints outside
        // the hero's 22px radius and shows two hard notches.
        borderBottomLeftRadius: `${solar.radius.hero}px`,
        borderBottomRightRadius: `${solar.radius.hero}px`,
        overflow: 'hidden',
        '& .flowScroll': reducedMotion
          ? {}
          : {
              animation: `flowStripMarch ${seconds.toFixed(2)}s linear infinite`,
            },
        '@keyframes flowStripMarch': {
          // Negative to zero: every chevron moves RIGHT. Reversed, the pattern travels left
          // while the chevrons point right.
          from: { transform: `translateX(-${CYCLE}px)` },
          to: { transform: 'translateX(0)' },
        },
      }}
    >
      <defs>
        <clipPath id={`${id}-used`}>
          {/*
            A percentage, so the line lands on the right pixel at any width. Not
            objectBoundingBox units, which would measure against the chevron run's own bounding
            box — two thousand pixels of pattern, most of it off-screen — and put the boundary
            somewhere with no meaning.
          */}
          <rect x="0" y="0" width={`${(share * 100).toFixed(3)}%`} height={HEIGHT} />
        </clipPath>
        <linearGradient id={`${id}-glow`} x1="0" x2="1">
          <stop offset="0" stopColor={solar.ramp.energy[1]} stopOpacity={0} />
          {/* Scaled to the strip's own brightness, so a dim strip never carries a bright band. */}
          <stop offset="0.5" stopColor={solar.ramp.energy[1]} stopOpacity={BRIGHT * 0.5} />
          <stop offset="1" stopColor={solar.ramp.energy[1]} stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* The faint continuation, full width. */}
      <g className="flowScroll">{chevrons(DIM)}</g>
      {/* The bright part, cut at the percentage. */}
      <g clipPath={`url(#${id}-used)`}>
        <g className="flowScroll">{chevrons(BRIGHT)}</g>
      </g>
      {/*
        The sweep, kept inside the used portion. Crossing the line softened exactly the edge
        that carries the number, which is the one thing this strip has to say clearly.
      */}
      {!reducedMotion && (
        <g clipPath={`url(#${id}-used)`}>
          <rect y="0" width={WIDTH} height={HEIGHT} fill={`url(#${id}-glow)`}>
            <animate
              attributeName="x"
              from={-WIDTH}
              to={WIDTH}
              dur={`${(seconds * 2.4).toFixed(2)}s`}
              repeatCount="indefinite"
            />
          </rect>
        </g>
      )}
    </Box>
  );
}
