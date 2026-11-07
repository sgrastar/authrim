import {
  assertControlPlaneRecordIsSecretFree,
  validateAccountDirectoryPublishRequest,
  type AccountDirectoryPublishResult,
  type AccountDirectoryPublishRequest,
} from '../control-plane/control-plane-contracts';
import type { DatabaseAdapter, PreparedStatement, TransactionContext } from '../../db/adapter';
import {
  lookupVirtualBucket,
  type LookupBlindIndex,
  type LookupIdentifierKind,
} from './blind-index';
import { LOOKUP_MAX_VIRTUAL_BUCKET } from './contract.js';

const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const KINDS = new Set<LookupIdentifierKind>(['email_exact', 'external_subject', 'account_id']);

export interface AccountDirectoryPublication extends AccountDirectoryPublishRequest {
  indexes: LookupBlindIndex[];
}

export interface AccountDirectoryRemovalPublication extends AccountDirectoryPublishRequest {
  scope: 'account' | 'identifier';
  indexes: LookupBlindIndex[];
}

export interface AccountDirectoryServiceBinding {
  publishAccountDirectory(
    publication: AccountDirectoryPublication
  ): Promise<AccountDirectoryPublishResult>;
  removeAccountDirectory?(
    publication: AccountDirectoryRemovalPublication
  ): Promise<AccountDirectoryPublishResult>;
}

export function accountDirectoryOutboxId(operationId: string): string {
  return `account-routing:${operationId}`;
}

export function accountDirectoryRemovalOutboxId(operationId: string): string {
  return `account-routing-removal:${operationId}`;
}

export async function markAccountDirectoryPublicationReady(
  adapter: DatabaseAdapter,
  operationId: string,
  now: number
): Promise<void> {
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('invalid_directory_publication_time');
  const result = await adapter.execute(
    `UPDATE account_routing_outbox
        SET status = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE outbox_id = ? AND status = 'prepared'`,
    [now, now, accountDirectoryOutboxId(operationId)]
  );
  if (result.rowsAffected === 1) return;
  const reflected = await adapter.queryOne<{ status: string }>(
    `SELECT status FROM account_routing_outbox WHERE outbox_id = ?`,
    [accountDirectoryOutboxId(operationId)]
  );
  if (!reflected || !['pending', 'leased', 'retry', 'succeeded'].includes(reflected.status)) {
    throw new Error('directory_routing_outbox_ready_failed');
  }
}

/** The account a removal of the whole account was about to prepare is under a legal hold. */
export const DIRECTORY_REMOVAL_ACCOUNT_HELD = 'directory_removal_account_held';

/**
 * No legal hold stands on `account`, as the deletion transition reads it
 * (accountDeletionPlan): its hold authority row is inactive and no active hold exists. A hold
 * placed later is refused, because the account is then `deleting`.
 */
const ACCOUNT_NOT_HELD_SQL = `EXISTS (SELECT 1 FROM account_legal_hold_states hold_state
      WHERE hold_state.tenant_id = account.tenant_id AND hold_state.account_id = account.id
        AND hold_state.projection_state = 'inactive' AND hold_state.active_hold_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM legal_holds hold
      WHERE hold.tenant_id = account.tenant_id AND hold.subject_id = account.id
        AND hold.subject_type = 'account' AND hold.state = 'active')`;

/**
 * Takes the account's hold authority row first, as placing a hold does (legalHoldGuardStatement):
 * on PostgreSQL its row lock, on Aurora DSQL a write conflict, puts the two in an order. Matches
 * no row while a hold stands.
 */
function accountRemovalHoldGuardStatement(
  tenantId: string,
  accountId: string,
  now: number
): PreparedStatement {
  return {
    sql: `UPDATE account_legal_hold_states
             SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
           WHERE tenant_id = ? AND account_id = ?
             AND projection_state = 'inactive' AND active_hold_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM legal_holds hold
               WHERE hold.tenant_id = ? AND hold.subject_id = ?
                 AND hold.subject_type = 'account' AND hold.state = 'active')`,
    params: [now * 1000, now * 1000, tenantId, accountId, tenantId, accountId],
  };
}

