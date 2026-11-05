import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // Every test spins up a real git repo on disk; give slow CI runners headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
