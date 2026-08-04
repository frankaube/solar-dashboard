import { ReactElement, useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { ArrayCensusCard } from '../components/ArrayCensusCard';
import { Alerts, Census, PowerPoint, Snapshot, Summary, ackAlert, fetchCensus } from '../api';
import { Surface } from '../components/Surface';
import { NotificationLog } from '../components/NotificationLog';
import { Issue, Rank, issueHeading, mergeIssues, pollFreshness, verdict } from './healthSummary';
import { solar } from '../theme';

/**
 * Is anything wrong? — answered before anything is explained.
 *
 * The previous version of this page ran to roughly seven hundred words. Three systems each
 * presented themselves in full: the alert engine, the array census with a paragraph under
 * every one of its six findings, and the fleet vitals. None of them answered the question
 * the page exists for, so you had to read all of it to find out that the answer was "three
 * things, one of them since this morning".
 *
 * Now: a verdict you can read without focusing, a strip of vital signs, and one ranked list
 * of everything wrong at one line apiece. The prose still exists — it was good prose, and
 * the census explanations are the most useful writing in the app — but it waits behind a
 * click instead of standing between you and the answer.
 */

const STRIP_CELLS = 48;

const TONE: Record<Rank, string> = {
  serious: solar.status.critical,
  warning: solar.status.warn,
  info: solar.status.info,
  ok: solar.status.ok,
};

function pollStrip(history: PowerPoint[] | null): boolean[] {
  const now = Date.now();
  return Array.from({ length: STRIP_CELLS }, (_, i) => {
    const start = now - (STRIP_CELLS - i) * 30 * 60_000;
    return (history ?? []).some((p) => {
      const t = new Date(p.t).getTime();
      return t >= start && t < start + 30 * 60_000;
    });
  });
}

/**
 * The one thing on this page that must read at a glance.
 *
 * A band of colour and four words. Everything below it is detail for somebody who has
 * already learned, from this, whether they need any.
 */
function Verdict({ rank, headline, detail }: { rank: Rank; headline: string; detail: string }): ReactElement {
  return (
    <Surface>
      <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start' }}>
        <Box
          sx={{
            width: 4,
            alignSelf: 'stretch',
            minHeight: 44,
            borderRadius: '2px',
            bgcolor: TONE[rank],
            flex: '0 0 4px',
          }}
        />
        <Box>
          <Typography sx={{ font: `600 22px/1.2 ${solar.font.sans}`, color: TONE[rank] }}>
            {headline}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {detail}
          </Typography>
        </Box>
      </Box>
    </Surface>
  );
}

/** A vital sign: a number, what it is, and whether it is the expected number. */
function Vital({
  label,
  value,
  bad,
}: {
  label: string;
  value: string;
  bad?: boolean;
}): ReactElement {
  return (
    <Box>
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography
        variant="mono"
        sx={{ fontSize: 17, color: bad ? solar.status.warn : solar.ink.pri }}
      >
        {value}
      </Typography>
    </Box>
  );
}

/** One line, and the paragraph only if asked for. */
function IssueRow({
  issue,
  onAck,
}: {
  issue: Issue;
  onAck: (id: number) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(issue.detail);
  return (
    <Box
      sx={{
        py: 2,
        borderBottom: '1px solid',
        borderColor: 'divider',
        '&:last-of-type': { borderBottom: 'none', pb: 0 },
        opacity: issue.acknowledged ? 0.55 : 1,
      }}
    >
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'baseline' }}>
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '999px',
            bgcolor: TONE[issue.rank],
            flex: '0 0 8px',
            transform: 'translateY(1px)',
          }}
        />
        <Typography
          variant="body2"
          onClick={expandable ? () => setOpen((v) => !v) : undefined}
          sx={{
            flex: 1,
            color: solar.ink.pri,
            cursor: expandable ? 'pointer' : 'default',
          }}
        >
          {issue.title}
          {expandable && (
            <Box component="span" sx={{ color: solar.ink.dim, ml: 1, fontSize: 11 }}>
              {open ? '−' : '+'}
            </Box>
          )}
        </Typography>
        {/*
          Opacity alone did not carry this. A dimmed row reads as "less important" rather
          than "you have already seen this and chosen to live with it", and those are
          different enough that the verdict counts them separately.
        */}
        {issue.acknowledged && (
          <Typography variant="caption" sx={{ color: solar.ink.dim, fontSize: 10.5 }}>
            acknowledged
          </Typography>
        )}
        {issue.since && (
          <Typography variant="mono" sx={{ color: 'text.disabled', fontSize: 11 }}>
            {new Date(issue.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Typography>
        )}
      </Box>

      <Collapse in={open}>
        {issue.detail && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, ml: 3 }}>
            {issue.detail}
          </Typography>
        )}
      </Collapse>

      {(issue.alertId !== null || issue.locatable) && (
        <Box sx={{ display: 'flex', gap: 1.5, mt: 1.5, ml: 3 }}>
          {issue.alertId !== null && !issue.acknowledged && (
            <Button size="small" variant="outlined" onClick={() => onAck(issue.alertId!)}>
              Acknowledge
            </Button>
          )}
          {issue.locatable && (
            <Button size="small" variant="outlined" component={RouterLink} to="/system/roof">
              Show on roof
            </Button>
          )}
        </Box>
      )}
    </Box>
  );
}

