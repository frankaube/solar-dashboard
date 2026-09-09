import { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { PanelMeta } from '../api';
import { RAMP_FOR, RoofCell, RoofMetric, hexSerial, shortPanelName } from './RoofCanvas';
import { rampColor, solar } from '../theme';

/*
  The same panels, grouped by what they are plugged into.

  A microinverter's four ports can sit in two rows on two roof faces, so on the map a failing
  unit reads as four unrelated dim squares. This view puts them on one line.

  It also does not depend on positions at all, so it works before any panel has been placed,
  and it is the only view that can show a panel the map cannot place.
*/

const LIGHT_INK_THRESHOLD = 0.78;

interface InverterViewProps {
  cells: RoofCell[];
  metric: RoofMetric;
  selectedId?: number | null;
  onSelect?: (meta: PanelMeta) => void;
  flagLowPanels?: boolean;
}

interface Unit {
  serial: string;
  cells: RoofCell[];
  totalW: number;
}

/**
 * Group by inverter, ports in order within each. Ordered by output rather than serial, so
 * the unit making nothing is at the top. Ties keep serial order, or the list reshuffles
 * itself every poll at night.
 */
export function groupByInverter(cells: RoofCell[]): Unit[] {
  const units = new Map<string, RoofCell[]>();
  for (const cell of cells) {
    const list = units.get(cell.meta.inverterSerial) ?? [];
    list.push(cell);
    units.set(cell.meta.inverterSerial, list);
  }
  return [...units.entries()]
    .map(([serial, group]) => ({
      serial,
      cells: [...group].sort((a, b) => a.meta.portNumber - b.meta.portNumber),
      totalW: group.reduce((sum, cell) => sum + cell.powerW, 0),
    }))
    .sort((a, b) => a.totalW - b.totalW || a.serial.localeCompare(b.serial));
}

export function InverterView({
  cells,
  metric,
  selectedId = null,
  onSelect,
  flagLowPanels = true,
}: InverterViewProps): ReactElement {
  const ramp = solar.ramp[RAMP_FOR[metric]];
  const units = groupByInverter(cells);
  // The widest unit sets the column count, so a 4-port and a 1-port line up rather than
  // stretching to the same width.
  const widest = Math.max(1, ...units.map((unit) => unit.cells.length));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {units.map((unit) => (
        <Box
          key={unit.serial}
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: `72px repeat(${widest}, minmax(44px, 1fr))`,
              sm: `104px repeat(${widest}, minmax(44px, 1fr)) 72px`,
            },
            gap: '6px',
            alignItems: 'center',
          }}
        >
          <Typography
            variant="mono"
            noWrap
            sx={{ color: unit.totalW > 0 ? 'text.secondary' : solar.status.warn }}
          >
            {hexSerial(unit.serial, 4)}
          </Typography>
          {unit.cells.map((cell) => {
            const selected = selectedId === cell.meta.id;
            const light = cell.t > LIGHT_INK_THRESHOLD;
            return (
              <Tooltip
                key={cell.meta.id}
                title={`${shortPanelName(cell.meta)} — ${cell.powerW.toFixed(0)} W${cell.flagged ? ' · below its siblings' : ''}`}
              >
                <Box
                  onClick={() => onSelect?.(cell.meta)}
                  role={onSelect ? 'button' : undefined}
                  tabIndex={onSelect ? 0 : undefined}
                  aria-label={
                    onSelect
                      ? `${shortPanelName(cell.meta)}, ${cell.powerW.toFixed(0)} watts${cell.flagged ? ', below its siblings' : ''}`
                      : undefined
                  }
                  aria-pressed={onSelect ? selected : undefined}
                  onKeyDown={(event) => {
                    if (!onSelect) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(cell.meta);
                    }
                  }}
                  sx={{
                    position: 'relative',
                    height: 44,
                    borderRadius: '5px',
                    border: selected ? `2px solid ${solar.ink.pri}` : '1px solid',
                    borderColor: selected
                      ? solar.ink.pri
                      : flagLowPanels && cell.flagged
                        ? solar.status.warn
                        : solar.surface.raised,
                    bgcolor: rampColor(ramp, cell.t),
                    cursor: onSelect ? 'pointer' : 'default',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background-color .3s',
                    '&:focus-visible': {
                      outline: `2px solid ${solar.accent.gold}`,
                      outlineOffset: '1px',
                    },
                  }}
                >
                  {flagLowPanels && cell.flagged && (
                    <Box
                      aria-hidden
                      sx={{
                        position: 'absolute',
                        top: 2,
                        right: 3,
                        font: `700 9px/1 ${solar.font.sans}`,
                        color: solar.status.warn,
                      }}
                    >
                      !
                    </Box>
                  )}
                  <Typography
                    sx={{
                      fontSize: 14,
                      fontWeight: 600,
                      fontVariantNumeric: 'tabular-nums',
                      color: solar.on.gold,
                      textShadow: light
                        ? '0 1px 2px rgba(255,255,255,.45)'
                        : '0 1px 2px rgba(0,0,0,.6)',
                    }}
                  >
                    {cell.value}
                  </Typography>
                </Box>
              </Tooltip>
            );
          })}
          {/* A short unit leaves its trailing columns empty rather than stretching. */}
          {Array.from({ length: widest - unit.cells.length }, (_, i) => (
            <Box key={`pad-${i}`} aria-hidden />
          ))}
          <Typography
            variant="mono"
            noWrap
            sx={{ color: 'text.disabled', textAlign: 'right', display: { xs: 'none', sm: 'block' } }}
          >
            {unit.totalW.toFixed(0)} W
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
