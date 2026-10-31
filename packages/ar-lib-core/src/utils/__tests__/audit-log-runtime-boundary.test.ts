import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('audit log runtime boundary', () => {
  it('does not retain audit services or adapters across Worker requests', () => {
    const source = readFileSync(resolve(testDir, '..', 'audit-log.ts'), 'utf8');

    expect(source).not.toContain('unifiedAuditServiceCache');
    expect(source).not.toMatch(/WeakMap<[^>]*IAuditService/u);
    expect(source).not.toContain('primaryAdapterCache');
    expect(source).not.toContain('UPDATE event_log');
  });
});
