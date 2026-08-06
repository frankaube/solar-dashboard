import { ReactElement, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { FuelSettings, fetchFuelSettings, saveFuelSettings } from '../api';
import { Hint } from './Hint';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * The two assumptions behind "instead of gasoline", and where its prices come from.
 *
 * Both used to be constants inside the Car page — `9` and `1.6` — which made them not
 * merely wrong but unreachable: nothing on any screen could change them and nothing
 * admitted they existed. The price is now looked up per month from a published series; the
 * car is not, and cannot be. Nobody publishes the fuel economy of a vehicle that was never
 * bought.
 *
 * Deliberately no default place. Guessing one would price a Vancouver owner's drives at
 * a pump three time zones away and be wrong in a way nothing on the page could reveal.
 */
export function FuelPriceCard(): ReactElement {
  const [server, setServer] = useState<FuelSettings | null>(null);
  const [litres, setLitres] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    fetchFuelSettings()
      .then((value) => {
        setServer(value);
        setLitres(value.litresPer100Km === null ? '' : String(value.litresPer100Km));
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  };
  useEffect(load, []);

  const save = async (patch: { geography?: string; litresPer100Km?: number }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await saveFuelSettings(patch);
      setServer(next);
      if (next.litresPer100Km !== null) setLitres(String(next.litresPer100Km));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!server) {
    return (
      <Surface title="Petrol comparison">
        <Typography variant="body2" color="text.secondary">
          {error ?? 'Loading…'}
        </Typography>
      </Surface>
    );
  }

  const lag =
    server.newestMonth === null
      ? null
      : Math.round(
          (Date.now() - new Date(`${server.newestMonth}-01T00:00:00Z`).getTime()) / 86_400_000,
        );

  return (
    <Surface title="Petrol comparison">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Prices your driving against the petrol it did not burn.
        <Hint>
          Each drive uses the published average for the month it happened in, not today's price.
          Over the last eighteen months that figure has moved by nearly half, so a flat current
          price does not misprice an old drive slightly — it misprices it by half.
        </Hint>
      </Typography>

      <TextField
        select
        fullWidth
        size="small"
        label="Price these drives against"
        value={server.geography ?? ''}
        disabled={busy}
        onChange={(event) => void save({ geography: event.target.value })}
        helperText="The nearest place the published series covers. No default — a guessed city is wrong in a way nothing here could show you."
        sx={{ mb: 2 }}
      >
        {server.geographies.map((geography) => (
          <MenuItem key={geography.id} value={geography.id}>
            {geography.name}
          </MenuItem>
        ))}
      </TextField>

      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
        <TextField
          size="small"
          label="Comparison car"
          value={litres}
          disabled={busy}
          onChange={(event) => setLitres(event.target.value)}
          slotProps={{ input: { endAdornment: <Typography variant="caption">L/100 km</Typography> } }}
          helperText="The petrol car you would otherwise be driving. This one is an assumption however good the prices get — no feed knows a car nobody bought."
        />
        <Button
          size="small"
          variant="contained"
          disabled={busy || litres.trim() === ''}
          onClick={() => void save({ litresPer100Km: Number(litres) })}
          sx={{ mt: 0.5 }}
        >
          Save
        </Button>
      </Box>

      {error && (
        <Typography variant="caption" sx={{ color: solar.status.critical, display: 'block', mt: 1 }}>
          {error}
        </Typography>
      )}

      <Box sx={{ mt: 2, pt: 2, borderTop: `1px solid ${solar.surface.border}` }}>
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
          {server.months === 0
            ? 'No prices stored yet. Choose a place above and they are fetched immediately.'
            : `${server.months} months stored, newest ${server.newestMonth} at ${server.newestCentsPerLitre?.toFixed(1)}¢/L.`}
        </Typography>
        {/*
          The lag is the honest limit and belongs on screen, not in a commit message. The
          series is monthly and published in arrears, so recent drives are always priced at
          a carried-forward figure — the Car page says which distance that covers.
        */}
        {lag !== null && (
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.5 }}>
            That month ended about {lag} days ago. Published averages arrive in arrears, so
            drives since then are priced at the newest figure available and the Car page says
            how much of the distance that is.
          </Typography>
        )}
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.5 }}>
          {server.source}. Fetched once a day; nothing about this installation is sent with
          the request.
        </Typography>
      </Box>
    </Surface>
  );
}
