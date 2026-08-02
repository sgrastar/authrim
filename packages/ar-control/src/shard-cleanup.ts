import {
  CloudflareControlApiError,
  RUNTIME_REGISTRY_SNAPSHOT_VERSION,
  buildRemovingWorkerBindingSettingsPatch,
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
  verifyTenantRuntimeRegistrySnapshotSignature,
  verifyWorkerSettingsBindingRemoved,
  type CloudflareD1Database,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerSettings,
  type ControlShardCleanupApprovalRequest,
  type ControlShardCleanupRetryRequest,
  type ControlShardCleanupView,
  type ControlShardQuarantineRequest,
  type ControlShardQuarantineRetryRequest,
  type RuntimeRegistrySnapshotVerificationKey,
  type TenantRuntimeRegistryGenerationDocument,
  type TenantRuntimeRegistrySnapshot,
} from '@authrim/ar-lib-core';
import type { ControlD1ApiClient, ControlWorkersApiClient } from './control-api-clients';
import {
  D1ShardCleanupRepository,
  type ShardCleanupBindingTarget,
  type ShardCleanupDeploymentLease,
  type ShardCleanupTarget,
  type ShardQuarantineTarget,
} from './shard-cleanup-repository';
import type { ControlEnv } from './types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const STANDARD_RETRY_BUDGET_SECONDS = 2 * 60 * 60;
const RETRY_SECONDS = 15;
const MAX_SNAPSHOT_BYTES = 512 * 1024;

interface ActiveDeployment {
  deploymentId: string;
  versionId: string;
  createdAt: number;
}

export interface ShardCleanupReconcileResult {
  quarantineAttempted: number;
  quarantineReady: number;
  cleanupAttempted: number;
  cleanupSucceeded: number;
  waitingRetry: number;
  blocked: number;
}

export interface ShardCleanupRegistryReader {
  get(key: string): Promise<string | null>;
}

export interface ShardCleanupServiceDependencies {
  repository: D1ShardCleanupRepository;
  d1: Pick<ControlD1ApiClient, 'getD1Database' | 'deleteD1Database'>;
  workers: Pick<
    ControlWorkersApiClient,
    'getWorkerSettings' | 'patchWorkerSettings' | 'listWorkerDeployments'
  >;
  registry?: ShardCleanupRegistryReader;
  registryVerificationKeys?: RuntimeRegistrySnapshotVerificationKey[];
  deploymentTarget?: string;
  destructiveOperationsEnabled: boolean;
  now: () => number;
}

function requiredId(value: string, field: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`invalid_${field}`);
  return value;
}

async function digestOperationId(parts: readonly string[], prefix: string): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join('\0'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  return `${prefix}_${hex.slice(0, 32)}`;
}

function activeDeployment(deployments: readonly CloudflareWorkerDeployment[]): ActiveDeployment {
  const candidates = deployments
    .map((deployment) => {
      const versions = Array.isArray(deployment.versions) ? deployment.versions : [];
      const version = versions.length === 1 && versions[0]?.percentage === 100 ? versions[0] : null;
      const createdAt = Date.parse(deployment.created_on);
      if (!deployment.id || !version?.version_id || !Number.isFinite(createdAt)) return null;
      return { deploymentId: deployment.id, versionId: version.version_id, createdAt };
    })
    .filter((value): value is ActiveDeployment => value !== null)
    .sort((left, right) => right.createdAt - left.createdAt);
  if (!candidates[0]) throw new Error('control_worker_active_deployment_missing');
  if (candidates[1] && candidates[0].createdAt === candidates[1].createdAt) {
    throw new Error('control_worker_active_deployment_ambiguous');
  }
  return candidates[0];
}

function activeDeploymentFollows(
  deployments: readonly CloudflareWorkerDeployment[],
  active: ActiveDeployment,
  previousDeploymentId: string
): boolean {
  const ordered = deployments
    .slice()
    .sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on));
  return ordered[0]?.id === active.deploymentId && ordered[1]?.id === previousDeploymentId;
}

