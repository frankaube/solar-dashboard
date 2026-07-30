import { ReactElement, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { ArrayCensusCard } from '../components/ArrayCensusCard';
import { Alerts, PowerPoint, Snapshot, Summary, ackAlert } from '../api';
import { Metric, Surface } from '../components/Surface';
import { solar } from '../theme';

const SEVERITY_DOT: Record<string, string> = {
  serious: solar.status.critical,
  warning: solar.status.warn,
};
/** One cell = 30 min of expected 5-min polls. */
const STRIP_CELLS = 48;

function pollStrip(history: PowerPoint[] | null): string[] {
  const cells: string[] = [];
  const now = Date.now();
  for (let i = 0; i < STRIP_CELLS; i++) {
    const start = now - (STRIP_CELLS - i) * 30 * 60_000;
    const end = start + 30 * 60_000;
    const hasSample = (history ?? []).some((p) => {
      const t = new Date(p.t).getTime();
      return t >= start && t < end;
    });
    cells.push(hasSample ? '#5aa87a33' : '#2e2a25');
  }
  return cells;
}

interface HealthPageProps {
  summary: Summary | null;
  live: Snapshot | null;
  alerts: Alerts | null;
  history: PowerPoint[] | null;
  refreshAlerts: () => void;
}

export function HealthPage({ summary, live, alerts, history, refreshAlerts }: HealthPageProps): ReactElement {
  const active = alerts?.active ?? [];
  const resolved = alerts?.recentlyClosed ?? [];
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5, maxWidth: 720 }}>
      <Box sx={{ display: 'flex', gap: 4, alignItems: 'baseline' }}>
        <Typography variant="body2">Active {active.length}</Typography>
        <Typography variant="body2" color="text.disabled">
          Resolved {resolved.length}
        </Typography>
      </Box>

      {active.length === 0 && (
        <Surface>
          <Typography variant="subtitle1" sx={{ color: solar.status.ok }}>
            All clear
          </Typography>
          <Typography variant="caption" color="text.secondary">
            No open alerts. The engine watches offline inverters, silent registrations, and
            panels drifting below their siblings.
          </Typography>
        </Surface>
      )}

      {active.map((alert) => (
        <Surface key={alert.id} sx={{ opacity: alert.ackedAt ? 0.6 : 1 }}>
          <Box sx={{ display: 'flex', gap: 4 }}>
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '5px',
                bgcolor: SEVERITY_DOT[alert.severity] ?? solar.status.info,
                mt: '5px',
                flex: '0 0 8px',
              }}
            />
            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <Typography variant="subtitle1" sx={{ fontSize: 13 }}>
                  {alert.message}
                </Typography>
                <Typography variant="mono" sx={{ color: 'text.disabled', fontSize: 11 }}>
                  since {new Date(alert.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', gap: '10px', mt: 1 }}>
                {!alert.ackedAt && (
                  <Button size="small" variant="outlined" onClick={() => void ackAlert(alert.id).then(refreshAlerts)}>
                    Acknowledge
                  </Button>
                )}
                {alert.subjectKey.includes(':') && (
                  <Button size="small" variant="outlined" component={RouterLink} to="/system/roof">
                    Show on roof
                  </Button>
                )}
              </Box>
            </Box>
          </Box>
        </Surface>
      ))}

      <ArrayCensusCard />

      <Surface title="Fleet">
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', mb: 3 }}>
          <Box>
            <Typography variant="caption" color="text.disabled">Inverters online</Typography>
            <Metric value={summary ? `${summary.invertersOnline} / ${summary.invertersTotal}` : '—'} variant="metricMd" />
          </Box>
          <Box>
            <Typography variant="caption" color="text.disabled">Panels reporting</Typography>
            {/* Denominator was hardcoded 42; use what the gateway has actually registered. */}
            <Metric
              value={live && summary?.panelsTotal ? `${live.ports.length} / ${summary.panelsTotal}` : '—'}
              variant="metricMd"
            />
          </Box>
        </Box>
        <Link
          component="button"
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          sx={{ fontWeight: 500, fontSize: 12, lineHeight: 1, color: 'text.secondary', mb: 3, display: 'inline-block' }}
        >
          {showAdvanced ? 'Hide electrical details' : 'Electrical details'}
        </Link>
        <Collapse in={showAdvanced}>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', mb: 4 }}>
            <Box>
              <Typography variant="caption" color="text.disabled">Grid</Typography>
              <Metric
                value={
                  summary?.gridVoltage
                    ? `${summary.gridVoltage.toFixed(1)} V · ${summary.gridFrequency?.toFixed(2)} Hz`
                    : '—'
                }
                variant="metricMd"
              />
            </Box>
            <Box>
              <Typography variant="caption" color="text.disabled">RF weakest link</Typography>
              <Metric
                value={
                  live?.inverters.length
                    ? `${Math.min(...live.inverters.map((inv) => inv.rfSignal))} dB`
                    : '—'
                }
                variant="metricMd"
              />
            </Box>
          </Box>
        </Collapse>
        <Box sx={{ display: 'flex', gap: '2px' }}>
          {pollStrip(history).map((color, i) => (
            <Box key={i} sx={{ flex: 1, height: 22, borderRadius: '2px', bgcolor: color }} />
          ))}
        </Box>
        <Typography variant="caption" color="text.disabled" sx={{ mt: 2, display: 'block' }}>
          Poll health, last 24 h · one cell = 30 min
        </Typography>
      </Surface>

      {resolved.length > 0 && (
        <Surface title="Recently resolved">
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {resolved.slice(0, 8).map((alert) => (
              <Typography key={alert.id} variant="caption" color="text.secondary">
                {new Date(alert.closedAt!).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} — {alert.message}
              </Typography>
            ))}
          </Box>
        </Surface>
      )}
    </Box>
  );
}
