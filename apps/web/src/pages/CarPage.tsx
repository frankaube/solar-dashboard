import { ReactElement, useEffect, useState } from 'react';
import { Capabilities, fetchCapabilities } from '../api';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import {
  fetchCharger,
  fetchConfig,
  fetchProductionAnalytics,
  fetchSummary,
  fetchVehicleDetails,
  usePolling,
} from '../api';
import { Chart } from '../charts/Chart';
import { basePreset } from '../charts/preset';
import { LedgerRow } from '../components/LedgerRow';
import { Metric, Surface } from '../components/Surface';
import { solar } from '../theme';

const POLL_MS = 60_000;
const STATS_DAYS = 30;
/** Rough gas-car comparison: 9 L/100 km at $1.60/L. */
const GAS_L_PER_100KM = 9;
const GAS_PRICE_PER_L = 1.6;
const FALLBACK_PRICE_PER_KWH = 0.16;

/**
 * " at home" / " away from home" / "" — where it is, when that is known.
 *
 * Empty for null, which is the whole point: null means no home has been set or the car has
 * no fix, and an app that has not been told where home is must not imply it knows. Saying
 * nothing is what "Parked in the garage" should have done.
 */
function placeText(atHome: boolean | null): string {
  if (atHome === null) return '';
  return atHome ? ' at home' : ' away from home';
}

/**
 * " since 3:42 pm" / " since Tuesday" / "" — how long the car has sat.
 *
 * Rounds up to a day once it is past one, because "parked since 41 hours" is not how
 * anyone reads a driveway. Returns nothing at all when there is no drive on record: a
 * fresh install has no idea, and inventing "just now" would be a lie on day one.
 */
