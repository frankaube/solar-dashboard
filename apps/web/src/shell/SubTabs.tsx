import { ReactElement } from 'react';
import { NavLink } from 'react-router-dom';
import Box from '@mui/material/Box';
import { solar } from '../theme';

/** Underline tab bar for a hub page's sub-sections; each tab is its own URL. */
export function SubTabs({ items }: { items: Array<{ to: string; label: string }> }): ReactElement {
  return (
    <Box
      sx={{
        display: 'flex',
        gap: 1,
        borderBottom: '1px solid',
        borderColor: 'divider',
        overflowX: 'auto',
        // The active tab's underline uses mb:-1px to sit on the container's border, which
        // overflows the box by 1px. Setting only overflow-x makes the y axis compute to
        // `auto` (CSS spec), so that 1px raised a stray vertical scrollbar — pin it hidden.
        overflowY: 'hidden',
        scrollbarWidth: 'none', // the tab strip scrolls by swipe/drag; no bar needed
        '&::-webkit-scrollbar': { display: 'none' },
      }}
    >
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} style={{ textDecoration: 'none' }}>
          {({ isActive }) => (
            <Box
              sx={{
                px: 3,
                py: '9px',
                whiteSpace: 'nowrap',
                font: '600 12px/1 ui-monospace,Menlo,monospace',
                letterSpacing: '.05em',
                color: isActive ? solar.series.production : solar.ink.dim,
                borderBottom: '2px solid',
                borderColor: isActive ? solar.series.production : 'transparent',
                mb: '-1px',
                cursor: 'pointer',
                '&:hover': { color: isActive ? solar.series.production : solar.ink.sec },
              }}
            >
              {item.label.toUpperCase()}
            </Box>
          )}
        </NavLink>
      ))}
    </Box>
  );
}
