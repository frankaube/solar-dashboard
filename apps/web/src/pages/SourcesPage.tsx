import { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { Attempt, SourceRow, SourceState, fetchSources, usePolling } from '../api';
import { Surface } from '../components/Surface';
import { solar } from '../theme';

/**
 * Whether the dashboard is actually being told anything — a different question from Health's
 * "is anything wrong with the array". A source that stops reporting leaves its last good
 * reading on screen, which looks like a quiet day.
 *
 * Nothing here probes anything: every figure comes from readings already in the database, so
 * this page adds no traffic to a gateway that handles one connection at a time.
 */

const POLL_MS = 60_000;

const LABEL: Record<SourceState, string> = {
  live: 'Live',
  partial: 'Partial',
  late: 'Late',
  silent: 'Silent',
  never: 'Never',
  off: 'Not set up',
};

/** Pill colours, from the token set rather than picked here. */
function pillOf(state: SourceState): { bg: string; border: string; fg: string } {
  if (state === 'live') return solar.pill.ok;
  if (state === 'partial' || state === 'late') return solar.pill.warn;
  if (state === 'silent' || state === 'never') return solar.pill.bad;
  return solar.pill.neutral;
}

function Pill({ state }: { state: SourceState }): ReactElement {
  const tone = pillOf(state);
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex', alignItems: 'center', gap: '6px', px: '9px', py: '4px',
        borderRadius: 999, border: '1px solid', whiteSpace: 'nowrap',
        background: tone.bg, borderColor: tone.border, color: tone.fg,
        font: `600 10px/1 ${solar.font.sans}`, letterSpacing: '.06em', textTransform: 'uppercase',
      }}
    >
      {/*
        Shape as well as hue. "Never" is a square and "not set up" is hollow, so the three
        kinds of nothing stay apart in greyscale and for a reader who cannot separate the
        colours — which matters most here, where every row is some shade of the same warning.
      */}
      <Box
        component="span"
        sx={{
          width: 7, height: 7, flex: '0 0 7px',
          borderRadius: state === 'never' ? '1px' : '50%',
          background: state === 'off' ? 'transparent' : 'currentColor',
          border: state === 'off' ? '1.5px solid currentColor' : 0,
        }}
      />
      {LABEL[state]}
    </Box>
  );
}

/**
 * The last twelve poll windows, oldest at the left. One "last seen" says a source answered
 * recently; twelve marks say whether it has been answering reliably.
 */
function Strip({ attempts, cadence }: { attempts: Attempt[]; cadence: string }): ReactElement {
  const missed = attempts.filter((a) => a === 'miss').length;
  const expected = attempts.filter((a) => a !== 'none').length;
  const title = expected === 0
    ? 'Nothing is expected from this source'
    : `${expected - missed} of the last ${expected} windows landed a reading, every ${cadence}`;
  return (
    <Tooltip title={title}>
      <Box component="span" tabIndex={0} sx={{ display: 'inline-flex', gap: '2px', cursor: 'help' }}>
        {attempts.map((attempt, index) => (
          <Box
            key={index}
            component="span"
            sx={{
              width: 5, height: 16, borderRadius: '1.5px',
              // Every mark at full strength: fading the older windows reads as "not filled"
              // in a row of identical marks, so twelve out of twelve looks like eight.
              background:
                attempt === 'ok' ? solar.status.ok
                : attempt === 'miss' ? solar.status.critical
                : solar.surface.borderStrong,
            }}
          />
        ))}
      </Box>
    </Tooltip>
  );
}

/** "41s ago", "18 h ago", "never". Never is italic, because it is not a duration. */
function Age({ at, state }: { at: string | null; state: SourceState }): ReactElement {
  if (at === null) {
    return (
      <Typography variant="mono" sx={{ color: solar.ink.faint, fontStyle: 'italic' }}>
        {state === 'off' ? '—' : 'never'}
      </Typography>
    );
  }
  const seconds = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  const text =
    seconds < 90 ? `${seconds}s ago`
    : seconds < 5400 ? `${Math.round(seconds / 60)} min ago`
    : seconds < 172_800 ? `${Math.round(seconds / 3600)} h ago`
    : `${Math.round(seconds / 86_400)} d ago`;
  const bad = state === 'silent' || state === 'never';
  return (
    <Typography variant="mono" sx={{ color: bad ? solar.status.critical : solar.ink.sec }}>
      {text}
    </Typography>
  );
}

