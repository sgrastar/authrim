import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('token tenant-d1 runtime boundary', () => {
  it('uses Hono runtime contexts for tenant-owned core and PII token lookups', () => {
    const source = readFileSync(resolve(testDir, '..', 'token.ts'), 'utf-8');

    expect(source).toContain('createAuthContextFromHono');
    expect(source).toContain('createPIIContextFromHono');
    expect(source).not.toMatch(/new\s+User(Core|PII)Repository\s*\(\s*c\.env\.DB/u);
    expect(source).not.toMatch(/new\s+User(Core|PII)Repository\s*\(\s*c\.env\.DB_PII/u);
  });
});
