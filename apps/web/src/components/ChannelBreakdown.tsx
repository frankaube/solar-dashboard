import { ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { ChannelUsage, setDeviceChannels } from '../api';
import { solar } from '../theme';

/**
 * Per-circuit energy from a multi-channel meter.
 *
 * This is the appliance-level view the whole CT-clamp argument exists for: not "the
 * house used 40 kWh" but "mini splits 12, water heater 8, dryer 3". The API has
 * returned it since the channel work landed; nothing rendered it, so it may as well
 * not have existed.
 */

const WIRING = [
  { value: 1, label: '120 V — one hot leg', hint: 'Ordinary outlets and lighting' },
  { value: 2, label: '240 V — two hot legs', hint: 'Dryer, water heater, mini split, EV charger' },
  { value: 3, label: 'Three-phase', hint: 'Rare in homes' },
];

export function ChannelBreakdown({
  deviceId,
  channels,
  onSaved,
}: {
  deviceId: number;
  channels: ChannelUsage[];
  onSaved: () => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    channels.map((c) => ({
      channel: c.channel,
      label: c.label.startsWith('Circuit ') ? '' : c.label,
      voltageMultiplier: c.voltageMultiplier ?? 1,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await setDeviceChannels(
        deviceId,
        draft.map((d) => ({
          channel: d.channel,
          label: d.label.trim() || undefined,
          voltageMultiplier: d.voltageMultiplier,
        })),
      );
      setEditing(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 2, pl: 2 }}>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 560 }}>
          Name each circuit and say how it’s wired. A clamp on one leg of a 240 V circuit
          measures half the real power, so we double it — get this wrong and the figure is
          out by 2×.
        </Typography>
        {draft.map((d, i) => (
          <Box key={d.channel} sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
            <Typography variant="mono" sx={{ width: 28, color: solar.ink.dim }}>
              {d.channel}
            </Typography>
            <TextField
              size="small"
              placeholder={`Circuit ${d.channel}`}
              value={d.label}
              onChange={(e) => {
                const next = [...draft];
                next[i] = { ...d, label: e.target.value };
                setDraft(next);
              }}
              sx={{ flex: '1 1 160px' }}
            />
            <TextField
              size="small"
              select
              value={d.voltageMultiplier}
              onChange={(e) => {
                const next = [...draft];
                next[i] = { ...d, voltageMultiplier: Number(e.target.value) };
                setDraft(next);
              }}
              sx={{ width: 210 }}
            >
              {WIRING.map((w) => (
                <MenuItem key={w.value} value={w.value}>
                  <Box>
                    <Typography sx={{ font: `500 13px/1.3 ${solar.font.sans}` }}>{w.label}</Typography>
                    <Typography variant="caption" color="text.disabled">
                      {w.hint}
                    </Typography>
                  </Box>
                </MenuItem>
              ))}
            </TextField>
          </Box>
        ))}
        {error && (
          <Typography variant="caption" sx={{ color: solar.status.critical }}>
            {error}
          </Typography>
        )}
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button size="small" variant="contained" disabled={busy} onClick={() => void save()}>
            Save
          </Button>
          <Button size="small" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px', mt: 1, pl: 2 }}>
      {channels.map((c) => (
        <Box key={c.channel} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Typography sx={{ font: `500 12.5px/1.4 ${solar.font.sans}`, color: solar.ink.sec, flex: '0 0 150px' }}>
            {c.label}
          </Typography>
          {/* A share bar makes "which one is costing me" readable at a glance, which a
              column of numbers does not. */}
          <Box sx={{ flex: 1, maxWidth: 180, height: 6, borderRadius: '3px', bgcolor: solar.surface.inset, overflow: 'hidden' }}>
            <Box sx={{ width: `${Math.min(100, c.sharePct)}%`, height: 6, bgcolor: solar.series.production }} />
          </Box>
          <Typography variant="mono" sx={{ fontSize: 12.5, color: solar.ink.sec, width: 72, textAlign: 'right' }}>
            {c.energyKwh} kWh
          </Typography>
          <Typography variant="mono" sx={{ fontSize: 12, color: solar.ink.dim, width: 40, textAlign: 'right' }}>
            {c.sharePct}%
          </Typography>
          {/* Corrected readings say so. Presenting a doubled figure as if the meter
              reported it would hide the one setting most likely to be wrong. */}
          {c.voltageMultiplier && c.voltageMultiplier !== 1 && (
            <Tooltip
              title={`This circuit is wired across ${c.voltageMultiplier} hot legs, and the clamp only measures one — so the meter's reading is multiplied by ${c.voltageMultiplier}.`}
              arrow
            >
              <Typography
                sx={{
                  font: `600 10px/1.3 ${solar.font.sans}`,
                  color: solar.accent.link,
                  cursor: 'help',
                  whiteSpace: 'nowrap',
                }}
              >
                ×{c.voltageMultiplier}
              </Typography>
            </Tooltip>
          )}
        </Box>
      ))}
      <Button
        size="small"
        onClick={() => setEditing(true)}
        sx={{ alignSelf: 'flex-start', mt: '2px', font: `600 12px/1 ${solar.font.sans}` }}
      >
        Name circuits &amp; set wiring
      </Button>
    </Box>
  );
}
