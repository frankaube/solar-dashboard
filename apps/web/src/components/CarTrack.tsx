import { ReactElement, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { VehicleTrack } from '../api';
import { boxAroundPoint, scaleFor, tilesFor } from './tileGrid';
import { useThemeMode } from '../shell/ThemeMode';
import { solar } from '../theme';

/*
  The car's journey.

  Street tiles come from this machine, which fetched and cached them — the browser never
  talks to OpenStreetMap. That is also why this is not Google: their terms forbid proxying or
  storing tiles, so the browser would have to talk to them directly, putting a live driving
  position in their logs for the length of every trip. See tiles.service.ts.

  With streets off it falls back to the Natural Earth vectors bundled for the radar, which
  have no roads in them at all — honest, and nearly empty inland. That is what the toggle is
  for, and it is the only explanation the reader needs; how the tiles reach the page is not
  their problem and does not belong on the card.
*/

interface CarTrackProps {
  track: VehicleTrack;
  /** Draw streets under the track. Off unless the owner switched street maps on. */
  streets?: boolean;
}

/** Line weights by what the feature is — a national border outranks a county edge. */
const STROKE: Record<string, { color: string; width: number }> = {
  country: { color: '#4a443c', width: 1.4 },
  border: { color: '#3a352e', width: 1 },
  coast: { color: '#4f4a42', width: 1.2 },
  lake: { color: '#33403f', width: 1 },
};

/**
 * How much ground "around the car" covers.
 *
 * Two kilometres reaches zoom 15, which is where OSM starts labelling streets — the whole
 * reason the mode exists. Framing a 29 km journey lands on zoom 12 and no tile budget can
 * fix that: zoom 15 across 29 km is thousands of tiles.
 */
const SURROUNDINGS_KM = 2;

/*
  The drawn window is wider than the one the server sent.

  boxAround returns a square, which is the honest shape for "fit this journey". The card is
  not square, and a square map inside it either letterboxes — which is what it did, stranding
  the map in the middle of a wide empty card — or squashes the route. Widening the window
  fills the card with more map at the same scale, which costs nothing and shows more.
*/
const ASPECT = 1.9;
const VIEW_W = 1000;
const VIEW_H = Math.round(VIEW_W / ASPECT);

export function CarTrack({ track, streets = false }: CarTrackProps): ReactElement {
  const { points, geography, home } = track;
  const light = useThemeMode().mode === 'light';
  const [frame, setFrame] = useState<'trip' | 'car'>('trip');
  const last = points[points.length - 1];

  /*
    Fall back to the whole trip if the streets are switched off.

    Close in with no tiles under it there is nothing to see at all — Natural Earth has no
    features at two kilometres — so the mode would be a button that blanks the card.
  */
  useEffect(() => {
    if (!streets) setFrame('trip');
  }, [streets]);
  const closeUp = frame === 'car' && streets;

  const baseBox = closeUp ? boxAroundPoint({ lat: last.lat, lon: last.lon }, SURROUNDINGS_KM) : track.box;

  const midLat = (baseBox.minLat + baseBox.maxLat) / 2;
  const midLon = (baseBox.minLon + baseBox.maxLon) / 2;
  const latSpan = baseBox.maxLat - baseBox.minLat;
  // A degree of longitude is shorter than one of latitude, so the widening is per-latitude.
  const shrink = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const lonSpan = (latSpan * ASPECT) / shrink;
  const box = {
    minLat: baseBox.minLat,
    maxLat: baseBox.maxLat,
    minLon: midLon - lonSpan / 2,
    maxLon: midLon + lonSpan / 2,
  };

  const x = (lon: number): number => ((lon - box.minLon) / (box.maxLon - box.minLon)) * VIEW_W;
  const y = (lat: number): number =>
    VIEW_H - ((lat - box.minLat) / (box.maxLat - box.minLat)) * VIEW_H;

  const path = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.lon).toFixed(1)},${y(p.lat).toFixed(1)}`)
    .join('');
  // Measured against the window actually drawn, which is neither the server's box nor fixed.
  const scale = scaleFor(box);
  const barPx = scale.fraction * VIEW_W;

  const minutes = Math.max(0, Math.round((last.at - points[0].at) / 60_000));
  const topSpeed = Math.round(Math.max(0, ...points.map((p) => p.speedKmh ?? 0)));
  const ink = light ? 'rgba(0,0,0,0.62)' : 'rgba(255,255,255,0.6)';

  return (
    <Box sx={{ display: 'flex', gap: 6, alignItems: 'stretch', flexWrap: 'wrap' }}>
      <Box
        sx={{
          position: 'relative',
          flex: '1 1 420px',
          minWidth: 280,
          aspectRatio: `${ASPECT}`,
          borderRadius: `${solar.radius.card}px`,
          overflow: 'hidden',
          bgcolor: solar.surface.inset,
          border: `1px solid ${solar.surface.border}`,
        }}
      >
        {streets &&
          tilesFor(box).map((tile) => (
            <Box
              key={`${tile.z}/${tile.x}/${tile.y}`}
              component="img"
              src={`/api/map/tile/${tile.z}/${tile.x}/${tile.y}.png`}
              alt=""
              aria-hidden
              sx={{
                position: 'absolute',
                left: `${tile.left}%`,
                top: `${tile.top}%`,
                width: `${tile.width}%`,
                height: `${tile.height}%`,
                display: 'block',
                /*
                  Pushed back so the route reads on top. OSM's default style is built to be
                  the whole picture; here it is the background to one. Dark mode wants it
                  darkened and paper wants it lightened — one filter for both turned the light
                  theme to mud.
                */
                filter: light
                  ? 'saturate(0.5) brightness(1.05) contrast(0.9)'
                  : 'saturate(0.5) brightness(0.62) contrast(1.05)',
              }}
            />
          ))}

        {streets && (
          <Box
            sx={{
              position: 'absolute',
              top: 10,
              right: 10,
              zIndex: 1,
              display: 'flex',
              borderRadius: 999,
              overflow: 'hidden',
              border: `1px solid ${solar.surface.border}`,
              bgcolor: light ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.55)',
            }}
          >
            {(['trip', 'car'] as const).map((option) => (
              <Box
                key={option}
                component="button"
                type="button"
                onClick={() => setFrame(option)}
                aria-pressed={frame === option}
                sx={{
                  border: 0,
                  cursor: 'pointer',
                  px: 3,
                  py: 1,
                  font: `600 10px/1.6 ${solar.font.mono}`,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  bgcolor: frame === option ? solar.series.car : 'transparent',
                  color: frame === option ? '#fff' : light ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.75)',
                }}
              >
                {option === 'trip' ? 'Whole trip' : 'Around car'}
              </Box>
            ))}
          </Box>
        )}

        <Box
          component="svg"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={
            track.fromHomeKm !== null
              ? `Car ${track.fromHomeKm} kilometres ${track.bearing} of home`
              : 'Car location'
          }
          sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
        >
          {/*
            Bundled shorelines, only when there are no streets — OSM already draws the coast,
            and two shorelines a pixel apart read as a rendering fault.
          */}
          {!streets &&
            geography.map((line, i) => {
              const stroke = STROKE[line.kind] ?? STROKE.coast;
              const d = line.points
                .reduce<string[]>((acc, value, index) => {
                  if (index % 2) return acc;
                  acc.push(
                    `${index ? 'L' : 'M'}${x(value).toFixed(1)},${y(line.points[index + 1]).toFixed(1)}`,
                  );
                  return acc;
                }, [])
                .join('');
              return (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke={stroke.color}
                  strokeWidth={stroke.width}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

          {/*
            Every stroke below is in SCREEN pixels, via non-scaling-stroke.

            Without it they are viewBox units, and the viewBox is a thousand wide inside a few
            hundred pixels — a width of 2.4 drew at 0.6 px and the route was invisible over the
            map. Which is how it shipped the first time.

            Two passes: a casing in the background colour, then the line. Over a basemap there
            is no single colour that stays legible across grass, water and asphalt, and the
            casing is what makes the route read on all three.
          */}
          <path
            d={path}
            fill="none"
            stroke={light ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.6)'}
            strokeWidth={7}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={path}
            fill="none"
            stroke={solar.series.car}
            strokeWidth={3.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {home && (
            <rect
              x={x(home.lon) - 7}
              y={y(home.lat) - 7}
              width={14}
              height={14}
              rx={3}
              fill={light ? '#fff' : solar.surface.card}
              stroke={solar.series.production}
              strokeWidth={2.5}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* The car last and largest — on a route that doubles back it would otherwise be
              lost inside its own line. */}
          <circle
            cx={x(last.lon)}
            cy={y(last.lat)}
            r={8}
            fill={solar.series.car}
            stroke={light ? '#fff' : solar.surface.inset}
            strokeWidth={3}
            vectorEffect="non-scaling-stroke"
          />

          {scale.km > 0 && (
            <g>
              <line
                x1={14}
                y1={VIEW_H - 12}
                x2={14 + barPx}
                y2={VIEW_H - 12}
                stroke={ink}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
              <text x={14} y={VIEW_H - 20} fill={ink} fontSize={13} fontFamily={solar.font.mono}>
                {scale.km >= 1 ? `${scale.km} km` : `${scale.km * 1000} m`}
              </text>
            </g>
          )}
        </Box>
      </Box>

      <Box sx={{ flex: '0 1 180px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {track.fromHomeKm !== null && (
          <Box>
            <Typography variant="overline" color="text.disabled">From home</Typography>
            <Typography variant="metricMd" sx={{ color: solar.series.car, display: 'block' }}>
              {track.fromHomeKm}
              <Typography component="span" variant="caption" sx={{ ml: 1 }}>
                km {track.bearing}
              </Typography>
            </Typography>
          </Box>
        )}
        <Box sx={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Box>
            <Typography variant="overline" color="text.disabled">Under way</Typography>
            <Typography variant="mono" sx={{ display: 'block', color: 'text.secondary' }}>
              {minutes} min
            </Typography>
          </Box>
          {topSpeed > 0 && (
            <Box>
              <Typography variant="overline" color="text.disabled">Top speed</Typography>
              <Typography variant="mono" sx={{ display: 'block', color: 'text.secondary' }}>
                {topSpeed} km/h
              </Typography>
            </Box>
          )}
        </Box>
        <Box sx={{ flex: 1 }} />
        {/* Required by the licence, and nothing beyond it. */}
        {streets && (
          <Typography variant="mono" sx={{ color: 'text.disabled' }}>
            © OpenStreetMap
          </Typography>
        )}
      </Box>
    </Box>
  );
}
