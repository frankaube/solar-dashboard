import { ReactElement, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Link } from 'react-router-dom';
import {
  GeographyLine,
  RADAR_CACHE_MS,
  RadarStatus,
  SiteLocation,
  fetchRadarGeography,
  fetchRadarStatus,
  fetchSiteLocation,
  radarImageUrl,
} from '../api';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * Where the rain is, beside what the sky offered.
 *
 * The sharper question on this page and a smaller one: production fell off a cliff at two
 * and expected-versus-actual says so without saying why. A cell went over.
 *
 * One image rather than a map. A slippy map means a tile library, pan and zoom state, and a
 * browser talking to a third party on every drag, to answer what a single square answers.
 *
 * Renders nothing at all when it is switched off, which is the default. An empty panel
 * explaining an absent feature is worse than the absence — this page has six charts on it
 * already, and a seventh box saying "not enabled" is noise on every visit forever.
 */

const SOURCE_NAMES: Record<string, string> = {
  eccc: 'Environment and Climate Change Canada',
  rainviewer: 'RainViewer',
};

/** Matches SPAN_DEG on the server: the picture covers this many degrees each way. */
const SPAN_DEG = 1.5;
/** Kilometres per degree of latitude. Near enough constant everywhere. */
const KM_PER_DEG = 111.32;
/** Rings to draw, in kilometres from the array. */
const RING_KM = [50, 100];

/**
 * Ring radii in viewBox units, corrected for the projection.
 *
 * The bounding box is square in *degrees* and the image is square in pixels, so away from
 * the equator the picture is stretched east-west: at 46°N the same pixel distance is about
 * 116 km across and 167 km up. Drawing a circle and calling it 100 km would be wrong by
 * nearly half in one axis — the kind of quiet inaccuracy that is worse than no ring at all,
 * because it looks authoritative. So these are ellipses, and the numbers on them are true.
 */
function ringRadii(latitude: number, km: number): { rx: number; ry: number } {
  const halfHeightKm = SPAN_DEG * KM_PER_DEG;
  const halfWidthKm = SPAN_DEG * KM_PER_DEG * Math.cos((latitude * Math.PI) / 180);
  // 50 viewBox units from centre to edge.
  return { rx: (km / halfWidthKm) * 50, ry: (km / halfHeightKm) * 50 };
}

/** Normalised coordinates into the overlay's 0–100 viewBox. */
function pointsOf(points: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < points.length; i += 2) {
    out.push(`${(points[i] * 100).toFixed(2)},${(points[i + 1] * 100).toFixed(2)}`);
  }
  return out.join(' ');
}

