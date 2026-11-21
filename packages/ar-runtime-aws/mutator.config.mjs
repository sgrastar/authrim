import { createMutatorConfig } from '../../mutator.base.mjs';

// Run against a real PostgreSQL (see docs/getting-started/testing.md): the PostgreSQL-backed
// tests share one database, so test files run one at a time in one session.
export default createMutatorConfig({
  vitestConfig: 'vitest.mutation.config.ts',
  concurrency: 1,
});
