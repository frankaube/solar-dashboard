import { ReactElement, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  PvoutputStatus,
  fetchPvoutput,
  forgetPvoutput,
  savePvoutput,
  testPvoutput,
} from '../api';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * The one thing in this app that sends data out.
 *
 * PVOutput is the long-running public register of domestic solar, and it is what makes
 * "is 76 kWh a good day for this array in this climate" answerable at all — the comparison
 * needs other people's roofs. That is worth having. It also means publishing, which is why
 * this card says so in the first sentence rather than in a footnote, and why nothing is
 * sent until both the key and the switch are set by hand.
 *
 * The key is write-only. It goes up and is never read back — not masked, not truncated —
 * so the field always renders empty and leaving it empty means "keep the one you have".
 */

export function PvoutputCard(): ReactElement {
  const [status, setStatus] = useState<PvoutputStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [systemId, setSystemId] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(() => {
    fetchPvoutput()
      .then((next) => {
        setStatus(next);
        setSystemId((current) => current || next.systemId || '');
      })
      .catch(() => setStatus(null));
  }, []);
  useEffect(load, [load]);

  const run = (work: Promise<PvoutputStatus | { ok: boolean; message: string }>): void => {
    setBusy(true);
    setNote(null);
    work
      .then((result) => {
        if ('ok' in result) {
          setNote({ kind: result.ok ? 'ok' : 'error', text: result.message });
          load();
        } else {
          setStatus(result);
          // Cleared on the way out: it is stored now, and holding a key in a React state
          // for the rest of the session serves nothing.
          setApiKey('');
        }
      })
      .catch((error: Error) => setNote({ kind: 'error', text: error.message }))
      .finally(() => setBusy(false));
  };

  if (!status) {
    return (
      <Surface title="Share with PVOutput">
        <Typography variant="body2" color="text.secondary">
          Loading…
        </Typography>
      </Surface>
    );
  }

  return (
    <Surface title="Share with PVOutput">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Uploads this array's output to{' '}
        <Link href="https://pvoutput.org" target="_blank" rel="noreferrer" underline="hover">
          pvoutput.org
        </Link>
        , where it becomes a public page and joins the comparison set that makes "is this a
        good day for an array this size, in this climate" a question with an answer.
      </Typography>
      {/*
        Said plainly and up front. Everything else in this app stays on this machine, so an
        integration that does not is a change of kind rather than of degree, and burying
        that under a toggle would be the sort of thing people find out about afterwards.
      */}
      <Typography variant="body2" sx={{ color: solar.status.warn, mb: 3 }}>
        This is the only feature that sends your data off this machine. Production, and the
        export figure where a meter measured one — never your rates, your bills or your
        address. Off until you switch it on.
      </Typography>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap', mb: 2 }}>
        <TextField
          size="small"
          label="System ID"
          value={systemId}
          disabled={busy}
          onChange={(event) => setSystemId(event.target.value.replace(/\D/g, ''))}
          sx={{ width: 140 }}
          slotProps={{ htmlInput: { inputMode: 'numeric', 'aria-label': 'PVOutput system id' } }}
        />
        <TextField
          size="small"
          type="password"
          label={status.configured ? 'API key (stored)' : 'API key'}
          placeholder={status.configured ? 'leave blank to keep' : ''}
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          sx={{ width: 260 }}
          slotProps={{
            htmlInput: { autoComplete: 'off', 'aria-label': 'PVOutput API key' },
          }}
        />
        <Button
          variant="contained"
          disabled={busy || (!apiKey.trim() && !systemId.trim())}
          onClick={() => run(savePvoutput({ apiKey: apiKey.trim(), systemId: systemId.trim() }))}
          sx={{ mt: '2px' }}
        >
          Save
        </Button>
      </Box>
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 3 }}>
        Both are on your PVOutput settings page. The key is stored on this machine and never
        sent back to this browser, so the box above stays empty once it is set.
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Switch
          checked={status.enabled}
          disabled={busy || !status.configured}
          onChange={(event) => run(savePvoutput({ enabled: event.target.checked }))}
          slotProps={{ input: { 'aria-label': 'Upload to PVOutput' } }}
        />
        <Typography variant="body2" sx={{ color: solar.ink.pri }}>
          {status.enabled ? 'Uploading every 10 minutes' : 'Not uploading'}
        </Typography>
        <Button
          size="small"
          disabled={busy || !status.configured || !status.enabled}
          onClick={() => run(testPvoutput())}
        >
          Send one now
        </Button>
        {status.configured && (
          <Button
            size="small"
            disabled={busy}
            onClick={() => run(forgetPvoutput())}
            sx={{ color: 'text.disabled' }}
          >
            Forget key
          </Button>
        )}
      </Box>

      {note && (
        <Alert severity={note.kind === 'ok' ? 'success' : 'warning'} sx={{ mt: 2 }}>
          {note.text}
        </Alert>
      )}
      {/*
        A failure that stopped the uploader has to be visible here, because that is the only
        place it can be fixed — and the switch above will read "off" with no other clue why.
      */}
      {!note && status.lastError && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {status.lastError}
        </Alert>
      )}
      {status.lastUploadAt && (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2 }}>
          Last upload {new Date(status.lastUploadAt).toLocaleString()}
          {status.rateRemaining !== null && ` · ${status.rateRemaining} requests left this hour`}
        </Typography>
      )}
    </Surface>
  );
}
