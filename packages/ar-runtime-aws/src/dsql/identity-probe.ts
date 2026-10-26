import { randomUUID } from 'node:crypto';
import type { VerifiedTenantBackupV2 } from '../import/backup-reader';
import type { DsqlProbeDatabase } from './probe';
import { createDsqlIdentityFixture } from './identity-fixture';
import { initializeDsqlIdentitySchema, type DsqlIdentitySchemaProgress } from './identity-schema';
import {
  createDsqlIdentityImportJournal,
  DsqlIdentityImportValidationError,
  DsqlIdentityVerificationMismatch,
  restoreDsqlIdentitySlice,
  verifyDsqlIdentitySubset,
} from './identity-import';

export interface DsqlIdentityProbeResult {
  formatVersion: 1;
  mode: 'synthetic-native-identity';
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
  if (!condition) throw new Error('dsql_identity_probe_assertion_failed');
}

function cleanupTableName(name: string): string {
  if (!/^[a-z_]+$/u.test(name)) throw new Error('dsql_identity_cleanup_invalid');
  return name;
}

function failureCode(error: unknown): string | undefined {
  const allowed = [
    'dsql_identity_schema_create_failed',
    'dsql_identity_table_create_failed',
    'dsql_identity_index_job_missing',
    'dsql_identity_index_job_invalid',
    'dsql_identity_index_build_failed',
    'dsql_identity_index_catalog_invalid',
    'dsql_identity_index_status_invalid',
    'dsql_identity_index_wait_exhausted',
    'dsql_identity_schema_initialization_failed',
  ];
  return error instanceof Error && allowed.includes(error.message) ? error.message : undefined;
}

async function requireRejected(
  operation: () => Promise<unknown>,
  expected: 'validation' | 'mismatch' | '23505'
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (expected === 'validation') {
      requireResult(error instanceof DsqlIdentityImportValidationError);
    } else if (expected === 'mismatch') {
      requireResult(error instanceof DsqlIdentityVerificationMismatch);
    } else {
      requireResult(
        typeof error === 'object' && error !== null && 'code' in error && error.code === expected
      );
    }
    return;
  }
  throw new Error('dsql_identity_probe_rejection_expected');
}

/**
 * Only encrypted, freshly generated synthetic input enters this experiment. It
 * neither accepts customer backup paths nor creates a runtime activation receipt.
 */
export async function runDsqlIdentityProbe(
  db: DsqlProbeDatabase,
  options: { writeProbe: true; userCount?: number }
): Promise<DsqlIdentityProbeResult> {
  if (
    db.getType() !== 'aurora-dsql' ||
    options.writeProbe !== true ||
    !Number.isSafeInteger(options.userCount ?? 201) ||
    (options.userCount ?? 201) < 1 ||
    (options.userCount ?? 201) > 2000
  ) {
    throw new Error('dsql_identity_probe_explicit_write_required');
  }
  const result: DsqlIdentityProbeResult = {
    formatVersion: 1,
    mode: 'synthetic-native-identity',
    fullRuntimeReady: false,
    passed: false,
    schema: `authrim_dsql_identity_${randomUUID().replaceAll('-', '')}`,
    checks: [],
    cleanup: 'not-needed',
  };
  let schemaCreated = false;
  let pendingDdl = false;
  const createdTables: string[] = [];
  let fixture: Awaited<ReturnType<typeof createDsqlIdentityFixture>> | undefined;
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
      await initializeDsqlIdentitySchema(db, result.schema, { onProgress: progress });
      await createDsqlIdentityImportJournal(db, result.schema, { onProgress: progress });
    });
    await check('encrypted-synthetic-backup', async () => {
      fixture = await createDsqlIdentityFixture({ userCount: options.userCount });
      backup = fixture.backup;
    });
    if (!fixture || !backup) throw new Error('dsql_identity_fixture_missing');
    const verifiedFixture = fixture;
    const input = () => {
      if (!backup) throw new Error('dsql_identity_fixture_missing');
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
      const step = await restoreDsqlIdentitySlice(input());
      requireResult(step.status === 'loading');
    });
    await check('changed-source-and-tenant-rejected', async () => {
      await requireRejected(
        () => restoreDsqlIdentitySlice({ ...input(), tenantId: 'synthetic-other-tenant' }),
        'validation'
      );
      await requireRejected(
        () => restoreDsqlIdentitySlice({ ...input(), trustedReceiptSha256: 'f'.repeat(64) }),
        'validation'
      );
    });
    await check('resume-after-reopening-backup', async () => {
      await input().backup.close();
      backup = await verifiedFixture.reopen();
      for (let step = 0; step < 1000; step++) {
        const state = await restoreDsqlIdentitySlice(input());
        if (state.status === 'sealed' || state.status === 'native_subset_verified') return;
      }
      throw new Error('dsql_identity_probe_step_limit');
    });
    await check('native-readback-and-reference-verification', async () => {
      const receipt = await verifyDsqlIdentitySubset(input());
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
      requireResult(result.omittedDatasets.length === 15);
      const chunks = await db.queryOne<{ count: string; max_rows: number; total_rows: string }>(
        `SELECT COUNT(*)::text AS count,
                MAX((chunk_json::jsonb ->> 'rows')::integer) AS max_rows,
                SUM((chunk_json::jsonb ->> 'rows')::integer)::text AS total_rows
         FROM "${result.schema}"."authrim_identity_import_chunks"`
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
      // This transaction must fail before commit; the original native row remains.
      await requireRejected(
        () =>
          db.transaction(async (tx) => {
            await tx.execute(
              `INSERT INTO "${result.schema}"."passkeys"
             (id, tenant_id, user_id, credential_id, public_key, counter, created_at)
             SELECT $1, tenant_id, user_id, credential_id, public_key, counter, created_at
             FROM "${result.schema}"."passkeys" ORDER BY id LIMIT 1`,
              [`duplicate-${randomUUID()}`]
            );
          }),
        '23505'
      );
      await verifyDsqlIdentitySubset(input());
    });
    await check('precise-json-number-change-rejected', async () => {
      const setNumber = (value: '9007199254740992' | '9007199254740993') =>
        db.execute(
          `UPDATE "${result.schema}"."users_pii"
         SET custom_attributes_json = jsonb_set(custom_attributes_json, '{preciseInteger}', $1::jsonb)
         WHERE id = (SELECT id FROM "${result.schema}"."users_pii" ORDER BY id LIMIT 1)`,
          [value]
        );
      requireResult((await setNumber('9007199254740992')).rowsAffected === 1);
      await requireRejected(() => verifyDsqlIdentitySubset(input()), 'mismatch');
      requireResult((await setNumber('9007199254740993')).rowsAffected === 1);
      await verifyDsqlIdentitySubset(input());
    });
    await check('changed-native-row-rejected', async () => {
      const changed = await db.execute(
        `UPDATE "${result.schema}"."passkeys" SET counter = counter + 1
         WHERE id = (SELECT id FROM "${result.schema}"."passkeys" ORDER BY id LIMIT 1)`
      );
      requireResult(changed.rowsAffected === 1);
      await requireRejected(() => verifyDsqlIdentitySubset(input()), 'mismatch');
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
