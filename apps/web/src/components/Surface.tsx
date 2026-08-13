import { useChanged, useCountUp, useEntranceDelay, usePrefersReducedMotion } from '../shell/motion';
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
  const reducedMotion = usePrefersReducedMotion();
  /*
    Cards arrive in sequence on a page load and alone at any other time — a panel opening or
    a tab switching mounts one card, and a delay there is lag rather than polish.
  */
  const enterDelay = useEntranceDelay(!reducedMotion);
  return (
    <Box
      sx={{
        background: hero
          ? `linear-gradient(180deg,${solar.surface.hero} 0%,${solar.surface.card} 62%)`
          : 'background.paper',
        bgcolor: hero ? undefined : 'background.paper',
        border: '1px solid',
        borderColor: hero ? solar.surface.borderStrong : 'divider',
        borderRadius: hero ? '14px' : '12px',
        p: 5,
        opacity: isStale ? solar.stale.opacity : 1,
        transition: 'opacity .3s',
        ...(reducedMotion
          ? {}
          : {
              /*
                Opacity and a few pixels, nothing that reflows. A card that grows into place
                pushes the ones below it, and on a page somebody is already reading that is
                worse than no animation at all.
              */
              animation: `surfaceEnter .34s ease-out ${enterDelay}ms both`,
              '@keyframes surfaceEnter': {
                from: { opacity: 0, transform: 'translateY(6px)' },
                to: { opacity: isStale ? solar.stale.opacity : 1, transform: 'none' },
              },
            }),
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

/**
 * A number, and a brief mark when it has just moved.
 *
 * This is a dashboard people leave open. Five minutes pass, a poll lands, four figures
 * change and the rest do not — and without something saying which, you have to have been
 * watching. The pulse answers "what just moved" for somebody who looked away.
 *
 * The value is never tweened. Counting from 2.1 kW to 3.4 kW draws every figure in between
 * and the array was at none of them: that is a five-minute gap with no samples in it, and
 * an app whose position is that it would rather show nothing than something false should
 * not animate its way through numbers it never measured. The number cuts; only the
 * highlight fades.
 */
export function Metric({ value, unit, variant = 'metricLg', dim }: MetricProps): ReactElement {
  const unitSize = variant === 'metricHero' ? 22 : variant === 'metricLg' ? 13 : 12;
  const reducedMotion = usePrefersReducedMotion();
  const justChanged = useChanged(value) && !reducedMotion;
  /*
    The travelling figure. Off under reduced motion, where the number simply cuts — which
    is also what it did before any of this, so nothing is lost.
  */
  const shown = useCountUp(value, !reducedMotion);
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: variant === 'metricHero' ? 2 : 1 }}>
      <Typography
        variant={variant}
        sx={{
          color: dim ? 'text.disabled' : solar.ink.pri,
          transition: 'color .3s',
          ...(justChanged
            ? {
                // Colour rather than movement: nothing reflows, so a changing figure cannot
                // shift the layout under a cursor or a finger.
                animation: 'metricChanged 1.4s ease-out',
                '@keyframes metricChanged': {
                  '0%': { color: solar.accent.link },
                  '100%': { color: dim ? undefined : solar.ink.pri },
                },
              }
            : {}),
        }}
      >
        {shown}
      </Typography>
      {unit && (
        <Typography sx={{ fontSize: unitSize, fontWeight: 500, color: 'text.secondary' }}>{unit}</Typography>
      )}
    </Box>
  );
}
