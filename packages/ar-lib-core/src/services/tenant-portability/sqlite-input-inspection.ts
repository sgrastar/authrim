import {
  createSqliteDatasetInspectorFactory,
  type SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector';
import type { TenantBundleManifest } from './bundle-manifest';
import type { DatabaseTenantBundleReferenceIndex } from './validation-index';
import type { TenantPortableDependency, TenantPortableRecordIdentity } from './reference-contract';
import { TENANT_PORTABILITY_MODULES } from './module-contract';

function fail(): never {
  throw new Error('backup_sqlite_input_inspection_invalid');
}
function validIdentity(identity: TenantPortableRecordIdentity, tenantId: string): boolean {
  return (
    Boolean(identity) &&
    identity.tenantId === tenantId &&
    (TENANT_PORTABILITY_MODULES as readonly string[]).includes(identity.module) &&
    typeof identity.collection === 'string' &&
    identity.collection.length > 0 &&
    identity.collection.length <= 256 &&
    typeof identity.id === 'string' &&
    identity.id.length > 0 &&
    identity.id.length <= 4096
  );
}

/**
 * Inspect exactly one complete SQL row, then idempotently record identities and edges. The caller
 * advances its row cursor only after this returns. Retry the same immutable input position after
 * any uncertain write; dataset/whole-input invariants and reference resolution remain later stages.
 */
export async function inspectSqliteInputRow(input: {
  policy: SqliteDatasetInspectionPolicy;
  manifest: TenantBundleManifest;
  rowJson: string;
  rowOrdinal: number;
  index: Pick<DatabaseTenantBundleReferenceIndex, 'recordOnce' | 'referenceOnce'>;
  assertPinnedInput: () => Promise<void>;
}): Promise<void> {
  const manifest = structuredClone(input.manifest);
  const datasetIndex = manifest.datasets.findIndex(
    (dataset) => dataset.id === input.policy.dataset.id
  );
  if (
    datasetIndex < 0 ||
    !Number.isSafeInteger(input.rowOrdinal) ||
    input.rowOrdinal < 0 ||
    input.rowOrdinal >= Number.MAX_SAFE_INTEGER ||
    typeof input.rowJson !== 'string'
  )
    fail();
  const bytes = new TextEncoder().encode(input.rowJson);
  if (!bytes.length || bytes.length > 16 * 1024 * 1024 || bytes.includes(10)) fail();
  await input.assertPinnedInput();
  let inspector;
  try {
    inspector = await createSqliteDatasetInspectorFactory(input.policy)(
      manifest.datasets[datasetIndex],
      manifest
    );
  } catch {
    throw new Error('backup_sqlite_inspector_create_failed');
  }
  const records: TenantPortableRecordIdentity[] = [];
  const references: TenantPortableDependency[] = [];
  try {
    let ordinal = 0;
    for (let offset = 0; offset < bytes.length; offset += 1048576) {
      await input.assertPinnedInput();
      let inspected;
      try {
        inspected = await inspector.chunk(bytes.subarray(offset, offset + 1048576), ordinal++);
      } catch {
        throw new Error('backup_sqlite_inspector_chunk_failed');
      }
      records.push(...inspected.records);
      references.push(...inspected.references);
    }
    let last;
    try {
      last = await inspector.chunk(new Uint8Array([10]), ordinal);
    } catch {
      throw new Error('backup_sqlite_inspector_row_finish_failed');
    }
    records.push(...last.records);
    references.push(...last.references);
    try {
      await inspector.finish();
    } catch {
      throw new Error('backup_sqlite_inspector_dataset_finish_failed');
    }
  } finally {
    await inspector.dispose();
  }
  if (!records.length || records.length > 4096 || references.length > 4096) fail();
  const record = records[0];
  if (
    !validIdentity(record, manifest.source.tenantId) ||
    record.module !== input.policy.dataset.module ||
    record.collection !== input.policy.dataset.id
  )
    fail();
  if (
    new Set(records.map(({ id }) => id)).size !== records.length ||
    records.some(
      (candidate) =>
        !validIdentity(candidate, manifest.source.tenantId) ||
        candidate.module !== record.module ||
        candidate.collection !== record.collection
    )
  )
    fail();
  for (const dependency of references) {
    if (
      !dependency ||
      !validIdentity(dependency.from, manifest.source.tenantId) ||
      !validIdentity(dependency.to, manifest.source.tenantId) ||
      dependency.from.module !== record.module ||
      dependency.from.collection !== record.collection ||
      dependency.from.id !== record.id ||
      !['resource', 'user', 'admin_actor', 'admin_principal', 'asset', 'secret'].includes(
        dependency.to.meaning
      ) ||
      !['required', 'provenance'].includes(dependency.to.requirement)
    )
      fail();
  }
  const source = `dataset:${datasetIndex}:row:${input.rowOrdinal}`;
  await input.assertPinnedInput();
  for (const [ordinal, candidate] of records.entries()) {
    const recordSource = ordinal === 0 ? source : `${source}:alias:${ordinal - 1}`;
    if (!(await input.index.recordOnce(manifest.bundleId, recordSource, candidate))) fail();
  }
  for (const [ordinal, dependency] of references.entries()) {
    await input.assertPinnedInput();
    await input.index.referenceOnce(manifest.bundleId, `${source}:edge:${ordinal}`, dependency);
  }
  await input.assertPinnedInput();
}