function parseSettings(value: string | null): CloudflareWorkerSettings {
  if (!value || new TextEncoder().encode(value).byteLength > 1024 * 1024) {
    throw new Error('control_shard_cleanup_previous_settings_missing');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('control_shard_cleanup_previous_settings_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('control_shard_cleanup_previous_settings_invalid');
  }
  return parsed as CloudflareWorkerSettings;
}

function bindingDatabaseId(binding: Record<string, unknown>): string | null {
  const value = binding.database_id ?? binding.id;
  return typeof value === 'string' ? value : null;
}

function expectedBindingPresence(
  settings: CloudflareWorkerSettings,
  target: ShardCleanupBindingTarget
): 'present' | 'absent' {
  const bindings = Array.isArray(settings.bindings) ? settings.bindings : [];
  const matching = bindings.filter((binding) => binding.name === target.bindingRef);
  if (matching.length === 0) {
    if (bindings.some((binding) => bindingDatabaseId(binding) === target.databaseId)) {
      throw new Error('control_shard_cleanup_binding_identity_mismatch');
    }
    return 'absent';
  }
  if (matching.length !== 1 || bindingDatabaseId(matching[0] ?? {}) !== target.databaseId) {
    throw new Error('control_shard_cleanup_binding_identity_mismatch');
  }
  return 'present';
}

function parseJsonDocument<T>(value: string | null, code: string): T {
  if (!value || new TextEncoder().encode(value).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error(code);
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(code);
  }
}

function activeRegistryVerificationKeys(env: ControlEnv): RuntimeRegistrySnapshotVerificationKey[] {
  const slots = [env.RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A, env.RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B];
  const keys: RuntimeRegistrySnapshotVerificationKey[] = [];
  for (const serialized of slots) {
    if (!serialized) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      throw new Error('control_runtime_registry_signing_key_invalid');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('control_runtime_registry_signing_key_invalid');
    }
    const parsedRecord = parsed as Record<string, unknown>;
    if (
      parsedRecord.kty !== 'OKP' ||
      parsedRecord.crv !== 'Ed25519' ||
      typeof parsedRecord.x !== 'string'
    ) {
      throw new Error('control_runtime_registry_signing_key_invalid');
    }
    const keyId = parsedRecord.kid;
    if (typeof keyId !== 'string' || !SAFE_ID.test(keyId)) {
      throw new Error('control_runtime_registry_signing_key_invalid');
    }
    const publicJwk = { ...parsedRecord };
    for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) delete publicJwk[field];
    publicJwk.alg = 'EdDSA';
    publicJwk.use = 'sig';
    publicJwk.key_ops = ['verify'];
    keys.push({
      publicJwk: publicJwk as unknown as RuntimeRegistrySnapshotVerificationKey['publicJwk'],
      keyId,
    });
  }
  if (keys.length === 0 || keys.length > 2) {
    throw new Error('control_runtime_registry_verification_keys_invalid');
  }
  return keys;
}

function classifyError(error: unknown): { code: string; permanent: boolean } {
  if (error instanceof CloudflareControlApiError) {
    if (error.status === 401 || error.status === 403) {
      return { code: 'control_cleanup_provider_capability_rejected', permanent: true };
    }
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      return { code: 'control_cleanup_provider_request_rejected', permanent: true };
    }
    return { code: 'control_cleanup_provider_request_failed', permanent: false };
  }
  const code = error instanceof Error ? error.message : '';
  if (
    code === 'control_shard_quarantine_registry_snapshot_invalid' ||
    code === 'control_shard_quarantine_registry_generation_invalid' ||
    code === 'control_worker_binding_cleanup_propagating' ||
    code === 'control_shard_cleanup_database_still_present'
  ) {
    return { code, permanent: false };
  }
  if (
    code.endsWith('_invalid') ||
    code.endsWith('_mismatch') ||
    code.endsWith('_ambiguous') ||
    code.endsWith('_missing') ||
    code.endsWith('_conflict') ||
    code.endsWith('_detected') ||
    code.includes('identity') ||
    code.includes('generation_stale') ||
    code.includes('signature')
  ) {
    return { code: code || 'control_shard_cleanup_invalid', permanent: true };
  }
  return { code: code || 'control_shard_cleanup_failed', permanent: false };
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareControlApiError && error.status === 404;
}

