import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.{ts,tsx}', '**/*.test.{ts,tsx}'], exclude: ['node_modules/**', 'dist/**'], testTimeout: 15000, hookTimeout: 30000, pool: 'forks', maxWorkers: 4 } });
