import { ReactElement, ReactNode, useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Link from '@mui/material/Link';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  Capabilities,
  Config,
  ProgramOption,
  ScanResult,
  SelfConsumptionEstimate,
  fetchCapabilities,
  fetchConfig,
  fetchPrograms,
  fetchSelfConsumptionEstimate,
  fetchNotifications,
  fetchSetupDevices,
  isDemoMode,
  resetOnboarding,
  saveConfig,
  setDemoMode,
  saveDevices,
  saveNotifications,
  scanForDevices,
  testNotification,
  usePolling,
} from '../api';
import { BackupCard } from '../components/BackupCard';
import { UpdatesCard } from '../components/UpdatesCard';
import { VehicleCard } from '../components/VehicleCard';
import { HomeLocationCard } from '../components/HomeLocationCard';
import { FuelPriceCard } from '../components/FuelPriceCard';
import { PvoutputCard } from '../components/PvoutputCard';
import { UtilityUsageCard } from '../components/UtilityUsageCard';
import { SubTabs } from '../shell/SubTabs';
import { Surface } from '../components/Surface';
import {
  RATE_FIELDS,
  RateKey,
  hstToFraction,
  hstToPercent,
  validateRates,
} from './settingsRates';
import { solar } from '../theme';

const SLOW_POLL_MS = 5 * 60_000;

/**
 * What this install has, for copy that would otherwise assert somebody else's hardware.
 *
 * Help text used to name a DTU-Pro-S on TCP 10081 and say only EV and battery charging
 * could be measured. Both were true here and false for a Fronius owner with a whole-home
 * meter, who had no way to tell which sentences applied to them.
 */
function useCapabilities(): Capabilities | null {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => {
    fetchCapabilities().then(setCaps).catch(() => setCaps(null));
  }, []);
  return caps;
}

/** The second half of the self-consumption help, built from what can actually be seen. */
function selfConsumptionHelp(caps: Capabilities | null): string {
  const sources = caps?.selfConsumptionSources ?? [];
  if (!caps) return '';
  if (!sources.length) {
    return ' Nothing on this install measures it, so without a figure here every kilowatt-hour is valued as exported.';
  }
  const list =
    sources.length === 1
      ? sources[0].label
      : `${sources.slice(0, -1).map((s) => s.label).join(', ')} and ${sources[sources.length - 1].label}`;
  return ` Only ${list} can be measured here; the rest of the house needs a whole-home meter, so without a figure here most of it is valued as exported.`;
}

/**
 * Form state that follows the server until you touch it.
 *
 * Both forms on this page poll every five minutes and used to copy the response into
 * local state via `useEffect(…, [data])`. `usePolling` hands back a fresh object each
 * tick, so that effect re-ran on every poll and overwrote the fields — start typing a
 * price, get interrupted for five minutes, and your input silently reverted under the
 * cursor. There was no dirty tracking to prevent it.
 *
 * Deriving the displayed value instead (server value, overlaid with edits) removes the
 * effect altogether: nothing can clobber an edit because nothing writes to the edits.
 * Clearing them after a successful save lets the confirmed server value show through.
 */
function useEditable<K extends string>(
  server: Record<K, string> | null,
): {
  values: Record<K, string>;
  dirty: boolean;
  set: (key: K, value: string) => void;
  clear: () => void;
} {
  const [edits, setEdits] = useState<Partial<Record<K, string>>>({});
  const values = { ...(server ?? ({} as Record<K, string>)), ...edits };
  const dirty =
    server !== null && (Object.keys(edits) as K[]).some((key) => edits[key] !== server[key]);
  return {
    values,
    dirty,
    set: (key, value) => setEdits((prev) => ({ ...prev, [key]: value })),
    clear: () => setEdits({}),
  };
}

/** A labelled row: what the setting is on the left, the control on the right. */
function Row({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '1fr auto' },
        gap: { xs: 2, sm: 3 },
        alignItems: 'center',
        py: 3,
        borderBottom: '1px solid',
        borderColor: 'divider',
        '&:last-of-type': { borderBottom: 'none', pb: 0 },
        '&:first-of-type': { pt: 0 },
      }}
    >
      <Box>
        <Typography variant="body2" sx={{ color: solar.ink.pri }}>
          {label}
        </Typography>
        {help && (
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.5 }}>
            {help}
          </Typography>
        )}
      </Box>
      <Box sx={{ justifySelf: { sm: 'end' } }}>{children}</Box>
    </Box>
  );
}

