import {
  CloudflareControlApiError,
  activeWorkerDeployment,
  ensureWorkerBindingPatched,
  verifyWorkerSettingsRestoreIntent,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerSettings,
} from '@authrim/ar-lib-core/control-plane';
import type { DesiredWorkerInventoryRow } from './repository';
import type { ControlEnv, RuntimeSmokeServiceBinding } from './types';
import { signControlRuntimeSmokeRequest } from './runtime-smoke-signer';
import {
  D1WorkerBindingRepository,
  type WorkerBindingTarget,
  type WorkerDeploymentLease,
} from './worker-binding-repository';

interface WorkerSettingsApi {
  getWorkerSettings(scriptName: string): Promise<CloudflareWorkerSettings>;
  patchWorkerSettings(
    scriptName: string,
    settings: CloudflareWorkerSettings
  ): Promise<CloudflareWorkerSettings>;
  listWorkerDeployments(scriptName: string): Promise<CloudflareWorkerDeployment[]>;
  createWorkerDeployment(
    scriptName: string,
    versionId: string,
    message: string
  ): Promise<CloudflareWorkerDeployment>;
}

interface DesiredWorkerInventory {
  getActiveDesiredWorker(
    environmentId: string,
    workerScriptName: string
  ): Promise<DesiredWorkerInventoryRow | null>;
  markOperationAwaitingOperator(operationId: string, now: number): Promise<unknown>;
}

export interface WorkerBindingReconcilerResult {
  attempted: number;
  succeeded: number;
  deferred: number;
  blocked: number;
}

type WorkerBindingStateRepository = Pick<
  D1WorkerBindingRepository,
  | 'ensurePendingTargets'
  | 'listDueTargets'
  | 'acquireDeploymentLease'
  | 'leaseIsCurrent'
  | 'releaseDeploymentLease'
  | 'recordAlreadySatisfied'
  | 'recordPatchStarted'
  | 'recordPatchResult'
  | 'recordSmokeProgress'
  | 'adoptSupersedingSmokeDeployment'
  | 'markSucceeded'
  | 'markRollbackRequired'
  | 'recordTransientError'
  | 'markRolledBack'
  | 'markBlocked'
  | 'completeOperationIfReady'
>;

const STABILIZATION_SECONDS = 30;
const RETRY_SECONDS = 15;
const WORKER_DEPLOYMENT_LEASE_SECONDS = 15 * 60;
const CORE_SMOKE_BINDINGS: Readonly<Record<string, keyof ControlEnv>> = {
  'ar-lib-core': 'SMOKE_AR_LIB_CORE',
  'ar-discovery': 'SMOKE_AR_DISCOVERY',
  'ar-auth': 'SMOKE_AR_AUTH',
  'ar-token': 'SMOKE_AR_TOKEN',
  'ar-userinfo': 'SMOKE_AR_USERINFO',
  'ar-management': 'SMOKE_AR_MANAGEMENT',
  'ar-agent-access': 'SMOKE_AR_AGENT_ACCESS',
  'ar-async': 'SMOKE_AR_ASYNC',
  'ar-policy': 'SMOKE_AR_POLICY',
  'ar-saml': 'SMOKE_AR_SAML',
  'ar-bridge': 'SMOKE_AR_BRIDGE',
  'ar-vc': 'SMOKE_AR_VC',
  'ar-plugin-runner': 'SMOKE_AR_PLUGIN_RUNNER',
};

function resolveSmokeService(
  env: ControlEnv,
  target: WorkerBindingTarget
): RuntimeSmokeServiceBinding {
  const prefix = `${target.environmentName}-`;
  if (!target.workerScriptName.startsWith(prefix)) {
    throw new Error('control_worker_script_environment_mismatch');
  }
  const component = target.workerScriptName.slice(prefix.length);
  const bindingName = CORE_SMOKE_BINDINGS[component];
  const binding = bindingName ? env[bindingName] : undefined;
  if (
    !binding ||
    typeof (binding as RuntimeSmokeServiceBinding).smokeTenantBinding !== 'function'
  ) {
    throw new Error('control_worker_smoke_service_binding_missing');
  }
  return binding as RuntimeSmokeServiceBinding;
}

function classifyError(error: unknown): { code: string; permanent: boolean } {
  if (error instanceof CloudflareControlApiError) {
    if (error.status === 401 || error.status === 403) {
      return { code: 'control_workers_capability_rejected', permanent: true };
    }
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      return { code: 'control_worker_settings_request_rejected', permanent: true };
    }
    return { code: 'control_worker_settings_request_failed', permanent: false };
  }
  const code = error instanceof Error ? error.message : '';
  if (code === 'control_worker_smoke_service_binding_missing') {
    return { code, permanent: false };
  }
  if (
    code === 'control_worker_script_environment_mismatch' ||
    code === 'control_worker_active_deployment_ambiguous' ||
    code.startsWith('worker_settings_binding_') ||
    code.startsWith('worker_settings_payload_too_large')
  ) {
    return { code, permanent: true };
  }
  return { code: 'control_worker_binding_reconciliation_failed', permanent: false };
}

