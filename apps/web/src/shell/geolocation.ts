import { useCallback, useState } from 'react';

/**
 * Asking the browser where it is.
 *
 * Setting the site otherwise means leaving the app, finding the roof on a map, and copying
 * six decimal places back by hand — and getting it wrong is silent, because a coordinate a
 * degree out still returns a perfectly good forecast for somewhere else.
 *
 * Never automatic. It fires on a click, the browser asks its own permission, and the answer
 * is dropped into a visible field rather than saved, so it can be checked before it counts.
 * That matters more here than in most apps: the browser doing the asking may not be in the
 * same building as the panels — a laptop configuring a Pi from the office would confidently
 * place the array at the office.
 *
 * Worth being straight that this is not local-only. A device with no GPS resolves position
 * through its vendor's network-location service, so the browser talks outward. This app
 * fetches radar server-side specifically to avoid that kind of call happening behind
 * somebody's back; the difference here is that it happens when asked, once, with a browser
 * permission prompt in front of it.
 */

export interface BrowserLocation {
  latitude: number;
  longitude: number;
  /** Metres. Wildly different between GPS and wifi trilateration, and worth showing. */
  accuracyM: number;
}

export interface GeolocationState {
  supported: boolean;
  busy: boolean;
  error: string | null;
  request: () => Promise<BrowserLocation | null>;
}

/** What went wrong, in words rather than a numeric code. */
function describe(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'The browser refused — allow location for this page, or type the coordinates.';
    case error.POSITION_UNAVAILABLE:
      return 'The browser could not work out where it is. Type the coordinates instead.';
    case error.TIMEOUT:
      return 'The browser took too long to answer. Try again, or type the coordinates.';
    default:
      return 'The browser could not provide a location. Type the coordinates instead.';
  }
}

export function useBrowserLocation(): GeolocationState {
  /*
    Checked for a callable method rather than for the key. `'geolocation' in navigator` is
    true whenever the property exists at all — including when it is present and undefined,
    which is what a locked-down or non-secure context can leave behind. That renders the
    button and then throws on the click, which is worse than never offering it.
  */
  const supported =
    typeof navigator !== 'undefined' &&
    typeof navigator.geolocation?.getCurrentPosition === 'function';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(async (): Promise<BrowserLocation | null> => {
    if (!supported) return null;
    setBusy(true);
    setError(null);
    try {
      return await new Promise<BrowserLocation | null>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (position) =>
            resolve({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracyM: position.coords.accuracy,
            }),
          (failure) => {
            setError(describe(failure));
            resolve(null);
          },
          // A roof does not move, so a cached fix from the last few minutes is as good as a
          // fresh one and much faster. The timeout exists because a denied-but-not-answered
          // prompt otherwise leaves the button spinning indefinitely.
          { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
        );
      });
    } finally {
      setBusy(false);
    }
  }, [supported]);

  return { supported, busy, error, request };
}
