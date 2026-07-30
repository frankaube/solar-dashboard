import { ReactElement } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import {
  Alerts,
  DailyEnergy,
  EnergyStats,
  PanelMeta,
  PowerPoint,
  ProductionAnalytics,
  Snapshot,
  Summary,
  Weather,
  fetchBattery,
  fetchCharger,
  fetchEnergyHistory,
  fetchProductionAnalytics,
  fetchStats,
  fetchWeather,
  usePolling,
} from '../api';
import { Chart } from '../charts/Chart';
import { basePreset, powerSeries } from '../charts/preset';
import { EnergyFlow } from '../components/EnergyFlow';
import { Metric, Surface } from '../components/Surface';
import { WeatherCard } from '../components/WeatherCard';
import { solar } from '../theme';

const SLOW_POLL_MS = 5 * 60_000;
const NIGHT_W = 10;

/** Status pill: hue + icon + word — three channels, so greyscale/CVD still read. */
function StatusPill({ tone, children }: { tone: 'ok' | 'warn' | 'unknown'; children: string }): ReactElement {
  const skin =
    tone === 'ok'
      ? { bg: '#1e2f24', border: '#2f5a41', fg: '#7fc79c' }
      : tone === 'warn'
        ? { bg: '#332417', border: '#6b4a24', fg: '#e0a05a' }
        : { bg: '#24211d', border: '#3a352e', fg: '#8a8073' };
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '7px',
        px: '13px',
        py: '7px',
        borderRadius: '999px',
        bgcolor: skin.bg,
        border: `1px solid ${skin.border}`,
        color: skin.fg,
        font: `600 12px/1 ${solar.font.sans}`,
        flex: '0 0 auto',
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.8}>
        {tone === 'ok' ? (
          <path d="M2.5 6.4l2.4 2.4L9.8 3.6" />
        ) : tone === 'warn' ? (
          <>
            <path d="M6 1.8l4.6 8.4H1.4z" />
            <path d="M6 5.2v2.1M6 9h.01" />
          </>
        ) : (
          <>
            <circle cx="6" cy="6" r="4.4" />
            <path d="M6 8.4V5.6M6 3.7h.01" />
          </>
        )}
      </svg>
      {children}
    </Box>
  );
}

/** Join a list in prose: [a] → "a", [a,b] → "a and b", [a,b,c] → "a, b and c". */
function proseList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Compact "where the roof's power is going right now" — the quick read above the full flow. */
function WhereItsGoing({ solarW, evW, batteryW }: { solarW: number; evW: number; batteryW: number }): ReactElement {
  const rest = Math.max(0, solarW - evW - Math.max(0, batteryW));
  const rows = [
    rest > 0 ? { label: 'The house', v: rest, color: solar.series.house } : null,
    evW > 0 ? { label: 'The car', v: evW, color: solar.series.car } : null,
    batteryW > 0 ? { label: 'Battery', v: batteryW, color: solar.series.battery } : null,
    batteryW < 0 ? { label: 'From battery', v: -batteryW, color: solar.series.battery } : null,
  ].filter(Boolean) as Array<{ label: string; v: number; color: string }>;
  const max = Math.max(solarW, ...rows.map((r) => r.v), 1);
  const parts = [
    rest > 0 ? 'the house' : null,
    evW > 0 ? 'the car' : null,
    batteryW > 0 ? 'charging the battery' : null,
  ].filter(Boolean) as string[];
  const sentence =
    solarW < 20
      ? batteryW < 0
        ? 'The battery is covering the house — the roof is resting.'
        : 'The roof is resting for now.'
      : parts.length
        ? `Your roof is powering ${proseList(parts)}.`
        : 'Your roof is producing.';
  return (
    <Surface
      title={
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', width: '100%' }}>
          <Typography variant="subtitle1">Where it&rsquo;s going</Typography>
          <Typography variant="caption" color="text.disabled">right now</Typography>
        </Box>
      }
    >
      <Typography variant="answer" sx={{ fontSize: 15, lineHeight: 1.5, color: solar.ink.sec, display: 'block', mb: 3 }}>
        {sentence}
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '11px' }}>
        {rows.map((r) => (
          <Box key={r.label} sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <Box sx={{ width: 9, height: 9, borderRadius: '3px', flex: '0 0 9px', bgcolor: r.color }} />
            <Typography sx={{ width: 96, flex: '0 0 96px', font: `500 13px/1.3 ${solar.font.sans}`, color: solar.ink.pri }}>
              {r.label}
            </Typography>
            <Box sx={{ flex: 1, height: 10, borderRadius: '3px', bgcolor: solar.surface.inset, overflow: 'hidden' }}>
              <Box sx={{ width: `${(r.v / max) * 100}%`, height: 10, borderRadius: '3px', bgcolor: r.color }} />
            </Box>
            <Typography variant="mono" sx={{ width: 58, textAlign: 'right', color: solar.ink.sec }}>
              {(r.v / 1000).toFixed(1)} kW
            </Typography>
          </Box>
        ))}
      </Box>
    </Surface>
  );
}

