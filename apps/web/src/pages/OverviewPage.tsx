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
import { FlowStrip } from '../components/FlowStrip';
import { Sparkline } from '../components/Sparkline';
import { Metric, Surface } from '../components/Surface';
import { WeatherCard } from '../components/WeatherCard';
import { solar } from '../theme';

const SLOW_POLL_MS = 5 * 60_000;
const NIGHT_W = 10;

/** Status pill: hue + icon + word — three channels, so greyscale/CVD still read. */
function StatusPill({ tone, children }: { tone: 'ok' | 'warn' | 'unknown'; children: string }): ReactElement {
  const skin =
    tone === 'ok'
      ? { bg: solar.pill.ok.bg, border: solar.pill.ok.border, fg: solar.series.money }
      : tone === 'warn'
        ? { bg: solar.pill.warn.bg, border: solar.pill.warn.border, fg: solar.status.warn }
        : { bg: solar.surface.raised, border: solar.pill.neutral.border, fg: solar.status.info };
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

/**
 * One labelled figure in the hero band: overline, number, reference line.
 *
 * The four of these used to be hand-written four times over, which is how "Made today"
 * ended up with a peak-watts caption under a kWh number. One shape, one place to fix.
 */
function Stat({
  label,
  caption,
  children,
}: {
  label: string;
  caption: string;
  children: ReactElement;
}): ReactElement {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="overline" color="text.disabled">
        {label}
      </Typography>
      {children}
      <Typography variant="caption" color="text.disabled">
        {caption}
      </Typography>
    </Box>
  );
}

/**
 * Dollars, with cents while cents are what there is.
 *
 * Whole dollars are right for a running total and wrong for a small one. On the first of
 * the month "This month" rounded $0.81 up to "$1" while "Worth today" showed "$0.81"
 * directly above it — the same money, in the same band, disagreeing. Under ten dollars the
 * cents are the number.
 */
