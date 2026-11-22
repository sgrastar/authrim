import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Vitest config for `mutator` runs against a real PostgreSQL (see docs/getting-started/testing.md).
 *
 * The replication initialization tests prove that an unencrypted connection is refused. They need
 * a URL without `sslmode` and must not see `AUTHRIM_AWS_TEST_DATABASE_URL`, which a shared mutator
 * session cannot give a single file, so they stay in the dedicated CI job.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      // The PostgreSQL-backed files share one database and must not run in parallel.
      fileParallelism: false,
      exclude: ['**/node_modules/**', 'src/replication/initialize*.postgres.test.ts'],
    },
  })
);
