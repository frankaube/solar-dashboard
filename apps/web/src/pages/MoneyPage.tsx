import { ReactElement, Suspense, lazy } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { SubTabs } from '../shell/SubTabs';

// Lazy so that Savings — which renders no chart — doesn't pull the ~1.1 MB echarts chunk
// that TrendsPage needs. Static imports here quietly undid the app's code-splitting.
const SavingsPage = lazy(() => import('./SavingsPage').then((m) => ({ default: m.SavingsPage })));
const TrendsPage = lazy(() => import('./TrendsPage').then((m) => ({ default: m.TrendsPage })));

const MONEY_TABS = ['savings', 'trends'];

/** "How much am I making?" — savings ledger + production analytics over time. */
export function MoneyPage(): ReactElement {
  const { tab } = useParams();
  // Previously an unknown sub-tab silently rendered Savings while the URL said otherwise.
  if (tab && !MONEY_TABS.includes(tab)) return <Navigate to="/money/savings" replace />;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <SubTabs
        items={[
          { to: '/money/savings', label: 'Savings' },
          { to: '/money/trends', label: 'Analytics' },
        ]}
      />
      <Suspense fallback={<Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress size={22} sx={{ color: 'primary.main' }} /></Box>}>
        {tab === 'trends' ? <TrendsPage /> : <SavingsPage />}
      </Suspense>
    </Box>
  );
}
