import { ReactElement, Suspense, lazy } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { Alerts, PanelMeta, PowerPoint, Snapshot, Summary } from '../api';
import { SubTabs } from '../shell/SubTabs';

// Lazy per sub-tab: Devices and Health render no charts, so they shouldn't pull the
// ~1.1 MB echarts chunk (or each other) just to open the System hub.
const RoofPage = lazy(() => import('./RoofPage').then((m) => ({ default: m.RoofPage })));
const BatteryPage = lazy(() => import('./BatteryPage').then((m) => ({ default: m.BatteryPage })));
const DevicesPage = lazy(() => import('./DevicesPage').then((m) => ({ default: m.DevicesPage })));
const HealthPage = lazy(() => import('./HealthPage').then((m) => ({ default: m.HealthPage })));

interface SystemPageProps {
  summary: Summary | null;
  live: Snapshot | null;
  panels: PanelMeta[] | null;
  refreshPanels: () => void;
  alerts: Alerts | null;
  history: PowerPoint[] | null;
  refreshAlerts: () => void;
}

/** "My equipment" — the roof array, battery, smart devices, and fleet health. */
const SYSTEM_TABS = ['roof', 'battery', 'devices', 'health'];

export function SystemPage(props: SystemPageProps): ReactElement {
  const { tab } = useParams();
  // An unknown sub-tab used to render the tab bar over an empty page. Send it to the default.
  if (tab && !SYSTEM_TABS.includes(tab)) return <Navigate to="/system/roof" replace />;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <SubTabs
        items={[
          { to: '/system/roof', label: 'Roof' },
          { to: '/system/battery', label: 'Battery' },
          { to: '/system/devices', label: 'Devices' },
          { to: '/system/health', label: 'Health' },
        ]}
      />
      <Suspense fallback={<Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress size={22} sx={{ color: 'primary.main' }} /></Box>}>
        {tab === 'battery' && <BatteryPage />}
        {tab === 'devices' && <DevicesPage />}
        {tab === 'health' && (
          <HealthPage
            summary={props.summary}
            live={props.live}
            alerts={props.alerts}
            history={props.history}
            refreshAlerts={props.refreshAlerts}
          />
        )}
        {tab === 'roof' && (
          <RoofPage live={props.live} panels={props.panels} refreshPanels={props.refreshPanels} />
        )}
      </Suspense>
    </Box>
  );
}
