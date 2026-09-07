import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const jsonReportPath = process.env.AUTHRIM_TEST_REPORT?.trim();

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    reporters: jsonReportPath ? ['default', 'json'] : ['default'],
    outputFile: jsonReportPath ? { json: jsonReportPath } : undefined,
  },
});