/** The install's own details, read from the server rather than assumed. */
function InstallFooter(): ReactElement | null {
  const caps = useCapabilities();
  if (!caps) return null;
  const minutes = caps.pollIntervalMs ? Math.round(caps.pollIntervalMs / 60_000) : null;
  const parts = [
    caps.solar?.name,
    minutes ? `polled every ${minutes} min` : null,
  ].filter(Boolean);
  return (
    <Typography variant="caption" color="text.disabled" sx={{ lineHeight: 1.8 }}>
      {parts.join(' · ')} · Prometheus at <code>{caps.metricsPath}</code> · health at{' '}
      <code>{caps.healthPath}</code>. Poll interval, MQTT, webhook notifications and the API
      write-token are configured via environment variables in <code>docker-compose.yml</code>.
      {/*
        The source offer the AGPL asks for.

        Section 13 says anyone interacting with this over a network must be offered the
        corresponding source. On a self-hosted install that is usually just you, but it
        binds whoever modifies it and puts it in front of other people — and a link costs
        nothing, whereas discovering the obligation later is how projects end up
        retrofitting one badly.
      */}
      {' '}
      Source:{' '}
      <Link
        href="https://github.com/frankaube/solar-dashboard"
        target="_blank"
        rel="noreferrer"
        underline="hover"
      >
        github.com/frankaube/solar-dashboard
      </Link>{' '}
      — AGPL-3.0-or-later.
    </Typography>
  );
}

/**
 * The offer to stop guessing the share above and measure it instead.
 *
 * Sits directly under the field it overrides, and shows the measured figure beside the
 * typed one — the toggle is only a real choice if you can see what you would be choosing.
 * When the meter cannot support a figure yet it says so and stays off rather than
 * presenting a switch that silently does nothing.
 */
function SelfConsumptionAuto({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (on: boolean) => void;
}): ReactElement {
  const [estimate, setEstimate] = useState<SelfConsumptionEstimate | null>(null);
  useEffect(() => {
    fetchSelfConsumptionEstimate().then(setEstimate).catch(() => setEstimate(null));
  }, []);
  const measured = estimate?.pct ?? null;
  const days = estimate?.days ?? 0;
  /*
    The window is part of the figure, not a footnote to it. A share measured over one week
    describes that week's weather and that week's habits — still a better basis for the
    unmetered days than a round number typed once, but only if you can see how thin it is.
  */
  const caveat = days < 30 ? ' That is a short window — it will settle as more months import.' : '';
  const help =
    measured !== null
      ? `Your meter puts it at ${measured}% across ${days} metered day(s) — ${Math.round(estimate?.selfConsumedKwh ?? 0)} of ${Math.round(estimate?.producedKwh ?? 0)} kWh stayed home. Turn this on to use that on days no meter covers, instead of the figure above.${caveat}`
      : (estimate?.reason ?? 'Checking what the meter can tell us…');
  return (
    <Row label="Measure that share instead" help={help}>
      <Switch
        checked={value && measured !== null}
        disabled={measured === null}
        onChange={(event) => onChange(event.target.checked)}
        slotProps={{ input: { 'aria-label': 'Measure the self-consumption share instead' } }}
      />
    </Row>
  );
}

