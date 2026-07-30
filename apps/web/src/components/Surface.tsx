import { ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { SxProps } from '@mui/material/styles';
import { useFreshness } from '../shell/freshness';
import { solar } from '../theme';

interface SurfaceProps {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  hero?: boolean;
  sx?: SxProps;
}

/** Card surface; dims itself when data is stale (freshness is a context concern). */
export function Surface({ title, action, children, hero, sx }: SurfaceProps): ReactElement {
  const { isStale } = useFreshness();
  return (
    <Box
      sx={{
        background: hero ? `linear-gradient(180deg,${solar.surface.hero} 0%,#1b1917 62%)` : 'background.paper',
        bgcolor: hero ? undefined : 'background.paper',
        border: '1px solid',
        borderColor: hero ? '#35302a' : 'divider',
        borderRadius: hero ? '14px' : '12px',
        p: 5,
        opacity: isStale ? solar.stale.opacity : 1,
        transition: 'opacity .3s',
        position: 'relative',
        overflow: 'hidden',
        ...sx,
      }}
    >
      {(title || action) && (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 3 }}>
          {typeof title === 'string' ? (
            <Typography variant="overline" color="text.disabled">
              {title}
            </Typography>
          ) : (
            title
          )}
          {action}
        </Box>
      )}
      {children}
    </Box>
  );
}

interface MetricProps {
  value: string;
  unit?: string;
  variant?: 'metricHero' | 'metricLg' | 'metricMd';
  dim?: boolean;
}

export function Metric({ value, unit, variant = 'metricLg', dim }: MetricProps): ReactElement {
  const unitSize = variant === 'metricHero' ? 22 : variant === 'metricLg' ? 13 : 12;
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: variant === 'metricHero' ? 2 : 1 }}>
      <Typography variant={variant} sx={{ color: dim ? 'text.disabled' : '#f6f2ec', transition: 'color .3s' }}>
        {value}
      </Typography>
      {unit && (
        <Typography sx={{ fontSize: unitSize, fontWeight: 500, color: 'text.secondary' }}>{unit}</Typography>
      )}
    </Box>
  );
}
