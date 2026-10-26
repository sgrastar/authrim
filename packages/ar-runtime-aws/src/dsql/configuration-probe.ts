import { randomUUID } from 'node:crypto';
import type { VerifiedTenantBackupV2 } from '../import/backup-reader';
import type { DsqlProbeDatabase } from './probe';
import { createDsqlConfigurationFixture } from './configuration-fixture';
import { initializeDsqlConfigurationSchema } from './configuration-schema';
import type { DsqlIdentitySchemaProgress } from './identity-schema';
import {
  createDsqlConfigurationImportJournal,
  DsqlConfigurationImportValidationError,
  DsqlConfigurationVerificationMismatch,
  restoreDsqlConfigurationSlice,
  verifyDsqlConfigurationSubset,
  verifyDsqlConfigurationReferences,
} from './configuration-import';

export interface DsqlConfigurationProbeResult {
  formatVersion: 1;
  mode: 'synthetic-native-configuration';
  fullRuntimeReady: false;
  passed: boolean;
  schema: string;
  checks: Array<{ name: string; passed: boolean; sqlState?: string; failureCode?: string }>;
  restoredRows?: Record<string, number>;
  omittedDatasets?: string[];
  chunks?: number;
  maxChunkRows?: number;
  cleanup: 'not-needed' | 'complete' | 'failed' | 'creation-unconfirmed';
}

function requireResult(condition: boolean): void {
  if (!condition) throw new Error('dsql_configuration_probe_assertion_failed');
}

function cleanupTableName(name: string): string {
  if (!/^[a-z_]+$/u.test(name)) throw new Error('dsql_configuration_cleanup_invalid');
  return name;
}

function failureCode(error: unknown): string | undefined {
  const allowed = [
    'dsql_configuration_schema_create_failed',
    'dsql_configuration_table_create_failed',
    'dsql_configuration_index_job_missing',
    'dsql_configuration_index_job_invalid',
    'dsql_configuration_index_build_failed',
    'dsql_configuration_index_catalog_invalid',
    'dsql_configuration_index_status_invalid',
    'dsql_configuration_index_wait_exhausted',
    'dsql_configuration_schema_initialization_failed',
  ];
  return error instanceof Error && allowed.includes(error.message) ? error.message : undefined;
}

async function requireRejected(
  operation: () => Promise<unknown>,
  expected: 'validation' | 'mismatch' | '23505' | '23503' | '23514'
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (expected === 'validation') {
      requireResult(error instanceof DsqlConfigurationImportValidationError);
    } else if (expected === 'mismatch') {
      requireResult(error instanceof DsqlConfigurationVerificationMismatch);
    } else {
      requireResult(
        typeof error === 'object' && error !== null && 'code' in error && error.code === expected
      );
    }
    return;
  }
  throw new Error('dsql_configuration_probe_rejection_expected');
}

/**
 * Only encrypted, freshly generated synthetic configuration enters this experiment.
 * It verifies storage/reference invariants, not Flow execution or SAML signing. It
 * neither accepts customer backup paths nor creates a runtime activation receipt.
 */