function accountDirectoryRemovalOutboxStatement(
  publication: AccountDirectoryRemovalPublication,
  now: number
): PreparedStatement {
  const routeGeneration = publication.routeProjection.accountRouteGeneration;
  const hmacKeyGeneration = Math.max(
    ...publication.indexes.map((index) => index.hmacKeyGeneration)
  );
  const accountStatePredicate =
    publication.scope === 'account'
      ? `account.lifecycle_state IN ('active', 'deprovisioned', 'deleting')
           AND account.directory_publication_state IN ('active', 'disabled')
           AND ${ACCOUNT_NOT_HELD_SQL}`
      : `account.lifecycle_state = 'active'
           AND account.directory_publication_state = 'active'`;
  return {
    sql: `INSERT INTO account_routing_outbox (
            outbox_id, tenant_id, account_id, event_kind, route_generation,
            route_schema_version, hmac_key_generation, payload_json, status,
            attempt_count, created_at, updated_at
          )
          SELECT ?, account.tenant_id, account.id, ?, ?, ?, ?, ?, 'prepared', 0, ?, ?
            FROM identity_accounts account
           WHERE account.tenant_id = ? AND account.id = ?
             AND account.account_route_generation = ?
             AND ${accountStatePredicate}`,
    params: [
      accountDirectoryRemovalOutboxId(publication.operationId),
      publication.scope === 'account' ? 'account_deleted' : 'identifier_removed',
      routeGeneration,
      publication.routeProjection.schemaVersion,
      hmacKeyGeneration,
      JSON.stringify(publication),
      now,
      now,
      publication.tenantId,
      publication.accountId,
      routeGeneration,
    ],
  };
}

/**
 * Atomically prepares one logical removal, including every chunk and the
 * fail-closed account state transition. D1 callback transactions cannot
 * provide rollback, so multi-statement callers must use this batch boundary.
 */
export async function insertPreparedAccountDirectoryRemovals(
  adapter: DatabaseAdapter,
  values: readonly AccountDirectoryRemovalPublication[],
  now: number
): Promise<void> {
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('invalid_directory_removal_time');
  if (values.length < 1 || values.length > 256) {
    throw new Error('invalid_directory_removal_batch_size');
  }
  const publications = await Promise.all(values.map(validateAccountDirectoryRemovalPublication));
  const first = publications[0];
  if (
    publications.some(
      (publication) =>
        publication.tenantId !== first.tenantId ||
        publication.accountId !== first.accountId ||
        publication.scope !== first.scope ||
        publication.routeProjection.accountRouteGeneration !==
          first.routeProjection.accountRouteGeneration
    )
  ) {
    throw new Error('directory_removal_batch_identity_mismatch');
  }
  const statements = publications.map((publication) =>
    accountDirectoryRemovalOutboxStatement(publication, now)
  );
  if (first.scope !== 'account') {
    const results = await adapter.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((result) => !result.success || result.rowsAffected !== 1)
    ) {
      throw new Error('directory_identifier_removal_prepare_failed');
    }
    return;
  }
  statements.push({
    sql: `UPDATE identity_accounts AS account
             SET lifecycle_state = 'deleting', directory_publication_state = 'disabled',
                 updated_at = ?, deleted_at = COALESCE(deleted_at, ?)
           WHERE account.tenant_id = ? AND account.id = ? AND account.account_route_generation = ?
             AND account.lifecycle_state IN ('active', 'deprovisioned', 'deleting')
             AND account.directory_publication_state IN ('active', 'disabled')
             AND ${ACCOUNT_NOT_HELD_SQL}`,
    params: [
      now * 1000,
      now * 1000,
      first.tenantId,
      first.accountId,
      first.routeProjection.accountRouteGeneration,
    ],
  });
  const guard = accountRemovalHoldGuardStatement(first.tenantId, first.accountId, now);
  await prepareAccountRemoval(adapter, guard, statements);
}

type TransactionRunner = <T>(fn: (tx: TransactionContext) => Promise<T>) => Promise<T>;

/** The adapter's retry on a confirmed serialization conflict (Aurora DSQL), or its transaction. */
function retryableTransaction(adapter: DatabaseAdapter): TransactionRunner {
  const retrying = (adapter as { retryableTransaction?: TransactionRunner }).retryableTransaction;
  if (typeof retrying === 'function') {
    return <T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> =>
      retrying.call(adapter, fn) as Promise<T>;
  }
  return <T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> => adapter.transaction(fn);
}

