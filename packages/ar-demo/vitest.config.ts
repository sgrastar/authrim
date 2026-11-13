import { defineConfig } from 'vitest/config';

// No shared test setup and no aliases: this package imports nothing from the other packages.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