function Row({ source }: { source: SourceRow }): ReactElement {
  const attn = source.state === 'silent' || source.state === 'never';
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr auto', md: 'minmax(200px,2fr) 110px 130px 110px auto' },
        alignItems: 'center', gap: 3, py: 3, px: 3,
        borderRadius: '8px',
        borderBottom: `1px solid ${solar.grid.line}`,
        '&:last-of-type': { borderBottom: 0 },
        background: attn ? `${solar.status.critical}0e` : 'transparent',
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <Typography variant="body2" sx={{ color: solar.ink.pri, fontWeight: 500 }}>
          {source.name}
        </Typography>
        <Typography variant="mono" sx={{ color: solar.ink.dim }}>
          {source.detail}
        </Typography>
      </Box>
      <Box><Pill state={source.state} /></Box>
      <Typography variant="mono" sx={{ color: solar.ink.dim, display: { xs: 'none', md: 'block' } }}>
        {source.cadenceText}
      </Typography>
      <Box sx={{ display: { xs: 'none', md: 'block' } }}>
        <Age at={source.lastSeenAt} state={source.state} />
      </Box>
      <Box sx={{ display: { xs: 'none', md: 'block' } }}>
        <Strip attempts={source.attempts} cadence={source.cadenceText} />
      </Box>
    </Box>
  );
}

export function SourcesPage(): ReactElement {
  const { data } = usePolling(fetchSources, POLL_MS);

  if (!data) {
    return (
      <Typography variant="body2" color="text.disabled">
        Looking at what has been reporting…
      </Typography>
    );
  }

  const tally = [
    { key: 'answering', label: 'Answering', value: data.tally.answering, color: solar.status.ok },
    { key: 'late', label: 'Late or partial', value: data.tally.late, color: solar.status.warn },
    { key: 'silent', label: 'Silent', value: data.tally.silent, color: solar.status.critical },
    { key: 'never', label: 'Never answered', value: data.tally.never, color: solar.status.critical },
    { key: 'off', label: 'Not set up', value: data.tally.off, color: solar.ink.faint },
  ].filter((entry) => entry.value > 0);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <Surface hero sx={{ p: 7, borderRadius: `${solar.radius.hero}px`, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <Typography variant="answer" component="h2" sx={{ color: 'text.primary' }}>
          {data.headline ?? 'Nothing is configured to report yet.'}
        </Typography>
        <Box sx={{ display: 'flex', gap: { xs: 6, md: 11 }, flexWrap: 'wrap' }}>
          {tally.map((entry) => (
            <Box key={entry.key} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="overline" color="text.disabled">{entry.label}</Typography>
              <Typography variant="metricLg" sx={{ color: entry.color }}>{entry.value}</Typography>
            </Box>
          ))}
        </Box>
      </Surface>

      {/*
        Surface keeps its own padding. Zeroing it so the rows could run edge to edge also
        stripped the padding its TITLE needs, so every group heading sat hard against the
        card's rounded corner and lost its first letter to the overflow clip.
      */}
      {data.groups.map((group) => (
        <Surface key={group.id} title={group.title}>
          <Box
            sx={{
              display: { xs: 'none', md: 'grid' },
              gridTemplateColumns: 'minmax(200px,2fr) 110px 130px 110px auto',
              gap: 3, px: 3, pb: 2,
              borderBottom: `1px solid ${solar.surface.border}`,
            }}
          >
            {['Source', 'State', 'Every', 'Last heard', 'Recent polls'].map((head) => (
              <Typography key={head} variant="overline" color="text.disabled">{head}</Typography>
            ))}
          </Box>
          {group.sources.map((source) => <Row key={source.id} source={source} />)}
          {group.note && (
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ display: 'block', px: 3, pt: 3, mt: 2, borderTop: `1px solid ${solar.surface.border}` }}
            >
              {group.note}
            </Typography>
          )}
        </Surface>
      ))}

      <Typography variant="caption" color="text.disabled">
        Nothing here contacts a device — every figure is already stored.
      </Typography>
    </Box>
  );
}
