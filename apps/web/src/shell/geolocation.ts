import { useCallback, useState } from 'react';

/**
 * Asking the browser where it is.
 *
 * Never automatic: it fires on a click and the answer is dropped into a visible field
 * rather than saved, because the browser doing the asking may not be in the same building
 * as the panels — a laptop configuring a Pi from the office would place the array there.
 *
 * Not local-only. A device with no GPS resolves position through its vendor's
 * network-location service, so the browser talks outward.
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
  // Checked for a callable method, not the key: `'geolocation' in navigator` is true even
  // when the property is present and undefined, which a non-secure context can leave.
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
          // A roof does not move, so a cached fix is as good as a fresh one. The timeout is
          // for a denied-but-not-answered prompt, which otherwise never resolves.
          { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
        );
      });
    } finally {
      setBusy(false);
    }
  }, [supported]);

  return { supported, busy, error, request };
}
