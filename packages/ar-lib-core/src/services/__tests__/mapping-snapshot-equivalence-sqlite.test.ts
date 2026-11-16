import { describe, expect, it } from 'vitest';
import { resolveRuntimeIdentityMappingBinding } from '../identity-mapping-runtime-resolver';
import {
  restoredMappingSnapshotRow,
  runtimeMappingSnapshotMatches,
} from '../mapping-snapshot-equivalence';
import { openAdminDatabase, seedMapping, sqliteAdapter } from './identity-mapping-sqlite-fixture';

describe('persisted snapshot equivalence resolution', () => {
  it.each([
    'exact-active-row',
    'same-content',
    'tampered-bundle',
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
        const exactRow = ['exact-active-row', 'tampered-bundle', 'forged-compilation'].includes(
          scenario
        );
        db.prepare(
          `UPDATE compiled_mapping_snapshots SET lifecycle_state=?,metadata_json=? WHERE id='snap-a'`
        ).run(
          exactRow ? 'active' : 'retired',
          JSON.stringify({
            dependencyGraphId:
              scenario === 'forged-compilation'
                ? 'dependency_graph_user_metadata'
                : 'graph_023_snap-a',
            graphMigration023: { previousSnapshotHash: 'legacy', snapshotHash: 'snapshot-a' },
          })
        );
        if (!exactRow)
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
        if (scenario === 'tampered-bundle') {
          const metadata = db
            .prepare("SELECT metadata_json FROM compiled_mapping_snapshots WHERE id='snap-a'")
            .get()?.metadata_json;
          const restored: unknown = JSON.parse(
            restoredMappingSnapshotRow(JSON.stringify({ metadata_json: ['text', metadata] }))
          );
          const restoredMetadata: unknown = Reflect.get(Object(restored), 'metadata_json');
          if (!Array.isArray(restoredMetadata) || typeof restoredMetadata[1] !== 'string')
            throw new Error('restored metadata missing');
          db.prepare("UPDATE compiled_mapping_snapshots SET metadata_json=? WHERE id='snap-a'").run(
            restoredMetadata[1]
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
        expect(runtimeMappingSnapshotMatches(binding, 'legacy')).toBe(
          scenario === 'exact-active-row'
        );
      } finally {
        db.close();
      }
    }
  );
});
