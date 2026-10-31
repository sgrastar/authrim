import { expect, it, vi } from 'vitest';
import { verifyPhase3LogicalReferences } from '../phase3-logical-references';

function admin(groups: unknown[], fields: unknown[]) {
  return {
    query: vi.fn(async (sql: string) =>
      sql.includes('attribute_group_registry') ? groups : fields
    ),
  };
}

it('accepts tenant and installed platform fields referenced by attribute groups', async () => {
  const database = admin(
    [
      { protocol: 'oidc', field_keys_json: '["email","locale","email"]' },
      { protocol: 'saml', field_keys_json: '[]' },
    ],
    [
      { protocol: 'oidc', field_key: 'email' },
      { protocol: 'oidc', field_key: 'locale' },
    ]
  );
  await expect(
    verifyPhase3LogicalReferences({ tenantId: 'tenant-a', admin: database as never })
  ).resolves.toBeUndefined();
  expect(database.query).toHaveBeenCalledTimes(2);
});

it('fails closed when a restored logical field reference is missing', async () => {
  await expect(
    verifyPhase3LogicalReferences({
      tenantId: 'tenant-a',
      admin: admin([{ protocol: 'oidc', field_keys_json: '["missing"]' }], []) as never,
    })
  ).rejects.toThrow('backup_phase3_semantic_reference_missing');
});

it.each([
  [[{ protocol: 'oidc', field_keys_json: '{}' }]],
  [[{ protocol: 'oidc', field_keys_json: '[""]' }]],
  [[{ protocol: null, field_keys_json: '[]' }]],
])('rejects malformed logical reference data before activation', async (groups) => {
  await expect(
    verifyPhase3LogicalReferences({
      tenantId: 'tenant-a',
      admin: admin(groups, [{ protocol: 'oidc', field_key: 'email' }]) as never,
    })
  ).rejects.toThrow('backup_phase3_semantic_reference_invalid');
});

it('rejects unbounded result pages instead of verifying a prefix', async () => {
  await expect(
    verifyPhase3LogicalReferences({
      tenantId: 'tenant-a',
      admin: admin(
        [],
        Array.from({ length: 8193 }, () => ({ protocol: 'oidc', field_key: 'email' }))
      ) as never,
    })
  ).rejects.toThrow('backup_phase3_semantic_reference_invalid');
});
