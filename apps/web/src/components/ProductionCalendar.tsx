import { ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { DailyEnergy } from '../api';
import { Chart } from '../charts/Chart';
import { calendarOption, calendarRange, cellColor, summarise } from '../charts/calendar';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * Daily production as a grid, with the same days available as a table.
 *
 * The table is not a fallback for a broken chart — it is the only version of this that
 * carries values rather than shades. A continuous colour scale encodes magnitude and
 * nothing else: you cannot read 43.2 kWh off a green square, and a reader who cannot
 * separate the hues reads nothing at all. Both views come from one array, so they cannot
 * disagree.
 */

const shortDate = (iso: string): string =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

/** The grid's twin: every day, with its number, sorted heaviest first. */
function ProductionTable({ days }: { days: DailyEnergy[] }): ReactElement {
  const peak = Math.max(...days.map((d) => d.energyWh), 1) / 1000;
  const rows = [...days]
    .filter((day) => day.energyWh > 0)
    .sort((a, b) => b.energyWh - a.energyWh);
  return (
    <Box
      component="table"
      sx={{
        width: '100%',
        borderCollapse: 'collapse',
        mt: 2,
        display: 'block',
        maxHeight: 360,
        overflowY: 'auto',
        // Wide content scrolls inside its own box rather than pushing the card sideways.
        overflowX: 'auto',
      }}
    >
      <Box component="thead" sx={{ position: 'sticky', top: 0, bgcolor: solar.surface.card }}>
        <Box component="tr">
          {['Day', 'Produced', ''].map((head) => (
            <Box
              component="th"
              key={head || 'swatch'}
              sx={{
                textAlign: head === 'Produced' ? 'right' : 'left',
                font: `600 11px/1 ${solar.font.sans}`,
                color: solar.ink.dim,
                py: 1,
                px: 1,
                borderBottom: '1px solid',
                borderColor: solar.surface.border,
              }}
            >
              {head}
            </Box>
          ))}
        </Box>
      </Box>
      <Box component="tbody">
        {rows.map((day) => (
          <Box component="tr" key={day.date}>
            <Box
              component="td"
              sx={{ py: '5px', px: 1, font: `400 12px/1 ${solar.font.sans}`, color: solar.ink.sec }}
            >
              {shortDate(day.date)}
            </Box>
            <Box
              component="td"
              sx={{
                py: '5px',
                px: 1,
                textAlign: 'right',
                font: `400 12px/1 ${solar.font.mono}`,
                color: solar.ink.pri,
              }}
            >
              {(day.energyWh / 1000).toFixed(1)} kWh
            </Box>
            {/* The same colour the grid would paint, so the two views are one thing. */}
            <Box component="td" sx={{ py: '5px', px: 1, width: 28 }}>
              <Box
                sx={{
                  width: 12,
                  height: 12,
                  borderRadius: '2px',
                  bgcolor: cellColor(day.energyWh / 1000, peak),
                }}
              />
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export function ProductionCalendar({ days }: { days: DailyEnergy[] | null }): ReactElement | null {
  const [asTable, setAsTable] = useState(false);
  if (!days || days.length === 0) return null;

  const option = calendarOption(days);
  const stats = summarise(days);
  const span = calendarRange(days);
  if (!option || !span) return null;

  /*
    Named from the data rather than from the range selector, and certainly not "this year".
    An array three weeks old under a 12-month selector has three weeks of days, and a
    heading claiming a year over thirteen squares invites the reader to conclude the other
    eleven months produced nothing.
  */
  const title = `Day by day · ${shortDate(span[0])} to ${shortDate(span[1])}`;

  return (
    <Surface title={title}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        One square per day, darker for more. Over a long enough window the seasonal arc, the
        weeks under snow and the days something was wrong all show up as shape rather than
        as a line to read.
      </Typography>

      {asTable ? (
        <ProductionTable days={days} />
      ) : (
        // Height covers the tallest a year gets: 53 week-columns at 14px plus labels.
        <Chart option={option} height={190} />
      )}

      {/*
        The facts the ramp cannot state, in text, in both views. A tooltip is an
        enhancement; it must never be the only way to reach a value.
      */}
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2 }}>
        {stats.producingDays} producing day{stats.producingDays === 1 ? '' : 's'} ·{' '}
        {Math.round(stats.totalKwh).toLocaleString('en-CA')} kWh in total · a middling day is{' '}
        {stats.medianKwh.toFixed(1)} kWh
        {stats.bestDate && (
          <>
            {' '}
            · best was {shortDate(stats.bestDate)} at {stats.bestKwh.toFixed(1)} kWh
          </>
        )}
      </Typography>

      <Link
        component="button"
        type="button"
        onClick={() => setAsTable((v) => !v)}
        underline="hover"
        sx={{
          font: `600 12.5px/1 ${solar.font.sans}`,
          color: solar.accent.link,
          mt: 2,
          display: 'inline-block',
        }}
      >
        {asTable ? 'Show the calendar' : 'Show as a table'}
      </Link>
    </Surface>
  );
}
