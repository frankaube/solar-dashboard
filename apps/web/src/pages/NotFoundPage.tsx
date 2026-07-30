import { ReactElement } from 'react';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { Surface } from '../components/Surface';
import { solar } from '../theme';

/** Shown for any unmatched URL — previously these rendered a blank page titled "Overview". */
export function NotFoundPage(): ReactElement {
  const { pathname } = useLocation();
  return (
    <Surface sx={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Typography variant="answer" component="h2" sx={{ color: 'text.primary' }}>
        There's nothing at this address.
      </Typography>
      <Typography variant="body2" color="text.secondary">
        <Box component="code" sx={{ font: `400 12px/1.6 ${solar.font.mono}`, color: solar.ink.dim }}>
          {pathname}
        </Box>{' '}
        isn't a page in this dashboard. If you followed an old bookmark, the layout changed — try
        one of these.
      </Typography>
      <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {[
          { to: '/', label: 'Home' },
          { to: '/money/savings', label: 'Money' },
          { to: '/car', label: 'Car' },
          { to: '/system/roof', label: 'System' },
        ].map((item) => (
          <Link
            key={item.to}
            component={RouterLink}
            to={item.to}
            sx={{ font: `600 13px/1 ${solar.font.sans}`, color: solar.accent.link }}
          >
            {item.label} →
          </Link>
        ))}
      </Box>
    </Surface>
  );
}
