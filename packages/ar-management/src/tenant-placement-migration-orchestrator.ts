import {
  assertControlPlaneRecordIsSecretFree,
  type ControlTenantPlacementMigrationView,
  type Env,
} from '@authrim/ar-lib-core';
import {
  TenantPlacementMigrationJobRepository,
  type TenantPlacementMigrationJobLease,
  type TenantPlacementMigrationJobView,
  type TenantPlacementMigrationStep,
} from './tenant-placement-migration-job';
import { processTenantPlacementLookupCutoverPage } from './tenant-placement-lookup-cutover';

const RETRY_SECONDS = 5;
const RETRY_BUDGET_SECONDS = 2 * 60 * 60;
const SAFE_ERROR_CODE =
  /^(control|tenant_placement|lookup|tenant_alias|tenant_runtime_registry)_[a-z0-9_]+$/u;
const SAFE_CONTROL_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_D1_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CONTROL_ERROR_CODE = /^[a-z][a-z0-9_]{0,127}$/u;
const MIGRATION_STATES = new Set([
  'planning',
  'targets_provisioning',
  'inventory_verifying',
  'capture_installing',
  'backfilling',
  'catching_up',
  'verifying',
  'write_fencing',
  'cutover_ready',
  'cutover_committed',
  'source_quarantined',
  'purge_pending',
  'complete',
  'canceled',
  'blocked',
]);
const SHARD_STATES = new Set([
  'target_pending',
  'inventory_pending',
  'capture_pending',
  'backfilling',
  'catching_up',
  'verifying',
  'verified',
  'write_fenced',
  'cutover_committed',
  'quarantined',
  'purged',
  'blocked',
]);
const DATA_ROLES = new Set(['tenant_core/default', 'tenant_core/users', 'tenant_pii']);
const WRITE_FENCE_STATES = new Set(['inactive', 'requested', 'active', 'released']);
const NON_CANCELABLE_STATES = new Set([
  'cutover_committed',
  'source_quarantined',
  'purge_pending',
  'complete',
  'canceled',
]);

export interface TenantPlacementMigrationSagaDependencies {
  prepareAlias(
    job: TenantPlacementMigrationJobView,
    migration: ControlTenantPlacementMigrationView
  ): Promise<void>;
  publishRegistry(
    job: TenantPlacementMigrationJobView,
    migration: ControlTenantPlacementMigrationView
  ): Promise<void>;
  activateAlias(
    job: TenantPlacementMigrationJobView,
    migration: ControlTenantPlacementMigrationView
  ): Promise<void>;
}

function control(env: Env) {
  const value = env.CONTROL;
  if (
    !value?.getTenantPlacementMigration ||
    !value.beginTenantPlacementRouteCutover ||
    !value.commitTenantPlacementMigration ||
    !value.finalizeTenantPlacementMigrationCutover
  ) {
    throw new Error('tenant_placement_migration_control_unavailable');
  }
  return value as Required<
    Pick<
      NonNullable<Env['CONTROL']>,
      | 'getTenantPlacementMigration'
      | 'beginTenantPlacementRouteCutover'
      | 'commitTenantPlacementMigration'
      | 'finalizeTenantPlacementMigrationCutover'
    >
  >;
}

function safeErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return code.length <= 128 && SAFE_ERROR_CODE.test(code)
    ? code
    : 'tenant_placement_migration_step_failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CONTROL_IDENTIFIER.test(value);
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isNullableSafeInteger(value: unknown): boolean {
  return value === null || isSafeInteger(value);
}

function isNullableErrorCode(value: unknown): boolean {
  return value === null || (typeof value === 'string' && CONTROL_ERROR_CODE.test(value));
}

