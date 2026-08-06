import { ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import {
  fetchChargeSessions,
  fetchEnergyHistory,
  fetchProductionAnalytics,
  fetchRecords,
  fetchTempPower,
  fetchVoltagePower,
  fetchWeatherHistory,
  usePolling,
} from '../api';
import { ProductionCalendar } from '../components/ProductionCalendar';
import { ProductionCompare } from '../components/ProductionCompare';
import { RecordsSection } from '../components/RecordsSection';
import { Chart } from '../charts/Chart';
import { basePreset, powerSeries } from '../charts/preset';
import { Metric, Surface } from '../components/Surface';
import { RadarPanel } from '../components/RadarPanel';
import { solar } from '../theme';

const SLOW_POLL_MS = 5 * 60_000;
const RANGES: Record<string, number> = { '30 d': 30, '90 d': 90, '12 mo': 366 };

/**
 * A range is only offered once there is history that reaches into it.
 *
 * Otherwise all three buttons return the same rows and the selector looks broken, because
 * functionally it is: on an install with a fortnight of data, 30 days, 90 days and a year
 * are the same fortnight. Clicking did fire the refetch and redraw the identical chart,
 * which is the most confusing possible outcome — the control responds and nothing happens.
 *
 * The shortest range stays available always, so there is never nothing to click.
 */
export function rangeAvailable(key: string, daysCollecting: number | null): boolean {
  const shortest = Math.min(...Object.values(RANGES));
  if (RANGES[key] === shortest) return true;
  if (daysCollecting === null) return true; // Not known yet — do not disable on a guess.
  return daysCollecting > shortest;
}

export function TrendsPage(): ReactElement {
  const [range, setRange] = useState('30 d');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const days = RANGES[range];
  const { data: analytics } = usePolling(() => fetchProductionAnalytics(24), SLOW_POLL_MS);
  const { data: weatherHistory } = usePolling(() => fetchWeatherHistory(24), SLOW_POLL_MS);
  const { data: scatter } = usePolling(() => fetchTempPower(24 * 7), SLOW_POLL_MS);
  const { data: voltage } = usePolling(() => fetchVoltagePower(24 * 7), SLOW_POLL_MS);
  // Keyed on `days`: the range toggle above this chart did nothing until the next poll.
  const { data: charging } = usePolling(() => fetchChargeSessions(days), SLOW_POLL_MS, days);
  const { data: records } = usePolling(fetchRecords, SLOW_POLL_MS);
  // Keyed on `days` so the range toggle actually re-fetches — see fetchChargeSessions above.
  const { data: calendar } = usePolling(() => fetchEnergyHistory(days), SLOW_POLL_MS, days);

  const preset = basePreset();

  const expectedActualOption = {
    ...preset,
    series: powerSeries(
      (analytics?.points ?? []).map((p) => [p.t, p.actualW]),
      (analytics?.points ?? []).map((p) => [p.t, p.expectedW]),
    ),
  };

  const irradianceOption = {
    ...preset,
    series: [
      {
        type: 'line' as const,
        data: (weatherHistory ?? []).map((p) => [p.t, p.irradiance]),
        showSymbol: false,
        lineStyle: { color: solar.series.irradiance, width: 1.8 },
      },
    ],
  };

  /*
    Cloud, on the same clock as irradiance rather than on the same axis.

    Two measures of different scale never share a y-axis — that is the commonest chart
    mistake there is, and it invites the reader to compare a percentage against watts per
    square metre by height. Stacked panels over one time range say the same thing without
    the invitation.

    Drawn downward, because that is the direction it acts: the deeper the shape, the less
    of the sky was available. Plotted the usual way round, a cloudy afternoon looks like a
    peak, which is exactly backwards from what it did to your roof.
  */
  const cloudOption = {
    ...preset,
    grid: { left: 46, right: 16, top: 12, bottom: 24, containLabel: false },
    yAxis: {
      type: 'value' as const,
      min: 0,
      max: 100,
      inverse: true,
      axisLine: { show: false },
      axisTick: { show: false },
      splitNumber: 2,
      splitLine: { lineStyle: { color: solar.grid.line, width: 1 } },
      axisLabel: {
        color: solar.ink.dim,
        fontSize: 10,
        margin: 10,
        formatter: (v: number) => `${v}%`,
      },
    },
    series: [
      {
        type: 'line' as const,
        data: (weatherHistory ?? []).map((p) => [p.t, p.cloudCover]),
        showSymbol: false,
        lineStyle: { color: solar.series.irradiance, width: 1.2, opacity: 0.7 },
        areaStyle: { color: solar.series.irradiance, opacity: 0.18 },
      },
    ],
  };

  const scatterOption = {
    ...preset,
    xAxis: {
      type: 'value' as const,
      name: '°C',
      min: 'dataMin' as const,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: solar.grid.line } },
      axisLabel: { color: solar.ink.dim, fontSize: 10 },
    },
    tooltip: { ...(preset.tooltip as object), trigger: 'item' as const },
    series: [
      {
        type: 'scatter' as const,
        symbolSize: 4,
        itemStyle: { color: solar.series.production, opacity: 0.35 },
        data: (scatter ?? []).map((p) => [p.temperature, p.powerW]),
      },
    ],
  };

  const voltageOption = {
    ...preset,
    xAxis: {
      type: 'value' as const,
      name: 'V',
      min: 'dataMin' as const,
      max: 'dataMax' as const,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: solar.grid.line } },
      axisLabel: { color: solar.ink.dim, fontSize: 10 },
    },
    tooltip: { ...(preset.tooltip as object), trigger: 'item' as const },
    series: [
      {
        type: 'scatter' as const,
        symbolSize: 4,
        itemStyle: { color: solar.series.irradiance, opacity: 0.35 },
        data: (voltage ?? []).map((p) => [p.voltage, p.powerW]),
      },
    ],
  };

  // Only compare points where an expected value exists — see OverviewPage for why.
  const pairedPoints = (analytics?.points ?? []).filter((p) => p.expectedW !== null && p.expectedW > 0);
  const todayPct = pairedPoints.length
    ? (() => {
        const act = pairedPoints.reduce((a, p) => a + p.actualW, 0);
        const exp = pairedPoints.reduce((a, p) => a + (p.expectedW ?? 0), 0);
        return exp > 0 ? Math.round((act / exp) * 100) : null;
      })()
    : null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {/*
          Scoped in the label, because it does not govern the whole page.

          It reached exactly one panel out of six — and not the chart directly beneath it,
          which is what anyone clicking it is looking at. Production now honours it too, but
          the rest are fixed-window by design: expected-vs-actual and irradiance are a
          24-hour pair, the scatters need a week to say anything and the API bounds them at
          a month, and records are all-time. Their titles each state their own window; what
          was missing was this control admitting its reach.
        */}
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={range}
            onChange={(_, value) => value && setRange(value)}
            sx={{ bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: '9px', p: '3px', gap: '2px' }}
          >
            {Object.keys(RANGES).map((key) => (
              <ToggleButton
                key={key}
                value={key}
                disabled={!rangeAvailable(key, records?.daysCollecting ?? null)}
              >
                {key}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.disabled">
            {/*
              Says why the longer ranges are greyed out, rather than leaving somebody to
              conclude the buttons are broken. They light up on their own as history builds.
            */}
            {records && records.daysCollecting <= Math.min(...Object.values(RANGES))
              ? `${records.daysCollecting} days recorded so far${records.firstDate ? `, from ${records.firstDate}` : ''} — longer ranges open up as that grows`
              : 'production and EV charging · other panels state their own window'}
          </Typography>
        </Box>
        <Typography variant="caption" color="text.disabled">
          <Link href="/api/export/daily.csv" download underline="hover">
            daily CSV
          </Link>
          {' · '}
          <Link href="/api/export/readings.csv" download underline="hover">
            raw CSV
          </Link>
        </Typography>
      </Box>

      {/*
        Replaces a fixed daily bar chart of the last N days. Same shape, but the period is
        selectable and a part-period is drawn as one — the old chart put a three-day August
        beside a nine-day July with nothing to say they were different kinds of bar.
      */}
      <ProductionCompare days={days} />

      {/*
        Placed under the period comparison because it answers the question that one raises.
        The bars say this month beat last; the grid says which days did it, and shows the
        week nothing happened that a monthly total quietly absorbs.

        Scoped to the range selector above like everything else on this page — a filter
        that governs some charts and not others is worse than no filter.
      */}
      <ProductionCalendar days={calendar} />

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 5 }}>
        <Surface
          title={
            <Box>
              <Typography variant="subtitle1">Expected vs actual · last 24 h</Typography>
              {todayPct !== null && (
                <Typography variant="caption" color="text.disabled">
                  {todayPct}% of what the sky offered
                </Typography>
              )}
            </Box>
          }
        >
          <Chart option={expectedActualOption} height={180} />
        </Surface>
        <Surface
          title={
            <Box>
              <Typography variant="subtitle1">Irradiance · W/m²</Typography>
              <Typography variant="caption" color="text.disabled">
                measured at the array's coordinates
              </Typography>
            </Box>
          }
        >
          <Chart option={irradianceOption} height={140} />
          {/*
            Beneath, sharing the time range. What the sky offered above, and what was in
            the way below — the second explains the first without competing with it.
          */}
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2 }}>
            Cloud cover · deeper is more
          </Typography>
          <Chart option={cloudOption} height={90} />
        </Surface>
        {/*
          Beside the two charts it explains: irradiance says the sky closed in, cloud says how
          much, radar says what it was. Renders nothing when switched off, which is the
          default — a panel explaining an absent feature is worse than the absence.
        */}
        <RadarPanel />
      </Box>

      {/* forecast + EV self-consumption — the homeowner-facing view */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 300px' }, gap: 5 }}>
        <Surface
          title={
            <Box>
              <Typography variant="subtitle1">EV charging vs solar</Typography>
              <Typography variant="caption" color="text.disabled">
                overlap of charge draw and concurrent production
              </Typography>
            </Box>
          }
          action={
            charging && charging.totals.energyWh > 0 ? (
              <Typography variant="mono" sx={{ color: solar.series.production }}>
                {charging.totals.solarPct}% solar overall
              </Typography>
            ) : undefined
          }
        >
          {!charging || charging.sessions.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No charging sessions recorded yet — tracking started when the Wall Connector was
              connected. Plug in and this fills itself in: per-session kWh, the share drawn while
              the roof was producing, and the running total.
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {charging.sessions.slice(0, 8).map((session) => (
                <Box
                  key={session.startedAt}
                  sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}
                >
                  <Typography variant="mono" sx={{ color: 'text.secondary', width: 120 }}>
                    {new Date(session.startedAt).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Typography>
                  <Typography variant="mono" sx={{ width: 74, textAlign: 'right' }}>
                    {(session.energyWh / 1000).toFixed(1)} kWh
                  </Typography>
                  <Box sx={{ flex: 1, minWidth: 80, height: 6, borderRadius: '3px', bgcolor: solar.surface.border, overflow: 'hidden' }}>
                    <Box
                      sx={{
                        width: `${session.solarPct}%`,
                        height: 6,
                        bgcolor: solar.series.production,
                      }}
                    />
                  </Box>
                  <Typography variant="mono" sx={{ width: 64, textAlign: 'right', color: solar.series.production }}>
                    {session.solarPct}% ☀
                  </Typography>
                </Box>
              ))}
              <Typography variant="caption" color="text.disabled" sx={{ mt: 1 }}>
                {(charging.totals.energyWh / 1000).toFixed(1)} kWh charged ·{' '}
                {(charging.totals.solarWh / 1000).toFixed(1)} kWh while the sun was paying for it.
                Solar share is the production/draw overlap (house loads aren't metered).
              </Typography>
            </Box>
          )}
        </Surface>
        <Surface title="Tomorrow">
          <Metric
            value={analytics?.tomorrowForecastWh != null ? (analytics.tomorrowForecastWh / 1000).toFixed(0) : '—'}
            unit="kWh est."
          />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            Open-Meteo irradiance forecast × the system's learned response
            {analytics?.wattsPerIrradiance
              ? ` (${analytics.wattsPerIrradiance.toFixed(1)} W per W/m²)`
              : ''}
            .
          </Typography>
        </Surface>
      </Box>

      {/* engineer-grade analytics — collapsed by default */}
      <Box>
        <Link
          component="button"
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          underline="hover"
          sx={{ fontWeight: 500, fontSize: 12, lineHeight: 1, color: 'text.secondary' }}
        >
          {showAdvanced ? 'Hide advanced analytics' : 'Advanced analytics — temperature & voltage'}
        </Link>
      </Box>
      <Collapse in={showAdvanced}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 5 }}>
          <Surface
            title={
              <Box>
                <Typography variant="subtitle1">Inverter temp vs output · 7 days</Typography>
                <Typography variant="caption" color="text.disabled">
                  thermal derating appears as data accumulates
                </Typography>
              </Box>
            }
          >
            <Chart option={scatterOption} height={200} />
          </Surface>
          <Surface
            title={
              <Box>
                <Typography variant="subtitle1">Grid voltage vs output · 7 days</Typography>
                <Typography variant="caption" color="text.disabled">
                  line voltage rises with export; near the ceiling, inverters curtail
                </Typography>
              </Box>
            }
          >
            <Chart option={voltageOption} height={200} />
          </Surface>
        </Box>
      </Collapse>

      <Typography variant="overline" color="text.disabled" sx={{ mt: 2 }}>
        Records &amp; milestones
      </Typography>
      <RecordsSection records={records} />
    </Box>
  );
}
