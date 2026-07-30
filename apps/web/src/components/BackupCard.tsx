import { ReactElement, ReactNode, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  BackupDestinationInfo,
  Capabilities,
  BackupFrequency,
  BackupStatus,
  disconnectGoogleDrive,
  fetchBackupConfig,
  fetchBackupDestinations,
  fetchBackupFrequencies,
  fetchBackupStatus,
  fetchCapabilities,
  runBackupNow,
  saveBackupConfig,
  testBackup,
} from '../api';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * Backup settings.
 *
 * The destination list, and every field each destination needs, comes from the server —
 * the same registry the backend builds destinations from. Adding a fourth destination is
 * a backend change only; nothing here names "s3" except the one place Google Drive needs
 * its own connect button.
 *
 * Several destinations can be on at once, because the useful arrangement is a local copy
 * AND an off-site one. They are not alternatives: a folder on the same machine survives a
 * bad deploy but not a house fire, and a bucket survives the fire but takes longer to
 * restore from. One switch each rather than a picker, so choosing one does not read as
 * giving up the other.
 */

function bytes(n: number | null | undefined): string {
  if (!n) return '—';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`;
}

function when(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <Box>
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 0.5 }}>
        {label}
      </Typography>
      {children}
    </Box>
  );
}

/**
 * The Drive authorisation step, and the two things about it that surprise people.
 *
 * The redirect URI has to be pasted into Google's console before connecting will work,
 * and it must be the loopback one — Google refuses plain http anywhere else — so it is
 * shown here rather than buried in the README, and the card says plainly when the page
 * is being viewed from somewhere the flow cannot complete.
 */
function GoogleDriveConnect({
  connected,
  onDisconnect,
}: {
  connected: boolean;
  onDisconnect: () => void;
}): ReactElement {
  const port = window.location.port || '80';
  const loopback =
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
      <Field label="Authorised redirect URI — paste this into your Google OAuth client">
        <Typography
          variant="caption"
          component="code"
          sx={{ wordBreak: 'break-all', color: solar.ink.pri }}
        >
          {`http://localhost:${port}/api/backup/oauth/google/callback`}
        </Typography>
      </Field>

      {connected ? (
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ color: solar.status.ok }}>
            Connected to Google Drive
          </Typography>
          <Button size="small" variant="outlined" onClick={onDisconnect}>
            Disconnect
          </Button>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            size="small"
            variant="contained"
            disabled={!loopback}
            href="/api/backup/oauth/google/start"
          >
            Connect Google Drive
          </Button>
          <Typography variant="caption" color="text.disabled">
            Save the client ID and secret first.
          </Typography>
        </Box>
      )}

      {!loopback && (
        <Typography variant="caption" sx={{ color: solar.status.warn }}>
          Connecting has to be done from the machine running the dashboard, at{' '}
          <code>{`http://localhost:${port}/settings/backup`}</code> — Google only allows an
          insecure redirect back to localhost. From another machine, forward the port first:{' '}
          <code>{`ssh -L ${port}:localhost:${port} user@host`}</code>.
        </Typography>
      )}

      <Typography variant="caption" color="text.disabled">
        Publish your OAuth consent screen to <strong>Production</strong>. While it is in Testing,
        Google revokes the authorisation after 7 days and backups stop.
      </Typography>
    </Box>
  );
}

