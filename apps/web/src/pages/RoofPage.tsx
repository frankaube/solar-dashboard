import { ReactElement, useEffect, useMemo, useState } from 'react';
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
  Summary,
  fetchClipping,
  fetchPanelRecords,
  fetchPanelInsights,
  fetchPortHistory,
  savePanel,
  savePanelPosition,
  usePolling,
} from '../api';
import { Chart } from '../charts/Chart';
import { basePreset } from '../charts/preset';
import { Metric, Surface } from '../components/Surface';
import { RAMP_FOR, RoofCanvas, RoofMetric, hexSerial, shortPanelName, useRoofCells } from '../components/RoofCanvas';
import { InverterView } from '../components/InverterView';
import { rampColor, solar } from '../theme';

const SCALE_LABELS: Record<RoofMetric, [string, string]> = {
  power: ['0 W', '500 W rated'],
  temp: ['coolest', 'hottest'],
  energy: ['least today', 'most today'],
  // Stretched across the roof's own range, so the labels name panels rather than watts.
  peak: ['roof’s weakest', 'roof record'],
};

/** "4 Aug, 1:41 pm" — which day the record was, and how close to noon. */
function recordMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface RoofPageProps {
  live: Snapshot | null;
  panels: PanelMeta[] | null;
  /** For the roof's size. The gateway knows it; the per-panel data does not. */
  summary: Summary | null;
  refreshPanels: () => void;
}

