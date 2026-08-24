import { ReactElement, useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { Census, fetchArrayContract, fetchCensus, saveArrayContract } from '../api';
import { Surface } from './Surface';
import { solar } from '../theme';

/**
 * Does the array agree with itself?
 *
 * The contract fields sit inside this card rather than on the settings page on purpose.
 * They are only ever worth filling in because of what is written directly above them —
 * asking for them somewhere else would be asking for homework with no visible reason.
 */

const TONE: Record<string, string> = {
  serious: solar.status.critical,
  warning: solar.status.warn,
  info: solar.ink.dim,
};

/**
 * @param showFindings false where the findings are already listed elsewhere. The Health
 *   page merges them into its single ranked issue list, and repeating all six here — with
 *   their paragraphs — is what made that page seven hundred words long.
 */
export function ArrayCensusCard({ showFindings = true }: { showFindings?: boolean } = {}): ReactElement | null {
  const [census, setCensus] = useState<Census | null>(null);
  const [panels, setPanels] = useState('');
  const [watts, setWatts] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void Promise.all([fetchCensus(), fetchArrayContract()])
      .then(([next, contract]) => {
        setCensus(next);
        setPanels(contract.panels ? String(contract.panels) : '');
        setWatts(contract.wattsPerPanel ? String(contract.wattsPerPanel) : '');
      })
      .catch(() => setCensus(null));
  }, []);

  useEffect(load, [load]);

  if (!census) return null;

  const claims = census.claims.filter((c) => c.panels !== null || c.ratedKw !== null);

  return (
    <Surface title="System check">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Several things claim to know how big this array is. When they disagree, one of them is
        wrong — and the figures on every other page are built on whichever one you configured.
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 3 }}>
        {claims.map((claim) => (
          <Box
            key={claim.source}
            sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}
          >
            <Typography variant="caption" color="text.secondary">
              {claim.source}
            </Typography>
            <Typography
              variant="caption"
              sx={{ color: solar.ink.pri, fontVariantNumeric: 'tabular-nums' }}
            >
              {[
                claim.panels !== null ? `${claim.panels} panels` : null,
                claim.ratedKw !== null ? `${claim.ratedKw} kW` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Typography>
          </Box>
        ))}
      </Box>

      {!showFindings ? null : census.findings.length === 0 ? (
        <Typography variant="body2" sx={{ color: solar.status.ok }}>
          Everything agrees.
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          {census.findings.map((finding) => (
            <Box
              key={finding.id}
              sx={{ borderLeft: '2px solid', borderColor: TONE[finding.severity], pl: 2 }}
            >
              <Typography variant="body2" sx={{ color: TONE[finding.severity] }}>
                {finding.headline}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                {finding.detail}
              </Typography>
            </Box>
          ))}
        </Box>
      )}

      <Box sx={{ mt: 4, pt: 3, borderTop: '1px solid', borderColor: 'divider' }}>
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 2 }}>
          {/*
            Stated plainly because it is the whole reason to bother typing this in: a
            gateway cannot report hardware nobody registered with it, so panels missing
            from its list are missing from its totals too. Only your paperwork sees them.
          */}
          What does your contract say? Your gateway can only count panels it was told about, so
          this is the one number that can reveal panels it has never heard of.
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <TextField
            size="small"
            label="Panels"
            value={panels}
            onChange={(event) => setPanels(event.target.value.replace(/[^\d]/g, ''))}
            sx={{ width: 110 }}
            slotProps={{ htmlInput: { inputMode: 'numeric' } }}
          />
          <TextField
            size="small"
            label="Watts each"
            value={watts}
            onChange={(event) => setWatts(event.target.value.replace(/[^\d]/g, ''))}
            sx={{ width: 130 }}
            slotProps={{ htmlInput: { inputMode: 'numeric' } }}
          />
          <Button
            variant="outlined"
            size="small"
            sx={{ mt: '4px' }}
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setError(null);
              void saveArrayContract(
                panels ? Number(panels) : null,
                watts ? Number(watts) : null,
              )
                .then((next) => setCensus(next))
                .catch((cause: Error) => setError(cause.message))
                .finally(() => setSaving(false));
            }}
          >
            {saving ? 'Checking…' : 'Check'}
          </Button>
          {panels && watts && (
            <Typography variant="caption" color="text.disabled" sx={{ mt: '10px' }}>
              = {((Number(panels) * Number(watts)) / 1000).toFixed(2)} kW
            </Typography>
          )}
          {error && (
            <Typography variant="caption" sx={{ color: solar.status.critical, mt: '10px' }}>
              {error}
            </Typography>
          )}
        </Box>
      </Box>
    </Surface>
  );
}
