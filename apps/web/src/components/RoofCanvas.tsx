import { ReactElement, useMemo } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { PanelMeta, Snapshot } from '../api';
import { rampColor, solar } from '../theme';

export type RoofMetric = 'power' | 'temp' | 'energy';

const DEFAULT_RATING_W = 500;
const POWER_GAMMA = 0.75;
/** Sibling-median deviation that flags a panel on the roof. */
const FLAG_RATIO = 0.85;
const MIN_FLAG_MEDIAN_W = 50;
/**
 * Where the ramp gets bright enough to switch from light ink to dark. This sat at 0.62,
 * which flipped to dark ink while the fill was still mid-brown — measured 3.37:1, below
 * AA, where light ink was still clearing 5:1. Switch later, once the fill is genuinely
 * light.
 */
const LIGHT_INK_THRESHOLD = 0.78;

export interface RoofCell {
  meta: PanelMeta;
  x: number;
  y: number;
  value: string;
  t: number;
  powerW: number;
  flagged: boolean;
}

/**
 * Serials are decimal strings today, but BigInt() throws a SyntaxError on anything else —
 * and with no error boundary above us that would white-screen the whole app if a vendor
 * (or a future DTU firmware) ever reported an alphanumeric serial. Fall back to the raw
 * string instead of taking the page down.
 */
export function hexSerial(serial: string, tailChars?: number): string {
  let out: string;
  try {
    out = BigInt(serial).toString(16).toUpperCase();
  } catch {
    out = String(serial).toUpperCase();
  }
  return tailChars ? out.slice(-tailChars) : out;
}