export class ShardCleanupService {
  constructor(private readonly dependencies: ShardCleanupServiceDependencies) {}

  static fromEnv(
    env: ControlEnv,
    repository: D1ShardCleanupRepository,
    d1: ShardCleanupServiceDependencies['d1'],
    workers: ShardCleanupServiceDependencies['workers'],
    now: () => number
  ): ShardCleanupService {
    return new ShardCleanupService({
      repository,
      d1,
      workers,
      registry: env.TENANT_RUNTIME_REGISTRY,
      registryVerificationKeys: activeRegistryVerificationKeys(env),
      deploymentTarget: env.AUTHRIM_DEPLOYMENT_TARGET?.trim() || 'default',
      destructiveOperationsEnabled: env.CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED === 'true',
      now,
    });
  }

  list(environmentId: string): Promise<ControlShardCleanupView[]> {
    return this.dependencies.repository.list(
      requiredId(environmentId, 'environment_id'),
      this.dependencies.destructiveOperationsEnabled
    );
  }

  get(environmentId: string, shardId: string): Promise<ControlShardCleanupView | null> {
    return this.dependencies.repository.get(
      requiredId(environmentId, 'environment_id'),
      requiredId(shardId, 'shard_id'),
      this.dependencies.destructiveOperationsEnabled
    );
  }

  async quarantine(
    environmentId: string,
    request: ControlShardQuarantineRequest
  ): Promise<ControlShardCleanupView> {
    requiredId(environmentId, 'environment_id');
    requiredId(request.shardId, 'shard_id');
    requiredId(request.idempotencyKey, 'idempotency_key');
    const existing = await this.dependencies.repository.findExistingOperation(
      environmentId,
      request.idempotencyKey
    );
    if (existing) {
      if (
        existing.operation_kind !== 'quarantine_shard' ||
        existing.shard_id !== request.shardId ||
        existing.requested_by_id !== request.requestedById
      ) {
        throw new Error('control_shard_quarantine_idempotency_conflict');
      }
      const replay = await this.get(environmentId, request.shardId);
      if (!replay) throw new Error('control_shard_quarantine_idempotency_conflict');
      return replay;
    }
    const operationId = await digestOperationId(
      [environmentId, 'quarantine_shard', request.shardId, request.idempotencyKey],
      'quarantine'
    );
    await this.dependencies.repository.startQuarantine({
      environmentId,
      operationId,
      request,
      now: this.dependencies.now(),
    });
    const result = await this.get(environmentId, request.shardId);
    if (!result) throw new Error('control_shard_quarantine_reflection_failed');
    return result;
  }