export async function runDsqlConfigurationProbe(
  db: DsqlProbeDatabase,
  options: { writeProbe: true; spCount?: number }
): Promise<DsqlConfigurationProbeResult> {
  if (
    db.getType() !== 'aurora-dsql' ||
    options.writeProbe !== true ||
    !Number.isSafeInteger(options.spCount ?? 101) ||
    (options.spCount ?? 101) < 1 ||
    (options.spCount ?? 101) > 2000
  ) {
    throw new Error('dsql_configuration_probe_explicit_write_required');
  }
  const result: DsqlConfigurationProbeResult = {
    formatVersion: 1,
    mode: 'synthetic-native-configuration',
    fullRuntimeReady: false,
    passed: false,
    schema: `authrim_dsql_configuration_${randomUUID().replaceAll('-', '')}`,
    checks: [],
    cleanup: 'not-needed',
  };
  let schemaCreated = false;
  let pendingDdl = false;
  const createdTables: string[] = [];
  let fixture: Awaited<ReturnType<typeof createDsqlConfigurationFixture>> | undefined;
  let backup: VerifiedTenantBackupV2 | undefined;
  let currentCheck = 'database';
  const progress = (event: DsqlIdentitySchemaProgress) => {
    if (event.status === 'attempted') {
      pendingDdl = true;
      result.cleanup = 'creation-unconfirmed';
    } else if (event.kind === 'schema' && event.status === 'created') {
      schemaCreated = true;
      pendingDdl = false;
    } else if (event.kind === 'table' && event.status === 'created') {
      createdTables.push(event.name);
      pendingDdl = false;
    } else if (event.kind === 'index' && event.status === 'ready') {
      pendingDdl = false;
    }
  };
  const check = async (name: string, operation: () => Promise<void>) => {
    currentCheck = name;
    await operation();
    result.checks.push({ name, passed: true });
  };
  try {
    await check('database', async () => {
      const row = await db.queryOne<{ name: string }>('SELECT current_database() AS name');
      requireResult(row?.name === 'postgres');
    });
    await check('native-schema-and-indexes', async () => {
      await initializeDsqlConfigurationSchema(db, result.schema, { onProgress: progress });
      await createDsqlConfigurationImportJournal(db, result.schema, { onProgress: progress });
    });
    await check('encrypted-synthetic-backup', async () => {
      fixture = await createDsqlConfigurationFixture({ spCount: options.spCount });
      backup = fixture.backup;
    });
    if (!fixture || !backup) throw new Error('dsql_configuration_fixture_missing');
    const verifiedFixture = fixture;
    const input = () => {
      if (!backup) throw new Error('dsql_configuration_fixture_missing');
      return {
        db,
        schema: result.schema,
        backup,
        tenantId: verifiedFixture.tenantId,
        trustedReceiptSha256: verifiedFixture.trustedReceiptDigest,
        maxRowsPerChunk: 100,
      };
    };
    await check('partial-import', async () => {
      const step = await restoreDsqlConfigurationSlice(input());
      requireResult(step.status === 'loading');
    });
    await check('changed-source-and-tenant-rejected', async () => {
      await requireRejected(
        () => restoreDsqlConfigurationSlice({ ...input(), tenantId: 'synthetic-other-tenant' }),
        'validation'
      );
      await requireRejected(
        () => restoreDsqlConfigurationSlice({ ...input(), trustedReceiptSha256: 'f'.repeat(64) }),
        'validation'
      );
    });
    await check('resume-after-reopening-backup', async () => {
      await input().backup.close();
      backup = await verifiedFixture.reopen();
      for (let step = 0; step < 1000; step++) {
        const state = await restoreDsqlConfigurationSlice(input());
        if (state.status === 'sealed' || state.status === 'native_subset_verified') return;
      }
      throw new Error('dsql_configuration_probe_step_limit');
    });
    await check('native-readback-and-reference-verification', async () => {
      const receipt = await verifyDsqlConfigurationSubset(input());
      requireResult(receipt.status === 'native_subset_verified' && !receipt.fullRuntimeReady);
      result.restoredRows = Object.fromEntries(
        receipt.tables.map((table) => [table.datasetId, table.rowCount])
      );
      for (const [id, count] of Object.entries(verifiedFixture.expectedRows).filter(
        ([, count]) => count > 0
      )) {
        requireResult(result.restoredRows[id] === count);
      }
      result.omittedDatasets = [...receipt.omittedDatasets];
      requireResult(result.omittedDatasets.length === 14);
      const chunks = await db.queryOne<{ count: string; max_rows: number; total_rows: string }>(
        `SELECT COUNT(*)::text AS count,
                MAX((chunk_json::jsonb ->> 'rows')::integer) AS max_rows,
                SUM((chunk_json::jsonb ->> 'rows')::integer)::text AS total_rows
         FROM "${result.schema}"."authrim_configuration_import_chunks"`
      );
      result.chunks = Number(chunks?.count);
      result.maxChunkRows = chunks?.max_rows;
      const minimumChunks = Object.values(result.restoredRows).reduce(
        (sum, count) => sum + Math.ceil(count / 100),
        0
      );
      requireResult(
        Number.isSafeInteger(result.chunks) &&
          result.chunks >= minimumChunks &&
          typeof result.maxChunkRows === 'number' &&
          result.maxChunkRows <= 100 &&
          Number(chunks?.total_rows) ===
            Object.values(result.restoredRows).reduce((sum, count) => sum + count, 0)
      );
    });
    await check('native-uniqueness-enforced', async () => {
      // A distinct primary key must not allow duplicate SAML entity IDs or default assignments.
      for (const sql of [
        `INSERT INTO "${result.schema}"."identity_providers"
         (id,name,provider_type,config_json,enabled,created_at,updated_at,tenant_id)
         SELECT $1,name,provider_type,config_json,enabled,created_at,updated_at,tenant_id
         FROM "${result.schema}"."identity_providers" ORDER BY id LIMIT 1`,
        `INSERT INTO "${result.schema}"."flow_assignments"
         (id,tenant_id,target_type,target_id,flow_kind,flow_id,enabled,created_at,updated_at)
         SELECT $1,tenant_id,target_type,target_id,flow_kind,flow_id,enabled,created_at,updated_at
         FROM "${result.schema}"."flow_assignments" WHERE target_type='tenant' LIMIT 1`,
      ]) {
        await requireRejected(
          () =>
            db.transaction(async (tx) => {
              await tx.execute(sql, [`duplicate-${randomUUID()}`]);
            }),
          '23505'
        );
      }
      await verifyDsqlConfigurationSubset(input());
    });
    await check('native-foreign-key-enforced', async () => {
      for (const name of ['flow_versions', 'flow_assignments']) {
        await requireRejected(
          () =>
            db.transaction(async (tx) => {
              await tx.execute(
                `UPDATE "${result.schema}"."${name}" SET flow_id=$1
            WHERE id=(SELECT id FROM "${result.schema}"."${name}" ORDER BY id LIMIT 1)`,
                [`missing-${randomUUID()}`]
              );
            }),
          '23503'
        );
      }
      await verifyDsqlConfigurationSubset(input());
    });
    await check('native-target-shape-enforced', async () => {
      await requireRejected(
        () =>
          db.transaction(async (tx) => {
            await tx.execute(`UPDATE "${result.schema}"."flow_assignments" SET target_type='tenant'
          WHERE id='synthetic-assignment-000000'`);
          }),
        '23514'
      );
      await verifyDsqlConfigurationSubset(input());
    });
    const rejectChangedReference = async (change: string, restore: string) => {
      requireResult((await db.execute(change)).rowsAffected === 1);
      // Direct reference verification avoids merely detecting the changed row hash.
      await requireRejected(
        () => verifyDsqlConfigurationReferences(db, result.schema, verifiedFixture.tenantId),
        'mismatch'
      );
      requireResult((await db.execute(restore)).rowsAffected === 1);
      await verifyDsqlConfigurationSubset(input());
    };
    await check('cross-tenant-reference-rejected', async () => {
      await rejectChangedReference(
        `UPDATE "${result.schema}"."flow_versions" SET tenant_id='synthetic-other-tenant' WHERE id='synthetic-version-000000'`,
        `UPDATE "${result.schema}"."flow_versions" SET tenant_id='dsql-synthetic-configuration' WHERE id='synthetic-version-000000'`
      );
    });
    await check('missing-sp-reference-rejected', async () => {
      await rejectChangedReference(
        `UPDATE "${result.schema}"."flow_assignments" SET target_id='https://missing.example.test/entity' WHERE id='synthetic-assignment-000000'`,
        `UPDATE "${result.schema}"."flow_assignments" SET target_id='https://sp-000000.example.test/entity' WHERE id='synthetic-assignment-000000'`
      );
    });
    await check('unsupported-target-inventory-rejected', async () => {
      await rejectChangedReference(
        `UPDATE "${result.schema}"."flow_assignments" SET target_type='oidc_client' WHERE id='synthetic-assignment-000000'`,
        `UPDATE "${result.schema}"."flow_assignments" SET target_type='saml_sp' WHERE id='synthetic-assignment-000000'`
      );
    });
    await check('invalid-configuration-json-rejected', async () => {
      const row = await db.queryOne<{ runtime_snapshot_json: string }>(
        `SELECT runtime_snapshot_json FROM "${result.schema}"."flow_versions" WHERE id=$1`,
        ['synthetic-version-000000']
      );
      requireResult(typeof row?.runtime_snapshot_json === 'string');
      requireResult(
        (
          await db.execute(
            `UPDATE "${result.schema}"."flow_versions" SET runtime_snapshot_json=$1 WHERE id=$2`,
            ['not json', 'synthetic-version-000000']
          )
        ).rowsAffected === 1
      );
      await requireRejected(
        () => verifyDsqlConfigurationReferences(db, result.schema, verifiedFixture.tenantId),
        'mismatch'
      );
      requireResult(
        (
          await db.execute(
            `UPDATE "${result.schema}"."flow_versions" SET runtime_snapshot_json=$1 WHERE id=$2`,
            [row?.runtime_snapshot_json, 'synthetic-version-000000']
          )
        ).rowsAffected === 1
      );
      await verifyDsqlConfigurationSubset(input());
    });
    await check('precise-json-number-change-rejected', async () => {
      const setNumber = (from: string, to: string) =>
        db.execute(
          `UPDATE "${result.schema}"."flow_versions"
         SET runtime_snapshot_json=replace(runtime_snapshot_json,$1,$2)
         WHERE id='synthetic-version-000000'`,
          [from, to]
        );
      requireResult((await setNumber('9007199254740993', '9007199254740992')).rowsAffected === 1);
      await requireRejected(() => verifyDsqlConfigurationSubset(input()), 'mismatch');
      requireResult((await setNumber('9007199254740992', '9007199254740993')).rowsAffected === 1);
      await verifyDsqlConfigurationSubset(input());
    });
    await check('changed-native-row-rejected', async () => {
      requireResult(
        (
          await db.execute(
            `UPDATE "${result.schema}"."identity_providers" SET enabled=0 WHERE id='synthetic-sp-000000'`
          )
        ).rowsAffected === 1
      );
      await requireRejected(() => verifyDsqlConfigurationSubset(input()), 'mismatch');
    });
    result.passed = true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    result.checks.push({
      name: currentCheck,
      passed: false,
      ...(failureCode(error) ? { failureCode: failureCode(error) } : {}),
      ...(typeof code === 'string' && /^[A-Z0-9]{5}$/u.test(code) ? { sqlState: code } : {}),
    });
  } finally {
    // Reader close checks the pinned files; fixture close removes those same files.
    // Complete the check first, and still remove the fixture if that check fails.
    let localCleanupFailed = false;
    for (const close of [() => backup?.close(), () => fixture?.close()]) {
      try {
        await close();
      } catch {
        localCleanupFailed = true;
      }
    }
    if (localCleanupFailed) {
      result.passed = false;
      result.checks.push({ name: 'local-fixture-cleanup', passed: false });
    }
    if (schemaCreated && !pendingDdl) {
      try {
        // Only names confirmed by our initializer are eligible, with no CASCADE.
        for (const name of [...createdTables].reverse()) {
          await db.execute(`DROP TABLE "${result.schema}"."${cleanupTableName(name)}"`);
        }
        await db.execute(`DROP SCHEMA "${result.schema}"`);
        result.cleanup = 'complete';
      } catch {
        result.cleanup = 'failed';
        result.passed = false;
      }
    }
  }
  return result;
}