export function RoofPage({ live, panels, summary, refreshPanels }: RoofPageProps): ReactElement {
  const [params, setParams] = useSearchParams();
  const metric = (params.get('metric') as RoofMetric) ?? 'power';
  // Two views of one set of panels, in the URL alongside `metric` so a view can be shared.
  // Editing is a roof-map operation, so it forces the map back regardless of this.
  const byInverter = params.get('view') === 'inverter';
  const [editMode, setEditMode] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(
    params.get('panel') ? Number(params.get('panel')) : null,
  );
  const [history, setHistory] = useState<PortHistoryPoint[] | null>(null);
  const [label, setLabel] = useState('');
  const [wattage, setWattage] = useState('');

  const { data: insights } = usePolling(() => fetchPanelInsights(7), 5 * 60_000);
  // Clipping is checked hourly: it pairs thirty days of port readings with their inverters',
  // the heaviest query in the app at about two seconds on the Pi.
  const { data: clipping } = usePolling(() => fetchClipping(30), 60 * 60_000);
  // Personal bests, refreshed every ten minutes — a record only moves on an exceptional
  // day, and never urgently.
  const { data: records } = usePolling(() => fetchPanelRecords(), 10 * 60_000);
  const recordByPort = useMemo(
    () => new Map((records ?? []).map((r) => [r.portId, r.peakW])),
    [records],
  );
  // Sorted best-first by the API, so the head of the list is the roof record.
  const roofRecord = records?.[0] ?? null;
  const selectedRecord = records?.find((r) => r.portId === selectedId) ?? null;
  const cells = useRoofCells(panels, live, metric, recordByPort);
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
  // `insights === null` means not-yet-loaded OR the fetch failed (usePolling swallows errors
  // and holds the last good value) — not the same as "nothing wrong", so do not assert.
  const insightsKnown = insights !== null;
  /*
    Three different counts, and they must not be swapped. The gateway registers more panels
    than send per-panel detail, and more have saved records than are currently reporting —
    46 registered, 42 with records, 38 sending on this roof.

    The denominator is the roof, not whatever is currently talking, and the silent ones are
    counted apart rather than called healthy. Their output is still in the system total; it
    just isn't attributable.
  */
  const reporting = live?.ports.length ?? cells.length;
  const totalPanels = summary?.panelsTotal || reporting;
  const underperf = insights?.length ?? 0;
  const healthyPanels = Math.max(0, reporting - underperf);
  const silentPanels = Math.max(0, totalPanels - reporting);
  const roofW = (live?.ports ?? []).reduce((a, p) => a + p.power, 0);
  const typicalW = live?.ports.length ? Math.round(roofW / live.ports.length) : 0;
  const silentNote = silentPanels
    ? ` ${silentPanels === 1 ? 'One more sends' : `${silentPanels} more send`} no detail at all.`
    : '';
  // Editing wins over the toggle: you cannot place a panel on a roof you are not looking at.
  const showInverters = byInverter && !editMode;
  const roofAnswer = !insightsKnown
    ? 'Checking how each panel is doing…'
    : underperf === 0
      ? `All ${reporting} panels that report are keeping up with each other.${silentNote}`
      : `${healthyPanels} of your ${totalPanels} panels are keeping up. ${underperf === 1 ? 'One is' : `${underperf} are`} making less than their neighbours${insights?.[0]?.pattern === 'shading' ? ' — likely shading.' : ' — worth a look below.'}${silentNote}`;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {/* health hero */}
      <Surface hero sx={{ p: 7, borderRadius: `${solar.radius.hero}px`, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <Typography variant="answer" component="h2" sx={{ color: 'text.primary' }}>{roofAnswer}</Typography>
        <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: { xs: 6, md: 11 }, flexWrap: 'wrap' }}>
          {/*
            THE ROOF RECORD, alongside the health figures.

            Not a health number and deliberately not styled as one — it is here because it is
            the only thing on this page that is purely enjoyable, and because it gives the
            watts beside it a scale. "257 W typical" means nothing until you know the best any
            panel here has ever managed is 388.
          */}
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
          {roofRecord && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="overline" color="text.disabled">Roof record</Typography>
              <Metric value={roofRecord.peakW.toFixed(0)} unit="W" variant="metricMd" />
              <Typography variant="mono" sx={{ color: 'text.disabled' }}>
                {roofRecord.panel} · {recordMoment(roofRecord.at)}
              </Typography>
            </Box>
          )}
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
          <ToggleButton value="peak">Best ever</ToggleButton>
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
              background: `linear-gradient(90deg,${solar.ramp[RAMP_FOR[metric]][0]},${solar.ramp[RAMP_FOR[metric]][1]},${solar.ramp[RAMP_FOR[metric]][2]})`,
            }}
          />
          <Typography variant="mono" sx={{ color: 'text.disabled' }}>
            {SCALE_LABELS[metric][1]}
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />
        {/*
          Which arrangement, not which metric — so it is a separate control rather than three
          more buttons in the group above. Hidden while editing, where only the roof applies.
        */}
        {!editMode && (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={byInverter ? 'inverter' : 'roof'}
            onChange={(_, value) => value && setParams({ metric, view: value }, { replace: true })}
            sx={{ bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: '9px', p: '3px', gap: '2px' }}
          >
            <ToggleButton value="roof">Roof</ToggleButton>
            <ToggleButton value="inverter">By inverter</ToggleButton>
          </ToggleButtonGroup>
        )}
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
            Select a panel — on the roof or in the tray below — then click an empty cell to move it there.
          </Typography>
        </Surface>
      )}

      {/*
        CLIPPING — absent unless it is actually happening, which is almost always.

        Not an alert and not on the Overview: it costs energy only at the very top of the
        very best days, and a DC:AC ratio above 1.0 is deliberate design rather than a fault.
        It belongs beside the panel insights, where the other per-unit findings live.
      */}
      {clipping && clipping.length > 0 && (
        <Surface
          title="Hitting their limit"
          action={
            <Typography variant="mono" sx={{ color: solar.status.warn }}>
              {clipping.length === 1 ? '1 inverter' : `${clipping.length} inverters`}
            </Typography>
          }
        >
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {clipping.map((unit) => (
              <Box
                key={unit.inverterSerial}
                sx={{ display: 'flex', alignItems: 'baseline', gap: 3, flexWrap: 'wrap' }}
              >
                <Typography variant="subtitle1" sx={{ fontSize: 13, minWidth: 70 }}>
                  {unit.label}
                </Typography>
                <Typography variant="mono" sx={{ color: solar.status.warn, width: 90, textAlign: 'right' }}>
                  {unit.ceilingAcW.toFixed(0)} W cap
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 220 }}>
                  Its {unit.ports === 1 ? 'panel makes' : `${unit.ports} panels make`} more than it can pass.
                </Typography>
                <Typography variant="mono" sx={{ color: 'text.disabled' }}>
                  ~{(unit.lostWhPerDay / 1000).toFixed(2)} kWh/day
                </Typography>
              </Box>
            ))}
          </Box>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 3 }}>
            Not a fault — panels are deliberately sized above the inverter, so ordinary hours
            produce more at the cost of shaving the best ones.
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
        {/* The map can only draw what reports, so it says so rather than implying the roof is smaller. */}
        <Surface
          // Card titles describe what is DRAWN — every panel with a saved record, including
          // ones sitting at zero. The hero above counts what is reporting.
          title={
            showInverters
              ? `By inverter · ${cells.length} panels`
              : cells.length < totalPanels
                ? `Array · ${cells.length} of ${totalPanels} panels`
                : `Array · ${totalPanels} panels`
          }
        >
          {showInverters ? (
            <InverterView
              cells={cells}
              metric={metric}
              selectedId={selectedId}
              onSelect={(meta) => setSelectedId(meta.id === selectedId ? null : meta.id)}
            />
          ) : (
            <RoofCanvas
              cells={cells}
              metric={metric}
              selectedId={selectedId}
              onSelect={(meta) => setSelectedId(meta.id === selectedId ? null : meta.id)}
              editMode={editMode}
              onPlace={(x, y) => void place(x, y)}
            />
          )}
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
                  <Chip size="small" label="LOW" sx={{ bgcolor: `${solar.status.warn}1f`, color: solar.status.warn, font: '600 10px/1.4 ui-monospace,Menlo,monospace' }} />
                ) : undefined
              }
              sx={{ borderColor: solar.surface.borderStrong }}
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
              {/*
                This panel's personal best, under its live figures.

                The single most-asked thing about one panel that the live number cannot answer:
                whether today is any good. Absent rather than zeroed while the records call is
                in flight, and absent for a panel that has only ever read zero — "best ever:
                0 W" is not a record, it is a different problem and one the roof map already
                shows.
              */}
              {selectedRecord && (
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 2,
                    mb: 4,
                    pb: 3,
                    borderBottom: `1px solid ${solar.surface.border}`,
                    flexWrap: 'wrap',
                  }}
                >
                  <Typography variant="caption" color="text.disabled">Best ever</Typography>
                  <Typography variant="mono" sx={{ color: solar.accent.gold, fontSize: 13 }}>
                    {selectedRecord.peakW.toFixed(0)} W
                  </Typography>
                  <Typography variant="mono" sx={{ color: 'text.disabled' }}>
                    {recordMoment(selectedRecord.at)} · {selectedRecord.pctOfRated}% of its {selectedRecord.ratedW} W
                  </Typography>
                </Box>
              )}
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
                  <Box sx={{ flex: 1, height: 4, borderRadius: '2px', bgcolor: solar.surface.border, overflow: 'hidden' }}>
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