function parseRestoreSettings(serialized: string | null): CloudflareWorkerSettings {
  if (!serialized || new TextEncoder().encode(serialized).byteLength > 1024 * 1024) {
    throw new Error('control_worker_restore_settings_missing');
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('control_worker_restore_settings_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_worker_restore_settings_invalid');
  }
  return value as CloudflareWorkerSettings;
}

function assertSmokeResult(input: {
  result: Awaited<ReturnType<RuntimeSmokeServiceBinding['smokeTenantBinding']>>;
  target: WorkerBindingTarget;
  expectedVersionId: string;
}): boolean {
  if (input.result.bindingRef !== input.target.bindingRef) {
    throw new Error('control_worker_smoke_result_binding_ref_mismatch');
  }
  if (input.result.migrationGeneration !== input.target.migrationGeneration) {
    throw new Error('control_worker_smoke_result_generation_mismatch');
  }
  if (input.result.dataRole !== input.target.dataRole) {
    throw new Error('control_worker_smoke_result_data_role_mismatch');
  }
  if (input.result.residencyPartition !== input.target.residencyPartition) {
    throw new Error('control_worker_smoke_result_residency_mismatch');
  }
  if (!Number.isSafeInteger(input.result.checkedAt) || input.result.checkedAt < 1) {
    throw new Error('control_worker_smoke_result_timestamp_invalid');
  }
  return input.result.observedVersionId === input.expectedVersionId;
}

function smokeFailureCode(error: unknown, fallback: string): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const messageValue =
      current instanceof Error
        ? current.message
        : current && typeof current === 'object' && 'message' in current
          ? (current as { message?: unknown }).message
          : typeof current === 'string'
            ? current
            : undefined;
    const message = typeof messageValue === 'string' ? messageValue : '';
    const code = message.match(
      /(?:^|\b)((?:runtime_smoke|control_smoke|control_worker_smoke_result)_[a-z0-9_]+)(?:\b|$)/u
    )?.[1];
    if (code) return code;
    current =
      current && typeof current === 'object' && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return fallback;
}

export class WorkerBindingReconciler {
  constructor(
    private readonly repository: WorkerBindingStateRepository,
    private readonly inventory: DesiredWorkerInventory,
    private readonly api: WorkerSettingsApi,
    private readonly env: ControlEnv,
    private readonly now: () => number,
    private readonly providerMutationEnabled = true
  ) {}

  async reconcile(limit = 10): Promise<WorkerBindingReconcilerResult> {
    const startedAt = this.now();
    await this.repository.ensurePendingTargets(startedAt);
    const dueTargets = await this.repository.listDueTargets(
      this.providerMutationEnabled ? limit : 100,
      startedAt
    );
    const handedOffOperations = new Set<string>();
    if (!this.providerMutationEnabled) {
      for (const target of dueTargets) {
        if (target.state !== 'pending' || handedOffOperations.has(target.operationId)) continue;
        await this.inventory.markOperationAwaitingOperator(target.operationId, startedAt);
        handedOffOperations.add(target.operationId);
      }
    }
    const targets = dueTargets
      .filter((target) => !handedOffOperations.has(target.operationId))
      .slice(0, limit);
    const result: WorkerBindingReconcilerResult = {
      attempted: targets.length + handedOffOperations.size,
      succeeded: 0,
      deferred: 0,
      blocked: handedOffOperations.size,
    };
    for (const target of targets) {
      const outcome = await this.reconcileTarget(target);
      result[outcome] += 1;
    }
    return result;
  }

