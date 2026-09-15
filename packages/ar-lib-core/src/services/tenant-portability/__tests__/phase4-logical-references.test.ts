import { expect, it, vi } from 'vitest';
import { verifyPhase4LogicalReferences } from '../phase4-logical-references';

function database(rows: unknown[][]) {
  const query = vi.fn();
  for (const result of rows) query.mockResolvedValueOnce(result);
  return { query };
}

it('accepts restored credential profiles whose Core configurations are usable', async () => {
  const admin = database([
    [
      { credential_configuration_id: 'StudentCredential', lifecycle_state: 'published' },
      { credential_configuration_id: 'DraftCredential', lifecycle_state: 'draft' },
    ],
  ]);
  const core = database([
    [
      { configuration_id: 'StudentCredential', is_active: 1 },
      { configuration_id: 'DraftCredential', is_active: 0 },
    ],
  ]);
  await expect(
    verifyPhase4LogicalReferences({ tenantId: 'tenant-a', core, admin })
  ).resolves.toBeUndefined();
  expect(admin.query).toHaveBeenCalledWith(expect.stringContaining('WHERE tenant_id = ?'), [
    'tenant-a',
    10_001,
  ]);
});

it.each([
  { configurations: [], label: 'missing' },
  {
    configurations: [{ configuration_id: 'StudentCredential', is_active: 0 }],
    label: 'inactive',
  },
])('rejects a $label configuration used by a published profile', async ({ configurations }) => {
  const admin = database([
    [{ credential_configuration_id: 'StudentCredential', lifecycle_state: 'published' }],
  ]);
  const core = database([configurations]);
  await expect(
    verifyPhase4LogicalReferences({ tenantId: 'tenant-a', core, admin })
  ).rejects.toThrow('backup_phase4_logical_reference_missing');
});

it('bounds restored cross-database reference scans', async () => {
  const admin = database([
    Array.from({ length: 10_001 }, () => ({
      credential_configuration_id: 'StudentCredential',
      lifecycle_state: 'draft',
    })),
  ]);
  await expect(
    verifyPhase4LogicalReferences({ tenantId: 'tenant-a', core: database([]), admin })
  ).rejects.toThrow('backup_phase4_logical_reference_limit');
});
