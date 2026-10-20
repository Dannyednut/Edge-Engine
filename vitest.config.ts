import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/test/_integration/**'],
    testTimeout: 15000,
    // EM-STRAT-006 §2: install the offline guard BEFORE any test file runs.
    // The guard blocks all external network requests by default. Tests that
    // need to exercise scan() must register deterministic mocks via the
    // global `mockFetch` helper.
    setupFiles: ['./packages/scanner/test/_setup/offline-guard.ts'],
  },
});
