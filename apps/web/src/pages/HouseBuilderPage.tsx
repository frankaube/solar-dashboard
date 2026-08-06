import { ReactElement, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Slider from '@mui/material/Slider';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  HouseComparison,
  HouseOptions,
  HouseSpec,
  compareHouses,
  decodeHouse,
  encodeHouse,
  fetchHouseOptions,
  setDemoHouse,
  setDemoMode,
} from '../api';
import { Surface } from '../components/Surface';
import { solar } from '../theme';

const money = (n: number): string =>
  `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/**
 * Modelled numbers must never wear the same clothes as measured ones.
 *
 * The rest of the app shows watts that came off a real inverter. Everything on this
 * page came out of a simulation, and the project's whole stated value is treating "we
 * don't know" as a real answer. So modelled figures get their own tint and a standing
 * label — cheaper than a disclaimer nobody reads, and it survives a screenshot.
 */
function Modelled({
  value,
  caption,
  emphasis,
}: {
  value: string;
  caption: string;
  emphasis?: boolean;
}): ReactElement {
  return (
    <Box>
      <Typography
        sx={{
          font: `600 ${emphasis ? 34 : 24}px/1.1 ${solar.font.sans}`,
          color: emphasis ? solar.accent.gold : solar.ink.pri,
        }}
      >
        {value}
      </Typography>
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.5 }}>
        {caption}
      </Typography>
    </Box>
  );
}

function Row({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '150px 1fr' },
        gap: { xs: 1, sm: 3 },
        alignItems: 'center',
        py: 2.5,
        borderBottom: '1px solid',
        borderColor: 'divider',
        '&:last-of-type': { borderBottom: 'none', pb: 0 },
        '&:first-of-type': { pt: 0 },
      }}
    >
      <Typography variant="body2" sx={{ color: solar.ink.sec }}>
        {label}
      </Typography>
      {children}
    </Box>
  );
}

/**
 * Build a house, then ask what changing it is worth.
 *
 * Demo mode showed one fixed home: 24 kW, a battery, at latitude 46. That answers
 * "what does this app look like" and nothing else. The question people actually arrive
 * with is "what would this look like for MY house", and the one right behind it —
 * "is a battery worth it?" — is a question nobody can currently answer without buying
 * one. That second question is why this page compares two houses rather than
 * describing one.
 */
export function HouseBuilderPage(): ReactElement {
  /*
    Fetched once, not polled. The catalogue is a static list compiled into the server —
    `usePolling` with a zero interval would call setInterval(fn, 0) and hammer the API
    as fast as it can answer.
  */
  const [options, setOptions] = useState<HouseOptions | null>(null);
  useEffect(() => {
    fetchHouseOptions().then(setOptions).catch(() => setOptions(null));
  }, []);
  const [spec, setSpec] = useState<HouseSpec | null>(null);
  /** What the house looked like before the change being priced. */
  const [baseline, setBaseline] = useState<HouseSpec | null>(null);
  const [capitalCost, setCapitalCost] = useState('12000');
  const [result, setResult] = useState<HouseComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /*
    Seed from a shared link if there is one, otherwise the first preset.

    `?house=` is what makes a configured house sendable — the same encoding the API
    transport already uses, so a link costs nothing extra to produce. A malformed one
    falls back to the preset rather than showing an error, because the useful thing to
    do with a broken link is still to show someone the builder.
  */
  useEffect(() => {
    if (!options || spec) return;
    const shared = new URLSearchParams(window.location.search).get('house');
    const fromLink = shared ? decodeHouse<HouseSpec>(shared) : null;
    const seed = fromLink?.location && fromLink?.tariff ? fromLink : options.presets[0];
    setSpec(seed);
    setBaseline(seed);
  }, [options, spec]);

  useEffect(() => {
    if (!spec || !baseline) return;
    let cancelled = false;
    compareHouses(baseline, spec, Number(capitalCost) || 0)
      .then((r) => !cancelled && setResult(r))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [spec, baseline, capitalCost]);

  const changed = useMemo(
    () => JSON.stringify(spec) !== JSON.stringify(baseline),
    [spec, baseline],
  );

  if (!options || !spec) {
    return (
      <Typography variant="body2" color="text.secondary">
        Loading the catalogue…
      </Typography>
    );
  }

  const patch = (next: Partial<HouseSpec>): void => setSpec({ ...spec, ...next });
  const panelKw = spec.solar ? (spec.solar.panelCount * spec.solar.panelWatts) / 1000 : 0;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5, maxWidth: 900 }}>
      <Box>
        <Typography variant="h5" sx={{ color: solar.ink.pri }}>
          House builder
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Describe the house you have — or the one you are thinking about — and see what the
          dashboard would show. Change something and it prices the change.
        </Typography>
        {/*
          Said once, plainly, at the top. Everything below is simulated from a shape
          model calibrated at a single latitude; presenting it as an estimate would be
          the exact dishonesty this project exists to avoid.
        */}
        <Chip
          size="small"
          label="Modelled — not a quote or a yield estimate"
          sx={{ mt: 2, bgcolor: 'transparent', border: '1px dashed', borderColor: solar.ink.faint, color: solar.ink.dim }}
        />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 5 }}>
        <Surface title="The house">
          <Box>
            <Row label="Start from">
              <TextField
                select
                size="small"
                fullWidth
                value={spec.label}
                onChange={(e) => {
                  const preset = options.presets.find((p) => p.label === e.target.value);
                  if (preset) {
                    setSpec(preset);
                    setBaseline(preset);
                  }
                }}
              >
                {options.presets.map((p) => (
                  <MenuItem key={p.label} value={p.label}>
                    {p.label}
                  </MenuItem>
                ))}
              </TextField>
            </Row>

            <Row label="Panels">
              <Box>
                <Slider
                  size="small"
                  min={0}
                  max={100}
                  value={spec.solar?.panelCount ?? 0}
                  onChange={(_, v) =>
                    patch({
                      solar:
                        (v as number) === 0
                          ? null
                          : { panelCount: v as number, panelWatts: spec.solar?.panelWatts ?? 400 },
                    })
                  }
                />
                <Typography variant="caption" color="text.disabled">
                  {spec.solar ? `${spec.solar.panelCount} panels · ${panelKw.toFixed(1)} kW` : 'no solar'}
                </Typography>
              </Box>
            </Row>

            <Row label="Panel size">
              <TextField
                select
                size="small"
                fullWidth
                disabled={!spec.solar}
                value={spec.solar?.panelWatts ?? 400}
                onChange={(e) =>
                  spec.solar &&
                  patch({ solar: { ...spec.solar, panelWatts: Number(e.target.value) } })
                }
              >
                {options.panels.map((p) => (
                  <MenuItem key={p.id} value={p.watts}>
                    {p.label}
                  </MenuItem>
                ))}
              </TextField>
            </Row>

            <Row label="Battery">
              <TextField
                select
                size="small"
                fullWidth
                value={spec.battery?.label ?? 'No battery'}
                onChange={(e) => {
                  const b = options.batteries.find((x) => x.label === e.target.value);
                  patch({ battery: b && b.capacityKwh > 0 ? b : null });
                }}
              >
                {options.batteries.map((b) => (
                  <MenuItem key={b.id} value={b.label}>
                    {b.label}
                    {b.capacityKwh > 0 ? ` · ${b.capacityKwh} kWh` : ''}
                  </MenuItem>
                ))}
              </TextField>
            </Row>

            <Row label="Electric car">
              <TextField
                select
                size="small"
                fullWidth
                value={spec.ev?.label ?? 'No EV'}
                onChange={(e) => {
                  const v = options.evs.find((x) => x.label === e.target.value);
                  patch({ ev: v && v.batteryKwh > 0 ? v : null });
                }}
              >
                {options.evs.map((v) => (
                  <MenuItem key={v.id} value={v.label}>
                    {v.label}
                  </MenuItem>
                ))}
              </TextField>
            </Row>

            <Row label="Heating">
              <TextField
                select
                size="small"
                fullWidth
                value={spec.heating}
                onChange={(e) => patch({ heating: e.target.value as HouseSpec['heating'] })}
              >
                <MenuItem value="none">Not electric</MenuItem>
                <MenuItem value="baseboard">Electric baseboard</MenuItem>
                <MenuItem value="heat-pump">Heat pump</MenuItem>
              </TextField>
            </Row>

            <Row label="Programme">
              <TextField
                select
                size="small"
                fullWidth
                value={spec.tariff.programId}
                onChange={(e) => patch({ tariff: { ...spec.tariff, programId: e.target.value } })}
              >
                {options.programs.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.label}
                  </MenuItem>
                ))}
              </TextField>
            </Row>
          </Box>
        </Surface>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Surface title="A year in this house">
            {result ? (
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                <Modelled
                  value={`${Math.round(result.after.flows.producedKwh).toLocaleString()} kWh`}
                  caption="PRODUCED"
                />
                <Modelled
                  value={`${result.after.flows.selfConsumptionPct.toFixed(0)}%`}
                  caption="USED AT HOME"
                />
                <Modelled value={money(result.after.valuation.realised)} caption="KEPT PER YEAR" />
                <Modelled
                  value={money(result.after.billWithSolarPerYear)}
                  caption="REMAINING BILL"
                />
              </Box>
            ) : (
              <Typography variant="body2" color="text.disabled">
                {error ?? 'Working…'}
              </Typography>
            )}
          </Surface>

          {/*
            The comparison only appears once something is actually different. A panel
            that permanently reads "+$0" trains people to ignore it.
          */}
          {changed && result && (
            <Surface title="What the change is worth">
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Modelled
                  emphasis
                  value={`${result.realisedDeltaPerYear >= 0 ? '+' : ''}${money(result.realisedDeltaPerYear)}`}
                  caption="EXTRA KEPT PER YEAR"
                />
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  <Modelled
                    value={`${result.selfConsumptionDeltaPct >= 0 ? '+' : ''}${result.selfConsumptionDeltaPct.toFixed(0)} pts`}
                    caption="USED AT HOME"
                  />
                  <Modelled
                    value={`${result.producedDeltaKwh >= 0 ? '+' : ''}${Math.round(result.producedDeltaKwh).toLocaleString()}`}
                    caption="kWh PRODUCED"
                  />
                </Box>
                <Box>
                  <TextField
                    label="What it costs"
                    size="small"
                    type="number"
                    value={capitalCost}
                    onChange={(e) => setCapitalCost(e.target.value)}
                    sx={{ width: 180 }}
                  />
                  <Typography variant="body2" sx={{ mt: 2, color: solar.ink.sec }}>
                    {/*
                      "Never" is the honest answer for a battery under 1:1 net metering,
                      and it is the single most useful thing this page can tell someone.
                      It must be stated, not left blank.
                    */}
                    {result.paybackYears === null
                      ? 'Never pays back at this price.'
                      : `Pays back in about ${result.paybackYears.toFixed(0)} years.`}
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                  <Button size="small" variant="outlined" onClick={() => setBaseline(spec)}>
                    Make this the new baseline
                  </Button>
                  {/*
                    The payoff. Until this existed the builder was a calculator sitting
                    beside the dashboard; now the house you described generates the two
                    years of data the whole app renders.
                  */}
                  <Button
                    size="small"
                    variant="contained"
                    onClick={() => {
                      setDemoMode(true);
                      setDemoHouse(spec);
                      window.location.href = '/';
                    }}
                  >
                    See this house in the dashboard
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => {
                      const url = `${window.location.origin}/builder?house=${encodeHouse(spec)}`;
                      void navigator.clipboard
                        .writeText(url)
                        .then(() => setCopied(true))
                        .catch(() => setCopied(false));
                      setTimeout(() => setCopied(false), 2500);
                    }}
                  >
                    {copied ? 'Link copied' : 'Copy link to this house'}
                  </Button>
                </Box>
              </Box>
            </Surface>
          )}
        </Box>
      </Box>
    </Box>
  );
}
