import { samlDrAll } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';
import {
  createAuditLog,
  createLookupBlindIndexes,
  createLogger,
  ensureDatabaseAdapter,
  markAccountDirectoryPublicationReady,
  validateAccountDirectoryPublication,
  validateControlAccountRouteAllocationResult,
  type AccountDirectoryPublication,
  type AccountDirectoryPublishResult,
  type AccountDirectoryServiceBinding,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import type { D1Database } from '@cloudflare/workers-types';
import {
  AccountCreationOperationRepository,
  type AccountCreationOperation,
} from './account-creation-operation';
import {
  ACCOUNT_CREATION_GENERATION_WARNING,
  ACCOUNT_CREATION_GENERATIONS_EXHAUSTED,
  ACCOUNT_CREATION_PREVIOUS_ACCOUNT_DELETING,
  MAX_ACCOUNT_CREATION_GENERATIONS,
  accountCreationGenerationOf,
  previousAccountStateReader,
  resolveAccountCreationGenerationKey,
  type PreviousAccountStateReader,
} from './account-creation-generation';
import { InitialAccountIdentifierReservationService } from './account-directory-reservation';
import { ACCOUNT_DIRECTORY_WRITE_BINDING_UNAVAILABLE } from './account-directory-errors';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';

const log = createLogger().module('ACCOUNT-DIRECTORY-PRODUCER');
const SAFE_PREPARATION_ERROR =
  /^(?:account_directory|control_account_allocation|lookup_hmac_key)_[a-z0-9_:-]{1,96}$/u;

export function classifyAccountCreationPreparationError(error: unknown): string {
  return error instanceof Error && SAFE_PREPARATION_ERROR.test(error.message)
    ? error.message
    : 'account_creation_preparation_failed';
}

export interface InitialAccountDirectoryPublicationInput {
  tenantId: string;
  accountId: string;
  email?: string | null;
  externalSubject?: { issuer: string; subject: string } | null;
  residencyPolicyId: string;
  residencyPartition: string;
  idempotencyKey: string;
  operationId: string;
}

export interface InitialAccountDirectoryWriteTargets {
  tenantCoreUsers: D1Database;
  tenantPii: D1Database;
  residencyPartition: string;
}

export interface InitialAccountDirectoryWriteContext {
  publication: AccountDirectoryPublication;
  tenantCoreUsers: DatabaseAdapter;
  tenantPii: DatabaseAdapter;
  residencyPartition: string;
}

export interface InitialAccountDirectoryWriteDependencies {
  writeAuthoritative(context: InitialAccountDirectoryWriteContext): Promise<void>;
  reserveIdentifiers?: (publication: AccountDirectoryPublication) => Promise<void>;
  releaseIdentifiers?: (publication: AccountDirectoryPublication) => Promise<void>;
  lookupForBucket?: (virtualBucket: number) => Promise<D1Database>;
  now?: () => number;
}

export interface InitialAccountDirectoryWriteResult {
  publication: AccountDirectoryPublication;
  delivery: AccountDirectoryPublishResult;
}

export interface DurableInitialAccountDirectoryWriteInput {
  tenantId: string;
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
  candidateOperationId: string;
  candidateUserId: string;
  email?: string | null;
  externalSubject?: { issuer: string; subject: string } | null;
  residencyPolicyId: string;
  residencyPartition: string;
  /**
   * The key is derived from the request (an auth sign-up's, a SCIM create's without an
   * Idempotency-Key), so the same request after its account was deleted must not get the deleted
   * account back (account-creation-generation.ts). `renew`: it goes to the key's next generation.
   * `refuse`: it is refused while the account is deleted or being deleted (a guest's, whose key
   * cannot move to a new account). Absent: a key the caller chose, replayed as it was.
   */
  onDeletedAccount?: 'renew' | 'refuse';
}

export interface DurableInitialAccountDirectoryWriteDependencies extends InitialAccountDirectoryWriteDependencies {
  operationRepository: AccountCreationOperationRepository;
  /** How a generation's account is read (the tenant's current core shards when absent). */
  readPreviousAccount?: PreviousAccountStateReader;
}

export interface DurableInitialAccountDirectoryWriteResult extends InitialAccountDirectoryWriteResult {
  operation: AccountCreationOperation;
}

type ControlAccountAllocationRpcStage =
  | 'try_allocate'
  | 'allocate'
  | 'ensure_capacity'
  | 'commit'
  | 'release';

async function callControlAccountAllocationRpc<T>(
  stage: ControlAccountAllocationRpcStage,
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    // The legacy allocation RPC reports exhausted capacity by throwing this stable domain error.
    // Preserve it so the caller can start idempotent capacity provisioning. Any other rejection at
    // this private RPC boundary means that no validated Control response was received and is safe
    // to retry through the durable account-creation operation.
    if (
      error instanceof Error &&
      error.message === 'control_account_allocation_capacity_unavailable'
    ) {
      throw error;
    }
    log.warn(
      'Control account allocation RPC rejected',
      { stage },
      error instanceof Error ? error : new Error('unknown_control_rpc_rejection')
    );
    throw new Error('control_account_allocation_rpc_unavailable', { cause: error });
  }
}

