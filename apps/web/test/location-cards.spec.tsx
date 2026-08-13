import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { HomeSettings } from '../src/api';

/*
  The two places a location gets typed, and the relationship between them.

  Worth rendering rather than only unit-testing, because the bug that prompted all of this
  was a display one in the end: the app held a perfectly valid coordinate for the Gulf of
  Guinea and every screen carried on as though it were fine. What the owner needed was for
  something, somewhere, to say the location was not set.
*/

const fetchSiteLocation = vi.fn();
const saveSiteLocation = vi.fn();
const fetchHome = vi.fn();
const saveHome = vi.fn();
const followSiteAtHome = vi.fn();

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    fetchSiteLocation: (...args: unknown[]) => fetchSiteLocation(...args),
    saveSiteLocation: (...args: unknown[]) => saveSiteLocation(...args),
    fetchHome: (...args: unknown[]) => fetchHome(...args),
    saveHome: (...args: unknown[]) => saveHome(...args),
    followSiteAtHome: (...args: unknown[]) => followSiteAtHome(...args),
  };
});

const { SiteLocationCard } = await import('../src/components/SiteLocationCard');
const { HomeLocationCard } = await import('../src/components/HomeLocationCard');

/** Parliament Hill — a public landmark, so no fixture here is anybody's driveway. */
const SITE = { latitude: 45.4236, longitude: -75.7 };

const homeSettings = (over: Partial<HomeSettings> = {}): HomeSettings => ({
  home: null,
  mode: 'site',
  site: null,
  carPosition: null,
  defaultRadiusM: 100,
  ...over,
});

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  fetchSiteLocation.mockResolvedValue({ location: null });
  saveSiteLocation.mockResolvedValue({ ok: true });
  fetchHome.mockResolvedValue(homeSettings());
  saveHome.mockResolvedValue({ ok: true });
  followSiteAtHome.mockResolvedValue({ ok: true });
});

describe('SiteLocationCard', () => {
  it('names what is switched off while it is unset', async () => {
    /*
      The failure this whole change exists to prevent was silent. An install with no location
      has five features quietly disabled and nothing anywhere saying so — which is how one
      ran for months on a coordinate in the Atlantic.
    */
    draw(<SiteLocationCard />);
    expect(await screen.findByText(/not set/i)).toBeTruthy();
    const notice = await screen.findByText(/forecast, daylight hours, expected output/i);
    expect(notice.textContent).toMatch(/radar/i);
  });

  it('shows the location once there is one', async () => {
    fetchSiteLocation.mockResolvedValue({ location: SITE });
    draw(<SiteLocationCard />);
    expect(await screen.findByText('45.4236, -75.7000')).toBeTruthy();
    expect(screen.queryByText(/are all off/i)).toBeNull();
  });

  it('sends what was typed', async () => {
    draw(<SiteLocationCard />);
    fireEvent.change(await screen.findByLabelText('Latitude'), { target: { value: '45.4236' } });
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '-75.7' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveSiteLocation).toHaveBeenCalledWith(SITE));
  });

  it('offers the coordinates the car already has, which is every upgrading install', async () => {
    /*
      Home was typed in months ago because the Car page needed it; the site, which drives far
      more, was never asked for. The right coordinates are already in the database under the
      other key — copying them is one button rather than a trip to a map.
    */
    fetchHome.mockResolvedValue(
      homeSettings({ mode: 'manual', home: { ...SITE, radiusM: 100 } }),
    );
    draw(<SiteLocationCard />);
    fireEvent.click(await screen.findByRole('button', { name: /use the car’s home/i }));
    expect(screen.getByLabelText('Latitude').getAttribute('value')).toBe('45.4236');
    expect(screen.getByLabelText('Longitude').getAttribute('value')).toBe('-75.7');
  });

  it('does not offer to copy a home that is already reading this setting', async () => {
    // In `site` mode home holds no coordinates of its own — copying it back would be a loop.
    fetchHome.mockResolvedValue(
      homeSettings({ mode: 'site', site: SITE, home: { ...SITE, radiusM: 100 } }),
    );
    draw(<SiteLocationCard />);
    await screen.findByLabelText('Latitude');
    expect(screen.queryByRole('button', { name: /use the car’s home/i })).toBeNull();
  });

  it('offers the car only when the car has reported a position', async () => {
    draw(<SiteLocationCard />);
    await screen.findByLabelText('Latitude');
    expect(screen.queryByRole('button', { name: /use the car/i })).toBeNull();

    fetchHome.mockResolvedValue(
      homeSettings({ carPosition: { ...SITE, at: new Date().toISOString() } }),
    );
    draw(<SiteLocationCard />);
    expect(await screen.findByRole('button', { name: /use the car/i })).toBeTruthy();
  });
});

