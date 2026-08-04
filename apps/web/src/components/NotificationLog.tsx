import { ReactElement, useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { NotificationRecord, fetchNotificationHistory } from '../api';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * Everything the app has told you, whether or not anything carried it away.
 *
 * These used to exist only as a push. The notifier resolved a webhook and returned early
 * when there was none — which on a default install is always — so the sunset daily summary,
 * which appears nowhere else in this app, was composed every evening and dropped. This is
 * where it lives now, and on an install with no ntfy topic it is not a secondary view of
 * the notifications; it is the only one.
 */

const FIRST_PAGE = 30;
const MORE = 120;

/**
 * The delivery state, in words rather than a coloured dot.
 *
 * Three states, and the distinction between the last two is the useful one: nothing to send
 * it to is the normal condition of an install that has not set up a webhook, while a
 * failure means one is configured and broken. A single "not delivered" would put a mark of
 * concern against every default install.
 */
function delivery(record: NotificationRecord): { text: string; color: string; hint: string } {
  if (record.deliveredAt) {
    return {
      text: 'sent',
      color: solar.ink.dim,
      hint: `Delivered to your webhook at ${new Date(record.deliveredAt).toLocaleString()}.`,
    };
  }
  if (record.error) {
    return {
      text: 'failed',
      color: solar.status.warn,
      hint: record.error,
    };
  }
  return {
    text: 'here only',
    color: solar.ink.dim,
    hint: 'No webhook is configured, so this was recorded here and sent nowhere. Settings → Alerts adds one.',
  };
}

export function NotificationLog(): ReactElement {
  const [records, setRecords] = useState<NotificationRecord[] | null>(null);
  const [limit, setLimit] = useState(FIRST_PAGE);

  const load = useCallback(() => {
    fetchNotificationHistory(limit)
      .then(setRecords)
      .catch(() => setRecords(null));
  }, [limit]);
  useEffect(load, [load]);

  if (!records) {
    return (
      <Surface title="Notifications">
        <Typography variant="body2" color="text.secondary">
          Loading…
        </Typography>
      </Surface>
    );
  }

  if (records.length === 0) {
    return (
      <Surface title="Notifications">
        <Typography variant="body2" color="text.secondary">
          Nothing yet. Alerts, resolutions and the daily summary at sunset will appear here as
          they happen — whether or not you have set up a webhook to receive them.
        </Typography>
      </Surface>
    );
  }

  return (
    <Surface title="Notifications">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Everything the app has raised, newest first — alerts, resolutions, and the daily
        summary at sunset. Recorded here even when there is no webhook to send it to.
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
        {records.map((record) => {
          const state = delivery(record);
          return (
            <Box
              key={record.id}
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: '132px 1fr auto' },
                gap: { xs: '4px', sm: 2 },
                alignItems: 'baseline',
                py: 2,
                borderBottom: '1px solid',
                borderColor: 'divider',
                '&:last-of-type': { borderBottom: 'none', pb: 0 },
              }}
            >
              <Typography
                variant="caption"
                sx={{ color: solar.ink.dim, font: `400 11.5px/1.4 ${solar.font.mono}` }}
              >
                {new Date(record.raisedAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Typography>
              <Box>
                {record.title && (
                  <Typography variant="body2" sx={{ color: solar.ink.pri }}>
                    {record.title}
                  </Typography>
                )}
                {/*
                  The daily summary is several lines of prose, so the newlines it was
                  written with are kept rather than collapsed into one run-on paragraph.
                */}
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {record.body}
                </Typography>
              </Box>
              <Tooltip title={state.hint}>
                <Typography
                  variant="caption"
                  sx={{ color: state.color, cursor: 'help', justifySelf: { sm: 'end' } }}
                >
                  {state.text}
                </Typography>
              </Tooltip>
            </Box>
          );
        })}
      </Box>

      {records.length >= limit && (
        <Link
          component="button"
          type="button"
          onClick={() => setLimit(MORE)}
          underline="hover"
          sx={{
            font: `600 12.5px/1 ${solar.font.sans}`,
            color: solar.accent.link,
            mt: 3,
            display: 'inline-block',
          }}
        >
          Show more
        </Link>
      )}
    </Surface>
  );
}