async function allocateAccountRouteWithElasticCapacity(
  env: Env,
  input: InitialAccountDirectoryPublicationInput,
  accountIdBlindDigest: string,
  dataRoles: readonly ['tenant_core/users', 'tenant_pii']
) {
  const control = env.CONTROL;
  if (!control) throw new Error('account_directory_control_unavailable');
  const request = {
    tenantId: input.tenantId,
    accountIdBlindDigest,
    residencyPolicyId: input.residencyPolicyId,
    residencyPartition: input.residencyPartition,
    idempotencyKey: input.idempotencyKey,
    dataRoles: [...dataRoles],
  };
  const allocateOnce = async () => {
    if (typeof control.tryAllocateAccountRoute === 'function') {
      const attempt = await callControlAccountAllocationRpc('try_allocate', () =>
        control.tryAllocateAccountRoute!(request)
      );
      if (attempt.state === 'capacity_unavailable') {
        throw new Error('control_account_allocation_capacity_unavailable');
      }
      if (attempt.state !== 'allocated' || !attempt.allocation) {
        throw new Error('account_directory_capacity_response_invalid');
      }
      return attempt.allocation;
    }
    return callControlAccountAllocationRpc('allocate', () => control.allocateAccountRoute(request));
  };
  try {
    return await allocateOnce();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== 'control_account_allocation_capacity_unavailable' ||
      typeof control.ensureTenantShardCapacity !== 'function'
    ) {
      throw error;
    }
    const capacity = await samlDrAll(
      dataRoles.map((dataRole) =>
        callControlAccountAllocationRpc('ensure_capacity', () =>
          control.ensureTenantShardCapacity!({
            tenantId: input.tenantId,
            dataRole,
            residencyPolicyId: input.residencyPolicyId,
            residencyPartition: input.residencyPartition,
            idempotencyKey: `account-capacity:${accountIdBlindDigest.slice(0, 32)}:${dataRole.replaceAll('/', '-')}`,
          })
        )
      )
    );
    for (const [index, result] of capacity.entries()) {
      if (
        !result ||
        (result.state !== 'ready' &&
          result.state !== 'provisioning' &&
          result.state !== 'blocked') ||
        (result.state === 'ready' && result.target.dataRole !== dataRoles[index])
      ) {
        throw new Error('account_directory_capacity_response_invalid');
      }
    }
    if (capacity.some((result) => result.state !== 'ready')) {
      throw new Error('control_account_allocation_capacity_unavailable');
    }
    return allocateOnce();
  }
}

