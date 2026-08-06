import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * What every render test needs before it can render anything.
 *
 * `cleanup` after each test because jsdom's document persists across a file: without it the
 * second test in a file queries a DOM containing the first test's output, and a passing
 * assertion may be reading a component that is no longer mounted.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * jsdom implements neither of these, and MUI reaches for both.
 *
 * `matchMedia` is read by the theme's initial mode and by every responsive `sx` breakpoint;
 * `ResizeObserver` by anything that measures itself. Absent, the component throws before a
 * single assertion runs — which looks like a broken test rather than a missing stub.
 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
