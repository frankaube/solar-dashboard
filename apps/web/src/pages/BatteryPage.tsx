import { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { fetchBattery, isDemoMode, setDemoMode, usePolling } from '../api';
import { Chart } from '../charts/Chart';
import { basePreset } from '../charts/preset';
import { ConnectBattery } from '../components/ConnectBattery';
import { FixtureNote, FixturePicker } from '../components/FixturePicker';
import { Metric, Surface } from '../components/Surface';
import { solar } from '../theme';

const POLL_MS = 60_000;

export function BatteryPage(): ReactElement {
  const { data: battery } = usePolling(fetchBattery, POLL_MS);

  if (!battery) return <Surface><Typography variant="body2">Loading…</Typography></Surface>;

  if (!battery.present) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {!isDemoMode() && <ConnectBattery onSaved={() => window.location.reload()} />}
        {/*
          "Reachable but unparseable" is its own state and deserves its own words. The
          device answered; we simply did not recognise anything it said. Falling back
          to the generic "no battery connected" copy would describe the wrong problem
          and send someone to check their wiring.
        */}
        {battery.unparsed && battery.fixture && (
          <Surface sx={{ maxWidth: 720 }}>
            <Typography variant="subtitle1" sx={{ mb: 1 }}>
              Connected, but not understood
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {battery.fixture.device} responded, but nothing in its reply matched a field we
              know. That is what an unsupported model looks like — no state of charge is shown
              rather than a misleading 0%.
            </Typography>
            <FixtureNote fixture={battery.fixture} />
          </Surface>
        )}
        {isDemoMode() && <FixturePicker />}
        <Surface sx={{ maxWidth: 560 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            What this page shows
          </Typography>
          {/*
            This used to promise "Tesla Powerwall, Victron, and Enphase adapters are on
            the roadmap" — three names with no code behind them, next to a form that
            only accepted a fourth. The picker above now lists exactly what works, so
            the roadmap prose was both redundant and a claim we were not keeping.
          */}
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Once a battery is connected: state of charge, charge and discharge flow, and how much
            of your evening comes from stored sun rather than the grid. Anything exposing SunSpec
            storage models over Modbus works without touching this code — many hybrid inverters do,
            behind a "Modbus" or "third-party control" switch in the maker's app.
          </Typography>
          {!isDemoMode() && (
          <Typography variant="body2" color="text.secondary">
            Curious what it looks like?{' '}
            <Box
              component="span"
              sx={{ color: solar.series.production, cursor: 'pointer', textDecoration: 'underline' }}
              onClick={() => {
                setDemoMode(true);
                window.location.reload();
              }}
            >
              Explore demo mode
            </Box>
            .
          </Typography>
          )}
        </Surface>
      </Box>
    );
  }

  const charging = (battery.powerW ?? 0) > 0;
  const flowLabel = charging ? 'charging' : (battery.powerW ?? 0) < 0 ? 'discharging' : 'idle';
  const socOption = {
    ...basePreset(),
    yAxis: {
      ...(basePreset().yAxis as object),
      max: 100,
      axisLabel: { color: solar.ink.dim, fontSize: 10, formatter: '{value}%' },
    },
    series: [
      {
        type: 'line' as const,
        data: (battery.series ?? []).map((p) => [p.t, p.soc]),
        showSymbol: false,
        smooth: 0.3,
        lineStyle: { color: solar.series.financial, width: 2 },
        areaStyle: {
          color: {
            type: 'linear' as const,
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(167,139,250,.22)' },
              { offset: 1, color: 'rgba(167,139,250,0)' },
            ],
          },
        },
      },
    ],
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {/* Above the hero, not below it: someone must not read these numbers as their
          own house before learning whose device they belong to. */}
      {battery.fixture && <FixtureNote fixture={battery.fixture} />}
      <Surface hero sx={{ p: 7 }}>
        <Box sx={{ display: 'flex', gap: { xs: 6, md: 11 }, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 240 }}>
            <Typography variant="overline" color="text.secondary">
              {[battery.name, battery.model, flowLabel]
                // A device whose name and model are the same string should say it once.
                .filter((part, i, all) => part && all.indexOf(part) === i)
                .join(' · ')}
            </Typography>
            <Metric value={String(battery.soc ?? 0)} unit="%" variant="metricHero" />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', width: 320, maxWidth: '100%' }}>
              <Box sx={{ flex: 1, height: 6, borderRadius: '3px', bgcolor: solar.surface.border, overflow: 'hidden', position: 'relative' }}>
                <Box sx={{ position: 'absolute', left: `${battery.reservePct ?? 20}%`, top: 0, bottom: 0, width: '1px', bgcolor: solar.status.warn }} />
                <Box sx={{ width: `${battery.soc ?? 0}%`, height: 6, bgcolor: solar.series.financial }} />
              </Box>
              {/* Capacity is genuinely unknown for several devices — EcoFlow only
                  reports it on some product lines. "0.0 / kWh" reads as a broken
                  gauge; saying nothing is both truer and tidier. */}
              {battery.capacityKwh != null && (
                <Typography variant="mono" sx={{ color: 'text.disabled' }}>
                  {(((battery.soc ?? 0) / 100) * battery.capacityKwh).toFixed(1)} /{' '}
                  {battery.capacityKwh} kWh
                </Typography>
              )}
            </Box>
          </Box>
          <Box>
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 1 }}>
              Power flow
            </Typography>
            <Metric
              value={Math.abs((battery.powerW ?? 0) / 1000).toFixed(1)}
              unit={charging ? 'kW in' : 'kW out'}
              variant="metricMd"
            />
          </Box>
        </Box>
      </Surface>

      {/*
        These four were `?? 0`, which is the same defect this project keeps finding:
        an unknown value rendering as a confident zero. A single snapshot carries no
        history at all, so "Charged today 0.0 kWh" was a false statement about a
        battery that may well have charged plenty. Unknown now shows an em dash.
      */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: '14px' }}>
        <Surface title="Charged today">
          <Metric
            value={battery.todayChargedKwh != null ? battery.todayChargedKwh.toFixed(1) : '—'}
            unit={battery.todayChargedKwh != null ? 'kWh' : undefined}
            dim={battery.todayChargedKwh == null}
          />
        </Surface>
        <Surface title="Discharged today">
          <Metric
            value={battery.todayDischargedKwh != null ? battery.todayDischargedKwh.toFixed(1) : '—'}
            unit={battery.todayDischargedKwh != null ? 'kWh' : undefined}
            dim={battery.todayDischargedKwh == null}
          />
        </Surface>
        <Surface title="Cycles">
          <Metric
            value={battery.cycles != null ? String(battery.cycles) : '—'}
            dim={battery.cycles == null}
          />
        </Surface>
        <Surface title="Round-trip">
          <Metric
            value={battery.roundTripPct != null ? String(battery.roundTripPct) : '—'}
            unit={battery.roundTripPct != null ? '%' : undefined}
            dim={battery.roundTripPct == null}
          />
        </Surface>
      </Box>

      {/* An empty chart under a caption describing behaviour we have not observed is
          worse than no chart. A snapshot fixture has no series to draw. */}
      {(battery.series?.length ?? 0) > 0 && (
        <Surface
          title={
            <Box>
              <Typography variant="subtitle1">State of charge · 24 h</Typography>
              <Typography variant="caption" color="text.disabled">
                charges from midday surplus, covers the evening
              </Typography>
            </Box>
          }
        >
          <Chart option={socOption} height={220} />
        </Surface>
      )}

      {isDemoMode() && <FixturePicker />}
    </Box>
  );
}
