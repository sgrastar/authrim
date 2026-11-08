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

/**
 * The account states an identifier's directory removal runs for: an active account, and a
 * suspended or locked one (unlinking an identifier changes neither state). An account being
 * deleted has its whole route removed by the deletion instead.
 */
export const IDENTIFIER_REMOVAL_ACCOUNT_LIFECYCLE_STATES: readonly string[] = [
  'active',
  'suspended',
  'locked',
];

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
      : // An identifier of a suspended or locked account can be removed too (an identity
        // provider's data deletion unlinks it); the account's state is left as it is.
        `account.lifecycle_state IN (${IDENTIFIER_REMOVAL_ACCOUNT_LIFECYCLE_STATES.map((state) => `'${state}'`).join(', ')})
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

/**
 * The removal of an account whose route was never published (an unfinished sign-up's: its
 * creation stopped before the directory published it), prepared as a deletion's: the removals,
 * the move to `deleting` with the publication `disabled`, and its creation's publication blocked
 * (`registration_abandoned`), all in one write or none. Each part carries the same account
 * condition, so on D1 they all match or none does: not held, still unpublished
 * (`pending` / `active_pending_directory`), and its creation's publication neither succeeded nor
 * leased by a worker whose lease is still running. The removals' route is the creation's.
 */
export async function insertPreparedUnpublishedAccountRemovals(
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
        publication.scope !== 'account' ||
        publication.tenantId !== first.tenantId ||
        publication.accountId !== first.accountId ||
        publication.routeProjection.accountRouteGeneration !==
          first.routeProjection.accountRouteGeneration
    )
  ) {
    throw new Error('directory_removal_batch_identity_mismatch');
  }
  const routeGeneration = first.routeProjection.accountRouteGeneration;
  const unpublished = `account.lifecycle_state IN ('active', 'deprovisioned')
      AND account.directory_publication_state IN ('pending', 'active_pending_directory')
      AND ${ACCOUNT_NOT_HELD_SQL}
      AND NOT EXISTS (SELECT 1 FROM account_routing_outbox created
        WHERE created.tenant_id = account.tenant_id AND created.account_id = account.id
          AND created.event_kind = 'account_created'
          AND (created.status = 'succeeded'
            OR (created.status = 'leased'
              AND (created.lease_expires_at IS NULL OR created.lease_expires_at > ${now}))))`;
  const statements: PreparedStatement[] = publications.map((publication) => ({
    sql: `INSERT INTO account_routing_outbox (
            outbox_id, tenant_id, account_id, event_kind, route_generation,
            route_schema_version, hmac_key_generation, payload_json, status,
            attempt_count, created_at, updated_at
          )
          SELECT ?, account.tenant_id, account.id, 'account_deleted', ?, ?, ?, ?, 'prepared', 0, ?, ?
            FROM identity_accounts account
           WHERE account.tenant_id = ? AND account.id = ?
             AND account.account_route_generation = ? AND ${unpublished}`,
    params: [
      accountDirectoryRemovalOutboxId(publication.operationId),
      routeGeneration,
      publication.routeProjection.schemaVersion,
      Math.max(...publication.indexes.map((index) => index.hmacKeyGeneration)),
      JSON.stringify(publication),
      now,
      now,
      publication.tenantId,
      publication.accountId,
      routeGeneration,
    ],
  }));
  // Before the account's move (whose condition it reads, as unpublished, as the inserts did).
  const blockCreation: PreparedStatement = {
    sql: `UPDATE account_routing_outbox
             SET status = 'blocked', last_error_code = 'registration_abandoned',
                 lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
                 updated_at = ?
           WHERE tenant_id = ? AND account_id = ? AND event_kind = 'account_created'
             AND (status IN ('prepared', 'pending', 'retry')
               OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
             AND EXISTS (SELECT 1 FROM identity_accounts account
               WHERE account.tenant_id = account_routing_outbox.tenant_id
                 AND account.id = account_routing_outbox.account_id
                 AND account.account_route_generation = ? AND ${unpublished})`,
    params: [now, first.tenantId, first.accountId, now, routeGeneration],
  };
  const moveAccount: PreparedStatement = {
    sql: `UPDATE identity_accounts AS account
             SET lifecycle_state = 'deleting', directory_publication_state = 'disabled',
                 updated_at = ?, deleted_at = COALESCE(deleted_at, ?)
           WHERE account.tenant_id = ? AND account.id = ? AND account.account_route_generation = ?
             AND ${unpublished}`,
    params: [now * 1000, now * 1000, first.tenantId, first.accountId, routeGeneration],
  };
  const guard = accountRemovalHoldGuardStatement(first.tenantId, first.accountId, now);
  // The creation's publication may have no row left to block (already blocked or dead): the only
  // part allowed to match nothing.
  await prepareAccountRemoval(adapter, guard, [...statements, blockCreation, moveAccount], {
    optional: new Set([statements.length]),
  });
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
  statements: PreparedStatement[],
  options: { optional?: ReadonlySet<number> } = {}
): Promise<void> {
  const required = (index: number) => !options.optional?.has(index);
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
    if (results.slice(1).some((result, index) => required(index) && result.rowsAffected < 1)) {
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
    for (const [index, statement] of statements.entries()) {
      const result = await tx.execute(statement.sql, statement.params);
      if (
        !result.success ||
        (required(index) ? result.rowsAffected !== 1 : result.rowsAffected > 1)
      ) {
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
