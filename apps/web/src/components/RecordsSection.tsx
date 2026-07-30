import { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Milestones } from '../api';
import { Metric, Surface } from './Surface';
import { solar } from '../theme';

const WH_PER_KWH = 1000;
const WH_PER_MWH = 1_000_000;

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtMonth(month: string | undefined): string {
  if (!month) return '—';
  return new Date(`${month}-15T12:00:00`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

interface RecordCardProps {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  highlight?: boolean;
}

function RecordCard({ label, value, unit, detail, highlight }: RecordCardProps): ReactElement {
  return (
    <Surface sx={{ borderColor: highlight ? solar.series.production : 'divider' }}>
      <Typography variant="overline" color="text.disabled" sx={{ display: 'block', mb: 1 }}>
        {label}
      </Typography>
      <Metric value={value} unit={unit} variant="metricMd" />
      {detail && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          {detail}
        </Typography>
      )}
    </Surface>
  );
}

interface RecordsSectionProps {
  records: Milestones | null;
}

export function RecordsSection({ records }: RecordsSectionProps): ReactElement {
  if (!records) {
    return (
      <Surface>
        <Typography variant="body2" color="text.secondary">
          Records appear as history accumulates.
        </Typography>
      </Surface>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {records.todayIsRecord && (
        <Surface sx={{ borderColor: solar.series.production }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <Typography sx={{ fontSize: 28 }}>🏆</Typography>
            <Box>
              <Typography variant="subtitle1">Today is a new record</Typography>
              <Typography variant="caption" color="text.secondary">
                {(records.bestDay!.wh / WH_PER_KWH).toFixed(1)} kWh — the best single day since
                the array came online.
              </Typography>
            </Box>
          </Box>
        </Surface>
      )}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(3, 1fr)', lg: 'repeat(4, 1fr)' },
          gap: '14px',
        }}
      >
        <RecordCard
          label="Best day"
          value={records.bestDay ? (records.bestDay.wh / WH_PER_KWH).toFixed(1) : '—'}
          unit="kWh"
          detail={fmtDate(records.bestDay?.date ?? null)}
          highlight={records.todayIsRecord}
        />
        <RecordCard
          label="Best week"
          value={records.bestWeek ? (records.bestWeek.wh / WH_PER_KWH).toFixed(0) : '—'}
          unit="kWh"
          detail={records.bestWeek ? `7 days to ${fmtDate(records.bestWeek.endDate)}` : undefined}
        />
        <RecordCard
          label="Best month"
          value={records.bestMonth ? (records.bestMonth.wh / WH_PER_KWH).toFixed(0) : '—'}
          unit="kWh"
          detail={fmtMonth(records.bestMonth?.month)}
        />
        <RecordCard
          label="Peak power"
          value={(records.peakPowerW / WH_PER_KWH).toFixed(2)}
          unit="kW"
          detail={
            records.peakPowerAt
              ? new Date(records.peakPowerAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : undefined
          }
        />
        <RecordCard
          label="Producing streak"
          value={String(records.producingStreak)}
          unit="days"
        />
        <RecordCard
          label="Average day"
          value={(records.avgDayWh / WH_PER_KWH).toFixed(1)}
          unit="kWh"
          detail={`over ${records.daysCollecting} days`}
        />
        <RecordCard
          label="Collecting since"
          value={fmtDate(records.firstDate)}
          detail={`${records.daysCollecting} days of data`}
        />
        <RecordCard
          label="CO₂ avoided"
          value={records.lifetimeCo2Kg.toFixed(0)}
          unit="kg"
          detail="lifetime, at grid intensity"
        />
      </Box>

      {records.nextMwh && (
        <Surface title={`Toward ${records.nextMwh.targetMwh} MWh lifetime`}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 3, mb: 2 }}>
            <Metric value={(records.lifetimeWh / WH_PER_MWH).toFixed(3)} unit="MWh" variant="metricMd" />
            <Typography variant="mono" sx={{ color: 'text.secondary' }}>
              {records.nextMwh.pct.toFixed(1)}% of {records.nextMwh.targetMwh} MWh
            </Typography>
          </Box>
          <Box sx={{ height: 6, borderRadius: '3px', bgcolor: '#2e2a25', overflow: 'hidden' }}>
            <Box
              sx={{
                width: `${Math.min(100, records.nextMwh.pct)}%`,
                minWidth: 2,
                height: 6,
                bgcolor: solar.series.production,
              }}
            />
          </Box>
        </Surface>
      )}
    </Box>
  );
}