  async approveCleanup(
    environmentId: string,
    request: ControlShardCleanupApprovalRequest
  ): Promise<ControlShardCleanupView> {
    requiredId(environmentId, 'environment_id');
    requiredId(request.quarantineOperationId, 'quarantine_operation_id');
    requiredId(request.idempotencyKey, 'idempotency_key');
    if (!request.deleteDatabase) throw new Error('control_shard_cleanup_delete_required');
    if (
      (request.exportMode === 'manual_verified' && !request.exportEvidenceId) ||
      (request.exportMode === 'skipped' && request.exportEvidenceId !== null)
    ) {
      throw new Error('control_shard_cleanup_export_evidence_invalid');
    }
    if (request.exportEvidenceId) requiredId(request.exportEvidenceId, 'export_evidence_id');
    const existing = await this.dependencies.repository.findExistingOperation(
      environmentId,
      request.idempotencyKey
    );
    if (existing) {
      if (
        existing.operation_kind !== 'cleanup_shard' ||
        !existing.shard_id ||
        existing.requested_by_id !== request.requestedById ||
        existing.quarantine_operation_id !== request.quarantineOperationId ||
        existing.export_mode !== request.exportMode ||
        existing.export_evidence_id !== request.exportEvidenceId ||
        existing.delete_database !== (request.deleteDatabase ? 1 : 0)
      ) {
        throw new Error('control_shard_cleanup_idempotency_conflict');
      }
      const replay = await this.get(environmentId, existing.shard_id);
      if (!replay || replay.cleanupOperationId !== existing.operation_id) {
        throw new Error('control_shard_cleanup_idempotency_conflict');
      }
      return replay;
    }
    const operationId = await digestOperationId(
      [environmentId, 'cleanup_shard', request.quarantineOperationId, request.idempotencyKey],
      'cleanup'
    );
    const shardId = await this.dependencies.repository.approveCleanup({
      environmentId,
      operationId,
      request,
      destructiveOperationsEnabled: this.dependencies.destructiveOperationsEnabled,
      now: this.dependencies.now(),
    });
    const result = await this.get(environmentId, shardId);
    if (!result) throw new Error('control_shard_cleanup_reflection_failed');
    return result;
  }

  async retryCleanup(
    environmentId: string,
    request: ControlShardCleanupRetryRequest
  ): Promise<ControlShardCleanupView> {
    if (!this.dependencies.destructiveOperationsEnabled) {
      throw new Error('control_destructive_operations_disabled');
    }
    const shardId = await this.dependencies.repository.retryCleanup({
      environmentId: requiredId(environmentId, 'environment_id'),
      request,
      now: this.dependencies.now(),
    });
    const result = await this.get(environmentId, shardId);
    if (!result) throw new Error('control_shard_cleanup_reflection_failed');
    return result;
  }

  async retryQuarantine(
    environmentId: string,
    request: ControlShardQuarantineRetryRequest
  ): Promise<ControlShardCleanupView> {
    requiredId(request.quarantineOperationId, 'quarantine_operation_id');
    requiredId(request.idempotencyKey, 'idempotency_key');
    const shardId = await this.dependencies.repository.retryQuarantine({
      environmentId: requiredId(environmentId, 'environment_id'),
      request,
      now: this.dependencies.now(),
    });
    const result = await this.get(environmentId, shardId);
    if (!result) throw new Error('control_shard_quarantine_reflection_failed');
    return result;
  }

  async reconcile(limit = 5): Promise<ShardCleanupReconcileResult> {
    const result: ShardCleanupReconcileResult = {
      quarantineAttempted: 0,
      quarantineReady: 0,
      cleanupAttempted: 0,
      cleanupSucceeded: 0,
      waitingRetry: 0,
      blocked: 0,
    };
    const now = this.dependencies.now();
    const quarantines = await this.dependencies.repository.listDueQuarantines(limit, now);
    for (const target of quarantines) {
      result.quarantineAttempted += 1;
      const outcome = await this.reconcileQuarantine(target);
      if (outcome === 'ready') result.quarantineReady += 1;
      else result[outcome] += 1;
    }
    const cleanups = await this.dependencies.repository.listDueCleanups(limit, now);
    for (const target of cleanups) {
      result.cleanupAttempted += 1;
      const outcome = await this.reconcileCleanup(target);
      if (outcome === 'succeeded') result.cleanupSucceeded += 1;
      else result[outcome] += 1;
    }
    return result;
  }