function validateMigrationShards(shards: unknown[]): boolean {
  const roleCounts = new Map<string, number>();
  const routeKeys = new Set<string>();
  for (const value of shards) {
    if (!isRecord(value) || !DATA_ROLES.has(String(value.dataRole))) return false;
    const dataRole = String(value.dataRole);
    if (
      !isSafeIdentifier(value.residencyPolicyId) ||
      !isSafeIdentifier(value.residencyPartition) ||
      !isSafeIdentifier(value.sourceShardId) ||
      !isSafeInteger(value.sourceAssignmentGeneration, 1) ||
      !SHARD_STATES.has(String(value.state)) ||
      !isNullableSafeInteger(value.inventoryTableCount) ||
      !isNullableSafeInteger(value.sourceRowCount) ||
      !isNullableSafeInteger(value.targetRowCount) ||
      !isSafeInteger(value.lastObservedSourceSequence) ||
      !isSafeInteger(value.lastAppliedSourceSequence) ||
      Number(value.lastAppliedSourceSequence) > Number(value.lastObservedSourceSequence) ||
      !isNullableErrorCode(value.lastErrorCode) ||
      !isSafeInteger(value.updatedAt)
    ) {
      return false;
    }

    const routeKey = [
      dataRole,
      value.residencyPolicyId,
      value.residencyPartition,
      value.sourceShardId,
    ].join('\u0000');
    if (routeKeys.has(routeKey)) return false;
    routeKeys.add(routeKey);
    roleCounts.set(dataRole, (roleCounts.get(dataRole) ?? 0) + 1);

    if (value.target === null) {
      if (value.targetShardId !== null) return false;
      if (!['target_pending', 'blocked'].includes(String(value.state))) return false;
      continue;
    }
    if (!isRecord(value.target) || !isSafeIdentifier(value.targetShardId)) return false;
    const target = value.target;
    if (
      !isSafeIdentifier(target.shardId) ||
      target.shardId !== value.targetShardId ||
      !isSafeInteger(target.assignmentGeneration, 1) ||
      !isSafeInteger(target.routeGeneration, 1) ||
      typeof target.bindingRef !== 'string' ||
      !SAFE_D1_BINDING.test(target.bindingRef) ||
      (target.databaseId !== null && !isSafeIdentifier(target.databaseId)) ||
      !isSafeIdentifier(target.databaseName)
    ) {
      return false;
    }
  }
  return (
    roleCounts.get('tenant_core/default') === 1 &&
    (roleCounts.get('tenant_core/users') ?? 0) >= 1 &&
    (roleCounts.get('tenant_pii') ?? 0) >= 1
  );
}

function validateMigration(
  value: unknown,
  job: TenantPlacementMigrationJobView
): ControlTenantPlacementMigrationView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tenant_placement_migration_control_response_invalid');
  }
  const migration = value as ControlTenantPlacementMigrationView;
  assertControlPlaneRecordIsSecretFree(migration);
  if (
    migration.operationId !== job.controlOperationId ||
    migration.tenantId !== job.tenantId ||
    migration.sourceIsolationPolicy !== 'shared_pool' ||
    migration.targetIsolationPolicy !== 'tenant_exclusive' ||
    !MIGRATION_STATES.has(String(migration.state)) ||
    !WRITE_FENCE_STATES.has(String(migration.writeFenceState)) ||
    !isSafeInteger(migration.sourcePolicyGeneration, 1) ||
    !isSafeInteger(migration.targetPolicyGeneration, 1) ||
    migration.targetPolicyGeneration !== migration.sourcePolicyGeneration + 1 ||
    typeof migration.routeCutoverStarted !== 'boolean' ||
    typeof migration.canCancel !== 'boolean' ||
    typeof migration.canApprovePurge !== 'boolean' ||
    (migration.routeCutoverStarted && migration.canCancel) ||
    (NON_CANCELABLE_STATES.has(String(migration.state)) && migration.canCancel) ||
    (migration.canApprovePurge && migration.state !== 'source_quarantined') ||
    !isNullableSafeInteger(migration.sourceRetentionExpiresAt) ||
    !isNullableErrorCode(migration.lastErrorCode) ||
    !isSafeInteger(migration.createdAt) ||
    !isSafeInteger(migration.updatedAt) ||
    migration.updatedAt < migration.createdAt ||
    !Array.isArray(migration.shards) ||
    migration.shards.length < 3 ||
    migration.shards.length > 256 ||
    !validateMigrationShards(migration.shards)
  ) {
    throw new Error('tenant_placement_migration_control_response_invalid');
  }
  return migration;
}

