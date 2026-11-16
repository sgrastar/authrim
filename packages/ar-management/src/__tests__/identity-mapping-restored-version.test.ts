import { describe, expect, it } from 'vitest';
import { resolveRuntimeIdentityMappingBinding } from '@authrim/ar-lib-core';
import {
  restoreMappingVersionRow,
  runtimeMappingSnapshotMatches,
} from '@authrim/ar-lib-core/services/mapping-snapshot-equivalence';
import { sqliteSnapshotRowInsert } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-row-codec';
import { IdentityMappingControlPlaneRepository } from '../identity-mapping-control-plane';
import { openAdminDatabase, sqliteAdapter } from './helpers/admin-authority-fixture';

describe('restored mapping version provenance', () => {
  it.each([false, true])(
    'never revives historical pins when the bundle omits every snapshot (deny changed to allow=%s)',
    async (changedAction) => {
      const source = openAdminDatabase();
      const target = openAdminDatabase();
      try {
        const tenantId = 'restored-version-tenant';
        const sourceAdapter = sqliteAdapter(source);
        const original = new IdentityMappingControlPlaneRepository(sourceAdapter);
        const catalog = await original.createCatalog(tenantId, {
          catalogKey: 'restored-fields',
          displayName: 'Restored fields',
          versionLabel: 'v1',
          entries: ['input', 'output'].map((name) => ({
            id: name,
            namespace: 'authrim.profile',
            path: `attributes.${name}`,
            valueType: 'string',
            cardinality: 'single',
            classification: 'internal',
            targetType: 'canonical',
          })),
        });
        const set = await original.createFieldMappingSet(tenantId, {
          fieldMappingKey: 'restore-pin',
          displayName: 'Restore pin',
        });
        const targetRef = {
          side: 'canonical',
          namespace: 'authrim.profile',
          path: 'attributes.output',
        };
        const version = await original.createFieldMappingVersion(tenantId, set.id, {
          versionLabel: 'v1',
          rules: [
            {
              ruleKey: 'policy',
              ruleKind: 'mapping',
              action: 'deny',
              targetRef,
              edges: [
                {
                  sourceRef: {
                    side: 'source',
                    namespace: 'authrim.profile',
                    path: 'attributes.input',
                  },
                  targetRef,
                },
              ],
              output: { edgeIndex: 0 },
            },
          ],
        });
        await original.publishFieldMappingVersion(tenantId, set.id, version.id);
        const pinned = await original.compileFieldMappingVersion(tenantId, set.id, version.id, {
          catalogVersionId: catalog.activeVersion.id,
        });
        if (changedAction) {
          // The attacker retains IDs and authoring/catalog hashes but changes unbound policy.
          source
            .prepare('UPDATE mapping_rules SET action=? WHERE field_mapping_version_id=?')
            .run('allow', version.id);
        }
        source
          .prepare('UPDATE field_mapping_versions SET restore_id=? WHERE id=?')
          .run('uploaded-restore-id', version.id);

        // The bundle contains its version and graph, with both snapshot datasets entirely empty.
        for (const table of [
          'field_catalogs',
          'field_catalog_versions',
          'field_catalog_entries',
          'field_mapping_sets',
          'field_mapping_versions',
          'mapping_rules',
          'mapping_rule_edges',
        ]) {
          const rows = await sourceAdapter.query<Record<string, string | number | null>>(
            `SELECT * FROM ${table} WHERE tenant_id=?`,
            [tenantId]
          );
          for (const row of rows) {
            let rowJson = JSON.stringify(
              Object.fromEntries(
                Object.entries(row).map(([column, value]) => [
                  column,
                  value === null
                    ? ['null', null]
                    : [typeof value === 'number' ? 'integer' : 'text', String(value)],
                ])
              )
            );
            if (table === 'field_mapping_versions')
              rowJson = await restoreMappingVersionRow(
                { operation: { id: 'destination-owned-restore' } },
                rowJson
              );
            const insert = sqliteSnapshotRowInsert(table, Object.keys(row), rowJson);
            target.prepare(insert.sql).run(...insert.params);
          }
        }
        expect(target.prepare('SELECT * FROM compiled_mapping_snapshots').all()).toEqual([]);
        expect(target.prepare('SELECT * FROM dependency_graph_snapshots').all()).toEqual([]);
        expect(
          target.prepare('SELECT restore_id,field_mapping_hash FROM field_mapping_versions').get()
        ).toEqual({
          restore_id: 'destination-owned-restore',
          field_mapping_hash: version.fieldMappingHash,
        });

        const adapter = sqliteAdapter(target);
        const restored = new IdentityMappingControlPlaneRepository(adapter);
        const replacement = await restored.compileFieldMappingVersion(
          tenantId,
          set.id,
          version.id,
          {
            catalogVersionId: catalog.activeVersion.id,
          }
        );
        await restored.activateFieldMappingVersion(tenantId, set.id, version.id, {
          snapshotId: replacement.id,
          holderId: 'restore-test',
          activationScope: { protocol: 'oidc', role: 'op' },
        });
        const binding = await resolveRuntimeIdentityMappingBinding(adapter, {
          tenantId,
          protocol: 'oidc',
          role: 'op',
          fieldMappingSetId: set.id,
        });
        if (!binding) throw new Error('Restored graph was not loaded');
        expect(binding.fieldMappingSet.rules[0].action).toBe(changedAction ? 'allow' : 'deny');
        expect(runtimeMappingSnapshotMatches(binding, pinned.snapshotHash)).toBe(false);
        expect(runtimeMappingSnapshotMatches(binding, replacement.snapshotHash)).toBe(true);
        // Removing all snapshot history again must never remove the version's restore record.
        target.exec(
          'DELETE FROM compiled_mapping_snapshots; DELETE FROM dependency_graph_snapshots'
        );
        const later = await restored.compileFieldMappingVersion(tenantId, set.id, version.id, {
          catalogVersionId: catalog.activeVersion.id,
        });
        expect(later.snapshotHash).not.toBe(pinned.snapshotHash);
        expect(later.snapshotHash).not.toBe(replacement.snapshotHash);
        const storedGraph = await adapter.queryOne<{ graph_json: string }>(
          'SELECT graph_json FROM dependency_graph_snapshots'
        );
        if (!storedGraph) throw new Error('Compiled graph was not stored');
        const material: unknown = JSON.parse(storedGraph.graph_json);
        expect(material).toMatchObject({
          restoreId: 'destination-owned-restore',
          restoredCompilationId: later.id,
        });
      } finally {
        source.close();
        target.close();
      }
    }
  );
});
