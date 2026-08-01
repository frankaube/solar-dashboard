import { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { demoHouse, isDemoMode, setDemoHouse, setDemoMode } from '../api';
import { solar } from '../theme';

/**
 * Describe the house actually being shown.
 *
 * The banner used to promise "~2 years incl. a home battery" unconditionally, which
 * stopped being true the moment demo mode could show a house without one — a banner
 * that describes a battery next to a picture captioned "battery not installed" is
 * worse than no banner.
 */
function describeHouse(): string {
  const encoded = demoHouse();
  if (!encoded) return 'sample data, ~2 years incl. a home battery';
  try {
    const spec = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))) as {
      label?: string;
      solar?: { panelCount: number; panelWatts: number } | null;
      battery?: { capacityKwh: number } | null;
    };
    const parts: string[] = [];
    if (spec.solar) {
      parts.push(`${((spec.solar.panelCount * spec.solar.panelWatts) / 1000).toFixed(1)} kW`);
    } else {
      parts.push('no solar');
    }
    if (spec.battery) parts.push(`${spec.battery.capacityKwh} kWh battery`);
    return `your house — ${parts.join(', ')}`;
  } catch {
    // Corrupt localStorage should not blank the banner that explains the data.
    return 'sample data';
  }
}

/** Sticky banner shown whenever the app is displaying generated demo data. */
export function DemoBanner(): ReactElement | null {
  if (!isDemoMode()) return null;
  const custom = demoHouse() !== null;
  return (
    <Box
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        bgcolor: solar.series.financial,
        color: '#0e0d0b',
        px: 4,
        py: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        font: '600 12px/1 ui-monospace,Menlo,monospace',
      }}
    >
      <Typography sx={{ font: 'inherit' }}>
        DEMO MODE — {describeHouse()}. Your real data is untouched.
      </Typography>
      {/*
        A way back to the builder, not just out of demo mode. Someone looking at a
        house they configured is one click from wanting to change it, and hunting for
        the URL again is the point at which they stop exploring.
      */}
      <Button
        size="small"
        href="/builder"
        sx={{ color: '#0e0d0b', textDecoration: 'underline', minHeight: 0, py: 0 }}
      >
        {custom ? 'Edit house' : 'Build a house'}
      </Button>
      <Button
        size="small"
        onClick={() => {
          setDemoMode(false);
          setDemoHouse(null);
          window.location.href = '/';
        }}
        sx={{ color: '#0e0d0b', textDecoration: 'underline', minHeight: 0, py: 0 }}
      >
        Exit demo
      </Button>
    </Box>
  );
}
