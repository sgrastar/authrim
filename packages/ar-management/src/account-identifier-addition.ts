import {
  accountDirectoryOutboxId,
  accountDirectoryRemovalOutboxId,
  createLookupBlindIndexes,
  insertPreparedAccountDirectoryRemovals,
  markAccountDirectoryRemovalReady,
  markAccountDirectoryPublicationReady,
  validateAccountDirectoryPublication,
  validateAccountDirectoryRemovalPublication,
  type AccountDirectoryPublication,
  type AccountDirectoryPublishResult,
  type AccountDirectoryRemovalPublication,
  type AccountDirectoryServiceBinding,
  type AccountRouteProjection,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { InitialAccountIdentifierReservationService } from './account-directory-reservation';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';

export interface AccountExternalSubjectAdditionInput {
  operationId: string;
  idempotencyKey: string;
  tenantId: string;
  accountId: string;
  externalSubject: { issuer: string; subject: string };
  routeProjection: AccountRouteProjection;
}

export interface AccountEmailAdditionInput {
  operationId: string;
  idempotencyKey: string;
  tenantId: string;
  accountId: string;
  email: string;
  routeProjection: AccountRouteProjection;
}

export type AccountExternalSubjectRemovalInput = AccountExternalSubjectAdditionInput;

interface IdentifierAdditionDependencies {
  tenantCoreUsers: DatabaseAdapter;
  directory: AccountDirectoryServiceBinding;
  now?: () => number;
}

interface OutboxReflection {
  payload_json: string;
  status: string;
}

export async function prepareAccountExternalSubjectRemoval(
  env: Env,
  input: AccountExternalSubjectRemovalInput,
  tenantCoreUsers: DatabaseAdapter,
  now = Math.floor(Date.now() / 1000)
): Promise<AccountDirectoryRemovalPublication> {
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new Error('account_identifier_removal_time_invalid');
  }
  const keys = (await loadLookupHmacRuntimeKeys(env)).readKeys;
  const publication = await validateAccountDirectoryRemovalPublication({
    operationId: input.operationId,
    tenantId: input.tenantId,
    accountId: input.accountId,
    idempotencyKey: input.idempotencyKey,
    routeProjection: input.routeProjection,
    scope: 'identifier',
    indexes: await createLookupBlindIndexes('external_subject', input.externalSubject, keys),
  });
  const outboxId = accountDirectoryRemovalOutboxId(publication.operationId);
  const payload = JSON.stringify(publication);
  const existing = await tenantCoreUsers.queryOne<OutboxReflection>(
    `SELECT payload_json, status FROM account_routing_outbox
      WHERE outbox_id = ? AND tenant_id = ? AND account_id = ?
        AND event_kind = 'identifier_removed'`,
    [outboxId, publication.tenantId, publication.accountId]
  );
  if (existing) {
    if (
      existing.payload_json !== payload ||
      !['prepared', 'pending', 'leased', 'retry', 'succeeded'].includes(existing.status)
    ) {
      throw new Error('account_identifier_removal_outbox_conflict');
    }
    return publication;
  }
  try {
    await insertPreparedAccountDirectoryRemovals(tenantCoreUsers, [publication], now);
  } catch (error) {
    const reflected = await tenantCoreUsers.queryOne<OutboxReflection>(
      `SELECT payload_json, status FROM account_routing_outbox
        WHERE outbox_id = ? AND tenant_id = ? AND account_id = ?
          AND event_kind = 'identifier_removed'`,
      [outboxId, publication.tenantId, publication.accountId]
    );
    if (
      !reflected ||
      reflected.payload_json !== payload ||
      !['prepared', 'pending', 'leased', 'retry', 'succeeded'].includes(reflected.status)
    ) {
      throw error;
    }
  }
  return publication;
}

export async function publishAccountExternalSubjectRemoval(
  env: Env,
  input: AccountExternalSubjectRemovalInput,
  dependencies: IdentifierAdditionDependencies
): Promise<AccountDirectoryPublishResult> {
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1000);
  const publication = await prepareAccountExternalSubjectRemoval(
    env,
    input,
    dependencies.tenantCoreUsers,
    now
  );
  await markAccountDirectoryRemovalReady(
    dependencies.tenantCoreUsers,
    publication.operationId,
    now
  );
  try {
    const result = await dependencies.directory.removeAccountDirectory?.(publication);
    if (
      result?.status === 201 &&
      result.operationId === publication.operationId &&
      result.accountId === publication.accountId
    ) {
      return result;
    }
  } catch {
    // The pending outbox is the durable retry boundary.
  }
  return {
    status: 202,
    operationId: publication.operationId,
    accountId: publication.accountId,
  };
}

export async function buildAccountExternalSubjectAddition(
  env: Env,
  input: AccountExternalSubjectAdditionInput
): Promise<AccountDirectoryPublication> {
  return buildAccountIdentifierAddition(env, {
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    tenantId: input.tenantId,
    accountId: input.accountId,
    identifierKind: 'external_subject',
    identifier: input.externalSubject,
    routeProjection: input.routeProjection,
  });
}

