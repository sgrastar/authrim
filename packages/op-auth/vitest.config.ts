import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Use op-auth specific setup
    setupFiles: ['./test/setup.ts'],
    // Only include src tests, exclude dist directory
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Use 'forks' pool for better test isolation
    pool: 'forks',
    poolOptions: {
      forks: {
        isolate: true,
      },
    },
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'test/', 'dist/', '**/*.d.ts', '**/*.config.*', '**/mockData.ts'],
    },
  },
  resolve: {
    alias: {
      // Mock cloudflare:workers for Node.js test environment
      'cloudflare:workers': resolve(__dirname, '../../test/mocks/cloudflare-workers.ts'),
    },
  },
});
