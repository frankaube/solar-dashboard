import { ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { Grouping, ProductionBuckets, fetchProductionBuckets, usePolling } from '../api';
import { Chart } from '../charts/Chart';
import { basePreset } from '../charts/preset';
import { Surface } from './Surface';
import { solar } from '../theme';

const POLL_MS = 5 * 60_000;

const GROUPINGS: Array<{ id: Grouping; label: string }> = [
  { id: 'day', label: 'Days' },
  { id: 'month', label: 'Months' },
  { id: 'year', label: 'Years' },
];

/**
 * Production side by side, by day, month or year.
 *
 * The hard part is not the totals — it is that most periods are not whole ones. This array
 * started reporting on 23 July, so July holds nine days and August holds however many have
 * elapsed. Drawn as plain bars that reads as "production collapsed in August", which is
 * the first thing anyone takes from the shapes and is false.
 *
 * So a part-period is drawn hollow, labelled in the tooltip with how many days it actually
 * covers, and counted in a line above the chart. The bars are still shown: hiding them
 * would drop the month you are living in, which is the one you most want to see.
 */
export function ProductionCompare(): ReactElement {
  const [grouping, setGrouping] = useState<Grouping>('day');
  // `grouping` as the key, so clicking Months fetches now rather than in five minutes.
  const { data } = usePolling<ProductionBuckets>(
    () => fetchProductionBuckets(grouping),
    POLL_MS,
    grouping,
  );

  // Only trust the payload once it describes the grouping being shown; otherwise a bar
  // labelled "Jul 23" would sit under a heading that says Months for one render.
  const buckets = data?.grouping === grouping ? data.buckets : [];
  const kwh = (wh: number): number => Number((wh / 1000).toFixed(1));

  const option = {
    ...basePreset(),
    grid: { left: 52, right: 16, top: 16, bottom: 26, containLabel: false },
    xAxis: {
      ...(basePreset().xAxis as object),
      type: 'category' as const,
      data: buckets.map((b) => b.label),
    },
    yAxis: {
      ...(basePreset().yAxis as object),
      axisLabel: {
        color: solar.ink.dim,
        fontFamily: 'ui-monospace,Menlo,monospace',
        fontSize: 10,
        formatter: (v: number) => `${v}`,
      },
    },
    tooltip: {
      ...(basePreset().tooltip as object),
      trigger: 'axis' as const,
      formatter: (params: unknown) => {
        const first = (params as Array<{ dataIndex: number }>)[0];
        const bucket = buckets[first?.dataIndex ?? 0];
        if (!bucket) return '';
        const total = `${bucket.label}: ${kwh(bucket.energyWh)} kWh`;
        /*
          The caveat belongs in the tooltip, not only in a legend. Someone reading a single
          bar to answer "how did August do" never looks at the legend, and the count of
          days is the fact that stops the number being misread.
        */
        if (bucket.complete) return total;
        return grouping === 'day'
          ? `${total}<br/>still in progress`
          : `${total}<br/>${bucket.daysWithData} of ${bucket.daysInPeriod} days`;
      },
    },
    series: [
      {
        type: 'bar' as const,
        barMaxWidth: 46,
        /*
          Styled per datum rather than with a callback: only itemStyle.color accepts a
          function, and the distinction needs the border too.

          Hollow for a part-period, solid for a whole one — not a paler shade of the same
          fill, which reads as "slightly less important" rather than "not the same kind of
          thing", and still invites comparison by height at a glance.
        */
        data: buckets.map((b) => ({
          value: kwh(b.energyWh),
          itemStyle: b.complete
            ? { color: solar.series.production, borderRadius: [3, 3, 0, 0] }
            : {
                color: 'transparent',
                borderColor: solar.series.production,
                borderWidth: 1.5,
                borderType: 'dashed' as const,
                borderRadius: [3, 3, 0, 0],
              },
        })),
      },
    ],
  };

  const anyPartial = buckets.some((b) => !b.complete);

  return (
    <Surface
      title={
        <Box>
          <Typography variant="subtitle1">Production · kWh</Typography>
          <Typography variant="caption" color="text.disabled">
            {data?.summary ?? 'loading…'}
          </Typography>
        </Box>
      }
      action={
        <ToggleButtonGroup
          size="small"
          exclusive
          value={grouping}
          onChange={(_, next: Grouping | null) => next && setGrouping(next)}
        >
          {GROUPINGS.map((g) => (
            <ToggleButton key={g.id} value={g.id} sx={{ px: 3, py: '3px', fontSize: 11 }}>
              {g.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      }
    >
      {buckets.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 6 }}>
          Nothing recorded yet — this fills in as the days accumulate.
        </Typography>
      ) : (
        <>
          <Chart option={option} height={200} />
          {anyPartial && (
            /* A key, because the hollow bars are otherwise an unexplained second encoding. */
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, mt: 2, flexWrap: 'wrap' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Box sx={{ width: 11, height: 11, borderRadius: '2px', bgcolor: solar.series.production }} />
                <Typography variant="caption" color="text.disabled">whole period</Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Box sx={{ width: 11, height: 11, borderRadius: '2px', border: `1.5px dashed ${solar.series.production}` }} />
                <Typography variant="caption" color="text.disabled">
                  part-period — not comparable by height
                </Typography>
              </Box>
            </Box>
          )}
        </>
      )}
    </Surface>
  );
}
