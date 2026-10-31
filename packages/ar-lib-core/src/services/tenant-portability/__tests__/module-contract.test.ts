import { describe, expect, it } from 'vitest';
import {
  validateTenantPortableDatasetCoverage,
  type TenantPortableDataset,
  type TenantPortableDatasetReceipt,
} from '../module-contract';

const snapshot = { id: 'snapshot-a', inventoryDigestSha256: 'inventory-a' };
const dataset: TenantPortableDataset = {
  id: 'applications.oauth-clients',
  module: 'applications',
  kind: 'settings',
  store: 'database',
  schemaVersion: 1,
  disposition: 'include',
};
const receipt: TenantPortableDatasetReceipt = {
  datasetId: dataset.id,
  schemaVersion: 1,
  snapshotId: snapshot.id,
  inventoryDigestSha256: snapshot.inventoryDigestSha256,
  status: 'captured',
};

describe('tenant portable module completeness', () => {
  it('does not mistake a missing inventory for an empty dataset', () => {
    expect(validateTenantPortableDatasetCoverage([], [], snapshot)).toEqual([
      { code: 'missing_dataset_inventory', datasetId: '' },
    ]);
  });
  it('requires a receipt even for a dataset with no records', () => {
    expect(validateTenantPortableDatasetCoverage([dataset], [], snapshot)).toEqual([
      { code: 'missing_dataset_receipt', datasetId: dataset.id },
    ]);
    expect(validateTenantPortableDatasetCoverage([dataset], [receipt], snapshot)).toEqual([]);
  });

  it('blocks when a newly discovered dataset was not captured', () => {
    expect(
      validateTenantPortableDatasetCoverage(
        [dataset, { ...dataset, id: 'applications.new-data' }],
        [receipt],
        snapshot
      )
    ).toEqual([{ code: 'missing_dataset_receipt', datasetId: 'applications.new-data' }]);
  });

  it.each([
    { snapshotId: 'old-snapshot' },
    { inventoryDigestSha256: 'old-inventory' },
    { schemaVersion: 2 },
  ])('rejects stale evidence %j', (change) => {
    expect(
      validateTenantPortableDatasetCoverage([dataset], [{ ...receipt, ...change }], snapshot)
    ).toEqual([{ code: 'receipt_identity_mismatch', datasetId: dataset.id }]);
  });

  it('does not treat unavailable or unsupported data as an empty successful export', () => {
    expect(
      validateTenantPortableDatasetCoverage(
        [dataset],
        [{ ...receipt, status: 'unavailable' }],
        snapshot
      )
    ).toEqual([{ code: 'dataset_not_ready', datasetId: dataset.id }]);
    expect(
      validateTenantPortableDatasetCoverage(
        [{ ...dataset, disposition: 'unsupported' }],
        [receipt],
        snapshot
      )
    ).toEqual([
      { code: 'unsupported_dataset', datasetId: dataset.id },
      { code: 'dataset_not_ready', datasetId: dataset.id },
    ]);
  });

  it.each([
    ['rebuild', 'rebuild_ready'],
    ['external', 'external_resolved'],
  ] as const)('requires explicit %s readiness', (disposition, status) => {
    const expected = [{ ...dataset, disposition }];
    expect(validateTenantPortableDatasetCoverage(expected, [receipt], snapshot)).toEqual([
      { code: 'dataset_not_ready', datasetId: dataset.id },
    ]);
    expect(
      validateTenantPortableDatasetCoverage(expected, [{ ...receipt, status }], snapshot)
    ).toEqual([]);
  });

  it('rejects extra and duplicate receipts instead of reconciling them silently', () => {
    expect(
      validateTenantPortableDatasetCoverage(
        [dataset],
        [receipt, receipt, { ...receipt, datasetId: 'unexpected' }],
        snapshot
      )
    ).toEqual([
      { code: 'duplicate_receipt', datasetId: dataset.id },
      { code: 'unexpected_dataset', datasetId: 'unexpected' },
    ]);
  });
});
