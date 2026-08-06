import { ReactElement, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  UtilityImportPreview,
  UtilityUsageStatus,
  fetchUtilityUsage,
  importUtilityUsage,
} from '../api';
import { Hint } from './Hint';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * Import the utility's own meter data.
 *
 * This is the same measurement a clamp on the service entrance takes — energy across the
 * property boundary, both directions — except the utility already takes it, bills on it,
 * and will hand it over. It needs no hardware and reaches back to the day the panels went
 * live, which is the one thing a clamp fitted later can never do.
 *
 * Read, then look, then store. The step in the middle is not politeness: a column mapped
 * the wrong way round produces a savings figure that is confidently backwards while every
 * individual number stays plausible, and the only moment anyone can catch it is while the
 * file is still in front of them.
 */
export function UtilityUsageCard(): ReactElement {
  const [status, setStatus] = useState<UtilityUsageStatus | null>(null);
  const [preview, setPreview] = useState<UtilityImportPreview | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<{ date: number; imported: number; exported: number }>({
    date: 0,
    imported: 1,
    exported: 2,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const refresh = (): void => {
    fetchUtilityUsage().then(setStatus).catch(() => setStatus(null));
  };
  useEffect(refresh, []);

  const run = async (chosen: File, commit: boolean, withMapping = false): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await importUtilityUsage(chosen, {
        commit,
        mapping: withMapping ? mapping : undefined,
      });
      setPreview(result);
      if (commit) {
        refresh();
        setFile(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const needsMapping = preview !== null && preview.mapping === null;

  return (
    <Surface title="Utility meter data">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Import your utility's daily import and export.
        <Hint>
          Self-consumption then stops being the share you estimated and becomes what actually
          crossed the boundary — measured by the meter your bill is calculated from, going back
          to the day the array went live.
        </Hint>
      </Typography>

      {status && status.days > 0 && (
        <Typography variant="body2" sx={{ color: solar.ink.pri, mb: 2 }}>
          {status.days} days imported, {status.firstDate} to {status.lastDate}
          {status.source ? ` (${status.source})` : ''}.
          {status.unmeteredDays > 0 && (
            <Box component="span" sx={{ color: solar.status.warn, display: 'block', mt: 0.5 }}>
              {status.unmeteredDays} of them are excluded — see below.
            </Box>
          )}
        </Typography>
      )}

      <input
        ref={picker}
        type="file"
        accept=".xlsx,.xls,.csv"
        style={{ display: 'none' }}
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          if (!chosen) return;
          setFile(chosen);
          setPreview(null);
          void run(chosen, false);
        }}
      />
      <Button variant="contained" size="small" disabled={busy} onClick={() => picker.current?.click()}>
        Choose a usage export
      </Button>
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
        A spreadsheet or CSV from your utility&rsquo;s usage page. Nothing is stored until you
        confirm what it found.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}

      {/*
        The unmetered warning goes above the confirm button, not below it.

        It is the one thing on this card that changes what the numbers mean, and a caveat
        underneath the action it qualifies is a caveat nobody read.
      */}
      {preview?.unmeteredNote && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {preview.unmeteredNote}
        </Alert>
      )}

      {preview && !needsMapping && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="body2" sx={{ color: solar.ink.pri }}>
            {preview.stored !== undefined
              ? `Stored ${preview.stored} days.`
              : `Found ${preview.readings.length} days${
                  preview.readings.length
                    ? `, ${preview.readings[0].date} to ${preview.readings.at(-1)!.date}`
                    : ''
                }.`}
          </Typography>
          {preview.problems.length > 0 && (
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.5 }}>
              {preview.problems.length} row(s) skipped: {preview.problems.slice(0, 3).join('; ')}
              {preview.problems.length > 3 ? ' …' : ''}
            </Typography>
          )}
          {preview.stored === undefined && preview.readings.length > 0 && (
            <Button
              variant="contained"
              size="small"
              disabled={busy || !file}
              sx={{ mt: 1.5 }}
              onClick={() => file && void run(file, true, preview.mapping === null)}
            >
              Store these {preview.readings.length} days
            </Button>
          )}
        </Box>
      )}

      {/*
        The mapping fallback, which is what makes a utility nobody has seen before work
        anyway. Only shown when detection declined — and it declines rather than guesses,
        because a column named "Delivered" is the utility delivering to you on one bill and
        you delivering to them on another.
      */}
      {needsMapping && (
        <Box sx={{ mt: 2 }}>
          <Alert severity="info" sx={{ mb: 2 }}>
            The columns in this file were not recognised. Say which is which — it is only
            asked once per format.
          </Alert>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {([
              ['date', 'Date'],
              ['imported', 'From the grid'],
              ['exported', 'To the grid'],
            ] as const).map(([role, label]) => (
              <TextField
                key={role}
                select
                size="small"
                label={label}
                value={mapping[role]}
                sx={{ minWidth: 170 }}
                onChange={(event) => setMapping({ ...mapping, [role]: Number(event.target.value) })}
              >
                {preview.headers.map((header, index) => (
                  <MenuItem key={`${header}-${index}`} value={index}>
                    {header || `column ${index + 1}`}
                  </MenuItem>
                ))}
              </TextField>
            ))}
          </Box>
          <Button
            variant="outlined"
            size="small"
            disabled={busy || !file}
            sx={{ mt: 1.5 }}
            onClick={() => file && void run(file, false, true)}
          >
            Read it again with these columns
          </Button>
        </Box>
      )}
    </Surface>
  );
}