  private async reconcileQuarantine(
    target: ShardQuarantineTarget
  ): Promise<'ready' | 'waitingRetry' | 'blocked'> {
    const now = this.dependencies.now();
    try {
      const referenceCount = await this.dependencies.repository.countActiveReferences(target);
      if (referenceCount !== 0) throw new Error('control_shard_cleanup_active_references_present');
      await this.verifyRegistry(target);
      if (now < target.drainNotBefore) {
        await this.dependencies.repository.recordQuarantineWaiting({
          operationId: target.operationId,
          registryVerified: true,
          referencesVerified: true,
          nextAttemptAt: Math.min(target.drainNotBefore, now + 60),
          now,
        });
        return 'waitingRetry';
      }
      await this.dependencies.repository.markQuarantineReady(target.operationId, now);
      return 'ready';
    } catch (error) {
      const failure = classifyError(error);
      if (failure.permanent || now - target.retryBudgetStartedAt >= STANDARD_RETRY_BUDGET_SECONDS) {
        await this.dependencies.repository.markQuarantineBlocked(
          target.operationId,
          failure.code,
          now
        );
        return 'blocked';
      }
      await this.dependencies.repository.recordQuarantineWaiting({
        operationId: target.operationId,
        registryVerified: false,
        referencesVerified: false,
        nextAttemptAt: now + RETRY_SECONDS,
        now,
      });
      return 'waitingRetry';
    }
  }

  private async verifyRegistry(target: ShardQuarantineTarget): Promise<void> {
    if (target.tenants.length === 0) return;
    const store = this.dependencies.registry;
    const keys = this.dependencies.registryVerificationKeys ?? [];
    if (!store || keys.length === 0) {
      throw new Error('control_shard_quarantine_registry_verifier_missing');
    }
    const deploymentTarget = this.dependencies.deploymentTarget ?? 'default';
    for (const tenant of target.tenants) {
      const [snapshotValue, generationValue] = await Promise.all([
        store.get(buildTenantRuntimeRegistrySnapshotKey(tenant.tenantId, deploymentTarget)),
        store.get(buildTenantRuntimeRegistryGenerationKey(tenant.tenantId, deploymentTarget)),
      ]);
      const snapshot = parseJsonDocument<TenantRuntimeRegistrySnapshot>(
        snapshotValue,
        'control_shard_quarantine_registry_snapshot_invalid'
      );
      const generation = parseJsonDocument<TenantRuntimeRegistryGenerationDocument>(
        generationValue,
        'control_shard_quarantine_registry_generation_invalid'
      );
      const publishedAt = Date.parse(snapshot.publishedAt);
      const expiresAt = Date.parse(snapshot.expiresAt);
      const nowMs = this.dependencies.now() * 1000;
      if (
        !Array.isArray(snapshot.stores) ||
        (await verifyTenantRuntimeRegistrySnapshotSignature(snapshot, keys)) !== 'valid' ||
        snapshot.version !== RUNTIME_REGISTRY_SNAPSHOT_VERSION ||
        snapshot.tenantId !== tenant.tenantId ||
        snapshot.deploymentTarget !== deploymentTarget ||
        snapshot.runtimeGeneration < tenant.minimumRuntimeGeneration ||
        generation.runtimeGeneration !== snapshot.runtimeGeneration ||
        generation.routeStatus !== snapshot.routeStatus ||
        generation.quarantineDenyGeneration !== snapshot.quarantineDenyGeneration ||
        !Number.isFinite(publishedAt) ||
        !Number.isFinite(expiresAt) ||
        publishedAt > nowMs ||
        expiresAt <= nowMs ||
        expiresAt <= publishedAt ||
        expiresAt - publishedAt > 30 * 60 * 1000 ||
        snapshot.stores.some(
          (entry) =>
            entry.bindingRef === target.bindingRef || entry.databaseId === target.databaseId
        )
      ) {
        throw new Error('control_shard_quarantine_registry_readback_mismatch');
      }
      await this.dependencies.repository.recordQuarantineTenantEvidence({
        operationId: target.operationId,
        tenantId: tenant.tenantId,
        runtimeGeneration: snapshot.runtimeGeneration,
        quarantineDenyGeneration: snapshot.quarantineDenyGeneration,
        publishedAt: Math.floor(publishedAt / 1000),
        expiresAt: Math.floor(expiresAt / 1000),
        now: this.dependencies.now(),
      });
    }
  }

