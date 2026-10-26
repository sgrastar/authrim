/** Compare live Core and PII databases to the activated source after expected auth writes. */
import { Client, type Pool } from 'pg';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { VerifiedTenantBackupV2 } from '../import/backup-reader';
import { verifyPostgresFamilyStagingRows } from '../import/postgres-restore';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';
import { restoreEvidenceDigest } from '../import/restore-evidence';
import { readVerifiedRows } from '../import/verified-rows';

const MUTABLE_DATASETS = ['core.identity_accounts', 'core.passkeys'] as const;
const ACCOUNT_COLUMNS =
  POSTGRES_RESTORE_TABLE_CONTRACTS.find((spec) => spec.datasetId === 'core.identity_accounts')
    ?.columns ?? [];
const PASSKEY_COLUMNS =
  POSTGRES_RESTORE_TABLE_CONTRACTS.find((spec) => spec.datasetId === 'core.passkeys')?.columns ??
  [];

function invalid(): never {
  throw new Error('aws_live_database_invalid');
}

function sourceValue(row: PortableSqliteRow, column: string): string | null {
  const value = row[column];
  if (!value) invalid();
  if (value[0] === 'null' && value[1] === null) return null;
  if ((value[0] !== 'text' && value[0] !== 'integer') || typeof value[1] !== 'string') invalid();
  return value[1];
}

function targetValue(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') invalid();
  return String(value);
}

function milliseconds(value: string | null): number {
  if (!value || !/^(?:0|[1-9][0-9]*)$/u.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid();
  return parsed;
}

function counter(value: string | null): bigint {
  if (!value || !/^(?:0|[1-9][0-9]*)$/u.test(value)) invalid();
  const parsed = BigInt(value);
  if (parsed > 2n ** 63n - 1n) invalid();
  return parsed;
}

function metadata(value: string | null): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = value === null ? {} : (JSON.parse(value) as unknown);
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  return parsed as Record<string, unknown>;
}

function assertAccountMetadata(
  original: string | null,
  current: string | null,
  originalUpdatedAt: string | null,
  currentUpdatedAt: string | null,
  activatedAtMs: number
): void {
  if (original === current && originalUpdatedAt === currentUpdatedAt) return;
  const before = metadata(original);
  const after = metadata(current);
  const beforeLogin = before.last_login_at;
  const afterLogin = after.last_login_at;
  delete before.last_login_at;
  delete after.last_login_at;
  if (
    restoreEvidenceDigest(before) !== restoreEvidenceDigest(after) ||
    typeof afterLogin !== 'number' ||
    !Number.isSafeInteger(afterLogin) ||
    afterLogin < activatedAtMs ||
    (beforeLogin !== undefined &&
      (typeof beforeLogin !== 'number' ||
        !Number.isSafeInteger(beforeLogin) ||
        afterLogin < beforeLogin)) ||
    milliseconds(currentUpdatedAt) < Math.max(milliseconds(originalUpdatedAt), activatedAtMs)
  )
    invalid();
}

async function sourceRows(
  backup: VerifiedTenantBackupV2,
  datasetId: string,
  columns: readonly string[]
): Promise<Map<string, PortableSqliteRow>> {
  const rows = await readVerifiedRows(backup, datasetId);
  const byId = new Map<string, PortableSqliteRow>();
  for (const row of rows) {
    if (
      Object.keys(row).length !== columns.length ||
      columns.some((column) => !Object.hasOwn(row, column)) ||
      sourceValue(row, 'tenant_id') !== backup.manifest.source.tenantId
    )
      invalid();
    const id = sourceValue(row, 'id');
    if (!id || byId.has(id)) invalid();
    byId.set(id, row);
  }
  return byId;
}

async function targetRows(
  db: Client,
  table: 'identity_accounts' | 'passkeys',
  columns: readonly string[],
  tenantId: string,
  expectedCount: number
): Promise<Map<string, Record<string, unknown>>> {
  if (columns.length === 0) invalid();
  const count = await db.query<{ count: string }>(`SELECT count(*) AS count FROM "${table}"`);
  if (count.rows.length !== 1 || Number(count.rows[0].count) !== expectedCount) invalid();
  const names = columns.map((column) => `"${column}"`).join(',');
  const result = await db.query<Record<string, unknown>>(
    `SELECT ${names} FROM "${table}" WHERE tenant_id=$1 LIMIT $2`,
    [tenantId, expectedCount + 1]
  );
  if (result.rows.length !== expectedCount) invalid();
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of result.rows) {
    const id = targetValue(row, 'id');
    if (!id || byId.has(id)) invalid();
    byId.set(id, row);
  }
  return byId;
}

