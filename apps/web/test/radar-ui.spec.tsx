import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { RadarStatus } from '../src/api';

/*
  The picture of the sky, and the switch that lets this machine go and get it.

  The rule that shapes both: this is the only thing in the app that sends anything about the
  house outward without being an upload the owner chose. So it is off until asked for, the
  card says what turning it on means before it is flipped, and the panel is absent rather
  than empty while it stays off.
*/

const fetchRadarStatus = vi.fn();
const setRadarEnabled = vi.fn();
const fetchSiteLocation = vi.fn();
const fetchRadarGeography = vi.fn();

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    fetchRadarStatus: (...a: unknown[]) => fetchRadarStatus(...a),
    setRadarEnabled: (...a: unknown[]) => setRadarEnabled(...a),
    fetchSiteLocation: (...a: unknown[]) => fetchSiteLocation(...a),
    fetchRadarGeography: (...a: unknown[]) => fetchRadarGeography(...a),
  };
});

const { RadarPanel } = await import('../src/components/RadarPanel');
const { RadarCard } = await import('../src/components/RadarCard');

const status = (over: Partial<RadarStatus> = {}): RadarStatus => ({
  enabled: false,
  source: 'eccc',
  updatedAt: null,
  error: null,
  ...over,
});

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  fetchRadarStatus.mockResolvedValue(status());
  fetchSiteLocation.mockResolvedValue({ location: null });
  fetchRadarGeography.mockResolvedValue({ lines: [] });
  setRadarEnabled.mockImplementation((on: boolean) => Promise.resolve(status({ enabled: on })));
});