  private async reconcileCleanup(
    target: ShardCleanupTarget
  ): Promise<'succeeded' | 'waitingRetry' | 'blocked'> {
    const now = this.dependencies.now();
    if (!this.dependencies.destructiveOperationsEnabled) {
      await this.dependencies.repository.markCleanupBlocked(
        target.operationId,
        'control_destructive_operations_disabled',
        now
      );
      return 'blocked';
    }
    try {
      const quarantine = await this.dependencies.repository.getQuarantineTargetForCleanup(
        target.operationId
      );
      if (now < quarantine.drainNotBefore) {
        throw new Error('control_shard_cleanup_snapshot_drain_incomplete');
      }
      if ((await this.dependencies.repository.countActiveReferences(target)) !== 0) {
        throw new Error('control_shard_cleanup_active_references_present');
      }
      await this.verifyRegistry(quarantine);
      await this.dependencies.repository.markCleanupRunning(target.operationId, now);
      const bindings = await this.dependencies.repository.listPendingBindings(target.operationId);
      for (const binding of bindings) await this.removeBinding(binding);
      await this.dependencies.repository.markBindingsComplete(
        target.operationId,
        this.dependencies.now()
      );
      const deletionQuarantine = await this.dependencies.repository.getQuarantineTargetForCleanup(
        target.operationId
      );
      if ((await this.dependencies.repository.countActiveReferences(target)) !== 0) {
        throw new Error('control_shard_cleanup_active_references_present');
      }
      await this.verifyRegistry(deletionQuarantine);
      await this.deleteDatabase(target);
      await this.dependencies.repository.markCleanupSucceeded(
        target.operationId,
        this.dependencies.now()
      );
      return 'succeeded';
    } catch (error) {
      const failure = classifyError(error);
      const current = this.dependencies.now();
      if (
        failure.permanent ||
        current - target.retryBudgetStartedAt >= STANDARD_RETRY_BUDGET_SECONDS
      ) {
        await this.dependencies.repository.markCleanupBlocked(
          target.operationId,
          failure.code,
          current
        );
        return 'blocked';
      }
      await this.dependencies.repository.markCleanupWaiting(
        target.operationId,
        failure.code,
        current + RETRY_SECONDS,
        current
      );
      return 'waitingRetry';
    }
  }

  private async removeBinding(target: ShardCleanupBindingTarget): Promise<void> {
    const initialDeployments = await this.dependencies.workers.listWorkerDeployments(
      target.workerScriptName
    );
    const initialActive = activeDeployment(initialDeployments);
    const sourceVersionId = target.expectedSourceVersionId ?? initialActive.versionId;
    const lease = await this.dependencies.repository.acquireDeploymentLease({
      target,
      expectedSourceVersionId: sourceVersionId,
      now: this.dependencies.now(),
    });
    if (!lease) throw new Error('control_worker_deployment_lease_busy');
    try {
      await this.removeBindingUnderLease(target, lease);
    } finally {
      await this.dependencies.repository.releaseDeploymentLease(lease);
    }
  }

