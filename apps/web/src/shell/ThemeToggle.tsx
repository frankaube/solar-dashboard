import { ReactElement } from 'react';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { useThemeMode } from './ThemeMode';
import { solar } from '../theme';

/**
 * Sun or moon — the mode you would get by pressing it, not the one you are in.
 *
 * Both readings are defensible and neither is guessable from an icon alone, which is why
 * the label spells it out rather than leaving it to be learned.
 */
export function ThemeToggle(): ReactElement {
  const { mode, toggle } = useThemeMode();
  const next = mode === 'dark' ? 'light' : 'dark';
  return (
    <Tooltip title={`Switch to ${next}`}>
      <IconButton
        onClick={toggle}
        aria-label={`Switch to ${next} theme`}
        size="small"
        sx={{ color: solar.ink.dim, '&:hover': { color: solar.ink.pri } }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round">
          {mode === 'dark' ? (
            // Currently dark → offer the sun.
            <>
              <circle cx="12" cy="12" r="4.2" />
              <path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M6.1 6.1L4.5 4.5M19.5 19.5l-1.6-1.6M17.9 6.1l1.6-1.6M4.5 19.5l1.6-1.6" />
            </>
          ) : (
            // Currently light → offer the moon.
            <path d="M20.5 14.5A8.6 8.6 0 019.5 3.5a8.6 8.6 0 1011 11z" />
          )}
        </svg>
      </IconButton>
    </Tooltip>
  );
}
