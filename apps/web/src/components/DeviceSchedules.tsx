import { ReactElement, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  DeviceSchedule,
  HomeDevice,
  addSchedule,
  fetchSchedules,
  removeSchedule,
} from '../api';
import { solar } from '../theme';

interface DeviceSchedulesProps {
  device: HomeDevice;
}

function describe(schedule: DeviceSchedule): string {
  const when =
    schedule.trigger === 'time'
      ? `at ${schedule.timeOfDay}`
      : `at ${schedule.trigger}${schedule.offsetMin ? ` ${schedule.offsetMin > 0 ? '+' : ''}${schedule.offsetMin} min` : ''}`;
  const what =
    schedule.action === 'setTarget'
      ? `set ${schedule.value}°`
      : `turn ${schedule.action}`;
  return `${what} ${when}`;
}

/** Compact schedule editor shown under a device on the Devices page. */
export function DeviceSchedules({ device }: DeviceSchedulesProps): ReactElement {
  const [schedules, setSchedules] = useState<DeviceSchedule[]>([]);
  const [adding, setAdding] = useState(false);
  const [action, setAction] = useState('on');
  const [trigger, setTrigger] = useState('sunset');
  const [time, setTime] = useState('18:00');
  const [value, setValue] = useState('20');

  const isThermostat = device.capabilities.includes('setTargetTemperature');

  const load = (): void => {
    void fetchSchedules(device.id).then(setSchedules);
  };
  useEffect(load, [device.id]);

  const save = async (): Promise<void> => {
    await addSchedule(device.id, {
      action,
      trigger,
      timeOfDay: trigger === 'time' ? time : undefined,
      value: action === 'setTarget' ? Number(value) : undefined,
    });
    setAdding(false);
    load();
  };

  return (
    <Box sx={{ mt: 2, pl: 5 }}>
      {schedules.map((schedule) => (
        <Box key={schedule.id} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Typography sx={{ color: solar.ink.dim }}>⏱</Typography>
          <Typography variant="caption" sx={{ flex: 1 }}>
            {describe(schedule)}
          </Typography>
          <IconButton
            size="small"
            onClick={() => void removeSchedule(schedule.id).then(load)}
            sx={{ color: 'text.disabled', fontSize: 14 }}
          >
            ✕
          </IconButton>
        </Box>
      ))}

      {adding ? (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1, flexWrap: 'wrap' }}>
          <TextField select size="small" value={action} onChange={(e) => setAction(e.target.value)} sx={{ width: 110 }}>
            <MenuItem value="on">Turn on</MenuItem>
            <MenuItem value="off">Turn off</MenuItem>
            {isThermostat && <MenuItem value="setTarget">Set temp</MenuItem>}
          </TextField>
          {action === 'setTarget' && (
            <TextField size="small" type="number" value={value} onChange={(e) => setValue(e.target.value)} sx={{ width: 70 }} />
          )}
          <TextField select size="small" value={trigger} onChange={(e) => setTrigger(e.target.value)} sx={{ width: 110 }}>
            <MenuItem value="sunrise">Sunrise</MenuItem>
            <MenuItem value="sunset">Sunset</MenuItem>
            <MenuItem value="time">Clock time</MenuItem>
          </TextField>
          {trigger === 'time' && (
            <TextField size="small" type="time" value={time} onChange={(e) => setTime(e.target.value)} sx={{ width: 120 }} />
          )}
          <Button size="small" variant="contained" onClick={() => void save()}>
            Add
          </Button>
          <Button size="small" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </Box>
      ) : (
        !device.critical && (
          <Button size="small" onClick={() => setAdding(true)} sx={{ color: 'text.disabled', mt: 0.5 }}>
            + schedule
          </Button>
        )
      )}
    </Box>
  );
}
