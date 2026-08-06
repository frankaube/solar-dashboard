import { ReactElement, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { RecoverySummary, fetchRecovery } from '../api';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * What the machine has had to do to keep itself running.
 *
 * The Pi repairs its own network now: it bounces the link, reloads the driver, and reboots
 * if neither worked. Every one of those is a success, and that is exactly the danger — a box
 * quietly rebooting itself each night looks, from this app, identical to one that has never
 * needed to. Self-healing that hides the fault converts a visible outage into an invisible
 * decline, and the first anyone hears of it is when the repair stops working.
 *
 * So it renders nothing when nothing has happened, and says something increasingly blunt as
 * the count climbs. One bounce in a fortnight is a network having a bad evening. Two reboots
 * is hardware, and this should say so rather than showing a tidy green tick.
 */

const LABELS: Record<string, string> = {
  'link-bounce': 'Restarted the network connection',
  'driver-reload': 'Reloaded the network driver',
  reboot: 'Restarted the machine',
  recovered: 'Network came back',
};

export function RecoveryCard(): ReactElement | null {
  const [summary, setSummary] = useState<RecoverySummary | null>(null);

  useEffect(() => {
    fetchRecovery()
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

  // Nothing to report is the normal state, and so is having no watchdog at all — a Docker
  // or from-source install has nothing to write the log. Both should be silence.
  if (!summary || summary.events.length === 0) return null;

  const serious = summary.reboots >= 2;

  return (
    <Surface
      title="Kept itself running"
      action={
        <Typography variant="mono" sx={{ color: serious ? solar.status.warn : solar.ink.sec }}>
          {summary.repairs} {summary.repairs === 1 ? 'repair' : 'repairs'}
        </Typography>
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {summary.verdict && (
          <Typography
            variant="body2"
            sx={{ color: serious ? solar.status.warn : solar.ink.sec }}
          >
            {summary.verdict}
          </Typography>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {summary.events.slice(0, 8).map((event) => (
            <Typography key={`${event.at}-${event.action}`} variant="caption" color="text.secondary">
              {new Date(event.at).toLocaleString([], {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}{' '}
              — {LABELS[event.action] ?? event.action}
            </Typography>
          ))}
        </Box>
      </Box>
    </Surface>
  );
}
