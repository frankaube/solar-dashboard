import { ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { setDeviceRole } from '../api';
import { solar } from '../theme';

/**
 * Declare that a meter is clamped on the service entrance.
 *
 * The single highest-value setting in this app, and it takes one click. Everything else
 * here measures one appliance; this one measures the boundary, and once it exists the
 * savings page stops resting on a percentage the owner typed into Settings and starts
 * resting on what actually left the property.
 *
 * Worded to say what it changes rather than what it is. "Role: mains" is a database
 * column; "this is where the house meets the grid" is the thing someone standing at a
 * panel with a clamp in their hand can actually answer, and getting it wrong is the one
 * mistake here that produces plausible numbers rather than obvious ones.
 */
export function MainsMeter({
  deviceId,
  deviceName,
  isMains,
  onSaved,
}: {
  deviceId: number;
  deviceName: string;
  isMains: boolean;
  onSaved: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await setDeviceRole(deviceId, isMains ? null : 'mains');
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ mt: 1.5, pt: 1.5, borderTop: `1px solid ${solar.grid.line}` }}>
      <Typography variant="body2" sx={{ color: solar.ink.pri, fontWeight: 600 }}>
        {isMains ? 'Measuring the whole property' : 'Is this clamped on the main service?'}
      </Typography>
      <Typography variant="caption" sx={{ color: solar.ink.sec, display: 'block', mt: 0.5 }}>
        {isMains
          ? `Self-consumption is measured from ${deviceName} — production minus what actually left the property — rather than estimated from the share set in Settings.`
          : 'Only say yes if its clamps are on the incoming service conductors, before anything branches off. A meter on a sub-panel sees part of the house, and the figures it would produce look entirely reasonable while being wrong.'}
      </Typography>
      {error && (
        <Typography variant="caption" sx={{ color: solar.status.critical, display: 'block', mt: 0.5 }}>
          {error}
        </Typography>
      )}
      <Button size="small" variant={isMains ? 'outlined' : 'contained'} disabled={busy} onClick={() => void toggle()} sx={{ mt: 1 }}>
        {isMains ? 'This is not the main service' : 'Yes — this is the main service'}
      </Button>
    </Box>
  );
}
