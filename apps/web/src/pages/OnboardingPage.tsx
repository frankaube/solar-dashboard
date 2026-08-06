import { ReactElement, ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  DiscoveredHomeDevice,
  ScanResult,
  adoptHomeDevice,
  completeOnboarding,
  fetchOnboarding,
  saveConfig,
  saveDevices,
  saveNotifications,
  saveSiteLocation,
  scanForDevices,
  scanHomeDevices,
  setDemoHouse,
  setDemoMode,
} from '../api';
import { Surface } from '../components/Surface';
import { useBrowserLocation } from '../shell/geolocation';
import { solar } from '../theme';

type Phase = 'idle' | 'solar' | 'devices' | 'done';
type SectionState = 'pending' | 'scanning' | 'found' | 'empty';

interface SectionProps {
  icon: string;
  title: string;
  state: SectionState;
  children?: ReactNode;
}

function Section({ icon, title, state, children }: SectionProps): ReactElement {
  const badge: Record<SectionState, ReactElement> = {
    pending: <Typography variant="caption" color="text.disabled">waiting</Typography>,
    scanning: <CircularProgress size={16} sx={{ color: solar.series.production }} />,
    found: <Typography variant="caption" sx={{ color: solar.status.ok }}>✓ found</Typography>,
    empty: <Typography variant="caption" color="text.disabled">none found</Typography>,
  };
  return (
    <Surface sx={{ opacity: state === 'pending' ? 0.6 : 1, transition: 'opacity .3s' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, mb: children ? 3 : 0 }}>
        <Typography sx={{ fontSize: 22 }}>{icon}</Typography>
        <Typography variant="subtitle1" sx={{ flex: 1 }}>
          {title}
        </Typography>
        {badge[state]}
      </Box>
      {children}
    </Surface>
  );
}

