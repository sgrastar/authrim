import {
  assertControlPlaneRecordIsSecretFree,
  validateAccountDirectoryPublishRequest,
  type AccountDirectoryPublishResult,
  type AccountDirectoryPublishRequest,
} from '../control-plane/control-plane-contracts';
import type { DatabaseAdapter, PreparedStatement } from '../../db/adapter';
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
           AND account.directory_publication_state IN ('active', 'disabled')`
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
  if (first.scope === 'account') {
    statements.push({
      sql: `UPDATE identity_accounts
               SET lifecycle_state = 'deleting', directory_publication_state = 'disabled',
                   updated_at = ?, deleted_at = COALESCE(deleted_at, ?)
             WHERE tenant_id = ? AND id = ? AND account_route_generation = ?
               AND lifecycle_state IN ('active', 'deprovisioned', 'deleting')
               AND directory_publication_state IN ('active', 'disabled')`,
      params: [
        now * 1000,
        now * 1000,
        first.tenantId,
        first.accountId,
        first.routeProjection.accountRouteGeneration,
      ],
    });
  }
  const results = await adapter.batch(statements);
  if (
    results.length !== statements.length ||
    results.some((result) => !result.success || result.rowsAffected !== 1)
  ) {
    throw new Error(
      first.scope === 'account'
        ? 'directory_removal_account_prepare_failed'
        : 'directory_identifier_removal_prepare_failed'
    );
  }
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
