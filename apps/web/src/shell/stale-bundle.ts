/**
 * Is the JavaScript in this tab older than what the server is serving?
 *
 * A tab runs whatever bundle it loaded, indefinitely, and goes on polling — so a wall
 * dashboard left open through an overnight update looks healthy on superseded code.
 *
 * Apart from the component so the refusals can be tested: most of the work is declining to
 * fire, since the banner's one cure would not clear a false positive.
 */

export interface BundleFreshness {
  /** The commit this bundle was compiled from, or null outside a checkout. */
  bundleCommit: string | null;
  /** What the server says it is running. */
  serverCommit: string | null | undefined;
  /** True under `vite dev`. */
  dev: boolean;
}

export function isBundleStale({ bundleCommit, serverCommit, dev }: BundleFreshness): boolean {
  // Never in development: the dev bundle is compiled from the working tree and differs from
  // whatever the proxied API was built from by definition. HMR covers this.
  if (dev) return false;

  // Both sides must know what they are: an unstamped bundle or server yields no comparison,
  // and "unknown" must not be read as "different".
  if (!bundleCommit || !serverCommit) return false;

  return bundleCommit !== serverCommit;
}
