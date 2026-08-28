import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * One test command covers both workspaces.
 *
 * The core's tests need no configuration; the web tests do, because `web/`
 * reaches the analysis core through the same `@core/*` and `@prices` aliases
 * its `tsconfig.json` declares, and vitest running from the repository root
 * does not read that file. The three entries below mirror
 * `web/tsconfig.json` exactly. If they drift, the web tests resolve a
 * different module than the app does and stop testing the shipped code.
 *
 * `@core/*` points at `dist/`, not `src/`, for the reason recorded in
 * `web/CLAUDE.md`: the core is ESM and imports siblings as `./types.js`, which
 * the bundler cannot resolve to `.ts`. That is why `pretest` builds first.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@core': path.resolve(here, 'dist'),
      '@prices': path.resolve(here, 'prices.json'),
      '@': path.resolve(here, 'web'),
    },
  },
  test: {
    include: ['src/__tests__/**/*.test.ts', 'web/lib/__tests__/**/*.test.ts'],
  },
});
