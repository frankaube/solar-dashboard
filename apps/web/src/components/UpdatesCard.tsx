import { ReactElement, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  UpdateStatus,
  cancelUpdateInstall,
  checkForUpdates,
  fetchUpdateStatus,
  requestUpdateInstall,
  saveUpdatePolicy,
} from '../api';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * Updates.
 *
 * Short on purpose. The interesting decisions — signature checks, health-gated installs,
 * automatic rollback — are the updater's, and describing them here would be three
 * paragraphs nobody reads to explain machinery that is meant to be invisible. What is on
 * screen is the version you are on, the version on offer, and who gets to press install.
 *
 * The one thing worth saying out loud is what "Off" means, so it is said in the option
 * itself rather than in a note underneath.
 */

function when(iso: string | null): string {
  if (!iso) return 'never';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'never';
  return at.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function describeBuild(status: UpdateStatus): string {
  const { version, commit, stamped } = status.current;
  if (!stamped) return 'unstamped build';
  return commit ? `${version} (${commit})` : version;
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function UpdatesCard(): ReactElement {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    fetchUpdateStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useEffect(load, [load]);

  const patch = async (input: { channel?: string; apply?: boolean; hour?: number }) => {
    setBusy('policy');
    setNote(null);
    try {
      setStatus(await saveUpdatePolicy(input));
    } finally {
      setBusy(null);
    }
  };

  if (!status) {
    return (
      <Surface>
        <Typography variant="h6" sx={{ color: solar.ink.pri }}>
          Updates
        </Typography>
      </Surface>
    );
  }

  const off = status.channel === 'off';

  return (
    <Surface>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box>
          <Typography variant="h6" sx={{ color: solar.ink.pri }}>
            Updates
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Running {describeBuild(status)}
            {status.current.builtAt ? `, built ${when(status.current.builtAt)}` : ''}.
          </Typography>
        </Box>

        {/*
          An unstamped build is called out before anything else, because every control
          below it is inert until it is fixed — and the reason ("I cannot tell what this
          is") is not something a user would ever guess from an install button doing
          nothing.
        */}
        {!status.current.stamped && (
          <Alert severity="info">
            This build carries no version stamp, so it cannot be compared to a release.
            Updates stay manual until it is replaced by a packaged build.
          </Alert>
        )}

        {!status.configured && (
          <Alert severity="info">
            No update source is set. Point <code>UPDATE_REPO</code> or{' '}
            <code>UPDATE_FEED_DIR</code> at one in <code>/etc/solar-dashboard/update.conf</code>.
          </Alert>
        )}

        <TextField
          select
          size="small"
          label="Check for updates"
          value={status.channel}
          disabled={busy !== null}
          onChange={(event) => void patch({ channel: event.target.value })}
          helperText={status.channels.find((c) => c.id === status.channel)?.detail}
        >
          {status.channels.map((channel) => (
            <MenuItem key={channel.id} value={channel.id}>
              {channel.label}
            </MenuItem>
          ))}
        </TextField>

        {!off && (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Switch
                checked={status.apply}
                disabled={busy !== null}
                onChange={(event) => void patch({ apply: event.target.checked })}
              />
              <Typography variant="body2">Install automatically</Typography>
            </Box>

            {status.apply && (
              <TextField
                select
                size="small"
                label="Between"
                value={status.hour}
                disabled={busy !== null}
                onChange={(event) => void patch({ hour: Number(event.target.value) })}
                helperText={`and ${String((status.hour + 2) % 24).padStart(2, '0')}:00, ${status.timeZone}`}
                sx={{ maxWidth: 200 }}
              >
                {HOURS.map((hour) => (
                  <MenuItem key={hour} value={hour}>
                    {String(hour).padStart(2, '0')}:00
                  </MenuItem>
                ))}
              </TextField>
            )}

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                {/*
                  A blocked reason belongs in the alert below and nowhere else. Printed
                  here as well it appeared twice, word for word — tolerable when it was
                  "this build has no version stamp", and plainly wrong now that the longest
                  of them is two sentences about where Windows gets its upgrades.
                */}
                <Typography variant="body2" sx={{ color: solar.ink.pri }}>
                  {status.available
                    ? `${status.available.version} available`
                    : status.blocked
                      ? 'No update can be installed from here.'
                      : status.reason}
                </Typography>
                {status.available?.notesUrl && (
                  <Link
                    href={status.available.notesUrl}
                    target="_blank"
                    rel="noreferrer"
                    variant="body2"
                  >
                    What changed
                  </Link>
                )}
              </Box>

              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy('check');
                    setNote(null);
                    checkForUpdates()
                      .then(setStatus)
                      .catch(() => undefined)
                      .finally(() => setBusy(null));
                  }}
                >
                  {busy === 'check' ? 'Checking…' : 'Check now'}
                </Button>

                {/*
                  The version is passed explicitly rather than "install the latest". What
                  gets installed has to be what was on screen when the button was pressed —
                  the updater refuses anything else, and this is the end of the chain that
                  carries that consent.
                */}
                {status.available && !status.pending && (
                  <Button
                    size="small"
                    variant="contained"
                    disabled={busy !== null}
                    onClick={() => {
                      const version = status.available!.version;
                      setBusy('install');
                      requestUpdateInstall(version)
                        .then((result) => {
                          setNote({ ok: result.ok, text: result.message });
                          load();
                        })
                        .catch((error: Error) => setNote({ ok: false, text: error.message }))
                        .finally(() => setBusy(null));
                    }}
                  >
                    Install {status.available.version}
                  </Button>
                )}

                {status.pending && (
                  <Button
                    size="small"
                    color="inherit"
                    disabled={busy !== null}
                    onClick={() => {
                      setBusy('cancel');
                      cancelUpdateInstall()
                        .then(load)
                        .finally(() => setBusy(null));
                    }}
                  >
                    Cancel {status.pending}
                  </Button>
                )}
              </Box>

              {status.pending && (
                <Typography variant="caption" color="text.secondary">
                  {status.pending} is queued. It installs on the updater's next run.
                </Typography>
              )}

              {status.blocked && <Alert severity="warning">{status.reason}</Alert>}
              {status.checkError && <Alert severity="warning">{status.checkError}</Alert>}
              {/*
                The success note is suppressed once something is queued, because the line
                above already says it. Both rendered at once and the panel told you the
                same thing twice in two different wordings — which is the exact habit this
                UI was cut down to remove. Failures still show: those say something the
                queued line cannot.
              */}
              {note && !(note.ok && status.pending) && (
                <Alert severity={note.ok ? 'success' : 'warning'}>{note.text}</Alert>
              )}

              <Typography variant="caption" color="text.disabled">
                Last checked {when(status.checkedAt)}
                {status.lastAttemptText ? ` · ${status.lastAttemptText}` : ''}
              </Typography>
            </Box>
          </>
        )}
      </Box>
    </Surface>
  );
}