function sinceText(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const hours = (Date.now() - at.getTime()) / 3_600_000;
  if (hours < 0) return '';
  if (hours < 20) return ` since ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (hours < 24 * 7) return ` since ${at.toLocaleDateString([], { weekday: 'long' })}`;
  return ` since ${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function fmtHour(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    // Numeric, not 2-digit: "5:36 PM" rather than "05:36 PM". A leading zero on an hour
    // is not how anyone writes a time, and the extra character wrapped the ledger's date
    // column onto two lines. The rest of the page already writes it this way.
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function CarPage(): ReactElement {
  // Whatever vehicle logger is actually connected, rather than the one this build
  // started with. Null until it answers, and null forever on an install with no car.
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => {
    fetchCapabilities().then(setCaps).catch(() => setCaps(null));
  }, []);
  const { data: charger } = usePolling(fetchCharger, POLL_MS);
  const { data: detailsWrap } = usePolling(() => fetchVehicleDetails(STATS_DAYS), POLL_MS);
  const { data: analytics } = usePolling(() => fetchProductionAnalytics(24), 5 * 60_000);
  const { data: config } = usePolling(fetchConfig, 5 * 60_000);
  const { data: summary } = usePolling(fetchSummary, POLL_MS);
  const [showMore, setShowMore] = useState(false);
  const pricePerKwh = config?.electricityPricePerKwh ?? FALLBACK_PRICE_PER_KWH;
  const details = detailsWrap?.details ?? null;
  const vehicle = details?.vehicle ?? charger?.vehicle ?? null;

  if (!vehicle) {
    return (
      <Surface sx={{ maxWidth: 560 }}>
        <Typography variant="subtitle1">No vehicle data yet</Typography>
        <Typography variant="body2" color="text.secondary">
          {caps?.vehicle
            ? `${caps.vehicle.name} hasn’t reported a car yet.${caps.vehicle.setupUrl ? ` Sign in at ${caps.vehicle.setupUrl} and give it a minute.` : ''}`
            : 'No vehicle logger is connected yet.'}
        </Typography>
      </Surface>
    );
  }

  const preset = basePreset();
  const batteryOption = {
    ...preset,
    yAxis: { ...(preset.yAxis as object), max: 100, axisLabel: { color: solar.ink.dim, fontSize: 10, formatter: '{value}%' } },
    series: [
      {
        type: 'line' as const,
        data: (details?.battery ?? []).map((p) => [p.t, p.level]),
        showSymbol: false,
        step: 'end' as const,
        lineStyle: { color: solar.status.ok, width: 2 },
        areaStyle: {
          color: {
            type: 'linear' as const,
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(34,197,94,.18)' },
              { offset: 1, color: 'rgba(34,197,94,0)' },
            ],
          },
        },
      },
    ],
  };

  const curveOption = {
    ...preset,
    series: [
      {
        type: 'line' as const,
        data: (details?.lastChargeCurve ?? []).map((p) => [p.t, p.powerKw]),
        showSymbol: false,
        lineStyle: { color: solar.series.production, width: 2 },
      },
    ],
  };

  const stats = details?.stats;
  const gasSavings =
    stats && stats.drivenKm > 0
      ? (stats.drivenKm / 100) * GAS_L_PER_100KM * GAS_PRICE_PER_L -
        stats.energyUsedKwh * pricePerKwh
      : null;

  /*
    Charging efficiency: what reached the battery against what came out of the wall.

    Both halves come from the car. This used to pair each charge with a Wall Connector
    session for the wall-side figure, so when the wall unit stopped answering on 28 July
    the tile fell to "—" and stayed there — the third instance of the same failure on this
    page, and the same silent kind: a dash reads as "no charges yet", not as "the thing
    this was measured from is gone".

    Fast charges are excluded: DC bypasses the onboard charger, so its losses are a
    different quantity and averaging the two answers nothing.
  */
  let effAdded = 0;
  let effUsed = 0;
  for (const charge of details?.charges ?? []) {
    if (charge.fast || charge.energyUsedKwh === null) continue;
    // Skip trickles — a 0.26 kWh top-up divides two rounded figures into noise.
    if (charge.energyUsedKwh > 0.5 && charge.energyAddedKwh > 0.5) {
      effAdded += charge.energyAddedKwh;
      effUsed += charge.energyUsedKwh;
    }
  }
  const chargeEfficiencyPct = effUsed > 0 ? Math.round((effAdded / effUsed) * 100) : null;
  const drain = details?.phantomDrain;

  /*
    Each list's bars are scaled to its own largest row, not to a fixed ceiling. A 52 kWh
    Supercharger stop and a 0.3 kWh top-up are three orders of magnitude apart on some
    days and all within a factor of two on others; a fixed scale would flatten one of
    those cases into a row of identical stubs.
  */
  const maxChargeKwh = Math.max(0, ...(details?.charges ?? []).slice(0, 10).map((c) => c.energyAddedKwh));
  const maxDriveKm = Math.max(0, ...(details?.drives ?? []).slice(0, 10).map((d) => d.distanceKm));

  const charging = charger?.live?.charging ?? false;
  const plugged = charger?.live?.vehicleConnected ?? false;
  /*
    From every charge the car recorded, not from Wall Connector sessions.

    The wall unit stopped answering on 28 July, so this headline was being computed from
    six sessions that all predated it — "4% solar over the last 30 days" while excluding
    every charge since, including a midday one that was 83% off the roof. Wrong number,
    wrong denominator, and captioned as the whole period.
  */
  const chargeTotals = details?.chargeTotals ?? null;
  const solarShare = chargeTotals && chargeTotals.energyWh > 0 ? chargeTotals.solarPct : null;
  // The "sunshine" claim must describe THIS charge, not a 30-day average — compare the
  // roof's output right now against what the car is drawing right now.
  const chargeW = charger?.live?.powerW ?? 0;
  const liveSolarCover = charging && chargeW > 0 ? Math.min(1, (summary?.currentPowerW ?? 0) / chargeW) : 0;
  const chargeSourcePhrase =
    liveSolarCover >= 0.8 ? ' on sunshine' : liveSolarCover >= 0.3 ? ' partly on sunshine' : ' from the grid';
  /*
    What the car is actually doing.

    This used to read "Parked in the garage" whenever the Wall Connector reported neither
    charging nor plugged in — a claim about where the car is, inferred from the absence of
    a charging signal, with nothing behind it. It said so while the car was doing 47 km/h a
    kilometre down the road, and it had been saying so unconditionally since the Wall
    Connector went unreachable, because with no charger both branches are false.

    The car's own state was already being fetched and thrown away. Nothing here claims a
    location: without a geofence the app does not know which coordinates are home, and
    guessing is what produced the garage.
  */
  const level = vehicle.batteryLevel !== null ? ` — ${vehicle.batteryLevel}% charged` : '';
  const driving = vehicle.motion?.driving ?? false;
  const speed = vehicle.motion?.speedKmh ?? null;
  /*
    The pill used to fall through to `vehicle.state`, which showed "online" beside a car
    that had been parked for three hours. That field says whether Tesla's API is answering,
    not what the car is doing. "asleep" and "offline" are the two values where it genuinely
    describes the car, so those survive; everything else is a parked car.
  */
  const statusWord = driving
    ? 'Driving'
    : charging
      ? 'Charging'
      : plugged
        ? 'Plugged in'
        : vehicle.state === 'asleep'
          ? 'Asleep'
          : vehicle.state === 'offline'
            ? 'Offline'
            : 'Parked';

  const carAnswer = driving
    ? `Driving${speed !== null ? ` at ${speed} km/h` : ''}${level}.`
    : charging
      ? `Charging${chargeSourcePhrase} — ${(chargeW / 1000).toFixed(1)} kW going in.`
      : plugged
        ? `Plugged in at home${level}.`
        : `Parked${placeText(vehicle.atHome ?? null)}${sinceText(vehicle.motion?.since ?? null)}${level}.`;
  const gasLitres = stats && stats.drivenKm > 0 ? Math.round((stats.drivenKm / 100) * GAS_L_PER_100KM) : null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {/* hero */}
      <Surface hero sx={{ p: 7, borderRadius: `${solar.radius.hero}px` }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
            <Box
              component="span"
              sx={{
                display: 'inline-flex', alignItems: 'center', gap: '7px', px: '13px', py: '7px', borderRadius: '999px',
                // Driving gets its own skin, so the pill is not grey-for-everything-else.
                bgcolor: charging ? solar.pill.charging.bg : driving ? solar.pill.driving.bg : solar.surface.raised,
                border: `1px solid ${charging ? solar.pill.charging.border : driving ? solar.pill.driving.border : solar.pill.neutral.border}`,
                color: charging ? solar.pill.charging.fg : driving ? solar.pill.driving.fg : solar.ink.dim,
                font: `600 12px/1 ${solar.font.sans}`, flex: '0 0 auto',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path d="M6.6 1.6L2.8 6.8h2.6l-.6 3.6 3.8-5.2H6l.6-3.6z" />
              </svg>
              {statusWord}
            </Box>
            <Typography variant="answer" component="h2" sx={{ color: 'text.primary' }}>{carAnswer}</Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: { xs: 6, md: 12 }, flexWrap: 'wrap' }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="overline" color="text.disabled">Charged</Typography>
              <Metric value={vehicle.batteryLevel !== null ? String(vehicle.batteryLevel) : '—'} unit="%" variant="metricHero" />
              <Typography variant="caption" color="text.secondary">
                {vehicle.rangeKm ? `${vehicle.rangeKm} km of range` : `${vehicle.name} · ${vehicle.model}`}
              </Typography>
            </Box>
            <Box sx={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 2, pb: '6px' }}>
              <Box sx={{ height: 34, borderRadius: '8px', bgcolor: solar.surface.inset, overflow: 'hidden', display: 'flex' }}>
                <Box sx={{ width: `${vehicle.batteryLevel ?? 0}%`, bgcolor: solar.pill.charging.fg }} />
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Typography variant="mono" sx={{ color: 'text.disabled' }}>now {vehicle.batteryLevel ?? 0}%</Typography>
                {charging && (
                  <Typography variant="mono" sx={{ color: 'text.disabled' }}>
                    adding {((charger?.live?.powerW ?? 0) / 1000).toFixed(1)} kW
                  </Typography>
                )}
              </Box>
            </Box>
          </Box>
        </Box>
      </Surface>

      {/* charge source + fuel saved */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 460px' }, gap: 5 }}>
        <Surface title={`Where your charging comes from · last ${STATS_DAYS} d`}>
          {solarShare !== null && chargeTotals ? (
            <>
              <Box sx={{ display: 'flex', height: 44, borderRadius: '9px', overflow: 'hidden', mb: 3 }}>
                <Box sx={{ width: `${solarShare}%`, bgcolor: solar.series.production, display: 'flex', alignItems: 'center', justifyContent: 'center', font: `600 12.5px/1 ${solar.font.sans}`, color: solar.on.gold }}>
                  {solarShare}% roof
                </Box>
                <Box sx={{ flex: 1, bgcolor: solar.series.car, display: 'flex', alignItems: 'center', justifyContent: 'center', font: `600 12.5px/1 ${solar.font.sans}`, color: solar.on.cool }}>
                  {100 - solarShare}% grid
                </Box>
              </Box>
              <Typography variant="answer" sx={{ fontSize: 15, lineHeight: 1.55, color: solar.ink.sec, display: 'block' }}>
                {solarShare}% of your home charging started on the roof — the rest came from the grid.
              </Typography>
              <Box sx={{ height: '1px', bgcolor: solar.surface.border, my: 4 }} />
              <Box sx={{ display: 'flex', gap: 8 }}>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <Typography variant="overline" color="text.disabled">Charged</Typography>
                  <Typography variant="metricMd">{(chargeTotals.energyWh / 1000).toFixed(1)} kWh</Typography>
                </Box>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <Typography variant="overline" color="text.disabled">From the roof</Typography>
                  <Typography variant="metricMd" sx={{ color: solar.series.money }}>{(chargeTotals.solarWh / 1000).toFixed(1)} kWh</Typography>
                </Box>
              </Box>
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Charging history appears once the car logs a charge.
            </Typography>
          )}
        </Surface>

        <Surface title="Instead of gasoline (est.)">
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
            <Typography variant="metricLg" sx={{ color: solar.series.money }}>
              {gasSavings !== null ? `$${gasSavings.toFixed(0)}` : '—'}
            </Typography>
            <Typography variant="caption" color="text.disabled">saved · {STATS_DAYS} d</Typography>
          </Box>
          <Typography variant="answer" sx={{ fontSize: 14, lineHeight: 1.55, color: solar.ink.sec, display: 'block', mt: 3 }}>
            {stats && gasLitres !== null
              ? `${stats.drivenKm.toLocaleString()} km driven — a gas car would've burned about ${gasLitres.toLocaleString()} L.`
              : `Trip data appears as ${caps?.vehicle?.name ?? 'your vehicle logger'} logs drives.`}
          </Typography>
          {/* The comparison rests on assumptions the owner can't see otherwise — state them. */}
          <Typography variant="caption" color="text.disabled" sx={{ mt: 2, display: 'block' }}>
            Assumes a comparable gas car at {GAS_L_PER_100KM} L/100 km and ${GAS_PRICE_PER_L.toFixed(2)}/L, minus the{' '}
            {((config?.electricityPricePerKwh ?? FALLBACK_PRICE_PER_KWH) * 100).toFixed(1)}¢/kWh the charging cost.
          </Typography>
          <Box sx={{ height: '1px', bgcolor: solar.surface.border, my: 4 }} />
          <Link
            component="button"
            type="button"
            onClick={() => setShowMore((v) => !v)}
            underline="hover"
            sx={{ font: `600 12.5px/1 ${solar.font.sans}`, color: solar.accent.link }}
          >
            {showMore ? 'Hide extra stats' : 'More — efficiency, Wh/km, standby drain'}
          </Link>
        </Surface>
      </Box>

      <Collapse in={showMore}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(3, 1fr)', lg: 'repeat(6, 1fr)' }, gap: '14px' }}>
          <Surface title="Consumption">
            <Metric value={stats?.avgConsumptionWhKm ? String(stats.avgConsumptionWhKm) : '—'} unit="Wh/km" variant="metricMd" />
          </Surface>
          <Surface title="Charge efficiency">
            <Metric value={chargeEfficiencyPct !== null ? String(chargeEfficiencyPct) : '—'} unit="%" variant="metricMd" />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>battery-in vs wall-out</Typography>
          </Surface>
          <Surface title="Phantom drain">
            <Metric value={drain?.avgPctPerDay != null ? String(drain.avgPctPerDay) : '—'} unit="%/day" variant="metricMd" />
          </Surface>
          <Surface title="Energy used">
            <Metric value={stats ? stats.energyUsedKwh.toFixed(1) : '—'} unit="kWh" variant="metricMd" />
          </Surface>
          <Surface title="Energy added">
            <Metric value={stats ? stats.energyAddedKwh.toFixed(1) : '—'} unit="kWh" variant="metricMd" />
          </Surface>
          <Surface title="Odometer">
            <Metric value={vehicle.odometerKm?.toLocaleString() ?? '—'} unit="km" variant="metricMd" />
          </Surface>
        </Box>
      </Collapse>

      {analytics?.chargeWindow && (
        <Surface sx={{ display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' }}>
          <Typography variant="overline" color="text.disabled">
            Best charge window tomorrow
          </Typography>
          <Typography variant="subtitle1">
            {fmtHour(analytics.chargeWindow.start)}–{fmtHour(analytics.chargeWindow.end)}
          </Typography>
          <Typography variant="mono" sx={{ color: solar.series.production }}>
            ~{analytics.chargeWindow.estKwh} kWh of solar · avg {analytics.chargeWindow.avgKw} kW
          </Typography>
          <Typography variant="caption" color="text.secondary">
            plug in then (or set the car's scheduled charging) for maximum sun-powered charging
          </Typography>
        </Surface>
      )}

      {/* charts */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 5 }}>
        <Surface
          title={
            <Box>
              <Typography variant="subtitle1">Battery · last 7 days</Typography>
              <Typography variant="caption" color="text.disabled">charges climb, drives descend</Typography>
            </Box>
          }
        >
          <Chart option={batteryOption} height={200} />
        </Surface>
        <Surface
          title={
            <Box>
              <Typography variant="subtitle1">Last charge · power</Typography>
              <Typography variant="caption" color="text.disabled">
                {details?.charges[0]
                  ? `${fmtWhen(details.charges[0].startedAt)}${details.charges[0].location ? ` · ${details.charges[0].location}` : ''}`
                  : 'no charges recorded yet'}
              </Typography>
            </Box>
          }
        >
          {details?.lastChargeCurve.length ? (
            <Chart option={curveOption} height={200} />
          ) : (
            <Typography variant="body2" color="text.secondary">
              {`The charge curve appears after the first charge ${caps?.vehicle?.name ?? 'your vehicle logger'} records.`}
            </Typography>
          )}
        </Surface>
      </Box>

      {/* charges + drives */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 5 }}>
        <Surface title={`Charges · last ${STATS_DAYS} d`}>
          {!details?.charges.length ? (
            <Typography variant="body2" color="text.secondary">
              None yet — the first plug-in shows up here with energy added, losses, and location.
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              {details.charges.slice(0, 10).map((charge) => (
                <LedgerRow
                  key={charge.startedAt}
                  when={fmtWhen(charge.startedAt)}
                  amount={`${charge.energyAddedKwh.toFixed(1)} kWh`}
                  fraction={maxChargeKwh > 0 ? charge.energyAddedKwh / maxChargeKwh : 0}
                  solarFraction={(charge.solarPct ?? 0) / 100}
                  tail={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                      {charge.fast && (
                        <Chip
                          size="small"
                          label="DC fast"
                          sx={{ height: 17, fontSize: 10, color: solar.series.irradiance, bgcolor: 'transparent', border: `1px solid ${solar.series.irradiance}` }}
                        />
                      )}
                      {/*
                        The place only when it is not home. Eleven identical "Home" labels
                        down a list is noise; one "Miramichi Supercharger" is the thing
                        worth seeing. The address itself used to be printed on every row.
                      */}
                      {charge.location && charge.location !== 'Home' && (
                        <Typography variant="caption" color="text.secondary">
                          {charge.location}
                        </Typography>
                      )}
                      {charge.solarPct !== null && charge.solarPct > 0 && (
                        <Typography variant="mono" sx={{ color: solar.series.production }}>
                          {charge.solarPct}% sun
                        </Typography>
                      )}
                      {charge.startLevel !== null && charge.endLevel !== null && (
                        <Typography variant="mono" sx={{ color: 'text.disabled' }}>
                          {charge.startLevel}→{charge.endLevel}%
                        </Typography>
                      )}
                    </Box>
                  }
                />
              ))}
            </Box>
          )}
        </Surface>
        <Surface title={`Drives · last ${STATS_DAYS} d`}>
          {!details?.drives.length ? (
            <Typography variant="body2" color="text.secondary">
              None yet — drives appear here with distance, duration, and consumption.
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              {details.drives.slice(0, 10).map((drive) => (
                <LedgerRow
                  key={drive.startedAt}
                  when={fmtWhen(drive.startedAt)}
                  amount={`${drive.distanceKm.toFixed(1)} km`}
                  fraction={maxDriveKm > 0 ? drive.distanceKm / maxDriveKm : 0}
                  tail={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                      {/*
                        Wraps rather than truncates. "Ashley Crescent → H" hides the
                        destination, which is the half of a route anyone reads; an
                        occasional two-line row costs less than that.
                      */}
                      {drive.from && drive.to && (
                        <Typography variant="caption" color="text.secondary">
                          {drive.from} → {drive.to}
                        </Typography>
                      )}
                      <Typography variant="mono" sx={{ color: 'text.disabled' }}>
                        {drive.durationMin} min
                        {/*
                          Wh/km is meaningless on a 1.5 km hop — the range estimate it comes
                          from moves in steps larger than the trip. Several of these drives
                          are exactly that, and a figure that swings 100% on rounding reads
                          as a real difference in how the car was driven.
                        */}
                        {drive.consumptionKwh !== null && drive.distanceKm > 3
                          ? ` · ${Math.round((drive.consumptionKwh * 1000) / drive.distanceKm)} Wh/km`
                          : ''}
                        {drive.consumptionKwh !== null
                          ? ` · $${(drive.consumptionKwh * pricePerKwh).toFixed(2)}`
                          : ''}
                      </Typography>
                    </Box>
                  }
                />
              ))}
            </Box>
          )}
        </Surface>
      </Box>

      {details && details.updates.length > 0 && (
        <Surface title="Software updates">
          <Box sx={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {details.updates.map((update) => (
              <Typography key={update.installedAt} variant="caption" color="text.secondary">
                <strong style={{ color: solar.ink.pri }}>{update.version}</strong> ·{' '}
                {new Date(update.installedAt).toLocaleDateString()}
              </Typography>
            ))}
          </Box>
        </Surface>
      )}
    </Box>
  );
}
