import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom doesn't scroll; the router resets the scroll position after every navigation.
window.scrollTo = () => {};

// Vitest runs without globals, so Testing Library can't register its own cleanup.
afterEach(() => {
  cleanup();
  // The Budget screen remembers collapsed groups in localStorage.
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