describe('HomeLocationCard', () => {
  it('follows the site by default, and says which place that is', async () => {
    fetchHome.mockResolvedValue(
      homeSettings({ site: SITE, home: { ...SITE, radiusM: 100 }, mode: 'site' }),
    );
    draw(<HomeLocationCard />);
    expect(await screen.findByText(/same place as the panels/i)).toBeTruthy();
    expect(screen.getByText('45.4236, -75.7000')).toBeTruthy();
    expect(screen.getByText(/same as site · 100 m/)).toBeTruthy();
  });

  it('hides the coordinate fields while following, so there is one place to edit', async () => {
    // Two editable copies of one fact is exactly what let them drift apart.
    fetchHome.mockResolvedValue(homeSettings({ site: SITE, mode: 'site' }));
    draw(<HomeLocationCard />);
    await screen.findByText(/same place as the panels/i);
    expect(screen.queryByLabelText('Latitude')).toBeNull();
    // The radius is the car's own in either mode — it is about GPS drift, not about where.
    expect(screen.getByLabelText('Radius (m)')).toBeTruthy();
  });

  it('points at the site card when following something that is not set', async () => {
    fetchHome.mockResolvedValue(homeSettings({ site: null, mode: 'site' }));
    draw(<HomeLocationCard />);
    const link = await screen.findByRole('link', { name: /set where the panels are/i });
    expect(link.getAttribute('href')).toBe('/settings/hardware');
  });

  it('saves a follow without sending coordinates', async () => {
    /*
      Sending both would raise the question of which wins, and any answer to that is a way
      for the two to disagree later.
    */
    fetchHome.mockResolvedValue(homeSettings({ site: SITE, mode: 'site' }));
    draw(<HomeLocationCard />);
    await screen.findByText(/same place as the panels/i);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(followSiteAtHome).toHaveBeenCalledWith(100));
    expect(saveHome).not.toHaveBeenCalled();
  });

  it('reveals the fields when a different place is chosen, seeded from the site', async () => {
    fetchHome.mockResolvedValue(homeSettings({ site: SITE, mode: 'site' }));
    draw(<HomeLocationCard />);
    await screen.findByText(/a different place/i);
    fireEvent.click(screen.getByRole('radio', { name: /a different place/i }));
    // Seeded rather than blank: switching almost always means nudging, not starting over.
    expect((await screen.findByLabelText('Latitude')).getAttribute('value')).toBe('45.4236');
  });

  it('leaves an install that already typed coordinates on manual', async () => {
    // These were set before there was a site to follow; repointing them silently is not an
    // upgrade, and would turn a working "at home" into "unknown" wherever no site is set.
    fetchHome.mockResolvedValue(
      homeSettings({ mode: 'manual', home: { ...SITE, radiusM: 150 }, site: null }),
    );
    draw(<HomeLocationCard />);
    expect(await screen.findByLabelText('Latitude')).toBeTruthy();
    expect(screen.getByText(/set · 150 m/)).toBeTruthy();
  });
});