function d1Binding(env: Env, bindingRef: string): D1Database {
  const value = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!value || typeof value !== 'object') {
    throw new Error(ACCOUNT_DIRECTORY_WRITE_BINDING_UNAVAILABLE);
  }
  const binding = value as Partial<D1Database>;
  if (
    typeof binding.prepare !== 'function' ||
    typeof binding.batch !== 'function' ||
    typeof binding.withSession !== 'function'
  ) {
    throw new Error(ACCOUNT_DIRECTORY_WRITE_BINDING_UNAVAILABLE);
  }
  return value as D1Database;
}

export async function resolveInitialAccountDirectoryWriteTargets(
  env: Env,
  value: AccountDirectoryPublication
): Promise<InitialAccountDirectoryWriteTargets> {
  const publication = await validateAccountDirectoryPublication(value);
  if (publication.routeProjection.targets.length !== 2) {
    throw new Error('account_directory_write_route_invalid');
  }
  const coreTargets = publication.routeProjection.targets.filter(
    (target) => target.dataRole === 'tenant_core/users'
  );
  const piiTargets = publication.routeProjection.targets.filter(
    (target) => target.dataRole === 'tenant_pii'
  );
  if (
    coreTargets.length !== 1 ||
    piiTargets.length !== 1 ||
    coreTargets[0].residencyPartition !== piiTargets[0].residencyPartition ||
    coreTargets[0].bindingRef === piiTargets[0].bindingRef ||
    coreTargets[0].shardId === piiTargets[0].shardId
  ) {
    throw new Error('account_directory_write_route_invalid');
  }
  return {
    tenantCoreUsers: d1Binding(env, coreTargets[0].bindingRef),
    tenantPii: d1Binding(env, piiTargets[0].bindingRef),
    residencyPartition: coreTargets[0].residencyPartition,
  };
}

export async function buildInitialAccountDirectoryPublication(
  env: Env,
  input: InitialAccountDirectoryPublicationInput
): Promise<AccountDirectoryPublication> {
  if (!env.CONTROL) throw new Error('account_directory_control_unavailable');
  const keys = (await loadLookupHmacRuntimeKeys(env)).writeKeys;
  const accountIndexes = await createLookupBlindIndexes('account_id', input.accountId, keys);
  const accountIndex = accountIndexes[0];
  const indexes = [
    ...accountIndexes,
    ...(input.email ? await createLookupBlindIndexes('email_exact', input.email, keys) : []),
    ...(input.externalSubject
      ? await createLookupBlindIndexes('external_subject', input.externalSubject, keys)
      : []),
  ];
  const requestedRoles = ['tenant_core/users', 'tenant_pii'] as const;
  const allocation = validateControlAccountRouteAllocationResult(
    await allocateAccountRouteWithElasticCapacity(env, input, accountIndex.digest, requestedRoles),
    {
      tenantId: input.tenantId,
      residencyPolicyId: input.residencyPolicyId,
      residencyPartition: input.residencyPartition,
      dataRoles: requestedRoles,
    }
  );
  const publication: AccountDirectoryPublication = {
    operationId: input.operationId,
    tenantId: input.tenantId,
    accountId: input.accountId,
    idempotencyKey: input.idempotencyKey,
    routeProjection: {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: input.residencyPolicyId,
      targets: allocation.targets.map((target) => ({
        dataRole: target.dataRole,
        residencyPartition: target.residencyPartition,
        shardId: target.shardId,
        bindingRef: target.bindingRef,
        requiredBindingRouteGeneration: target.routeGeneration,
      })),
    },
    indexes,
  };
  return validateAccountDirectoryPublication(publication);
}

async function lookupResolverFromEnvironment(
  env: Env
): Promise<(virtualBucket: number) => Promise<D1Database>> {
  return createLookupBucketWriteResolver(env);
}

async function reserveInitialIdentifiers(
  env: Env,
  publication: AccountDirectoryPublication,
  dependencies: InitialAccountDirectoryWriteDependencies,
  now: number
): Promise<void> {
  if (dependencies.reserveIdentifiers) {
    await dependencies.reserveIdentifiers(publication);
  } else if (publication.indexes.some((index) => index.indexKind !== 'account_id')) {
    const lookupForBucket =
      dependencies.lookupForBucket ?? (await lookupResolverFromEnvironment(env));
    await new InitialAccountIdentifierReservationService({
      lookupForBucket,
      now: () => now,
    }).reserve(publication);
  }
}

