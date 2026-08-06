import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Separate from vite.config.ts, which carries the dev server and its API proxy — neither of
 * which a test run should touch.
 *
 * `jsdom` rather than node, because the point of adding this was rendering. Eight web spec
 * files existed before it and every one tested a pure function: the bugs that actually
 * shipped this month were a reason printed twice, a card heading that counted rows instead
 * of outstanding work, and a title claiming "this year" over thirteen days. None of those
 * are reachable without a DOM, and all three were found by opening the page.
 */
export default defineConfig({
  plugins: [react()],
  define: {
    // vite.config.ts injects this for the real build; the stale-bundle check reads it.
    __DEV_BUILD__: 'false',
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['test/**/*.spec.ts', 'test/**/*.spec.tsx'],
    setupFiles: ['test/setup.ts'],
  },
});
