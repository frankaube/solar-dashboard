import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/*
  Asking where the panels are during setup.

  It was asked nowhere at all until now, and the consequence was not a blank field — the
  installer seeded the key empty, empty parsed as zero, and an install would run for months
  reporting a forecast for the Gulf of Guinea with nothing anywhere looking wrong. The scan
  can find a gateway, a charger and a dozen plugs; it cannot find a latitude. So this is the
  one question setup has to actually ask.
*/

const saveSiteLocation = vi.fn();
const saveConfig = vi.fn();
const saveNotifications = vi.fn();
const completeOnboarding = vi.fn();
const scanForDevices = vi.fn();
const scanHomeDevices = vi.fn();

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    fetchOnboarding: vi.fn().mockResolvedValue({ suggestedSubnet: '10.0.0', subnetSuggestions: [] }),
    scanForDevices: (...a: unknown[]) => scanForDevices(...a),
    scanHomeDevices: (...a: unknown[]) => scanHomeDevices(...a),
    saveDevices: vi.fn().mockResolvedValue(undefined),
    saveConfig: (...a: unknown[]) => saveConfig(...a),
    saveNotifications: (...a: unknown[]) => saveNotifications(...a),
    saveSiteLocation: (...a: unknown[]) => saveSiteLocation(...a),
    completeOnboarding: (...a: unknown[]) => completeOnboarding(...a),
  };
});

const { OnboardingPage } = await import('../src/pages/OnboardingPage');

/** Parliament Hill — a public landmark, so no fixture here is anybody's driveway. */
const SITE = { latitude: 45.4236, longitude: -75.7 };

/** Drive the wizard to its last screen, where the questions a scan cannot answer live. */
async function reachTheEnd(): Promise<void> {
  render(
    <MemoryRouter>
      <OnboardingPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /scan my network/i }));
  await screen.findByText(/where are the panels/i);
}

beforeEach(() => {
  vi.clearAllMocks();
  scanForDevices.mockResolvedValue({ dtus: [], chargers: [] });
  scanHomeDevices.mockResolvedValue({ devices: [] });
  saveSiteLocation.mockResolvedValue({ ok: true });
  saveConfig.mockResolvedValue(undefined);
  saveNotifications.mockResolvedValue(undefined);
  completeOnboarding.mockResolvedValue(undefined);
  vi.unstubAllGlobals();
});

describe('onboarding asks where the panels are', () => {
  it('asks, and says what stays off without it', async () => {
    await reachTheEnd();
    expect(screen.getByLabelText('Latitude')).toBeTruthy();
    expect(screen.getByLabelText('Longitude')).toBeTruthy();
    expect(screen.getByText(/those stay off/i)).toBeTruthy();
  });

  it('saves what was entered when setup finishes', async () => {
    await reachTheEnd();
    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '45.4236' } });
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '-75.7' } });
    fireEvent.click(screen.getByRole('button', { name: /finish setup/i }));
    await waitFor(() => expect(saveSiteLocation).toHaveBeenCalledWith(SITE));
  });

  it('finishes without one rather than trapping anyone on the last screen', async () => {
    /*
      Location turns features on; it is not needed to run. Someone who does not know their
      coordinates, or who refused the browser prompt, must still be able to complete setup —
      and it is correctable in Settings afterwards.
    */
    await reachTheEnd();
    fireEvent.click(screen.getByRole('button', { name: /finish setup/i }));
    await waitFor(() => expect(completeOnboarding).toHaveBeenCalled());
    expect(saveSiteLocation).not.toHaveBeenCalled();
  });

  it('still completes when the location save is rejected', async () => {
    // A typo'd coordinate is a reason to fix it later, not a reason to be stuck here.
    saveSiteLocation.mockRejectedValue(new Error('That is 0°, 0° in the Atlantic'));
    await reachTheEnd();
    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /finish setup/i }));
    await waitFor(() => expect(completeOnboarding).toHaveBeenCalled());
  });
});

describe('taking the location from the browser', () => {
  const stubGeolocation = (impl: Partial<Geolocation>): void => {
    vi.stubGlobal('navigator', { ...navigator, geolocation: impl });
  };

  it('fills the fields from the device, and says how good the fix was', async () => {
    /*
      Shown rather than saved straight off. The browser doing the asking may not be in the
      same building as the panels — a laptop configuring a Pi from the office would place the
      array at the office, confidently and silently.
    */
    stubGeolocation({
      getCurrentPosition: (onSuccess) =>
        onSuccess({
          coords: { latitude: 45.4236, longitude: -75.7, accuracy: 812 },
        } as GeolocationPosition),
    });
    await reachTheEnd();
    fireEvent.click(screen.getByRole('button', { name: /use this device/i }));
    await waitFor(() => expect(screen.getByLabelText('Latitude').getAttribute('value')).toBe('45.42360'));
    expect(screen.getByText(/about 812 m/)).toBeTruthy();
    expect(screen.getByText(/not at the house/i)).toBeTruthy();
  });

  it('explains a refusal instead of failing silently', async () => {
    stubGeolocation({
      getCurrentPosition: (_onSuccess, onError) =>
        onError?.({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError),
    });
    await reachTheEnd();
    fireEvent.click(screen.getByRole('button', { name: /use this device/i }));
    expect(await screen.findByText(/browser refused/i)).toBeTruthy();
    // And the manual route is still right there.
    expect(screen.getByLabelText('Latitude')).toBeTruthy();
  });

  it('offers no button at all where the browser has no geolocation', async () => {
    vi.stubGlobal('navigator', { ...navigator, geolocation: undefined });
    await reachTheEnd();
    expect(screen.queryByRole('button', { name: /use this device/i })).toBeNull();
  });
});
