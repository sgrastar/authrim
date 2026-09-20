import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupStepContext } from './operation-executor';
import type { TenantBundleManifest } from './bundle-manifest';
import { encodeTenantBundleManifest } from './bundle-manifest';
import {
  sqliteDatasetInspectionPolicyDescriptor,
  type SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector';
import { TenantBackupContainerInputStore } from './container-input-store';
import { DatabaseTenantBundleReferenceIndex } from './validation-index';

function fail(): never {
  throw new Error('backup_dataset_inspection_receipt_invalid');
}
async function hash(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Record SQL dataset completion only from its persisted EOF phase. This proves one dataset,
 * not the complete input set or its references. Preparation must pin the installed policy.
 */
export async function finalizeSqliteDatasetInspection(
  context: TenantBackupStepContext,
  input: {
    database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
    manifest: TenantBundleManifest;
    policy: SqliteDatasetInspectionPolicy;
    now: () => number;
    assertPinnedInput: () => Promise<void>;
    operationCursorGuard: string;
  }
): Promise<{ manifestSha256: string; policySha256: string; recordCount: number }> {
  const { operation, lease, signal } = context;
  if (
    operation.kind !== 'import' ||
    operation.state !== 'running' ||
    operation.phase !== 'advance_validation_dataset' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    input.manifest.source.tenantId !== lease.tenantId
  )
    fail();
  let cursor: {
    sessionId: string;
    bundleId: string;
    datasetId: string;
    rows: number;
    sourceCursor: string | null;
    version: number;
  };
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null') as typeof cursor;
  } catch {
    return fail();
  }
  if (
    !cursor ||
    Object.keys(cursor).sort().join(',') !==
      'bundleId,datasetId,rows,sessionId,sourceCursor,version' ||
    cursor.version !== 1 ||
    cursor.bundleId !== input.manifest.bundleId ||
    cursor.datasetId !== input.policy.dataset.id ||
    !Number.isSafeInteger(cursor.rows) ||
    cursor.rows < 0 ||
    typeof cursor.sessionId !== 'string' ||
    !cursor.sessionId ||
    (cursor.rows === 0) !== (cursor.sourceCursor === null)
  )
    fail();
  const dataset = input.manifest.datasets.find((item) => item.id === cursor.datasetId);
  if (
    !dataset ||
    !['database', 'kv', 'durable_object', 'object'].includes(dataset.store) ||
    dataset.disposition !== 'include' ||
    Object.keys(input.policy.dataset).some(
      (key) =>
        dataset[key as keyof typeof dataset] !== input.policy.dataset[key as keyof typeof dataset]
    )
  )
    fail();
  const manifestSha256 = await hash(encodeTenantBundleManifest(input.manifest, input.manifest));
  const policySha256 = await hash(
    new TextEncoder().encode(JSON.stringify(sqliteDatasetInspectionPolicyDescriptor(input.policy)))
  );
  signal.throwIfAborted();
  await input.assertPinnedInput();
  await DatabaseTenantBundleReferenceIndex.resume(
    input.database,
    cursor.sessionId,
    lease,
    input.now
  );
  const decoded = await new TenantBackupContainerInputStore(input.database, lease, input.now).load(
    cursor.bundleId
  );
  if (decoded.manifest_sha256 !== manifestSha256) fail();
  const timestamp = input.now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail();
  const params = [
    cursor.sessionId,
    lease.tenantId,
    cursor.bundleId,
    cursor.datasetId,
    manifestSha256,
    policySha256,
    cursor.rows,
  ];
  const live = `EXISTS (SELECT 1 FROM tenant_backup_operations o WHERE o.id=s.operation_id AND o.tenant_id=s.tenant_id AND o.kind='import' AND o.state='running' AND o.phase='advance_validation_dataset' AND o.cursor_json=? AND o.lease_owner=? AND o.fencing_token=? AND s.fencing_token=o.fencing_token AND o.lease_expires_at>? AND o.updated_at<=?)`;
  if (!input.operationCursorGuard) fail();
  const guard = [input.operationCursorGuard, lease.owner, lease.fencingToken, timestamp, timestamp];
  await input.database.queryOne(
    `INSERT INTO tenant_backup_dataset_inspections(session_id,tenant_id,bundle_id,dataset_id,manifest_sha256,policy_sha256,record_count)
    SELECT ?,?,?,?,?,?,? FROM tenant_backup_validation_sessions s WHERE s.id=? AND s.tenant_id=? AND s.operation_id=? AND s.state='open' AND ${live}
    AND (SELECT count(*) FROM tenant_backup_validation_records r WHERE r.session_id=s.id AND r.tenant_id=s.tenant_id AND r.bundle_id=? AND r.collection=? AND r.source_id IS NOT NULL AND instr(r.source_id, ':alias:')=0)=?
    ON CONFLICT(session_id,bundle_id,dataset_id) DO NOTHING RETURNING dataset_id`,
    [
      ...params,
      cursor.sessionId,
      lease.tenantId,
      lease.operationId,
      ...guard,
      cursor.bundleId,
      cursor.datasetId,
      cursor.rows,
    ]
  );
  const saved = await input.database.queryOne<{
    manifest_sha256: string;
    policy_sha256: string;
    record_count: number;
  }>(
    `SELECT d.* FROM tenant_backup_dataset_inspections d JOIN tenant_backup_validation_sessions s ON s.id=d.session_id AND s.tenant_id=d.tenant_id WHERE d.session_id=? AND d.tenant_id=? AND d.bundle_id=? AND d.dataset_id=? AND ${live}`,
    [cursor.sessionId, lease.tenantId, cursor.bundleId, cursor.datasetId, ...guard]
  );
  if (
    !saved ||
    saved.manifest_sha256 !== manifestSha256 ||
    saved.policy_sha256 !== policySha256 ||
    saved.record_count !== cursor.rows
  )
    fail();
  await input.assertPinnedInput();
  signal.throwIfAborted();
  return { manifestSha256, policySha256, recordCount: cursor.rows };
}

/** Record consecutive authenticated datasets in one D1 batch and one operation slice. */
export async function finalizeSqliteDatasetBatchInspections(
  context: TenantBackupStepContext,
  input: {
    database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute' | 'batch'>;
    manifest: TenantBundleManifest;
    datasets: readonly { policy: SqliteDatasetInspectionPolicy; recordCount: number }[];
    sessionId: string;
    now: () => number;
    assertPinnedInput: () => Promise<void>;
    operationCursorGuard: string;
  }
): Promise<void> {
  const { operation, lease, signal } = context;
  if (
    operation.kind !== 'import' ||
    operation.state !== 'running' ||
    operation.phase !== 'validate_input_modules' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    input.manifest.source.tenantId !== lease.tenantId ||
    !input.datasets.length ||
    input.datasets.length > 256 ||
    !input.operationCursorGuard
  )
    fail();
  const manifestSha256 = await hash(encodeTenantBundleManifest(input.manifest, input.manifest));
  const entries = await Promise.all(
    input.datasets.map(async ({ policy, recordCount }) => {
      const dataset = input.manifest.datasets.find((item) => item.id === policy.dataset.id);
      if (
        !dataset ||
        dataset.disposition !== 'include' ||
        Object.keys(policy.dataset).some(
          (key) =>
            dataset[key as keyof typeof dataset] !== policy.dataset[key as keyof typeof dataset]
        )
      )
        fail();
      if (!Number.isSafeInteger(recordCount) || recordCount < 0 || recordCount > 500) fail();
      return {
        datasetId: dataset.id,
        recordCount,
        policySha256: await hash(
          new TextEncoder().encode(JSON.stringify(sqliteDatasetInspectionPolicyDescriptor(policy)))
        ),
      };
    })
  );
  if (new Set(entries.map(({ datasetId }) => datasetId)).size !== entries.length) fail();
  signal.throwIfAborted();
  await input.assertPinnedInput();
  await DatabaseTenantBundleReferenceIndex.resume(
    input.database,
    input.sessionId,
    lease,
    input.now
  );
  const decoded = await new TenantBackupContainerInputStore(input.database, lease, input.now).load(
    input.manifest.bundleId
  );
  if (decoded.manifest_sha256 !== manifestSha256) fail();
  const timestamp = input.now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail();
  const live = `EXISTS (SELECT 1 FROM tenant_backup_operations o WHERE o.id=s.operation_id AND o.tenant_id=s.tenant_id AND o.kind='import' AND o.state='running' AND o.phase='validate_input_modules' AND o.cursor_json=? AND o.lease_owner=? AND o.fencing_token=? AND s.fencing_token=o.fencing_token AND o.lease_expires_at>? AND o.updated_at<=?)`;
  const guard = [input.operationCursorGuard, lease.owner, lease.fencingToken, timestamp, timestamp];
  const results = await input.database.batch(
    entries.map(({ datasetId, policySha256, recordCount }) => ({
      sql: `INSERT INTO tenant_backup_dataset_inspections(session_id,tenant_id,bundle_id,dataset_id,manifest_sha256,policy_sha256,record_count)
        SELECT ?,?,?,?,?,?,? FROM tenant_backup_validation_sessions s WHERE s.id=? AND s.tenant_id=? AND s.operation_id=? AND s.state='open' AND ${live}
        AND (SELECT count(*) FROM tenant_backup_validation_records r WHERE r.session_id=s.id AND r.tenant_id=s.tenant_id AND r.bundle_id=? AND r.collection=? AND r.source_id IS NOT NULL AND instr(r.source_id, ':alias:')=0)=?
        ON CONFLICT(session_id,bundle_id,dataset_id) DO NOTHING`,
      params: [
        input.sessionId,
        lease.tenantId,
        input.manifest.bundleId,
        datasetId,
        manifestSha256,
        policySha256,
        recordCount,
        input.sessionId,
        lease.tenantId,
        lease.operationId,
        ...guard,
        input.manifest.bundleId,
        datasetId,
        recordCount,
      ],
    }))
  );
  if (results.length !== entries.length || results.some((result) => !result.success)) fail();
  const saved = await input.database.query<{
    dataset_id: string;
    policy_sha256: string;
    record_count: number;
  }>(
    `SELECT dataset_id,policy_sha256,record_count FROM tenant_backup_dataset_inspections
     WHERE session_id=? AND tenant_id=? AND bundle_id=?`,
    [input.sessionId, lease.tenantId, input.manifest.bundleId]
  );
  const byId = new Map(saved.map((row) => [row.dataset_id, row]));
  if (
    entries.some((entry) => {
      const row = byId.get(entry.datasetId);
      return row?.policy_sha256 !== entry.policySha256 || row.record_count !== entry.recordCount;
    })
  )
    fail();
  await input.assertPinnedInput();
  signal.throwIfAborted();
}
