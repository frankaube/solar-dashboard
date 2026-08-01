import { ReactElement, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  VehicleConfig,
  VehicleTestResult,
  disconnectVehicle,
  fetchVehicleConfig,
  saveVehicleConfig,
  testVehicleConfig,
} from '../api';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * Connecting to TeslaMate.
 *
 * This was an environment variable, which made adding a car to a running install an ssh
 * session, a hand-written Postgres URL, a service restart and a trip through the journal
 * to find out whether it had worked — four steps, each silent when wrong.
 *
 * The fields are separate rather than one URL box for the same reason: a typo inside
 * `postgresql://user:pass@host:5432/db` is invisible, and the failure it produces reads as
 * a wrong password wherever it actually was.
 */

export function VehicleCard(): ReactElement {
  const [state, setState] = useState<VehicleConfig | null>(null);
  const [form, setForm] = useState({ host: '', port: '5432', user: '', database: '', password: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<VehicleTestResult | null>(null);

  const load = useCallback(() => {
    fetchVehicleConfig()
      .then((next) => {
        setState(next);
        setForm({
          host: next.config.host,
          port: String(next.config.port),
          user: next.config.user,
          database: next.config.database,
          password: '',
        });
      })
      .catch(() => setState(null));
  }, []);
  useEffect(load, [load]);

  if (!state) {
    return (
      <Surface>
        <Typography variant="h6" sx={{ color: solar.ink.pri }}>
          Vehicle
        </Typography>
      </Surface>
    );
  }

  const payload = {
    host: form.host,
    port: Number(form.port),
    user: form.user,
    database: form.database,
    // Blank means "keep what is stored", which is why the field is never prefilled.
    ...(form.password ? { password: form.password } : {}),
  };

  const run = (
    label: string,
    action: () => Promise<VehicleTestResult>,
  ): void => {
    setBusy(label);
    setResult(null);
    action()
      .then((next) => {
        setResult(next);
        if (next.saved) {
          setForm((prev) => ({ ...prev, password: '' }));
          load();
        }
      })
      .catch((error: Error) => setResult({ ok: false, message: error.message }))
      .finally(() => setBusy(null));
  };

  const field = (key: keyof typeof form, label: string, extra = {}) => (
    <TextField
      size="small"
      label={label}
      value={form[key]}
      disabled={busy !== null}
      onChange={(event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))}
      {...extra}
    />
  );

  return (
    <Surface>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box>
          <Typography variant="h6" sx={{ color: solar.ink.pri }}>
            Vehicle
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Drives, charging and battery history come from{' '}
            <a href="https://docs.teslamate.org" target="_blank" rel="noreferrer">
              TeslaMate
            </a>
            . Point this at its database — it can be on this machine or another one.
          </Typography>
        </Box>

        {state.configured && (
          <Alert severity="success">
            Connected to <code>{state.describe}</code>
            {state.fromEnvironment && ' — set by TESLAMATE_DATABASE_URL in the environment.'}
          </Alert>
        )}

        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {field('host', 'Host', { sx: { flex: '1 1 180px' } })}
          {field('port', 'Port', { sx: { width: 110 }, inputMode: 'numeric' })}
        </Box>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {field('user', 'User', { sx: { flex: '1 1 160px' } })}
          {field('database', 'Database', { sx: { flex: '1 1 160px' } })}
        </Box>
        {field('password', 'Password', {
          type: 'password',
          placeholder: state.passwordSet ? '•••••••• (unchanged)' : '',
          helperText: state.passwordSet ? 'Leave blank to keep the saved password.' : undefined,
          sx: { maxWidth: 320 },
        })}

        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button
            size="small"
            variant="outlined"
            disabled={busy !== null}
            onClick={() => run('test', () => testVehicleConfig(payload))}
          >
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </Button>
          {/*
            Save tests first and refuses on failure. Saving something that does not work
            would leave this panel reporting a connection while every query failed quietly
            in the background — the exact state it exists to prevent.
          */}
          <Button
            size="small"
            variant="contained"
            disabled={busy !== null}
            onClick={() => run('save', () => saveVehicleConfig(payload))}
          >
            {busy === 'save' ? 'Saving…' : 'Save & connect'}
          </Button>
          {state.configured && (
            <Button
              size="small"
              color="inherit"
              disabled={busy !== null}
              onClick={() => {
                setBusy('off');
                setResult(null);
                disconnectVehicle()
                  .then(load)
                  .finally(() => setBusy(null));
              }}
            >
              Disconnect
            </Button>
          )}
        </Box>

        {result && (
          <Alert severity={result.ok ? 'success' : 'warning'}>{result.message}</Alert>
        )}
      </Box>
    </Surface>
  );
}
