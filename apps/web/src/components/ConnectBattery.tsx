import { ReactElement, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  BatteryConfig,
  BatteryVendorInfo,
  EcoFlowDevice,
  fetchBatteryConfig,
  fetchBatteryVendors,
  listEcoFlowDevices,
  saveBatteryConfig,
  testBatteryConfig,
} from '../api';
import { Surface } from '../components/Surface';
import { solar } from '../theme';

/**
 * Connect a battery, whichever kind it is.
 *
 * This replaced a card headed "Connect an EcoFlow battery" with two hardcoded key
 * fields and a paragraph promising Tesla, Victron and Enphase "on the roadmap". An
 * owner could not tell which of the four they could actually use, and a battery that
 * connects by IP rather than by API key had nowhere to put its address.
 *
 * Everything here is rendered from the vendor registry the API serves, so adding a
 * battery is a registry entry rather than another branch in this file.
 */
export function ConnectBattery({ onSaved }: { onSaved?: () => void }): ReactElement {
  const [vendors, setVendors] = useState<BatteryVendorInfo[] | null>(null);
  const [config, setConfig] = useState<BatteryConfig | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'test' | 'save' | 'devices' | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [devices, setDevices] = useState<EcoFlowDevice[] | null>(null);

  useEffect(() => {
    void Promise.all([fetchBatteryVendors(), fetchBatteryConfig()])
      .then(([v, c]) => {
        setVendors(v);
        setConfig(c);
        // Reopen on whatever is already configured, so editing is not a fresh start.
        if (c.vendor) {
          setSelected(c.vendor);
          setValues(c.values);
        }
      })
      .catch(() => setVendors([]));
  }, []);

  if (!vendors) {
    return (
      <Surface sx={{ maxWidth: 720 }}>
        <Typography variant="body2" color="text.secondary">
          Loading batteries…
        </Typography>
      </Surface>
    );
  }

  const vendor = vendors.find((v) => v.id === selected) ?? null;
  const set = (key: string, value: string): void => setValues((prev) => ({ ...prev, [key]: value }));

  const run = async (
    kind: 'test' | 'save',
  ): Promise<void> => {
    if (!vendor) return;
    setBusy(kind);
    setStatus(null);
    try {
      const result = await testBatteryConfig(vendor.id, values);
      if (!result.ok) {
        setStatus({ ok: false, text: result.error ?? 'Could not reach the battery.' });
        return;
      }
      if (kind === 'test') {
        setStatus({ ok: true, text: `Found it — ${result.soc}% charged.` });
        return;
      }
      await saveBatteryConfig(vendor.id, values);
      setStatus({ ok: true, text: 'Saved.' });
      onSaved?.();
    } catch (error) {
      setStatus({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Surface sx={{ maxWidth: 720 }}>
      <Typography variant="overline" color="text.disabled" sx={{ display: 'block', mb: 1 }}>
        Connect a battery
      </Typography>

      {/*
        A configured-but-failing battery is its own state. Before this, an unreachable
        battery rendered the same empty setup form as one that had never been added, so
        an owner whose inverter changed IP got no hint that anything had been lost.
      */}
      {config?.error && (
        <Box
          sx={{
            mb: 3,
            p: 3,
            borderRadius: `${solar.radius.control}px`,
            border: '1px solid',
            borderColor: solar.status.critical,
          }}
        >
          <Typography variant="body2" sx={{ color: solar.status.critical }}>
            Your battery is configured but not answering: {config.error}
          </Typography>
          <Typography variant="caption" color="text.disabled">
            If it moved to a new address, correct it below. Nothing has been forgotten.
          </Typography>
        </Box>
      )}

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Nothing found by the network scan? Pick your battery here and enter its address — or
        its keys, if the maker offers no way to reach it locally.
      </Typography>

      <TextField
        select
        size="small"
        fullWidth
        label="Battery"
        value={selected ?? ''}
        onChange={(event) => {
          setSelected(event.target.value);
          setValues({});
          setStatus(null);
          setDevices(null);
        }}
        sx={{ mb: 3 }}
      >
        {vendors.map((v) => (
          <MenuItem key={v.id} value={v.id}>
            <Box>
              <Typography variant="body2">{v.name}</Typography>
              <Typography variant="caption" color="text.disabled">
                {v.summary}
              </Typography>
            </Box>
          </MenuItem>
        ))}
      </TextField>

      {vendor && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {/*
              Local versus cloud is stated plainly. In an app whose claim is that
              nothing leaves the house, a vendor that requires a round trip through
              their servers should look like the compromise it is.
            */}
            <Chip
              size="small"
              label={vendor.connection === 'local' ? 'Local — stays on your network' : 'Cloud — leaves your network'}
              sx={{
                bgcolor: 'transparent',
                border: '1px solid',
                borderColor: vendor.connection === 'local' ? solar.status.ok : solar.status.warn,
                color: vendor.connection === 'local' ? solar.status.ok : solar.status.warn,
              }}
            />
            {/*
              Same honesty rule the fixture catalogue uses: implementing a published
              spec proves we parse the document, not that a device agrees with it.
            */}
            {vendor.confidence === 'documented' && (
              <Chip
                size="small"
                label="Built from the spec, not yet proven on hardware"
                sx={{ bgcolor: 'transparent', border: '1px dashed', borderColor: solar.ink.faint, color: solar.ink.dim }}
              />
            )}
          </Box>

          <Typography variant="body2" color="text.secondary">
            {vendor.setupHint}
          </Typography>

          {vendor.fields.map((field) => (
            <TextField
              key={field.key}
              size="small"
              fullWidth
              label={field.label}
              type={field.secret ? 'password' : 'text'}
              value={values[field.key] ?? ''}
              placeholder={field.placeholder}
              helperText={
                field.secret && config?.secretsSet?.[field.key] && !values[field.key]
                  ? 'Stored. Leave blank to keep it.'
                  : field.help
              }
              onChange={(event) => set(field.key, event.target.value)}
            />
          ))}

          {/* EcoFlow needs its serial chosen from the account, so offer that lookup. */}
          {vendor.id === 'ecoflow' && (
            <Box>
              <Button
                size="small"
                variant="outlined"
                disabled={busy !== null || !values.accessKey || !values.secretKey}
                onClick={() => {
                  setBusy('devices');
                  setStatus(null);
                  void listEcoFlowDevices(values.accessKey, values.secretKey)
                    .then(setDevices)
                    .catch((e: Error) => setStatus({ ok: false, text: e.message }))
                    .finally(() => setBusy(null));
                }}
              >
                {busy === 'devices' ? <CircularProgress size={16} /> : 'Find my devices'}
              </Button>
              {devices && (
                <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {devices.length === 0 && (
                    <Typography variant="caption" color="text.disabled">
                      Those keys worked, but the account has no devices.
                    </Typography>
                  )}
                  {devices.map((device) => (
                    <Button
                      key={device.sn}
                      size="small"
                      variant={values.sn === device.sn ? 'contained' : 'outlined'}
                      onClick={() => set('sn', device.sn)}
                      sx={{ justifyContent: 'flex-start' }}
                    >
                      {device.productName ?? 'EcoFlow device'} · {device.sn}
                    </Button>
                  ))}
                </Box>
              )}
            </Box>
          )}

          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            {/*
              Test before save. Storing an address that does not answer and finding out
              a minute later when a background poll fails quietly is the failure this
              page kept producing.
            */}
            <Button variant="outlined" disabled={busy !== null} onClick={() => void run('test')}>
              {busy === 'test' ? <CircularProgress size={16} /> : 'Test connection'}
            </Button>
            <Button variant="contained" disabled={busy !== null} onClick={() => void run('save')}>
              {busy === 'save' ? <CircularProgress size={16} sx={{ color: '#0e0d0b' }} /> : 'Save'}
            </Button>
            {status && (
              <Typography
                variant="caption"
                sx={{ color: status.ok ? solar.status.ok : solar.status.critical }}
              >
                {status.text}
              </Typography>
            )}
          </Box>
        </Box>
      )}
    </Surface>
  );
}
