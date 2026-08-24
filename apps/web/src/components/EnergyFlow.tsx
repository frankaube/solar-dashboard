import { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Battery, ChargerLive, Summary } from '../api';
import { Chart } from '../charts/Chart';
import { Surface } from './Surface';
import { usePrefersReducedMotion } from '../shell/motion';
import { solar } from '../theme';

interface EnergyFlowProps {
  summary: Summary | null;
  charger: { live: ChargerLive | null } | null;
  battery: Battery | null;
}

/**
 * The same energy identities the "Where it's going" list uses. These previously diverged —
 * the car was blue in that list and orange here, the battery green there and gold here —
 * which broke the palette's own rule that a colour names one thing.
 */
/*
  A function, not a constant. As a module-level object this was evaluated once at import
  and held whichever palette was active then — the sankey kept its original colours through
  every theme change, because nothing ever read the tokens again.
*/
const nodeColors = (): Record<string, string> => ({
  Solar: solar.series.production,
  House: solar.series.house,
  'House + grid': solar.series.house,
  Battery: solar.series.battery,
  EV: solar.series.car,
  Grid: solar.series.grid,
});

/**
 * Sankey of instantaneous power flow. Honest by construction: it draws only
 * measured flows. Without a whole-home CT meter the split between house use
 * and grid export is unknown, so those merge into one "House + grid" sink and
 * a note says so. Demo mode supplies a battery and a real house figure.
 */
/**
 * How fast the sheen crosses the bar, in seconds.
 *
 * Speed carries the kilowatts, which is the only reason this animation earns its place: a
 * fast bar is a busy roof, and you can read that across a room without looking at the
 * number. Clamped at both ends — below the floor it reads as broken rather than slow, and
 * above the ceiling it stops looking like flow and starts looking like flicker.
 *
 * Roughly 10 kW hits the fast end, which suits a domestic array without needing to know
 * this one's size.
 */
function sheenSeconds(watts: number): number {
  const share = Math.min(1, Math.max(0, watts / 10_000));
  return 4.2 - share * 3;
}

export function EnergyFlow({ summary, charger, battery }: EnergyFlowProps): ReactElement {
  const reducedMotion = usePrefersReducedMotion();
  const solarW = summary?.currentPowerW ?? 0;
  const evW = charger?.live?.charging ? charger.live.powerW : 0;
  const batteryW = battery?.present ? (battery.powerW ?? 0) : 0; // + charging
  const hasMeter = false; // set true when a CT meter adapter lands

  const links: Array<{ source: string; target: string; value: number }> = [];
  if (evW > 0) links.push({ source: 'Solar', target: 'EV', value: Math.round(evW) });
  if (batteryW > 0) links.push({ source: 'Solar', target: 'Battery', value: Math.round(batteryW) });
  const restLabel = hasMeter ? 'House' : 'House + grid';
  const rest = Math.max(0, solarW - evW - Math.max(0, batteryW));
  if (rest > 0) links.push({ source: 'Solar', target: restLabel, value: Math.round(rest) });
  if (batteryW < 0) links.push({ source: 'Battery', target: restLabel, value: Math.round(-batteryW) });

  if (solarW < 20 && evW === 0) {
    return (
      <Surface title="Energy flow">
        <Typography variant="body2" color="text.secondary">
          The array is idle — the flow view lights up while the sun is producing.
        </Typography>
      </Surface>
    );
  }

  const nodes = [...new Set(links.flatMap((l) => [l.source, l.target]))].map((name) => ({
    name,
    itemStyle: { color: nodeColors()[name] ?? solar.series.grid, borderColor: 'transparent' },
  }));

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: solar.surface.raised,
      borderColor: solar.surface.borderStrong,
      textStyle: { color: solar.ink.pri, fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12 },
      formatter: (p: unknown) =>
        `${(Number((p as { value?: unknown }).value ?? 0) / 1000).toFixed(2)} kW`,
    },
    series: [
      {
        type: 'sankey' as const,
        left: 8,
        right: 90,
        top: 10,
        bottom: 10,
        nodeWidth: 14,
        nodeGap: 14,
        draggable: false,
        label: { color: solar.ink.sec, fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 11 },
        lineStyle: { color: 'gradient', opacity: 0.35, curveness: 0.5 },
        data: nodes,
        links,
      },
    ],
  };

  return (
    <Surface
      title="Energy flow — now"
      action={
        <Typography variant="mono" sx={{ color: 'text.secondary' }}>
          {(solarW / 1000).toFixed(2)} kW produced
        </Typography>
      }
    >
      {/* A sankey needs something to branch. With a single flow it degenerates into
          one full-width slab — 220px of card saying exactly what the caption below it
          already says. Draw a compact source → target bar until there's a real split
          (EV charging, a battery, or a whole-home meter separating house from grid). */}
      {links.length <= 1 ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, py: 2 }}>
          <Typography sx={{ font: `600 12px/1 ${solar.font.sans}`, color: solar.series.production, flex: '0 0 auto' }}>
            {links[0]?.source ?? 'Solar'}
          </Typography>
          {/*
            The flow, moving in the direction it flows.

            A sheen travelling source-to-target rather than a pulse or a shimmer, because
            the thing being drawn has a direction and an animation that ignores it is
            decoration. Speed is proportional to the load, so the bar reads at a glance.

            Stops entirely when the browser asks for reduced motion — the gradient alone
            still says source, target and magnitude, so nothing is lost but the movement.
          */}
          <Box
            sx={{
              flex: 1,
              height: 12,
              borderRadius: '6px',
              position: 'relative',
              overflow: 'hidden',
              background: `linear-gradient(90deg, ${solar.series.production}, ${
                nodeColors()[links[0]?.target ?? 'House'] ?? solar.series.house
              })`,
              opacity: 0.85,
              '&::after': reducedMotion
                ? {}
                : {
                    content: '""',
                    position: 'absolute',
                    inset: 0,
                    background:
                      'linear-gradient(90deg, transparent 0%, rgba(255,255,255,.45) 50%, transparent 100%)',
                    transform: 'translateX(-100%)',
                    width: '55%',
                    animation: `flowSheen ${sheenSeconds(links[0]?.value ?? 0).toFixed(2)}s linear infinite`,
                  },
              '@keyframes flowSheen': {
                from: { transform: 'translateX(-100%)' },
                to: { transform: 'translateX(280%)' },
              },
            }}
          />
          <Typography variant="mono" sx={{ color: solar.ink.pri, flex: '0 0 auto' }}>
            {((links[0]?.value ?? 0) / 1000).toFixed(1)} kW
          </Typography>
          <Typography sx={{ font: `600 12px/1 ${solar.font.sans}`, color: nodeColors()[links[0]?.target ?? 'House'] ?? solar.series.house, flex: '0 0 auto' }}>
            {links[0]?.target ?? 'House'}
          </Typography>
        </Box>
      ) : (
        <Chart option={option} height={220} />
      )}
      {!hasMeter && (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
          House use and grid export merge until a whole-home meter is connected — measured flows
          (production, EV, battery) are exact.
        </Typography>
      )}
      {/* The legend only earns its space once the sankey is drawn — in compact mode the
          bar above already states source, target and kW. */}
      {links.length > 1 && (
        <Box sx={{ display: 'flex', gap: 4, mt: 2, flexWrap: 'wrap' }}>
          {links.map((l) => (
            <Box key={`${l.source}-${l.target}`} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: nodeColors()[l.target] ?? solar.series.grid }} />
              <Typography variant="caption" color="text.secondary">
                {l.source} → {l.target}: {(l.value / 1000).toFixed(1)} kW
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Surface>
  );
}
