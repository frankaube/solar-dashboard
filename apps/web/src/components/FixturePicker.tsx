import { ReactElement, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { DemoFixtureInfo, Provenance, demoFixture, fetchFixtures, setDemoFixture } from '../api';
import { Surface } from '../components/Surface';
import { solar } from '../theme';

/**
 * Where a fixture's numbers came from.
 *
 * This is NOT surfaced as a badge on every row. In demo mode everything on screen is
 * sample data and the page banner already says so, so per-row provenance labels
 * implied a distinction a visitor has no reason to care about — and a warning colour
 * on "from published docs" made ordinary demo data look faintly broken.
 *
 * It is kept in the data and shown on the active fixture, because there is one
 * audience it genuinely matters to: anyone who might read this as "we tested against
 * real hardware." Only `captured` supports that claim. Keeping the citation one hover
 * away means the stronger claim is never made by accident, without cluttering the
 * common case.
 */
const PROVENANCE: Record<Provenance, string> = {
  captured: 'Recorded from a real device, so this is exactly what the adapter receives.',
  documented:
    'Built from the vendor’s published field names, with sample values. It shows the dashboard parses what the documentation describes — it has not been checked against physical hardware.',
  synthetic: 'Made up to exercise a code path. It does not represent any real device.',
};

function Row({
  selected,
  onClick,
  title,
  summary,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  summary: string;
}): ReactElement {
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      sx={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        p: '14px 16px',
        borderRadius: '10px',
        border: '1px solid',
        borderColor: selected ? solar.series.production : solar.surface.border,
        bgcolor: selected ? 'rgba(229,165,47,.07)' : 'transparent',
        cursor: 'pointer',
        transition: 'border-color .15s, background-color .15s',
        '&:hover': { borderColor: selected ? solar.series.production : solar.ink.dim },
      }}
    >
      <Typography
        sx={{ font: `600 14.5px/1.3 ${solar.font.sans}`, color: solar.ink.pri, mb: '5px' }}
      >
        {title}
      </Typography>
      {/* ink.sec, not ink.dim: this is the description, not a disabled control, and at
          12px dim it was the least readable text on the page. */}
      <Typography
        sx={{ font: `400 13px/1.5 ${solar.font.sans}`, color: solar.ink.sec, maxWidth: 620 }}
      >
        {summary}
      </Typography>
    </Box>
  );
}

/**
 * Demo mode as a showroom: stand the dashboard up against a recorded device instead
 * of the generated house. The payload runs through the production parser, so what is
 * shown is genuinely what the adapter would produce from that device.
 */
export function FixturePicker(): ReactElement | null {
  const [fixtures, setFixtures] = useState<DemoFixtureInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(demoFixture());

  useEffect(() => {
    fetchFixtures()
      .then(setFixtures)
      .catch(() => setFixtures([]));
  }, []);

  // Nothing to choose between: stay out of the way rather than render an empty card.
  if (!fixtures || fixtures.length === 0) return null;

  const choose = (id: string | null): void => {
    setDemoFixture(id);
    setSelected(id);
    // The whole page reads from the fixture, so re-poll everything rather than
    // patching one card and leaving the rest describing a different device.
    window.location.reload();
  };

  return (
    <Surface title="Preview a device">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 4, maxWidth: 620 }}>
        See the dashboard with someone else’s hardware. Each option is a sample payload
        run through the same adapter the real app uses.
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <Row
          selected={selected === null}
          onClick={() => choose(null)}
          title="Generated home battery"
          summary="The default demo — a simulated pack with two years of history"
        />
        {fixtures.map((f) => (
          <Row
            key={f.id}
            selected={selected === f.id}
            onClick={() => choose(f.id)}
            title={f.device}
            summary={f.summary}
          />
        ))}
      </Box>
    </Surface>
  );
}

/** Inline note shown on a page currently driven by a fixture. */
export function FixtureNote({
  fixture,
}: {
  fixture: { device: string; provenance: Provenance; source: string };
}): ReactElement {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexWrap: 'wrap',
        p: '10px 14px',
        borderRadius: '9px',
        border: '1px dashed',
        borderColor: solar.surface.border,
      }}
    >
      <Typography sx={{ font: `600 12.5px/1.4 ${solar.font.sans}`, color: solar.ink.sec }}>
        Sample data — previewing {fixture.device}
      </Typography>
      <Tooltip
        title={`${PROVENANCE[fixture.provenance]} ${fixture.source}`}
        enterTouchDelay={0}
        leaveTouchDelay={8000}
        arrow
      >
        <Box
          component="span"
          tabIndex={0}
          aria-label={`${PROVENANCE[fixture.provenance]} ${fixture.source}`}
          sx={{
            width: 15,
            height: 15,
            flex: '0 0 15px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '999px',
            border: '1px solid',
            borderColor: solar.surface.border,
            color: solar.ink.dim,
            font: `600 9.5px/1 ${solar.font.sans}`,
            cursor: 'help',
            transition: 'color .2s, border-color .2s',
            '&:hover, &:focus-visible': { color: solar.ink.pri, borderColor: solar.ink.dim },
          }}
        >
          i
        </Box>
      </Tooltip>
    </Box>
  );
}
