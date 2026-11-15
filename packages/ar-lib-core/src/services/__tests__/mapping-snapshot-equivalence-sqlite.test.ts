import { describe, expect, it } from 'vitest';
import { resolveRuntimeIdentityMappingBinding } from '../identity-mapping-runtime-resolver';
import { runtimeMappingSnapshotMatches } from '../mapping-snapshot-equivalence';
import { openAdminDatabase, seedMapping, sqliteAdapter } from './identity-mapping-sqlite-fixture';

describe('persisted snapshot equivalence resolution', () => {
  it.each([
    'same-content',
    'changed-policy',
    'different-tenant',
    'different-version',
    'forged-compilation',
  ])(
    'recognizes only the migrated tenant/version/hash after recompilation: %s',
    async (scenario) => {
      const db = openAdminDatabase();
      try {
        seedMapping(db, { owner: 'tenant-a', id: 'a' });
        db.prepare(
          `UPDATE compiled_mapping_snapshots SET lifecycle_state='retired',metadata_json=? WHERE id='snap-a'`
        ).run(
          JSON.stringify({
            dependencyGraphId:
              scenario === 'forged-compilation'
                ? 'dependency_graph_user_metadata'
                : 'graph_023_snap-a',
            graphMigration023: { previousSnapshotHash: 'legacy', snapshotHash: 'snapshot-a' },
          })
        );
        db.prepare(
          `INSERT INTO compiled_mapping_snapshots (id,tenant_id,field_mapping_version_id,catalog_version_id,snapshot_hash,lifecycle_state,compiled_at,metadata_json)
          VALUES ('new-snapshot','tenant-a','ver-a','catalog-a',?,'active',2,'{}')`
        ).run(scenario === 'changed-policy' ? 'changed' : 'snapshot-a');
        if (scenario === 'different-tenant')
          db.exec(
            "UPDATE compiled_mapping_snapshots SET tenant_id='other-tenant' WHERE id='snap-a'"
          );
        if (scenario === 'different-version') {
          seedMapping(db, { owner: 'tenant-a', id: 'other' });
          db.exec(
            "UPDATE compiled_mapping_snapshots SET field_mapping_version_id='ver-other' WHERE id='snap-a'"
          );
        }
        const binding = await resolveRuntimeIdentityMappingBinding(sqliteAdapter(db), {
          tenantId: 'tenant-a',
          protocol: 'oidc',
          role: 'op',
          fieldMappingSetId: 'set-a',
          fieldMappingVersionId: 'ver-a',
        });
        expect(binding).not.toBeNull();
        if (!binding) throw new Error('binding missing');
        expect(runtimeMappingSnapshotMatches(binding, 'legacy')).toBe(scenario === 'same-content');
      } finally {
        db.close();
      }
    }
  );
});
