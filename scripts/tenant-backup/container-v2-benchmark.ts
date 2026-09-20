import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, no-console -- Node 22 node:sqlite is runtime-required but absent from the shared Node 20 declarations; this CLI prints its benchmark result. */
// Node 22 provides node:sqlite; this repository's shared Node 20 declarations do not list it yet.
// @ts-expect-error node:sqlite is available in the required Node >=22 runtime.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  decodeTenantBackupContainerV2,
  encodeTenantBackupContainerV2,
  type TenantBackupContainerDatasetSourceV2,
} from '../../packages/ar-lib-core/src/services/tenant-portability/backup-container-v2.js';
import { createTenantBundleKeyEnvelope } from '../../packages/ar-lib-core/src/services/tenant-portability/bundle-key-envelope.js';
import type { TenantBundleManifest } from '../../packages/ar-lib-core/src/services/tenant-portability/bundle-manifest.js';
import { readSqliteRestoreSeedFingerprint } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-restore-seed.js';
import {
  SqliteRestoreTarget,
  type SqliteRestoreTargetIdentity,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-restore-target.js';
import type { SqliteDatasetInspectionPolicy } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-dataset-inspector.js';
import { buildTenantBackupDatasetExecutionPlan } from '../../packages/ar-lib-core/src/services/tenant-portability/dataset-execution-plan.js';

const encoder = new TextEncoder();
const emptyDatasetCount = 305;
const rowCount = 600;
const tenantId = 'tenant-benchmark';

function elapsed(started: number): number {
  return Number((performance.now() - started).toFixed(3));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hash(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))));
}

const rows = Array.from({ length: rowCount }, (_, index) =>
  JSON.stringify({
    id: ['text', `user-${index.toString().padStart(4, '0')}`],
    tenant_id: ['text', tenantId],
    payload: ['text', `${index}:`.padEnd(940, 'x')],
  })
);
const datasetBytes = encoder.encode(`${rows.join('\n')}\n`);
const datasetId = 'core.benchmark_users';
const emptyIds = Array.from({ length: emptyDatasetCount }, (_, index) => `core.empty_${index}`);
const key = await createTenantBundleKeyEnvelope('local v2 benchmark password');
const manifest: TenantBundleManifest = {
  formatVersion: 1,
  bundleId: hex(key.envelope.subarray(1, 17)),
  source: { tenantId, issuer: 'https://benchmark.invalid', productVersion: '0.4.2' },
  snapshotId: 'benchmark-t0',
  boundaryUnixMs: 1,
  inventoryDigestSha256: 'a'.repeat(64),
  selection: {
    settings: true,
    users: true,
    admin: true,
    artifacts: false,
    logs: { audit: true, other: true, sensitive: false, period: 'all' },
  },
  datasets: [datasetId, ...emptyIds].map((id) => ({
    id,
    module: 'users',
    kind: 'users',
    store: 'database',
    schemaVersion: 1,
    disposition: 'include',
  })),
};
const executionPlan = buildTenantBackupDatasetExecutionPlan(
  manifest.datasets.map((dataset, index) => ({
    dataset,
    targetId: 'benchmark-d1',
    rows: index === 0 ? rowCount : 0,
    bytes: index === 0 ? datasetBytes.length : 0,
  }))
);

async function* sources(): AsyncGenerator<TenantBackupContainerDatasetSourceV2> {
  yield {
    datasetId,
    chunks: (async function* () {
      yield datasetBytes;
    })(),
  };
  for (const id of emptyIds)
    yield {
      datasetId: id,
      chunks: (async function* () {})(),
    };
}

const exportStarted = performance.now();
const encoded = await encodeTenantBackupContainerV2({
  manifest,
  datasets: sources(),
  session: key,
});
const exportMs = elapsed(exportStarted);
assert.equal(encoded.parts.length, 1);