export function OnboardingPage(): ReactElement {
  const navigate = useNavigate();
  const [subnet, setSubnet] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [solarScan, setSolarScan] = useState<ScanResult | null>(null);
  const [deviceScan, setDeviceScan] = useState<DiscoveredHomeDevice[] | null>(null);
  const [adopted, setAdopted] = useState<Set<string>>(new Set());
  const [price, setPrice] = useState('0.16');
  const [notify, setNotify] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const geo = useBrowserLocation();

  useEffect(() => {
    fetchOnboarding()
      .then((status) => {
        setSubnet(status.suggestedSubnet);
        setSuggestions(status.subnetSuggestions);
      })
      .catch(() => setSubnet('192.168.1'));
  }, []);

  const solarState: SectionState =
    phase === 'idle' || phase === 'solar'
      ? phase === 'solar'
        ? 'scanning'
        : 'pending'
      : (solarScan?.dtus.length ?? 0) > 0
        ? 'found'
        : 'empty';
  const chargerFound = (solarScan?.chargers.length ?? 0) > 0;
  const deviceState: SectionState =
    phase === 'devices'
      ? 'scanning'
      : phase === 'done'
        ? (deviceScan?.length ?? 0) > 0
          ? 'found'
          : 'empty'
        : 'pending';

  const runScan = async (): Promise<void> => {
    setError(null);
    setSolarScan(null);
    setDeviceScan(null);
    try {
      setPhase('solar');
      const solarResult = await scanForDevices(subnet);
      setSolarScan(solarResult);
      // Auto-adopt the solar gateway — it's the core; nothing works without it.
      if (solarResult.dtus[0]) {
        await saveDevices({
          dtuHost: solarResult.dtus[0].host,
          solarVendor: solarResult.dtus[0].vendor,
        });
      }
      if (solarResult.chargers[0]) {
        await saveDevices({ chargerHost: solarResult.chargers[0].host });
      }
      setPhase('devices');
      const result = await scanHomeDevices(subnet);
      setDeviceScan(result.devices);
      setPhase('done');
    } catch (err) {
      setError((err as Error).message);
      setPhase('idle');
    }
  };

  const adopt = async (device: DiscoveredHomeDevice): Promise<void> => {
    await adoptHomeDevice(device);
    setAdopted((prev) => new Set(prev).add(`${device.vendor}-${device.host}`));
  };

  const finish = async (): Promise<void> => {
    if (price.trim()) await saveConfig({ electricityPricePerKwh: Number(price) });
    if (notify.trim()) await saveNotifications(notify.trim());
    /*
      Saved only when both were filled, and never allowed to block finishing. Location turns
      features on rather than being required to run, so a bad pair here — a typo, a refused
      permission — must not trap somebody on the last screen of setup. It is correctable in
      Settings, and the API refuses what it should.
    */
    if (lat.trim() && lon.trim()) {
      await saveSiteLocation({ latitude: Number(lat), longitude: Number(lon) }).catch(() => undefined);
    }
    await completeOnboarding();
    navigate('/');
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: 'background.default',
        display: 'flex',
        justifyContent: 'center',
        p: { xs: 4, md: 8 },
      }}
    >
      <Box sx={{ width: '100%', maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <Box>
          <Box
            sx={{
              width: 44,
              height: 44,
              borderRadius: '11px',
              bgcolor: solar.series.production,
              color: solar.on.gold,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700, fontSize: 22, lineHeight: 1,
              mb: 3,
            }}
          >
            S
          </Box>
          <Typography variant="metricMd" sx={{ display: 'block', mb: 1 }}>
            Welcome to Solar Dashboard
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Let's find your gear. One gentle scan of your network looks for a solar gateway, an
            EV charger, and smart devices — nothing leaves your home.
          </Typography>
        </Box>

        {phase === 'idle' && (
          <Surface sx={{ bgcolor: 'transparent', borderStyle: 'dashed' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
              <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                Just looking? Describe your house — or the one you are considering — and see the
                whole app filled with what it would produce. Nothing is scanned and no hardware is
                needed.
              </Typography>
              {/*
                The builder leads, because "see YOUR house" is a better offer than "see
                a house", and it is the only version of this that answers the question
                someone actually arrives with. The fixed demo stays as the one-click
                path for anyone who just wants to look around.
              */}
              <Button variant="contained" onClick={() => navigate('/builder')}>
                Build your house
              </Button>
              <Button
                variant="outlined"
                onClick={() => {
                  setDemoMode(true);
                  setDemoHouse(null);
                  navigate('/');
                  window.location.reload();
                }}
              >
                Just show me one
              </Button>
            </Box>
          </Surface>
        )}

        {phase === 'idle' && (
          <Surface title="Which network?">
            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
              <TextField
                size="small"
                value={subnet}
                onChange={(event) => setSubnet(event.target.value)}
                helperText="first three numbers of your home IP"
                sx={{ width: 180 }}
              />
              <Button variant="contained" onClick={() => void runScan()} disabled={!subnet}>
                Scan my network
              </Button>
            </Box>
            {suggestions.length > 1 && (
              <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
                {suggestions.map((option) => (
                  <Chip
                    key={option}
                    size="small"
                    label={`${option}.x`}
                    variant={subnet === option ? 'filled' : 'outlined'}
                    onClick={() => setSubnet(option)}
                  />
                ))}
              </Box>
            )}
          </Surface>
        )}

        {error && (
          <Typography variant="body2" sx={{ color: solar.status.critical }}>
            {error}
          </Typography>
        )}

        {phase !== 'idle' && (
          <>
            <Section icon="⚡" title="Solar gateway" state={solarState}>
              {solarScan?.dtus.map((dtu) => (
                <Typography key={dtu.host} variant="body2">
                  {dtu.serialNumber} · {dtu.inverterCount} inverters / {dtu.pvCount} panels ·{' '}
                  <Typography component="span" sx={{ color: solar.status.ok }}>
                    connected
                  </Typography>
                </Typography>
              ))}
              {solarState === 'empty' && (
                <Typography variant="body2" color="text.secondary">
                  No solar gateway found on {subnet}.x — check the subnet, or add it later in Settings.
                </Typography>
              )}
            </Section>

            <Section
              icon="🚗"
              title="EV charger"
              state={phase === 'solar' ? 'pending' : chargerFound ? 'found' : 'empty'}
            >
              {solarScan?.chargers.map((charger) => (
                <Typography key={charger.host} variant="body2">
                  Wall Connector at {charger.host} ·{' '}
                  <Typography component="span" sx={{ color: solar.status.ok }}>
                    connected
                  </Typography>
                </Typography>
              ))}
            </Section>

            <Section icon="🔌" title="Smart devices" state={deviceState}>
              {deviceScan?.map((device) => (
                <Box
                  key={`${device.vendor}-${device.host}`}
                  sx={{ display: 'flex', alignItems: 'center', gap: 2, py: '4px' }}
                >
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    {device.name}{' '}
                    <Typography component="span" variant="caption" color="text.disabled">
                      ({device.model ?? device.vendor})
                    </Typography>
                  </Typography>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={adopted.has(`${device.vendor}-${device.host}`)}
                    onClick={() => void adopt(device)}
                  >
                    {adopted.has(`${device.vendor}-${device.host}`) ? 'Added' : 'Add'}
                  </Button>
                </Box>
              ))}
            </Section>
          </>
        )}

        {phase === 'done' && (
          <Surface title="A few last details">
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {/*
                Location leads, because it is the one a scan cannot find and the one the most
                depends on — forecast, sunrise and sunset, how much output to expect for the
                time of year, cloud cover, radar.

                It was asked for nowhere at all until now. The setting existed, the installer
                seeded it blank, and blank parsed as 0°, 0° — a real coordinate in the Gulf of
                Guinea that returns real weather, so every one of those features worked and
                described the wrong hemisphere. Asking here is what stops that being the
                default outcome of installing this.
              */}
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <Typography variant="body2" color="text.secondary">
                  Where are the panels? This sets the forecast, your daylight hours and how much
                  output to expect. Leave it and those stay off.
                </Typography>
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                  <TextField
                    label="Latitude"
                    size="small"
                    value={lat}
                    onChange={(event) => setLat(event.target.value)}
                    placeholder="45.4236"
                    sx={{ width: 150 }}
                  />
                  <TextField
                    label="Longitude"
                    size="small"
                    value={lon}
                    onChange={(event) => setLon(event.target.value)}
                    placeholder="-75.7000"
                    sx={{ width: 150 }}
                  />
                  {geo.supported && (
                    <Button
                      variant="outlined"
                      size="small"
                      disabled={geo.busy}
                      onClick={() => {
                        void geo.request().then((found) => {
                          if (!found) return;
                          setLat(found.latitude.toFixed(5));
                          setLon(found.longitude.toFixed(5));
                          setAccuracyM(found.accuracyM);
                        });
                      }}
                    >
                      {geo.busy ? 'Locating…' : 'Use this device'}
                    </Button>
                  )}
                </Box>
                {/*
                  Accuracy shown rather than swallowed. A wifi-derived fix can be a kilometre
                  out, which is fine for a forecast and not fine if somebody assumes it is GPS.
                */}
                {accuracyM !== null && (
                  <Typography variant="caption" color="text.disabled">
                    From this device, to about {Math.round(accuracyM)} m. Fine for weather —
                    correct it in Settings if this browser is not at the house.
                  </Typography>
                )}
                {geo.error && (
                  <Typography variant="caption" sx={{ color: solar.status.warn }}>
                    {geo.error}
                  </Typography>
                )}
              </Box>

              <TextField
                label="Electricity price ($/kWh)"
                size="small"
                type="number"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
              <TextField
                label="Notifications (ntfy topic, optional)"
                size="small"
                value={notify}
                onChange={(event) => setNotify(event.target.value)}
                helperText="a made-up word; subscribe to it in the ntfy app for phone alerts"
              />
            </Box>
          </Surface>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button color="inherit" onClick={() => void finish()} sx={{ color: 'text.disabled' }}>
            Skip for now
          </Button>
          {phase === 'done' && (
            <Button variant="contained" onClick={() => void finish()}>
              Finish setup
            </Button>
          )}
        </Box>
      </Box>
    </Box>
  );
}
