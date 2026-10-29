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
  runTenantBackupCoveredEffect,
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
  preparedPublication?: AccountDirectoryPublication;
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
  return runTenantBackupCoveredEffect(env, { tenantId: input.tenantId }, async () => {
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
  });
}

export async function buildAccountExternalSubjectAddition(
  env: Env,
  input: AccountExternalSubjectAdditionInput,
  tenantCoreUsers?: DatabaseAdapter
): Promise<AccountDirectoryPublication> {
  return buildAccountIdentifierAddition(
    env,
    {
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      tenantId: input.tenantId,
      accountId: input.accountId,
      identifierKind: 'external_subject',
      identifier: input.externalSubject,
      routeProjection: input.routeProjection,
    },
    tenantCoreUsers
  );
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
  },
  tenantCoreUsers?: DatabaseAdapter
): Promise<AccountDirectoryPublication> {
  const existing = tenantCoreUsers
    ? await tenantCoreUsers.queryOne<OutboxReflection>(
        `SELECT payload_json, status FROM account_routing_outbox
      WHERE outbox_id = ? AND tenant_id = ? AND account_id = ? AND event_kind = 'identifier_added'`,
        [accountDirectoryOutboxId(input.operationId), input.tenantId, input.accountId],
        { consistencyClass: 'primary_required' }
      )
    : null;
  const runtimeKeys = await loadLookupHmacRuntimeKeys(env);
  let keys = runtimeKeys.writeKeys;
  if (existing) {
    if (!['prepared', 'pending', 'leased', 'retry', 'succeeded'].includes(existing.status)) {
      throw new Error('account_identifier_addition_outbox_conflict');
    }
    let persisted: AccountDirectoryPublication;
    try {
      persisted = await validateAccountDirectoryPublication(
        JSON.parse(existing.payload_json) as AccountDirectoryPublication
      );
    } catch {
      throw new Error('account_identifier_addition_outbox_conflict');
    }
    // The outbox pins this add's generations. A key switch must not turn a retry into a new
    // reservation (which a reindex may already own). Recompute the complete payload from the
    // caller's input using those keys; never accept a different identifier from a stored claim.
    keys = [];
    for (const generation of new Set(persisted.indexes.map((index) => index.hmacKeyGeneration))) {
      const key = runtimeKeys.readKeys.find((candidate) => candidate.generation === generation);
      if (!key) throw new Error('account_identifier_addition_outbox_conflict');
      keys.push(key);
    }
  }
  const publication = await validateAccountDirectoryPublication({
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
  if (existing && existing.payload_json !== JSON.stringify(publication)) {
    throw new Error('account_identifier_addition_outbox_conflict');
  }
  return publication;
}

export async function buildAccountEmailAddition(
  env: Env,
  input: AccountEmailAdditionInput,
  tenantCoreUsers?: DatabaseAdapter
): Promise<AccountDirectoryPublication> {
  return buildAccountIdentifierAddition(
    env,
    {
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      tenantId: input.tenantId,
      accountId: input.accountId,
      identifierKind: 'email_exact',
      identifier: input.email,
      routeProjection: input.routeProjection,
    },
    tenantCoreUsers
  );
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
  const outboxId = accountDirectoryOutboxId(publication.operationId);
  const payload = JSON.stringify(publication);
  // An addition whose outbox row already succeeded is finished: its reservation was committed and
  // its route published. A replay of it must not touch the reservation again. reserve() refuses to
  // re-acquire a row only from the operation that released it last, so a replay arriving after the
  // identifier went to another operation and was released again would take the row back and
  // revive a route nothing owns. The finished add is answered from the outbox, which stays as the
  // record of it however the identifier was removed since.
  const finished = await dependencies.tenantCoreUsers.queryOne<OutboxReflection>(
    `SELECT payload_json, status FROM account_routing_outbox
      WHERE outbox_id = ? AND tenant_id = ? AND account_id = ? AND event_kind = 'identifier_added'`,
    [outboxId, publication.tenantId, publication.accountId],
    { consistencyClass: 'primary_required' }
  );
  if (
    finished &&
    (finished.payload_json !== payload ||
      !['prepared', 'pending', 'leased', 'retry', 'succeeded'].includes(finished.status))
  ) {
    throw new Error('account_identifier_addition_outbox_conflict');
  }
  if (finished?.status === 'succeeded') {
    return {
      status: 201,
      operationId: publication.operationId,
      accountId: publication.accountId,
    };
  }

  const lookupForBucket = await createLookupBucketWriteResolver(env);
  await new InitialAccountIdentifierReservationService({
    lookupForBucket,
    now: () => now,
  }).reserve(publication);

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
  return runTenantBackupCoveredEffect(env, { tenantId: input.tenantId }, async () => {
    const publication = dependencies.preparedPublication
      ? await validatePreparedAddition(dependencies.preparedPublication, input)
      : await buildAccountExternalSubjectAddition(env, input, dependencies.tenantCoreUsers);
    return publishAccountIdentifierAddition(env, publication, dependencies);
  });
}

export async function publishAccountEmailAddition(
  env: Env,
  input: AccountEmailAdditionInput,
  dependencies: IdentifierAdditionDependencies
): Promise<AccountDirectoryPublishResult> {
  return runTenantBackupCoveredEffect(env, { tenantId: input.tenantId }, async () => {
    const publication = dependencies.preparedPublication
      ? await validatePreparedAddition(dependencies.preparedPublication, input)
      : await buildAccountEmailAddition(env, input, dependencies.tenantCoreUsers);
    return publishAccountIdentifierAddition(env, publication, dependencies);
  });
}

async function validatePreparedAddition(
  value: AccountDirectoryPublication,
  input: AccountEmailAdditionInput | AccountExternalSubjectAdditionInput
): Promise<AccountDirectoryPublication> {
  const publication = await validateAccountDirectoryPublication(value);
  if (
    publication.operationId !== input.operationId ||
    publication.tenantId !== input.tenantId ||
    publication.accountId !== input.accountId ||
    publication.idempotencyKey !== input.idempotencyKey
  )
    throw new Error('account_identifier_prepared_publication_mismatch');
  return publication;
}
