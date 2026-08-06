import { ReactElement, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  ImportSummary,
  applyCloudImport,
  fetchCloudImports,
  previewCloudImport,
  undoCloudImport,
} from '../api';
import { Hint } from './Hint';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * Repairing a hole in the power history from the vendor's own export.
 *
 * The dashboard records what it managed to poll. Miss a window — a machine asleep through a
 * sunrise, a wifi adapter that drops at 04:23 and does not come back — and the day's kWh
 * survives, because the gateway's counter is cumulative and lives on the gateway. The
 * five-minute power curve does not: it has a hole that nothing but the vendor's record can
 * fill.
 *
 * This existed only as a Node script, which was fine until somebody needed it on a Pi: the
 * release ships one executable with no Node and no Prisma, so the documented repair could
 * not be run on the machines that get gaps.
 *
 * It previews first, always. This writes into the only copy of the measurement history, and
 * an import that parses and saves in one motion gives nobody the moment they need to notice
 * that the file covers the wrong day.
 */

const PLACEHOLDER = `2026-08-06 05:35\t0
2026-08-06 05:40\t142
2026-08-06 05:45\t318`;

export function GapFillCard(): ReactElement {
  const [text, setText] = useState('');
  const [date, setDate] = useState('');
  const [plan, setPlan] = useState<ImportSummary | null>(null);
  const [existing, setExisting] = useState<Array<{ localDate: string; rows: number }>>([]);
  const [busy, setBusy] = useState<'preview' | 'apply' | 'undo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const loadExisting = useCallback(() => {
    fetchCloudImports()
      .then(setExisting)
      .catch(() => setExisting([]));
  }, []);
  useEffect(loadExisting, [loadExisting]);

  const run = (mode: 'preview' | 'apply'): void => {
    setBusy(mode);
    setError(null);
    setDone(null);
    const request = mode === 'preview' ? previewCloudImport : applyCloudImport;
    request(text, date || undefined)
      .then((result) => {
        setPlan(result);
        if (result.applied) {
          setDone(`Filled ${result.inserted} reading${result.inserted === 1 ? '' : 's'}.`);
          setText('');
          loadExisting();
        }
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(null));
  };

  const undo = (day: string): void => {
    setBusy('undo');
    setError(null);
    undoCloudImport(day)
      .then((result) => {
        setDone(`Removed ${result.removed} imported reading${result.removed === 1 ? '' : 's'} from ${day}.`);
        setPlan(null);
        loadExisting();
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(null));
  };

  const local = (iso: string | null): string =>
    iso ? new Date(iso).toLocaleString([], { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <Surface
      title="Fill a gap in the history"
      action={
        existing.length > 0 ? (
          <Typography variant="mono" sx={{ color: solar.ink.sec }}>
            {existing.reduce((sum, day) => sum + day.rows, 0)} imported
          </Typography>
        ) : undefined
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Typography variant="body2" color="text.secondary">
          Paste your inverter vendor&rsquo;s export for a period this app missed.
          <Hint>
            Only the power curve can have holes — the day&rsquo;s total comes from a counter on
            the gateway itself and survives any outage. Imported readings are marked as
            imported and never replace one this app recorded, so this cannot overwrite your
            own measurements or inflate a day.
          </Hint>
        </Typography>

        <TextField
          multiline
          minRows={4}
          maxRows={10}
          size="small"
          label="Export rows"
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setPlan(null);
          }}
          slotProps={{ input: { sx: { font: `400 12px/1.6 ${solar.font.mono}` } } }}
        />

        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          {/*
            Only needed by older exports. One that carries "2026-08-06 05:35" says which day
            it is; one with a bare "05:35" does not, and assuming today would file last
            week's export under this morning — rows that look real, in the wrong place,
            forever.
          */}
          <TextField
            size="small"
            label="Day (only if rows have no date)"
            placeholder="2026-08-06"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            sx={{ width: 240 }}
          />
          <Button
            size="small"
            variant="outlined"
            disabled={busy !== null || !text.trim()}
            onClick={() => run('preview')}
          >
            {busy === 'preview' ? 'Reading…' : 'Preview'}
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={busy !== null || !plan || plan.inserted === 0 || plan.applied}
            onClick={() => run('apply')}
          >
            {busy === 'apply' ? 'Filling…' : 'Fill the gap'}
          </Button>
        </Box>

        {plan && !plan.applied && (
          <Alert severity={plan.inserted > 0 ? 'info' : 'warning'}>
            {plan.inserted > 0 ? (
              <>
                {plan.inserted} reading{plan.inserted === 1 ? '' : 's'} to add
                {plan.from && ` — ${local(plan.from)} to ${local(plan.to)}`}
                {plan.covered > 0 && (
                  <>
                    . {plan.covered} refused: this app already recorded {plan.covered === 1 ? 'that moment' : 'those moments'}
                  </>
                )}
                .
                {/*
                  The number that proves an import cannot inflate a day. Energy is rebuilt
                  from the power curve, so it always lands under the gateway's own counter —
                  and showing both is what lets somebody check that rather than trust it.
                */}
                {plan.perDay.map((day) => (
                  <Typography key={day.date} variant="caption" sx={{ display: 'block', mt: 1 }}>
                    {day.date}: adds up to {day.importedPeakWh} Wh, against{' '}
                    {day.recordedPeakWh} Wh the gateway already recorded
                    {day.recordedPeakWh > 0 && day.importedPeakWh < day.recordedPeakWh
                      ? ' — the day total is unaffected'
                      : ''}
                  </Typography>
                ))}
              </>
            ) : (
              <>Nothing to fill — this app already has a reading for every row in that export.</>
            )}
          </Alert>
        )}

        {error && <Alert severity="warning">{error}</Alert>}
        {done && <Alert severity="success">{done}</Alert>}

        {existing.length > 0 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="caption" color="text.disabled">
              Days carrying imported readings. Removing them takes only the imported ones.
            </Typography>
            {existing.map((day) => (
              <Box key={day.localDate} sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <Typography variant="body2" sx={{ flex: 1 }}>
                  {day.localDate}{' '}
                  <Typography component="span" variant="caption" color="text.disabled">
                    ({day.rows} imported)
                  </Typography>
                </Typography>
                <Button size="small" color="inherit" disabled={busy !== null} onClick={() => undo(day.localDate)}>
                  Remove
                </Button>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Surface>
  );
}
