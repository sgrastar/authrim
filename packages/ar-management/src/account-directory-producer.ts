import {
  createLookupBlindIndexes,
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
import { InitialAccountIdentifierReservationService } from './account-directory-reservation';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';

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
}

export interface DurableInitialAccountDirectoryWriteDependencies extends InitialAccountDirectoryWriteDependencies {
  operationRepository: AccountCreationOperationRepository;
}

export interface DurableInitialAccountDirectoryWriteResult extends InitialAccountDirectoryWriteResult {
  operation: AccountCreationOperation;
}

async function allocateAccountRouteWithElasticCapacity(
  env: Env,
  input: InitialAccountDirectoryPublicationInput,
  accountIdBlindDigest: string,
  dataRoles: readonly ['tenant_core/users', 'tenant_pii']
) {
  if (!env.CONTROL) throw new Error('account_directory_control_unavailable');
  const request = {
    tenantId: input.tenantId,
    accountIdBlindDigest,
    residencyPolicyId: input.residencyPolicyId,
    residencyPartition: input.residencyPartition,
    idempotencyKey: input.idempotencyKey,
    dataRoles: [...dataRoles],
  };
  try {
    return await env.CONTROL.allocateAccountRoute(request);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== 'control_account_allocation_capacity_unavailable' ||
      !env.CONTROL.ensureTenantShardCapacity
    ) {
      throw error;
    }
  }

  const capacity = await Promise.all(
    dataRoles.map((dataRole) =>
      env.CONTROL!.ensureTenantShardCapacity!({
        tenantId: input.tenantId,
        dataRole,
        residencyPolicyId: input.residencyPolicyId,
        residencyPartition: input.residencyPartition,
        idempotencyKey: `account-capacity:${accountIdBlindDigest.slice(0, 32)}:${dataRole.replaceAll('/', '-')}`,
      })
    )
  );
  for (const [index, result] of capacity.entries()) {
    if (
      !result ||
      (result.state !== 'ready' && result.state !== 'provisioning' && result.state !== 'blocked') ||
      (result.state === 'ready' && result.target.dataRole !== dataRoles[index])
    ) {
      throw new Error('account_directory_capacity_response_invalid');
    }
  }
  if (capacity.some((result) => result.state !== 'ready')) {
    throw new Error('control_account_allocation_capacity_unavailable');
  }
  return env.CONTROL.allocateAccountRoute(request);
}

function d1Binding(env: Env, bindingRef: string): D1Database {
  const value = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!value || typeof value !== 'object') {
    throw new Error('account_directory_write_binding_unavailable');
  }
  const binding = value as Partial<D1Database>;
  if (
    typeof binding.prepare !== 'function' ||
    typeof binding.batch !== 'function' ||
    typeof binding.withSession !== 'function'
  ) {
    throw new Error('account_directory_write_binding_unavailable');
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
  await reserveInitialIdentifiers(env, publication, dependencies, now);
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
  await markAccountDirectoryPublicationReady(tenantCoreUsers, publication.operationId, now);
  return {
    publication,
    delivery: await attemptImmediateAccountDirectoryPublication(env.ACCOUNT_DIRECTORY, publication),
  };
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
  let operation = await dependencies.operationRepository.acquire({
    tenantId: input.tenantId,
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    candidateOperationId: input.candidateOperationId,
    candidateUserId: input.candidateUserId,
    now,
  });
  if (operation.status === 'blocked' || operation.status === 'canceled') {
    throw new Error(`account_creation_operation_${operation.status}`);
  }
  let publication = operation.publication;
  if (!publication) {
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
    operation = await dependencies.operationRepository.recordPublication(
      operation,
      publication,
      now
    );
  }
  if (operation.status === 'succeeded') {
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
    await reserveInitialIdentifiers(env, publication, dependencies, now);
  }
  if (operation.status === 'preparing') {
    operation = await dependencies.operationRepository.transition(operation, 'reserved', now);
  }
  if (operation.status === 'reserved') {
    operation = await dependencies.operationRepository.transition(operation, 'writing', now);
  }
  if (operation.status === 'writing') {
    await dependencies.writeAuthoritative({
      publication,
      tenantCoreUsers,
      tenantPii: ensureDatabaseAdapter(targets.tenantPii, 'account-directory-tenant-pii'),
      residencyPartition: targets.residencyPartition,
    });
    await markAccountDirectoryPublicationReady(tenantCoreUsers, publication.operationId, now);
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
