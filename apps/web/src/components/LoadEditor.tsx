import { ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { DeviceLoad, LoadType, setDeviceLoad } from '../api';
import { solar } from '../theme';

/**
 * Tell the app what a switch-only device runs.
 *
 * Most cheap smart plugs can report that a relay is closed and nothing else. The
 * owner, however, knows it is the pool pump — so on-time plus a rated wattage gives
 * energy the hardware could never measure.
 *
 * The load type is not a nicety. The same arithmetic is trustworthy for a heater and
 * close to meaningless for a variable-speed pump, so the options are worded to make
 * that choice obvious to someone who has never thought about it, and the resulting
 * figure carries the confidence its answer earned.
 */
const LOAD_TYPES: Array<{ value: LoadType; label: string; hint: string }> = [
  { value: 'resistive', label: 'Heater or element', hint: 'Baseboard, kettle, water heater' },
  { value: 'motor', label: 'Single-speed motor', hint: 'Pool pump, fan, fridge' },
  { value: 'variable', label: 'Variable speed', hint: 'Inverter pump, heat pump, EV charger' },
  { value: 'electronic', label: 'Electronics', hint: 'TV, computer, lights' },
];

export function LoadEditor({
  deviceId,
  current,
  onSaved,
}: {
  deviceId: number;
  current: DeviceLoad;
  onSaved: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(current.loadLabel ?? '');
  const [watts, setWatts] = useState(current.ratedW ? String(current.ratedW) : '');
  const [type, setType] = useState<LoadType | ''>(current.loadType ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (clear = false): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await setDeviceLoad(
        deviceId,
        clear
          ? { loadLabel: null, ratedW: null, loadType: null }
          : {
              loadLabel: label.trim() || null,
              // An empty field means "unset", not zero — the API rejects 0 anyway,
              // but sending null says what was meant.
              ratedW: watts.trim() ? Number(watts) : null,
              loadType: type || null,
            },
      );
      if (clear) {
        setLabel('');
        setWatts('');
        setType('');
      }
      setOpen(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button size="small" variant="outlined" onClick={() => setOpen(true)}>
        {current.ratedW ? 'Edit what this runs' : 'Say what this runs'}
      </Button>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        width: '100%',
        mt: 2,
        p: 3,
        borderRadius: '10px',
        border: '1px solid',
        borderColor: solar.surface.border,
      }}
    >
      <Typography variant="body2" color="text.secondary">
        This device can’t measure its own power. Tell us what it runs and we’ll estimate its
        energy from how long it’s on.
      </Typography>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          label="What it runs"
          placeholder="Pool pump"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          sx={{ flex: '1 1 180px' }}
        />
        <TextField
          size="small"
          label="Watts"
          placeholder="1100"
          value={watts}
          onChange={(e) => setWatts(e.target.value.replace(/[^\d.]/g, ''))}
          inputMode="numeric"
          sx={{ width: 110 }}
        />
      </Box>
      <TextField
        size="small"
        select
        label="Kind of load"
        value={type}
        onChange={(e) => setType(e.target.value as LoadType)}
        helperText="Decides how much to trust the estimate — a heater is exact, a variable-speed pump is a rough ceiling."
      >
        {LOAD_TYPES.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            <Box>
              <Typography sx={{ font: `500 13px/1.3 ${solar.font.sans}` }}>{option.label}</Typography>
              <Typography variant="caption" color="text.disabled">
                {option.hint}
              </Typography>
            </Box>
          </MenuItem>
        ))}
      </TextField>
      {error && (
        <Typography variant="caption" sx={{ color: solar.status.critical }}>
          {error}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
        <Button size="small" variant="contained" disabled={busy} onClick={() => void save()}>
          Save
        </Button>
        <Button size="small" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {current.ratedW && (
          <Button size="small" color="inherit" disabled={busy} onClick={() => void save(true)}>
            Clear
          </Button>
        )}
      </Box>
    </Box>
  );
}

const CONFIDENCE_COLOUR: Record<string, string> = {
  good: solar.status.ok,
  fair: solar.status.warn,
  rough: solar.ink.dim,
};

/**
 * An estimated energy figure, always labelled as one.
 *
 * A measured kWh and an inferred kWh must never look the same. This renders with a
 * tilde and the confidence the load type earned, so a rough ceiling cannot be mistaken
 * for a reading.
 */
export function EstimatedEnergy({
  kwh,
  confidence,
}: {
  kwh: number;
  confidence?: string;
}): ReactElement {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
      <Typography variant="mono" sx={{ color: solar.ink.sec }}>
        ~{kwh} kWh
      </Typography>
      {confidence && (
        <Typography
          sx={{
            font: `600 9.5px/1.3 ${solar.font.sans}`,
            textTransform: 'uppercase',
            letterSpacing: '.05em',
            color: CONFIDENCE_COLOUR[confidence] ?? solar.ink.dim,
          }}
        >
          {confidence === 'rough' ? 'rough estimate' : `${confidence} estimate`}
        </Typography>
      )}
    </Box>
  );
}
