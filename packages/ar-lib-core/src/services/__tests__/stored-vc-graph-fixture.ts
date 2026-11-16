import { vi } from 'vitest';
import type { DatabaseAdapter, TransactionContext } from '../../db/adapter';
import {
  loadRuntimeMappingGraph,
  type RuntimeIdentityMappingBinding,
} from '../identity-mapping-runtime-resolver';

/** Exercise the stored-row decoder used by both VC entry points, without mocking the evaluator. */
export async function storedVCGraphBinding(
  destinationNamespace: string
): Promise<RuntimeIdentityMappingBinding> {
  const sourceRef = { side: 'source', namespace: 'vc', path: 'age_over_18' };
  const targetRef = { side: 'destination', namespace: destinationNamespace, path: 'age_over_18' };
  const adapter: DatabaseAdapter = {
    async query<T>(): Promise<T[]> {
      return [];
    },
    async queryOne<T>(): Promise<T | null> {
      return null;
    },
    async execute() {
      throw new Error('read-only fixture');
    },
    async transaction<T>(callback: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return callback(adapter);
    },
    async batch() {
      return [];
    },
    async isHealthy() {
      return { healthy: true, latencyMs: 0, type: 'mock' };
    },
    getType: () => 'mock',
    async close() {},
  };
  vi.spyOn(adapter, 'query')
    .mockResolvedValueOnce([
      {
        id: 'edge',
        rule_id: 'rule',
        source_ref_json: JSON.stringify(sourceRef),
        target_ref_json: JSON.stringify(targetRef),
        edge_kind: 'direct',
        display_order: 0,
      },
    ])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      {
        id: 'rule',
        action: 'allow',
        priority: 0,
        scope_json: '{}',
        metadata_json: '{}',
        target_ref_json: JSON.stringify(targetRef),
        output_edge_id: 'edge',
        output_step_id: null,
      },
    ])
    .mockResolvedValueOnce([]);
  const graph = await loadRuntimeMappingGraph(adapter, 'tenant-1', 'mapping-version-1');
  return {
    ...graph,
    id: 'activation',
    tenantId: 'tenant-1',
    fieldMappingSetId: 'mapping-set-1',
    fieldMappingVersionId: 'mapping-version-1',
    mappingSnapshotHash: 'snapshot-1',
    destinationNamespace,
    destinationProfileIds: [],
    activationScope: {},
    validationRules: [],
    fieldMappingSet: { id: 'mapping-set-1', rules: [] },
    catalog: {
      identity: {
        id: 'catalog',
        version: '1',
        contentHash: 'catalog-hash',
        compatibilityRange: '*',
      },
      entries: [
        {
          id: 'source',
          namespace: 'vc',
          path: 'age_over_18',
          valueType: 'boolean',
          cardinality: 'single',
          classification: 'internal',
        },
        {
          id: 'target',
          namespace: destinationNamespace,
          path: 'age_over_18',
          valueType: 'boolean',
          cardinality: 'single',
          classification: 'internal',
        },
      ],
    },
  };
}