describe('RadarPanel', () => {
  it('renders nothing at all while it is off', async () => {
    /*
      Absent, not an empty box explaining an absent feature. Trends already carries six
      charts; a seventh panel saying "not enabled" is noise on every visit forever.
    */
    const { container } = draw(<RadarPanel />);
    await waitFor(() => expect(fetchRadarStatus).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('shows the picture, and names who it came from', async () => {
    fetchRadarStatus.mockResolvedValue(status({ enabled: true, source: 'eccc' }));
    draw(<RadarPanel />);
    const image = await screen.findByRole('img');
    expect(image.getAttribute('src')).toMatch(/^\/api\/radar\/image\.png\?t=\d+$/);
    expect(await screen.findByText(/Environment and Climate Change Canada/)).toBeTruthy();
  });

  it('says what an empty square means, because most of the time it is empty', async () => {
    /*
      The composites are transparent, so a clear sky is a blank box — which looks exactly
      like a component that failed to load. Verified against the live ECCC source: a clear
      afternoon returns a valid 512×512 PNG of 1096 bytes with nothing drawn in it.
    */
    fetchRadarStatus.mockResolvedValue(status({ enabled: true, source: 'eccc' }));
    draw(<RadarPanel />);
    expect(await screen.findByText(/An empty square means nothing is falling/)).toBeTruthy();
  });

  it('says why rather than drawing a broken image when the far end failed', async () => {
    // The source being down is not this install's fault and not something to present as one.
    fetchRadarStatus.mockResolvedValue(
      status({ enabled: true, error: 'No recent radar frame published.' }),
    );
    draw(<RadarPanel />);
    expect(await screen.findByText(/No recent radar frame published/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('points at the site card when there is nowhere to centre on', async () => {
    fetchRadarStatus.mockResolvedValue(status({ enabled: true, source: null }));
    draw(<RadarPanel />);
    const link = await screen.findByRole('link', { name: /set where the panels are/i });
    expect(link.getAttribute('href')).toBe('/settings/hardware');
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('RadarCard', () => {
  it('is off, and says what switching it on would do before it is switched', async () => {
    draw(<RadarCard />);
    expect(await screen.findByText('off')).toBeTruthy();
    const explanation = await screen.findByText(/lets this machine ask/i);
    expect(explanation.textContent).toMatch(/Environment and Climate Change Canada/);
    // The point of fetching server-side, said where the decision is made.
    expect(explanation.textContent).toMatch(/browser never talks to them directly/i);
  });

  it('switches on', async () => {
    draw(<RadarCard />);
    fireEvent.click(await screen.findByRole('switch', { name: /show weather radar/i }));
    await waitFor(() => expect(setRadarEnabled).toHaveBeenCalledWith(true));
    expect(await screen.findByText('on')).toBeTruthy();
  });

  it('cannot be switched on without a location, and says so', async () => {
    // Enabling it would make a request that cannot succeed — there is nowhere to centre.
    fetchRadarStatus.mockResolvedValue(status({ source: null }));
    draw(<RadarCard />);
    const toggle = await screen.findByRole('switch', { name: /show weather radar/i });
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/needs a site location first/i)).toBeTruthy();
  });

  it('names the global source outside Canada', async () => {
    // The repository is public; most people cloning it are not in Canada.
    fetchRadarStatus.mockResolvedValue(status({ source: 'rainviewer' }));
    draw(<RadarCard />);
    expect(await screen.findByText(/RainViewer/)).toBeTruthy();
  });
});

describe('the ground under the weather', () => {
  const enabled = () => {
    fetchRadarStatus.mockResolvedValue(status({ enabled: true, source: 'eccc' }));
    fetchSiteLocation.mockResolvedValue({ location: { latitude: 46.109093, longitude: -64.737333 } });
  };

  it('draws the coastline it was given', async () => {
    /*
      The complaint that prompted this: rain floating in an empty square. Precipitation with
      no land under it cannot tell you whether a cell is overhead or over the next county,
      which makes the panel decoration rather than information.
    */
    enabled();
    fetchRadarGeography.mockResolvedValue({
      lines: [{ kind: 'coast', points: [0.1, 0.2, 0.3, 0.4] }],
    });
    const { container } = draw(<RadarPanel />);
    await waitFor(() => expect(container.querySelectorAll('polyline').length).toBe(1));
    expect(container.querySelector('polyline')?.getAttribute('points')).toBe('10.00,20.00 30.00,40.00');
  });

  it('puts the land behind the rain, not over it', async () => {
    // The composite is a transparent PNG, so geography drawn behind shows through and the
    // rain stays the brightest thing. On top it would put hairlines across every cell.
    enabled();
    fetchRadarGeography.mockResolvedValue({
      lines: [{ kind: 'coast', points: [0.1, 0.2, 0.3, 0.4] }],
    });
    const { container } = draw(<RadarPanel />);
    const image = await screen.findByRole('img');
    await waitFor(() => expect(container.querySelector('polyline')).toBeTruthy());
    const land = container.querySelector('polyline')!.closest('svg')!;
    // Earlier in document order means painted first, which means underneath.
    expect(land.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('still draws the picture when there is no geography for the area', async () => {
    // Mid-ocean, or a failed fetch. Rain on a blank square is worse than rain on a
    // coastline, but it is not nothing.
    enabled();
    fetchRadarGeography.mockRejectedValue(new Error('nope'));
    draw(<RadarPanel />);
    expect(await screen.findByRole('img')).toBeTruthy();
  });

  it('says when the frame is from', async () => {
    // It carried no time at all, and a radar picture without one is unreadable even when it
    // is perfect — an arriving cell looks identical to one that left an hour ago.
    fetchRadarStatus.mockResolvedValue(
      status({ enabled: true, source: 'eccc', updatedAt: '2026-08-06T11:35:00.000Z' }),
    );
    fetchSiteLocation.mockResolvedValue({ location: { latitude: 46.1, longitude: -64.7 } });
    draw(<RadarPanel />);
    expect(await screen.findByText(/^as of/i)).toBeTruthy();
  });

  it('keys the colours without inventing rainfall rates', async () => {
    // The palette belongs to the source and this app does not know its breakpoints; naming
    // mm/h would be precision nobody measured.
    enabled();
    draw(<RadarPanel />);
    expect(await screen.findByText('light')).toBeTruthy();
    expect(screen.getByText('heavy')).toBeTruthy();
  });
});

describe('the frame of reference the composite does not come with', () => {
  it('draws rings as ellipses, because the projection is stretched', async () => {
    /*
      The bounding box is square in degrees and the image is square in pixels, so away from
      the equator the picture is wider than it is tall on the ground: at 46°N the same pixel
      distance is about 116 km across and 167 km up. A circle labelled "100 km" would be
      wrong by nearly half in one axis, and wrong in the worst way — it would look
      authoritative. So the ratio of the radii has to be 1/cos(latitude).
    */
    fetchRadarStatus.mockResolvedValue(status({ enabled: true, source: 'eccc' }));
    fetchSiteLocation.mockResolvedValue({ location: { latitude: 46.109093, longitude: -64.737333 } });
    const { container } = draw(<RadarPanel />);
    await waitFor(() => expect(container.querySelectorAll('ellipse').length).toBe(2));

    const [inner, outer] = [...container.querySelectorAll('ellipse')];
    const ratio = Number(outer.getAttribute('rx')) / Number(outer.getAttribute('ry'));
    expect(ratio).toBeCloseTo(1 / Math.cos((46.109093 * Math.PI) / 180), 3);
    // And the 50 km ring is half the 100 km one, in both axes.
    expect(Number(inner.getAttribute('rx'))).toBeCloseTo(Number(outer.getAttribute('rx')) / 2, 5);
    expect(Number(inner.getAttribute('ry'))).toBeCloseTo(Number(outer.getAttribute('ry')) / 2, 5);
  });

  it('keeps every ring inside the picture', async () => {
    // A ring drawn past the edge of the box is a distance that cannot be read off it.
    fetchRadarStatus.mockResolvedValue(status({ enabled: true, source: 'eccc' }));
    fetchSiteLocation.mockResolvedValue({ location: { latitude: 46.109093, longitude: -64.737333 } });
    const { container } = draw(<RadarPanel />);
    await waitFor(() => expect(container.querySelectorAll('ellipse').length).toBe(2));
    for (const ring of container.querySelectorAll('ellipse')) {
      expect(Number(ring.getAttribute('rx'))).toBeLessThan(50);
      expect(Number(ring.getAttribute('ry'))).toBeLessThan(50);
    }
  });

  it('says the rings are there, and what they measure', async () => {
    fetchRadarStatus.mockResolvedValue(status({ enabled: true, source: 'eccc' }));
    fetchSiteLocation.mockResolvedValue({ location: { latitude: 46.109093, longitude: -64.737333 } });
    draw(<RadarPanel />);
    expect(await screen.findByText(/Rings are 50 and 100 km/)).toBeTruthy();
  });

  it('draws no rings at all when the location is unknown', async () => {
    // Without a latitude the correction cannot be computed, and an uncorrected ring would
    // be a wrong number rather than a missing one.
    fetchRadarStatus.mockResolvedValue(status({ enabled: true, source: 'eccc' }));
    fetchSiteLocation.mockResolvedValue({ location: null });
    const { container } = draw(<RadarPanel />);
    await screen.findByRole('img');
    expect(container.querySelectorAll('ellipse').length).toBe(0);
  });
});