async function releaseInitialIdentifiers(
  env: Env,
  publication: AccountDirectoryPublication,
  dependencies: InitialAccountDirectoryWriteDependencies,
  now: number
): Promise<void> {
  if (dependencies.releaseIdentifiers) {
    await dependencies.releaseIdentifiers(publication);
    return;
  }
  if (dependencies.reserveIdentifiers) return;
  if (!publication.indexes.some((index) => index.indexKind !== 'account_id')) return;
  const lookupForBucket =
    dependencies.lookupForBucket ?? (await lookupResolverFromEnvironment(env));
  await new InitialAccountIdentifierReservationService({
    lookupForBucket,
    now: () => now,
  }).release(publication);
}

function accountRouteAllocationRequest(publication: AccountDirectoryPublication) {
  const accountIndex = publication.indexes.find((index) => index.indexKind === 'account_id');
  if (!accountIndex) throw new Error('account_directory_allocation_commit_invalid');
  return {
    tenantId: publication.tenantId,
    accountIdBlindDigest: accountIndex.digest,
    residencyPolicyId: publication.routeProjection.residencyPolicyId,
    residencyPartition: publication.routeProjection.targets[0]?.residencyPartition ?? '',
    idempotencyKey: publication.idempotencyKey,
    dataRoles: ['tenant_core/users', 'tenant_pii'] as const,
  };
}

async function commitInitialAccountRouteAllocation(
  env: Env,
  publication: AccountDirectoryPublication
): Promise<void> {
  if (!env.CONTROL?.commitAccountRoute) {
    throw new Error('account_directory_allocation_commit_unavailable');
  }
  const dataRoles = ['tenant_core/users', 'tenant_pii'] as const;
  const request = accountRouteAllocationRequest(publication);
  const committed = validateControlAccountRouteAllocationResult(
    await callControlAccountAllocationRpc('commit', () =>
      env.CONTROL!.commitAccountRoute!({ ...request, dataRoles: [...dataRoles] })
    ),
    {
      tenantId: publication.tenantId,
      residencyPolicyId: publication.routeProjection.residencyPolicyId,
      residencyPartition: publication.routeProjection.targets[0]?.residencyPartition ?? '',
      dataRoles,
    }
  );
  const projectedByRole = new Map(
    publication.routeProjection.targets.map((target) => [target.dataRole, target] as const)
  );
  for (const target of committed.targets) {
    const projected = projectedByRole.get(target.dataRole);
    if (
      !projected ||
      projected.residencyPartition !== target.residencyPartition ||
      projected.shardId !== target.shardId ||
      projected.bindingRef !== target.bindingRef ||
      projected.requiredBindingRouteGeneration !== target.routeGeneration
    ) {
      throw new Error('account_directory_allocation_commit_route_mismatch');
    }
  }
}

async function releaseInitialAccountRouteAllocation(
  env: Env,
  publication: AccountDirectoryPublication
): Promise<void> {
  if (!env.CONTROL?.releaseAccountRoute) {
    throw new Error('account_directory_allocation_release_unavailable');
  }
  const request = accountRouteAllocationRequest(publication);
  await callControlAccountAllocationRpc('release', () =>
    env.CONTROL!.releaseAccountRoute!({ ...request, dataRoles: [...request.dataRoles] })
  );
}

/**
 * Releases an abandoned creation's Control allocation, if it is still only reserved: `committed`
 * when the account was written (a committed allocation is never released), `absent` when there
 * is none.
 */
