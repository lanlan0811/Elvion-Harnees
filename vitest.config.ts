import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/setup.ts'],
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx', 'tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    exclude: ['**/node_modules/**', 'dist/**', 'research/**'],
  },
});
