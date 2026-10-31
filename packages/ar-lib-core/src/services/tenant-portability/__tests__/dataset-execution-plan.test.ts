import { describe, expect, it } from 'vitest';
import { buildTenantBackupDatasetExecutionPlan } from '../dataset-execution-plan';

describe('tenant backup dataset execution plan', () => {
  it('keeps 306 registered datasets while materializing only content and explicit empty state', () => {
    const inputs = Array.from({ length: 306 }, (_, index) => ({
      dataset: {
        id: `core.dataset_${index}`,
        module: 'core',
        kind: 'users',
        store: 'database' as const,
        schemaVersion: 1,
        disposition: 'include' as const,
      },
      targetId: index < 200 ? 'core-default' : 'core-users',
      rows: index === 2 || index === 202 ? 10 : 0,
      bytes: index === 2 || index === 202 ? 1024 : 0,
      materializeEmpty: index === 205,
    }));
    const plan = buildTenantBackupDatasetExecutionPlan(inputs);
    expect(plan.registeredDatasets).toHaveLength(306);
    expect(plan.nonEmptyDatasets).toHaveLength(2);
    expect(plan.materializedDatasets).toHaveLength(3);
    expect(plan.executionBatches).toHaveLength(2);
    expect(plan.executionBatches.map(({ datasetIds }) => datasetIds)).toEqual([
      ['core.dataset_2'],
      ['core.dataset_202', 'core.dataset_205'],
    ]);
  });

  it('starts another execution batch only at a target or capacity boundary', () => {
    const dataset = (id: string, targetId: string, rows: number, bytes: number) => ({
      dataset: {
        id,
        module: 'core',
        kind: 'users',
        store: 'database' as const,
        schemaVersion: 1,
        disposition: 'include' as const,
      },
      targetId,
      rows,
      bytes,
    });
    const plan = buildTenantBackupDatasetExecutionPlan([
      dataset('core.a', 'one', 100, 1024),
      dataset('core.b', 'one', 150, 1024),
      dataset('core.c', 'one', 1, 1),
      dataset('core.d', 'two', 1, 1),
    ]);
    expect(plan.executionBatches.map(({ datasetIds }) => datasetIds)).toEqual([
      ['core.a', 'core.b'],
      ['core.c'],
      ['core.d'],
    ]);
  });
});
