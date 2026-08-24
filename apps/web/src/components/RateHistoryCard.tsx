import { ReactElement, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { RateEntry, addRate, fetchRates, removeRate } from '../api';
import { Hint } from './Hint';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * What a kilowatt-hour cost, and when it started costing that.
 *
 * Until this existed the app held one price and applied it to all history, so the day a
 * utility raised its rate every figure it had ever shown changed with it — retroactively,
 * and with nothing on screen to say why. A savings total somebody wrote down last winter
 * stopped matching the one in front of them.
 *
 * Empty by default and honest about it: with nothing recorded the app uses the single price
 * above, exactly as it always has. This only starts mattering when a rate actually changes.
 */

const today = (): string => new Date().toISOString().slice(0, 10);

export function RateHistoryCard(): ReactElement {
  const [rates, setRates] = useState<RateEntry[] | null>(null);
  const [from, setFrom] = useState(today());
  const [price, setPrice] = useState('');
  const [tax, setTax] = useState('');
  const [includesTax, setIncludesTax] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchRates()
      .then(setRates)
      .catch(() => setRates(null));
  }, []);
  useEffect(load, [load]);

  const save = (): void => {
    setBusy(true);
    setError(null);
    addRate({
      effectiveFrom: from,
      pricePerKwh: Number(price),
      hstRate: Number(tax) / 100,
      priceIncludesTax: includesTax === '1',
    })
      .then((next) => {
        setRates(next);
        setPrice('');
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  /*
    The rate actually governing today, which is not simply the newest row: utilities
    announce changes in advance, so a rate dated next month is recorded now and must not
    be shown as the one in force. Newest row whose date has arrived.
  */
  const now = today();
  const inEffect = (rates ?? []).find((rate) => rate.effectiveFrom <= now) ?? null;

  return (
    <Surface title="When the price changed">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Record a rate change and every figure keeps the price it was actually worth.
        <Hint>
          Without this the app applies one price to all of history, so the day your utility
          raises its rate last year&rsquo;s savings change too — retroactively, with nothing
          on screen to say why. Leave it empty and the single price above is used for
          everything, exactly as before.
        </Hint>
      </Typography>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap', mb: 1 }}>
        <TextField
          size="small"
          type="date"
          label="In effect from"
          value={from}
          disabled={busy}
          onChange={(event) => setFrom(event.target.value)}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { 'aria-label': 'In effect from' } }}
          sx={{ width: 170 }}
        />
        <TextField
          size="small"
          type="number"
          label="Price"
          value={price}
          disabled={busy}
          onChange={(event) => setPrice(event.target.value)}
          slotProps={{
            htmlInput: { step: '0.0001', 'aria-label': 'Price per kWh' },
            input: {
              startAdornment: <InputAdornment position="start">$</InputAdornment>,
              endAdornment: <InputAdornment position="end">/kWh</InputAdornment>,
            },
          }}
          sx={{ width: 170 }}
        />
        <TextField
          size="small"
          type="number"
          label="Sales tax"
          value={tax}
          disabled={busy}
          onChange={(event) => setTax(event.target.value)}
          slotProps={{
            htmlInput: { step: '0.001', 'aria-label': 'Sales tax percent' },
            input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
          }}
          sx={{ width: 130 }}
        />
        <TextField
          select
          size="small"
          label="That price is"
          value={includesTax}
          disabled={busy}
          onChange={(event) => setIncludesTax(event.target.value)}
          sx={{ width: 190 }}
          slotProps={{ htmlInput: { 'aria-label': 'Whether the price includes tax' } }}
        >
          <MenuItem value="0">Before tax</MenuItem>
          <MenuItem value="1">After tax</MenuItem>
        </TextField>
        <Button
          variant="contained"
          disabled={busy || !price.trim() || !tax.trim()}
          onClick={save}
          sx={{ mt: '2px' }}
        >
          Record
        </Button>
      </Box>

      {error && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}

      {rates && rates.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', mt: 3 }}>
          {rates.map((rate) => (
            <Box
              key={rate.id}
              sx={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 2,
                py: 1.5,
                borderBottom: '1px solid',
                borderColor: 'divider',
                '&:last-of-type': { borderBottom: 'none' },
              }}
            >
              <Typography variant="mono" sx={{ fontSize: 12.5, color: solar.ink.sec, width: 100 }}>
                {rate.effectiveFrom}
              </Typography>
              <Typography variant="mono" sx={{ fontSize: 13, color: solar.ink.pri, flex: 1 }}>
                {(rate.pricePerKwh * 100).toFixed(2)}¢
                <Box component="span" sx={{ color: solar.ink.dim, ml: 1, fontSize: 11.5 }}>
                  {rate.priceIncludesTax ? 'incl.' : `+ ${(rate.hstRate * 100).toFixed(0)}% tax`}
                </Box>
                {inEffect?.id === rate.id && (
                  <Box component="span" sx={{ color: solar.status.ok, ml: 1.5, fontSize: 11.5 }}>
                    in effect now
                  </Box>
                )}
                {rate.effectiveFrom > now && (
                  <Box component="span" sx={{ color: solar.ink.dim, ml: 1.5, fontSize: 11.5 }}>
                    starts later
                  </Box>
                )}
              </Typography>
              <Button
                size="small"
                disabled={busy}
                onClick={() => void removeRate(rate.id).then(setRates)}
                sx={{ color: 'text.disabled', minWidth: 32 }}
              >
                ✕
              </Button>
            </Box>
          ))}
        </Box>
      )}

      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 3 }}>
        {rates && rates.length > 0
          ? 'Days before the earliest date here keep the single price above, so recording only an increase leaves everything before it exactly as it was.'
          : 'Nothing recorded, so the single price above applies to everything.'}
      </Typography>
    </Surface>
  );
}
