import { ReactElement, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import {
  PanelMeta,
  PortHistoryPoint,
  Snapshot,
  fetchPanelInsights,
  fetchPortHistory,
  savePanel,
  savePanelPosition,
  usePolling,
} from '../api';
import { Chart } from '../charts/Chart';
import { basePreset } from '../charts/preset';
import { Metric, Surface } from '../components/Surface';
import { RoofCanvas, RoofMetric, hexSerial, shortPanelName, useRoofCells } from '../components/RoofCanvas';
import { rampColor, solar } from '../theme';

const SCALE_LABELS: Record<RoofMetric, [string, string]> = {
  power: ['0 W', '500 W rated'],
  temp: ['coolest', 'hottest'],
  energy: ['least today', 'most today'],
};

interface RoofPageProps {
  live: Snapshot | null;
  panels: PanelMeta[] | null;
  refreshPanels: () => void;
}

export function RoofPage({ live, panels, refreshPanels }: RoofPageProps): ReactElement {
  const [params, setParams] = useSearchParams();
  const metric = (params.get('metric') as RoofMetric) ?? 'power';
  const [editMode, setEditMode] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(
    params.get('panel') ? Number(params.get('panel')) : null,
  );
  const [history, setHistory] = useState<PortHistoryPoint[] | null>(null);
  const [label, setLabel] = useState('');
  const [wattage, setWattage] = useState('');

  const cells = useRoofCells(panels, live, metric);
  const { data: insights } = usePolling(() => fetchPanelInsights(7), 5 * 60_000);
  const PRICE = 0.16;
  const selected = panels?.find((p) => p.id === selectedId) ?? null;
  const selectedCell = cells.find((c) => c.meta.id === selectedId) ?? null;

  // Load the selected panel's 24 h curve. Keyed on the id alone: `selected` is a brand-new
  // object on every /api/panels poll, so depending on it refetched every 60 s.
  useEffect(() => {
    setHistory(null);
    if (selectedId === null) return;
    let cancelled = false;
    fetchPortHistory(selectedId, 24)
      .then((points) => {
        if (!cancelled) setHistory(points);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Seed the edit form from the stored values. Depends on the primitives, not the object —
  // otherwise each poll re-seeded the fields and destroyed whatever was being typed.
  const storedLabel = selected?.label ?? '';
  const storedWattage = selected?.wattage ? String(selected.wattage) : '';
  useEffect(() => {
    setLabel(storedLabel);
    setWattage(storedWattage);
  }, [selectedId, storedLabel, storedWattage]);

  const place = async (x: number, y: number): Promise<void> => {
    if (selectedId === null) return;
    await savePanelPosition(selectedId, { gridX: x, gridY: y });
    refreshPanels();
  };

  const saveMeta = async (): Promise<void> => {
    if (!selected) return;
    await savePanel(selected.id, {
      label: label.trim() || null,
      wattage: wattage.trim() ? Number(wattage) : null,
    });
    refreshPanels();
  };

  const port = selected
    ? live?.ports.find(
        (p) => p.inverterSerialNumber === selected.inverterSerial && p.portNumber === selected.portNumber,
      )
    : null;
  const inverter = selected
    ? live?.inverters.find((inv) => inv.serialNumber === selected.inverterSerial)
    : null;

  const historyOption = {
    ...basePreset(),
    grid: { left: 40, right: 8, top: 8, bottom: 22, containLabel: false },
    series: [
      {
        type: 'line' as const,
        data: (history ?? []).map((p) => [p.t, p.powerW]),
        showSymbol: false,
        lineStyle: { color: solar.series.production, width: 1.8 },
      },
    ],
  };

  const maxInvW = Math.max(1, ...(live?.inverters.map((inv) => inv.activePower) ?? [1]));

  // Health hero: how many panels are keeping up with their siblings.
  // `insights === null` means not-yet-loaded OR the fetch failed (usePolling swallows
  // errors and holds the last good value) — that is NOT the same as "nothing wrong",
  // so we must not assert health until we've actually heard back.
  const insightsKnown = insights !== null;
  const totalPanels = cells.length || live?.ports.length || 0;
  const underperf = insights?.length ?? 0;
  const healthyPanels = Math.max(0, totalPanels - underperf);
  const roofW = (live?.ports ?? []).reduce((a, p) => a + p.power, 0);
  const typicalW = live?.ports.length ? Math.round(roofW / live.ports.length) : 0;
  const roofAnswer = !insightsKnown
    ? 'Checking how each panel is doing…'
    : underperf === 0
      ? `All ${totalPanels} panels are keeping up with each other.`
      : `${healthyPanels} of your ${totalPanels} panels are keeping up. ${underperf === 1 ? 'One is' : `${underperf} are`} making less than their neighbours${insights?.[0]?.pattern === 'shading' ? ' — likely shading, which usually clears on its own.' : ' — worth a look below.'}`;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {/* health hero */}
      <Surface hero sx={{ p: 7, borderRadius: `${solar.radius.hero}px`, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <Typography variant="answer" component="h2" sx={{ color: 'text.primary' }}>{roofAnswer}</Typography>
        <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: { xs: 6, md: 11 }, flexWrap: 'wrap' }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="overline" color="text.disabled">Panels keeping up</Typography>
            <Metric
              value={insightsKnown ? String(healthyPanels) : '—'}
              unit={totalPanels ? `of ${totalPanels}` : undefined}
              variant="metricHero"
              dim={!insightsKnown}
            />
          </Box>
          <Box sx={{ width: '1px', height: 56, bgcolor: solar.surface.border, alignSelf: 'flex-end', mb: '4px', display: { xs: 'none', md: 'block' } }} />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="overline" color="text.disabled">Roof output</Typography>
            <Metric value={(roofW / 1000).toFixed(1)} unit="kW" variant="metricMd" />
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="overline" color="text.disabled">Typical panel</Typography>
            <Metric value={String(typicalW)} unit="W" variant="metricMd" />
          </Box>
        </Box>
      </Surface>

      {/* toolbar */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={metric}
          onChange={(_, value) => value && setParams({ metric: value }, { replace: true })}
          sx={{ bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: '9px', p: '3px', gap: '2px' }}
        >
          <ToggleButton value="power">Power</ToggleButton>
          <ToggleButton value="temp">Temperature</ToggleButton>
          <ToggleButton value="energy">Daily energy</ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Typography variant="mono" sx={{ color: 'text.disabled' }}>
            {SCALE_LABELS[metric][0]}
          </Typography>
          <Box
            sx={{
              width: 132,
              height: 8,
              borderRadius: '4px',
              background: `linear-gradient(90deg,${solar.ramp[metric][0]},${solar.ramp[metric][1]},${solar.ramp[metric][2]})`,
            }}
          />
          <Typography variant="mono" sx={{ color: 'text.disabled' }}>
            {SCALE_LABELS[metric][1]}
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />
        <Button
          variant={editMode ? 'contained' : 'outlined'}
          size="small"
          onClick={() => setEditMode((v) => !v)}
        >
          {editMode ? 'Done editing' : 'Edit layout'}
        </Button>
      </Box>

      {editMode && (
        <Surface sx={{ bgcolor: solar.surface.raised, borderColor: solar.surface.borderStrong, py: 3 }}>
          <Typography variant="body2" color="text.secondary">
            <strong style={{ color: solar.ink.pri }}>Edit layout</strong> — select a panel (on the roof or
            from the tray below), then click an empty cell to move it there. Metric colors are muted while editing.
          </Typography>
        </Surface>
      )}

      {insights && insights.length > 0 && (
        <Surface
          title="Panel insights"
          action={
            <Typography variant="mono" sx={{ color: solar.status.warn }}>
              {insights.length} underperforming
            </Typography>
          }
        >
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {insights.map((insight) => (
              <Box
                key={insight.portId}
                sx={{ display: 'flex', alignItems: 'baseline', gap: 3, flexWrap: 'wrap' }}
              >
                {/* Shading vs hardware fault was hue-only; pair it with a word so the
                    distinction survives greyscale and colour-blindness. */}
                <Box
                  sx={{
                    alignSelf: 'center',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    minWidth: 78,
                    color: insight.pattern === 'shading' ? solar.status.warn : solar.status.critical,
                  }}
                >
                  <Box
                    sx={{
                      width: 7,
                      height: 7,
                      borderRadius: insight.pattern === 'shading' ? '4px' : '1px',
                      bgcolor: 'currentColor',
                      flex: '0 0 7px',
                    }}
                  />
                  <Typography sx={{ font: `600 10px/1 ${solar.font.sans}`, letterSpacing: '.08em', textTransform: 'uppercase' }}>
                    {insight.pattern === 'shading' ? 'Shade' : 'Check'}
                  </Typography>
                </Box>
                <Typography variant="subtitle1" sx={{ fontSize: 13, minWidth: 130 }}>
                  {insight.panel}
                </Typography>
                <Typography variant="mono" sx={{ color: solar.status.warn, width: 70, textAlign: 'right' }}>
                  −{insight.deficitPct}%
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 200 }}>
                  {insight.diagnosis}
                </Typography>
                <Typography variant="mono" sx={{ color: 'text.disabled' }}>
                  ~{(insight.lostWhPerDay / 1000).toFixed(2)} kWh/day · $
                  {(((insight.lostWhPerDay / 1000) * PRICE) * 30).toFixed(2)}/mo
                </Typography>
              </Box>
            ))}
          </Box>
          <Typography variant="caption" color="text.disabled" sx={{ mt: 2, display: 'block' }}>
            Compared to each panel's own inverter siblings over 7 days. Shading (time-specific dips)
            usually means a tree or vent; all-day dips mean soiling or a hardware fault.
          </Typography>
        </Surface>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 326px' }, gap: 5, alignItems: 'start' }}>
        <Surface title={`Array · ${cells.length} panels`}>
          <RoofCanvas
            cells={cells}
            metric={metric}
            selectedId={selectedId}
            onSelect={(meta) => setSelectedId(meta.id === selectedId ? null : meta.id)}
            editMode={editMode}
            onPlace={(x, y) => void place(x, y)}
          />
          {editMode && (
            <Box sx={{ mt: 4, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {(panels ?? [])
                .filter((p) => p.gridX === null)
                .map((meta) => (
                  <Chip
                    key={meta.id}
                    size="small"
                    label={shortPanelName(meta)}
                    variant={selectedId === meta.id ? 'filled' : 'outlined'}
                    onClick={() => setSelectedId(meta.id)}
                  />
                ))}
            </Box>
          )}
        </Surface>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {selected && (
            <Surface
              title={
                <Box>
                  <Typography variant="h5">{shortPanelName(selected)}</Typography>
                  <Typography variant="caption" color="text.disabled">
                    inverter {hexSerial(selected.inverterSerial)} · port {selected.portNumber}
                  </Typography>
                </Box>
              }
              action={
                selectedCell?.flagged ? (
                  <Chip size="small" label="LOW" sx={{ bgcolor: '#e0a05a1f', color: solar.status.warn, font: '600 10px/1.4 ui-monospace,Menlo,monospace' }} />
                ) : undefined
              }
              sx={{ borderColor: '#35302a' }}
            >
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', mb: 4 }}>
                <Box>
                  <Typography variant="caption" color="text.disabled">Power</Typography>
                  <Metric value={(port?.power ?? 0).toFixed(0)} unit="W" variant="metricMd" />
                </Box>
                <Box>
                  <Typography variant="caption" color="text.disabled">Today</Typography>
                  <Metric value={((port?.energyDailyWh ?? 0) / 1000).toFixed(2)} unit="kWh" variant="metricMd" />
                </Box>
                <Box>
                  <Typography variant="caption" color="text.disabled">Voltage</Typography>
                  <Metric value={(port?.voltage ?? 0).toFixed(1)} unit="V" variant="metricMd" />
                </Box>
                <Box>
                  <Typography variant="caption" color="text.disabled">Inverter temp</Typography>
                  <Metric value={(inverter?.temperature ?? 0).toFixed(0)} unit="°C" variant="metricMd" />
                </Box>
              </Box>
              {history && history.length > 1 && <Chart option={historyOption} height={90} />}
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 4 }}>
                <TextField label="Label" size="small" value={label} onChange={(e) => setLabel(e.target.value)} />
                <TextField label="Rated W" size="small" type="number" value={wattage} onChange={(e) => setWattage(e.target.value)} />
                <Box sx={{ display: 'flex', gap: 2 }}>
                  <Button size="small" variant="outlined" onClick={() => void saveMeta()} sx={{ flex: 1 }}>
                    Save
                  </Button>
                  <Button size="small" variant="outlined" sx={{ flex: 1 }} component={Link} href={`/api/export/readings.csv`} download>
                    CSV
                  </Button>
                </Box>
              </Box>
            </Surface>
          )}

          <Surface title={`Microinverters · ${live?.inverters.length ?? 0}`}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {(live?.inverters ?? []).map((inv) => (
                <Box key={inv.serialNumber} sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Typography variant="mono" sx={{ width: 44, color: 'text.secondary' }}>
                    {hexSerial(inv.serialNumber, 4)}
                  </Typography>
                  <Box sx={{ flex: 1, height: 4, borderRadius: '2px', bgcolor: '#2e2a25', overflow: 'hidden' }}>
                    <Box
                      sx={{
                        width: `${(inv.activePower / maxInvW) * 100}%`,
                        height: 4,
                        bgcolor: rampColor(solar.ramp.power, Math.pow(inv.activePower / maxInvW, 0.75)),
                      }}
                    />
                  </Box>
                  <Typography variant="mono" sx={{ width: 52, textAlign: 'right' }}>
                    {inv.activePower.toFixed(0)}
                  </Typography>
                  <Typography variant="mono" sx={{ width: 36, textAlign: 'right', color: 'text.disabled' }}>
                    {inv.temperature.toFixed(0)}°
                  </Typography>
                </Box>
              ))}
            </Box>
          </Surface>
        </Box>
      </Box>
    </Box>
  );
}