const uploadStarted = performance.now();
const r2Object = new Uint8Array(encoded.parts[0]);
const transportHash = await hash(r2Object);
const uploadMs = elapsed(uploadStarted);

const verifyStarted = performance.now();
assert.equal(await hash(r2Object), transportHash);
const decoded = await decodeTenantBackupContainerV2({ parts: [r2Object], session: key });
const verified = decoded.datasets.get(datasetId);
assert(verified);
assert.equal(await hash(verified), await hash(datasetBytes));
assert(decoded.manifest.datasets.slice(1).every((dataset) => dataset.rows === 0));
const verifyMs = elapsed(verifyStarted);

const db = new DatabaseSync(':memory:');
let d1BatchCalls = 0;
try {
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(
    readFileSync(
      new URL('../../migrations/core/d1/010_tenant_backup_restore_target.sql', import.meta.url),
      'utf8'
    )
  );
  db.exec(
    readFileSync(
      new URL(
        '../../migrations/core/d1/011_tenant_backup_restore_target_cancellation.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  db.exec(
    'CREATE TABLE benchmark_users(id TEXT NOT NULL PRIMARY KEY,tenant_id TEXT NOT NULL,payload TEXT NOT NULL)'
  );
  const database = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = db.prepare(sql).run(...(params as SQLInputValue[]));
      return { success: true, rowsAffected: Number(result.changes) };
    },
    async batch(statements: { sql: string; params?: unknown[] }[]) {
      d1BatchCalls += 1;
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params = [] }) => {
          const result = db.prepare(sql).run(...(params as SQLInputValue[]));
          return { success: true, rowsAffected: Number(result.changes) };
        });
        db.exec('COMMIT');
        return results;
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
    },
  };
  const seedFingerprint = await readSqliteRestoreSeedFingerprint(database, async () => {});
  const identity: SqliteRestoreTargetIdentity = {
    id: 'benchmark-stage',
    tenantId,
    operationId: 'benchmark-import',
    resourceId: 'benchmark-isolated-db',
    planDigest: 'b'.repeat(64),
    seedFingerprint,
  };
  const policy: SqliteDatasetInspectionPolicy = {
    dataset: manifest.datasets[0],
    schema: {
      table: 'benchmark_users',
      columns: ['id', 'tenant_id', 'payload'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    async inspectRow() {
      return [];
    },
  };
  const target = await SqliteRestoreTarget.open({
    database,
    identity,
    lease: { owner: 'benchmark-worker', fencingToken: 1, expiresAt: 60_000 },
    now: () => 1,
    authorize: async () => {},
    readSeedFingerprint: async () => seedFingerprint,
  });
  const restoreStarted = performance.now();
  for (let offset = 0; offset < rows.length; offset += 250)
    await target.writeRows(policy, manifest, rows.slice(offset, offset + 250));
  const restored = db.prepare('SELECT count(*) AS count FROM benchmark_users').get() as {
    count: number;
  };
  assert.equal(restored.count, rowCount);
  const restoreMs = elapsed(restoreStarted);
  const totalMs = exportMs + uploadMs + verifyMs + restoreMs;
  console.log(
    JSON.stringify(
      {
        formatVersion: 2,
        sourceBytes: datasetBytes.length,
        rows: rowCount,
        registeredDatasets: executionPlan.registeredDatasets.length,
        materializedDatasets: executionPlan.materializedDatasets.length,
        nonEmptyDatasets: executionPlan.nonEmptyDatasets.length,
        executionBatches: executionPlan.executionBatches.length,
        emptyDatasets: emptyDatasetCount,
        r2Objects: encoded.parts.length,
        encryptedObjectBytes: r2Object.length,
        d1BatchCalls,
        timingsMs: {
          export: exportMs,
          uploadAndTransportHash: uploadMs,
          importVerify: verifyMs,
          restore: restoreMs,
          total: Number(totalMs.toFixed(3)),
        },
      },
      null,
      2
    )
  );
} finally {
  db.close();
}
