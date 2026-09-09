import { ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { solar } from '../theme';

/**
 * One row of the charge or drive ledger: when, how much, a bar for scale, and a tail.
 *
 * The bar carries magnitude, and on a charge its filled portion carries the solar share, so
 * a 52 kWh top-up and a 0.3 kWh trickle are not the same shape.
 */
export function LedgerRow({
  when,
  amount,
  /** 0–1 of the widest row in the list. */
  fraction,
  /** 0–1 of this row's own bar that was solar. Omit for a bar with no split. */
  solarFraction,
  tail,
}: {
  when: string;
  amount: string;
  fraction: number;
  solarFraction?: number;
  tail: ReactNode;
}): ReactElement {
  const width = Math.max(0, Math.min(1, fraction)) * 100;
  const sunWidth = width * Math.max(0, Math.min(1, solarFraction ?? 0));
  return (
    <Box
      sx={{
        display: 'grid',
        // The bar track is a fixed width and the tail takes the slack, not the other way
        // round: a full-scale length that changes per row encodes nothing, and the longest
        // bar would not be the largest charge.
        gridTemplateColumns: { xs: '92px 68px 1fr', sm: '104px 74px 132px minmax(0, 1fr)' },
        alignItems: 'center',
        gap: 3,
        py: '6px',
        borderBottom: `1px solid ${solar.surface.border}`,
        '&:last-of-type': { borderBottom: 0 },
      }}
    >
      <Typography variant="mono" sx={{ color: 'text.disabled' }}>
        {when}
      </Typography>
      <Typography variant="mono" sx={{ textAlign: 'right', color: 'text.primary' }}>
        {amount}
      </Typography>
      <Box sx={{ height: 7, borderRadius: '4px', bgcolor: solar.surface.inset, overflow: 'hidden', display: 'flex' }}>
        {sunWidth > 0 && (
          <Box sx={{ width: `${sunWidth}%`, bgcolor: solar.series.production, transition: 'width .3s' }} />
        )}
        <Box
          sx={{
            width: `${width - sunWidth}%`,
            bgcolor: solarFraction === undefined ? solar.series.expected : solar.series.car,
            transition: 'width .3s',
          }}
        />
      </Box>
      <Box sx={{ gridColumn: { xs: '1 / -1', sm: 'auto' }, minWidth: 0 }}>{tail}</Box>
    </Box>
  );
}