interface OverviewPageProps {
  summary: Summary | null;
  history: PowerPoint[] | null;
  alerts: Alerts | null;
}

export function OverviewPage({ summary, history, alerts }: OverviewPageProps): ReactElement {
  const { data: stats } = usePolling<EnergyStats>(fetchStats, SLOW_POLL_MS);
  const { data: analytics } = usePolling<ProductionAnalytics>(
    () => fetchProductionAnalytics(24),
    SLOW_POLL_MS,
  );
  const { data: weather } = usePolling<Weather>(fetchWeather, SLOW_POLL_MS);
  const { data: energy } = usePolling<DailyEnergy[]>(() => fetchEnergyHistory(30), SLOW_POLL_MS);
  const { data: charger } = usePolling(fetchCharger, 60_000);
  const { data: battery } = usePolling(fetchBattery, 60_000);

  const nowW = summary?.currentPowerW ?? 0;
  const night = nowW < NIGHT_W;
  // Rated size comes from the API (owner-configured, else estimated) — it was hardcoded
  // to 21 kW while this array is 24 kW, inflating every capacity reading by ~14%.
  const ratedKw = summary?.ratedKw && summary.ratedKw > 0 ? summary.ratedKw : null;
  const capPct = ratedKw ? Math.min(100, (nowW / 1000 / ratedKw) * 100) : 0;
  const active = alerts?.active ?? [];
  const yesterdayWh = energy && energy.length > 1 ? energy[energy.length - 2].energyWh : null;
  // Energy and its value must describe the SAME day. After midnight "today" is near
  // zero and yesterday's total is the useful number, but the two tiles used to pair
  // "Made yesterday" with "Worth today" — different periods, side by side.
  const showYesterday = night && yesterdayWh !== null && (summary?.todayEnergyWh ?? 0) < yesterdayWh;
  const shownDayLabel = showYesterday ? 'yesterday' : 'today';
  const shownEnergyWh = showYesterday ? (yesterdayWh ?? 0) : (summary?.todayEnergyWh ?? 0);
  const shownWorth = showYesterday
    ? ((yesterdayWh ?? 0) / 1000) * (summary?.pricePerKwh ?? 0)
    : (summary?.todayRevenue ?? 0);
  const evNowW = charger?.live?.charging ? charger.live.powerW : 0;
  const batteryNowW = battery?.present ? (battery.powerW ?? 0) : 0;

  // Actual vs clear-day estimate. Only pairs where BOTH sides exist may be compared —
  // counting actual against a missing expected inflates the ratio into a false all-clear.
  const paired = (analytics?.points ?? []).filter((p) => p.expectedW !== null && p.expectedW > 0);
  const todayPct = paired.length
    ? (() => {
        const a = paired.reduce((s, p) => s + p.actualW, 0);
        const e = paired.reduce((s, p) => s + (p.expectedW ?? 0), 0);
        return e > 0 ? Math.round((a / e) * 100) : null;
      })()
    : null;
  const powerSubtitle =
    todayPct == null
      ? 'actual vs a clear-day estimate'
      : todayPct >= 98
        ? 'Running at or above a clear-day pace.'
        : `About ${100 - todayPct}% under a clear day${todayPct < 85 ? ' — cloudy.' : ' — some cloud.'}`;

  const series = powerSeries(
    (analytics?.points ?? history ?? []).map((p) => [
      p.t,
      'actualW' in p ? (p as { actualW: number }).actualW : (p as PowerPoint).powerW,
    ]),
    (analytics?.points ?? []).map((p) => [p.t, p.expectedW]),
  );
  // Daylight band: shade sunrise→sunset behind the curve.
  const sunrise = weather?.daily?.sunrise?.[0];
  const sunset = weather?.daily?.sunset?.[0];
  if (sunrise && sunset && series[1]) {
    (series[1] as { markArea?: unknown }).markArea = {
      silent: true,
      itemStyle: { color: 'rgba(240,180,41,0.05)' },
      data: [[{ xAxis: sunrise }, { xAxis: sunset }]],
    };
  }
  const chartOption = {
    ...basePreset(),
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

  // One plain-language answer for the hero — folds in status and the sky.
  const cur = weather?.current ?? null;
  const skyPhrase = !cur
    ? ''
    : cur.cloudCover <= 25
      ? 'a bright day'
      : cur.cloudCover <= 60
        ? 'some cloud around'
        : 'overcast, running light';
  // `alerts === null` means "haven't heard back" (usePolling keeps the last good value and
  // swallows errors), which is not the same as "nothing is wrong" — don't claim all-clear.
  const alertsKnown = alerts !== null;
  const answer = !alertsKnown
    ? 'Checking on your system…'
    : active.length
      ? `${active.length} thing${active.length > 1 ? 's' : ''} to look at — details under System.`
      : night
        ? 'Asleep for the night — back at sunrise.'
        : skyPhrase
          ? `Everything’s running normally — ${skyPhrase}.`
          : 'Everything’s running normally.';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {/* HERO — Sunhouse: status pill + serif answer, one 64px number, today's money */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 420px' }, gap: 5 }}>
        {/* No backdrop chart here: it drew the same 24 h curve as the "Power · last
            24 hours" card directly below, stretched full-width behind the text, where
            it read as a muddy wash and could not be hovered or read off. The chart
            below is the graph; the hero is the answer. */}
        <Surface hero sx={{ p: 7, borderRadius: `${solar.radius.hero}px` }}>
          <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
              <StatusPill tone={!alertsKnown ? 'unknown' : active.length ? 'warn' : 'ok'}>
                {!alertsKnown ? 'Checking' : active.length ? 'Needs a look' : 'All good'}
              </StatusPill>
              <Typography variant="answer" component="h2" sx={{ color: 'text.primary' }}>
                {answer}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: { xs: 6, md: 12 }, flexWrap: 'wrap' }}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Typography variant="overline" color="text.disabled">
                  {night ? 'Asleep' : 'Making right now'}
                </Typography>
                <Metric value={(nowW / 1000).toFixed(1)} unit="kW" variant="metricHero" dim={night} />
                {!night && ratedKw && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: '11px', width: 300, maxWidth: '100%' }}>
                    <Box sx={{ flex: 1, height: 5, borderRadius: '3px', bgcolor: solar.surface.border, overflow: 'hidden' }}>
                      <Box sx={{ width: `${capPct}%`, height: 5, borderRadius: '3px', bgcolor: solar.series.production, transition: 'width .4s' }} />
                    </Box>
                    <Typography variant="mono" sx={{ color: 'text.disabled' }}>
                      {capPct.toFixed(0)}% of your {ratedKw.toFixed(0)} kW roof
                    </Typography>
                  </Box>
                )}
              </Box>
              <Box sx={{ width: '1px', height: 74, bgcolor: solar.surface.border, display: { xs: 'none', md: 'block' } }} />
              <Box sx={{ display: 'flex', gap: { xs: 6, md: 10 } }}>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Typography variant="overline" color="text.disabled">
                    Made {shownDayLabel}
                  </Typography>
                  <Metric value={(shownEnergyWh / 1000).toFixed(0)} unit="kWh" variant="metricLg" />
                  <Typography variant="caption" color="text.disabled">
                    {stats ? `peak ${(stats.records.peakPowerW / 1000).toFixed(1)} kW record` : ' '}
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Typography variant="overline" color="text.disabled">
                    Worth {shownDayLabel}
                  </Typography>
                  <Typography variant="metricLg" sx={{ color: solar.series.money }}>
                    ${shownWorth.toFixed(2)}
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    at {((summary?.pricePerKwh ?? 0) * 100).toFixed(1)}¢/kWh
                  </Typography>
                </Box>
              </Box>
            </Box>
          </Box>
        </Surface>

        {/* Paying itself off */}
        <Surface sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <Typography variant="subtitle1">Paying itself off</Typography>
            <Link component={RouterLink} to="/money/savings" sx={{ font: `600 12px/1 ${solar.font.sans}`, color: solar.accent.link }}>
              Money →
            </Link>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
            <Typography variant="metricLg" sx={{ color: solar.series.money }}>
              ${(stats?.savings.lifetime ?? 0).toLocaleString('en-CA', { maximumFractionDigits: 0 })}
            </Typography>
            {stats?.systemCostCad ? (
              <Typography variant="body2" color="text.disabled">
                of ${stats.systemCostCad.toLocaleString('en-CA', { maximumFractionDigits: 0 })}
              </Typography>
            ) : null}
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box sx={{ height: 8, borderRadius: '5px', bgcolor: solar.surface.border, overflow: 'hidden' }}>
              <Box sx={{ width: `${Math.min(100, stats?.paybackProgressPct ?? 0)}%`, minWidth: stats?.paybackProgressPct ? 2 : 0, height: 8, bgcolor: solar.status.ok }} />
            </Box>
            <Typography variant="caption" color="text.disabled">
              {stats?.paybackProgressPct != null ? `${stats.paybackProgressPct.toFixed(1)}% paid back` : 'set your system cost in Settings'}
            </Typography>
          </Box>
          <Box sx={{ height: '1px', bgcolor: solar.surface.border }} />
          <Box sx={{ display: 'flex', gap: 8 }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography variant="overline" color="text.disabled">This month</Typography>
              <Typography variant="metricMd">${(stats?.savings.month ?? 0).toFixed(0)}</Typography>
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography variant="overline" color="text.disabled">Lifetime</Typography>
              <Typography variant="metricMd">{((stats?.lifetimeWh ?? 0) / 1_000_000).toFixed(1)} MWh</Typography>
            </Box>
          </Box>
        </Surface>
      </Box>

      {/* Power today + where it's going */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 420px' }, gap: 5 }}>
        <Surface
          title={
            <Box>
              <Typography variant="subtitle1">Power · last 24 hours</Typography>
              <Typography variant="caption" color="text.disabled">{powerSubtitle}</Typography>
            </Box>
          }
          action={
            <Box sx={{ display: 'flex', gap: 4, font: `400 11px/1 ${solar.font.mono}`, color: solar.ink.sec }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Box sx={{ width: 14, height: '2px', bgcolor: solar.series.production }} /> what you made
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Box sx={{ width: 14, borderTop: `2px dashed ${solar.series.expected}` }} /> a clear day
              </Box>
            </Box>
          }
        >
          <Chart option={chartOption} height={230} />
        </Surface>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <WhereItsGoing solarW={nowW} evW={evNowW} batteryW={batteryNowW} />
          <WeatherCard weather={weather ?? null} />
        </Box>
      </Box>

      {/* live flow */}
      <EnergyFlow summary={summary} charger={charger ?? null} battery={battery ?? null} />
    </Box>
  );
}
