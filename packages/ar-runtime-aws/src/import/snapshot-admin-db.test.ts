import { runtimeMappingSnapshotMatches } from '@authrim/ar-lib-core/services/mapping-snapshot-equivalence';
import {
  loadRuntimeMappingGraph,
  resolveRuntimeIdentityMappingBinding,
} from '@authrim/ar-lib-core/services/identity-mapping-runtime-resolver';
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

function portable(values: Record<string, string | number | null>): PortableSqliteRow {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]): [string, readonly [string, string | null]] => [
      key,
      value === null
        ? ['null', null]
        : [typeof value === 'number' ? 'integer' : 'text', String(value)],
    ])
  );
}

describe('verified Admin mapping snapshot adapter', () => {
  it.each([undefined, null, 'uploaded-restore-id'])(
    'records fresh version provenance with no snapshots, ignoring uploaded restore ID %s',
    async (uploaded) => {
      const source = rows();
      source.field_mapping_versions.push(
        portable({
          id: 'version',
          tenant_id: 'tenant-a',
          field_mapping_set_id: 'set',
          field_mapping_hash: 'retained-authoring-hash',
          ...(uploaded === undefined ? {} : { restore_id: uploaded }),
        })
      );
      source.mapping_rules.push(
        portable({
          id: 'rule',
          tenant_id: 'tenant-a',
          field_mapping_version_id: 'version',
          action: 'allow',
        })
      );
      const first = createSnapshotAdminAdapter({ tenantId: 'tenant-a', rows: source });
      const second = createSnapshotAdminAdapter({ tenantId: 'tenant-a', rows: source });
      try {
        expect(await first.query('SELECT * FROM compiled_mapping_snapshots')).toEqual([]);
        const one = await first.queryOne<{ restore_id: string; field_mapping_hash: string }>(
          'SELECT restore_id,field_mapping_hash FROM field_mapping_versions'
        );
        const two = await second.queryOne<{ restore_id: string }>(
          'SELECT restore_id FROM field_mapping_versions'
        );
        expect(one?.field_mapping_hash).toBe('retained-authoring-hash');
        expect(one?.restore_id).toEqual(expect.any(String));
        expect(one?.restore_id).not.toBe(uploaded);
        expect(one?.restore_id).not.toBe(two?.restore_id);
        expect(await first.query('SELECT action FROM mapping_rules')).toEqual([
          { action: 'allow' },
        ]);
      } finally {
        await first.close();
        await second.close();
      }
    }
  );
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

  it('executes every runtime graph loader against minimum registry columns, including empty tables', async () => {
    const source = rows();
    source.field_mapping_activations.push(
      portable({
        id: 'activation',
        tenant_id: 'tenant-a',
        field_mapping_set_id: 'set',
        field_mapping_version_id: 'version',
        lifecycle_state: 'active',
        activation_scope_json: '{"kind":"tenant"}',
      })
    );
    source.field_mapping_versions.push(
      portable({
        id: 'version',
        tenant_id: 'tenant-a',
        field_mapping_set_id: 'set',
        version_label: 'v1',
        field_mapping_hash: 'hash',
      })
    );
    source.compiled_mapping_snapshots.push(
      portable({
        id: 'snapshot',
        tenant_id: 'tenant-a',
        field_mapping_version_id: 'version',
        catalog_version_id: 'catalog',
        lifecycle_state: 'active',
        snapshot_hash: 'current',
        metadata_json: JSON.stringify({
          dependencyGraphId: 'graph_023_snapshot',
          graphMigration023: { previousSnapshotHash: 'forged-old', snapshotHash: 'current' },
        }),
      })
    );
    const adapter = createSnapshotAdminAdapter({ tenantId: 'tenant-a', rows: source });
    try {
      // These are the actual production queries, so added SELECT/JOIN/WHERE columns break CI.
      expect(await loadRuntimeMappingGraph(adapter, 'tenant-a', 'version')).toEqual({
        edges: [],
        transforms: [],
        graphRules: [],
      });
      const binding = await resolveRuntimeIdentityMappingBinding(adapter, {
        tenantId: 'tenant-a',
        protocol: 'oidc',
        role: 'op',
      });
      expect(binding?.mappingSnapshotHash).toBe('current');
      expect(binding?.mappingSnapshotPinTrusted).toBe(false);
      if (!binding) throw new Error('imported mapping missing');
      expect(runtimeMappingSnapshotMatches(binding, 'current')).toBe(false);
      expect(binding?.equivalentMappingSnapshotHashes).toEqual([]);
      await expect(adapter.query('SELECT edge_id FROM mapping_transform_steps')).rejects.toThrow();
      await expect(
        adapter.query('SELECT target_ref_json FROM mapping_transform_steps')
      ).rejects.toThrow();
    } finally {
      await adapter.close();
    }
  });

  it.each(['legitimate', 'changed-graph-forged-pin'])(
    'loads stored graphs but refuses imported pin authority: %s',
    async (scenario) => {
      const source = rows();
      const owner = { tenant_id: 'tenant-a' };
      source.mapping_rules.push(
        portable({
          ...owner,
          id: 'rule',
          field_mapping_version_id: 'version',
          priority: 0,
          created_at: 1,
          action: 'allow',
          output_edge_id: null,
          output_step_id: 'step',
          target_ref_json: '{"namespace":"oidc.claim","path":"name"}',
        })
      );
      source.mapping_rule_edges.push(
        portable({
          ...owner,
          id: 'edge',
          rule_id: 'rule',
          source_ref_json: '{"namespace":"authrim.profile","path":"name"}',
          target_ref_json: '{"namespace":"oidc.claim","path":"name"}',
          edge_kind: 'direct',
          display_order: 0,
        })
      );
      source.mapping_transform_steps.push(
        portable({
          ...owner,
          id: 'step',
          rule_id: 'rule',
          step_order: 0,
          operation: 'concat',
          parameters_json: '{}',
        })
      );
      for (let position = 11; position >= 0; position--)
        source.mapping_transform_step_inputs.push(
          portable({
            ...owner,
            step_id: 'step',
            position,
            edge_id: 'edge',
            input_step_id: null,
            name: `input-${position}`,
          })
        );
      source.field_mapping_versions.push(
        portable({
          id: 'version',
          tenant_id: 'tenant-a',
          field_mapping_set_id: 'set',
          version_label: 'v1',
          field_mapping_hash: 'original-policy',
        })
      );
      source.field_mapping_activations.push(
        portable({
          id: 'activation',
          tenant_id: 'tenant-a',
          field_mapping_set_id: 'set',
          field_mapping_version_id: 'version',
          lifecycle_state: 'active',
          activation_scope_json: '{"kind":"tenant"}',
        })
      );
      source.compiled_mapping_snapshots.push(
        portable({
          id: 'snapshot',
          tenant_id: 'tenant-a',
          field_mapping_version_id: 'version',
          catalog_version_id: 'catalog',
          snapshot_hash: 'previous-evidence-pin',
          lifecycle_state: 'active',
          metadata_json: '{"snapshotPinState":"compiled"}',
        })
      );
      if (scenario === 'changed-graph-forged-pin')
        source.mapping_transform_steps[0] = portable({
          ...owner,
          id: 'step',
          rule_id: 'rule',
          step_order: 0,
          operation: 'concat',
          parameters_json: '{"delimiter":"attacker"}',
        });
      const adapter = createSnapshotAdminAdapter({ tenantId: 'tenant-a', rows: source });
      try {
        const graph = await loadRuntimeMappingGraph(adapter, 'tenant-a', 'version');
        expect(graph.graphRules[0].output).toEqual({ stepIndex: 0 });
        expect(graph.graphRules[0].transforms[0].inputs).toEqual(
          Array.from({ length: 12 }, (_, index) => ({ edgeIndex: 0, name: `input-${index}` }))
        );
        const binding = await resolveRuntimeIdentityMappingBinding(adapter, {
          tenantId: 'tenant-a',
          protocol: 'oidc',
          role: 'op',
        });
        if (!binding) throw new Error('imported mapping missing');
        expect(binding.graphRules).toHaveLength(1);
        expect(runtimeMappingSnapshotMatches(binding, 'previous-evidence-pin')).toBe(false);
        const columns = await adapter.query<{ type: string }>(
          'PRAGMA table_info(mapping_transform_step_inputs)'
        );
        expect(columns).toContainEqual(
          expect.objectContaining({ name: 'position', type: 'INTEGER' })
        );
      } finally {
        await adapter.close();
      }
    }
  );

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
