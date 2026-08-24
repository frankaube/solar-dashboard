import { ReactElement, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { Link } from 'react-router-dom';
import { HomeMode, HomeSettings, fetchHome, followSiteAtHome, saveHome } from '../api';
import { Hint } from './Hint';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * Telling the app where home is, which is usually where the panels are.
 *
 * The Car page used to say "Parked in the garage" — not from a location, but as the else
 * branch of a Wall Connector check. It said so while the car was doing 47 km/h. Replacing
 * that guess with a fact needs someone to say which patch of ground is home, and nothing
 * in the app could.
 *
 * TeslaMate has a geofences table, but it is empty on a fresh install and writing into it
 * would break the rule that integration keeps: TeslaMate owns its schema, we only read.
 * So this lives in the app's own settings.
 *
 * It defaults to following the site rather than holding a second copy. The array and the
 * driveway are the same place in all but the odd install, and two independently-editable
 * records of one fact do not stay equal — they drift, both look set, and nothing surfaces
 * which one is stale. Following means there is one place to correct and no way to disagree.
 */
export function HomeLocationCard(): ReactElement {
  const [state, setState] = useState<HomeSettings | null>(null);
  const [mode, setMode] = useState<HomeMode>('site');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [radius, setRadius] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(() => {
    fetchHome()
      .then((next) => {
        setState(next);
        // Defaulted rather than trusted: a browser holding a newer bundle than the API it is
        // talking to gets no `mode` back, and an unset RadioGroup renders with neither option
        // chosen — a form that looks broken rather than one that looks unconfigured.
        setMode(next.mode ?? 'site');
        /*
          Seed the manual fields from whatever is on offer — the current home, or the site if
          following it. Someone switching to "a different place" almost always wants to nudge
          the coordinates rather than find them from scratch.
        */
        const seed = next.mode === 'manual' ? next.home : (next.home ?? next.site);
        setLat(seed ? String(seed.latitude) : '');
        setLon(seed ? String(seed.longitude) : '');
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
    setBusy(true);
    setResult(null);
    const request =
      mode === 'site'
        ? followSiteAtHome(Number(radius))
        : saveHome({ latitude: Number(lat), longitude: Number(lon), radiusM: Number(radius) });
    request
      .then(() => {
        setResult({ ok: true, message: 'Saved — the Car page will say whether it is home.' });
        load();
      })
      .catch((error: Error) => setResult({ ok: false, message: error.message }))
      .finally(() => setBusy(false));
  };

  const carSeenAt = state?.carPosition
    ? new Date(state.carPosition.at).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

  const status = (): string => {
    if (!state?.home) return 'not set';
    return state.mode === 'site' ? `same as site · ${state.home.radiusM} m` : `set · ${state.home.radiusM} m`;
  };

  return (
    <Surface
      title="Home"
      action={
        <Typography variant="mono" sx={{ color: state?.home ? solar.ink.sec : solar.ink.faint }}>
          {status()}
        </Typography>
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Typography variant="body2" color="text.secondary">
          Where your driveway is.
          <Hint>
            With this set the Car page can say the car is parked at home rather than just
            parked. Without it the page says nothing about location, which is the honest answer.
          </Hint>
        </Typography>

        <RadioGroup value={mode} onChange={(e) => { setMode(e.target.value as HomeMode); setResult(null); }}>
          <FormControlLabel
            value="site"
            control={<Radio size="small" />}
            label={
              <Typography variant="body2">
                Same place as the panels
                {state?.site ? (
                  <Typography component="span" variant="mono" sx={{ color: solar.ink.sec, ml: 2 }}>
                    {state.site.latitude.toFixed(4)}, {state.site.longitude.toFixed(4)}
                  </Typography>
                ) : (
                  <Typography component="span" variant="caption" sx={{ color: solar.ink.faint, ml: 2 }}>
                    — no site location set yet
                  </Typography>
                )}
              </Typography>
            }
          />
          <FormControlLabel
            value="manual"
            control={<Radio size="small" />}
            label={<Typography variant="body2">A different place</Typography>}
          />
        </RadioGroup>

        {/*
          The site is set on the Hardware tab. Linked rather than duplicated here — a second
          form writing the same setting is how the two got out of step in the first place.
        */}
        {mode === 'site' && !state?.site && (
          <Alert severity="info">
            No site location yet, so the car cannot be said to be home.{' '}
            <Link to="/settings/hardware">Set where the panels are</Link>, and this follows it.
          </Alert>
        )}

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: mode === 'manual' ? '1fr 1fr 130px' : '130px' },
            gap: 3,
          }}
        >
          {mode === 'manual' && (
            <>
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
            </>
          )}
          {/* Radius belongs to the car in either mode — it is about GPS drift, not about where. */}
          <TextField
            size="small"
            label="Radius (m)"
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
            helperText="20–2000"
          />
        </Box>

        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          {mode === 'manual' && (
            <Button
              size="small"
              variant="outlined"
              disabled={!state?.carPosition || busy}
              onClick={useCarPosition}
            >
              Use the car&rsquo;s location
            </Button>
          )}
          <Button
            size="small"
            variant="contained"
            disabled={busy || (mode === 'manual' && (lat === '' || lon === ''))}
            onClick={submit}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </Box>

        {/* Say why the button is dead rather than leaving it greyed out for no visible reason. */}
        {mode === 'manual' && (
          <Typography variant="caption" color="text.disabled">
            {state?.carPosition
              ? `The car last reported a position ${carSeenAt}. Park it at home and use that.`
              : 'No position from the car yet — connect TeslaMate above, or type the coordinates.'}
          </Typography>
        )}

        {result && <Alert severity={result.ok ? 'success' : 'warning'}>{result.message}</Alert>}
      </Box>
    </Surface>
  );
}
