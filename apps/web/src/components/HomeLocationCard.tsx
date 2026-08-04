import { ReactElement, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { HomeSettings, clearHome, fetchHome, saveHome } from '../api';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * Telling the app where home is.
 *
 * The Car page used to say "Parked in the garage" — not from a location, but as the else
 * branch of a Wall Connector check. It said so while the car was doing 47 km/h. Replacing
 * that guess with a fact needs someone to say which patch of ground is home, and nothing
 * in the app could.
 *
 * TeslaMate has a geofences table, but it is empty on a fresh install and writing into it
 * would break the rule that integration keeps: TeslaMate owns its schema, we only read.
 * So this lives in the app's own settings.
 */
export function HomeLocationCard(): ReactElement {
  const [state, setState] = useState<HomeSettings | null>(null);
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [radius, setRadius] = useState('');
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(() => {
    fetchHome()
      .then((next) => {
        setState(next);
        setLat(next.home ? String(next.home.latitude) : '');
        setLon(next.home ? String(next.home.longitude) : '');
        setRadius(String(next.home?.radiusM ?? next.defaultRadiusM));
      })
      .catch(() => setState(null));
  }, []);

  useEffect(load, [load]);

  /*
    Filling the form from the car.

    The alternative is asking someone to leave the app, find their house on a map, and copy
    six decimal places back by hand. The car is usually sitting in the driveway while this
    is being set up and already knows exactly where that is — to a better precision than a
    map click, and with no chance of a transcription slip.
  */
  const useCarPosition = (): void => {
    if (!state?.carPosition) return;
    setLat(String(state.carPosition.latitude));
    setLon(String(state.carPosition.longitude));
    setResult(null);
  };

  const submit = (): void => {
    setBusy('save');
    setResult(null);
    saveHome({ latitude: Number(lat), longitude: Number(lon), radiusM: Number(radius) })
      .then(() => {
        setResult({ ok: true, message: 'Saved — the Car page will say whether it is home.' });
        load();
      })
      .catch((error: Error) => setResult({ ok: false, message: error.message }))
      .finally(() => setBusy(null));
  };

  const carSeenAt = state?.carPosition
    ? new Date(state.carPosition.at).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

  return (
    <Surface
      title="Home"
      action={
        <Typography variant="mono" sx={{ color: state?.home ? solar.ink.sec : solar.ink.faint }}>
          {state?.home ? `set · ${state.home.radiusM} m` : 'not set'}
        </Typography>
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Typography variant="body2" color="text.secondary">
          Where your driveway is. With this set the Car page can say the car is parked at
          home rather than just parked — without it, it says nothing about location, which
          is the honest answer.
        </Typography>

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 130px' }, gap: 3 }}>
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
          <TextField
            size="small"
            label="Radius (m)"
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
            helperText="20–2000"
          />
        </Box>

        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button
            size="small"
            variant="outlined"
            disabled={!state?.carPosition || busy !== null}
            onClick={useCarPosition}
          >
            Use the car&rsquo;s location
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={busy !== null || lat === '' || lon === ''}
            onClick={submit}
          >
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
          {state?.home && (
            <Button
              size="small"
              color="inherit"
              disabled={busy !== null}
              onClick={() => {
                setBusy('clear');
                setResult(null);
                clearHome()
                  .then(load)
                  .finally(() => setBusy(null));
              }}
            >
              Clear
            </Button>
          )}
        </Box>

        {/* Say why the button is dead rather than leaving it greyed out for no visible reason. */}
        <Typography variant="caption" color="text.disabled">
          {state?.carPosition
            ? `The car last reported a position ${carSeenAt}. Park it at home and use that.`
            : 'No position from the car yet — connect TeslaMate above, or type the coordinates.'}
        </Typography>

        {result && <Alert severity={result.ok ? 'success' : 'warning'}>{result.message}</Alert>}
      </Box>
    </Surface>
  );
}
