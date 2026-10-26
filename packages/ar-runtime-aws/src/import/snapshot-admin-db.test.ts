import { describe, expect, it } from 'vitest';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import {
  createSnapshotAdminAdapter,
  SNAPSHOT_ADMIN_MAPPING_TABLES,
  type SnapshotAdminMappingTable,
} from './snapshot-admin-db';

function rows(): Record<SnapshotAdminMappingTable, PortableSqliteRow[]> {
  return Object.fromEntries(
    SNAPSHOT_ADMIN_MAPPING_TABLES.map((table) => [table, []])
  ) as unknown as Record<SnapshotAdminMappingTable, PortableSqliteRow[]>;
}

describe('verified Admin mapping snapshot adapter', () => {
  it('makes selected source rows available to the existing compiler without mutation', async () => {
    const source = rows();
    source.field_mapping_sets.push({
      id: ['text', 'set-a'],
      tenant_id: ['text', 'tenant-a'],
      lifecycle_state: ['text', 'active'],
    });
    const adapter = createSnapshotAdminAdapter({ tenantId: 'tenant-a', rows: source });
    try {
      expect(
        await adapter.queryOne<{ lifecycle_state: string }>(
          'SELECT lifecycle_state FROM field_mapping_sets WHERE id = ?',
          ['set-a']
        )
      ).toEqual({ lifecycle_state: 'active' });
      await expect(adapter.execute('DELETE FROM field_mapping_sets')).rejects.toThrow(
        'aws_admin_snapshot_invalid'
      );
    } finally {
      await adapter.close();
    }
  });

  it('rejects another tenant and untrusted platform table rows', () => {
    const source = rows();
    source.field_mapping_sets.push({
      id: ['text', 'set-b'],
      tenant_id: ['text', 'tenant-b'],
      lifecycle_state: ['text', 'active'],
    });
    expect(() => createSnapshotAdminAdapter({ tenantId: 'tenant-a', rows: source })).toThrow(
      'aws_admin_snapshot_invalid'
    );
    source.field_mapping_sets.length = 0;
    expect(() =>
      createSnapshotAdminAdapter({
        tenantId: 'tenant-a',
        rows: source,
        platformRows: {
          field_mapping_sets: [
            {
              id: ['text', 'set-platform'],
              tenant_id: ['text', 'platform'],
            },
          ],
        },
      })
    ).toThrow('aws_admin_snapshot_invalid');
  });
});