export function RadarPanel(): ReactElement | null {
  const [status, setStatus] = useState<RadarStatus | null>(null);
  const [site, setSite] = useState<SiteLocation | null>(null);
  const [geography, setGeography] = useState<GeographyLine[]>([]);
  const [url, setUrl] = useState(() => radarImageUrl());
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    fetchRadarStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
    fetchSiteLocation()
      .then(({ location }) => setSite(location))
      .catch(() => setSite(null));
    /*
      Fetched once. It changes only when the array moves, where the radar changes every few
      minutes — and failing quietly is right: rain on a blank square is worse than rain on a
      coastline, but it is not nothing.
    */
    fetchRadarGeography()
      .then(({ lines }) => setGeography(lines))
      .catch(() => setGeography([]));
  }, []);

  /*
    Re-ask on the same clock the server caches on. Not a poll for its own sake: the picture
    genuinely changes every few minutes, and a radar frame from an hour ago is worse than
    none because it looks current.
  */
  useEffect(() => {
    if (!status?.enabled) return;
    const timer = setInterval(() => {
      setUrl(radarImageUrl());
      setBroken(false);
    }, RADAR_CACHE_MS);
    return () => clearInterval(timer);
  }, [status?.enabled]);

  if (!status?.enabled) return null;

  const trouble = status.error ?? (broken ? 'The picture could not be fetched.' : null);
  const rings = site ? RING_KM.map((km) => ({ km, ...ringRadii(site.latitude, km) })) : [];

  return (
    <Surface
      title={
        <Box>
          <Typography variant="subtitle1">Radar</Typography>
          <Typography variant="caption" color="text.disabled">
            {status.source
              ? `${SOURCE_NAMES[status.source] ?? status.source}, fetched by this machine`
              : 'no location set'}
          </Typography>
        </Box>
      }
    >
      {!status.source ? (
        <Typography variant="body2" color="text.secondary">
          There is nowhere to centre the picture yet.{' '}
          <Link to="/settings/hardware">Set where the panels are</Link>.
        </Typography>
      ) : trouble ? (
        /*
          Said rather than drawn as a broken image. The far end being down is not this
          install's fault and not something to present as one.
        */
        <Typography variant="body2" color="text.secondary">
          {trouble} It will try again in a few minutes.
        </Typography>
      ) : (
        <Box>
          <Box
            sx={{
              position: 'relative',
              width: '100%',
              maxWidth: 512,
              aspectRatio: '1 / 1',
              borderRadius: `${solar.radius.card}px`,
              /*
                The composites are transparent PNGs, so the square needs a backing and an
                edge. Without them, light precipitation over the page background reads as
                nothing — and a clear sky reads as a component that failed to load.
              */
              bgcolor: solar.surface.inset,
              border: '1px solid',
              borderColor: solar.surface.border,
              overflow: 'hidden',
            }}
          >
            {/*
              The ground, underneath the weather.

              Genuinely underneath: the composite is a transparent PNG, so land drawn behind
              it shows through and the rain stays the brightest thing on the square. Drawing
              it on top instead puts hairlines across every cell, which is the wrong way round
              — the geography is there to locate the rain, not to compete with it.
            */}
            <Box
              component="svg"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
              sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
            >
              {geography.map((line, index) => (
                <polyline
                  key={index}
                  points={pointsOf(line.points)}
                  fill="none"
                  stroke={line.kind === 'lake' ? solar.series.production : solar.ink.sec}
                  strokeWidth={line.kind === 'coast' ? 1.2 : 0.9}
                  strokeDasharray={line.kind === 'border' ? '3 2' : undefined}
                  opacity={line.kind === 'coast' ? 0.7 : line.kind === 'country' ? 0.6 : 0.4}
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
            </Box>
            <Box
              component="img"
              src={url}
              alt={`Weather radar centred on the array, from ${SOURCE_NAMES[status.source] ?? status.source}`}
              onError={() => setBroken(true)}
              /*
                Ask again once the picture has actually arrived.

                The frame's time comes from the server's cache, and that cache is empty until
                something requests an image — so status fetched at mount always reported null
                and the timestamp never appeared at all. This is the one moment it is known to
                have changed.
              */
              onLoad={() => {
                fetchRadarStatus()
                  .then(setStatus)
                  .catch(() => undefined);
              }}
              sx={{
                display: 'block',
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
              }}
            />
            {/*
              Distance and the house, on top of both — the two marks that have to stay
              readable through heavy rain rather than being covered by it.
            */}
            <Box
              component="svg"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
              sx={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
              }}
            >
              {rings.map(({ km, rx, ry }) => (
                <ellipse
                  key={km}
                  cx="50"
                  cy="50"
                  rx={rx}
                  ry={ry}
                  fill="none"
                  stroke={solar.ink.faint}
                  strokeWidth="1"
                  opacity={0.45}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {/* The array itself — the only mark on here that is not weather or ground. */}
              <circle
                cx="50"
                cy="50"
                r="1.6"
                fill={solar.series.production}
                stroke={solar.surface.inset}
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </Box>
          </Box>
          {/*
            Says what an empty square means, because most of the time it will be empty and
            empty is the answer that looks like a bug.

            Deliberately not detected. Telling "no rain" from "nothing rendered" would mean
            decoding the PNG and counting opaque pixels, and a caption that is true either
            way costs nothing and cannot itself be wrong.
          */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, mt: 2, flexWrap: 'wrap' }}>
            {/*
              A key, because the colours meant nothing before. Deliberately unlabelled in
              mm/h: the composite's palette is the source's own and this app does not know
              its breakpoints, so naming rates would be inventing precision. Light-to-heavy
              is the whole of what can be said honestly.
            */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Typography variant="caption" color="text.disabled">
                light
              </Typography>
              <Box
                sx={{
                  width: 72,
                  height: 6,
                  borderRadius: '3px',
                  background: 'linear-gradient(90deg,#8fd0f0,#3aa0dc,#2ec27e,#f5c518,#e8623a)',
                }}
              />
              <Typography variant="caption" color="text.disabled">
                heavy
              </Typography>
            </Box>
            {/*
              When the frame is from. It had no time on it at all, and a radar picture
              without one is unreadable even when it is perfect — you cannot tell a cell
              that is arriving from one that left an hour ago.
            */}
            {status.updatedAt && (
              <Typography variant="caption" color="text.disabled">
                as of{' '}
                {new Date(status.updatedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Typography>
            )}
          </Box>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2 }}>
            {rings.length > 0
              ? `Precipitation near the array, marked at centre. Rings are ${RING_KM.join(' and ')} km.
                 An empty square means nothing is falling.`
              : 'Precipitation near the array. An empty square means nothing is falling.'}
          </Typography>
        </Box>
      )}
    </Surface>
  );
}
