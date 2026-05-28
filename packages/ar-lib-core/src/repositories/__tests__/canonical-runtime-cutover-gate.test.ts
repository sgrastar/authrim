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

  it('keeps projection users_pii access quarantined behind the explicit legacy value resolver', () => {
    const source = readSource('../identity/canonical-runtime-user-projection.ts');

    expect(source).not.toMatch(/\b(FROM|JOIN|INSERT INTO|UPDATE|DELETE FROM)\s+users_core\b/iu);
    const usersPiiSqlReferences = [
      ...source.matchAll(/\b(FROM|JOIN|INSERT INTO|UPDATE|DELETE FROM)\s+users_pii\b/giu),
    ];
    expect(usersPiiSqlReferences).toHaveLength(1);
    expect(source).toContain('class LegacyUsersPiiValueResolver');
    expect(source).toContain('SELECT ${ref.field} FROM users_pii WHERE id = ? AND tenant_id = ?');
  });
});
