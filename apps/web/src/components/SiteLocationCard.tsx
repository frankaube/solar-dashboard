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
 * Where the array is.
 *
 * This had no UI at all until now, which is not a small omission: it decides the forecast,
 * sunrise and sunset, expected-vs-actual, the cloud panel and which radar covers you. The
 * only ways to set it were an environment variable and a REST call.
 *
 * That gap had a second half. The Pi installer wrote `SITE_LATITUDE=` into .env, and an
 * empty environment variable is '' rather than unset, so `Number('')` made every install of
 * that vintage sit at 0°, 0° — a real coordinate in the Gulf of Guinea, which returns real
 * weather. Nothing errored. A roof at 46°N was simply told it got twelve hours of August
 * daylight instead of fifteen, and every figure derived from that was wrong in a way
 * no error message would ever mention.
 */
export function SiteLocationCard(): ReactElement {
  const [location, setLocation] = useState<SiteLocation | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [carPosition, setCarPosition] = useState<{ latitude: number; longitude: number } | null>(null);
  /*
    The car's saved home, when it has one of its own.

    Every install that predates this card is in exactly that state: home was typed in months
    ago because the Car page needed it, and the site — which drives far more — was never
    asked for. The coordinates are already right and already in the database, under the other
    key. Offering to copy them is the whole upgrade path.
  */
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
    /*
      The car, if there is one, is usually parked on the property while somebody is setting
      this up — and it knows where that is to more decimal places than a map click. Failing
      quietly is right: most installs have no vehicle, and that is not a problem to report.
    */
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
