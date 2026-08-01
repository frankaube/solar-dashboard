import { ReactElement, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  CreditBankStatus,
  addCreditReading,
  fetchCreditBank,
  removeCreditReading,
} from '../api';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * Banked export credits and the date they stop existing.
 *
 * Worth a panel because nothing else tells you: the balance is printed on a bill as a
 * plain number, with no indication that it is emptied on a fixed date every year and that
 * whatever is left is simply gone.
 *
 * The balance is typed in rather than measured, and the card says so. This app sees
 * production; it has no meter at the service entrance, so it cannot know what was exported
 * or bought back. Presenting a derived guess as a balance would be worse than asking.
 */

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Today, as the value an <input type="date"> expects. */
function todayValue(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function CreditBankCard(): ReactElement {
  const [status, setStatus] = useState<CreditBankStatus | null>(null);
  const [balance, setBalance] = useState('');
  const [readAt, setReadAt] = useState(todayValue());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchCreditBank()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useEffect(load, [load]);

  if (!status) {
    return (
      <Surface>
        <Typography variant="h6" sx={{ color: solar.ink.pri }}>
          Banked credits
        </Typography>
      </Surface>
    );
  }

  const save = (): void => {
    const kwh = Number(balance);
    if (!Number.isFinite(kwh) || kwh < 0) {
      setError('Enter the banked kWh from your bill.');
      return;
    }
    setBusy(true);
    setError(null);
    addCreditReading({ readAt: new Date(`${readAt}T12:00:00`).toISOString(), balanceKwh: kwh })
      .then((next) => {
        setStatus(next);
        setBalance('');
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  // Only a real forecast earns a warning colour. Every other state is informational, and
  // colouring "not enough history yet" as a problem would train people to ignore it.
  const severity = status.basis === 'trend' && (status.atRiskKwh ?? 0) > 0 ? 'warning' : 'info';

  return (
    <Surface>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box>
          <Typography variant="h6" sx={{ color: solar.ink.pri }}>
            Banked credits
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Surplus kWh bank instead of being paid for, and the bank empties on{' '}
            <strong>{shortDate(status.expiresAt)}</strong> — {status.daysRemaining} days away.
            Anything left is forfeited.
          </Typography>
        </Box>

        {status.balanceKwh !== null && (
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
            <Typography variant="mono" sx={{ fontSize: 30, color: solar.ink.pri }}>
              {Math.round(status.balanceKwh)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              kWh banked, as of {status.readAt ? shortDate(status.readAt) : '—'}
            </Typography>
          </Box>
        )}

        <Alert severity={severity}>{status.message}</Alert>

        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <TextField
            size="small"
            type="date"
            label="Bill date"
            value={readAt}
            disabled={busy}
            onChange={(event) => setReadAt(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ width: 170 }}
          />
          <TextField
            size="small"
            label="Banked kWh"
            value={balance}
            disabled={busy}
            inputMode="decimal"
            onChange={(event) => setBalance(event.target.value.replace(/[^\d.]/g, ''))}
            sx={{ width: 140 }}
          />
          <Button size="small" variant="contained" disabled={busy} onClick={save} sx={{ mt: '2px' }}>
            {busy ? 'Saving…' : 'Record'}
          </Button>
        </Box>

        {error && <Alert severity="warning">{error}</Alert>}

        {status.readings.length > 0 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {status.readings.slice(0, 8).map((reading) => (
              <Box
                key={reading.id}
                sx={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 13 }}
              >
                <Typography variant="caption" sx={{ color: solar.ink.sec, width: 110 }}>
                  {shortDate(reading.readAt)}
                </Typography>
                <Typography variant="mono" sx={{ fontSize: 13, color: solar.ink.pri, width: 80 }}>
                  {Math.round(reading.balanceKwh)} kWh
                </Typography>
                <Button
                  size="small"
                  onClick={() => void removeCreditReading(reading.id).then(setStatus)}
                  sx={{ color: 'text.disabled', minWidth: 32 }}
                >
                  ✕
                </Button>
              </Box>
            ))}
          </Box>
        )}

        <Typography variant="caption" color="text.disabled">
          Entered from your bill, not measured — this app reads your inverter, not your
          meter, so it cannot see what was exported or bought back. A credit is valued at{' '}
          {(status.redeemRatePerKwh * 100).toFixed(2)}¢/kWh: what it saves you, before the
          sales tax you still pay to buy the energy back.
        </Typography>
      </Box>
    </Surface>
  );
}
