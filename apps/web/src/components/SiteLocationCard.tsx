import { ReactElement, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { SiteLocation, fetchHome, fetchSiteLocation, saveSiteLocation } from '../api';
import { Hint } from './Hint';
import { Surface } from './Surface';
import { useBrowserLocation } from '../shell/geolocation';
import { solar } from '../theme';

/**
 * Where the array is: it decides the forecast, sunrise and sunset, expected-vs-actual, the
 * cloud panel and which radar covers you.
 *
 * An empty `SITE_LATITUDE=` in .env is '' rather than unset, and `Number('')` is 0 — which
 * puts the install at 0°, 0° in the Gulf of Guinea and returns real weather for it, with no
 * error anywhere.
 */
export function SiteLocationCard(): ReactElement {
  const [location, setLocation] = useState<SiteLocation | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [carPosition, setCarPosition] = useState<{ latitude: number; longitude: number } | null>(null);
  // The car's saved home, when it has one of its own — on installs predating this card the
  // right coordinates are already in the database under that key.
  const [carHome, setCarHome] = useState<{ latitude: number; longitude: number } | null>(null);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const geo = useBrowserLocation();

  const load = useCallback(() => {
    fetchSiteLocation()
      .then(({ location: next }) => {
        setLocation(next);
        setLat(next ? String(next.latitude) : '');
        setLon(next ? String(next.longitude) : '');
      })
      .catch(() => setLocation(null))
      .finally(() => setLoaded(true));
    // The car is usually parked on the property while this is being set up. Fails quietly:
    // most installs have no vehicle.
    fetchHome()
      .then((home) => {
        setCarPosition(home.carPosition);
        // Only when home holds coordinates of its own. In `site` mode it is reading this
        // setting, and offering to copy it back here would be a loop.
        setCarHome(home.mode === 'manual' ? home.home : null);
      })
      .catch(() => {
        setCarPosition(null);
        setCarHome(null);
      });
  }, []);

  useEffect(load, [load]);

  const submit = (): void => {
    setBusy(true);
    setResult(null);
    saveSiteLocation({ latitude: Number(lat), longitude: Number(lon) })
      .then(() => {
        setResult({ ok: true, message: 'Saved — the forecast and daylight hours now use this.' });
        load();
      })
      .catch((error: Error) => setResult({ ok: false, message: error.message }))
      .finally(() => setBusy(false));
  };

  const changed = location === null || String(location.latitude) !== lat || String(location.longitude) !== lon;

  return (
    <Surface
      title="Site location"
      action={
        <Typography variant="mono" sx={{ color: location ? solar.ink.sec : solar.ink.faint }}>
          {location ? `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}` : 'not set'}
        </Typography>
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Typography variant="body2" color="text.secondary">
          Where the panels are.
          <Hint>
            This decides the forecast, sunrise and sunset, how much output to expect for the
            time of year, the cloud reading beside irradiance, and which radar covers you.
            Unset, those features stay off — someone else&rsquo;s forecast is worse than none,
            because it looks like data.
          </Hint>
        </Typography>

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 3 }}>
          <TextField
            size="small"
            label="Latitude"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="45.4236"
          />
          <TextField
            size="small"
            label="Longitude"
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            placeholder="-75.7000"
          />
        </Box>

        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          {/*
            First, because it is the only one of these three that a fresh install can use. The
            car buttons below need a vehicle integration, which is something people add later
            if at all — the array is the reason they installed this.
          */}
          {geo.supported && (
            <Button
              size="small"
              variant="outlined"
              disabled={busy || geo.busy}
              onClick={() => {
                void geo.request().then((found) => {
                  if (!found) return;
                  setLat(found.latitude.toFixed(5));
                  setLon(found.longitude.toFixed(5));
                  setAccuracyM(found.accuracyM);
                  setResult(null);
                });
              }}
            >
              {geo.busy ? 'Locating…' : 'Use this device'}
            </Button>
          )}
          {carHome && (
            <Button
              size="small"
              variant="outlined"
              disabled={busy}
              onClick={() => {
                setLat(String(carHome.latitude));
                setLon(String(carHome.longitude));
                setResult(null);
              }}
            >
              Use the car&rsquo;s home
            </Button>
          )}
          {carPosition && (
            <Button
              size="small"
              variant="outlined"
              disabled={busy}
              onClick={() => {
                setLat(String(carPosition.latitude));
                setLon(String(carPosition.longitude));
                setResult(null);
              }}
            >
              Use the car&rsquo;s location
            </Button>
          )}
          <Button
            size="small"
            variant="contained"
            disabled={busy || lat === '' || lon === '' || !changed}
            onClick={submit}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </Box>

        {/*
          Said plainly rather than left to be inferred from a blank field. An install that
          reads "not set" here is one where five features are silently switched off, and
          nothing else on the page would tell you which.
        */}
        {loaded && !location && (
          <Alert severity="info">
            Not set, so the forecast, daylight hours, expected output, cloud cover and radar are
            all off. Two numbers turn them on.
          </Alert>
        )}

        {/*
          Accuracy shown rather than swallowed. A wifi-derived fix can be a kilometre out —
          fine for a forecast, misleading if somebody takes it for GPS.
        */}
        {accuracyM !== null && (
          <Typography variant="caption" color="text.disabled">
            From this device, to about {Math.round(accuracyM)} m. Correct it by hand if this
            browser is not at the house.
          </Typography>
        )}
        {geo.error && <Alert severity="warning">{geo.error}</Alert>}

        {result && <Alert severity={result.ok ? 'success' : 'warning'}>{result.message}</Alert>}
      </Box>
    </Surface>
  );
}
