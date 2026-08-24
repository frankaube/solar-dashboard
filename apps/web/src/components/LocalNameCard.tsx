import { ReactElement, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import InputAdornment from '@mui/material/InputAdornment';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { MdnsStatus, fetchMdns, saveMdns } from '../api';
import { Hint } from './Hint';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * The name this dashboard answers to on the home network.
 *
 * The one setting in the app that can cut off the browser changing it. Rename from
 * `solar-dashboard` to `solar` while reading the page at the old address and the tab you
 * are looking at is pointed at a name that no longer resolves — so the IP is on screen
 * permanently, the warning is stated before rather than after, and the new URL arrives as
 * a link you can click rather than a string to retype.
 *
 * The server keeps the old name alive for a few seconds after the switch, which usually
 * lets the response to that request arrive — but only usually: both responders share UDP
 * 5353 and queries are not reliably delivered to both, measured here answering at T+1 and
 * T+3 in one run and already gone at T+3 in another. So the IP is the guarantee and the
 * overlap is a courtesy, and this card says it that way round.
 */

export function LocalNameCard(): ReactElement | null {
  const [status, setStatus] = useState<MdnsStatus | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamed, setRenamed] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchMdns()
      .then((next) => {
        setStatus(next);
        setValue((current) => current || next.hostname);
      })
      .catch(() => setStatus(null));
  }, []);
  useEffect(load, [load]);

  if (!status) return null;

  const dirty = value.trim().toLowerCase() !== status.hostname;
  const fallback = status.address ? `http://${status.address}:${status.port}` : null;

  const save = (): void => {
    setBusy(true);
    setError(null);
    setRenamed(null);
    saveMdns(value.trim())
      .then((next) => {
        setStatus(next);
        setRenamed(next.url);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <Surface title="Address on your network">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Reach the dashboard by name instead of by IP.
        <Hint>
          So you do not have to know where your router put it. Works on the home network only —
          not from outside, not over a VPN, and not across a guest network.
        </Hint>
      </Typography>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap', mb: 2 }}>
        <TextField
          size="small"
          label="Name"
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          error={Boolean(error)}
          sx={{ width: 260 }}
          slotProps={{
            htmlInput: { 'aria-label': 'Network name', autoCapitalize: 'none', spellCheck: false },
            input: { endAdornment: <InputAdornment position="end">.local</InputAdornment> },
          }}
        />
        <Button variant="contained" disabled={busy || !dirty} onClick={save} sx={{ mt: '2px' }}>
          {busy ? 'Renaming…' : 'Rename'}
        </Button>
      </Box>

      {/*
        Said before the change, not after. Once it has been made, the reader may not be able
        to load the page that would have told them.
      */}
      {dirty && !error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Renaming stops <code>{status.hostname}.local</code> working. Any bookmark or
          shortcut using it will need updating
          {fallback ? ' — the IP address below keeps working either way.' : '.'}
        </Alert>
      )}

      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {renamed && (
        <Alert severity="success" sx={{ mb: 2 }}>
          Renamed. The dashboard is now at{' '}
          <Link href={renamed} sx={{ fontWeight: 600 }}>
            {renamed}
          </Link>
          . Update any bookmark pointing at the old name{fallback ? `; ${fallback} works whatever happens` : ''}.
        </Alert>
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {status.url && (
          <Row label="Address">
            <Link href={status.url}>{status.url}</Link>
          </Row>
        )}
        {fallback && (
          <Row label="Always works">
            <Link href={fallback}>{fallback}</Link>
          </Row>
        )}
        {status.source === 'environment' && (
          <Row label="Set by">
            <span>
              <code>MDNS_HOSTNAME</code> — saving here takes over from it
            </span>
          </Row>
        )}
      </Box>

      {!status.running && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {status.error
            ? `The name is not being advertised: ${status.error} Use the IP address.`
            : 'The name is not being advertised. Use the IP address.'}
        </Alert>
      )}

      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 3 }}>
        Letters, digits and hyphens; no dots. Phones and laptops made in the last few years
        resolve these without anything installed; anything older may still need the IP.
      </Typography>
    </Surface>
  );
}

/** label · value, for the two or three facts under the field. */
function Row({ label, children }: { label: string; children: ReactElement | string }): ReactElement {
  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <Typography variant="caption" color="text.disabled" sx={{ width: 96 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ color: solar.ink.pri }}>
        {children}
      </Typography>
    </Box>
  );
}
