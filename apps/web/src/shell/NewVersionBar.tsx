import { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { BuildInfo, fetchBuild, usePolling } from '../api';
import { isBundleStale } from './stale-bundle';
import { solar } from '../theme';

// Both injected by vite.config.ts at build time.
declare const __BUILD_COMMIT__: string | null;
declare const __DEV_BUILD__: boolean;

const POLL_MS = 60_000;

/**
 * "A new version is ready" — when this tab is running superseded code.
 *
 * A prompt, not an automatic reload: the Pi installs updates on a timer, and a self-reload
 * would land mid-form. Not dismissible either, since dismissing leaves old code running
 * while looking dealt with.
 */
export function NewVersionBar(): ReactElement | null {
  const { data: build } = usePolling<BuildInfo>(fetchBuild, POLL_MS);

  const stale = isBundleStale({
    bundleCommit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : null,
    serverCommit: build?.commit,
    dev: typeof __DEV_BUILD__ === 'boolean' ? __DEV_BUILD__ : false,
  });
  if (!stale) return null;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: 3,
        px: 5,
        py: '9px',
        bgcolor: solar.pill.warn.bg,
        borderBottom: `1px solid ${solar.pill.warn.border}`,
        color: solar.status.warn,
      }}
    >
      {/*
        No version number here. The bundle knows the commit it was built from and nothing
        else, so it cannot tell whether the version changed — and between releases it has
        not. The first draft read "Version 0.1.1 is installed — this page is still running
        the old one" while the old one was also 0.1.1, which invites the reader to conclude
        the banner is broken.
      */}
      <Typography sx={{ font: `600 12.5px/1.4 ${solar.font.sans}` }}>
        The dashboard has been updated — this page is still running the older build.
      </Typography>
      <Button
        size="small"
        variant="outlined"
        onClick={() => window.location.reload()}
        sx={{
          color: solar.status.warn,
          borderColor: solar.pill.warn.border,
          font: `600 12px/1 ${solar.font.sans}`,
          py: '4px',
          '&:hover': { borderColor: solar.status.warn, bgcolor: 'transparent' },
        }}
      >
        Reload
      </Button>
    </Box>
  );
}