  private async removeBindingUnderLease(
    target: ShardCleanupBindingTarget,
    lease: ShardCleanupDeploymentLease
  ): Promise<void> {
    if (!(await this.dependencies.repository.leaseIsCurrent(lease, this.dependencies.now()))) {
      throw new Error('control_worker_deployment_lease_lost');
    }
    const deployments = await this.dependencies.workers.listWorkerDeployments(
      target.workerScriptName
    );
    const active = activeDeployment(deployments);
    const currentSettings = await this.dependencies.workers.getWorkerSettings(
      target.workerScriptName
    );

    if (target.state === 'pending') {
      if (active.versionId !== lease.expectedSourceVersionId) {
        throw new Error('control_worker_source_version_changed');
      }
      if (expectedBindingPresence(currentSettings, target) === 'absent') {
        if (!(await this.dependencies.repository.leaseIsCurrent(lease, this.dependencies.now()))) {
          throw new Error('control_worker_deployment_lease_lost');
        }
        await this.dependencies.repository.markBindingAlreadyAbsent({
          target,
          lease,
          versionId: active.versionId,
          deploymentId: active.deploymentId,
          currentSettingsJson: JSON.stringify(currentSettings),
          now: this.dependencies.now(),
        });
        return;
      }
      await this.dependencies.repository.recordBindingRemovalStarted({
        target,
        lease,
        sourceVersionId: active.versionId,
        previousDeploymentId: active.deploymentId,
        previousSettingsJson: JSON.stringify(currentSettings),
        now: this.dependencies.now(),
      });
      if (!(await this.dependencies.repository.leaseIsCurrent(lease, this.dependencies.now()))) {
        throw new Error('control_worker_deployment_lease_lost');
      }
      const patch = buildRemovingWorkerBindingSettingsPatch({
        currentSettings,
        sourceVersionId: active.versionId,
        bindingName: target.bindingRef,
      });
      await this.dependencies.workers.patchWorkerSettings(target.workerScriptName, patch);
    } else if (target.state === 'removing') {
      if (active.versionId === lease.expectedSourceVersionId) {
        expectedBindingPresence(currentSettings, target);
        const patch = buildRemovingWorkerBindingSettingsPatch({
          currentSettings,
          sourceVersionId: active.versionId,
          bindingName: target.bindingRef,
        });
        await this.dependencies.workers.patchWorkerSettings(target.workerScriptName, patch);
      }
    } else {
      throw new Error('control_shard_cleanup_binding_state_invalid');
    }

    const reflectedDeployments = await this.dependencies.workers.listWorkerDeployments(
      target.workerScriptName
    );
    const reflectedActive = activeDeployment(reflectedDeployments);
    const reflectedSettings = await this.dependencies.workers.getWorkerSettings(
      target.workerScriptName
    );
    if (reflectedActive.versionId === lease.expectedSourceVersionId) {
      throw new Error('control_worker_binding_cleanup_propagating');
    }
    const previousDeploymentId = target.previousDeploymentId ?? active.deploymentId;
    if (!activeDeploymentFollows(reflectedDeployments, reflectedActive, previousDeploymentId)) {
      throw new Error('control_worker_concurrent_deployment_detected');
    }
    const before =
      target.state === 'removing'
        ? parseSettings(target.previousRestoreSettingsJson)
        : currentSettings;
    const issues = verifyWorkerSettingsBindingRemoved({
      before,
      after: reflectedSettings,
      bindingName: target.bindingRef,
    });
    if (issues.length > 0) throw new Error('control_worker_binding_cleanup_reflection_mismatch');
    await this.dependencies.repository.markBindingRemoved({
      target,
      lease,
      versionId: reflectedActive.versionId,
      deploymentId: reflectedActive.deploymentId,
      now: this.dependencies.now(),
    });
  }

  private async deleteDatabase(target: ShardCleanupTarget): Promise<void> {
    if (!target.deleteDatabase) throw new Error('control_shard_cleanup_delete_required');
    await this.dependencies.repository.markDatabaseDeletionStarted(
      target.operationId,
      this.dependencies.now()
    );
    let database: CloudflareD1Database | null = null;
    try {
      database = await this.dependencies.d1.getD1Database(target.databaseId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (database) {
      if (database.uuid !== target.databaseId || database.name !== target.databaseName) {
        throw new Error('control_shard_cleanup_database_identity_mismatch');
      }
      await this.dependencies.d1.deleteD1Database(target.databaseId);
    }
    await this.dependencies.repository.markDatabaseDeleteRequested(
      target.operationId,
      this.dependencies.now()
    );
    try {
      await this.dependencies.d1.getD1Database(target.databaseId);
      throw new Error('control_shard_cleanup_database_still_present');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

export { activeRegistryVerificationKeys };
