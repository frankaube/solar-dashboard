import { ReactElement, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  DeviceLoad,
  HomeScanResult,
  HomeDevice,
  adoptHomeDevice,
  commandHomeDevice,
  fetchConfig,
  fetchDeviceUsage,
  fetchHomeDevices,
  fetchSubnetSuggestions,
  pairHomeDevice,
  scanHomeDevices,
  updateHomeDevice,
  usePolling,
} from '../api';
import { DeviceSchedules } from '../components/DeviceSchedules';
import { ChannelBreakdown } from '../components/ChannelBreakdown';
import { EstimatedEnergy, LoadEditor } from '../components/LoadEditor';
import { AddDeviceFlow } from '../components/AddDeviceFlow';
import { Surface } from '../components/Surface';
import {
  Capabilities,
  ManualVendor,
  addDeviceManually,
  fetchCapabilities,
  fetchManualVendors,
} from '../api';
import {
  StateTone,
  costIsEstimated,
  describeKind,
  describeState,
  headline,
  monthlyCost,
  needsPairing,
  usingNowKw,
} from './devicesCopy';
import { solar } from '../theme';

const POLL_MS = 30_000;

/**
 * Pull load settings out of a device's config JSON.
 *
 * The same blob also carries HomeKit pairing data and meter channel labels, so this
 * reads defensively and returns nothing rather than throwing on anything unexpected.
 */
function readLoad(configJson: string | null): DeviceLoad {
  if (!configJson) return {};
  try {
    const parsed = JSON.parse(configJson) as DeviceLoad;
    return {
      ratedW: typeof parsed.ratedW === 'number' ? parsed.ratedW : null,
      loadLabel: typeof parsed.loadLabel === 'string' ? parsed.loadLabel : null,
      loadType: parsed.loadType ?? null,
    };
  } catch {
    return {};
  }
}

/**
 * One glyph per kind, at the size the design uses.
 *
 * Kept as emoji rather than an icon font because the project ships no icon dependency and
 * a 30px tile reads the same either way.
 */
const KIND_ICONS: Record<string, string> = {
  thermostat: '🌡',
  switch: '🎚',
  light: '💡',
  plug: '🔌',
  meter: '📟',
  battery: '🔋',
  charger: '🔌',
};

/** Pill colours per state tone, from the design's warm palette. */
const TONE: Record<StateTone, { bg: string; border: string; ink: string }> = {
  ok: { bg: solar.pill.ok.bg, border: solar.pill.ok.border, ink: solar.status.ok },
  warn: { bg: solar.pill.warn.bg, border: solar.pill.warn.border, ink: solar.status.warn },
  bad: { bg: solar.pill.bad.bg, border: solar.pill.bad.border, ink: solar.status.critical },
  idle: { bg: solar.surface.raised, border: solar.surface.borderStrong, ink: solar.ink.dim },
};

/** A column layout shared by the header row and every device row, so they cannot drift. */
const COLS = { kind: 104, state: 132, warn: 118, action: 108 };