/**
 * Writes an account removal only when no legal hold stands on the account, all of it or none of
 * it (DIRECTORY_REMOVAL_ACCOUNT_HELD when held). D1 runs a batch as one transaction with no other
 * writer between its statements, so each statement carries the same hold condition and they all
 * match, or none does (a statement matching no row would not roll the batch back). Elsewhere a
 * transaction takes the hold authority row first and rolls back on any miss.
 */
async function prepareAccountRemoval(
  adapter: DatabaseAdapter,
  guard: PreparedStatement,
  statements: PreparedStatement[]
): Promise<void> {
  if (adapter.getType() === 'd1') {
    const results = await adapter.batch([guard, ...statements]);
    if (results.length !== statements.length + 1 || results.some((result) => !result.success)) {
      throw new Error('directory_removal_account_prepare_failed');
    }
    if (results[0].rowsAffected < 1) {
      if (results.slice(1).some((result) => result.rowsAffected !== 0)) {
        throw new Error('directory_removal_account_prepare_failed');
      }
      throw new Error(DIRECTORY_REMOVAL_ACCOUNT_HELD);
    }
    // Point writes; D1 also counts what triggers write, so more than one means matched.
    if (results.slice(1).some((result) => result.rowsAffected < 1)) {
      throw new Error('directory_removal_account_prepare_failed');
    }
    return;
  }
  // Held is returned, not thrown: a transaction may replace what its callback throws (Aurora
  // DSQL does), and the guard matched nothing, so there is nothing to roll back. On Aurora DSQL a
  // hold placed at the same time is a write conflict on the hold authority row: the work (SQL
  // only) runs again on a confirmed conflict, then sees the hold.
  const prepared = await retryableTransaction(adapter)(async (tx) => {
    const guarded = await tx.execute(guard.sql, guard.params);
    if (!guarded.success) throw new Error('directory_removal_account_prepare_failed');
    if (guarded.rowsAffected !== 1) return false;
    for (const statement of statements) {
      const result = await tx.execute(statement.sql, statement.params);
      if (!result.success || result.rowsAffected !== 1) {
        throw new Error('directory_removal_account_prepare_failed');
      }
    }
    return true;
  });
  if (!prepared) throw new Error(DIRECTORY_REMOVAL_ACCOUNT_HELD);
}

export async function markAccountDirectoryRemovalReady(
  adapter: DatabaseAdapter,
  operationId: string,
  now: number
): Promise<void> {
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('invalid_directory_removal_time');
  const outboxId = accountDirectoryRemovalOutboxId(operationId);
  const result = await adapter.execute(
    `UPDATE account_routing_outbox
        SET status = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE outbox_id = ? AND status = 'prepared'`,
    [now, now, outboxId]
  );
  if (result.rowsAffected === 1) return;
  const reflected = await adapter.queryOne<{ status: string }>(
    `SELECT status FROM account_routing_outbox WHERE outbox_id = ?`,
    [outboxId]
  );
  if (!reflected || !['pending', 'leased', 'retry', 'succeeded'].includes(reflected.status)) {
    throw new Error('directory_removal_outbox_ready_failed');
  }
}

