import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@core': path.resolve(here, 'dist'),
      '@prices': path.resolve(here, 'prices.json'),
    },
  },
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});
