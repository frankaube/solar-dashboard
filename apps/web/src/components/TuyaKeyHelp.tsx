import { ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { solar } from '../theme';

/**
 * How to get a Tuya local key, in the app rather than in a document nobody will find.
 *
 * Folded away by default. It is six steps on somebody else's website and it only matters
 * to people who own one of these plugs — put it on screen unconditionally and it becomes
 * the largest thing on the page for everyone who does not.
 *
 * Kept blunt about the cost. This is a developer account, an app-account link and a
 * project that expires, to control a switch that cannot measure anything. That is a fair
 * trade for some people and a waste of an evening for others, and they should be able to
 * tell which before starting.
 */

const STEPS: Array<{ title: string; detail: string }> = [
  {
    title: 'Create a Tuya IoT developer account',
    detail:
      'iot.tuya.com — separate from the Smart Life app account you already have. Free.',
  },
  {
    title: 'Create a Cloud project',
    detail:
      'Pick the data centre your app uses, not the one nearest you. Canada and the US are usually "Western America"; the wrong one lists no devices and gives no clue why.',
  },
  {
    title: 'Link your app account',
    detail:
      'In the project: Devices → Link App Account → Add App Account, then scan the QR with Smart Life (Me → the scan icon, top right).',
  },
  {
    title: 'Find the plug',
    detail: 'Devices → All Devices. Your plugs appear once the accounts are linked.',
  },
  {
    title: 'Copy the Device ID and Local Key',
    detail:
      'Both are on the device row. The local key is exactly 16 characters. If the column is hidden, API Explorer → Device Control → Get Device Details returns local_key.',
  },
  {
    title: 'Paste them here',
    detail: 'Then Test. The key is stored on this machine and never leaves it.',
  },
];

export function TuyaKeyHelp(): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <Box>
      <Button
        size="small"
        onClick={() => setOpen((was) => !was)}
        sx={{ pl: 0, font: `600 12.5px/1 ${solar.font.sans}` }}
      >
        {open ? 'Hide' : 'How do I get a local key?'}
      </Button>

      <Collapse in={open}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 2, maxWidth: 560 }}>
          <Typography variant="body2" color="text.secondary">
            Tuya encrypts local traffic with a key only its cloud will issue. There is no way
            to obtain it from the plug itself — which is why this is six steps on someone
            else's website.
          </Typography>

          {STEPS.map((step, index) => (
            <Box key={step.title} sx={{ display: 'flex', gap: 2 }}>
              <Typography
                variant="mono"
                sx={{ color: solar.ink.dim, fontSize: 12, mt: '2px', width: 16, flexShrink: 0 }}
              >
                {index + 1}
              </Typography>
              <Box>
                <Typography sx={{ font: `600 13px/1.4 ${solar.font.sans}`, color: solar.ink.pri }}>
                  {step.title}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {step.detail}
                </Typography>
              </Box>
            </Box>
          ))}

          <Typography variant="caption" color="text.disabled">
            Worth knowing before you start: the trial project expires after a month and needs
            a free extension, the key changes if you ever re-pair the plug, and this buys
            on/off only — these plugs do not measure power.{' '}
            <Link href="https://developer.tuya.com/en/docs/iot" target="_blank" rel="noreferrer">
              Tuya's own docs
            </Link>{' '}
            cover the console if a step has moved.
          </Typography>
        </Box>
      </Collapse>
    </Box>
  );
}