export async function validateAccountDirectoryPublication(
  value: AccountDirectoryPublication
): Promise<AccountDirectoryPublication> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 6 ||
    Object.keys(value).some(
      (key) =>
        ![
          'operationId',
          'tenantId',
          'accountId',
          'routeProjection',
          'idempotencyKey',
          'indexes',
        ].includes(key)
    )
  ) {
    throw new Error('invalid_directory_publication_shape');
  }
  validateAccountDirectoryPublishRequest({
    operationId: value.operationId,
    tenantId: value.tenantId,
    accountId: value.accountId,
    routeProjection: value.routeProjection,
    idempotencyKey: value.idempotencyKey,
  });
  if (!Array.isArray(value.indexes) || value.indexes.length < 1 || value.indexes.length > 6) {
    throw new Error('invalid_directory_publication_indexes');
  }
  const counts = new Map<LookupIdentifierKind, number>();
  const identities = new Set<string>();
  for (const index of value.indexes) {
    if (
      !index ||
      typeof index !== 'object' ||
      Array.isArray(index) ||
      Object.keys(index).length !== 5 ||
      Object.keys(index).some(
        (key) =>
          ![
            'indexKind',
            'normalizationVersion',
            'hmacKeyGeneration',
            'digest',
            'virtualBucket',
          ].includes(key)
      ) ||
      !KINDS.has(index.indexKind) ||
      !Number.isSafeInteger(index.normalizationVersion) ||
      index.normalizationVersion < 1 ||
      !Number.isSafeInteger(index.hmacKeyGeneration) ||
      index.hmacKeyGeneration < 1 ||
      !HEX_DIGEST.test(index.digest) ||
      !Number.isSafeInteger(index.virtualBucket) ||
      index.virtualBucket < 0 ||
      index.virtualBucket > LOOKUP_MAX_VIRTUAL_BUCKET ||
      (await lookupVirtualBucket(index.indexKind, index.digest)) !== index.virtualBucket
    ) {
      throw new Error('invalid_directory_publication_index');
    }
    const identity = `${index.indexKind}:${index.normalizationVersion}:${index.hmacKeyGeneration}`;
    if (identities.has(identity)) throw new Error('duplicate_directory_publication_index');
    identities.add(identity);
    counts.set(index.indexKind, (counts.get(index.indexKind) ?? 0) + 1);
  }
  if (
    (counts.get('account_id') ?? 0) < 1 ||
    Array.from(counts.values()).some((count) => count > 2)
  ) {
    throw new Error('invalid_directory_publication_index_set');
  }
  assertControlPlaneRecordIsSecretFree(value);
  return value;
}

export async function validateAccountDirectoryRemovalPublication(
  value: AccountDirectoryRemovalPublication
): Promise<AccountDirectoryRemovalPublication> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 7 ||
    Object.keys(value).some(
      (key) =>
        ![
          'operationId',
          'tenantId',
          'accountId',
          'routeProjection',
          'idempotencyKey',
          'scope',
          'indexes',
        ].includes(key)
    ) ||
    !['account', 'identifier'].includes(value.scope)
  ) {
    throw new Error('invalid_directory_removal_shape');
  }
  validateAccountDirectoryPublishRequest({
    operationId: value.operationId,
    tenantId: value.tenantId,
    accountId: value.accountId,
    routeProjection: value.routeProjection,
    idempotencyKey: value.idempotencyKey,
  });
  if (!Array.isArray(value.indexes) || value.indexes.length < 1 || value.indexes.length > 64) {
    throw new Error('invalid_directory_removal_indexes');
  }
  const identities = new Set<string>();
  for (const index of value.indexes) {
    if (
      !index ||
      typeof index !== 'object' ||
      Array.isArray(index) ||
      Object.keys(index).length !== 5 ||
      Object.keys(index).some(
        (key) =>
          ![
            'indexKind',
            'normalizationVersion',
            'hmacKeyGeneration',
            'digest',
            'virtualBucket',
          ].includes(key)
      ) ||
      !KINDS.has(index.indexKind) ||
      !Number.isSafeInteger(index.normalizationVersion) ||
      index.normalizationVersion < 1 ||
      !Number.isSafeInteger(index.hmacKeyGeneration) ||
      index.hmacKeyGeneration < 1 ||
      !HEX_DIGEST.test(index.digest) ||
      !Number.isSafeInteger(index.virtualBucket) ||
      index.virtualBucket < 0 ||
      index.virtualBucket > LOOKUP_MAX_VIRTUAL_BUCKET ||
      (await lookupVirtualBucket(index.indexKind, index.digest)) !== index.virtualBucket
    ) {
      throw new Error('invalid_directory_removal_index');
    }
    const identity = `${index.indexKind}:${index.normalizationVersion}:${index.hmacKeyGeneration}:${index.digest}`;
    if (identities.has(identity)) throw new Error('duplicate_directory_removal_index');
    identities.add(identity);
  }
  if (
    value.scope === 'identifier' &&
    value.indexes.some((index) => index.indexKind === 'account_id')
  ) {
    throw new Error('invalid_identifier_removal_index_set');
  }
  if (
    value.scope === 'account' &&
    !value.indexes.some((index) => index.indexKind === 'account_id')
  ) {
    throw new Error('invalid_account_removal_index_set');
  }
  assertControlPlaneRecordIsSecretFree(value);
  return value;
}
