import { ReactElement, useEffect, useState } from 'react';
import { TuyaKeyHelp } from './TuyaKeyHelp';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  HomeScanResult,
  ManualVendor,
  addDeviceManually,
  adoptHomeDevice,
  fetchCapabilities,
  fetchManualVendors,
  fetchSubnetSuggestions,
  scanHomeDevices,
} from '../api';
import { LoadEditor } from './LoadEditor';
import { solar } from '../theme';

/**
 * Adding a device, one question at a time.
 *
 * This replaces a permanent panel that carried 176 words of explanation — how discovery
 * works, why a container cannot hear broadcasts, which plugs meter and which do not, what
 * to do instead. Every sentence was true and each was written the moment its subtlety was
 * discovered, which is exactly how a page accumulates an essay nobody reads.
 *
 * The rule here: a sentence earns its place only where it changes the next click. So the
 * container-networking explanation appears when a scan finds nothing and never otherwise,
 * "this cannot measure watts" appears while you are choosing a type, and the rating prompt
 * appears immediately after adopting a device that needs one rather than as advice on a
 * page you were not reading.
 */

type Step = 'how' | 'scan' | 'address' | 'rating';

export function AddDeviceFlow({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}): ReactElement {
  const [step, setStep] = useState<Step>('how');
  const [vendors, setVendors] = useState<ManualVendor[] | null>(null);
  const [subnets, setSubnets] = useState<Array<{ subnet: string; reason: string }> | null>(null);
  const [blindReason, setBlindReason] = useState<string | null>(null);

  const [subnet, setSubnet] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<HomeScanResult | null>(null);

  const [vendorId, setVendorId] = useState('');
  const [host, setHost] = useState('');
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The device just added, when it needs a rating before it can cost anything. */
  const [added, setAdded] = useState<{ id: number; name: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    void fetchManualVendors()
      .then((list) => {
        setVendors(list);
        setVendorId((current) => current || list[0]?.id || '');
      })
      .catch(() => setVendors(null));
    void fetchSubnetSuggestions()
      .then((list) => {
        setSubnets(list);
        setSubnet((current) => current || list[0]?.subnet || '');
      })
      .catch(() => setSubnets(null));
    void fetchCapabilities()
      .then((caps) => setBlindReason(caps.discovery.blindReason))
      .catch(() => setBlindReason(null));
  }, [open]);

  const close = (): void => {
    setStep('how');
    setScan(null);
    setError(null);
    setAdded(null);
    setHost('');
    setCredential('');
    onClose();
  };

  const vendor = vendors?.find((v) => v.id === vendorId) ?? null;

  /** After anything is added: ask for a rating only if nothing will ever measure it. */
  const finishWith = (id: number, name: string, meters: boolean): void => {
    onChanged();
    if (meters) {
      close();
      return;
    }
    setAdded({ id, name });
    setStep('rating');
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
      <DialogContent sx={{ p: 3.5 }}>
        {step === 'how' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <Typography variant="answer">Add a device</Typography>
            <Button variant="contained" size="large" onClick={() => setStep('scan')}>
              Search my network
            </Button>
            <Button variant="outlined" size="large" onClick={() => setStep('address')}>
              I know its address
            </Button>
          </Box>
        )}

        {step === 'scan' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <Typography variant="answer">Which network?</Typography>
            <Box sx={{ display: 'flex', gap: 1.5 }}>
              <TextField
                size="small"
                label="Subnet"
                value={subnet}
                onChange={(event) => setSubnet(event.target.value)}
                sx={{ width: 160 }}
              />
              <Button
                variant="contained"
                disabled={scanning || !subnet.trim()}
                onClick={() => {
                  setScanning(true);
                  setError(null);
                  void scanHomeDevices(subnet.trim())
                    .then(setScan)
                    .catch((e: Error) => setError(e.message))
                    .finally(() => setScanning(false));
                }}
              >
                {scanning ? <CircularProgress size={18} /> : 'Search'}
              </Button>
            </Box>
            {subnets && subnets.length > 0 && !scan && (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {subnets.slice(0, 4).map((s) => (
                  <Chip
                    key={s.subnet}
                    size="small"
                    label={`${s.subnet}.x`}
                    title={s.reason}
                    onClick={() => setSubnet(s.subnet)}
                    variant={subnet === s.subnet ? 'filled' : 'outlined'}
                    sx={{ cursor: 'pointer' }}
                  />
                ))}
              </Box>
            )}

            {scan?.devices.map((found) => (
              <Box
                key={`${found.vendor}-${found.host}`}
                sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}
              >
                <Typography variant="body2" sx={{ flex: 1 }}>
                  {found.name}{' '}
                  <Typography component="span" variant="caption" color="text.disabled">
                    {found.model ?? found.vendor}
                  </Typography>
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={found.adopted || busy}
                  onClick={() => {
                    setBusy(true);
                    void adoptHomeDevice(found)
                      .then((device) => {
                        const meters = vendors?.find((v) => v.id === found.vendor)?.metersEnergy ?? true;
                        finishWith(device.id, found.name, meters);
                      })
                      .catch((e: Error) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  {found.adopted ? 'Already added' : 'Add'}
                </Button>
              </Box>
            ))}

            {/*
              The container-networking explanation, at the only moment it is useful: a
              search came back empty and the reason is not the network being empty. It used
              to sit permanently above the search box, where it was an essay you read once
              and then scrolled past forever.
            */}
            {scan && scan.devices.length === 0 && (
              <Box sx={{ borderLeft: '2px solid', borderColor: solar.status.warn, pl: 2 }}>
                <Typography variant="body2" sx={{ color: solar.status.warn }}>
                  Nothing found on {subnet}.0/24.
                </Typography>
                <Typography variant="caption" sx={{ color: solar.ink.sec, display: 'block', mt: 0.8 }}>
                  {blindReason
                    ? 'Some devices only announce themselves to their own network, and this app is running in a container that never hears them. Typing the address works.'
                    : `Looked for ${scan.lookedFor.join(', ')}. A device from another brand will not appear.`}
                </Typography>
                <Button size="small" sx={{ mt: 1, ml: -1 }} onClick={() => setStep('address')}>
                  Type an address instead
                </Button>
              </Box>
            )}
          </Box>
        )}

        {step === 'address' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <Typography variant="answer">What kind of device?</Typography>
            <TextField
              select
              size="small"
              value={vendorId}
              onChange={(event) => setVendorId(event.target.value)}
              sx={{ '& .MuiSelect-select': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
            >
              {(vendors ?? []).map((v) => (
                <MenuItem key={v.id} value={v.id}>
                  {v.name}
                </MenuItem>
              ))}
            </TextField>

            {/*
              Both caveats belong here, where a type is being chosen — they are inputs to
              that decision, not trivia about a device you already own.
            */}
            {vendor && !vendor.metersEnergy && (
              <Typography variant="caption" sx={{ color: solar.status.warn }}>
                No energy meter. It can be switched and watched, never measured.
              </Typography>
            )}

            <TextField
              size="small"
              label="Address"
              placeholder="10.0.0.115"
              value={host}
              onChange={(event) => setHost(event.target.value)}
            />
            {vendor?.credentialLabel && (
              <>
                <TextField
                  size="small"
                  label={`${vendor.credentialLabel} (optional)`}
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  helperText={vendor.note ?? undefined}
                />
                {/*
                  The procedure, folded away, next to the field that needs it. A key is
                  six steps on someone else's website, and "you need a local key" without
                  saying how to get one is the least useful possible amount of help.
                */}
                {vendorId === 'tuya' && <TuyaKeyHelp />}
              </>
            )}

            <Button
              variant="contained"
              disabled={busy || !host.trim() || !vendorId}
              onClick={() => {
                setBusy(true);
                setError(null);
                void addDeviceManually({
                  vendor: vendorId,
                  host: host.trim(),
                  credential: credential.trim() || undefined,
                })
                  .then((result) =>
                    finishWith(result.device.id, result.device.name, vendor?.metersEnergy ?? true),
                  )
                  .catch((e: Error) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? 'Checking…' : 'Add'}
            </Button>
          </Box>
        )}

        {step === 'rating' && added && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="answer">What does {added.name} run?</Typography>
            {/*
              Asked here rather than printed as advice on the page. This device cannot
              report watts, so this is the only way it will ever appear in a cost — and the
              moment just after adding it is the one moment someone is willing to answer.
            */}
            <Typography variant="caption" sx={{ color: solar.ink.sec }}>
              It can’t measure its own power. Tell us roughly what it draws and we’ll work out
              the cost from how long it runs.
            </Typography>
            <LoadEditor deviceId={added.id} current={{}} onSaved={onChanged} />
            <Button variant="text" onClick={close} sx={{ alignSelf: 'flex-start', ml: -1 }}>
              Skip for now
            </Button>
          </Box>
        )}

        {error && (
          <Typography variant="caption" sx={{ color: solar.status.critical, display: 'block', mt: 2 }}>
            {error}
          </Typography>
        )}

        {step !== 'how' && step !== 'rating' && (
          <Button variant="text" onClick={() => setStep('how')} sx={{ mt: 2.5, ml: -1 }}>
            Back
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
