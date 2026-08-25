import { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import { solar } from '../theme';

/**
 * An explanation that waits to be asked for. The text is not cut, only moved: still one
 * gesture away, and still reaching a screen reader through `aria-label`.
 *
 * `enterTouchDelay={0}` because on a phone the tap IS the request and the default 700 ms
 * makes it feel broken; `leaveTouchDelay` is long so the text can be read, not glimpsed.
 */
export function Hint({ children }: { children: string }): ReactElement {
  return (
    <Tooltip title={children} enterTouchDelay={0} leaveTouchDelay={6000} arrow>
      <Box
        component="span"
        tabIndex={0}
        aria-label={children}
        sx={{
          ml: '5px',
          width: 14,
          height: 14,
          flex: '0 0 14px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '999px',
          border: '1px solid',
          borderColor: solar.surface.border,
          color: solar.ink.dim,
          font: `600 9px/1 ${solar.font.sans}`,
          cursor: 'help',
          verticalAlign: 'middle',
          transition: 'color .2s, border-color .2s',
          '&:hover, &:focus-visible': { color: solar.ink.pri, borderColor: solar.ink.dim },
        }}
      >
        i
      </Box>
    </Tooltip>
  );
}
