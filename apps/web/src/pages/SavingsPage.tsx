import { ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { Savings, SavingsPeriod, fetchSavings, usePolling } from '../api';
import { CreditBankCard } from '../components/CreditBankCard';
import { Metric, Surface } from '../components/Surface';
import { solar } from '../theme';

const POLL_MS = 5 * 60_000;
/** Dim slate for value that was never realized — an opportunity, not money in hand. */
const FOREGONE = '#4a443b';

const money = (n: number, dp = 0): string =>
  `$${n.toLocaleString('en-CA', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const cents = (n: number): string => `${(n * 100).toFixed(1)}¢`;

/**
 * The caveats on this page are load-bearing — every figure here is a claim about
 * someone's money, and several are ceilings rather than totals. But nine of them
 * rendered inline turned the page into an essay. They live behind this instead:
 * still one gesture away, no longer competing with the numbers for attention.
 */
function Hint({ children }: { children: string }): ReactElement {
  return (
    <Tooltip title={children} enterTouchDelay={0} leaveTouchDelay={6000} arrow>
      <Box
        component="span"
        tabIndex={0}
        aria-label={children}
        sx={{
          ml: '5px',
          width: 14,
          height: 14,
          flex: '0 0 14px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '999px',
          border: '1px solid',
          borderColor: solar.surface.border,
          color: solar.ink.dim,
          font: `600 9px/1 ${solar.font.sans}`,
          cursor: 'help',
          verticalAlign: 'middle',
          transition: 'color .2s, border-color .2s',
          '&:hover, &:focus-visible': { color: solar.ink.pri, borderColor: solar.ink.dim },
        }}
      >
        i
      </Box>
    </Tooltip>
  );
}

/** label + value + proportional bar. The "why" is a hint, not a paragraph. */
function SourceRow({
  label,
  color,
  value,
  hint,
  frac,
}: {
  label: string;
  color: string;
  value: string;
  hint: string;
  frac: number;
}): ReactElement {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Typography
          component="div"
          sx={{ font: `500 13.5px/1.3 ${solar.font.sans}`, color: solar.ink.pri }}
        >
          {label}
          <Hint>{hint}</Hint>
        </Typography>
        <Typography variant="mono" sx={{ fontSize: 16, color }}>
          {value}
        </Typography>
      </Box>
      <Box sx={{ height: 9, borderRadius: '3px', bgcolor: solar.surface.inset, overflow: 'hidden' }}>
        <Box sx={{ width: `${Math.min(100, frac * 100)}%`, height: 9, borderRadius: '3px', bgcolor: color }} />
      </Box>
    </Box>
  );
}

interface PeriodRow {
  label: string;
  short: string;
  p: SavingsPeriod;
}

/**
 * Collapse consecutive periods that hold identical figures into one row.
 *
 * On a system less than a month old, month/year/lifetime are genuinely the same
 * number — printing it three times reads as a rendering bug rather than as the fact
 * it is. Merging says the same thing in one line and stops being clever the moment
 * the periods actually diverge.
 */
export function mergePeriods(rows: PeriodRow[]): Array<{ label: string; p: SavingsPeriod }> {
  const out: Array<{ label: string; p: SavingsPeriod }> = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    const same =
      prev &&
      prev.p.producedKwh === row.p.producedKwh &&
      prev.p.realizedSaved === row.p.realizedSaved;
    if (same) prev.label += ` · ${row.short}`;
    else out.push({ label: row.label, p: row.p });
  }
  return out;
}

export function SavingsPage(): ReactElement {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { data } = usePolling<Savings>(fetchSavings, POLL_MS);
  if (!data) return <Surface><Typography variant="body2">Loading…</Typography></Surface>;

  const { rates, lifetime, year, month, today } = data;
  const gross = Math.max(lifetime.grossValue, 1);
  const rows = mergePeriods([
    { label: 'Today', short: 'today', p: today },
    { label: 'This month', short: 'month', p: month },
    { label: 'This year', short: 'year', p: year },
    { label: 'Lifetime', short: 'lifetime', p: lifetime },
  ]);
  const hstPct = (rates.hstRate * 100).toFixed(0);
  /*
    Derived from the rule ids the programme returned rather than from a programme id,
    because what this card explains is the tax premium — and that exists exactly when
    the engine emitted a `tax-kept` line, whatever the programme ends up being called.
  */
  const isNetMetering = lifetime.lines.some((line) => line.id === 'tax-kept');
  /*
    Asked of the programme rather than read from a dedicated field.

    `rates.exportCreditPerKwh` used to be published beside the retail price, quietly
    asserting that every tariff has an export credit; two of the three do not. The
    marginal value answers it for all of them — and it has to be the marginal value
    rather than "the rule that applies to exported", because net metering credits
    `produced` and adds tax back for self-use, so that simpler reading returns zero
    and would draw a "Sent to the grid: 0¢" bar under the one tariff where the card
    is shown at all.
  */
  const exportRate = rates.marginal.exportedPerKwh;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 5 }}>
        {/*
          The hero is the REALIZED figure, not the gross one. Gross is a ceiling that
          assumes every kWh replaced a purchase, and leading with it meant the biggest
          number on a page about someone's money was the one that isn't true.
        */}
        <Surface hero sx={{ p: 7, borderRadius: `${solar.radius.hero}px`, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Typography variant="answer" component="h2" sx={{ color: 'text.primary' }}>
            So far, your roof has kept you
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Metric value={money(lifetime.realizedSaved)} variant="metricHero" />
            <Typography variant="caption" color="text.disabled" component="div">
              from {lifetime.producedKwh.toLocaleString('en-CA')} kWh · up to {money(lifetime.grossValue)} if every
              kWh had replaced a purchase
              <Hint>
                {`The ${money(lifetime.grossValue)} ceiling values all ${lifetime.producedKwh.toLocaleString('en-CA')} kWh at the ${cents(rates.retailPerKwh)}/kWh you pay to buy power. You only reach it by using every kWh as you make it; what you exported comes back with sales tax on top.`}
              </Hint>
            </Typography>
          </Box>
          {data.systemCostCad ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Box sx={{ height: 8, borderRadius: '5px', bgcolor: solar.surface.border, overflow: 'hidden' }}>
                <Box sx={{ width: `${Math.min(100, data.paybackProgressPct ?? 0)}%`, minWidth: data.paybackProgressPct ? 2 : 0, height: 8, bgcolor: solar.status.ok }} />
              </Box>
              <Typography variant="caption" color="text.disabled">
                {(data.paybackProgressPct ?? 0).toFixed(1)}% of the {money(data.systemCostCad)} system paid back
              </Typography>
            </Box>
          ) : (
            <Typography variant="caption" color="text.disabled">
              Add your system cost in Settings to track payback.
            </Typography>
          )}
        </Surface>

        {/*
          Rendered from whatever the chosen programme returns, rather than from three
          hardcoded net-metering rows.

          The old markup named "Export credits" and "Tax kept on self-use" directly,
          which stopped being true the moment the tariff became a setting — under a
          no-export arrangement there are no export credits and no tax premium, and the
          page would have shown two confident $0.00 rows and a label describing a
          mechanism that does not apply. Labels, colours and explanations now come from
          the programme itself; unrealised lines are the ones that get the muted tone.
        */}
        <Surface title="Where that comes from">
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {lifetime.lines.map((line, index) => (
              <SourceRow
                key={line.id}
                label={line.label}
                color={
                  !line.realised
                    ? FOREGONE
                    : index === 0
                      ? solar.series.financial
                      : solar.series.money
                }
                value={money(line.amount)}
                hint={line.note ?? ''}
                frac={gross > 0 ? line.amount / gross : 0}
              />
            ))}
          </Box>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 3 }}>
            Valued under {lifetime.programName}. Change it in Settings.
          </Typography>
        </Surface>
      </Box>

      {/*
        Net metering only.

        The comparison this card draws — retail versus a tax-reduced export credit — is
        a fact about net metering, not about solar. Under a feed-in tariff the gap is
        set by the published export rate, and under no-export the right-hand bar is
        zero and "the 15% rule" names a mechanism that does not exist. Showing it
        regardless would be the same mistake as the hardcoded breakdown above.
      */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 5 }}>
        {isNetMetering && (
        <Surface title={`Use it or export it — the ${hstPct}% rule`}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {[
              { label: 'Used at home', v: rates.marginal.selfConsumedPerKwh, color: solar.series.production, ink: solar.ink.pri },
              { label: 'Sent to the grid', v: exportRate, color: '#6e6558', ink: solar.ink.sec },
            ].map((r) => (
              <Box key={r.label} sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <Typography sx={{ width: 128, flex: '0 0 128px', font: `500 13px/1.3 ${solar.font.sans}`, color: r.color === '#6e6558' ? solar.ink.dim : solar.series.production }}>
                  {r.label}
                </Typography>
                <Box sx={{ flex: 1, height: 30, borderRadius: '6px', bgcolor: solar.surface.inset, overflow: 'hidden' }}>
                  <Box sx={{ width: `${(r.v / rates.retailPerKwh) * 100}%`, height: 30, borderRadius: '6px', bgcolor: r.color }} />
                </Box>
                <Typography variant="mono" sx={{ width: 68, textAlign: 'right', fontSize: 18, color: r.ink }}>
                  {cents(r.v)}
                </Typography>
              </Box>
            ))}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 4 }}>
            Power used the moment you make it is worth {hstPct}% more, because you skip the sales tax on buying it
            back. Exporting instead has cost {money(lifetime.bonusForegone)} so far
            <Hint>
              {`A battery could target up to ${money(year.bonusForegone)}/yr — but only on the share you'd actually shift into the evening, so treat it as a ceiling rather than a saving.`}
            </Hint>
          </Typography>
        </Surface>
        )}

        <Surface title="By period">
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ display: 'flex', pb: 2, borderBottom: '1px solid', borderColor: 'divider', font: `600 10.5px/1 ${solar.font.sans}`, letterSpacing: '.12em', textTransform: 'uppercase', color: solar.ink.dim }}>
              <Box sx={{ flex: 1 }}>Period</Box>
              <Box sx={{ width: 92, textAlign: 'right' }}>Energy</Box>
              <Box sx={{ width: 92, textAlign: 'right' }}>Kept</Box>
              <Box sx={{ width: 88, textAlign: 'right', pl: 2 }}>Used here</Box>
            </Box>
            {rows.map(({ label, p }) => (
              <Box key={label} sx={{ display: 'flex', alignItems: 'center', py: '13px', borderBottom: '1px solid', borderColor: solar.grid.line }}>
                <Typography sx={{ flex: 1, font: `500 13.5px/1.25 ${solar.font.sans}`, color: solar.ink.pri, pr: 2 }}>{label}</Typography>
                <Typography variant="mono" sx={{ width: 92, textAlign: 'right', fontSize: 13, color: solar.ink.sec }}>{p.producedKwh.toLocaleString('en-CA')} kWh</Typography>
                {/* realizedSaved, not grossValue: a column headed "Kept" must agree with the hero. */}
                <Typography variant="mono" sx={{ width: 92, textAlign: 'right', fontSize: 13.5, color: solar.series.money }}>{money(p.realizedSaved, 2)}</Typography>
                {/*
                  Marked when the figure rests on the estimate rather than a meter. An
                  estimate beats the 1% a partial meter reports, but presenting a guess
                  and a measurement in the same typeface leaves nobody able to tell which
                  is which — and this column is what decides the "Kept" one beside it.
                */}
                <Tooltip
                  title={
                    p.selfConsumptionEstimated
                      ? 'Based on the share you estimated in Settings, not a meter. Only EV and battery charging can be measured directly.'
                      : ''
                  }
                >
                  <Typography variant="mono" sx={{ width: 88, textAlign: 'right', pl: 2, fontSize: 13, color: solar.ink.dim, cursor: p.selfConsumptionEstimated ? 'help' : 'default' }}>
                    {p.selfConsumptionPct}%{p.selfConsumptionEstimated ? ' *' : ''}
                  </Typography>
                </Tooltip>
              </Box>
            ))}
          </Box>
          <Link
            component="button"
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            underline="hover"
            sx={{ font: `600 12.5px/1 ${solar.font.sans}`, color: solar.accent.link, mt: 3, display: 'inline-block' }}
          >
            {showAdvanced ? 'Hide rate detail' : 'Advanced — rates & self-consumption'}
          </Link>
          <Collapse in={showAdvanced}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 3, pt: 3, borderTop: '1px solid', borderColor: 'divider' }}>
              {/*
                Listed from the programme rather than naming net metering's two rates.
                Each line says what it pays and what you have to do to earn it, which
                is the only phrasing that survives changing tariff.
              */}
              <Typography variant="caption" color="text.secondary">
                Buy / retail rate: {cents(rates.retailPerKwh)}/kWh
                {rates.perKwh
                  .filter((r) => r.realised)
                  .map((r) => ` · ${r.label.toLowerCase()}: ${cents(r.ratePerKwh)}/kWh`)
                  .join('')}
              </Typography>
              {/*
                Stated only when it is true. Under a time-of-use tariff "a kWh used at
                home is worth X" has no single answer, and printing the peak rate as
                though it always applied would overstate every off-peak hour by more
                than double.
              */}
              {rates.marginal.varies && (
                <Typography variant="caption" color="text.disabled">
                  Your price changes through the day, so a kWh used at home is worth
                  between {cents(rates.marginal.selfConsumedLowPerKwh)} and{' '}
                  {cents(rates.marginal.selfConsumedPerKwh)}/kWh depending on when you use it.
                  The figures above use the hour each kWh actually flowed.
                </Typography>
              )}
              <Typography variant="caption" color="text.disabled">
                Self-consumption is measured from EV charging on solar ({data.measured.evSolarKwhLifetime.toLocaleString('en-CA')} kWh) and battery discharge ({data.measured.batteryDischargeKwhLifetime.toLocaleString('en-CA')} kWh). With no whole-home meter the base load solar covers is invisible, so the true figure is higher.
              </Typography>
              <Link href="/api/export/daily.csv" download sx={{ font: `600 12px/1 ${solar.font.sans}` }}>Daily energy CSV →</Link>
            </Box>
          </Collapse>
        </Surface>

        {/*
          Below the ledger deliberately. It answers a different question — not "what did
          the roof earn" but "is any of it about to evaporate" — and it is the only figure
          on this page that comes off a bill rather than a meter.
        */}
        <CreditBankCard />
      </Box>
    </Box>
  );
}
