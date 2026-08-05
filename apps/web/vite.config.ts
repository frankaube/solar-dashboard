import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Stamp the bundle with the commit it was built from.
 *
 * A tab left open keeps running whatever JavaScript it loaded, forever. With automatic
 * updates wired up, the Pi can install a new version overnight and a dashboard on a wall
 * would go on showing the old interface silently — the numbers keep moving, so nothing
 * looks wrong. The shell compares this against what the server reports and offers a reload.
 *
 * null outside a checkout, and the comparison stays silent for it: a build that cannot say
 * what it is must not accuse the server of being different.
 */
const buildCommit = ((): string | null => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || null;
  } catch {
    return null;
  }
})();

/**
 * 3001 is the API running bare-metal; the Docker stack publishes it on 8080
 * instead, so this has to be overridable to develop the UI against a running
 * container rather than a second API process.
 */
const API_DEV_URL = process.env.API_DEV_URL ?? 'http://localhost:3001';

export default defineConfig(({ command }) => ({
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
    // `serve` is the dev server. The staleness check stays silent there — see
    // src/shell/stale-bundle.ts. Injected rather than read from import.meta.env because
    // this project does not pull in vite/client's ambient types.
    __DEV_BUILD__: JSON.stringify(command === 'serve'),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': API_DEV_URL,
    },
  },
  // `vite preview` serves the real production bundle, which is the only way to exercise
  // anything that behaves differently outside dev — the new-version banner, for one. It
  // needs the same proxy or every request 404s.
  preview: {
    proxy: {
      '/api': API_DEV_URL,
    },
  },
}));
