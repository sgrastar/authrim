import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), 'utf8');
}

describe('canonical runtime cutover source gate', () => {
  it('keeps runtime writer free of legacy users_core/users_pii table access', () => {
    const source = readSource('../identity/canonical-runtime-user-writer.ts');

    expect(source).not.toMatch(/\b(FROM|JOIN|INSERT INTO|UPDATE|DELETE FROM)\s+users_core\b/iu);
    expect(source).not.toMatch(/\b(FROM|JOIN|INSERT INTO|UPDATE|DELETE FROM)\s+users_pii\b/iu);
  });

  it('keeps projection legacy users_core/users_pii access out of the canonical read path', () => {
    const source = readSource('../identity/canonical-runtime-user-projection.ts');

    expect(source).not.toMatch(/\b(FROM|JOIN|INSERT INTO|UPDATE|DELETE FROM)\s+users_core\b/iu);
    expect(source).not.toMatch(/\b(FROM|JOIN|INSERT INTO|UPDATE|DELETE FROM)\s+users_pii\b/iu);
    expect(source).toContain('class CanonicalSensitiveValueResolver');
    expect(source).toContain('FROM identity_sensitive_values');
  });
});
