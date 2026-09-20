import { readNextShardedSqliteDatasetChunk } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-sharded-dataset-reader.js';
import { saveTenantBackupExportManifest } from '../../packages/ar-lib-core/src/services/tenant-portability/export-manifest-store.js';
import { runPrepareTenantBackupArtifactStep } from '../../packages/ar-lib-core/src/services/tenant-portability/prepare-artifact-step.js';
import { runPreparedSnapshotBoundaryStep } from '../../packages/ar-lib-core/src/services/tenant-portability/snapshot-boundary-step.js';
import { TenantBackupBoundaryReceipts } from '../../packages/ar-lib-core/src/services/tenant-portability/boundary-receipts.js';
import { TenantBackupMutationAdmission } from '../../packages/ar-lib-core/src/services/tenant-portability/mutation-admission.js';
import { runSqliteResourcePreparationStep } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-resource-preparation.js';
import { runSqliteResourceDiscoveryStep } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-resource-discovery.js';
import { cleanupExpiredTenantBackupArtifact } from '../../packages/ar-lib-core/src/services/tenant-portability/expired-artifact-cleanup.js';
import { openTenantBackupDownload } from '../../packages/ar-lib-core/src/services/tenant-portability/published-artifact-reader.js';
import { runTenantBackupArtifactPublicationStep } from '../../packages/ar-lib-core/src/services/tenant-portability/publish-artifact-step.js';
import { finalizeTenantBackupInputValidation } from '../../packages/ar-lib-core/src/services/tenant-portability/finalize-input-validation.js';
import { finalizeSqliteDatasetInspection } from '../../packages/ar-lib-core/src/services/tenant-portability/dataset-inspection-receipt.js';
import { runTenantBackupReferenceValidationStep } from '../../packages/ar-lib-core/src/services/tenant-portability/validate-references-step.js';
import { runSqliteInputValidationStep } from '../../packages/ar-lib-core/src/services/tenant-portability/validate-sqlite-input-step.js';
import { validateTenantBackupReferencePage } from '../../packages/ar-lib-core/src/services/tenant-portability/validate-reference-page.js';
import { inspectSqliteInputRow } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-input-inspection.js';
import {
  persistTenantBackupInput,
  runPlannedTenantBackupInputDecodeStep,
} from '../../packages/ar-lib-core/src/services/tenant-portability/input-plan.js';
import { readNextSqliteInputRow } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-input-row-source.js';
import { TenantBackupInputReceipts } from '../../packages/ar-lib-core/src/services/tenant-portability/input-receipts.js';
import {
  decodeTenantBackupInputStep,
  type TenantBackupInputDecodeCheckpoint,
} from '../../packages/ar-lib-core/src/services/tenant-portability/input-decode-step.js';
import { readTenantBackupInputFrame } from '../../packages/ar-lib-core/src/services/tenant-portability/input-frame-reader.js';
import { TenantBundleContentDecoder } from '../../packages/ar-lib-core/src/services/tenant-portability/bundle-content-decoder.js';
import { TenantBundleCipherDecoder } from '../../packages/ar-lib-core/src/services/tenant-portability/bundle-cipher-decoder.js';
import { decodeTenantBundleFrames } from '../../packages/ar-lib-core/src/services/tenant-portability/bundle-framing.js';
import {
  persistSqliteRestoreSequence,
  runSqliteRestoreSequenceStep,
} from '../../packages/ar-lib-core/src/services/tenant-portability/restore-sqlite-sequence.js';
import { DatabaseTenantBackupRestorePlanInventory } from '../../packages/ar-lib-core/src/services/tenant-portability/restore-plan-inventory.js';
import {
  persistInitializedSqliteRestoreTarget,
  openPlannedSqliteRestoreTarget,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-restore-plan.js';
import { createSqliteDatasetInspectorFactory } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-dataset-inspector.js';
import { runTenantBackupArtifactVerificationStep } from '../../packages/ar-lib-core/src/services/tenant-portability/verify-artifact-step.js';
import { runTenantBackupArtifactStep } from '../../packages/ar-lib-core/src/services/tenant-portability/export-artifact-step.js';
import { readTenantBackupArtifact } from '../../packages/ar-lib-core/src/services/tenant-portability/artifact-reader.js';
import { readNextSqliteSnapshotChunk } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-dataset-source.js';
import { TenantBackupCipherJournal } from '../../packages/ar-lib-core/src/services/tenant-portability/cipher-journal.js';
import { decryptTenantBundleStream } from '../../packages/ar-lib-core/src/services/tenant-portability/bundle-cipher.js';
import { TenantBackupSnapshotResources } from '../../packages/ar-lib-core/src/services/tenant-portability/snapshot-resources.js';
import { executeTenantBackupSlice } from '../../packages/ar-lib-core/src/services/tenant-portability/operation-executor.js';
import {
  invalidateSqliteBackupSnapshot,
  cleanupSqliteBackupSnapshotPage,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-snapshot-cleanup.js';
import { readBackupSqliteDatabaseSchema } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-schema-reader.js';
import {
  persistSqliteTenantDatasetPlan,
  verifyLiveSqliteTenantDatasetPlan,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-dataset-plan.js';
import { TenantBackupExecutionInventory } from '../../packages/ar-lib-core/src/services/tenant-portability/execution-inventory.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readSqliteSnapshotDataset } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-dataset-source.js';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotTriggers,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-snapshot.js';
import { TenantBackupArtifactWriter } from '../../packages/ar-lib-core/src/services/tenant-portability/artifact-writer.js';
import { runTenantBackupScheduler } from '../../packages/ar-lib-core/src/services/tenant-portability/operation-scheduler.js';
import { TenantBackupRequestStore } from '../../packages/ar-lib-core/src/services/tenant-portability/operation-request.js';
import { TenantBackupOperationKeyStore } from '../../packages/ar-lib-core/src/services/tenant-portability/operation-key-store.js';
import { createTenantBundleKeyEnvelope } from '../../packages/ar-lib-core/src/services/tenant-portability/bundle-key-envelope.js';
import { TenantBackupOperationStore } from '../../packages/ar-lib-core/src/services/tenant-portability/operation-store.js';
import { DatabaseTenantBundleReferenceIndex } from '../../packages/ar-lib-core/src/services/tenant-portability/validation-index.js';
import { splitMigrationSql } from '../../packages/ar-lib-core/src/services/control-plane/migration-sql.js';
import type { DatabaseAdapter } from '../../packages/ar-lib-core/src/db/adapter.js';

const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))(
  'miniflare'
) as typeof import('miniflare');
const runtime = new Miniflare({
  modules: true,
  script: 'export default {};',
  compatibilityDate: '2026-07-08',
  host: '127.0.0.1',
  d1Databases: ['FIXTURE_ADMIN', 'FIXTURE_CORE', 'FIXTURE_RESTORE', 'FIXTURE_CONTROL'],
  r2Buckets: ['FIXTURE_BACKUPS'],
});
try {
  const control = await runtime.getD1Database('FIXTURE_CONTROL');
  const admissionSql = readFileSync(
    new URL(
      '../../migrations/control/d1/005_tenant_backup_mutation_admission.sql',
      import.meta.url
    ),
    'utf8'
  );
  await control.batch(
    splitMigrationSql(admissionSql).map((statement) => control.prepare(statement))
  );
  const environmentAdmissionSql = readFileSync(
    new URL(
      '../../migrations/control/d1/006_tenant_backup_mutation_environment_scope.sql',
      import.meta.url
    ),
    'utf8'
  );
  await control.batch(
    splitMigrationSql(environmentAdmissionSql).map((statement) => control.prepare(statement))
  );
  const receiptSql = readFileSync(
    new URL('../../migrations/control/d1/007_tenant_backup_boundary_receipts.sql', import.meta.url),
    'utf8'
  );
  await control.batch(splitMigrationSql(receiptSql).map((statement) => control.prepare(statement)));
  const snapshotTimestampSql = readFileSync(
    new URL(
      '../../migrations/control/d1/010_tenant_backup_snapshot_timestamp.sql',
      import.meta.url
    ),
    'utf8'
  );
  await control.batch(
    splitMigrationSql(snapshotTimestampSql).map((statement) => control.prepare(statement))
  );
  const admissionDatabase = {
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return control
        .prepare(sql)
        .bind(...params)
        .first<T>();
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = await control
        .prepare(sql)
        .bind(...params)
        .run();
      return { success: result.success, rowsAffected: result.meta.changes ?? 0 };
    },
  };
  const admission = new TenantBackupMutationAdmission(admissionDatabase);
  assert(await admission.acquire('tenant-a', 'writer-in-flight', 1));
  const admissionRequest = {
    tenantId: 'tenant-a',
    operationId: 'backup',
    inventoryDigest: 'ab'.repeat(32),
    now: 10,
  };
  const competingBoundaries = await Promise.all([
    admission.begin({ ...admissionRequest, id: 'boundary-a' }),
    admission.begin({ ...admissionRequest, id: 'boundary-b' }),
  ]);
  assert.equal(competingBoundaries.filter(Boolean).length, 1);
  const winner = competingBoundaries.find(Boolean);
  assert(winner);
  assert.equal(await admission.hold('tenant-a', winner.id, 11), null);
  assert.equal(await admission.acquire('tenant-a', 'new-writer', 11), false);
  assert(await admission.acquire('tenant-b', 'other-tenant-writer', 11));
  await admission.complete('tenant-a', 'writer-in-flight', 12);
  assert.equal(
    (await new TenantBackupMutationAdmission(admissionDatabase).hold('tenant-a', winner.id, 13))
      ?.state,
    'held'
  );
  assert.equal(await admission.hold('tenant-a', winner.id, 2010), null);
  assert(await admission.acquire('tenant-a', 'new-writer', 2010));
  assert.equal(await admission.begin({ ...admissionRequest, id: winner.id, now: 2011 }), null);
  await admission.complete('tenant-b', 'other-tenant-writer', 2012);
  await admission.complete('tenant-a', 'new-writer', 2012);
  const sharedAdmission = new TenantBackupMutationAdmission(admissionDatabase, 'shared-env');
  assert(await sharedAdmission.acquireEnvironment('shared-writer', 3001));
  await sharedAdmission.begin({ ...admissionRequest, now: 3010, id: 'shared-tenant-a' });
  await sharedAdmission.begin({
    ...admissionRequest,
    now: 3010,
    id: 'shared-tenant-b',
    tenantId: 'tenant-b',
  });
  assert.equal(await sharedAdmission.hold('tenant-a', 'shared-tenant-a', 3011), null);
  assert.equal(await sharedAdmission.hold('tenant-b', 'shared-tenant-b', 3011), null);
  await sharedAdmission.completeEnvironment('shared-writer', 3012);
  assert.equal((await sharedAdmission.hold('tenant-a', 'shared-tenant-a', 3013))?.state, 'held');
  assert.equal((await sharedAdmission.hold('tenant-b', 'shared-tenant-b', 3013))?.state, 'held');
  assert.equal(await sharedAdmission.acquireEnvironment('another-shared-writer', 3014), false);
  const receipts = new TenantBackupBoundaryReceipts(admissionDatabase);
  const receiptIdentity = {
    environmentId: 'receipt-env',
    tenantId: 'tenant-a',
    boundaryId: 'receipt-boundary',
    operationId: 'backup',
    inventoryDigest: 'ab'.repeat(32),
  };
  const receiptAdmission = new TenantBackupMutationAdmission(admissionDatabase, 'receipt-env');
  await receiptAdmission.begin({ ...admissionRequest, id: receiptIdentity.boundaryId, now: 4000 });
  const participants = [
    { resourceId: 'core', snapshotId: 'core-snapshot' },
    { resourceId: 'pii', snapshotId: 'pii-snapshot' },
  ];
  assert(await receipts.plan(receiptIdentity, participants, 4001));
  assert(await receiptAdmission.hold('tenant-a', receiptIdentity.boundaryId, 4002));
  assert(await receipts.acknowledge(receiptIdentity, participants[0], 4003));
  assert.equal(await receipts.release(receiptIdentity, 4004), null);
  assert(await receipts.acknowledge(receiptIdentity, participants[1], 4005));
  assert.equal((await receipts.release(receiptIdentity, 4006))?.released_at, 4006);
  assert.equal(
    (await new TenantBackupBoundaryReceipts(admissionDatabase).release(receiptIdentity, 9000))
      ?.released_at,
    4006
  );
  assert(await receiptAdmission.acquire('tenant-a', 'after-release', 4007));
  const db = await runtime.getD1Database('FIXTURE_ADMIN');
  const sql = readFileSync(
    new URL('../../migrations/admin/d1/003_tenant_backup_operations.sql', import.meta.url),
    'utf8'
  );
  await db.batch(splitMigrationSql(sql).map((statement) => db.prepare(statement)));
  const indexSql = readFileSync(
    new URL('../../migrations/admin/d1/004_tenant_backup_validation_index.sql', import.meta.url),
    'utf8'
  );
  await db.batch(splitMigrationSql(indexSql).map((statement) => db.prepare(statement)));
  const keySql = readFileSync(
    new URL('../../migrations/admin/d1/005_tenant_backup_key_handoffs.sql', import.meta.url),
    'utf8'
  );
  await db.batch(splitMigrationSql(keySql).map((statement) => db.prepare(statement)));
  const requestSql = readFileSync(
    new URL('../../migrations/admin/d1/006_tenant_backup_request_intent.sql', import.meta.url),
    'utf8'
  );
  await db.batch(splitMigrationSql(requestSql).map((statement) => db.prepare(statement)));
  const activeKeySql = readFileSync(
    new URL('../../migrations/admin/d1/007_tenant_backup_active_key.sql', import.meta.url),
    'utf8'
  );
  await db.batch(splitMigrationSql(activeKeySql).map((statement) => db.prepare(statement)));
  const retrySql = readFileSync(
    new URL('../../migrations/admin/d1/008_tenant_backup_retry_state.sql', import.meta.url),
    'utf8'
  );
  await db.batch(splitMigrationSql(retrySql).map((statement) => db.prepare(statement)));
  const artifactSql = readFileSync(
    new URL('../../migrations/admin/d1/009_tenant_backup_artifact_parts.sql', import.meta.url),
    'utf8'
  );
  await db.batch(splitMigrationSql(artifactSql).map((statement) => db.prepare(statement)));
  const inventorySql = readFileSync(
    new URL('../../migrations/admin/d1/010_tenant_backup_execution_inventory.sql', import.meta.url),
    'utf8'
  );
  await db.batch(splitMigrationSql(inventorySql).map((statement) => db.prepare(statement)));
  await db.batch(
    splitMigrationSql(
      readFileSync(
        new URL('../../migrations/admin/d1/015_tenant_backup_input_receipts.sql', import.meta.url),
        'utf8'
      )
    ).map((statement) => db.prepare(statement))
  );
  await db.batch(
    splitMigrationSql(
      readFileSync(
        new URL(
          '../../migrations/admin/d1/016_tenant_backup_input_dataset_boundaries.sql',
          import.meta.url
        ),
        'utf8'
      )
    ).map((statement) => db.prepare(statement))
  );
  await db.batch(
    splitMigrationSql(
      readFileSync(
        new URL(
          '../../migrations/admin/d1/017_tenant_backup_validation_record_sources.sql',
          import.meta.url
        ),
        'utf8'
      )
    ).map((statement) => db.prepare(statement))
  );
  await db.batch(
    splitMigrationSql(
      readFileSync(
        new URL(
          '../../migrations/admin/d1/018_tenant_backup_dataset_inspections.sql',
          import.meta.url
        ),
        'utf8'
      )
    ).map((statement) => db.prepare(statement))
  );
  await db.batch(
    splitMigrationSql(
      readFileSync(
        new URL(
          '../../migrations/admin/d1/019_tenant_backup_input_validations.sql',
          import.meta.url
        ),
        'utf8'
      )
    ).map((statement) => db.prepare(statement))
  );
  await db.batch(
    splitMigrationSql(
      readFileSync(
        new URL('../../migrations/admin/d1/020_tenant_backup_publications.sql', import.meta.url),
        'utf8'
      )
    ).map((statement) => db.prepare(statement))
  );
  await db.batch(
    splitMigrationSql(
      readFileSync(
        new URL(
          '../../migrations/admin/d1/024_tenant_backup_restore_plan_inventory.sql',
          import.meta.url
        ),
        'utf8'
      )
    ).map((statement) => db.prepare(statement))
  );
  for (const file of [
    '031_tenant_backup_r2_restores.sql',
    '032_tenant_backup_r2_log_record_maps.sql',
  ]) {
    const migration = readFileSync(
      new URL(`../../migrations/admin/d1/${file}`, import.meta.url),
      'utf8'
    );
    await db.batch(splitMigrationSql(migration).map((statement) => db.prepare(statement)));
  }
  const r2RestoreColumns = await db
    .prepare("PRAGMA table_info('tenant_backup_r2_restore_objects')")
    .all<{ name: string }>();
  assert(r2RestoreColumns.results.some(({ name }) => name === 'log_records_json'));
  const adapter: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute' | 'batch'> = {
    async query<T>(sql: string, params: unknown[] = []) {
      return (
        await db
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results;
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return db
        .prepare(sql)
        .bind(...params)
        .first<T>();
    },
    async execute(sql, params = []) {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .run();
      return { success: result.success, rowsAffected: result.meta.changes };
    },
    async batch(statements) {
      const results = await db.batch(
        statements.map(({ sql, params = [] }) => db.prepare(sql).bind(...params))
      );
      return results.map((result) => ({
        success: result.success,
        rowsAffected: result.meta.changes ?? 0,
      }));
    },
  };
  const store = new TenantBackupOperationStore(adapter);
  const request = {
    id: 'operation',
    tenantId: 'tenant-a',
    kind: 'export' as const,
    idempotencyKey: 'request',
    requestDigest: 'ab'.repeat(32),
    actorId: 'admin',
    now: 100,
  };
  await store.create(request);
  await assert.rejects(
    db.prepare('UPDATE tenant_backup_operations SET id=NULL WHERE id=?').bind('operation').run(),
    /NOT NULL/
  );
  const first = await store.claim('tenant-a', 'operation', 'worker-a', 101);
  assert(first);
  const lease = {
    tenantId: 'tenant-a',
    operationId: 'operation',
    owner: 'worker-a',
    fencingToken: first.fencing_token,
  };
  const saved = await store.checkpoint(lease, first.revision, 'capture', '{"page":1}', 102);
  assert(saved);
  const restarted = new TenantBackupOperationStore(adapter);
  assert.equal((await restarted.get('tenant-a', 'operation'))?.cursor_json, '{"page":1}');
  assert.equal(await restarted.claim('tenant-a', 'operation', 'worker-b', 103), null);
  const claimed = await restarted.claim('tenant-a', 'operation', 'worker-b', 30102);
  assert.equal(claimed?.fencing_token, first.fencing_token + 1);
  assert.equal(await store.checkpoint(lease, saved.revision, 'capture', '{"page":2}', 30103), null);
  assert.equal(await store.get('tenant-b', 'operation'), null);
  const cancelled = await restarted.requestCancel('tenant-a', 'operation', 30104);
  assert.equal(cancelled?.state, 'cancelling');
  assert.equal(await restarted.claim('tenant-a', 'operation', 'worker-c', 70000), null);
  const cleanup = await restarted.claimCancellation('tenant-a', 'operation', 'cleaner', 70001);
  assert(cleanup);
  const cleanupLease = {
    tenantId: 'tenant-a',
    operationId: 'operation',
    owner: 'cleaner',
    fencingToken: cleanup.fencing_token,
  };
  const savedCleanup = await restarted.checkpointCancellation(
    cleanupLease,
    cleanup.revision,
    '{"object":1}',
    70002
  );
  assert(savedCleanup);
  const yielded = await restarted.yieldCancellation(cleanupLease, savedCleanup.revision, 70003);
  assert.equal(yielded?.lease_owner, null);
  assert.equal(
    await restarted.finishCancellation(cleanupLease, savedCleanup.revision, 70004),
    null
  );
  const cleanupAgain = await store.claimCancellation('tenant-a', 'operation', 'cleaner-new', 70004);
  assert(cleanupAgain);
  assert.equal(cleanupAgain.cursor_json, '{"object":1}');
  const terminal = await store.finishCancellation(
    { ...cleanupLease, owner: 'cleaner-new', fencingToken: cleanupAgain.fencing_token },
    cleanupAgain.revision,
    70005
  );
  assert.equal(terminal?.state, 'cancelled');
  await store.create({ ...request, id: 'validation', idempotencyKey: 'validation', now: 80000 });
  const validation = await store.claim('tenant-a', 'validation', 'validator', 80001);
  assert(validation);
  const index = await DatabaseTenantBundleReferenceIndex.create(
    adapter,
    {
      tenantId: 'tenant-a',
      operationId: 'validation',
      owner: 'validator',
      fencingToken: validation.fencing_token,
    },
    () => 80002
  );
  const identity = {
    tenantId: 'tenant-a',
    module: 'applications',
    collection: 'clients',
    id: 'client',
  };
  assert.equal(await index.record('bundle-a', identity), true);
  assert.equal(await index.record('bundle-b', identity), false);
  assert.equal(await index.hasRecord(identity, 'bundle-a'), true);
  assert.equal(await index.hasRecord(identity, 'bundle-b'), false);
  for (let i = 0; i < 105; i++) {
    await index.reference('bundle-a', {
      from: identity,
      to: { ...identity, meaning: 'resource', requirement: 'required' },
    });
  }
  let edges = 0;
  for await (const edge of index.references()) {
    assert.equal(await index.hasRecord(edge.dependency.to), true);
    edges++;
  }
  assert.equal(edges, 105);
  assert.equal(await index.record('bundle-a', { ...identity, id: 'late' }), false);
  await store.requestCancel('tenant-a', 'validation', 80002);
  await assert.rejects(index.hasRecord(identity), /fenced/);
  await index.dispose();
  assert.equal(
    (
      await db
        .prepare('SELECT count(*) AS n FROM tenant_backup_validation_references')
        .first<{ n: number }>()
    )?.n,
    5
  );
  const indexCleanup = await store.claimCancellation(
    'tenant-a',
    'validation',
    'index-cleaner',
    80003
  );
  assert(indexCleanup);
  const indexCleanupLease = {
    tenantId: 'tenant-a',
    operationId: 'validation',
    owner: 'index-cleaner',
    fencingToken: indexCleanup.fencing_token,
  };
  assert.deepEqual(
    await DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(
      adapter,
      indexCleanupLease,
      () => 80004
    ),
    { found: true, done: true }
  );
  assert.deepEqual(
    await DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(
      adapter,
      indexCleanupLease,
      () => 80004
    ),
    { found: false, done: true }
  );
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
  await store.create({
    ...request,
    id: 'key-operation',
    idempotencyKey: 'key-operation',
    now: 90000,
  });
  const wrapping = {
    id: 'fixture-v1',
    key: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  };
  const keys = new TenantBackupOperationKeyStore(adapter, wrapping);
  const offer = await keys.issue('tenant-a', 'key-operation', 'admin', 90001);
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    offer.publicKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const session = await createTenantBundleKeyEnvelope('local fixture backup key password', {
    publicKey,
    context: offer.context,
  });
  assert(session.handoff);
  await keys.accept(
    'tenant-a',
    'key-operation',
    'admin',
    offer.context.challengeId,
    session.envelope,
    session.handoff,
    90002
  );
  await assert.rejects(
    keys.accept(
      'tenant-a',
      'key-operation',
      'admin',
      offer.context.challengeId,
      session.envelope,
      session.handoff,
      90003
    )
  );
  const keyRun = await store.claim('tenant-a', 'key-operation', 'key-worker', 90004);
  assert(keyRun);
  const keyLease = {
    tenantId: 'tenant-a',
    operationId: 'key-operation',
    owner: 'key-worker',
    fencingToken: keyRun.fencing_token,
  };
  const restartedKeys = new TenantBackupOperationKeyStore(adapter, wrapping);
  assert.equal(
    (await restartedKeys.load(keyLease, offer.context.challengeId, 90005)).contentKey.extractable,
    false
  );
  await store.requestCancel('tenant-a', 'key-operation', 90006);
  await assert.rejects(restartedKeys.load(keyLease, offer.context.challengeId, 90007));
  assert.equal(await restartedKeys.cleanupPage(90007), 1);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
  const requests = new TenantBackupRequestStore(adapter);
  const intent = {
    version: 1,
    kind: 'export',
    source: { tenantId: 'tenant-a', issuer: 'https://fixture.example', productVersion: '0.4.2' },
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
    },
    inputs: [],
  };
  const created = await requests.create({
    id: 'intent-operation',
    tenantId: 'tenant-a',
    actorId: 'admin',
    idempotencyKey: 'intent',
    intent,
    now: 100000,
  });
  assert.equal(created.state, 'waiting');
  assert.equal(await store.claim('tenant-a', created.id, 'worker', 100001), null);
  assert.deepEqual(
    await new TenantBackupRequestStore(adapter).load('tenant-a', created.id),
    intent
  );
  await assert.rejects(
    db
      .prepare("UPDATE tenant_backup_operations SET request_json='{}' WHERE id=?")
      .bind(created.id)
      .run(),
    /immutable/
  );
  const startOffer = await keys.issue('tenant-a', created.id, 'admin', 100001);
  const startPublicKey = await crypto.subtle.importKey(
    'jwk',
    startOffer.publicKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const startSession = await createTenantBundleKeyEnvelope('local fixture password for start', {
    publicKey: startPublicKey,
    context: startOffer.context,
  });
  assert(startSession.handoff);
  const startInput = {
    tenantId: 'tenant-a',
    operationId: created.id,
    actorId: 'admin',
    challengeId: startOffer.context.challengeId,
    revision: 0,
    now: 100004,
  };
  assert.equal(await requests.start(startInput), null);
  await keys.accept(
    'tenant-a',
    created.id,
    'admin',
    startOffer.context.challengeId,
    startSession.envelope,
    startSession.handoff,
    100003
  );
  assert.equal((await requests.start(startInput))?.state, 'queued');
  assert.equal(await requests.start(startInput), null);
  let activeKeyLoaded = false;
  await runTenantBackupScheduler(
    adapter,
    {
      async run(context) {
        if (context.operation.id === created.id) {
          const active = await restartedKeys.loadActive(context.lease, () => 100005);
          assert.deepEqual(active.envelope, startSession.envelope);
          assert.equal(active.contentKey.extractable, false);
          await assert.rejects(
            restartedKeys.loadActive({ ...context.lease, tenantId: 'tenant-b' }, () => 100005)
          );
          assert.deepEqual(await requests.loadForExecution(context, () => 100005), intent);
          await assert.rejects(
            requests.loadForExecution(
              { ...context, operation: { ...context.operation, phase: 'stale' } },
              () => 100005
            ),
            /execution_fenced/
          );
          activeKeyLoaded = true;
        }
        throw new Error('fixture private failure');
      },
      async cleanup() {
        return { cursor: null, done: true };
      },
    },
    new AbortController().signal,
    () => 100005
  );
  assert.equal(activeKeyLoaded, true);
  const deferred = await store.get('tenant-a', created.id);
  assert.equal(deferred?.last_error_code, 'backup_operation_slice_failed');
  assert.equal(deferred?.next_attempt_at, 101005);
  assert.equal(await store.claim('tenant-a', created.id, 'early', 101004), null);
  await store.create({
    ...request,
    id: 'artifact-operation',
    idempotencyKey: 'artifact-operation',
    now: 110000,
  });
  const artifactRun = await store.claim(
    'tenant-a',
    'artifact-operation',
    'artifact-writer',
    110001
  );
  assert(artifactRun);
  const bucket = await runtime.getR2Bucket('FIXTURE_BACKUPS');
  const artifactWriter = await TenantBackupArtifactWriter.create(
    adapter,
    bucket,
    {
      tenantId: 'tenant-a',
      operationId: 'artifact-operation',
      owner: 'artifact-writer',
      fencingToken: artifactRun.fencing_token,
    },
    () => 110002
  );
  await artifactWriter.writePart(0, new Uint8Array([1, 2, 3]));
  await artifactWriter.writePart(0, new Uint8Array([1, 2, 3]));
  await assert.rejects(artifactWriter.writePart(0, new Uint8Array([4])));
  const replacementRun = await store.claim(
    'tenant-a',
    'artifact-operation',
    'replacement-writer',
    150000
  );
  assert(replacementRun);
  const resumedWriter = await TenantBackupArtifactWriter.resume(
    adapter,
    bucket,
    artifactWriter.attemptId,
    {
      tenantId: 'tenant-a',
      operationId: 'artifact-operation',
      owner: 'replacement-writer',
      fencingToken: replacementRun.fencing_token,
    },
    () => 150001
  );
  assert.deepEqual(await resumedWriter.progress(), {
    state: 'writing',
    reservedParts: 1,
    uploadedParts: 1,
    uploadedBytes: 3,
  });
  await assert.rejects(artifactWriter.writePart(1, new Uint8Array([4])));
  await resumedWriter.writePart(0, new Uint8Array([1, 2, 3]));
  await resumedWriter.seal(1, 3);
  await resumedWriter.seal(1, 3);
  assert.equal((await resumedWriter.progress()).state, 'sealed');
  const part = await db
    .prepare('SELECT object_key FROM tenant_backup_artifact_parts WHERE attempt_id=?')
    .bind(artifactWriter.attemptId)
    .first<{ object_key: string }>();
  assert(part);
  const object = await bucket.get(part.object_key);
  assert(object);
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal((await bucket.list()).objects.length, 1);
  const fixtureSchema = {
    table: 'backup_fixture_rows',
    tenantColumn: 'tenant_id',
    columns: ['tenant_id', 'id', 'value', 'amount'],
    primaryKey: ['tenant_id', 'id'],
    uniqueKeys: [],
  };
  const fixtureSql = `CREATE TABLE backup_fixture_rows(tenant_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT,amount INTEGER,PRIMARY KEY(tenant_id,id));
    ${SQLITE_SNAPSHOT_SCHEMA}${sqliteSnapshotTriggers(fixtureSchema)}
    INSERT INTO backup_fixture_rows VALUES ('tenant-a','1','before',9007199254740993);
    INSERT INTO backup_fixture_rows VALUES ('other','1','foreign',0);
    INSERT INTO tenant_backup_snapshots (id, tenant_id, state) VALUES ('fixture-snapshot','tenant-a','capturing');
    UPDATE backup_fixture_rows SET value='after' WHERE tenant_id='tenant-a';`;
  await db.batch(splitMigrationSql(fixtureSql).map((statement) => db.prepare(statement)));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let dataset = '';
  for await (const chunk of readSqliteSnapshotDataset({
    database: adapter,
    schema: fixtureSchema,
    snapshotId: 'fixture-snapshot',
    tenantId: 'tenant-a',
    signal: new AbortController().signal,
  }))
    dataset += decoder.decode(chunk, { stream: true });
  dataset += decoder.decode();
  assert.deepEqual(JSON.parse(dataset), {
    tenant_id: ['text', 'tenant-a'],
    id: ['text', '1'],
    value: ['text', 'before'],
    amount: ['integer', '9007199254740993'],
  });
  await db
    .prepare("INSERT INTO backup_fixture_rows VALUES ('tenant-large','1',?,0)")
    .bind('\u0001'.repeat(1572864))
    .run();
  await db
    .prepare(
      "INSERT INTO tenant_backup_snapshots (id, tenant_id, state) VALUES ('large-snapshot','tenant-large','capturing')"
    )
    .run();
  await db
    .prepare("UPDATE backup_fixture_rows SET value='after-large' WHERE tenant_id='tenant-large'")
    .run();
  assert.equal(
    (
      await db
        .prepare(
          "SELECT typeof(row_json) AS kind FROM tenant_backup_preimages WHERE snapshot_id='large-snapshot' AND present=1"
        )
        .first<{ kind: string }>()
    )?.kind,
    'blob'
  );
  let largeBytes = 0,
    largeChunks = 0;
  for await (const chunk of readSqliteSnapshotDataset({
    database: adapter,
    schema: fixtureSchema,
    snapshotId: 'large-snapshot',
    tenantId: 'tenant-large',
    signal: new AbortController().signal,
  })) {
    assert(chunk.length <= 256 * 1024);
    largeBytes += chunk.length;
    largeChunks++;
  }
  assert(largeBytes > 8 * 1024 * 1024);
  assert(largeChunks > 32);
  await store.create({ ...request, id: 'inventory', idempotencyKey: 'inventory', now: 200000 });
  const inventoryRun = await store.claim('tenant-a', 'inventory', 'planner', 200001);
  assert(inventoryRun);
  const inventory = new TenantBackupExecutionInventory(
    adapter,
    {
      tenantId: 'tenant-a',
      operationId: 'inventory',
      owner: 'planner',
      fencingToken: inventoryRun.fencing_token,
    },
    () => 200002
  );
  await inventory.create();
  await inventory.append(
    0,
    'core:clients',
    JSON.stringify({ resourceId: 'fixture', schemaDigest: 'a'.repeat(64) })
  );
  await inventory.append(1, 'admin:users', '{"resourceId":"fixture-admin"}');
  const inventoryHead = await inventory.head();
  assert.equal(inventoryHead.item_count, 2);
  await inventory.seal(2, inventoryHead.chain_digest);
  assert.equal((await inventory.readPage()).length, 2);
  await assert.rejects(inventory.append(2, 'extra', '{}'), /append_conflict/);
  const resourceSql = readFileSync(
    new URL('../../migrations/admin/d1/011_tenant_backup_snapshot_resources.sql', import.meta.url),
    'utf8'
  );
  await db.batch(splitMigrationSql(resourceSql).map((statement) => db.prepare(statement)));
  const coreDb = await runtime.getD1Database('FIXTURE_CORE');
  await coreDb.prepare('CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL,value TEXT)').run();
  const coreAdapter: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute' | 'batch'> = {
    async execute(sql, params = []) {
      const r = await coreDb
        .prepare(sql)
        .bind(...params)
        .run();
      return { success: r.success, rowsAffected: r.meta.changes };
    },
    async query<T>(sql: string, params: unknown[] = []) {
      return (
        await coreDb
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results;
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return coreDb
        .prepare(sql)
        .bind(...params)
        .first<T>();
    },
    async batch(statements) {
      const results = await coreDb.batch(
        statements.map(({ sql, params = [] }) => coreDb.prepare(sql).bind(...params))
      );
      return results.map((result) => ({
        success: result.success,
        rowsAffected: result.meta.changes ?? 0,
      }));
    },
  };
  const sourceTables = await readBackupSqliteDatabaseSchema(
    coreAdapter,
    'core',
    new AbortController().signal
  );
  await store.create({ ...request, id: 'source-plan', idempotencyKey: 'source-plan', now: 210000 });
  const sourceRun = await store.claim('tenant-a', 'source-plan', 'source-planner', 210001);
  assert(sourceRun);
  const sourceInventory = new TenantBackupExecutionInventory(
    adapter,
    {
      tenantId: 'tenant-a',
      operationId: 'source-plan',
      owner: 'source-planner',
      fencingToken: sourceRun.fencing_token,
    },
    () => 210002
  );
  await sourceInventory.create();
  const sourceInput = {
    inventory: sourceInventory,
    family: 'core' as const,
    resourceId: 'core-fixture',
    firstOrdinal: 0,
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    },
  };
  await persistSqliteTenantDatasetPlan({ ...sourceInput, tables: sourceTables });
  const sourceHead = await sourceInventory.head();
  await sourceInventory.seal(sourceHead.item_count, sourceHead.chain_digest);
  assert.equal(
    (
      await verifyLiveSqliteTenantDatasetPlan({
        ...sourceInput,
        database: coreAdapter,
        signal: new AbortController().signal,
      })
    ).length,
    1
  );
  const schemas = await verifyLiveSqliteTenantDatasetPlan({
    ...sourceInput,
    database: coreAdapter,
    signal: new AbortController().signal,
  });
  const snapshotStorage = readFileSync(
    new URL('../../migrations/core/d1/009_tenant_backup_snapshot_storage.sql', import.meta.url),
    'utf8'
  );
  for (const sql of splitMigrationSql(snapshotStorage)) await coreDb.prepare(sql).run();
  const snapshotPartitions = readFileSync(
    new URL(
      '../../migrations/core/d1/012_tenant_backup_preimage_row_partitions.sql',
      import.meta.url
    ),
    'utf8'
  );
  for (const sql of splitMigrationSql(snapshotPartitions)) await coreDb.prepare(sql).run();
  await coreDb.prepare("INSERT INTO tenants VALUES ('tenant-a','before')").run();
  const captureInput = {
    ...sourceInput,
    context: {
      operation: sourceRun,
      lease: {
        tenantId: 'tenant-a',
        operationId: 'source-plan',
        owner: 'source-planner',
        fencingToken: sourceRun.fencing_token,
      },
      signal: new AbortController().signal,
    },
    resources: new TenantBackupSnapshotResources(adapter, () => 210002),
    source: { resourceId: 'core-fixture', database: coreAdapter },
    snapshotId: 'operation-snapshot',
    async assertBoundary() {},
  };
  const discoveryOperation = await store.checkpoint(
    captureInput.context.lease,
    sourceRun.revision,
    'discover_sqlite_resources',
    null,
    210002
  );
  assert(discoveryOperation);
  const discovered = await runSqliteResourceDiscoveryStep({
    context: { ...captureInput.context, operation: discoveryOperation },
    inventory: sourceInventory,
  });
  assert.equal(discovered.phase, 'prepare_capture_resources');
  assert(discovered.cursor);
  assert.deepEqual((JSON.parse(discovered.cursor) as { resources: unknown }).resources, [
    {
      resourceId: 'core-fixture',
      family: 'core',
      firstOrdinal: 0,
      tableCount: sourceTables.length,
      captureCount: 1,
    },
  ]);
  const discoverySaved = await store.checkpoint(
    captureInput.context.lease,
    discoveryOperation.revision,
    discovered.phase,
    discovered.cursor,
    210002
  );
  assert(discoverySaved);
  const resourcesPrepared = await runSqliteResourcePreparationStep({
    ...captureInput,
    context: { ...captureInput.context, operation: discoverySaved },
    async resolveSource(resource) {
      assert.equal(resource.resourceId, 'core-fixture');
      return captureInput.source;
    },
  });
  assert.equal(resourcesPrepared.phase, 'admit_snapshot_boundary');
  assert.equal(
    (await coreAdapter.queryOne<{ n: number }>('SELECT count(*) n FROM tenant_backup_snapshots'))
      ?.n,
    0
  );
  const resourcesPreparedSaved = await store.checkpoint(
    captureInput.context.lease,
    discoverySaved.revision,
    resourcesPrepared.phase,
    resourcesPrepared.cursor,
    210002
  );
  assert(resourcesPreparedSaved);
  const boundaryInput = {
    ...captureInput,
    context: { ...captureInput.context, operation: resourcesPreparedSaved },
    environmentId: 'sql-env',
    boundaryTenantId: 'tenant-a',
    admission: new TenantBackupMutationAdmission(admissionDatabase, 'sql-env'),
    receipts: new TenantBackupBoundaryReceipts(admissionDatabase),
    additionalParticipants: [],
    now: () => 210002,
    async assertReady() {
      await sourceInventory.headForLease(captureInput.context.lease);
    },
    async assertCoverage(
      resources: readonly { resourceId: string }[],
      participants: readonly { resourceId: string }[]
    ) {
      assert.deepEqual(
        resources.map((r) => r.resourceId),
        ['core-fixture']
      );
      assert.deepEqual(
        participants.map((r) => r.resourceId),
        ['core-fixture']
      );
    },
    async resolveSource() {
      return captureInput.source;
    },
  };
  const boundaryResult = await runPreparedSnapshotBoundaryStep(boundaryInput);
  assert.equal(boundaryResult.phase, 'prepare_export_artifact');
  const boundaryCursor = JSON.parse(boundaryResult.cursor ?? 'null') as {
    boundaryId: string;
    participants: { resourceId: string; snapshotId: string }[];
  };
  assert.equal(boundaryCursor.participants.length, 1);
  assert.equal(boundaryCursor.participants[0].resourceId, 'core-fixture');
  const operationSnapshotId = boundaryCursor.participants[0].snapshotId;
  await coreDb.prepare("UPDATE tenants SET value='after' WHERE id='tenant-a'").run();
  // Deliberately lose the outer checkpoint, then consume the same prepared cursor again.
  assert.deepEqual(await runPreparedSnapshotBoundaryStep(boundaryInput), boundaryResult);
  assert(
    await store.checkpoint(
      captureInput.context.lease,
      resourcesPreparedSaved.revision,
      boundaryResult.phase,
      boundaryResult.cursor,
      210002
    )
  );
  let capturedText = '';
  for await (const bytes of readSqliteSnapshotDataset({
    database: coreAdapter,
    schema: schemas[0],
    snapshotId: operationSnapshotId,
    tenantId: 'tenant-a',
    signal: new AbortController().signal,
  }))
    capturedText += new TextDecoder().decode(bytes);
  assert(capturedText.includes('before'));
  assert(!capturedText.includes('after'));
  const sqlDataset = {
    id: 'core.tenants',
    module: 'tenant-runtime' as const,
    kind: 'settings' as const,
    store: 'database' as const,
    schemaVersion: 1,
    disposition: 'include' as const,
  };
  const sqlInspector = await createSqliteDatasetInspectorFactory({
    dataset: sqlDataset,
    schema: schemas[0],
    async inspectRow(row) {
      assert.deepEqual(row.value, ['text', 'before']);
      return [];
    },
  })(sqlDataset, {
    formatVersion: 1,
    bundleId: 'a'.repeat(32),
    source: { tenantId: 'tenant-a', issuer: 'https://fixture.example', productVersion: '0.4.2' },
    selection: sourceInput.selection,
    snapshotId: operationSnapshotId,
    boundaryUnixMs: 210002,
    inventoryDigestSha256: 'b'.repeat(64),
    datasets: [sqlDataset],
  });
  const inspectedRows = await sqlInspector.chunk(new TextEncoder().encode(capturedText), 0);
  assert.equal(inspectedRows.records.length, 1);
  assert.equal(inspectedRows.records[0].tenantId, 'tenant-a');
  await sqlInspector.finish();
  await sqlInspector.dispose();
  const restoreDb = await runtime.getD1Database('FIXTURE_RESTORE');
  const restoreMigration = readFileSync(
    new URL('../../migrations/core/d1/010_tenant_backup_restore_target.sql', import.meta.url),
    'utf8'
  );
  await restoreDb.batch(splitMigrationSql(restoreMigration).map((sql) => restoreDb.prepare(sql)));
  await restoreDb.prepare('CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL,value TEXT)').run();
  const restoreAdapter = {
    async query<T>(sql: string, params: unknown[] = []) {
      return (
        await restoreDb
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results;
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return restoreDb
        .prepare(sql)
        .bind(...params)
        .first<T>();
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = await restoreDb
        .prepare(sql)
        .bind(...params)
        .run();
      return { success: result.success, rowsAffected: result.meta.changes };
    },
  };
  let restoreNow = 210005;
  await store.create({
    ...request,
    id: 'import-fixture',
    idempotencyKey: 'import-fixture',
    kind: 'import',
    now: 210000,
  });
  let restoreOperation = await store.claim('tenant-a', 'import-fixture', 'loader', restoreNow);
  assert(restoreOperation);
  const restoreLease = {
    tenantId: 'tenant-a',
    operationId: 'import-fixture',
    owner: 'loader',
    fencingToken: restoreOperation.fencing_token,
  };
  const restoreContext = {
    operation: restoreOperation,
    lease: restoreLease,
    signal: new AbortController().signal,
  };
  const restoreInventory = new TenantBackupExecutionInventory(
    adapter,
    restoreLease,
    () => restoreNow
  );
  await restoreInventory.create();
  const initializedResource = {
    targetId: 'isolated',
    resourceId: 'restore-fixture',
    provisioningId: 'fixture-provision',
    database: restoreAdapter,
  };
  const restorePolicy = {
    dataset: sqlDataset,
    schema: schemas[0],
    async inspectRow() {
      return [];
    },
  };
  const cipherSql = readFileSync(
    new URL('../../migrations/admin/d1/012_tenant_backup_cipher_journal.sql', import.meta.url),
    'utf8'
  );
  await db.batch(splitMigrationSql(cipherSql).map((sql) => db.prepare(sql)));
  const exportManifestSql = readFileSync(
    new URL('../../migrations/admin/d1/021_tenant_backup_export_manifests.sql', import.meta.url),
    'utf8'
  );
  await db.batch(splitMigrationSql(exportManifestSql).map((sql) => db.prepare(sql)));
  const restoreSession = await createTenantBundleKeyEnvelope('local fixture restore passphrase');
  const restoreManifest = {
    formatVersion: 1 as const,
    bundleId: [...restoreSession.envelope.slice(1, 17)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
    source: { tenantId: 'tenant-a', issuer: 'https://fixture.example', productVersion: '0.4.2' },
    selection: sourceInput.selection,
    snapshotId: boundaryCursor.boundaryId,
    boundaryUnixMs: 210002,
    inventoryDigestSha256: sourceHead.chain_digest,
    datasets: [sqlDataset],
  };
  let outputOperation = await store.get('tenant-a', 'source-plan');
  assert(outputOperation);
  const prepareOutput = {
    context: { ...captureInput.context, operation: outputOperation },
    inventory: sourceInventory,
    receipts: boundaryInput.receipts,
    environmentId: 'sql-env',
    boundaryTenantId: 'tenant-a',
    database: adapter,
    bucket,
    key: restoreSession,
    manifest: restoreManifest,
    expected: restoreManifest,
    now: () => 210002,
    async assertSources() {
      await captureInput.resources.assertCaptureOwner(
        captureInput.context.lease,
        'core-fixture',
        operationSnapshotId
      );
    },
  };
  const outputPrepared = await runPrepareTenantBackupArtifactStep(prepareOutput);
  assert.deepEqual(await runPrepareTenantBackupArtifactStep(prepareOutput), outputPrepared);
  const { attemptId: preparedAttemptId } = JSON.parse(outputPrepared.cursor ?? 'null') as {
    attemptId: string;
  };
  outputOperation = await store.checkpoint(
    captureInput.context.lease,
    outputOperation.revision,
    outputPrepared.phase,
    outputPrepared.cursor,
    210002
  );
  assert(outputOperation);
  while (outputOperation.phase === 'export_artifact') {
    const datasetContext = { ...captureInput.context, operation: outputOperation };
    const result = await runTenantBackupArtifactStep(
      { ...captureInput.context, operation: outputOperation },
      {
        database: adapter,
        bucket,
        attemptId: preparedAttemptId,
        key: restoreSession,
        now: () => 210002,
        expected: restoreManifest,
        assertBoundary: () => prepareOutput.assertSources(),
        async readNext(datasetId, cursor, signal) {
          assert.equal(datasetId, sqlDataset.id);
          signal.throwIfAborted();
          return readNextShardedSqliteDatasetChunk(
            {
              context: datasetContext,
              inventory: sourceInventory,
              resources: captureInput.resources,
              dataset: sqlDataset,
              table: 'tenants',
              capture: schemas[0],
              family: 'core',
              shards: [
                { resourceId: 'core-fixture', firstOrdinal: 0, snapshotId: operationSnapshotId },
              ],
              async assertResourceSet(shards) {
                assert.deepEqual(
                  shards.map((s) => s.resourceId),
                  ['core-fixture']
                );
              },
              selection: sourceInput.selection,
              async resolveSource() {
                return captureInput.source;
              },
              async assertSourceStable() {
                await sourceInventory.headForLease(captureInput.context.lease);
              },
            },
            cursor
          );
        },
      }
    );
    outputOperation = await store.checkpoint(
      captureInput.context.lease,
      outputOperation.revision,
      result.phase,
      result.cursor,
      210002
    );
    assert(outputOperation);
  }
  assert.equal(outputOperation.phase, 'verify_artifact');
  const restoreUploadParts: Uint8Array[] = [];
  for await (const part of readTenantBackupArtifact({
    database: adapter,
    bucket,
    lease: captureInput.context.lease,
    attemptId: preparedAttemptId,
    signal: captureInput.context.signal,
    now: () => 210002,
  }))
    restoreUploadParts.push(part);
  const restoreUpload = await bucket.put(
    'restore-input-fixture',
    Buffer.concat(restoreUploadParts)
  );
  assert(restoreUpload);
  const restoreReplayInput = {
    bucket,
    identity: {
      key: 'restore-input-fixture',
      version: restoreUpload.version,
      etag: restoreUpload.etag,
      size: restoreUpload.size,
    },
    session: restoreSession,
    manifest: restoreManifest,
    expected: restoreManifest,
    limits: { maxTotalBytes: 100000, maxFrames: 20 },
    signal: new AbortController().signal,
    assertAuthorized: async () => {},
  };
  await persistTenantBackupInput({
    context: restoreContext,
    inventory: restoreInventory,
    ordinal: 0,
    identity: restoreReplayInput.identity,
    limits: restoreReplayInput.limits,
    manifest: restoreManifest,
    expected: restoreManifest,
    assertUploadOwnership: async () => {},
  });
  const restoreHead = await restoreInventory.head();
  await restoreInventory.seal(restoreHead.item_count, restoreHead.chain_digest);
  let restoreDecodeCheckpoint: TenantBackupInputDecodeCheckpoint | null = null;
  let restoreReceiptSequence = 0;
  const restoreReceipts = new TenantBackupInputReceipts(adapter, restoreLease, () => restoreNow);
  while (!restoreDecodeCheckpoint?.complete) {
    const decoded = await decodeTenantBackupInputStep({
      ...restoreReplayInput,
      checkpoint: restoreDecodeCheckpoint,
    });
    await restoreReceipts.append(
      restoreManifest.bundleId,
      restoreReceiptSequence++,
      restoreDecodeCheckpoint,
      decoded
    );
    restoreDecodeCheckpoint = decoded.checkpoint;
  }
  const restoreFirstSequence = await restoreReceipts.datasetStart(
    restoreManifest.bundleId,
    sqlDataset.id,
    restoreReplayInput
  );
  const restoreValidation = await DatabaseTenantBundleReferenceIndex.create(
    adapter,
    restoreLease,
    () => restoreNow
  );
  const rowToInspect = await readNextSqliteInputRow({
    receipts: restoreReceipts,
    replayInput: restoreReplayInput,
    datasetId: sqlDataset.id,
    firstSequence: restoreFirstSequence,
    sourceCursor: null,
    planDigest: 'ab'.repeat(32),
    assertValidatedPlan: async () => {},
  });
  assert(rowToInspect);
  await inspectSqliteInputRow({
    policy: restorePolicy,
    manifest: restoreManifest,
    rowJson: rowToInspect.rowJson,
    rowOrdinal: 0,
    index: restoreValidation,
    assertPinnedInput: async () => {},
  });
  await inspectSqliteInputRow({
    policy: restorePolicy,
    manifest: restoreManifest,
    rowJson: rowToInspect.rowJson,
    rowOrdinal: 0,
    index: restoreValidation,
    assertPinnedInput: async () => {},
  });
  await assert.rejects(
    inspectSqliteInputRow({
      policy: restorePolicy,
      manifest: restoreManifest,
      rowJson: rowToInspect.rowJson,
      rowOrdinal: 1,
      index: restoreValidation,
      assertPinnedInput: async () => {},
    })
  );
  const validationPrepared = await store.checkpoint(
    restoreLease,
    restoreOperation.revision,
    'validate_sqlite_dataset',
    JSON.stringify({
      version: 1,
      sessionId: restoreValidation.sessionId,
      bundleId: restoreManifest.bundleId,
      datasetId: sqlDataset.id,
      sourceCursor: null,
      rows: 0,
    }),
    restoreNow
  );
  assert(validationPrepared);
  restoreOperation = validationPrepared;
  for (let validationSlice = 0; validationSlice < 2; validationSlice++) {
    const result = await runSqliteInputValidationStep(
      { ...restoreContext, operation: restoreOperation },
      {
        database: adapter,
        now: () => restoreNow,
        sessionId: restoreValidation.sessionId,
        policy: restorePolicy,
        manifest: restoreManifest,
        assertPinnedInput: async () => {},
        readNextRow: (sourceCursor) =>
          readNextSqliteInputRow({
            receipts: restoreReceipts,
            replayInput: restoreReplayInput,
            datasetId: sqlDataset.id,
            firstSequence: restoreFirstSequence,
            sourceCursor,
            planDigest: 'ab'.repeat(32),
            assertValidatedPlan: async () => {},
          }),
      }
    );
    const saved = await store.checkpoint(
      restoreLease,
      restoreOperation.revision,
      result.phase,
      result.cursor,
      restoreNow
    );
    assert(saved);
    restoreOperation = saved;
  }
  assert.equal(restoreOperation.phase, 'advance_validation_dataset');
  const inspectionReceipt = await finalizeSqliteDatasetInspection(
    { ...restoreContext, operation: restoreOperation },
    {
      database: adapter,
      manifest: restoreManifest,
      policy: restorePolicy,
      now: () => restoreNow,
      assertPinnedInput: async () => {},
      operationCursorGuard: restoreOperation.cursor_json ?? '',
    }
  );
  assert.equal(inspectionReceipt.recordCount, 1);
  assert.deepEqual(
    await finalizeSqliteDatasetInspection(
      { ...restoreContext, operation: restoreOperation },
      {
        database: adapter,
        manifest: restoreManifest,
        policy: restorePolicy,
        now: () => restoreNow,
        assertPinnedInput: async () => {},
        operationCursorGuard: restoreOperation.cursor_json ?? '',
      }
    ),
    inspectionReceipt
  );
  await assert.rejects(
    finalizeSqliteDatasetInspection(
      { ...restoreContext, operation: restoreOperation },
      {
        database: adapter,
        manifest: restoreManifest,
        policy: { ...restorePolicy, deferredColumns: ['value'] },
        now: () => restoreNow,
        assertPinnedInput: async () => {},
        operationCursorGuard: restoreOperation.cursor_json ?? '',
      }
    )
  );
  await assert.rejects(
    finalizeSqliteDatasetInspection(
      {
        ...restoreContext,
        operation: {
          ...restoreOperation,
          cursor_json: JSON.stringify({
            ...(JSON.parse(restoreOperation.cursor_json ?? 'null') as Record<string, unknown>),
            rows: 2,
          }),
        },
      },
      {
        database: adapter,
        manifest: restoreManifest,
        policy: restorePolicy,
        now: () => restoreNow,
        assertPinnedInput: async () => {},
        operationCursorGuard: restoreOperation.cursor_json ?? '',
      }
    )
  );

  const completedReferences = await validateTenantBackupReferencePage({
    index: restoreValidation,
    after: '',
    assertCompleteInputInspection: async () => {},
  });
  assert(completedReferences.done);
  const finalValidation = await store.checkpoint(
    restoreLease,
    restoreOperation.revision,
    'finalize_input_validation',
    JSON.stringify({
      version: 1,
      sessionId: restoreValidation.sessionId,
      inputSetDigest: restoreHead.chain_digest,
      after: completedReferences.nextCursor,
      examined: completedReferences.examined,
      unresolvedProvenance: completedReferences.unresolvedProvenance,
    }),
    restoreNow
  );
  assert(finalValidation);
  restoreOperation = finalValidation;
  await db
    .prepare('DELETE FROM tenant_backup_dataset_inspections WHERE session_id=?')
    .bind(restoreValidation.sessionId)
    .run();
  await assert.rejects(
    finalizeTenantBackupInputValidation(
      { ...restoreContext, operation: restoreOperation },
      { database: adapter, inventory: restoreInventory, now: () => restoreNow }
    ),
    /backup_input_validation_incomplete/
  );
  assert.equal(
    await adapter.queryOne(
      'SELECT operation_id FROM tenant_backup_input_validations WHERE operation_id=?',
      [restoreLease.operationId]
    ),
    null
  );
  await db
    .prepare(
      'INSERT INTO tenant_backup_dataset_inspections(session_id,tenant_id,bundle_id,dataset_id,manifest_sha256,policy_sha256,record_count) VALUES(?,?,?,?,?,?,?)'
    )
    .bind(
      restoreValidation.sessionId,
      restoreLease.tenantId,
      restoreManifest.bundleId,
      sqlDataset.id,
      inspectionReceipt.manifestSha256,
      inspectionReceipt.policySha256,
      inspectionReceipt.recordCount
    )
    .run();
  await finalizeTenantBackupInputValidation(
    { ...restoreContext, operation: restoreOperation },
    { database: adapter, inventory: restoreInventory, now: () => restoreNow }
  );
  await finalizeTenantBackupInputValidation(
    { ...restoreContext, operation: restoreOperation },
    { database: adapter, inventory: restoreInventory, now: () => restoreNow }
  );
  const restorePlanOperation = await store.checkpoint(
    restoreLease,
    restoreOperation.revision,
    'prepare_restore_plan',
    JSON.stringify({
      version: 1,
      sessionId: restoreValidation.sessionId,
      inputSetDigest: restoreHead.chain_digest,
    }),
    restoreNow
  );
  assert(restorePlanOperation);
  restoreOperation = restorePlanOperation;
  const restorePlanInventory = new DatabaseTenantBackupRestorePlanInventory(
    adapter,
    restoreLease,
    () => restoreNow
  );
  await restorePlanInventory.create(restoreHead.chain_digest);
  const restorePlanContext = { ...restoreContext, operation: restoreOperation };
  await persistInitializedSqliteRestoreTarget({
    context: restorePlanContext,
    inventory: restorePlanInventory,
    ordinal: 0,
    resource: initializedResource,
    async assertProvisioningOwnership() {},
  });
  await persistSqliteRestoreSequence(restorePlanInventory, 1, [
    {
      targetId: 'isolated',
      ordinal: 0,
      policy: restorePolicy,
      manifest: restoreManifest,
      recordCount: 1,
      byteCount: new TextEncoder().encode(capturedText).length,
    },
  ]);
  const restorePlanHead = await restorePlanInventory.headForLease(restoreLease);
  await restorePlanInventory.seal(restorePlanHead.item_count, restorePlanHead.chain_digest);
  const restoreInput = {
    context: restorePlanContext,
    inventory: restorePlanInventory,
    ordinal: 0,
    targetId: 'isolated',
    now: () => restoreNow,
    async resolve(resourceId: string, provisioningId: string) {
      assert.equal(resourceId, initializedResource.resourceId);
      assert.equal(provisioningId, initializedResource.provisioningId);
      return initializedResource;
    },
    async assertValidatedUnpublishedPlan(digest: string) {
      assert.equal(digest, restorePlanHead.chain_digest);
    },
  };
  const restoreTarget = await openPlannedSqliteRestoreTarget(restoreInput);
  const importCursor = { version: 1, sequenceOrdinal: 1, jobIndex: 0, datasetCursor: null };
  const importCheckpoint = await store.checkpoint(
    restoreLease,
    restoreOperation.revision,
    'start_sqlite_restore_sequence',
    JSON.stringify(importCursor),
    restoreNow
  );
  assert(importCheckpoint);
  assert(await store.release(restoreLease, importCheckpoint.revision, 'queued', restoreNow));
  let restoreSequenceComplete = false;
  for (let slice = 0; slice < 20; slice++) {
    restoreNow++;
    const result = await executeTenantBackupSlice(
      store,
      {
        tenantId: 'tenant-a',
        operationId: 'import-fixture',
        workerId: `import-worker-${slice}`,
        signal: new AbortController().signal,
      },
      {
        async run(context) {
          if (context.operation.phase === 'restore_other_stores')
            return {
              phase: 'verify_restore_targets',
              cursor: context.operation.cursor_json,
              disposition: 'continue' as const,
            };
          return runSqliteRestoreSequenceStep(context, {
            ...restoreInput,
            sequenceOrdinal: 1,
            inventory: new DatabaseTenantBackupRestorePlanInventory(
              adapter,
              context.lease,
              () => restoreNow
            ),
            async loadValidatedDataset() {
              return {
                policy: restorePolicy,
                manifest: restoreManifest,
                async readNextValidatedRow({ sourceCursor, datasetId, planDigest }) {
                  return readNextSqliteInputRow({
                    receipts: new TenantBackupInputReceipts(
                      adapter,
                      context.lease,
                      () => restoreNow
                    ),
                    replayInput: { ...restoreReplayInput, signal: context.signal },
                    datasetId,
                    firstSequence: restoreFirstSequence,
                    sourceCursor,
                    planDigest,
                    async assertValidatedPlan(digest, bundleId, selectedDataset) {
                      assert.equal(digest, restorePlanHead.chain_digest);
                      assert.equal(bundleId, restoreManifest.bundleId);
                      assert.equal(selectedDataset, sqlDataset.id);
                    },
                  });
                },
              };
            },
          });
        },
        async cleanup() {
          throw new Error('unexpected_import_cleanup');
        },
      },
      () => restoreNow
    );
    assert.equal(result.outcome, 'yielded');
    if (result.operation?.phase === 'verify_other_restore_stores') {
      restoreSequenceComplete = true;
      break;
    }
  }
  assert.equal(restoreSequenceComplete, true);
  const importedOperation = await store.get('tenant-a', 'import-fixture');
  assert.equal(importedOperation?.phase, 'verify_other_restore_stores');
  assert.equal(importedOperation?.state, 'queued');

  restoreNow = 250000;
  const replacementOperation = await store.claim(
    'tenant-a',
    'import-fixture',
    'replacement',
    restoreNow
  );
  assert(replacementOperation);
  const replacementLease = {
    ...restoreLease,
    owner: 'replacement',
    fencingToken: replacementOperation.fencing_token,
  };
  assert.equal(replacementOperation.state, 'running');
  assert.equal(replacementOperation.lease_owner, replacementLease.owner);
  assert(replacementOperation.lease_expires_at !== null);
  assert(replacementOperation.lease_expires_at > restoreNow);
  const previousRestoreTarget = await restoreAdapter.queryOne<{
    state: string;
    owner: string;
    fencing_token: number;
    lease_expires_at: number;
  }>('SELECT state,owner,fencing_token,lease_expires_at FROM tenant_backup_restore_targets');
  assert(previousRestoreTarget);
  assert.equal(previousRestoreTarget.state, 'sealed');
  assert(previousRestoreTarget.fencing_token < replacementOperation.fencing_token);
  const replacementTarget = await openPlannedSqliteRestoreTarget({
    mode: 'verify',
    ...restoreInput,
    context: { ...restoreContext, operation: replacementOperation, lease: replacementLease },
    inventory: new DatabaseTenantBackupRestorePlanInventory(
      adapter,
      replacementLease,
      () => restoreNow
    ),
  });
  await assert.rejects(
    replacementTarget.writeRow(restorePolicy, restoreManifest, capturedText.trimEnd())
  );
  await assert.rejects(
    restoreTarget.writeRow(restorePolicy, restoreManifest, capturedText.trimEnd())
  );
  assert.deepEqual(
    await restoreDb
      .prepare('SELECT id,value FROM tenants')
      .all()
      .then((r) => r.results),
    [{ id: 'tenant-a', value: 'before' }]
  );
  await assert.rejects(
    replacementTarget.writeRow(restorePolicy, restoreManifest, capturedText.trimEnd())
  );
  const sealedReader = await openPlannedSqliteRestoreTarget({
    ...restoreInput,
    mode: 'verify',
    context: { ...restoreContext, operation: replacementOperation, lease: replacementLease },
    inventory: new DatabaseTenantBackupRestorePlanInventory(
      adapter,
      replacementLease,
      () => restoreNow
    ),
  });
  await sealedReader.verifyRow(restorePolicy, restoreManifest, capturedText.trimEnd());
  await sealedReader.verifyDataset(restorePolicy, 1);
  await assert.rejects(
    sealedReader.writeRow(restorePolicy, restoreManifest, capturedText.trimEnd())
  );

  const cursorInput = {
    database: coreAdapter,
    schema: schemas[0],
    snapshotId: operationSnapshotId,
    tenantId: 'tenant-a',
    signal: new AbortController().signal,
  };
  const firstSourceChunk = await readNextSqliteSnapshotChunk(cursorInput, null);
  assert(firstSourceChunk);
  assert.equal(new TextDecoder().decode(firstSourceChunk.bytes), capturedText);
  assert.deepEqual(await readNextSqliteSnapshotChunk(cursorInput, null), firstSourceChunk);
  assert.equal(await readNextSqliteSnapshotChunk(cursorInput, firstSourceChunk.nextCursor), null);

  await coreDb.prepare('ALTER TABLE tenants ADD COLUMN changed TEXT').run();
  await assert.rejects(
    verifyLiveSqliteTenantDatasetPlan({
      ...sourceInput,
      database: coreAdapter,
      signal: new AbortController().signal,
    }),
    /inventory_changed/
  );
  await assert.rejects(
    cleanupSqliteBackupSnapshotPage(adapter, 'fixture-snapshot', 'tenant-a'),
    /not_invalid/
  );
  await invalidateSqliteBackupSnapshot(adapter, 'fixture-snapshot', 'tenant-a');
  await assert.rejects(
    db
      .prepare("UPDATE tenant_backup_snapshots SET state='capturing' WHERE id='fixture-snapshot'")
      .run(),
    /state_regression/
  );
  assert.deepEqual(await cleanupSqliteBackupSnapshotPage(adapter, 'fixture-snapshot', 'tenant-a'), {
    removed: 1,
    complete: true,
  });
  assert.deepEqual(await cleanupSqliteBackupSnapshotPage(adapter, 'fixture-snapshot', 'tenant-a'), {
    removed: 0,
    complete: true,
  });
  assert.equal(
    (
      await db
        .prepare("SELECT value FROM backup_fixture_rows WHERE tenant_id='tenant-a'")
        .first<{ value: string }>()
    )?.value,
    'after'
  );
  await store.create({
    id: 'resource-operation',
    tenantId: 'tenant-a',
    kind: 'export',
    idempotencyKey: 'resource-request',
    requestDigest: 'a'.repeat(64),
    actorId: 'admin',
    now: 2000000,
  });
  const resourceOperation = await store.claim('tenant-a', 'resource-operation', 'capture', 2000001);
  assert(resourceOperation);
  const resources = new TenantBackupSnapshotResources(adapter, () => 2000002);
  await resources.reserve(
    {
      tenantId: 'tenant-a',
      operationId: 'resource-operation',
      owner: 'capture',
      fencingToken: resourceOperation.fencing_token,
    },
    'fixture-admin',
    'uncertain-start'
  );
  await store.requestCancel('tenant-a', 'resource-operation', 2000002);
  const handlers = {
    async run(): Promise<never> {
      throw new Error('unexpected');
    },
    async cleanup(context: Parameters<typeof resources.cleanupCancellationPage>[0]) {
      return {
        ...(await resources.cleanupCancellationPage(context, async (resourceId) => ({
          resourceId,
          database: adapter,
        }))),
        cursor: null,
      };
    },
  };
  for (let slice = 0; slice < 2; slice++)
    await executeTenantBackupSlice(
      store,
      {
        tenantId: 'tenant-a',
        operationId: 'resource-operation',
        workerId: 'cleanup',
        signal: new AbortController().signal,
      },
      handlers,
      () => 2000002
    );
  assert.equal((await store.get('tenant-a', 'resource-operation'))?.state, 'cancelled');
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO tenant_backup_snapshots(id,tenant_id,state) VALUES ('uncertain-start','tenant-a','capturing')"
      )
      .run()
  );
  await assert.rejects(
    db
      .prepare("UPDATE tenant_backup_snapshots SET state='capturing' WHERE id='uncertain-start'")
      .run(),
    /state_regression/
  );

  await store.create({
    ...request,
    id: 'cipher-operation',
    idempotencyKey: 'cipher-operation',
    now: 3000000,
  });
  const cipherRun = await store.claim('tenant-a', 'cipher-operation', 'cipher-worker', 3000001);
  assert(cipherRun);
  const cipherLease = {
    tenantId: 'tenant-a',
    operationId: 'cipher-operation',
    owner: 'cipher-worker',
    fencingToken: cipherRun.fencing_token,
  };
  const cipherWriter = await TenantBackupArtifactWriter.create(
    adapter,
    bucket,
    cipherLease,
    () => 3000002
  );
  const cipherSession = await createTenantBundleKeyEnvelope(
    'runtime cipher checkpoint fixture password'
  );
  const journal = await TenantBackupCipherJournal.open(
    adapter,
    cipherWriter,
    cipherLease,
    () => 3000002,
    cipherSession
  );
  await journal.write(0, new TextEncoder().encode('before-restart'), '{"cursor":1}');
  const cipherNext = await store.claim(
    'tenant-a',
    'cipher-operation',
    'cipher-replacement',
    3040000
  );
  assert(cipherNext);
  const cipherNextLease = {
    ...cipherLease,
    owner: 'cipher-replacement',
    fencingToken: cipherNext.fencing_token,
  };
  const adopted = await TenantBackupArtifactWriter.resume(
    adapter,
    bucket,
    cipherWriter.attemptId,
    cipherNextLease,
    () => 3040001
  );
  const reopened = await TenantBackupCipherJournal.open(
    adapter,
    adopted,
    cipherNextLease,
    () => 3040001,
    cipherSession
  );
  await assert.rejects(
    reopened.write(0, new TextEncoder().encode('different-content'), '{"cursor":1}')
  );
  await reopened.write(1, new TextEncoder().encode('after-restart'), '{"cursor":2}');
  await reopened.finish(2, '{"done":true}');
  await reopened.finish(2, '{"done":true}');
  const cipherParts = await db
    .prepare(
      'SELECT object_key FROM tenant_backup_artifact_parts WHERE attempt_id=? ORDER BY ordinal'
    )
    .bind(adopted.attemptId)
    .all<{ object_key: string }>();
  function ciphertext() {
    return readTenantBackupArtifact({
      database: adapter,
      bucket: {
        async get(key: string) {
          return bucket.get(key);
        },
      },
      lease: cipherNextLease,
      attemptId: adopted.attemptId,
      signal: new AbortController().signal,
      now: () => 3040001,
    });
  }
  const cipherEvents = [];
  for await (const event of decryptTenantBundleStream(ciphertext(), cipherSession, {
    maxFrames: 20,
    maxTotalBytes: 10000,
  }))
    cipherEvents.push(event.kind === 'chunk' ? new TextDecoder().decode(event.bytes) : 'complete');
  assert.deepEqual(cipherEvents, ['before-restart', 'after-restart', 'complete']);
  let inputHeader: Uint8Array | undefined;
  let inputDecoder: TenantBundleCipherDecoder | undefined;
  const resumedPlain: string[] = [];
  const inputLimits = { maxFrames: 20, maxTotalBytes: 10000 };
  for await (const frame of decodeTenantBundleFrames(ciphertext(), inputLimits)) {
    if (!inputHeader) {
      inputHeader = frame;
      inputDecoder = await TenantBundleCipherDecoder.create(
        inputHeader,
        cipherSession,
        inputLimits
      );
      continue;
    }
    assert(inputDecoder);
    const event = await inputDecoder.step(frame);
    if (event.kind === 'chunk') resumedPlain.push(new TextDecoder().decode(event.bytes));
    inputDecoder = await TenantBundleCipherDecoder.create(
      inputHeader,
      cipherSession,
      inputLimits,
      inputDecoder.checkpoint()
    );
  }
  assert(inputDecoder?.checkpoint().complete);
  assert.deepEqual(resumedPlain, ['before-restart', 'after-restart']);

  await bucket.delete(cipherParts.results[0].object_key);
  await assert.rejects(ciphertext().next(), /artifact_read_failed/);
  await store.create({
    ...request,
    id: 'export-step',
    idempotencyKey: 'export-step',
    now: 4000000,
  });
  const exportRun = await store.claim('tenant-a', 'export-step', 'prepare', 4000001);
  assert(exportRun);
  const exportLease = {
    tenantId: 'tenant-a',
    operationId: 'export-step',
    owner: 'prepare',
    fencingToken: exportRun.fencing_token,
  };
  const exportWriter = await TenantBackupArtifactWriter.create(
    adapter,
    bucket,
    exportLease,
    () => 4000002
  );
  const exportSaved = await store.checkpoint(
    exportLease,
    exportRun.revision,
    'export_artifact',
    JSON.stringify({ version: 1, attemptId: exportWriter.attemptId }),
    4000002
  );
  assert(exportSaved);
  await store.release(exportLease, exportSaved.revision, 'queued', 4000002);
  const exportExpected = {
    bundleId: Array.from(cipherSession.envelope.subarray(1, 17), (b) =>
      b.toString(16).padStart(2, '0')
    ).join(''),
    source: { tenantId: 'tenant-a', issuer: 'https://fixture.example', productVersion: '0.4.2' },
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    },
    datasets: [
      {
        id: 'core.clients',
        module: 'applications' as const,
        kind: 'settings' as const,
        store: 'database' as const,
        schemaVersion: 1,
        disposition: 'include' as const,
      },
    ],
  };
  const exportManifest = {
    formatVersion: 1 as const,
    ...exportExpected,
    snapshotId: 'export-snapshot',
    boundaryUnixMs: 4000000,
    inventoryDigestSha256: 'a'.repeat(64),
  };
  for (let slice = 0; slice < 4; slice++) {
    const stepTime = 4000003 + slice;
    const result = await executeTenantBackupSlice(
      store,
      {
        tenantId: 'tenant-a',
        operationId: 'export-step',
        workerId: `export-worker-${slice}`,
        signal: new AbortController().signal,
      },
      {
        async run(context) {
          await TenantBackupArtifactWriter.resume(
            adapter,
            bucket,
            exportWriter.attemptId,
            context.lease,
            () => stepTime
          );
          await saveTenantBackupExportManifest({
            database: adapter,
            lease: context.lease,
            attemptId: exportWriter.attemptId,
            manifest: exportManifest,
            expected: exportExpected,
            now: () => stepTime,
          });
          return runTenantBackupArtifactStep(context, {
            database: adapter,
            bucket,
            attemptId: exportWriter.attemptId,
            key: cipherSession,
            now: () => stepTime,
            manifest: exportManifest,
            expected: exportExpected,
            async assertBoundary() {},
            async readNext(_datasetId, cursor) {
              return cursor === null
                ? {
                    bytes: new TextEncoder().encode('{"id":["text","slice-body"]}\n'),
                    nextCursor: '1',
                  }
                : null;
            },
          });
        },
        async cleanup() {
          throw new Error('unexpected');
        },
      },
      () => stepTime
    );
    assert.equal(result.outcome, 'yielded');
  }
  assert.equal((await store.get('tenant-a', 'export-step'))?.phase, 'verify_artifact');
  assert.equal((await store.get('tenant-a', 'export-step'))?.state, 'queued');
  for (let slice = 0; slice < 5; slice++) {
    const now = 4000010 + slice;
    const result = await executeTenantBackupSlice(
      store,
      {
        tenantId: 'tenant-a',
        operationId: 'export-step',
        workerId: `verify-worker-${slice}`,
        signal: new AbortController().signal,
      },
      {
        run(context) {
          return runTenantBackupArtifactVerificationStep(context, {
            database: adapter,
            bucket: {
              async get(key: string) {
                return bucket.get(key);
              },
            },
            attemptId: exportWriter.attemptId,
            key: cipherSession,
            now: () => now,
            expected: exportExpected,
          });
        },
        async cleanup() {
          throw new Error('unexpected');
        },
      },
      () => now
    );
    assert.equal(result.outcome, 'yielded');
  }
  assert.equal((await store.get('tenant-a', 'export-step'))?.phase, 'release_export_resources');
  assert.equal((await store.get('tenant-a', 'export-step'))?.state, 'queued');

  const inputRun = await store.claim('tenant-a', 'export-step', 'input-decoder', 4000100);
  assert(inputRun);
  const encodedInput = readTenantBackupArtifact({
    database: adapter,
    bucket,
    lease: {
      tenantId: 'tenant-a',
      operationId: 'export-step',
      owner: 'input-decoder',
      fencingToken: inputRun.fencing_token,
    },
    attemptId: exportWriter.attemptId,
    signal: new AbortController().signal,
    now: () => 4000100,
  });
  // A small fixture upload; production uploads must stream into their operation-owned object.
  const uploadParts: Uint8Array[] = [];
  for await (const part of encodedInput) uploadParts.push(part);
  const uploadBytes = Buffer.concat(uploadParts);
  const uploadedInput = await bucket.put('input-range-fixture', uploadBytes);
  assert(uploadedInput);
  const inputIdentity = {
    key: 'input-range-fixture',
    version: uploadedInput.version,
    etag: uploadedInput.etag,
    size: uploadedInput.size,
  };
  let inputCursor = { offset: 0, frames: 0 };
  let contentDecoder = await TenantBundleContentDecoder.create(exportManifest, exportExpected);
  let framedCipher: TenantBundleCipherDecoder | undefined;
  let framedHeader: Uint8Array | undefined;
  const contentEvents: string[] = [];
  while (true) {
    const nextFrame = await readTenantBackupInputFrame({
      bucket,
      identity: inputIdentity,
      cursor: inputCursor,
      limits: inputLimits,
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
    });
    if (!nextFrame) break;
    inputCursor = nextFrame.cursor;
    const frame = nextFrame.payload;
    if (!framedHeader) {
      framedHeader = frame;
      framedCipher = await TenantBundleCipherDecoder.create(frame, cipherSession, inputLimits);
      continue;
    }
    assert(framedCipher);
    const decrypted = await framedCipher.step(frame);
    if (decrypted.kind === 'chunk') {
      const content = await contentDecoder.step(decrypted.bytes);
      contentEvents.push(content.kind);
      if (content.kind === 'chunk')
        assert.equal(new TextDecoder().decode(content.bytes), '{"id":["text","slice-body"]}\n');
      contentDecoder = await TenantBundleContentDecoder.create(
        exportManifest,
        exportExpected,
        contentDecoder.checkpoint()
      );
    }
    framedCipher = await TenantBundleCipherDecoder.create(
      framedHeader,
      cipherSession,
      inputLimits,
      framedCipher.checkpoint()
    );
  }
  assert(framedCipher?.checkpoint().complete);
  assert.equal(contentDecoder.finish().kind, 'complete');
  assert.deepEqual(contentEvents, ['manifest', 'chunk', 'dataset_end']);
  await store.create({
    ...request,
    id: 'decode-input',
    idempotencyKey: 'decode-input',
    kind: 'import',
    now: 4000200,
  });
  const decodeRun = await store.claim('tenant-a', 'decode-input', 'decode-worker', 4000201);
  assert(decodeRun);
  let decodeLease = {
    tenantId: 'tenant-a',
    operationId: 'decode-input',
    owner: 'decode-worker',
    fencingToken: decodeRun.fencing_token,
  };
  let decodeNow = 4000202;
  const decodeInventory = new TenantBackupExecutionInventory(adapter, decodeLease, () => decodeNow);
  await decodeInventory.create();
  await persistTenantBackupInput({
    context: { operation: decodeRun, lease: decodeLease, signal: new AbortController().signal },
    inventory: decodeInventory,
    ordinal: 0,
    identity: inputIdentity,
    limits: inputLimits,
    manifest: exportManifest,
    expected: exportExpected,
    assertUploadOwnership: async () => {},
  });
  const decodePlanHead = await decodeInventory.head();
  await decodeInventory.seal(decodePlanHead.item_count, decodePlanHead.chain_digest);
  const decodePrepared = await store.checkpoint(
    decodeLease,
    decodeRun.revision,
    'decode_input',
    JSON.stringify({ version: 1, bundleId: exportExpected.bundleId }),
    decodeNow
  );
  assert(decodePrepared);
  await store.release(decodeLease, decodePrepared.revision, 'queued', decodeNow);
  for (let slice = 0; slice < 6; slice++) {
    decodeNow += slice === 1 ? 40000 : 1;
    const execution = executeTenantBackupSlice(
      store,
      {
        tenantId: 'tenant-a',
        operationId: 'decode-input',
        workerId: `decoder-${slice}`,
        signal: new AbortController().signal,
      },
      {
        async run(context) {
          const result = await runPlannedTenantBackupInputDecodeStep(context, {
            database: adapter,
            bucket,
            inventory: new TenantBackupExecutionInventory(adapter, context.lease, () => decodeNow),
            ordinal: 0,
            session: cipherSession,
            expected: exportExpected,
            now: () => decodeNow,
          });
          if (slice === 0) throw new Error('lost_outer_checkpoint_after_receipt_commit');
          return result;
        },
        async cleanup() {
          throw new Error('unexpected_decode_cleanup');
        },
      },
      () => decodeNow
    );
    if (slice === 0) await assert.rejects(execution, /backup_operation_slice_failed/);
    else assert.equal((await execution).outcome, 'yielded');
  }
  assert.equal((await store.get('tenant-a', 'decode-input'))?.phase, 'validate_input_modules');
  const decodeReader = await store.claim('tenant-a', 'decode-input', 'decode-reader', ++decodeNow);
  assert(decodeReader);
  decodeLease = {
    ...decodeLease,
    owner: 'decode-reader',
    fencingToken: decodeReader.fencing_token,
  };
  const replayed = await new TenantBackupInputReceipts(
    adapter,
    decodeLease,
    () => decodeNow
  ).replay(exportExpected.bundleId, 2, {
    bucket,
    identity: inputIdentity,
    limits: inputLimits,
    signal: new AbortController().signal,
    assertAuthorized: async () => {},
    session: cipherSession,
    manifest: exportManifest,
    expected: exportExpected,
  });
  assert.equal(replayed.kind, 'chunk');
  if (replayed.kind === 'chunk')
    assert.equal(new TextDecoder().decode(replayed.bytes), '{"id":["text","slice-body"]}\n');
  const rowSourceInput = {
    receipts: new TenantBackupInputReceipts(adapter, decodeLease, () => decodeNow),
    replayInput: {
      bucket,
      identity: inputIdentity,
      limits: inputLimits,
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
      session: cipherSession,
      manifest: exportManifest,
      expected: exportExpected,
    },
    datasetId: exportManifest.datasets[0].id,
    firstSequence: 2,
    sourceCursor: null,
    planDigest: 'ab'.repeat(32),
    assertValidatedPlan: async () => {},
  };
  const loadedRow = await readNextSqliteInputRow(rowSourceInput);
  assert.equal(loadedRow?.rowJson, '{"id":["text","slice-body"]}');
  assert(loadedRow);
  assert.equal(
    await readNextSqliteInputRow({ ...rowSourceInput, sourceCursor: loadedRow.nextCursor }),
    null
  );
  const resumedValidation = await DatabaseTenantBundleReferenceIndex.create(
    adapter,
    decodeLease,
    () => decodeNow
  );
  const validatedIdentity = {
    tenantId: 'tenant-a',
    module: 'applications' as const,
    collection: 'core.clients',
    id: 'slice-body',
  };
  assert(
    await resumedValidation.recordOnce(
      exportExpected.bundleId,
      'dataset:0:row:0',
      validatedIdentity
    )
  );
  assert(
    await resumedValidation.recordOnce(
      exportExpected.bundleId,
      'dataset:0:row:0',
      validatedIdentity
    )
  );
  assert.equal(
    await resumedValidation.recordOnce(
      exportExpected.bundleId,
      'dataset:0:row:1',
      validatedIdentity
    ),
    false
  );
  decodeNow += 40000;
  const decodeTakeover = await store.claim(
    'tenant-a',
    'decode-input',
    'decode-successor',
    decodeNow
  );
  assert(decodeTakeover);
  await assert.rejects(
    new TenantBackupInputReceipts(adapter, decodeLease, () => decodeNow).latest(
      exportExpected.bundleId
    ),
    /backup_input_receipt_failed/
  );
  const resumedReceipt = await new TenantBackupInputReceipts(
    adapter,
    {
      ...decodeLease,
      owner: 'decode-successor',
      fencingToken: decodeTakeover.fencing_token,
    },
    () => decodeNow
  ).latest(exportExpected.bundleId);
  assert(resumedReceipt?.checkpoint.complete);
  const takenValidation = await DatabaseTenantBundleReferenceIndex.resume(
    adapter,
    resumedValidation.sessionId,
    {
      ...decodeLease,
      owner: 'decode-successor',
      fencingToken: decodeTakeover.fencing_token,
    },
    () => decodeNow
  );
  assert(await takenValidation.hasRecord(validatedIdentity));
  await takenValidation.referenceOnce(exportExpected.bundleId, 'edge:0', {
    from: validatedIdentity,
    to: { ...validatedIdentity, meaning: 'resource', requirement: 'required' },
  });
  const referenceResult = await validateTenantBackupReferencePage({
    index: takenValidation,
    after: '',
    assertCompleteInputInspection: async () => {},
  });
  assert.equal(referenceResult.examined, 1);
  assert.equal(referenceResult.done, true);
  assert.equal(referenceResult.unresolvedProvenance, 0);
  const referenceLease = {
    ...decodeLease,
    owner: 'decode-successor',
    fencingToken: decodeTakeover.fencing_token,
  };
  const referencePrepared = await store.checkpoint(
    referenceLease,
    decodeTakeover.revision,
    'validate_input_references',
    JSON.stringify({
      version: 1,
      sessionId: takenValidation.sessionId,
      inputSetDigest: 'ab'.repeat(32),
      after: '',
      examined: 0,
      unresolvedProvenance: 0,
    }),
    decodeNow
  );
  assert(referencePrepared);
  const referenceStep = await runTenantBackupReferenceValidationStep(
    { operation: referencePrepared, lease: referenceLease, signal: new AbortController().signal },
    {
      database: adapter,
      now: () => decodeNow,
      sessionId: takenValidation.sessionId,
      inputSetDigest: 'ab'.repeat(32),
      assertCompleteInputInspection: async () => {},
    }
  );
  const referenceSaved = await store.checkpoint(
    referenceLease,
    referencePrepared.revision,
    referenceStep.phase,
    referenceStep.cursor,
    decodeNow
  );
  assert.equal(referenceSaved?.phase, 'finalize_input_validation');

  assert.equal(
    await takenValidation.recordOnce(exportExpected.bundleId, 'dataset:0:row:0', validatedIdentity),
    false
  );
  assert.equal(
    await resumedValidation.recordOnce(
      exportExpected.bundleId,
      'dataset:0:row:0',
      validatedIdentity
    ),
    false
  );

  await bucket.put(inputIdentity.key, uploadBytes);
  await assert.rejects(
    readTenantBackupInputFrame({
      bucket,
      identity: inputIdentity,
      cursor: inputCursor,
      limits: inputLimits,
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
    }),
    /backup_input_read_failed/
  );

  let publicationNow = 4000101;
  const publicationLease = {
    tenantId: 'tenant-a',
    operationId: 'export-step',
    owner: 'input-decoder',
    fencingToken: inputRun.fencing_token,
  };
  // This focused artifact fixture has no SQL/non-SQL snapshot resources. The dispatcher-level
  // release stage is covered separately; advance the same fenced operation after that empty release.
  const publicationOperation = await store.checkpoint(
    publicationLease,
    inputRun.revision,
    'publish_artifact',
    inputRun.cursor_json,
    publicationNow
  );
  assert(publicationOperation);
  const publicationInventory = new TenantBackupExecutionInventory(
    adapter,
    publicationLease,
    () => publicationNow
  );
  await publicationInventory.create();
  await publicationInventory.append(
    0,
    'fixture-export-plan',
    JSON.stringify({ snapshotId: exportManifest.snapshotId })
  );
  const publicationHead = await publicationInventory.head();
  await publicationInventory.seal(publicationHead.item_count, publicationHead.chain_digest);
  await assert.rejects(
    runTenantBackupArtifactPublicationStep(
      {
        operation: publicationOperation,
        lease: publicationLease,
        signal: new AbortController().signal,
      },
      {
        database: adapter,
        inventory: publicationInventory,
        now: () => publicationNow,
        assertPublishable: async () => {
          throw new Error('capture_not_released');
        },
      }
    ),
    /capture_not_released/
  );
  assert.equal(
    await adapter.queryOne(
      'SELECT operation_id FROM tenant_backup_publications WHERE operation_id=?',
      ['export-step']
    ),
    null
  );
  await store.release(publicationLease, publicationOperation.revision, 'queued', publicationNow);
  for (let slice = 0; slice < 2; slice++) {
    publicationNow += slice ? 40000 : 1;
    const execution = executeTenantBackupSlice(
      store,
      {
        tenantId: 'tenant-a',
        operationId: 'export-step',
        workerId: `publisher-${slice}`,
        signal: new AbortController().signal,
      },
      {
        async run(context) {
          const result = await runTenantBackupArtifactPublicationStep(context, {
            database: adapter,
            inventory: new TenantBackupExecutionInventory(
              adapter,
              context.lease,
              () => publicationNow
            ),
            now: () => publicationNow,
            assertPublishable: async () => {},
          });
          if (!slice) throw new Error('lost_publication_checkpoint');
          return result;
        },
        async cleanup() {
          throw new Error('unexpected publication cleanup');
        },
      },
      () => publicationNow
    );
    if (!slice) await assert.rejects(execution, /backup_operation_slice_failed/);
    else assert.equal((await execution).outcome, 'yielded');
  }
  assert.equal((await store.get('tenant-a', 'export-step'))?.state, 'ready');
  const publication = await adapter.queryOne<{ published_at: number; expires_at: number }>(
    'SELECT published_at,expires_at FROM tenant_backup_publications WHERE operation_id=?',
    ['export-step']
  );
  assert(publication);
  assert.equal(publication.published_at, 4000102);
  assert.equal(publication.expires_at, 4000102 + 604800000);
  const downloadRequest = {
    database: adapter,
    bucket,
    tenantId: 'tenant-a',
    operationId: 'export-step',
    now: () => publicationNow,
    signal: new AbortController().signal,
  };
  const download = await openTenantBackupDownload(downloadRequest);
  const downloaded: Uint8Array[] = [];
  for await (const part of download.chunks) downloaded.push(part);
  assert.deepEqual(Buffer.concat(downloaded), uploadBytes);
  await assert.rejects(
    openTenantBackupDownload({ ...downloadRequest, tenantId: 'other' }),
    /backup_download_unavailable/
  );
  await assert.rejects(
    openTenantBackupDownload({ ...downloadRequest, now: () => publication.expires_at }),
    /backup_download_unavailable/
  );
  const firstDownloadPart = await adapter.queryOne<{ object_key: string; byte_count: number }>(
    'SELECT object_key,byte_count FROM tenant_backup_artifact_parts WHERE attempt_id=? AND ordinal=0',
    [exportWriter.attemptId]
  );
  assert(firstDownloadPart);
  await bucket.put(firstDownloadPart.object_key, new Uint8Array(firstDownloadPart.byte_count));
  const corruptedDownload = await openTenantBackupDownload(downloadRequest);
  await assert.rejects(async () => {
    for await (const part of corruptedDownload.chunks)
      assert.fail(`corrupt part must not be emitted (${part.length} bytes)`);
  }, /backup_download_unavailable/);

  const expiring = await adapter.queryOne<{ attempt_id: string }>(
    'SELECT attempt_id FROM tenant_backup_publications WHERE operation_id=?',
    ['export-step']
  );
  assert(expiring);
  for (let page = 0; page < 20; page++) {
    await cleanupExpiredTenantBackupArtifact({
      database: adapter,
      bucket,
      now: publication.expires_at,
    });
    if (
      !(await adapter.queryOne('SELECT id FROM tenant_backup_artifact_attempts WHERE id=?', [
        expiring.attempt_id,
      ]))
    )
      break;
  }
  assert.equal(await bucket.head(firstDownloadPart.object_key), null);
  assert.equal(
    await adapter.queryOne('SELECT id FROM tenant_backup_artifact_attempts WHERE id=?', [
      expiring.attempt_id,
    ]),
    null
  );
  process.stdout.write(
    JSON.stringify(
      {
        scope: 'local-d1-operation-coordination',
        passed: true,
        verified: [
          'non-null identity',
          'independent per-part verification reaches publication gate across five leased slices',
          'durable export artifact step advances to verification after four separately leased slices',
          'sealed artifact readback verifies each R2 body and rejects a missing part',
          'SQL source cursor reopens at the exact saved output boundary',
          'SQL import inspector validates local D1 source bytes, original values and tenant ownership',
          'isolated D1 restore target imports original rows, retries across leases and rejects old or sealed write guards',
          'sealed restore target supports idempotent sealing and read-only row, count and foreign-key verification',
          'restore target opening compares the complete schema and typed seed data fingerprint',
          'initialized restore destination is pinned in a sealed import inventory and reopened after operation lease takeover',
          'SQL restore executor persists one-row progress and reads back rows, counts and foreign keys across leased slices',
          'sealed SQL sequence binds manifests and module schemas, seals targets and re-verifies all SQL rows before other-store checks',
          'nonce journal resumes across Worker leases and decrypts as one complete v1 stream',
          'R2 input decrypts identically when the cipher decoder is recreated after every authenticated frame',
          'encrypted R2 bundle validates content when cipher and dataset decoders restart at every frame',
          'artifact ownership transfers to new lease without replacing uploaded ciphertext',
          'sealed operation plan starts and resumes SQL capture without replacing preimages',
          'operation-owned cancellation preserves tombstone and rejects late snapshot start',
          'large control-character preimages preserve normal D1 updates',
          'local D1 snapshot dataset preserves prior values and large integer types',
          'local R2 checksummed artifact parts are immutable and idempotent',
          'local D1 applies the portable R2 restore schema and log-record extension',
          'scheduler persists bounded retry delay without private error text',
          'request intent persists atomically in key-waiting state',
          'request intent rejects SQL mutation',
          'start atomically requires an accepted key and current revision',
          'durable encrypted key acceptance rejects replay',
          'accepted keys survive instance restart',
          'cancelled operation keys are inaccessible and collected',
          'cursor persistence',
          'immutable execution inventory seals with matching digest and count',
          'live source schema matches pinned plan and detects DDL changes',
          'migration-installed snapshot storage and operation-owned trigger preparation start local D1 capture',
          'invalidated SQL snapshot cleanup is idempotent and preserves live rows',
          'active lease exclusion',
          'expired lease takeover',
          'old fence rejection',
          'tenant isolation',
          'cancelled work cannot restart',
          'cleanup cursor survives yield',
          'stale cleanup cannot finish',
          'current cleanup reaches cancelled',
          'validation index rejects duplicates across bundles',
          'validation references page across local D1 queries',
          'sealed index rejects new records',
          'cancelled validation loses read access',
          'bounded scratch cleanup preserves foreign keys',
          'scratch cleanup resumes without original index instance',
        ],
        largeRow: { portableBytes: largeBytes, chunks: largeChunks },
        productionWriterFencing: false,
      },
      null,
      2
    ) + '\n'
  );
} finally {
  await runtime.dispose();
}