  private async reconcileTarget(
    target: WorkerBindingTarget
  ): Promise<'succeeded' | 'deferred' | 'blocked'> {
    const now = this.now();
    try {
      const desiredWorker = await this.inventory.getActiveDesiredWorker(
        target.environmentId,
        target.workerScriptName
      );
      if (!desiredWorker) {
        await this.repository.markBlocked(target, 'control_worker_not_in_desired_inventory', now);
        return 'blocked';
      }
      if (target.state === 'settings_patched' || target.state === 'smoke_verifying') {
        const expectedSourceVersionId =
          target.expectedSourceVersionId ?? target.patchResultVersionId;
        if (!expectedSourceVersionId) {
          await this.repository.markBlocked(target, 'control_worker_patch_result_missing', now);
          return 'blocked';
        }
        const lease = await this.repository.acquireDeploymentLease({
          target,
          expectedSourceVersionId,
          now,
          ttlSeconds: WORKER_DEPLOYMENT_LEASE_SECONDS,
        });
        if (!lease) {
          await this.repository.recordTransientError(
            target,
            'control_worker_deployment_lease_busy',
            now + RETRY_SECONDS,
            now
          );
          return 'deferred';
        }
        return await this.runSmokeSeries(target, lease, resolveSmokeService(this.env, target));
      }
      if (target.state === 'stabilizing') {
        const expectedSourceVersionId =
          target.expectedSourceVersionId ?? target.patchResultVersionId;
        if (!expectedSourceVersionId) {
          await this.repository.markBlocked(target, 'control_worker_patch_result_missing', now);
          return 'blocked';
        }
        const lease = await this.repository.acquireDeploymentLease({
          target,
          expectedSourceVersionId,
          now,
          ttlSeconds: WORKER_DEPLOYMENT_LEASE_SECONDS,
        });
        if (!lease) {
          await this.repository.recordTransientError(
            target,
            'control_worker_deployment_lease_busy',
            now + RETRY_SECONDS,
            now
          );
          return 'deferred';
        }
        return await this.finishStabilization(target, resolveSmokeService(this.env, target));
      }
      const deployments = await this.api.listWorkerDeployments(target.workerScriptName);
      const active = activeWorkerDeployment(deployments);
      const lease = await this.repository.acquireDeploymentLease({
        target,
        expectedSourceVersionId: target.expectedSourceVersionId ?? active.versionId,
        now,
        ttlSeconds: WORKER_DEPLOYMENT_LEASE_SECONDS,
      });
      if (!lease) {
        await this.repository.recordTransientError(
          target,
          'control_worker_deployment_lease_busy',
          now + RETRY_SECONDS,
          now
        );
        return 'deferred';
      }
      const currentDeployments = await this.api.listWorkerDeployments(target.workerScriptName);
      const currentActive = activeWorkerDeployment(currentDeployments);

      if (target.state === 'rollback_required') {
        return await this.rollback(target, lease, currentDeployments);
      }
      const smoke = resolveSmokeService(this.env, target);
      let patchedTarget = target;
      if (target.state === 'pending') {
        const patched = await this.ensurePatched(target, lease, currentDeployments, currentActive);
        if (!patched) return 'deferred';
        patchedTarget = patched;
      }
      return await this.runSmokeSeries(patchedTarget, lease, smoke);
    } catch (error) {
      const failure = classifyError(error);
      if (failure.permanent) {
        await this.repository.markBlocked(target, failure.code, now);
        return 'blocked';
      }
      await this.repository.recordTransientError(target, failure.code, now + RETRY_SECONDS, now);
      return 'deferred';
    }
  }

  private async ensurePatched(
    target: WorkerBindingTarget,
    lease: WorkerDeploymentLease,
    deploymentsBefore: CloudflareWorkerDeployment[],
    activeBefore: ReturnType<typeof activeWorkerDeployment>
  ): Promise<WorkerBindingTarget | null> {
    const result = await ensureWorkerBindingPatched({
      target,
      lease,
      deploymentsBefore,
      activeBefore,
      api: this.api,
      state: this.repository,
      now: this.now,
      retrySeconds: RETRY_SECONDS,
    });
    return result.state === 'patched' ? result.target : null;
  }

  private async runSmokeSeries(
    target: WorkerBindingTarget,
    lease: WorkerDeploymentLease,
    smoke: RuntimeSmokeServiceBinding
  ): Promise<'succeeded' | 'deferred'> {
    const expectedVersionId = target.patchResultVersionId;
    if (!expectedVersionId) throw new Error('control_worker_patch_result_missing');
    let attempt = target.smokeAttemptCount;
    let consecutive = target.consecutiveSmokeSuccesses;
    while (consecutive < 3) {
      attempt += 1;
      try {
        const token = await signControlRuntimeSmokeRequest({
          env: this.env,
          request: {
            environmentId: target.environmentId,
            operationId: target.operationId,
            attempt,
            targetWorker: target.workerScriptName,
            bindingRef: target.bindingRef,
            expectedMigrationGeneration: target.migrationGeneration,
            dataRole: target.dataRole,
            residencyPartition: target.residencyPartition,
          },
          now: this.now(),
        });
        const result = await smoke.smokeTenantBinding(token);
        const expectedVersionObserved = assertSmokeResult({ result, target, expectedVersionId });
        if (!expectedVersionObserved) {
          const deployments = await this.api.listWorkerDeployments(target.workerScriptName);
          const active = activeWorkerDeployment(deployments);
          if (active.versionId !== result.observedVersionId) {
            throw new Error('control_worker_smoke_result_version_mismatch');
          }
          await this.repository.adoptSupersedingSmokeDeployment({
            target,
            lease,
            versionId: active.versionId,
            deploymentId: active.deploymentId,
            now: this.now(),
          });
          return 'deferred';
        }
        consecutive += 1;
        await this.repository.recordSmokeProgress({
          target,
          successful: true,
          attempt,
          ...(consecutive === 3
            ? { stabilizationNotBefore: this.now() + STABILIZATION_SECONDS }
            : {}),
          now: this.now(),
        });
      } catch (error) {
        const errorCode = smokeFailureCode(error, 'control_worker_smoke_failed');
        await this.repository.recordSmokeProgress({
          target,
          successful: false,
          attempt,
          errorCode,
          now: this.now(),
        });
        await this.repository.recordTransientError(
          target,
          errorCode,
          this.now() + RETRY_SECONDS,
          this.now()
        );
        return 'deferred';
      }
    }
    return 'deferred';
  }

