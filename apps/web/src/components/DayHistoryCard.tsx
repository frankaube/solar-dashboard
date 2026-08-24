import { ReactElement, useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { DayHistory, fetchDay } from '../api';
import type { SeriesOption } from 'echarts';
import { Chart } from '../charts/Chart';
import { basePreset } from '../charts/preset';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * One day of the roof, pinned to midnight.
 *
 * The chart above this rolls over the last twenty-four hours, which is the right shape for
 * "what is happening now" and the wrong one for "what did the roof do on the fourth". Half
 * of a rolling window is the previous day, so its axis means something different every time
 * it is opened — and it is why laying a comparison over it produced a curve that could never
 * meet the one beside it.
 *
 * Pinned to a date, both problems go. The axis is always midnight to midnight, and the day
 * before drops exactly on top, which is the comparison that was wanted in the first place.
 */

/** Stepping the calendar in the browser, matching what the server does. */
const step = (date: string, days: number): string => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
};

const kwh = (wh: number | null): string => (wh === null ? '—' : `${(wh / 1000).toFixed(2)} kWh`);

/** "Thu 6 Aug" — enough to place the day without the year most people are already in. */
const pretty = (date: string): string => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
};

export function DayHistoryCard({ today }: { today: string }): ReactElement {
  const [date, setDate] = useState(today);
  const [compare, setCompare] = useState(false);
  const [day, setDay] = useState<DayHistory | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchDay(date, compare)
      .then(setDay)
      .catch(() => setDay(null))
      .finally(() => setLoading(false));
  }, [date, compare]);
  useEffect(load, [load]);

  /*
    Navigation stops where the record does, in both directions. Walking past either end
    lands on a day that is empty for a reason nothing on screen explains — which reads as
    the app having lost the data rather than never having had it.
  */
  const canGoBack = day?.earliest ? date > day.earliest : false;
  const canGoForward = day?.latest ? date < day.latest : false;

  const series: SeriesOption[] = [
    ...(day?.previous && day.previous.points.length
      ? [
          {
            name: pretty(day.previous.date),
            type: 'line' as const,
            data: day.previous.points.map((p) => [p.t, p.powerW]),
            showSymbol: false,
            tooltip: { valueFormatter: (v: unknown) => `${(Number(v) / 1000).toFixed(2)} kW` },
            // Quiet and behind: the day being viewed is the subject.
            lineStyle: { color: solar.ink.faint, width: 1.4, type: 'dashed' as const },
            z: 1,
          },
        ]
      : []),
    {
      name: pretty(date),
      type: 'line' as const,
      data: (day?.points ?? []).map((p) => [p.t, p.powerW]),
      showSymbol: false,
      smooth: 0.18,
      tooltip: { valueFormatter: (v: unknown) => `${(Number(v) / 1000).toFixed(2)} kW` },
      lineStyle: { color: solar.series.production, width: 2 },
      z: 2,
      areaStyle: {
        color: {
          type: 'linear' as const,
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(229,165,47,.24)' },
            { offset: 1, color: 'rgba(229,165,47,0)' },
          ],
        },
      },
    },
  ];

  const option = {
    ...basePreset(),
    /*
      The axis is the day, not the data. Fixed from midnight to midnight so a morning-only
      record still draws in its true place on the day rather than being stretched across it
      — which would make every incomplete day look like a full one.
    */
    xAxis: {
      ...(basePreset().xAxis as object),
      type: 'time' as const,
      min: `${date}T00:00:00`,
      max: `${date}T23:59:59`,
    },
    yAxis: {
      ...(basePreset().yAxis as object),
      axisLabel: {
        color: solar.ink.dim,
        fontFamily: 'ui-monospace,Menlo,monospace',
        fontSize: 10,
        formatter: (v: number) => `${v / 1000}`,
      },
    },
    series,
  };

  return (
    <Surface
      title={
        <Box>
          <Typography variant="subtitle1">A day at a time</Typography>
          <Typography variant="caption" color="text.disabled">
            midnight to midnight, so every day is drawn on the same axis
          </Typography>
        </Box>
      }
      action={
        <Typography variant="mono" sx={{ color: solar.ink.sec }}>
          {kwh(day?.energyWh ?? null)}
        </Typography>
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <IconButton
              size="small"
              disabled={!canGoBack}
              onClick={() => setDate(step(date, -1))}
              aria-label="Previous day"
            >
              ‹
            </IconButton>
            <Typography variant="body2" sx={{ minWidth: 110, textAlign: 'center', color: solar.ink.pri }}>
              {pretty(date)}
            </Typography>
            <IconButton
              size="small"
              disabled={!canGoForward}
              onClick={() => setDate(step(date, 1))}
              aria-label="Next day"
            >
              ›
            </IconButton>
          </Box>

          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={compare}
                onChange={(event) => setCompare(event.target.checked)}
                slotProps={{ input: { 'aria-label': 'Compare with the day before' } }}
              />
            }
            label={<Typography variant="body2">Compare with the day before</Typography>}
          />

          {date !== today && (
            <Typography
              component="button"
              variant="caption"
              onClick={() => setDate(today)}
              sx={{
                border: 0,
                background: 'none',
                cursor: 'pointer',
                color: solar.ink.sec,
                textDecoration: 'underline',
                p: 0,
              }}
            >
              back to today
            </Typography>
          )}
        </Box>

        <Chart option={option} height={220} />

        {/*
          Said rather than left to be inferred from a flat line. A day with no readings and a
          day the array made nothing look identical on a chart, and only one of them is about
          the weather.
        */}
        {!loading && day && day.points.length === 0 && (
          <Typography variant="caption" color="text.disabled">
            Nothing was recorded on this day.
          </Typography>
        )}
        {day && day.importedPoints > 0 && (
          <Typography variant="caption" color="text.disabled">
            {day.importedPoints} of these readings were imported from a vendor export rather
            than polled.
          </Typography>
        )}
        {compare && day && !day.previous && (
          <Typography variant="caption" color="text.disabled">
            Nothing was recorded the day before, so there is nothing to compare against.
          </Typography>
        )}
      </Box>
    </Surface>
  );
}
