/**
 * Is the JavaScript in this tab older than what the server is serving?
 *
 * A browser tab keeps running whatever bundle it loaded, indefinitely. Nothing in the app
 * noticed: the numbers went on refreshing every sixty seconds, so a tab left open through
 * an update looked perfectly healthy while running superseded code. With automatic updates
 * installing overnight, a dashboard on a wall could sit like that for weeks.
 *
 * Kept apart from the component so the refusals can be tested. Most of the work here is
 * declining to fire — a false "new version available" that never goes away is worse than
 * saying nothing, because the one cure the banner offers would not cure it.
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
  /*
    Never in development. The dev server serves a bundle compiled from the working tree,
    which routinely differs from whatever the API it proxies to was built from — and while
    developing against the Pi it differs by definition. HMR already handles this case, so
    the banner would be permanent decoration.
  */
  if (dev) return false;

  /*
    Both sides must know what they are. An unstamped bundle or an unstamped server yields
    no comparison, and "different" is not the honest reading of "unknown" — that is the
    same collapse of don't-know into a claim that put a car in a garage it was nowhere
    near.
  */
  if (!bundleCommit || !serverCommit) return false;

  return bundleCommit !== serverCommit;
}