export function shortPanelName(meta: PanelMeta): string {
  return meta.label ?? `${hexSerial(meta.inverterSerial, 4)}·${meta.portNumber}`;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Compute roof cells. Panels without saved positions fall back to one row per
 * microinverter so the roof reads sensibly before the layout is edited.
 */
export function useRoofCells(
  panels: PanelMeta[] | null,
  snapshot: Snapshot | null,
  metric: RoofMetric,
): RoofCell[] {
  return useMemo(() => {
    if (!panels || !snapshot) return [];
    const bySerial = new Map<string, number>();
    snapshot.inverters.forEach((inv, index) => bySerial.set(inv.serialNumber, index));
    const tempBySerial = new Map(snapshot.inverters.map((inv) => [inv.serialNumber, inv.temperature]));
    const portData = new Map(
      snapshot.ports.map((port) => [`${port.inverterSerialNumber}:${port.portNumber}`, port]),
    );

    const siblings = new Map<string, number[]>();
    for (const port of snapshot.ports) {
      const list = siblings.get(port.inverterSerialNumber) ?? [];
      list.push(port.power);
      siblings.set(port.inverterSerialNumber, list);
    }

    const energies = panels.map(
      (meta) => portData.get(`${meta.inverterSerial}:${meta.portNumber}`)?.energyDailyWh ?? 0,
    );
    const temps = snapshot.inverters.map((inv) => inv.temperature);
    const eMin = Math.min(...energies, Infinity);
    const eMax = Math.max(...energies, -Infinity);
    const tMin = Math.min(...temps, Infinity);
    const tMax = Math.max(...temps, -Infinity);

    return panels.map((meta, index) => {
      const port = portData.get(`${meta.inverterSerial}:${meta.portNumber}`);
      const powerW = port?.power ?? 0;
      // `??` would let a stored 0 (or a negative) through and yield NaN → "#NaNNaNNaN".
      const rating = meta.wattage && meta.wattage > 0 ? meta.wattage : DEFAULT_RATING_W;
      const temp = tempBySerial.get(meta.inverterSerial) ?? 0;
      const energy = port?.energyDailyWh ?? 0;

      let value: string;
      let t: number;
      if (metric === 'power') {
        value = String(Math.round(powerW));
        t = Math.pow(Math.min(1, powerW / rating), POWER_GAMMA);
      } else if (metric === 'temp') {
        value = `${Math.round(temp)}°`;
        t = tMax > tMin ? (temp - tMin) / (tMax - tMin) : 0.5;
      } else {
        value = (energy / 1000).toFixed(1);
        t = eMax > eMin ? (energy - eMin) / (eMax - eMin) : 0.5;
      }

      const sibs = siblings.get(meta.inverterSerial) ?? [];
      const ref = median(sibs);
      const flagged = sibs.length > 1 && ref >= MIN_FLAG_MEDIAN_W && powerW / ref < FLAG_RATIO;

      const autoRow = bySerial.get(meta.inverterSerial) ?? 0;
      return {
        meta,
        x: meta.gridX ?? meta.portNumber - 1,
        y: meta.gridY ?? autoRow + (meta.gridX === null ? index * 0 : 0),
        value,
        t,
        powerW,
        flagged,
      };
    });
  }, [panels, snapshot, metric]);
}

interface RoofCanvasProps {
  cells: RoofCell[];
  metric: RoofMetric;
  selectedId?: number | null;
  onSelect?: (meta: PanelMeta) => void;
  editMode?: boolean;
  onPlace?: (x: number, y: number) => void;
  compact?: boolean;
  flagLowPanels?: boolean;
}

export function RoofCanvas({
  cells,
  metric,
  selectedId = null,
  onSelect,
  editMode = false,
  onPlace,
  compact = false,
  flagLowPanels = true,
}: RoofCanvasProps): ReactElement {
  const ramp = solar.ramp[metric];
  const cols = Math.max(8, ...cells.map((cell) => cell.x + 1));
  const rows = Math.max(3, ...cells.map((cell) => cell.y + 1));
  const occupied = new Set(cells.map((cell) => `${cell.x}:${cell.y}`));
  const cellH = compact ? 22 : 52;

  const grid: ReactElement[] = [];
  for (const cell of cells) {
    const fill = editMode ? solar.surface.card : rampColor(ramp, cell.t);
    const light = !editMode && cell.t > LIGHT_INK_THRESHOLD;
    const selected = selectedId === cell.meta.id;
    grid.push(
      <Tooltip
        key={cell.meta.id}
        title={`${shortPanelName(cell.meta)} — ${cell.powerW.toFixed(0)} W${cell.flagged ? ' · below its siblings' : ''}`}
        disableHoverListener={compact}
      >
        <Box
          onClick={() => onSelect?.(cell.meta)}
          // Keyboard reachable: these were click-only <div>s, so the whole array — and the
          // tooltip that names each panel — was unusable without a mouse.
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
            gridColumn: cell.x + 1,
            gridRow: cell.y + 1,
            borderRadius: compact ? '2px' : '5px',
            border: selected ? `2px solid ${solar.ink.pri}` : '1px solid',
            borderColor: selected
              ? solar.ink.pri
              : flagLowPanels && cell.flagged
                ? solar.status.warn
                : solar.surface.raised,
            borderStyle: editMode ? 'dashed' : 'solid',
            bgcolor: fill,
            cursor: onSelect ? 'pointer' : 'default',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            transition: 'background-color .3s',
            '&:hover': onSelect ? { transform: 'translateY(-1px)' } : undefined,
            '&:focus-visible': {
              outline: `2px solid ${solar.accent.gold}`,
              outlineOffset: '1px',
            },
          }}
        >
          {/* Underperformance was signalled by border hue alone — add a shape channel. */}
          {!compact && flagLowPanels && cell.flagged && !editMode && (
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
          {!compact && (
            // Only the value at rest: the 9px name never cleared 4.5:1 anywhere on the
            // ramp, and it duplicates the tooltip / selected-panel header. The shadow keeps
            // the figure legible across the whole gradient rather than at one end of it.
            <Typography
              sx={{
                fontSize: 14,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                color: editMode ? solar.ink.sec : light ? solar.on.gold : solar.on.gold,
                textShadow: editMode
                  ? 'none'
                  : light
                    ? '0 1px 2px rgba(255,255,255,.45)'
                    : '0 1px 2px rgba(0,0,0,.6)',
              }}
            >
              {cell.value}
            </Typography>
          )}
        </Box>
      </Tooltip>,
    );
  }

  if (editMode && onPlace) {
    for (let y = 0; y < rows + 2; y++) {
      for (let x = 0; x < Math.max(cols + 2, 14); x++) {
        if (occupied.has(`${x}:${y}`)) continue;
        grid.push(
          <Box
            key={`empty-${x}-${y}`}
            onClick={() => onPlace(x, y)}
            sx={{
              gridColumn: x + 1,
              gridRow: y + 1,
              borderRadius: '4px',
              border: '1px dashed rgba(176,167,155,0.20)',
              cursor: 'copy',
            }}
          />,
        );
      }
    }
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: `repeat(${editMode ? Math.max(cols + 2, 14) : cols}, minmax(${compact ? 18 : 44}px, 1fr))`,
        gridAutoRows: `${cellH}px`,
        gap: compact ? '3px' : '6px',
        overflowX: 'auto',
      }}
    >
      {grid}
    </Box>
  );
}
