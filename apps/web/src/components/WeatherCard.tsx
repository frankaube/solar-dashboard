import { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Weather } from '../api';
import { Surface } from './Surface';
import { SkyKind, readSky, solarOutlook } from './weatherCodes';
import { solar } from '../theme';

/** Sun, cloud and precipitation glyphs — one shape per SkyKind. */
function SkyIcon({ kind, size = 34 }: { kind: SkyKind; size?: number }): ReactElement {
  const sun = solar.series.production;
  const cloud = '#9aa4b2';
  const wet = '#8ba9d6';
  const common = { width: size, height: size, viewBox: '0 0 40 40', 'aria-hidden': true } as const;

  if (kind === 'clear') {
    return (
      <svg {...common}>
        <circle cx="20" cy="20" r="8" fill={sun} />
        <g stroke={sun} strokeWidth="2.4" strokeLinecap="round">
          <path d="M20 3v5M20 32v5M3 20h5M32 20h5M8 8l3.5 3.5M28.5 28.5L32 32M32 8l-3.5 3.5M11.5 28.5L8 32" />
        </g>
      </svg>
    );
  }
  const cloudPath = (
    <path
      d="M12.5 30h15a6.5 6.5 0 0 0 .6-12.97A9 9 0 0 0 11 19.2 5.6 5.6 0 0 0 12.5 30z"
      fill={cloud}
    />
  );
  if (kind === 'partly') {
    return (
      <svg {...common}>
        <circle cx="26" cy="14" r="6" fill={sun} />
        <g stroke={sun} strokeWidth="2" strokeLinecap="round">
          <path d="M26 2v3.5M36.5 14H34M33.5 6.5L31.6 8.4" />
        </g>
        {cloudPath}
      </svg>
    );
  }
  if (kind === 'fog') {
    return (
      <svg {...common}>
        {cloudPath}
        <g stroke={cloud} strokeWidth="2.4" strokeLinecap="round" opacity="0.75">
          <path d="M8 34h24M12 38h16" />
        </g>
      </svg>
    );
  }
  if (kind === 'snow') {
    return (
      <svg {...common}>
        {cloudPath}
        <g stroke={wet} strokeWidth="2.2" strokeLinecap="round">
          <path d="M15 34l0 4M13 36l4 0M25 34l0 4M23 36l4 0" />
        </g>
      </svg>
    );
  }
  if (kind === 'storm') {
    return (
      <svg {...common}>
        {cloudPath}
        <path d="M21 32l-5 6h4l-2 5 6-7h-4l2-4z" fill={sun} />
      </svg>
    );
  }
  // drizzle | rain | anything unsettled
  const drops = kind === 'drizzle' ? [16, 24] : [13, 20, 27];
  return (
    <svg {...common}>
      {cloudPath}
      <g stroke={wet} strokeWidth="2.4" strokeLinecap="round">
        {drops.map((x) => (
          <path key={x} d={`M${x} 33l-1.5 5`} />
        ))}
      </g>
    </svg>
  );
}

const dayName = (iso: string): string =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });

const clockOf = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

/**
 * Current conditions plus a three-day outlook. Framed for a solar owner: the sky
 * matters because of what it means for production, so each day carries a plain
 * "strong sun / little sun" read rather than only an icon.
 */
export function WeatherCard({ weather }: { weather: Weather | null }): ReactElement {
  const current = weather?.current ?? null;
  const days = weather?.forecast ?? [];
  const today = days[0];
  const ahead = days.slice(1, 4);
  const sky = readSky(current?.weatherCode ?? today?.weatherCode);

  return (
    <Surface title="Weather" sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {!current && !today ? (
        <Typography variant="body2" color="text.secondary">
          Waiting for the first forecast.
        </Typography>
      ) : (
        <>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4 }}>
            <Box sx={{ minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
                <Typography variant="metricHero" sx={{ fontSize: 52 }}>
                  {current ? Math.round(current.temperature) : Math.round(today?.tempMax ?? 0)}
                </Typography>
                <Typography sx={{ font: `500 20px/1 ${solar.font.sans}`, color: solar.ink.sec }}>
                  °C
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                  {sky.label}
                </Typography>
              </Box>
              {today && (
                <Typography variant="mono" sx={{ color: solar.ink.dim, mt: 2, display: 'block' }}>
                  {Math.round(today.tempMin)} ~ {Math.round(today.tempMax)}°C
                  {today.sunrise ? `   ↑ ${clockOf(today.sunrise)}` : ''}
                  {today.sunset ? `   ↓ ${clockOf(today.sunset)}` : ''}
                </Typography>
              )}
            </Box>
            <Box sx={{ textAlign: 'center', flex: '0 0 auto' }}>
              <SkyIcon kind={sky.kind} size={40} />
              <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
                {solarOutlook(sky.kind)}
              </Typography>
            </Box>
          </Box>

          {ahead.length > 0 && (
            <>
              <Box sx={{ height: '1px', bgcolor: solar.surface.border }} />
              <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${ahead.length}, 1fr)`, gap: 3 }}>
                {ahead.map((day) => {
                  const s = readSky(day.weatherCode);
                  return (
                    <Box key={day.date} sx={{ textAlign: 'center' }}>
                      <Typography variant="overline" color="text.disabled" sx={{ display: 'block', mb: 2 }}>
                        {dayName(day.date)}
                      </Typography>
                      <SkyIcon kind={s.kind} size={30} />
                      <Typography variant="mono" sx={{ display: 'block', mt: 2, color: solar.ink.sec }}>
                        {Math.round(day.tempMax)}° / {Math.round(day.tempMin)}°
                      </Typography>
                      <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                        {solarOutlook(s.kind)}
                      </Typography>
                    </Box>
                  );
                })}
              </Box>
            </>
          )}
        </>
      )}
    </Surface>
  );
}