export function BackupCard(): ReactElement {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [kinds, setKinds] = useState<BackupDestinationInfo[] | null>(null);
  const [frequencies, setFrequencies] = useState<BackupFrequency[] | null>(null);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [configs, setConfigs] = useState<Record<string, Record<string, string>>>({});
  const [secretsSet, setSecretsSet] = useState<Record<string, Record<string, boolean>>>({});
  const [schedule, setSchedule] = useState('daily');
  const [hour, setHour] = useState(3);
  const [keep, setKeep] = useState('14');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const flash = (kind: 'ok' | 'error', text: string, ms = 4000): void => {
    setNote({ kind, text });
    setTimeout(() => setNote(null), ms);
  };

  const applyConfig = (config: Awaited<ReturnType<typeof fetchBackupConfig>>): void => {
    setEnabled(config.enabled);
    setConfigs(Object.fromEntries(Object.entries(config.kinds).map(([id, k]) => [id, k.values])));
    setSecretsSet(
      Object.fromEntries(Object.entries(config.kinds).map(([id, k]) => [id, k.secretsSet])),
    );
  };

  /*
    Loaded once rather than polled. Everything here is either something you just typed or
    something that changes once a day, and a poll that rewrote the form under the cursor is
    exactly the bug the rest of this page was fixed for.
  */
  useEffect(() => {
    void fetchCapabilities().then(setCaps).catch(() => setCaps(null));
  }, []);

  useEffect(() => {
    void (async () => {
      const [list, rates, current, config] = await Promise.all([
        fetchBackupDestinations(),
        fetchBackupFrequencies(),
        fetchBackupStatus(),
        fetchBackupConfig(),
      ]);
      setKinds(list);
      setFrequencies(rates);
      setStatus(current);
      setSchedule(current.schedule);
      setHour(current.hour);
      setKeep(String(current.keep));
      applyConfig(config);
    })().catch((error: Error) => flash('error', error.message, 8000));
  }, []);

  const anchored = frequencies?.find((f) => f.id === schedule)?.anchored ?? false;
  const setField = (kindId: string, key: string, value: string): void =>
    setConfigs((prev) => ({ ...prev, [kindId]: { ...(prev[kindId] ?? {}), [key]: value } }));

  const save = (): void => {
    setBusy('save');
    void saveBackupConfig({ enabled, configs, schedule, keep: Number(keep) || 14, hour })
      .then(() =>
        // Re-read rather than trust the form: it confirms what was stored, and flips the
        // secret placeholders to "stored".
        Promise.all([fetchBackupStatus(), fetchBackupConfig()]).then(([next, config]) => {
          setStatus(next);
          applyConfig(config);
          flash('ok', 'Saved');
        }),
      )
      .catch((error: Error) => flash('error', error.message, 8000))
      .finally(() => setBusy(null));
  };

  return (
    <Surface title="Backup">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        A consistent copy of the whole database — readings, panel layout, settings and alert
        history — written on a schedule and pruned to the last few. Turn on as many places as you
        want; each gets the same snapshot.
        {/*
          Named only when there IS one. This used to assert "your TeslaMate data" at every
          install, including households with no car, which both named the wrong product
          and warned about an exclusion that did not apply to them.
        */}
        {caps?.vehicle ? (
          <>
            {' '}Your {caps.vehicle.name} data lives in its own database and is{' '}
            <strong>not</strong> included.
          </>
        ) : null}
      </Typography>

      {kinds && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {kinds.map((kind) => {
            const on = enabled.includes(kind.id);
            return (
              <Box
                key={kind.id}
                sx={{
                  border: '1px solid',
                  borderColor: on ? 'divider' : 'transparent',
                  borderRadius: 1,
                  p: on ? 2.5 : 0,
                  transition: 'padding .15s',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
                  <Switch
                    size="small"
                    checked={on}
                    onChange={(event) =>
                      setEnabled((prev) =>
                        event.target.checked
                          ? [...prev, kind.id]
                          : prev.filter((id) => id !== kind.id),
                      )
                    }
                    slotProps={{ input: { 'aria-label': kind.name } }}
                  />
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="body2" sx={{ color: on ? solar.ink.pri : solar.ink.dim }}>
                      {kind.name}
                    </Typography>
                    <Typography variant="caption" color="text.disabled">
                      {kind.summary}
                    </Typography>
                  </Box>
                </Box>

                {/*
                  Kept mounted and collapsed rather than unmounted, so switching a
                  destination off and on again does not discard what was typed into it.
                */}
                <Collapse in={on}>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, mt: 2.5, pl: 5 }}>
                    <Typography variant="caption" color="text.disabled">
                      {kind.setupHint}
                    </Typography>
                    {kind.fields
                      .filter((field) => !field.hidden)
                      .map((field) => (
                        <Field key={field.key} label={field.label}>
                          <TextField
                            size="small"
                            fullWidth
                            type={field.secret ? 'password' : 'text'}
                            value={configs[kind.id]?.[field.key] ?? ''}
                            onChange={(event) => setField(kind.id, field.key, event.target.value)}
                            /*
                              A stored secret is never sent back down, so the field is blank
                              on load. Saying so is the difference between "leave it alone"
                              and "this was never set".
                            */
                            placeholder={
                              field.secret && secretsSet[kind.id]?.[field.key]
                                ? 'stored — leave blank to keep'
                                : field.placeholder
                            }
                            helperText={field.help}
                          />
                        </Field>
                      ))}
                    {kind.id === 'gdrive' && (
                      <GoogleDriveConnect
                        connected={Boolean(secretsSet.gdrive?.refreshToken)}
                        onDisconnect={() =>
                          void disconnectGoogleDrive()
                            .then((next) => {
                              setStatus(next);
                              setSecretsSet((prev) => ({
                                ...prev,
                                gdrive: { ...(prev.gdrive ?? {}), refreshToken: false },
                              }));
                              flash('ok', 'Disconnected');
                            })
                            .catch((error: Error) => flash('error', error.message, 8000))
                        }
                      />
                    )}
                    <Button
                      variant="outlined"
                      size="small"
                      sx={{ alignSelf: 'flex-start' }}
                      disabled={busy !== null}
                      onClick={() => {
                        setBusy(`test:${kind.id}`);
                        void testBackup(kind.id, configs[kind.id] ?? {})
                          .then((result) =>
                            result.ok
                              ? flash('ok', `${kind.name}: wrote and deleted a test file`)
                              : flash('error', `${kind.name}: ${result.error}`, 10000),
                          )
                          .catch((error: Error) => flash('error', error.message, 8000))
                          .finally(() => setBusy(null));
                      }}
                    >
                      {busy === `test:${kind.id}` ? 'Testing…' : 'Test this destination'}
                    </Button>
                  </Box>
                </Collapse>
              </Box>
            );
          })}

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: anchored ? '1fr 1fr 1fr' : '1fr 1fr' },
              gap: 3,
              mt: 1,
            }}
          >
            <Field label="How often">
              <TextField
                select
                size="small"
                fullWidth
                value={schedule}
                onChange={(event) => setSchedule(event.target.value)}
              >
                {(frequencies ?? []).map((frequency) => (
                  <MenuItem key={frequency.id} value={frequency.id}>
                    {frequency.label}
                  </MenuItem>
                ))}
              </TextField>
            </Field>
            {/*
              Only for frequencies that anchor. Offering an hour for "every 6 hours" would
              be a control that quietly does nothing, which is worse than absent.
            */}
            {anchored && (
              <Field label="At">
                <TextField
                  select
                  size="small"
                  fullWidth
                  value={hour}
                  onChange={(event) => setHour(Number(event.target.value))}
                  helperText="Local time."
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <MenuItem key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </MenuItem>
                  ))}
                </TextField>
              </Field>
            )}
            <Field label="Keep">
              <TextField
                size="small"
                fullWidth
                value={keep}
                onChange={(event) => setKeep(event.target.value.replace(/[^\d]/g, ''))}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                helperText="Per destination."
              />
            </Field>
          </Box>

          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="contained" disabled={busy !== null} onClick={save}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="outlined"
              disabled={busy !== null || !status?.configured}
              onClick={() => {
                setBusy('run');
                void runBackupNow()
                  .then((result) => {
                    void fetchBackupStatus().then(setStatus);
                    if (result.error) return flash('error', result.error, 10000);
                    const failed = result.results.filter((r) => !r.ok);
                    return failed.length
                      ? flash(
                          'error',
                          `${result.results.length - failed.length} of ${result.results.length} succeeded — ${failed.map((f) => `${f.kind}: ${f.error}`).join('; ')}`,
                          12000,
                        )
                      : flash('ok', `Backed up to ${result.results.length} destination(s)`, 6000);
                  })
                  .catch((error: Error) => flash('error', error.message, 8000))
                  .finally(() => setBusy(null));
              }}
            >
              {busy === 'run' ? 'Backing up…' : 'Back up now'}
            </Button>
            {note && (
              <Typography
                variant="caption"
                sx={{ color: note.kind === 'ok' ? solar.status.ok : solar.status.critical }}
              >
                {note.text}
              </Typography>
            )}
          </Box>
        </Box>
      )}

      {status && (
        <Box sx={{ mt: 4, pt: 3, borderTop: '1px solid', borderColor: 'divider' }}>
          {!status.configured ? (
            <Typography variant="caption" color="text.disabled">
              Nothing is being backed up.
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
              <Typography variant="caption" color="text.disabled">
                {status.scheduleText}
              </Typography>
              {status.destinations.map((dest) => (
                <Box key={dest.kind}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {dest.describe} · last run {when(dest.lastRunAt)}
                    {dest.lastSizeBytes ? ` · ${bytes(dest.lastSizeBytes)}` : ''}
                  </Typography>
                  {dest.lastOk === false && dest.lastError && (
                    <Typography variant="caption" sx={{ color: solar.status.critical, display: 'block' }}>
                      Last attempt failed: {dest.lastError}
                    </Typography>
                  )}
                  {dest.listError && (
                    /*
                      Distinct from a failed run. The last backup may have succeeded and the
                      destination still be unreachable now — in which case the empty list
                      means "cannot see them", not "there are none".
                    */
                    <Typography variant="caption" sx={{ color: solar.status.critical, display: 'block' }}>
                      Could not read what is stored there: {dest.listError}
                    </Typography>
                  )}
                  {/*
                    The list is the only proof the backups exist. A card that says "last run
                    succeeded" and shows nothing is what a silently broken backup looks like.
                  */}
                  {dest.backups.slice(0, 3).map((backup) => (
                    <Typography
                      key={backup.name}
                      variant="caption"
                      color="text.disabled"
                      sx={{ display: 'block', fontVariantNumeric: 'tabular-nums', pl: 1.5 }}
                    >
                      {backup.name} · {bytes(backup.sizeBytes)} · {when(backup.modifiedAt)}
                    </Typography>
                  ))}
                  {dest.backups.length > 3 && (
                    <Typography variant="caption" color="text.disabled" sx={{ pl: 1.5 }}>
                      and {dest.backups.length - 3} older
                    </Typography>
                  )}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Surface>
  );
}
