import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { REASON_REGISTRY, validateReasonRegistry } from '../../core/reason-registry';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('reason registry', () => {
  it('has no duplicate or category-mismatched reason codes', () => {
    expect(validateReasonRegistry()).toEqual([]);
  });

  it('keeps the reviewed docs snapshot in sync', () => {
    const docs = readFileSync(resolve(__dirname, '../../../docs/reason-codes.md'), 'utf8');
    for (const entry of REASON_REGISTRY) {
      const row = docs.split('\n').find((line) => line.includes(`| \`${entry.code}\``));
      expect(row).toBeDefined();
      expect(row).toContain(`| ${entry.category}`);
      expect(row).toContain(`| ${entry.severity}`);
      expect(row).toContain(`| ${entry.stability}`);
    }
  });
});
