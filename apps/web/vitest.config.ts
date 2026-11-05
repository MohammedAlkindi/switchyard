import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const contextbillRoot = path.resolve(here, '../../packages/contextbill');

export default defineConfig({
  resolve: {
    alias: {
      '@core': path.resolve(contextbillRoot, 'dist'),
      '@prices': path.resolve(contextbillRoot, 'prices.json'),
      '@': here,
    },
  },
  test: {
    include: ['lib/__tests__/**/*.test.ts'],
  },
});