async function buildAccountIdentifierAddition(
  env: Env,
  input: {
    operationId: string;
    idempotencyKey: string;
    tenantId: string;
    accountId: string;
    identifierKind: 'email_exact' | 'external_subject';
    identifier: string | { issuer: string; subject: string };
    routeProjection: AccountRouteProjection;
  }
): Promise<AccountDirectoryPublication> {
  const keys = (await loadLookupHmacRuntimeKeys(env)).writeKeys;
  return validateAccountDirectoryPublication({
    operationId: input.operationId,
    tenantId: input.tenantId,
    accountId: input.accountId,
    idempotencyKey: input.idempotencyKey,
    routeProjection: input.routeProjection,
    indexes: [
      ...(await createLookupBlindIndexes('account_id', input.accountId, keys)),
      ...(await createLookupBlindIndexes(input.identifierKind, input.identifier, keys)),
    ],
  });
}

export async function buildAccountEmailAddition(
  env: Env,
  input: AccountEmailAdditionInput
): Promise<AccountDirectoryPublication> {
  return buildAccountIdentifierAddition(env, {
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    tenantId: input.tenantId,
    accountId: input.accountId,
    identifierKind: 'email_exact',
    identifier: input.email,
    routeProjection: input.routeProjection,
  });
}

async function publishAccountIdentifierAddition(
  env: Env,
  publication: AccountDirectoryPublication,
  dependencies: IdentifierAdditionDependencies
): Promise<AccountDirectoryPublishResult> {
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new Error('account_identifier_addition_time_invalid');
  }
  const lookupForBucket = await createLookupBucketWriteResolver(env);
  await new InitialAccountIdentifierReservationService({
    lookupForBucket,
    now: () => now,
  }).reserve(publication);

  const outboxId = accountDirectoryOutboxId(publication.operationId);
  const payload = JSON.stringify(publication);
  await dependencies.tenantCoreUsers.execute(
    `INSERT OR IGNORE INTO account_routing_outbox (
       outbox_id, tenant_id, account_id, event_kind, route_generation,
       route_schema_version, hmac_key_generation, payload_json, status,
       attempt_count, created_at, updated_at
     )
     SELECT ?, account.tenant_id, account.id, 'identifier_added', ?, ?, ?, ?, 'prepared', 0, ?, ?
       FROM identity_accounts account
      WHERE account.tenant_id = ? AND account.id = ?
        AND account.account_route_generation = ?
        AND account.lifecycle_state = 'active'
        AND account.directory_publication_state = 'active'`,
    [
      outboxId,
      publication.routeProjection.accountRouteGeneration,
      publication.routeProjection.schemaVersion,
      Math.max(...publication.indexes.map((index) => index.hmacKeyGeneration)),
      payload,
      now,
      now,
      publication.tenantId,
      publication.accountId,
      publication.routeProjection.accountRouteGeneration,
    ]
  );
  const reflected = await dependencies.tenantCoreUsers.queryOne<OutboxReflection>(
    `SELECT payload_json, status FROM account_routing_outbox
      WHERE outbox_id = ? AND tenant_id = ? AND account_id = ? AND event_kind = 'identifier_added'`,
    [outboxId, publication.tenantId, publication.accountId]
  );
  if (
    !reflected ||
    reflected.payload_json !== payload ||
    !['prepared', 'pending', 'leased', 'retry', 'succeeded'].includes(reflected.status)
  ) {
    throw new Error('account_identifier_addition_outbox_conflict');
  }
  await markAccountDirectoryPublicationReady(
    dependencies.tenantCoreUsers,
    publication.operationId,
    now
  );
  try {
    const result = await dependencies.directory.publishAccountDirectory(publication);
    if (
      result.status === 201 &&
      result.operationId === publication.operationId &&
      result.accountId === publication.accountId
    ) {
      return result;
    }
  } catch {
    // The pending outbox is the durable retry boundary.
  }
  return {
    status: 202,
    operationId: publication.operationId,
    accountId: publication.accountId,
  };
}

export async function publishAccountExternalSubjectAddition(
  env: Env,
  input: AccountExternalSubjectAdditionInput,
  dependencies: IdentifierAdditionDependencies
): Promise<AccountDirectoryPublishResult> {
  const publication = await buildAccountExternalSubjectAddition(env, input);
  return publishAccountIdentifierAddition(env, publication, dependencies);
}

export async function publishAccountEmailAddition(
  env: Env,
  input: AccountEmailAdditionInput,
  dependencies: IdentifierAdditionDependencies
): Promise<AccountDirectoryPublishResult> {
  const publication = await buildAccountEmailAddition(env, input);
  return publishAccountIdentifierAddition(env, publication, dependencies);
}