function assertUnchanged(
  source: PortableSqliteRow,
  target: Record<string, unknown>,
  columns: readonly string[],
  mutable: ReadonlySet<string>
): void {
  for (const column of columns) {
    if (!mutable.has(column) && sourceValue(source, column) !== targetValue(target, column))
      invalid();
  }
}

export async function verifyActivatedDatabaseRows(input: {
  backup: VerifiedTenantBackupV2;
  core: { connectionString: string; targetId: string };
  pii: { connectionString: string; targetId: string };
  stateDb: Pool;
  /** Read the selected authority after the Core snapshot; never use the legacy SQL copy on DynamoDB. */
  readPasskeyCounters?: () => Promise<
    Array<{ user_id: string; credential_id: string; counter: string }>
  >;
  activatedAtMs: number;
}): Promise<void> {
  try {
    if (!Number.isSafeInteger(input.activatedAtMs) || input.activatedAtMs < 1) invalid();
    await Promise.all([
      verifyPostgresFamilyStagingRows({
        ...input.core,
        skipDatasetIds: MUTABLE_DATASETS,
        clientFactory: (connectionString) =>
          new Client({ connectionString, connectionTimeoutMillis: 5_000 }),
      }),
      verifyPostgresFamilyStagingRows({
        ...input.pii,
        clientFactory: (connectionString) =>
          new Client({ connectionString, connectionTimeoutMillis: 5_000 }),
      }),
    ]);

    const tenantId = input.backup.manifest.source.tenantId;
    const [accounts, passkeys] = await Promise.all([
      sourceRows(input.backup, 'core.identity_accounts', ACCOUNT_COLUMNS),
      sourceRows(input.backup, 'core.passkeys', PASSKEY_COLUMNS),
    ]);
    const core = new Client({
      connectionString: input.core.connectionString,
      connectionTimeoutMillis: 5_000,
    });
    await core.connect();
    try {
      await core.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const liveAccounts = await targetRows(
          core,
          'identity_accounts',
          ACCOUNT_COLUMNS,
          tenantId,
          accounts.size
        );
        const livePasskeys = await targetRows(
          core,
          'passkeys',
          PASSKEY_COLUMNS,
          tenantId,
          passkeys.size
        );
        // State is authoritative and advances before the eventual Core mirror. Read it
        // after the Core snapshot so a concurrent verified login cannot look like rollback.
        const stateCounters = input.readPasskeyCounters
          ? await input.readPasskeyCounters()
          : (
              await input.stateDb.query<{
                user_id: string;
                credential_id: string;
                counter: string;
              }>(
                `SELECT user_id,credential_id,counter FROM authrim_aws_passkey_counters
           WHERE tenant_id=$1`,
                [tenantId]
              )
            ).rows;
        if (stateCounters.length !== passkeys.size) invalid();
        const counters = new Map(stateCounters.map((row) => [row.credential_id, row]));
        if (counters.size !== passkeys.size) invalid();
        for (const [id, original] of accounts) {
          const current = liveAccounts.get(id);
          if (!current) invalid();
          assertUnchanged(
            original,
            current,
            ACCOUNT_COLUMNS,
            new Set(['metadata_json', 'updated_at'])
          );
          assertAccountMetadata(
            sourceValue(original, 'metadata_json'),
            targetValue(current, 'metadata_json'),
            sourceValue(original, 'updated_at'),
            targetValue(current, 'updated_at'),
            input.activatedAtMs
          );
        }
        for (const [id, original] of passkeys) {
          const current = livePasskeys.get(id);
          if (!current) invalid();
          assertUnchanged(original, current, PASSKEY_COLUMNS, new Set(['counter', 'last_used_at']));
          // The DO and AWS authority index counters by Core passkey row ID.
          // The raw WebAuthn credential ID remains an immutable Core field.
          const state = counters.get(id);
          const oldCounter = counter(sourceValue(original, 'counter'));
          const newCounter = counter(targetValue(current, 'counter'));
          if (
            !state ||
            state.user_id !== sourceValue(original, 'user_id') ||
            newCounter < oldCounter ||
            newCounter > counter(state.counter)
          )
            invalid();
          const oldUsed = sourceValue(original, 'last_used_at');
          const newUsed = targetValue(current, 'last_used_at');
          if (newCounter !== oldCounter || newUsed !== oldUsed) {
            if (
              newUsed === null ||
              milliseconds(newUsed) <
                Math.max(oldUsed === null ? 0 : milliseconds(oldUsed), input.activatedAtMs)
            )
              invalid();
          }
        }
        await core.query('COMMIT');
      } catch {
        await core.query('ROLLBACK').catch(() => undefined);
        throw new Error('aws_live_database_invalid');
      }
    } finally {
      await core.end();
    }
  } catch {
    invalid();
  }
}