function RatesCard(): ReactElement {
  const { data: config, refresh } = usePolling<Config>(fetchConfig, SLOW_POLL_MS);
  const server: Record<RateKey | 'programId' | 'includesTax' | 'selfAuto', string> | null = config
    ? {
        price: String(config.electricityPricePerKwh),
        ratedKw: config.systemRatedKw ? String(config.systemRatedKw) : '',
        cost: config.systemCostCad ? String(config.systemCostCad) : '',
        hstPct: hstToPercent(config.hstRate),
        selfPct: config.selfConsumptionPct !== null ? String(config.selfConsumptionPct) : '',
        selfAuto: config.selfConsumptionAuto ? '1' : '0',
        programId: config.rewardProgramId ?? "net-metering",
        includesTax: config.priceIncludesTax ? '1' : '0',
      }
    : null;
  const { values, dirty, set, clear } = useEditable<RateKey | 'programId' | 'includesTax' | 'selfAuto'>(server);
  const caps = useCapabilities();
  const [programs, setPrograms] = useState<ProgramOption[] | null>(null);
  useEffect(() => {
    fetchPrograms().then(setPrograms).catch(() => setPrograms(null));
  }, []);
  const [errors, setErrors] = useState<Partial<Record<RateKey, string>>>({});
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    const found = validateRates(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setStatus({ kind: 'error', text: 'Check the highlighted fields.' });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      /*
        Blank optional fields are omitted rather than sent as null: the endpoint takes
        "positive number or absent", so there is no way to clear a system cost once set.
        Sending an empty value would just earn a 400.
      */
      await saveConfig({
        electricityPricePerKwh: Number(values.price),
        ...(values.ratedKw.trim() ? { systemRatedKw: Number(values.ratedKw) } : {}),
        ...(values.cost.trim() ? { systemCostCad: Number(values.cost) } : {}),
        ...(values.hstPct.trim() ? { hstRate: hstToFraction(values.hstPct) } : {}),
        ...(values.programId ? { rewardProgramId: values.programId } : {}),
        priceIncludesTax: values.includesTax !== '0',
        // Blank clears the assumption; 0 is a real answer, so it cannot mean "absent".
        selfConsumptionPct: values.selfPct.trim() === '' ? 0 : Number(values.selfPct),
        selfConsumptionAuto: values.selfAuto === '1',
      });
      clear();
      refresh();
      setStatus({ kind: 'ok', text: 'Saved' });
      setTimeout(() => setStatus(null), 2500);
    } catch (error) {
      setStatus({ kind: 'error', text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Surface title="Rates & system">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        How you're paid, and the numbers it's applied to. Together these drive every dollar
        figure in the app.
      </Typography>
      <Box>
        {/*
          The tariff sits above the numbers because it decides what they mean. The
          same 15% is a self-consumption premium under net metering and irrelevant
          under a feed-in tariff, so choosing it after typing the rates reads as an
          afterthought when it is the frame.
        */}
        <Row
          label="How you're paid"
          help={programs?.find((p) => p.id === values.programId)?.description}
        >
          <TextField
            select
            size="small"
            value={values.programId ?? 'net-metering'}
            onChange={(event) => set('programId', event.target.value)}
            sx={{ width: 260 }}
            slotProps={{ htmlInput: { 'aria-label': 'How you are paid' } }}
          >
            {(programs ?? []).map((option) => (
              <MenuItem key={option.id} value={option.id}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        </Row>
        {/*
          Placed directly under the price it qualifies, because it changes what that
          number means. Bills print the pre-tax energy rate, so the value people copy in
          is usually the one this app was NOT expecting — and the difference is the whole
          sales tax on every dollar figure in the app.
        */}
        <Row
          label="Is that price before or after tax?"
          help="Utility bills usually show the energy rate before tax. Say which one you typed and the app applies the rest."
        >
          <TextField
            select
            size="small"
            value={values.includesTax ?? '1'}
            onChange={(event) => set('includesTax', event.target.value)}
            sx={{ width: 260 }}
            slotProps={{ htmlInput: { 'aria-label': 'Is the price before or after tax' } }}
          >
            <MenuItem value="0">Before tax — add it on</MenuItem>
            <MenuItem value="1">After tax — that is what I pay</MenuItem>
          </TextField>
        </Row>
        {RATE_FIELDS.map((field) => (
          <Row
            key={field.key}
            label={field.label}
            help={field.key === 'selfPct' ? field.help + selfConsumptionHelp(caps) : field.help}
          >
            <TextField
              size="small"
              type="number"
              value={values[field.key] ?? ''}
              onChange={(event) => set(field.key, event.target.value)}
              error={Boolean(errors[field.key])}
              helperText={errors[field.key]}
              // MUI v9: `inputProps`/`InputProps` are gone in favour of slots.
              slotProps={{
                htmlInput: { step: field.step, 'aria-label': field.label },
                input: {
                  startAdornment: field.prefix ? (
                    <InputAdornment position="start">{field.prefix}</InputAdornment>
                  ) : undefined,
                  endAdornment: field.suffix ? (
                    <InputAdornment position="end">{field.suffix}</InputAdornment>
                  ) : undefined,
                },
              }}
              sx={{ width: 200 }}
            />
          </Row>
        ))}
        <SelfConsumptionAuto
          value={values.selfAuto === '1'}
          onChange={(on) => set('selfAuto', on ? '1' : '0')}
        />
      </Box>
      <Box sx={{ display: 'flex', gap: 3, alignItems: 'center', mt: 4 }}>
        {/*
          Disabled until something actually changed. The old button was always live and
          gave the same two-second "Saved" whether or not anything was different, which
          told you nothing about whether your edit had landed.
        */}
        <Button variant="contained" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? <CircularProgress size={18} sx={{ color: solar.on.gold }} /> : 'Save changes'}
        </Button>
        {status && (
          <Typography
            variant="caption"
            sx={{ color: status.kind === 'ok' ? solar.status.ok : solar.status.critical }}
          >
            {status.text}
          </Typography>
        )}
        {!status && dirty && (
          <Typography variant="caption" color="text.disabled">
            Unsaved changes
          </Typography>
        )}
      </Box>
    </Surface>
  );
}

function NotificationsCard(): ReactElement {
  const { data, refresh } = usePolling(fetchNotifications, SLOW_POLL_MS);
  const server = data ? { webhook: data.webhook ?? '' } : null;
  const { values, dirty, set, clear } = useEditable<'webhook'>(server);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const flash = (kind: 'ok' | 'error', text: string, ms = 2500): void => {
    setStatus({ kind, text });
    setTimeout(() => setStatus(null), ms);
  };

  return (
    <Surface title="Alerts">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        A bare word becomes an{' '}
        <Link href="https://ntfy.sh" target="_blank" rel="noopener">
          ntfy.sh
        </Link>{' '}
        topic — subscribe to the same topic in the ntfy app for push alerts and the sunset daily
        summary. Discord webhook URLs work too.
      </Typography>
      <TextField
        label="Topic or webhook"
        size="small"
        fullWidth
        value={values.webhook ?? ''}
        onChange={(event) => set('webhook', event.target.value)}
        placeholder="my-solar-a1b2c3"
      />
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mt: 3 }}>
        <Button
          variant="contained"
          disabled={!dirty}
          onClick={() =>
            void saveNotifications(values.webhook)
              .then(() => {
                clear();
                refresh();
                flash('ok', 'Saved');
              })
              // Previously uncaught: a failed save left the form looking untouched.
              .catch((error: Error) => flash('error', error.message, 5000))
          }
        >
          Save
        </Button>
        <Button
          variant="outlined"
          onClick={() =>
            void testNotification()
              .then(() => flash('ok', 'Test sent — check your phone', 4000))
              .catch(() => flash('error', 'Test failed', 4000))
          }
        >
          Send test
        </Button>
        {status && (
          <Typography
            variant="caption"
            sx={{ color: status.kind === 'ok' ? solar.status.ok : solar.status.critical }}
          >
            {status.text}
          </Typography>
        )}
      </Box>
    </Surface>
  );
}

function HardwareCard(): ReactElement {
  const caps = useCapabilities();
  const { data: devices, refresh: refreshDevices } = usePolling(fetchSetupDevices, SLOW_POLL_MS);
  const [subnet, setSubnet] = useState('');
  const [subnetTouched, setSubnetTouched] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // Suggested subnet until the user types their own — same derive-don't-sync rule as above.
  const subnetValue = subnetTouched ? subnet : (devices?.suggestedSubnet ?? '');

  const runScan = async (): Promise<void> => {
    setScanning(true);
    setScanError(null);
    setScan(null);
    try {
      setScan(await scanForDevices(subnetValue));
    } catch (error) {
      setScanError((error as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const adopt = async (
    kind: 'dtuHost' | 'chargerHost',
    host: string,
    solarVendor?: string,
  ): Promise<void> => {
    await saveDevices({ [kind]: host, ...(solarVendor ? { solarVendor } : {}) });
    refreshDevices();
  };

  const found = scan ? scan.dtus.length + scan.chargers.length : 0;

  return (
    <Surface title="Hardware">
      <Box>
        <Row label="Solar gateway">
          <Typography variant="body2" sx={{ color: devices?.dtuHost ? solar.ink.pri : solar.ink.faint }}>
            {devices?.dtuHost ?? 'not configured'}
          </Typography>
        </Row>
        <Row label="EV charger">
          <Typography
            variant="body2"
            sx={{ color: devices?.chargerHost ? solar.ink.pri : solar.ink.faint }}
          >
            {devices?.chargerHost ?? 'not configured'}
          </Typography>
        </Row>
      </Box>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', mt: 4 }}>
        <TextField
          label="Subnet to scan"
          size="small"
          value={subnetValue}
          onChange={(event) => {
            setSubnetTouched(true);
            setSubnet(event.target.value);
          }}
          helperText='first three octets, e.g. "192.168.1"'
          sx={{ width: 200 }}
        />
        <Button
          variant="contained"
          onClick={() => void runScan()}
          disabled={scanning || !subnetValue}
          sx={{ mt: 0.5 }}
        >
          {scanning ? <CircularProgress size={18} sx={{ color: solar.on.gold }} /> : 'Scan network'}
        </Button>
      </Box>

      {scanError && (
        <Typography variant="caption" sx={{ color: solar.status.critical, display: 'block', mt: 2 }}>
          {scanError}
        </Typography>
      )}

      {scan && (
        <Box sx={{ mt: 3 }}>
          {found === 0 ? (
            <Typography variant="caption" color="text.secondary">
              Nothing found on {scan.subnet}.0/24 — check the subnet and that the gear is powered.
            </Typography>
          ) : (
            <Box>
              {scan.dtus.map((dtu) => (
                <Row
                  key={dtu.host}
                  label={`${dtu.vendor} · ${dtu.host}`}
                  help={`${dtu.serialNumber} · ${dtu.inverterCount} inverters${dtu.pvCount ? ` / ${dtu.pvCount} panels` : ''}`}
                >
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={devices?.dtuHost === dtu.host}
                    onClick={() => void adopt('dtuHost', dtu.host, dtu.vendor)}
                  >
                    {devices?.dtuHost === dtu.host ? 'In use' : 'Use'}
                  </Button>
                </Row>
              ))}
              {scan.chargers.map((charger) => (
                <Row
                  key={charger.host}
                  // Named from the registry: the chip should say what is actually
                  // connected, not the one product this build happened to start with.
                  label={`${caps?.charger?.name ?? 'EV charger'} · ${charger.host}`}
                  help={`grid ${charger.gridVoltage.toFixed(0)} V`}
                >
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={devices?.chargerHost === charger.host}
                    onClick={() => void adopt('chargerHost', charger.host)}
                  >
                    {devices?.chargerHost === charger.host ? 'In use' : 'Use'}
                  </Button>
                </Row>
              ))}
            </Box>
          )}
        </Box>
      )}

      {/*
        What the scan can recognise, at the bottom where it reads as a footnote. It was
        the card's header action — a long "·"-joined vendor list wrapping across the top
        of the card, which made the most prominent line the least useful one.
      */}
      {devices?.vendors.length ? (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 4 }}>
          Recognises {devices.vendors.map((vendor) => vendor.name).join(' · ')}
        </Typography>
      ) : null}
    </Surface>
  );
}

function DataCard(): ReactElement {
  const demo = isDemoMode();
  return (
    <Surface title="Data">
      <Box>
        <Row label="Export" help="Everything recorded, as plain CSV.">
          <Typography variant="body2">
            <Link href="/api/export/daily.csv" download>
              Daily energy
            </Link>
            {' · '}
            <Link href="/api/export/readings.csv" download>
              Raw readings
            </Link>
          </Typography>
        </Row>
        <Row
          label="Demo mode"
          help="Fills the app with ~2 years of sample data, including a home battery. Your real data stays untouched."
        >
          <Button
            variant="outlined"
            size="small"
            onClick={() => {
              setDemoMode(!demo);
              window.location.href = '/';
            }}
          >
            {demo ? 'Exit demo mode' : 'Enter demo mode'}
          </Button>
        </Row>
        {/*
          A plain download rather than a preview-then-download: the file is the artefact,
          and the promise about what is in it is made by the report itself — its last
          section lists what was excluded, so it can be checked rather than trusted.
        */}
        <Row
          label="Install report"
          help="What the app has found about your setup and how it worked it out. No address, no serial numbers, no credentials, no dollar figures — safe to send to an installer or paste in a forum."
        >
          <Button variant="outlined" size="small" href="/api/system/report.md">
            Download report
          </Button>
        </Row>
        <Row label="Setup wizard" help="Re-run the first-time wizard to scan for new gear.">
          <Button
            variant="outlined"
            size="small"
            onClick={() =>
              void resetOnboarding().then(() => {
                window.location.href = '/welcome';
              })
            }
          >
            Re-run setup
          </Button>
        </Row>
      </Box>
    </Surface>
  );
}

const SETTINGS_TABS = [
  { id: 'rates', label: 'Rates' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'vehicle', label: 'Vehicle' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'backup', label: 'Backup' },
  { id: 'updates', label: 'Updates' },
  { id: 'data', label: 'Data' },
];

/**
 * One panel per tab, all of them mounted.
 *
 * Hidden rather than unmounted, which is the one place this diverges from the Money and
 * System hubs. Those switch between read-only views, so unmounting costs nothing. Every
 * panel here is a form holding edits in component state — unmounting would throw away
 * whatever you had typed the moment you clicked another tab, silently, which is the same
 * class of surprise `useEditable` exists to prevent. Keeping them mounted also leaves
 * fetching and polling exactly as they were when this was one long page.
 */
function Panel({ active, children }: { active: boolean; children: ReactNode }): ReactElement {
  return <Box sx={{ display: active ? 'block' : 'none' }}>{children}</Box>;
}

export function SettingsPage(): ReactElement {
  const { tab } = useParams();
  const current = SETTINGS_TABS.find((t) => t.id === tab);
  // An unknown tab used to be impossible; now it is one typo in the address bar. Land on
  // the first tab rather than rendering it while the URL claims otherwise.
  if (!current) return <Navigate to={`/settings/${SETTINGS_TABS[0].id}`} replace />;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 640 }}>
      {/*
        No subtitle under the heading. Each card already opens with a line explaining
        itself, and a per-tab blurb here restated the Rates card's word for word — the tab
        bar is what orients you now, so the sentence it replaced is not needed twice.
      */}
      <Typography variant="h5" sx={{ color: solar.ink.pri }}>
        Settings
      </Typography>

      <SubTabs
        items={SETTINGS_TABS.map((t) => ({ to: `/settings/${t.id}`, label: t.label }))}
      />

      <Panel active={current.id === 'rates'}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <RatesCard />
          {/* Beside the rates because it decides what self-consumption means, which is
              what every figure on that card is multiplied against. */}
          <UtilityUsageCard />
        </Box>
      </Panel>
      <Panel active={current.id === 'hardware'}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <HardwareCard />
          {/*
            Install details as a quiet footer rather than a card of their own. Reference
            material you read once, and it belongs with the hardware it describes.

            Every fact here comes from the server. It used to read "DTU-Pro-S · local
            protobuf on TCP 10081 · 5-min polling", which was this developer's hardware
            asserted at everyone — a Fronius owner was told the wrong protocol on the
            wrong port, with nothing to indicate the line did not apply to them.
          */}
          <InstallFooter />
        </Box>
      </Panel>
      <Panel active={current.id === 'vehicle'}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <VehicleCard />
          {/* Home sits below the connection, because the button that fills it needs one. */}
          <HomeLocationCard />
          <FuelPriceCard />
        </Box>
      </Panel>
      <Panel active={current.id === 'alerts'}>
        <NotificationsCard />
      </Panel>
      <Panel active={current.id === 'backup'}>
        <BackupCard />
      </Panel>
      <Panel active={current.id === 'updates'}>
        <UpdatesCard />
      </Panel>
      <Panel active={current.id === 'data'}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <DataCard />
          {/*
            Under the export tools, because it is the same question — what leaves this
            machine — and the only answer here that leaves it continuously.
          */}
          <PvoutputCard />
        </Box>
      </Panel>
    </Box>
  );
}