interface HealthPageProps {
  summary: Summary | null;
  live: Snapshot | null;
  alerts: Alerts | null;
  history: PowerPoint[] | null;
  refreshAlerts: () => void;
}

export function HealthPage({
  summary,
  live,
  alerts,
  history,
  refreshAlerts,
}: HealthPageProps): ReactElement {
  const [census, setCensus] = useState<Census | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const loadCensus = useCallback(() => {
    fetchCensus()
      .then(setCensus)
      .catch(() => setCensus(null));
  }, []);
  useEffect(loadCensus, [loadCensus]);

  const resolved = alerts?.recentlyClosed ?? [];
  const issues = mergeIssues(alerts?.active ?? [], census);
  const result = verdict(issues);
  const freshness = pollFreshness(summary?.updatedAt ?? null, Date.now());

  const invertersBad = Boolean(summary && summary.invertersOnline < summary.invertersTotal);
  const panelsBad = Boolean(live && summary?.panelsTotal && live.ports.length < summary.panelsTotal);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 720 }}>
      {/*
        Stale data outranks the verdict, because it invalidates it. "All clear" computed
        from readings that stopped arriving three hours ago is not health — it is the last
        health this app saw, and the two are indistinguishable on screen.
      */}
      {freshness.stale ? (
        <Verdict
          rank="warning"
          headline="Not hearing from the array"
          detail={`The last reading arrived ${freshness.text}. Nothing below is current.`}
        />
      ) : (
        <Verdict rank={result.rank} headline={result.headline} detail={result.detail} />
      )}

      <Surface>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(3, 1fr)' },
            gap: 3,
            mb: 3,
          }}
        >
          <Vital
            label="Inverters online"
            value={summary ? `${summary.invertersOnline} / ${summary.invertersTotal}` : '—'}
            bad={invertersBad}
          />
          <Vital
            label="Panels reporting"
            value={live && summary?.panelsTotal ? `${live.ports.length} / ${summary.panelsTotal}` : '—'}
            bad={panelsBad}
          />
          <Vital label="Last reading" value={freshness.text} bad={freshness.stale} />
        </Box>

        {/* 24 h of polls. A gap here is the shape of an outage, and needs no words. */}
        <Box sx={{ display: 'flex', gap: '2px' }}>
          {pollStrip(history).map((seen, i) => (
            <Box
              key={i}
              sx={{
                flex: 1,
                height: 18,
                borderRadius: '2px',
                bgcolor: seen ? `${solar.status.ok}55` : solar.surface.border,
              }}
            />
          ))}
        </Box>
        <Typography variant="caption" color="text.disabled" sx={{ mt: 1.5, display: 'block' }}>
          Polls, last 24 h
        </Typography>

        <Collapse in={showDetail}>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, mt: 3 }}>
            <Vital
              label="Grid"
              value={
                summary?.gridVoltage
                  ? `${summary.gridVoltage.toFixed(1)} V · ${summary.gridFrequency?.toFixed(2)} Hz`
                  : '—'
              }
            />
            <Vital
              label="RF weakest link"
              value={
                live?.inverters.length
                  ? `${Math.min(...live.inverters.map((inv) => inv.rfSignal))} dB`
                  : '—'
              }
            />
          </Box>
        </Collapse>
        <Link
          component="button"
          type="button"
          onClick={() => setShowDetail((v) => !v)}
          underline="hover"
          sx={{
            font: `600 12.5px/1 ${solar.font.sans}`,
            color: solar.accent.link,
            mt: 3,
            display: 'inline-block',
          }}
        >
          {showDetail ? 'Hide electrical detail' : 'Electrical detail'}
        </Link>
      </Surface>

      {issues.length > 0 && (
        <Surface title={issueHeading(issues)}>
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            {issues.map((issue) => (
              <IssueRow
                key={issue.key}
                issue={issue}
                onAck={(id) => void ackAlert(id).then(refreshAlerts)}
              />
            ))}
          </Box>
        </Surface>
      )}

      {/*
        Everything below is reference rather than status, and none of it should compete with
        the verdict for attention — so it is one link until somebody wants it. The census
        card in particular is six paragraphs; its findings are already in the list above,
        and what is left here is the size arithmetic and the calculator.
      */}
      <Link
        component="button"
        type="button"
        onClick={() => setShowHistory((v) => !v)}
        underline="hover"
        sx={{
          font: `600 12.5px/1 ${solar.font.sans}`,
          color: solar.accent.link,
          alignSelf: 'flex-start',
        }}
      >
        {showHistory ? 'Hide detail & history' : 'Detail & history'}
      </Link>
      <Collapse in={showHistory}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <ArrayCensusCard showFindings={false} />
          <NotificationLog />
          {resolved.length > 0 && (
            <Surface title="Recently resolved">
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                {resolved.slice(0, 8).map((alert) => (
                  <Typography key={alert.id} variant="caption" color="text.secondary">
                    {new Date(alert.closedAt!).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    — {alert.message}
                  </Typography>
                ))}
              </Box>
            </Surface>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}
