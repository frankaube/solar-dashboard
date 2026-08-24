/**
 * Talking to the dashboard, and turning a failure to reach it into a sentence.
 *
 * This is the only part of the server that touches the network, and the only part that can
 * fail for reasons that are nobody's mistake — the Pi is rebooting, the laptop is on a
 * different network, the address in the config has a typo. Every one of those must arrive
 * at the model as plain words explaining what could not be reached, never as an empty
 * result. An assistant handed `{}` will answer the question anyway, from nothing.
 */

export const DEFAULT_PORT = 3001;
export const DEFAULT_TIMEOUT_MS = 10_000;

export class DashboardError extends Error {}

/**
 * Accept the address a person would actually type.
 *
 * "10.0.0.140", "10.0.0.140:3001", "http://solar.local:3001/" are all the same intent, and
 * a configuration that rejects two of the three for no reason is a configuration people
 * get wrong once and then distrust.
 */
export function normaliseBaseUrl(raw) {
  const text = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!text) throw new DashboardError('No dashboard address configured.');
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new DashboardError(`"${raw}" is not a usable address.`);
  }
  if (!url.port && !/^https:/i.test(withScheme)) url.port = String(DEFAULT_PORT);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * A GET client over the dashboard's REST API.
 *
 * Read-only by construction: there is no method here that sends anything but GET, so no
 * tool can acquire the ability to change something by passing a cleverer argument.
 */
export function createClient({ baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
  const base = normaliseBaseUrl(baseUrl);

  return {
    base,
    async get(path) {
      const url = `${base}${path}`;
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason =
          error?.name === 'TimeoutError' || error?.name === 'AbortError'
            ? `it did not answer within ${Math.round(timeoutMs / 1000)}s`
            : `the connection failed (${error?.cause?.code ?? error?.code ?? error?.message ?? 'no detail'})`;
        throw new DashboardError(
          `Could not reach the Solar Dashboard at ${base} — ${reason}. Check that it is running and that the configured address is right. No figures are available, so do not estimate any.`,
        );
      }
      if (!response.ok) {
        throw new DashboardError(
          `The Solar Dashboard answered ${response.status} for ${path}. This part of the system may not be configured on that install.`,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new DashboardError(
          `The Solar Dashboard returned something that is not JSON for ${path}. That usually means the address points at a different service.`,
        );
      }
    },
  };
}