async function loadMigration(
  env: Env,
  job: TenantPlacementMigrationJobView
): Promise<ControlTenantPlacementMigrationView> {
  const result = await control(env).getTenantPlacementMigration(job.controlOperationId);
  if (!result) throw new Error('tenant_placement_migration_control_operation_missing');
  return validateMigration(result, job);
}

async function checkpointSucceeded(
  repository: TenantPlacementMigrationJobRepository,
  lease: TenantPlacementMigrationJobLease,
  currentStep: TenantPlacementMigrationStep,
  nextStep: TenantPlacementMigrationStep,
  now: number
): Promise<void> {
  await repository.checkpoint(lease, {
    currentStep,
    nextStep,
    status: 'running',
    now,
  });
}

export async function runTenantPlacementMigrationSaga(input: {
  env: Env;
  repository: TenantPlacementMigrationJobRepository;
  lease: TenantPlacementMigrationJobLease;
  dependencies: TenantPlacementMigrationSagaDependencies;
  now: () => number;
}): Promise<void> {
  const job = input.lease.job;
  let currentStep = job.currentStep;
  let lookupCursor = job.lookupCursor;
  try {
    let migration = await loadMigration(input.env, job);
    if (migration.state === 'blocked') {
      await input.repository.checkpoint(input.lease, {
        currentStep,
        status: 'blocked',
        now: input.now(),
        errorCode: migration.lastErrorCode ?? 'control_tenant_placement_migration_blocked',
      });
      return;
    }
    if (migration.state === 'canceled') {
      await input.repository.checkpoint(input.lease, {
        currentStep,
        status: 'canceled',
        now: input.now(),
      });
      return;
    }

    if (currentStep === 'wait_control') {
      if (!['cutover_ready', 'cutover_committed'].includes(migration.state)) {
        const now = input.now();
        await input.repository.checkpoint(input.lease, {
          currentStep,
          status: 'waiting_retry',
          now,
          nextAttemptAt: now + RETRY_SECONDS,
        });
        return;
      }
      await checkpointSucceeded(
        input.repository,
        input.lease,
        currentStep,
        'begin_route_cutover',
        input.now()
      );
      currentStep = 'begin_route_cutover';
    }

    if (currentStep === 'begin_route_cutover') {
      if (migration.state === 'cutover_ready') {
        migration = validateMigration(
          await control(input.env).beginTenantPlacementRouteCutover({
            operationId: job.controlOperationId,
            requestedById: job.requestedBy,
            idempotencyKey: `${job.operationId}:route-cutover`,
          }),
          job
        );
      }
      if (!migration.routeCutoverStarted) {
        throw new Error('tenant_placement_migration_route_lease_missing');
      }
      await checkpointSucceeded(
        input.repository,
        input.lease,
        currentStep,
        'prepare_lookup',
        input.now()
      );
      currentStep = 'prepare_lookup';
    }

    if (currentStep === 'prepare_lookup') {
      if (migration.state === 'cutover_ready') {
        migration = validateMigration(
          await control(input.env).beginTenantPlacementRouteCutover({
            operationId: job.controlOperationId,
            requestedById: job.requestedBy,
            idempotencyKey: `${job.operationId}:route-cutover`,
          }),
          job
        );
      }
      const page = await processTenantPlacementLookupCutoverPage(input.env, {
        tenantId: job.tenantId,
        migration,
        phase: 'prepare',
        cursor: lookupCursor,
      });
      lookupCursor = page.cursor;
      const now = input.now();
      await input.repository.checkpoint(input.lease, {
        currentStep,
        nextStep: page.complete ? 'prepare_alias' : currentStep,
        status: page.complete ? 'running' : 'waiting_retry',
        now,
        nextAttemptAt: page.complete ? null : now + 1,
        lookupCursor: page.cursor,
        processedLookupRows: page.processedRows,
        lookupCounter: 'prepared',
      });
      if (!page.complete) return;
      currentStep = 'prepare_alias';
    }

    if (currentStep === 'prepare_alias') {
      await input.dependencies.prepareAlias(job, migration);
      await checkpointSucceeded(
        input.repository,
        input.lease,
        currentStep,
        'commit_control',
        input.now()
      );
      currentStep = 'commit_control';
    }

    if (currentStep === 'commit_control') {
      migration = validateMigration(
        await control(input.env).commitTenantPlacementMigration({
          operationId: job.controlOperationId,
          requestedById: job.requestedBy,
          idempotencyKey: `${job.operationId}:control-commit`,
        }),
        job
      );
      if (migration.state !== 'cutover_committed') {
        throw new Error('tenant_placement_migration_control_commit_invalid');
      }
      await checkpointSucceeded(
        input.repository,
        input.lease,
        currentStep,
        'publish_registry',
        input.now()
      );
      currentStep = 'publish_registry';
    }

    if (currentStep === 'publish_registry') {
      await input.dependencies.publishRegistry(job, migration);
      await checkpointSucceeded(
        input.repository,
        input.lease,
        currentStep,
        'activate_alias',
        input.now()
      );
      currentStep = 'activate_alias';
    }

    if (currentStep === 'activate_alias') {
      await input.dependencies.activateAlias(job, migration);
      await checkpointSucceeded(
        input.repository,
        input.lease,
        currentStep,
        'activate_lookup',
        input.now()
      );
      currentStep = 'activate_lookup';
    }

    while (currentStep === 'activate_lookup' || currentStep === 'verify_routes') {
      const phase = currentStep === 'activate_lookup' ? 'activate' : 'verify';
      const nextStep: TenantPlacementMigrationStep =
        currentStep === 'activate_lookup' ? 'verify_routes' : 'finalize_source';
      const page = await processTenantPlacementLookupCutoverPage(input.env, {
        tenantId: job.tenantId,
        migration,
        phase,
        cursor: lookupCursor,
      });
      lookupCursor = page.cursor;
      const now = input.now();
      await input.repository.checkpoint(input.lease, {
        currentStep,
        nextStep: page.complete ? nextStep : currentStep,
        status: page.complete ? 'running' : 'waiting_retry',
        now,
        nextAttemptAt: page.complete ? null : now + 1,
        lookupCursor: page.cursor,
        processedLookupRows: page.processedRows,
        lookupCounter: phase === 'activate' ? 'activated' : 'verified',
      });
      if (!page.complete) return;
      currentStep = nextStep;
    }

    if (currentStep === 'finalize_source') {
      const finalized = validateMigration(
        await control(input.env).finalizeTenantPlacementMigrationCutover({
          operationId: job.controlOperationId,
          requestedById: job.requestedBy,
          idempotencyKey: `${job.operationId}:source-finalize`,
        }),
        job
      );
      if (finalized.state !== 'source_quarantined' || finalized.writeFenceState !== 'released') {
        throw new Error('tenant_placement_migration_finalize_invalid');
      }
      await input.repository.checkpoint(input.lease, {
        currentStep,
        nextStep: 'complete',
        status: 'succeeded',
        now: input.now(),
      });
    }
  } catch (error) {
    const now = input.now();
    const code = safeErrorCode(error);
    const permanent =
      code.endsWith('_invalid') ||
      code.endsWith('_conflict') ||
      code.endsWith('_mismatch') ||
      code.endsWith('_unmapped') ||
      code.endsWith('_incomplete') ||
      code.endsWith('_stale') ||
      now - job.retryBudgetStartedAt >= RETRY_BUDGET_SECONDS;
    await input.repository.checkpoint(input.lease, {
      currentStep,
      status: permanent ? 'blocked' : 'waiting_retry',
      now,
      nextAttemptAt: permanent ? null : now + RETRY_SECONDS,
      errorCode: code,
    });
  }
}