function money(amount: number): string {
  const decimals = amount < 10 ? 2 : 0;
  return `$${amount.toLocaleString('en-CA', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
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
      {/*
        The caveat follows the number it qualifies. "The house" here is really house plus
        whatever goes to the grid — without a whole-home CT there is no way to split them.
        It used to sit under a separate flow strip at the foot of the page, two cards away
        from the figure it was about.
      */}
      {rest > 0 && (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 4, lineHeight: 1.5 }}>
          House use and grid export merge until a whole-home meter is connected — measured
          flows (production, EV, battery) are exact.
        </Typography>
      )}
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
  /*
    Tomorrow's expected output, and when to plug in for it.

    Both were already on this page — fetchProductionAnalytics returns them — and neither
    was rendered. The weather card meanwhile described tomorrow with a word derived from
    the WMO rain code, which on this very screen read "poor for solar" beside an internally
    computed 81 kWh. A figure from measured irradiance and this array's learned response
    beats an adjective about precipitation.
  */
  const tomorrowDate = (() => {
    const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();
  const tomorrow = analytics?.outlook?.find((day) => day.date === tomorrowDate) ?? null;
  const window = analytics?.chargeWindow ?? null;
  const hourOf = (iso: string): string => iso.slice(11, 16);
  const chargeWindowText = window
    ? `best ${hourOf(window.start)}–${hourOf(window.end)}, about ${window.avgKw} kW`
    : null;

  /*
    What today's total is worth comparing against.

    Yesterday first, because it is the comparison people actually make, and it is only
    honest while the day is still running — after midnight the tile already switches to
    showing yesterday, and captioning yesterday with itself would be absurd. The best day
    is the second reference, and it needs enough history to mean anything: on day two,
    "best" is just "the other day".
  */
  const kwh = (wh: number): string => (wh / 1000).toFixed(wh < 10_000 ? 1 : 0);
  const bestDayWh = stats?.records.bestDayWh ?? 0;
  const enoughHistory = (stats?.records.daysCollecting ?? 0) >= 3;
  const energyCaption =
    [
      !showYesterday && yesterdayWh !== null ? `${kwh(yesterdayWh)} yesterday` : null,
      enoughHistory && bestDayWh > 0 ? `best ${kwh(bestDayWh)}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || ' ';

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
  /*
    Name the problem, do not count it.

    This said "3 things to look at — details under System", which spends the widest strip
    on the page saying nothing you can act on: you cannot tell whether to click. Serious
    outranks warning, then oldest first — the one that has been wrong longest is the one
    that matters, not the one that happened to fire last.
  */
  const worst = [...active].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'serious' ? -1 : 1;
    return a.openedAt.localeCompare(b.openedAt);
  })[0];
  const others = active.length - 1;

  const answer = !alertsKnown
    ? 'Checking on your system…'
    : active.length
      ? `${worst.message}${others > 0 ? ` — and ${others} more under System.` : ''}`
      : night
        ? 'Asleep for the night — back at sunrise.'
        : skyPhrase
          ? `Everything’s running normally — ${skyPhrase}.`
          : 'Everything’s running normally.';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {/*
        HERO BAND — the answer, then the live number, then the day's figures beside it.

        This was a card two-thirds as wide with a divider and nothing after it: the number
        claimed a column it did not fill, and the four figures that belong with it were
        pushed into their own row. One band across the page puts them where the blank was.
      */}
      <Surface hero sx={{ p: 7, borderRadius: `${solar.radius.hero}px` }}>
        <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
            <StatusPill tone={!alertsKnown ? 'unknown' : active.length ? 'warn' : 'ok'}>
              {!alertsKnown ? 'Checking' : active.length ? 'Needs a look' : 'All good'}
            </StatusPill>
            <Typography variant="answer" component="h2" sx={{ color: 'text.primary' }}>
              {answer}
            </Typography>
          </Box>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: 'minmax(260px, 320px) 1px 1fr' },
              gap: { xs: 6, md: 9 },
              alignItems: 'center',
            }}
          >
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="overline" color="text.disabled">
                {night ? 'Asleep' : 'Making right now'}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 3, flexWrap: 'wrap' }}>
                <Metric value={(nowW / 1000).toFixed(1)} unit="kW" variant="metricHero" dim={night} />
                {/*
                  The shape beside the figure. 10.7 kW is a good morning on the way up and a
                  poor afternoon on the way down, and the number alone cannot tell them
                  apart. Hidden at night, where a flat line at zero says nothing.
                */}
                {!night && <Sparkline history={history} />}
              </Box>
              {!night && ratedKw && (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                  <Box sx={{ height: 5, borderRadius: '3px', bgcolor: solar.surface.border, overflow: 'hidden', maxWidth: 220 }}>
                    <Box sx={{ width: `${capPct}%`, height: 5, borderRadius: '3px', bgcolor: solar.series.production, transition: 'width .4s' }} />
                  </Box>
                  <Typography variant="mono" sx={{ color: 'text.disabled' }}>
                    {capPct.toFixed(0)}% of your {ratedKw.toFixed(0)} kW roof
                    {stats ? ` · best ${(stats.records.peakPowerW / 1000).toFixed(1)} kW` : ''}
                  </Typography>
                </Box>
              )}
            </Box>
            <Box sx={{ bgcolor: solar.surface.border, alignSelf: 'stretch', display: { xs: 'none', md: 'block' } }} />
            {/*
              auto-fit rather than a fixed four columns: "Tomorrow" only appears once the
              array has taught the forecast what it does with irradiance, and a fixed grid
              would leave its cell as a hole until then.
            */}
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 6 }}>
              {/*
                A reference under each number, because a total alone answers nothing — 8 kWh
                is either a washout or a winter triumph depending on what this roof normally
                does. The peak-power record used to caption this one: a watt figure under a
                kWh figure. It has moved up to the kW number where its units match.
              */}
              <Stat label={`Made ${shownDayLabel}`} caption={energyCaption}>
                <Metric value={(shownEnergyWh / 1000).toFixed(0)} unit="kWh" variant="metricLg" />
              </Stat>
              <Stat
                label={`Worth ${shownDayLabel}`}
                caption={`at ${((summary?.pricePerKwh ?? 0) * 100).toFixed(1)}¢/kWh`}
              >
                <Typography variant="metricLg" sx={{ color: solar.series.money }}>
                  {money(shownWorth)}
                </Typography>
              </Stat>

              {/*
                Tomorrow answers the one planning question this screen could never answer —
                run the dryer today or tomorrow — from forecast irradiance times this array's
                own learned response, not from a nameplate.
              */}
              {tomorrow !== null && (
                <Stat label="Tomorrow" caption={chargeWindowText ?? 'expected'}>
                  <Typography variant="metricLg" sx={{ color: solar.ink.sec }}>
                    ~{Math.round(tomorrow.expectedWh / 1000)}
                    <Typography component="span" variant="caption" sx={{ ml: 1 }}>
                      kWh
                    </Typography>
                  </Typography>
                </Stat>
              )}

              {/*
                This month rides up here with the other running totals. What is left of the
                payback card — a figure that moves once a day — became the strip at the foot
                of the page rather than a tall card that was two-thirds air.
              */}
              <Stat
                label="This month"
                caption={`${((stats?.lifetimeWh ?? 0) / 1_000_000).toFixed(1)} MWh lifetime`}
              >
                <Typography variant="metricLg" sx={{ color: solar.series.money }}>
                  {money(stats?.savings.month ?? 0)}
                </Typography>
              </Stat>
            </Box>
          </Box>
          {/*
            Energy leaving the roof, along the bottom edge of the card.

            Outside the padded content and flush to the card's corners, because a strip that
            stopped short of the edge would read as another row of the layout rather than as
            the card's own base. Absent at night — a still strip at zero says less than no
            strip at all, and the figure above already says "Asleep".
          */}
          {!night && <FlowStrip pct={capPct} />}
        </Box>
      </Surface>

      {/* Power today + where it's going */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 380px' }, gap: 5 }}>
        <Surface
          sx={{ display: 'flex', flexDirection: 'column' }}
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
          <Chart option={chartOption} height={230} fill />
        </Surface>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <WhereItsGoing solarW={nowW} evW={evNowW} batteryW={batteryNowW} />
          <WeatherCard weather={weather ?? null} />
        </Box>
      </Box>

      {/*
        Payback as a strip, not a card.

        It moves once a day and has three parts — a figure, a bar, a link — so a full card
        left two-thirds of its height empty. Laid out along one line it says the same thing
        in a fifth of the space.
      */}
      <Surface sx={{ py: 4, px: 6 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: 'auto 1fr auto' },
            gap: { xs: 3, md: 7 },
            alignItems: 'center',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 3, flexWrap: 'wrap' }}>
            <Typography variant="overline" color="text.disabled">
              Paying itself off
            </Typography>
            <Typography variant="metricMd" sx={{ color: solar.series.money }}>
              {money(stats?.savings.lifetime ?? 0)}
            </Typography>
            <Typography variant="caption" color="text.disabled">
              {stats?.systemCostCad
                ? `of $${stats.systemCostCad.toLocaleString('en-CA', { maximumFractionDigits: 0 })}`
                : 'set your system cost in Settings'}
              {stats?.paybackProgressPct != null ? ` · ${stats.paybackProgressPct.toFixed(1)}% paid back` : ''}
            </Typography>
          </Box>
          <Box sx={{ height: 6, borderRadius: '4px', bgcolor: solar.surface.border, overflow: 'hidden', minWidth: 80 }}>
            <Box
              sx={{
                width: `${Math.min(100, stats?.paybackProgressPct ?? 0)}%`,
                minWidth: stats?.paybackProgressPct ? 2 : 0,
                height: 6,
                borderRadius: '4px',
                bgcolor: solar.status.ok,
              }}
            />
          </Box>
          <Link
            component={RouterLink}
            to="/money/savings"
            sx={{ font: `600 12px/1 ${solar.font.sans}`, color: solar.accent.link, justifySelf: 'start' }}
          >
            Money →
          </Link>
        </Box>
      </Surface>

      {/*
        The sankey only when there is something to branch.

        With a single flow it degenerates into one full-width bar saying exactly what
        "Where it's going" says two cards above — which is what it did every day the car
        was not plugged in. It comes back the moment there is a real split.
      */}
      {(evNowW > 0 || batteryNowW !== 0) && (
        <EnergyFlow summary={summary} charger={charger ?? null} battery={battery ?? null} />
      )}
    </Box>
  );
}
