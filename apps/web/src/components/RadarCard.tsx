import { ReactElement, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { RadarStatus, fetchRadarStatus, setRadarEnabled } from '../api';
import { Hint } from './Hint';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * The switch for the one feature here that reaches outside the house.
 *
 * Everything else on this page is drawn from local data. Radar is not — it is a picture of
 * the sky above these coordinates, and somebody has to fetch it. This app does that from the
 * server rather than the browser, so the request carries the household's rough position to
 * one place, once every five minutes, instead of to a tile server on every page load.
 *
 * That is still an outbound request, so it is off until asked for, and the card says what
 * turning it on means rather than describing it as "enable radar". A privacy decision
 * presented as a feature toggle is not a decision anybody got to make.
 */

const SOURCE_NAMES: Record<string, string> = {
  eccc: 'Environment and Climate Change Canada',
  rainviewer: 'RainViewer',
};

export function RadarCard(): ReactElement {
  const [status, setStatus] = useState<RadarStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchRadarStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(load, [load]);

  const toggle = (on: boolean): void => {
    setBusy(true);
    setRadarEnabled(on)
      .then(setStatus)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const located = status?.source !== null && status?.source !== undefined;

  return (
    <Surface
      title="Radar"
      action={
        <Typography variant="mono" sx={{ color: status?.enabled ? solar.ink.sec : solar.ink.faint }}>
          {status?.enabled ? 'on' : 'off'}
        </Typography>
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <Switch
            checked={status?.enabled ?? false}
            disabled={busy || status === null || !located}
            onChange={(event) => toggle(event.target.checked)}
            slotProps={{ input: { 'aria-label': 'Show weather radar' } }}
          />
          <Typography variant="body2" sx={{ color: solar.ink.pri }}>
            Show weather radar on Trends
            <Hint>
              Production falling off a cliff at two in the afternoon is a question
              expected-versus-actual raises without answering. A radar frame answers it: a cell
              went over. One image centred on the array, not a map you can pan.
            </Hint>
          </Typography>
        </Box>

        {/*
          Said before the switch is flipped, not after. This is the only thing in the app that
          sends anything about this house anywhere without being an upload the owner chose.
        */}
        <Typography variant="caption" color="text.disabled">
          {located
            ? `Turning this on lets this machine ask ${
                SOURCE_NAMES[status!.source!] ?? status!.source
              } for a picture of the sky above your coordinates, about once every five minutes while
              the page is open. Your browser never talks to them directly.`
            : 'Needs a site location first — there is nowhere to centre the picture.'}
        </Typography>

        {status?.enabled && status.error && (
          <Alert severity="warning">
            {status.error} The panel on Trends says so rather than showing a broken image.
          </Alert>
        )}
      </Box>
    </Surface>
  );
}
