import { ReactElement, Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import {
  fetchAlerts,
  fetchLive,
  fetchOnboarding,
  fetchPanels,
  fetchPowerHistory,
  fetchSummary,
  usePolling,
} from './api';
import { FreshnessProvider } from './shell/freshness';
import { AppShell } from './shell/AppShell';

// Every route loads on demand, so the charts library lands in an async chunk
// rather than the initial bundle — a first-time visitor on the welcome wizard
// downloads only the shell.
// Four primary destinations. Money and System are hub pages that lazy-import their
// own sub-pages (Savings/Trends and Roof/Battery/Devices/Health respectively).
const OverviewPage = lazy(() => import('./pages/OverviewPage').then((m) => ({ default: m.OverviewPage })));
const CarPage = lazy(() => import('./pages/CarPage').then((m) => ({ default: m.CarPage })));
const MoneyPage = lazy(() => import('./pages/MoneyPage').then((m) => ({ default: m.MoneyPage })));
const SystemPage = lazy(() => import('./pages/SystemPage').then((m) => ({ default: m.SystemPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const HouseFlow = lazy(() => import('./components/HouseFlow').then((m) => ({ default: m.HouseFlow })));
const HouseBuilderPage = lazy(() =>
  import('./pages/HouseBuilderPage').then((m) => ({ default: m.HouseBuilderPage })),
);
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));
const OnboardingPage = lazy(() => import('./pages/OnboardingPage').then((m) => ({ default: m.OnboardingPage })));

const LIVE_POLL_MS = 60_000;
const ONBOARDING_POLL_MS = 30_000;
const HISTORY_HOURS = 24;

function PageFallback(): ReactElement {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
      <CircularProgress size={24} sx={{ color: 'primary.main' }} />
    </Box>
  );
}

/**
 * `<Navigate to="/some/path">` resolves a bare string and drops search + hash, which would
 * silently break the deep links the app itself hands out (RoofPage writes ?metric= and
 * ?panel= into the URL). Carry them across.
 */
function LegacyRedirect({ to }: { to: string }): ReactElement {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}

export function App(): ReactElement {
  const location = useLocation();
  const { data: onboarding } = usePolling(fetchOnboarding, ONBOARDING_POLL_MS);
  const { data: summary } = usePolling(fetchSummary, LIVE_POLL_MS);
  const { data: live } = usePolling(fetchLive, LIVE_POLL_MS);
  const { data: history } = usePolling(() => fetchPowerHistory(HISTORY_HOURS), LIVE_POLL_MS);
  const { data: alerts, refresh: refreshAlerts } = usePolling(fetchAlerts, LIVE_POLL_MS);
  const { data: panels, refresh: refreshPanels } = usePolling(fetchPanels, LIVE_POLL_MS);

  const unacked = (alerts?.active ?? []).filter((alert) => !alert.ackedAt).length;

  // Live tab title — a pinned tab shows current output at a glance.
  useEffect(() => {
    const kw = (summary?.currentPowerW ?? 0) / 1000;
    document.title = kw >= 0.05 ? `${kw.toFixed(1)} kW · Solar` : 'Solar Dashboard';
  }, [summary?.currentPowerW]);

  // First run: send the user to the welcome wizard until they finish (or skip) it.
  if (onboarding && !onboarding.complete && location.pathname !== '/welcome') {
    return <Navigate to="/welcome" replace />;
  }
  if (location.pathname === '/welcome') {
    return (
      <Suspense fallback={<PageFallback />}>
        <OnboardingPage />
      </Suspense>
    );
  }

  return (
    <FreshnessProvider updatedAt={summary?.updatedAt}>
      <AppShell alertCount={unacked}>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route
              path="/"
              element={
                <OverviewPage summary={summary} history={history} alerts={alerts} />
              }
            />
            <Route path="/car" element={<CarPage />} />
            <Route path="/money" element={<LegacyRedirect to="/money/savings" />} />
            <Route path="/money/:tab" element={<MoneyPage />} />
            <Route path="/system" element={<LegacyRedirect to="/system/roof" />} />
            <Route
              path="/system/:tab"
              element={
                <SystemPage
                  summary={summary}
                  live={live?.snapshot ?? null}
                  panels={panels}
                  refreshPanels={refreshPanels}
                  alerts={alerts}
                  history={history}
                  refreshAlerts={refreshAlerts}
                />
              }
            />
            <Route path="/settings" element={<LegacyRedirect to="/settings/rates" />} />
            <Route path="/settings/:tab" element={<SettingsPage />} />
            {/* Prototype: the isometric house view. Own route so it can be judged
                without disturbing the working dashboard. */}
            <Route path="/house" element={<HouseFlow />} />
            {/* Demo-only: describe a house, then price a change to it. */}
            <Route path="/builder" element={<HouseBuilderPage />} />
            {/* legacy paths → new homes; LegacyRedirect preserves ?query and #hash */}
            <Route path="/savings" element={<LegacyRedirect to="/money/savings" />} />
            <Route path="/trends" element={<LegacyRedirect to="/money/trends" />} />
            <Route path="/roof" element={<LegacyRedirect to="/system/roof" />} />
            <Route path="/battery" element={<LegacyRedirect to="/system/battery" />} />
            <Route path="/devices" element={<LegacyRedirect to="/system/devices" />} />
            <Route path="/health" element={<LegacyRedirect to="/system/health" />} />
            {/* Anything else would otherwise render an empty shell titled "Overview". */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </AppShell>
    </FreshnessProvider>
  );
}