export async function releaseAbandonedAccountRouteAllocation(
  env: Env,
  publication: AccountDirectoryPublication
): Promise<'released' | 'committed' | 'absent'> {
  if (!env.CONTROL?.releaseAccountRoute) {
    throw new Error('account_directory_allocation_release_unavailable');
  }
  const request = accountRouteAllocationRequest(
    await validateAccountDirectoryPublication(publication)
  );
  try {
    await env.CONTROL.releaseAccountRoute({ ...request, dataRoles: [...request.dataRoles] });
    return 'released';
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'control_account_allocation_release_committed') return 'committed';
    if (message === 'control_account_allocation_release_not_found') return 'absent';
    throw new Error('control_account_allocation_rpc_unavailable', { cause: error });
  }
}

async function rollbackInitialReservations(
  env: Env,
  publication: AccountDirectoryPublication,
  dependencies: InitialAccountDirectoryWriteDependencies,
  now: number
): Promise<void> {
  await releaseInitialIdentifiers(env, publication, dependencies, now);
  await releaseInitialAccountRouteAllocation(env, publication);
}

export async function executeInitialAccountDirectoryWrite(
  env: Env,
  input: InitialAccountDirectoryPublicationInput,
  dependencies: InitialAccountDirectoryWriteDependencies
): Promise<InitialAccountDirectoryWriteResult> {
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new Error('account_directory_write_time_invalid');
  }
  const publication = await buildInitialAccountDirectoryPublication(env, input);
  const targets = await resolveInitialAccountDirectoryWriteTargets(env, publication);
  try {
    await reserveInitialIdentifiers(env, publication, dependencies, now);
  } catch (error) {
    if (error instanceof Error && error.message === 'directory_identifier_reservation_conflict') {
      await rollbackInitialReservations(env, publication, dependencies, now);
    }
    throw error;
  }
  const tenantCoreUsers = ensureDatabaseAdapter(
    targets.tenantCoreUsers,
    'account-directory-tenant-core-users'
  );
  await dependencies.writeAuthoritative({
    publication,
    tenantCoreUsers,
    tenantPii: ensureDatabaseAdapter(targets.tenantPii, 'account-directory-tenant-pii'),
    residencyPartition: targets.residencyPartition,
  });
  await commitInitialAccountRouteAllocation(env, publication);
  await markAccountDirectoryPublicationReady(tenantCoreUsers, publication.operationId, now);
  return {
    publication,
    delivery: await attemptImmediateAccountDirectoryPublication(env.ACCOUNT_DIRECTORY, publication),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The creator a log or an audit may name: an auth flow, or SCIM (never its token's digest). */
function creatorKind(actorId: string): string {
  return actorId.startsWith('auth:') ? actorId : actorId.startsWith('scim-') ? 'scim' : 'other';
}

/**
 * The generation of a key derived from its request (account-creation-generation.ts): a warning
 * from ACCOUNT_CREATION_GENERATION_WARNING on, and an audit when the generations are used up.
 * Neither names the address.
 */
async function resolveGeneration(
  env: Env,
  input: DurableInitialAccountDirectoryWriteInput,
  repository: AccountCreationOperationRepository,
  readPreviousAccount: PreviousAccountStateReader
): Promise<string> {
  let key: string;
  try {
    key = await resolveAccountCreationGenerationKey({
      repository,
      tenantId: input.tenantId,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      readPreviousAccount,
    });
  } catch (error) {
    if (error instanceof Error && error.message === ACCOUNT_CREATION_GENERATIONS_EXHAUSTED) {
      log.warn('Account creation refused: the key has used all its generations', {
        tenantId: input.tenantId,
        flow: creatorKind(input.actorId),
        generations: MAX_ACCOUNT_CREATION_GENERATIONS,
      });
      const keyDigest = await sha256Hex(
        `${input.tenantId}\0${input.actorId}\0${input.idempotencyKey}`
      );
      // One per key and UTC day, the same each time it is sent again that day (its id, its time
      // and its content: a stored audit is never rewritten).
      const day = Math.floor(Date.now() / 86_400_000);
      await createAuditLog(env, {
        id: `account-creation-refused:${keyDigest.slice(0, 48)}:${day}`,
        createdAt: day * 86_400_000,
        tenantId: input.tenantId,
        userId: 'system',
        action: 'account.creation_refused',
        resource: 'account_creation',
        resourceId: keyDigest,
        severity: 'warning',
        ipAddress: 'system',
        userAgent: 'Authrim account provisioning',
        metadata: JSON.stringify({
          reason: 'generations_exhausted',
          flow: creatorKind(input.actorId),
          generations: MAX_ACCOUNT_CREATION_GENERATIONS,
        }),
      }).catch((auditError: unknown) =>
        log.error(
          'Account creation refusal not audited',
          {},
          auditError instanceof Error ? auditError : new Error('audit_failed')
        )
      );
    }
    throw error;
  }
  const generation = accountCreationGenerationOf(input.idempotencyKey, key);
  if (generation >= ACCOUNT_CREATION_GENERATION_WARNING) {
    log.warn('Account creation key renewed after many deletions', {
      tenantId: input.tenantId,
      flow: creatorKind(input.actorId),
      generation,
    });
  }
  return key;
}

export async function executeDurableInitialAccountDirectoryWrite(
  env: Env,
  input: DurableInitialAccountDirectoryWriteInput,
  dependencies: DurableInitialAccountDirectoryWriteDependencies
): Promise<DurableInitialAccountDirectoryWriteResult> {
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new Error('account_directory_write_time_invalid');
  }
  const readPreviousAccount = input.onDeletedAccount
    ? (dependencies.readPreviousAccount ?? previousAccountStateReader(env))
    : null;
  const idempotencyKey =
    readPreviousAccount && input.onDeletedAccount === 'renew'
      ? await resolveGeneration(env, input, dependencies.operationRepository, readPreviousAccount)
      : input.idempotencyKey;
  let operation = await dependencies.operationRepository.acquire({
    tenantId: input.tenantId,
    actorId: input.actorId,
    idempotencyKey,
    requestHash: input.requestHash,
    candidateOperationId: input.candidateOperationId,
    candidateUserId: input.candidateUserId,
    now,
  });
  if (operation.status === 'blocked' || operation.status === 'canceled') {
    if (
      operation.status === 'blocked' &&
      operation.lastErrorCode === 'directory_identifier_reservation_conflict' &&
      operation.publication
    ) {
      await rollbackInitialReservations(env, operation.publication, dependencies, now);
      throw new Error('directory_identifier_reservation_conflict');
    }
    throw new Error(`account_creation_operation_${operation.status}`);
  }
  if (operation.status !== 'succeeded') {
    // Resumed (or begun) now: recorded before any effect, so the clean-up of unfinished sign-ups
    // never gives up a creation a request is moving (and a given-up one is refused here).
    operation = await dependencies.operationRepository.touch(operation, now);
  }
  // An account already written (a resume, a replay) is read again here: deleted since the
  // generation was chosen (or, for `refuse`, at all), it is neither handed back nor published
  // again. Refused like a deletion under way; a `renew` retry goes on to the next generation once
  // the removal has finished.
  if (
    readPreviousAccount &&
    (operation.status === 'directory_pending' || operation.status === 'succeeded') &&
    (await readPreviousAccount(operation)) !== 'live'
  ) {
    throw new Error(ACCOUNT_CREATION_PREVIOUS_ACCOUNT_DELETING);
  }
  let publication = operation.publication;
  if (!publication) {
    try {
      publication = await buildInitialAccountDirectoryPublication(env, {
        tenantId: operation.tenantId,
        accountId: operation.accountId,
        email: input.email,
        externalSubject: input.externalSubject,
        residencyPolicyId: input.residencyPolicyId,
        residencyPartition: input.residencyPartition,
        idempotencyKey: operation.allocationIdempotencyKey,
        operationId: operation.operationId,
      });
    } catch (error) {
      try {
        await dependencies.operationRepository.recordPreparationFailure(
          operation,
          classifyAccountCreationPreparationError(error),
          now
        );
      } catch (recordError) {
        log.warn(
          'Account creation preparation failure could not be persisted',
          { stage: 'preparation_failure_persistence' },
          recordError instanceof Error ? recordError : new Error('unknown_persistence_failure')
        );
      }
      throw error;
    }
    operation = await dependencies.operationRepository.recordPublication(
      operation,
      publication,
      now
    );
  }
  if (operation.status === 'succeeded') {
    await commitInitialAccountRouteAllocation(env, publication);
    return {
      operation,
      publication,
      delivery: {
        status: 201,
        accountId: publication.accountId,
        operationId: operation.operationId,
      },
    };
  }

  const targets = await resolveInitialAccountDirectoryWriteTargets(env, publication);
  const tenantCoreUsers = ensureDatabaseAdapter(
    targets.tenantCoreUsers,
    'account-directory-tenant-core-users'
  );
  if (['preparing', 'reserved', 'writing'].includes(operation.status)) {
    try {
      await reserveInitialIdentifiers(env, publication, dependencies, now);
    } catch (error) {
      if (error instanceof Error && error.message === 'directory_identifier_reservation_conflict') {
        await dependencies.operationRepository.recordDirectoryOutcome({
          publication,
          outcome: 'blocked',
          now,
          errorCode: 'directory_identifier_reservation_conflict',
        });
        await rollbackInitialReservations(env, publication, dependencies, now);
      }
      throw error;
    }
  }
  if (operation.status === 'preparing') {
    operation = await dependencies.operationRepository.transition(operation, 'reserved', now);
  }
  if (operation.status === 'reserved') {
    operation = await dependencies.operationRepository.transition(operation, 'writing', now);
  }
  if (operation.status === 'writing') {
    log.info('Durable account authoritative write started', {
      stage: 'authoritative_write_started',
    });
    await dependencies.writeAuthoritative({
      publication,
      tenantCoreUsers,
      tenantPii: ensureDatabaseAdapter(targets.tenantPii, 'account-directory-tenant-pii'),
      residencyPartition: targets.residencyPartition,
    });
    log.info('Durable account authoritative write completed', {
      stage: 'authoritative_write_completed',
    });
    log.info('Account route allocation commit started', { stage: 'allocation_commit_started' });
    await commitInitialAccountRouteAllocation(env, publication);
    log.info('Account route allocation commit completed', { stage: 'allocation_commit_completed' });
    log.info('Directory outbox ready transition started', { stage: 'outbox_ready_started' });
    await markAccountDirectoryPublicationReady(tenantCoreUsers, publication.operationId, now);
    log.info('Directory outbox ready transition completed', { stage: 'outbox_ready_completed' });
  }
  const delivery = await attemptImmediateAccountDirectoryPublication(
    env.ACCOUNT_DIRECTORY,
    publication
  );
  operation =
    delivery.status === 201
      ? await dependencies.operationRepository.recordDirectoryOutcome({
          publication,
          outcome: 'succeeded',
          now,
          lifecycleEventAdapter: tenantCoreUsers,
        })
      : await dependencies.operationRepository.transition(operation, 'directory_pending', now);
  return { operation, publication, delivery };
}

export async function attemptImmediateAccountDirectoryPublication(
  binding: AccountDirectoryServiceBinding | undefined,
  publication: AccountDirectoryPublication
): Promise<AccountDirectoryPublishResult> {
  if (binding) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await binding.publishAccountDirectory(publication);
        if (
          result.status === 201 &&
          result.accountId === publication.accountId &&
          result.operationId === publication.operationId
        ) {
          return result;
        }
        break;
      } catch {
        // A publication is fenced by its operation ID and safe to retry once. The prepared outbox
        // remains the durable retry boundary if both immediate attempts lose their response.
      }
    }
  }
  return {
    status: 202,
    accountId: publication.accountId,
    operationId: publication.operationId,
  };
}
