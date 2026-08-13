import { ReactElement, ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { NewVersionBar } from './NewVersionBar';
import { ThemeToggle } from './ThemeToggle';
import { solar } from '../theme';
import { useFreshness } from './freshness';
import { CarIcon, GearIcon, SavingsIcon, SunIcon, SystemIcon } from './icons';
import { DemoBanner } from './DemoBanner';

const NAV = [
  { to: '/', label: 'Home', icon: <SunIcon /> },
  { to: '/money', label: 'Money', icon: <SavingsIcon /> },
  { to: '/car', label: 'Car', icon: <CarIcon /> },
  { to: '/system', label: 'System', icon: <SystemIcon /> },
];

const TITLES: Record<string, string> = {
  '/': 'Overview',
  '/car': 'Car',
  '/money/savings': 'Savings',
  '/money/trends': 'Trends & analytics',
  '/system/roof': 'Roof layout',
  '/system/battery': 'Battery',
  '/system/devices': 'Devices',
  '/system/health': 'Health',
  '/settings': 'Settings',
  '/settings/rates': 'Settings',
  '/settings/hardware': 'Settings',
  '/settings/alerts': 'Settings',
  '/settings/backup': 'Settings',
  '/settings/data': 'Settings',
};

function NavItem({
  to,
  label,
  icon,
  badge,
  bottom,
  title,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  bottom?: boolean;
  title?: string;
}): ReactElement {
  return (
    // `label` is empty for the settings gear, which left that link with no accessible
    // name at all on desktop — fall back to the title.
    <NavLink
      to={to}
      /*
        The flex item is this anchor, not the Box inside it.

        `flex: 1` sat on that inner Box, where it did nothing: the anchor stayed
        shrink-to-fit, so on a 400 px phone all five tabs crowded into the left 111 px and
        the labels ran together as one word. minWidth: 0 lets a long label shrink instead
        of forcing the row wider than the screen.
      */
      style={bottom ? { textDecoration: 'none', flex: 1, minWidth: 0 } : { textDecoration: 'none' }}
      end={to === '/'}
      aria-label={`${label || title}${badge ? ` — ${badge} needing attention` : ''}`}
    >
      {({ isActive }) => (
        <Box
          sx={{
            position: 'relative',
            width: bottom ? '100%' : 48,
            height: 48,
            borderRadius: '11px',
            bgcolor: isActive && !bottom ? solar.surface.raised : 'transparent',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '4px',
            color: isActive ? solar.series.production : solar.ink.dim,
            flex: bottom ? 1 : undefined,
          }}
        >
          {isActive && !bottom && (
            <Box
              sx={{
                position: 'absolute',
                left: -12,
                top: 14,
                width: 3,
                height: 20,
                borderRadius: '2px',
                bgcolor: solar.series.production,
              }}
            />
          )}
          {icon}
          <Typography sx={{ font: '600 8px/1 ui-monospace,Menlo,monospace', letterSpacing: '.06em' }}>
            {label.toUpperCase()}
          </Typography>
          {badge ? (
            <Box
              sx={{
                position: 'absolute',
                top: 4,
                right: bottom ? 'calc(50% - 22px)' : 4,
                minWidth: 15,
                height: 15,
                borderRadius: '8px',
                bgcolor: solar.status.warn,
                color: solar.on.gold,
                font: '700 9px/15px ui-monospace,Menlo,monospace',
                textAlign: 'center',
                px: '2px',
              }}
            >
              {badge}
            </Box>
          ) : null}
        </Box>
      )}
    </NavLink>
  );
}

interface AppShellProps {
  alertCount: number;
  topRight?: ReactNode;
  children: ReactNode;
}

export function AppShell({ alertCount, topRight, children }: AppShellProps): ReactElement {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('md'));
  const { secondsAgo, isStale } = useFreshness();
  const location = useLocation();
  // No fallback to a real page name — an unmatched path titled "Overview" reads as
  // "Overview is broken" rather than "wrong URL".
  const title = TITLES[location.pathname] ?? '';

  const pollText =
    secondsAgo === null ? 'connecting…' : `polled ${secondsAgo}s ago · 5-min data`;
  const pollColor = isStale ? solar.status.warn : solar.ink.sec;

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      {!mobile && (
        <Box
          sx={{
            width: solar.dims.rail,
            flex: `0 0 ${solar.dims.rail}px`,
            bgcolor: solar.surface.rail,
            borderRight: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            py: '18px',
            gap: '6px',
            position: 'sticky',
            top: 0,
            height: '100vh',
          }}
        >
          <Box
            sx={{
              width: 32,
              height: 32,
              borderRadius: '9px',
              bgcolor: solar.series.production,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700, fontSize: 15, lineHeight: 1,
              color: solar.on.gold,
              mb: '14px',
            }}
          >
            S
          </Box>
          {NAV.map((item) => (
            <NavItem
              key={item.to}
              {...item}
              badge={item.to === '/system' ? alertCount : undefined}
            />
          ))}
          <Box sx={{ flex: 1 }} />
          <NavItem to="/settings" label="" title="Settings" icon={<GearIcon />} />
        </Box>
      )}

      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <DemoBanner />
        {/*
          Above the title bar, across the full width, on every page — because the tab that
          needs it most is one nobody is looking at, left on a wall through an overnight
          update. It renders nothing at all unless this bundle is genuinely superseded.
        */}
        <NewVersionBar />
        <Box
          sx={{
            height: solar.dims.topbar,
            flex: `0 0 ${solar.dims.topbar}px`,
            borderBottom: '1px solid',
            borderColor: 'divider',
            px: 6,
          }}
        >
          <Box
            sx={{
              maxWidth: 1368,
              mx: 'auto',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
            <Typography variant="h5">{title}</Typography>
            {!mobile && (
              <Typography variant="body2" color="text.disabled">
                {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
              </Typography>
            )}
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                font: '400 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
                color: pollColor,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <Box
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: '4px',
                  bgcolor: isStale ? solar.status.warn : solar.status.ok,
                  '@keyframes omPulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
                  animation: 'omPulse 3.2s ease-in-out infinite',
                  '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
                }}
              />
              {pollText}
            </Box>
            <ThemeToggle />
            {topRight}
          </Box>
          </Box>
        </Box>

        <Box
          sx={{
            p: mobile ? 4 : 6,
            pb: mobile ? `${solar.dims.tabbar + 16}px` : 6,
            maxWidth: 1368,
            width: '100%',
            mx: 'auto',
          }}
        >
          {children}
        </Box>
      </Box>

      {mobile && (
        <Box
          sx={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            height: `calc(${solar.dims.tabbar}px + env(safe-area-inset-bottom))`,
            pt: '11px',
            bgcolor: solar.surface.rail,
            borderTop: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'flex-start',
            zIndex: 10,
          }}
        >
          {NAV.map((item) => (
            <NavItem
              key={item.to}
              {...item}
              bottom
              badge={item.to === '/system' ? alertCount : undefined}
            />
          ))}
          <NavItem to="/settings" label="More" icon={<GearIcon />} bottom />
        </Box>
      )}
    </Box>
  );
}