export function DevicesPage(): ReactElement {
  const { data: devices, refresh } = usePolling(fetchHomeDevices, POLL_MS);
  // Usage polls slowly because it is a week-long aggregate, but declaring a load
  // changes it immediately — so that path refreshes it explicitly rather than leaving
  // someone staring at "reports no power" for five minutes after telling us it runs
  // the pool pump.
  const { data: usage, refresh: refreshUsage } = usePolling(() => fetchDeviceUsage(7), 5 * 60_000);
  const { data: subnets } = usePolling(fetchSubnetSuggestions, 10 * 60_000);
  const [subnet, setSubnet] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<HomeScanResult | null>(null);
  const [pinFor, setPinFor] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const { data: config } = usePolling(fetchConfig, 10 * 60_000);
  useEffect(() => {
    fetchCapabilities().then(setCaps).catch(() => setCaps(null));
  }, []);

  // Adopt the best-evidenced suggestion once it arrives, but never overwrite a choice
  // already made — the field was previously hardcoded to one developer's network.
  useEffect(() => {
    if (!subnet && subnets && subnets.length > 0) setSubnet(subnets[0].subnet);
  }, [subnets, subnet]);

  const runScan = async (): Promise<void> => {
    setScanning(true);
    setError(null);
    try {
      setScan(await scanHomeDevices(subnet));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const head = headline(devices ?? []);
  const liveKw = usingNowKw(devices ?? []);
  /*
    Tax-inclusive, because "costing you" is what leaves your pocket. The configured price
    may be either convention — see the Settings → Rates work on priceIncludesTax.
  */
  const retail = config
    ? config.priceIncludesTax
      ? config.electricityPricePerKwh
      : config.electricityPricePerKwh * (1 + config.hstRate)
    : 0;
  const cost = monthlyCost(usage ?? [], retail);
  const estimated = costIsEstimated(usage ?? []);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 1240 }}>
      {error && (
        <Typography variant="body2" sx={{ color: solar.status.critical }}>
          {error}
        </Typography>
      )}

      <Box
        sx={{
          display: 'flex',
          gap: 2.5,
          alignItems: 'flex-start',
          flexWrap: { xs: 'wrap', lg: 'nowrap' },
        }}
      >
        {/* Left: the answer and the table. Right: the things you set up once. */}
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        {/*
          Hero: one sentence a homeowner can act on, and one number big enough to read from
          across the kitchen. From the Sunhouse design — the old page opened with three
          equal-weight cards and a paragraph of Docker networking.
        */}
        <Surface>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              {head.troubled > 0 && (
                <Box
                  component="span"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.9,
                    px: 1.6,
                    py: 0.9,
                    borderRadius: 999,
                    background: TONE.warn.bg,
                    border: '1px solid',
                    borderColor: TONE.warn.border,
                    font: `600 12px/1 ${solar.font.sans}`,
                    color: TONE.warn.ink,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {head.troubled} need{head.troubled === 1 ? 's' : ''} a look
                </Box>
              )}
              {/* The serif voice: this is the app telling you something, not showing you a number. */}
              <Typography variant="answer" sx={{ color: solar.ink.pri }}>
                {head.sentence}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 5.5, flexWrap: 'wrap' }}>
              <Box>
                <Typography variant="overline" sx={{ color: solar.ink.dim, display: 'block' }}>
                  Devices reporting
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                  <Typography variant="metricHero">{head.reporting}</Typography>
                  <Typography sx={{ font: `500 20px/1 ${solar.font.sans}`, color: solar.ink.dim }}>
                    of {head.total}
                  </Typography>
                </Box>
              </Box>
              <Box>
                <Typography variant="overline" sx={{ color: solar.ink.dim, display: 'block', mb: '6px' }}>
                  Using now
                </Typography>
                {/*
                  Null, not zero — none of these devices meter their own power, and a
                  confident 0.0 kW would be a lie. But a bare em-dash under a label is not
                  an answer either; on screen it reads as a rendering failure. Say which.
                */}
                {liveKw === null ? (
                  <Typography variant="caption" sx={{ color: solar.ink.dim, display: 'block', pb: '5px' }}>
                    Nothing here meters
                  </Typography>
                ) : (
                  <Typography variant="metricMd">{liveKw.toFixed(1)} kW</Typography>
                )}
              </Box>
              <Box>
                <Typography variant="overline" sx={{ color: solar.ink.dim, display: 'block', mb: '6px' }}>
                  Costing you
                </Typography>
                {/* Same reasoning as "Using now": name the gap, do not draw a dash in it. */}
                {cost === null ? (
                  <Typography variant="caption" sx={{ color: solar.ink.dim, display: 'block', pb: '5px' }}>
                    Set a rating to find out
                  </Typography>
                ) : (
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                    <Typography variant="metricMd">{cost}</Typography>
                    {estimated && (
                      <Tooltip title="Estimated from how long each device runs, not metered.">
                        <Typography variant="caption" sx={{ color: solar.ink.dim, cursor: 'help' }}>
                          est.
                        </Typography>
                      </Tooltip>
                    )}
                  </Box>
                )}
              </Box>
            </Box>
          </Box>
        </Surface>
  
        {/*
          One table. Kind is a column rather than three card headings — the grouping was
          costing more vertical space than it saved on a four-device install.
        */}
        <Surface>
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', pb: 2 }}>
              <Typography variant="subtitle1">Your devices</Typography>
              {/* Opens the add flow. One entry point, so there is one form to keep correct. */}
              <Button size="small" variant="outlined" onClick={() => setAdding(true)}>
                Add a device
              </Button>
            </Box>
  
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                pb: 1.2,
                borderBottom: '1px solid',
                borderColor: 'divider',
                font: `600 10.5px/1 ${solar.font.sans}`,
                letterSpacing: '.12em',
                textTransform: 'uppercase',
                color: solar.ink.dim,
              }}
            >
              <Box sx={{ flex: 1, pl: '44px' }}>Device</Box>
              <Box sx={{ width: COLS.kind, flex: `0 0 ${COLS.kind}px`, display: { xs: 'none', md: 'block' } }}>Kind</Box>
              <Box sx={{ width: COLS.state, flex: `0 0 ${COLS.state}px` }}>State</Box>
              {/*
                A header, which the old unlabelled "critical" switch never had. A toggle with
                no sentence next to it is a guess.
              */}
              {/*
                A tooltip, not a paragraph. The old footnote explained what the column
                replaced, which is changelog rather than help — nobody reading this page
                needs to know what used to be here.
              */}
              <Tooltip title="Sends a notice if this device stops reporting.">
                <Box sx={{ width: COLS.warn, flex: `0 0 ${COLS.warn}px`, textAlign: 'center', cursor: 'help' }}>
                  Warn me
                </Box>
              </Tooltip>
              <Box sx={{ width: COLS.action, flex: `0 0 ${COLS.action}px` }} />
            </Box>
  
            {(devices ?? []).map((device) => {
              const state = describeState(device);
              const tone = TONE[state.tone];
              return (
                <Box key={device.id} sx={{ borderBottom: '1px solid', borderColor: solar.grid.line }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', py: 2 }}>
                    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 1.8 }}>
                      <Box
                        sx={{
                          width: 30,
                          height: 30,
                          flex: '0 0 30px',
                          borderRadius: '9px',
                          background: solar.surface.raised,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 15,
                        }}
                      >
                        {KIND_ICONS[device.kind] ?? '⚙'}
                      </Box>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography sx={{ font: `500 14px/1.3 ${solar.font.sans}`, color: solar.ink.pri }}>
                          {device.name}
                        </Typography>
                        {state.detail && (
                          <Typography sx={{ font: `400 12px/1.35 ${solar.font.sans}`, color: solar.ink.dim, mt: '3px' }}>
                            {state.detail}
                          </Typography>
                        )}
                      </Box>
                    </Box>
  
                    <Box
                      sx={{
                        width: COLS.kind,
                        flex: `0 0 ${COLS.kind}px`,
                        display: { xs: 'none', md: 'block' },
                        font: `400 12.5px/1.3 ${solar.font.sans}`,
                        color: solar.ink.sec,
                      }}
                    >
                      {describeKind(device.kind)}
                    </Box>
  
                    <Box sx={{ width: COLS.state, flex: `0 0 ${COLS.state}px` }}>
                      <Box
                        component="span"
                        sx={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          px: 1.4,
                          py: 0.65,
                          borderRadius: 999,
                          background: tone.bg,
                          border: '1px solid',
                          borderColor: tone.border,
                          font: `600 11.5px/1 ${solar.font.sans}`,
                          color: tone.ink,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {state.label}
                      </Box>
                    </Box>
  
                    <Box sx={{ width: COLS.warn, flex: `0 0 ${COLS.warn}px`, display: 'flex', justifyContent: 'center' }}>
                      <Switch
                        size="small"
                        checked={device.critical}
                        onChange={(event) =>
                          void act(() => updateHomeDevice(device.id, { critical: event.target.checked }))
                        }
                        slotProps={{ input: { 'aria-label': `Warn me about ${device.name}` } }}
                      />
                    </Box>
  
                    <Box
                      sx={{
                        width: COLS.action,
                        flex: `0 0 ${COLS.action}px`,
                        display: 'flex',
                        justifyContent: 'flex-end',
                        gap: 0.5,
                      }}
                    >
                      {/*
                        The action cell holds a button and nothing else.

                        A text field lived here at first and overflowed a 108px column the
                        moment it appeared — the code entry needs more room than any table
                        cell should give it, so the button opens the row and the field lives
                        in the space below, where there is room for a hint about where to
                        find the code.
                      */}
                      {needsPairing(device) ? (
                        <Button
                          size="small"
                          variant={openId === device.id ? 'contained' : 'outlined'}
                          onClick={() => setOpenId(openId === device.id ? null : device.id)}
                        >
                          Pair
                        </Button>
                      ) : (
                        device.capabilities.includes('setOn') &&
                        !device.critical && (
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() =>
                              void act(() => commandHomeDevice(device.id, device.state?.on ? 'off' : 'on'))
                            }
                          >
                            Turn {device.state?.on ? 'off' : 'on'}
                          </Button>
                        )
                      )}
                      {!needsPairing(device) && (
                        <Button
                          size="small"
                          variant="text"
                          onClick={() => setOpenId(openId === device.id ? null : device.id)}
                          sx={{ minWidth: 30, color: solar.ink.dim }}
                          aria-label={openId === device.id ? 'Hide settings' : 'Show settings'}
                        >
                          {openId === device.id ? '−' : '+'}
                        </Button>
                      )}
                    </Box>
                  </Box>
  
                  <Collapse in={openId === device.id}>
                    <Box sx={{ pl: '44px', pb: 2.5, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <Typography variant="caption" sx={{ color: solar.ink.dim }}>
                        {device.host}
                      </Typography>
                      {/*
                        The code entry, given room. HomeKit codes are eight digits in a
                        fixed shape, so the field says so rather than leaving you to guess
                        whether the dashes matter.
                      */}
                      {needsPairing(device) && (
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <Typography variant="caption" sx={{ color: solar.ink.sec }}>
                            Enter the eight-digit HomeKit code printed on the thermostat, or in its
                            box.
                          </Typography>
                          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                            <TextField
                              size="small"
                              placeholder="123-45-678"
                              value={pinFor === device.id ? pin : ''}
                              onChange={(event) => {
                                setPinFor(device.id);
                                setPin(event.target.value);
                              }}
                              sx={{ width: 160 }}
                              slotProps={{ htmlInput: { 'aria-label': 'HomeKit pairing code' } }}
                            />
                            <Button
                              size="small"
                              variant="contained"
                              disabled={pinFor !== device.id || pin.trim().length < 8}
                              onClick={() =>
                                void act(async () => {
                                  await pairHomeDevice(device.id, pin);
                                  setPinFor(null);
                                  setPin('');
                                })
                              }
                            >
                              Pair
                            </Button>
                          </Box>
                        </Box>
                      )}
                      {device.capabilities.includes('setTargetTemperature') && !device.critical && (
                        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                          <Typography variant="caption" sx={{ color: solar.ink.sec }}>
                            Target
                          </Typography>
                          {[-0.5, 0.5].map((delta) => (
                            <Button
                              key={delta}
                              size="small"
                              variant="outlined"
                              disabled={device.state?.setpointC === null || device.state?.setpointC === undefined}
                              onClick={() =>
                                void act(() =>
                                  commandHomeDevice(device.id, 'setTarget', (device.state?.setpointC ?? 20) + delta),
                                )
                              }
                            >
                              {delta > 0 ? '+' : '−'}½°
                            </Button>
                          ))}
                        </Box>
                      )}
                      {device.state?.powerW == null && device.kind !== 'thermostat' && (
                        <LoadEditor
                          deviceId={device.id}
                          current={readLoad(device.config)}
                          onSaved={() => {
                            refresh();
                            refreshUsage();
                          }}
                        />
                      )}
                      {device.capabilities.length > 0 && <DeviceSchedules device={device} />}
                    </Box>
                  </Collapse>
                </Box>
              );
            })}
  
            {/*
              A button, not a sentence pointing at a panel. The old copy said "search your
              network below" and there is no longer a below — the flow it described is now
              behind this.
            */}
            {(devices ?? []).length === 0 && (
              <Button
                variant="outlined"
                sx={{ alignSelf: 'flex-start', my: 2.5 }}
                onClick={() => setAdding(true)}
              >
                Add your first device
              </Button>
            )}
  
            
          </Box>
        </Surface>
  
        </Box>
        <Box
          sx={{
            width: { xs: '100%', lg: 420 },
            flex: { lg: '0 0 420px' },
            display: 'flex',
            flexDirection: 'column',
            gap: 2.5,
          }}
        >
        {usage && usage.length > 0 && (
          <Surface title="How much they're used" action={<Typography variant="caption" sx={{ color: solar.ink.dim }}>last 7 days</Typography>}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.2 }}>
              {usage.map((u) => {
                /*
                  Bars are scaled against the busiest device rather than a fixed maximum, so
                  a house where nothing runs much still shows a readable comparison.
                */
                const busiest = Math.max(...usage.map((x) => x.onHoursPerDay), 0.1);
                /*
                No floor. A minimum width turned "0 h/day" into a small dot that looks like
                a measurement, when the honest rendering of nothing is an empty track.
              */
              const width = u.onHoursPerDay > 0 ? Math.round((u.onHoursPerDay / busiest) * 100) : 0;
                const perMonth =
                  u.energyKwh !== null && retail > 0
                    ? monthlyCost([u], retail)
                    : null;
                return (
                  <Box key={u.deviceId} sx={{ display: 'flex', flexDirection: 'column', gap: 0.9 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 2 }}>
                      <Typography sx={{ font: `500 13px/1.3 ${solar.font.sans}`, color: solar.ink.pri }}>
                        {u.name}
                      </Typography>
                      <Typography variant="mono" sx={{ color: solar.ink.dim, fontSize: 12 }}>
                        {u.onHoursPerDay} h/day
                      </Typography>
                    </Box>
                    <Box sx={{ height: 8, borderRadius: '3px', background: solar.surface.raised, overflow: 'hidden' }}>
                      <Box
                        sx={{
                          width: `${width}%`,
                          height: '100%',
                          borderRadius: '3px',
                          background: u.metered ? solar.series.production : solar.ink.dim,
                        }}
                      />
                    </Box>
                    {/*
                      Cost where it is knowable, and silence where it is not. The old card
                      printed a paragraph of advice under every unmetered device; the design
                      says it once, below, for all of them.
                    */}
                    {/*
                      A cost line only where there is a cost. Repeating "cost unknown" under
                      every row said the same thing three times, and then a fourth time in
                      the note below — the design's whole point is to say it once.
                    */}
                    {perMonth && (
                      <Typography variant="caption" sx={{ color: solar.ink.dim }}>
                        {perMonth}
                        {u.metered ? '' : ' · estimated'}
                      </Typography>
                    )}
                  </Box>
                );
              })}
            </Box>
                      </Surface>
        )}
  
        </Box>
      </Box>
      <AddDeviceFlow open={adding} onClose={() => setAdding(false)} onChanged={() => { refresh(); refreshUsage(); }} />
    </Box>
  );
}
