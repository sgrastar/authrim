import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// Deliberately outside the default src/**/*.test.ts discovery. Missing/invalid local PG is an error.
export default defineConfig(async () => {
  const resolved = await base;
  return {
    ...resolved,
    test: {
      ...resolved.test,
      include: ['src/test/integration/statement-consent-postgres.integration.ts'],
    },
  };
});