  private async finishStabilization(
    target: WorkerBindingTarget,
    smoke: RuntimeSmokeServiceBinding
  ): Promise<'succeeded' | 'deferred' | 'blocked'> {
    const now = this.now();
    if (!target.patchResultVersionId || !target.patchResultDeploymentId) {
      await this.repository.markBlocked(target, 'control_worker_patch_result_missing', now);
      return 'blocked';
    }
    const attempt = target.smokeAttemptCount + 1;
    try {
      const token = await signControlRuntimeSmokeRequest({
        env: this.env,
        request: {
          environmentId: target.environmentId,
          operationId: target.operationId,
          attempt,
          targetWorker: target.workerScriptName,
          bindingRef: target.bindingRef,
          expectedMigrationGeneration: target.migrationGeneration,
          dataRole: target.dataRole,
          residencyPartition: target.residencyPartition,
        },
        now,
      });
      const result = await smoke.smokeTenantBinding(token);
      if (!assertSmokeResult({ result, target, expectedVersionId: target.patchResultVersionId })) {
        throw new Error('control_worker_smoke_result_version_mismatch');
      }
      await this.repository.recordSmokeProgress({
        target,
        successful: true,
        attempt,
        completeStabilizationCheck: true,
        now,
      });
      await this.repository.markSucceeded(target, now);
      await this.repository.completeOperationIfReady(target.operationId, now);
      return 'succeeded';
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('control_worker_smoke_result_')) {
        await this.repository.markBlocked(
          target,
          error.message.replace(
            'control_worker_smoke_result_',
            'control_worker_stabilization_smoke_result_'
          ),
          now
        );
        return 'blocked';
      }
      const errorCode = smokeFailureCode(error, 'control_worker_stabilization_smoke_failed');
      await this.repository.recordSmokeProgress({
        target,
        successful: false,
        attempt,
        errorCode,
        now,
      });
      await this.repository.recordTransientError(target, errorCode, now + RETRY_SECONDS, now);
      return 'deferred';
    }
  }

  private async rollback(
    target: WorkerBindingTarget,
    lease: WorkerDeploymentLease,
    deployments: CloudflareWorkerDeployment[]
  ): Promise<'deferred' | 'blocked'> {
    const now = this.now();
    const active = activeWorkerDeployment(deployments);
    if (
      !target.patchResultVersionId ||
      !target.patchResultDeploymentId ||
      active.versionId !== target.patchResultVersionId ||
      active.deploymentId !== target.patchResultDeploymentId
    ) {
      await this.repository.markBlocked(target, 'control_worker_newer_deployment_detected', now);
      return 'blocked';
    }
    if (!(await this.repository.leaseIsCurrent(lease, now))) return 'deferred';

    const restoreSettings = parseRestoreSettings(target.previousRestoreSettingsJson);
    try {
      if (!(await this.repository.leaseIsCurrent(lease, this.now()))) return 'deferred';
      await this.api.patchWorkerSettings(target.workerScriptName, restoreSettings);
      const reflected = await this.api.getWorkerSettings(target.workerScriptName);
      if (
        verifyWorkerSettingsRestoreIntent({
          restoreSettings,
          after: reflected,
          desiredBindings: [],
        }).length > 0
      ) {
        throw new Error('control_worker_restore_reflection_mismatch');
      }
    } catch {
      await this.repository.markBlocked(target, 'control_worker_rollback_failed', now);
      return 'blocked';
    }
    await this.repository.markRolledBack(target, now);
    await this.repository.releaseDeploymentLease(lease);
    return 'blocked';
  }
}
