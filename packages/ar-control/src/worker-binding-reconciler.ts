import {
  CloudflareControlApiError,
  activeWorkerDeployment,
  ensureWorkerBindingsPatched,
  ensureWorkerBindingPatched,
  verifyWorkerSettingsRestoreIntent,
  type CloudflareWorkerBinding,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerSettings,
  type RuntimeSmokeBatchResult,
  type RuntimeSmokeResult,
} from '@authrim/ar-lib-core/control-plane';
import type { DesiredWorkerInventoryRow } from './repository';
import type { ControlEnv, RuntimeSmokeServiceBinding } from './types';
import { signControlRuntimeSmokeRequest } from './runtime-smoke-signer';
import {
  D1WorkerBindingRepository,
  type WorkerBindingTarget,
  type WorkerDeploymentLease,
} from './worker-binding-repository';
import {
  consumeServiceBindingInvocation,
  type ServiceBindingInvocationBudget,
} from './service-binding-invocation-budget';

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
  | 'listDueTargetsForWorkers'
  | 'acquireReconcilerLease'
  | 'releaseReconcilerLease'
  | 'acquireDeploymentLease'
  | 'leaseIsCurrent'
  | 'releaseDeploymentLease'
  | 'recordAlreadySatisfied'
  | 'recordPatchStarted'
  | 'rearmPatchIntent'
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
const RECONCILER_LEASE_SECONDS = 5 * 60;
const MAX_PARALLEL_WORKER_RECONCILIATIONS = 5;
const MAX_SMOKE_TOKENS_PER_INVOCATION = 31;
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
    code === 'control_worker_active_deployment_missing' ||
    code === 'control_worker_deployment_lease_lost' ||
    code === 'control_worker_source_version_changed'
  ) {
    return { code, permanent: false };
  }
  if (
    code === 'control_worker_script_environment_mismatch' ||
    code === 'control_worker_active_deployment_ambiguous' ||
    code === 'control_worker_binding_batch_conflict' ||
    code.startsWith('worker_settings_binding_') ||
    code.startsWith('worker_settings_payload_too_large')
  ) {
    return { code, permanent: true };
  }
  return { code: 'control_worker_binding_reconciliation_failed', permanent: false };
}

function retryAt(error: unknown, now: number): number {
  const providerDelayValue =
    error instanceof CloudflareControlApiError
      ? (error as CloudflareControlApiError & { retryAfterSeconds?: unknown }).retryAfterSeconds
      : null;
  const providerDelay =
    typeof providerDelayValue === 'number' && Number.isFinite(providerDelayValue)
      ? providerDelayValue
      : null;
  return now + Math.max(RETRY_SECONDS, providerDelay ?? 0);
}

function desiredD1Bindings(targets: readonly WorkerBindingTarget[]): CloudflareWorkerBinding[] {
  const byName = new Map<string, string>();
  for (const target of targets) {
    const existing = byName.get(target.bindingRef);
    if (existing !== undefined && existing !== target.databaseId) {
      throw new Error('control_worker_binding_batch_conflict');
    }
    byName.set(target.bindingRef, target.databaseId);
  }
  return [...byName].map(([name, database_id]) => ({ name, type: 'd1', database_id }));
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

function isSmokeCheckpointConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'control_worker_binding_smoke_state_stale' ||
      error.message === 'control_worker_binding_smoke_lease_stale')
  );
}

async function invokeSmokeBatch(
  smoke: RuntimeSmokeServiceBinding,
  tokens: string[],
  budget?: ServiceBindingInvocationBudget
): Promise<RuntimeSmokeBatchResult[]> {
  const normalize = (value: unknown): RuntimeSmokeBatchResult => {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'ok' in value) {
      const item = value as RuntimeSmokeBatchResult;
      if (item.ok === true && item.result) return item;
      if (item.ok === false && typeof item.errorCode === 'string') return item;
      throw new Error('control_worker_smoke_result_batch_item_invalid');
    }
    return { ok: true, result: value as RuntimeSmokeResult };
  };
  if (smoke.smokeTenantBindings) {
    if (!consumeServiceBindingInvocation(budget)) {
      throw new Error('control_service_binding_invocation_budget_exhausted');
    }
    try {
      const results = await smoke.smokeTenantBindings(tokens);
      if (Array.isArray(results) && results.length === tokens.length) {
        return results.map(normalize);
      }
    } catch {
      // During a rolling update, an older RPC receiver may not expose the batch method yet.
      // Individual smoke is read-only and applies the same signed-token and result checks.
    }
  }
  if (!consumeServiceBindingInvocation(budget, tokens.length)) {
    throw new Error('control_service_binding_invocation_budget_exhausted');
  }
  return Promise.all(
    tokens.map(async (token): Promise<RuntimeSmokeBatchResult> => {
      try {
        return { ok: true, result: await smoke.smokeTenantBinding(token) };
      } catch (error) {
        return { ok: false, errorCode: smokeFailureCode(error, 'control_worker_smoke_failed') };
      }
    })
  );
}

export class WorkerBindingReconciler {
  constructor(
    private readonly repository: WorkerBindingStateRepository,
    private readonly inventory: DesiredWorkerInventory,
    private readonly api: WorkerSettingsApi,
    private readonly env: ControlEnv,
    private readonly now: () => number,
    private readonly providerMutationEnabled = true,
    private readonly serviceBindingBudget?: ServiceBindingInvocationBudget
  ) {}

  async reconcile(limit = 10): Promise<WorkerBindingReconcilerResult> {
    if (!Number.isFinite(limit)) throw new Error('invalid_worker_binding_reconciliation_limit');
    const workerLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    const startedAt = this.now();
    await this.repository.ensurePendingTargets(startedAt);
    // Automatic reconciliation selects Workers first, then loads every due target for those
    // Workers. This prevents a global row limit from splitting one Worker across multiple PATCHes.
    // Operator handoff remains row-bounded because it does not mutate Worker settings.
    const dueTargets = this.providerMutationEnabled
      ? await this.repository.listDueTargetsForWorkers(workerLimit, startedAt)
      : await this.repository.listDueTargets(100, startedAt);
    const handedOffOperations = new Set<string>();
    if (!this.providerMutationEnabled) {
      for (const target of dueTargets) {
        if (target.state !== 'pending' || handedOffOperations.has(target.operationId)) continue;
        await this.inventory.markOperationAwaitingOperator(target.operationId, startedAt);
        handedOffOperations.add(target.operationId);
      }
    }
    const candidateTargets = dueTargets.filter(
      (target) => !handedOffOperations.has(target.operationId)
    );
    const candidateGroups = new Map<string, WorkerBindingTarget[]>();
    for (const target of candidateTargets) {
      const key = `${target.environmentId}\u0000${target.workerScriptName}`;
      const group = candidateGroups.get(key) ?? [];
      group.push(target);
      candidateGroups.set(key, group);
    }
    const targets = [...candidateGroups.values()]
      .slice(0, this.providerMutationEnabled ? candidateGroups.size : workerLimit)
      .flat();
    const result: WorkerBindingReconcilerResult = {
      attempted: targets.length + handedOffOperations.size,
      succeeded: 0,
      deferred: 0,
      blocked: handedOffOperations.size,
    };
    const ownerId = crypto.randomUUID();
    const environmentIds = [...new Set(targets.map((target) => target.environmentId))];
    const acquiredEnvironmentIds = new Set<string>();
    for (const environmentId of environmentIds) {
      if (
        await this.repository.acquireReconcilerLease({
          environmentId,
          ownerId,
          now: startedAt,
          ttlSeconds: RECONCILER_LEASE_SECONDS,
        })
      ) {
        acquiredEnvironmentIds.add(environmentId);
      }
    }
    const leasedTargets = targets.filter((target) =>
      acquiredEnvironmentIds.has(target.environmentId)
    );
    result.deferred += targets.length - leasedTargets.length;
    const targetsByWorker = new Map<string, WorkerBindingTarget[]>();
    for (const target of leasedTargets) {
      const key = `${target.environmentId}\u0000${target.workerScriptName}`;
      const workerTargets = targetsByWorker.get(key) ?? [];
      workerTargets.push(target);
      targetsByWorker.set(key, workerTargets);
    }
    try {
      const workerGroups = [...targetsByWorker.values()];
      for (
        let offset = 0;
        offset < workerGroups.length;
        offset += MAX_PARALLEL_WORKER_RECONCILIATIONS
      ) {
        const outcomes = await Promise.all(
          workerGroups
            .slice(offset, offset + MAX_PARALLEL_WORKER_RECONCILIATIONS)
            .map(async (workerTargets) => {
              return this.reconcileWorkerTargets(workerTargets);
            })
        );
        for (const outcome of outcomes.flat()) result[outcome] += 1;
      }
    } finally {
      await Promise.all(
        [...acquiredEnvironmentIds].map((environmentId) =>
          this.repository.releaseReconcilerLease({ environmentId, ownerId })
        )
      );
    }
    return result;
  }

  private async reconcileWorkerTargets(
    targets: WorkerBindingTarget[]
  ): Promise<Array<'succeeded' | 'deferred' | 'blocked'>> {
    const outcomes: Array<'succeeded' | 'deferred' | 'blocked'> = [];
    const pendingTargets = targets.filter((target) => target.state === 'pending');
    let batchedBindings: CloudflareWorkerBinding[];
    try {
      batchedBindings = desiredD1Bindings(pendingTargets);
    } catch (error) {
      const failure = classifyError(error);
      for (const target of pendingTargets) {
        await this.repository.markBlocked(target, failure.code, this.now());
        outcomes.push('blocked');
      }
      const remainingTargets = targets.filter((target) => target.state !== 'pending');
      if (remainingTargets.length > 0) {
        outcomes.push(...(await this.reconcileWorkerTargets(remainingTargets)));
      }
      return outcomes;
    }
    const initialSmokeTargets: WorkerBindingTarget[] = [];
    const stabilizationTargets: WorkerBindingTarget[] = [];
    let batchOffered = false;
    for (const target of targets) {
      const useBatch = target.state === 'pending' && !batchOffered;
      if (useBatch) batchOffered = true;
      const prepared = await this.prepareTarget(target, useBatch ? batchedBindings : undefined);
      if (prepared.state === 'outcome') {
        outcomes.push(prepared.outcome);
      } else if (prepared.phase === 'stabilizing') {
        stabilizationTargets.push(prepared.target);
      } else {
        initialSmokeTargets.push(prepared.target);
      }
    }
    if (initialSmokeTargets.length > 0) {
      outcomes.push(...(await this.runWorkerSmokeBatches(initialSmokeTargets)));
    }
    if (stabilizationTargets.length > 0) {
      outcomes.push(...(await this.finishWorkerStabilizationBatches(stabilizationTargets)));
    }
    return outcomes;
  }

  private async prepareTarget(
    target: WorkerBindingTarget,
    desiredBindings?: CloudflareWorkerBinding[]
  ): Promise<
    | { state: 'ready'; phase: 'initial' | 'stabilizing'; target: WorkerBindingTarget }
    | { state: 'outcome'; outcome: 'deferred' | 'blocked' }
  > {
    const now = this.now();
    try {
      const desiredWorker = await this.inventory.getActiveDesiredWorker(
        target.environmentId,
        target.workerScriptName
      );
      if (!desiredWorker) {
        await this.repository.markBlocked(target, 'control_worker_not_in_desired_inventory', now);
        return { state: 'outcome', outcome: 'blocked' };
      }
      if (target.state === 'settings_patched' || target.state === 'smoke_verifying') {
        if (!target.expectedSourceVersionId && !target.patchResultVersionId) {
          await this.repository.markBlocked(target, 'control_worker_patch_result_missing', now);
          return { state: 'outcome', outcome: 'blocked' };
        }
        const lease = await this.repository.acquireDeploymentLease({
          target,
          expectedSourceVersionId: target.expectedSourceVersionId ?? target.patchResultVersionId!,
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
          return { state: 'outcome', outcome: 'deferred' };
        }
        return { state: 'ready', phase: 'initial', target };
      }
      if (target.state === 'stabilizing') {
        if (!target.expectedSourceVersionId && !target.patchResultVersionId) {
          await this.repository.markBlocked(target, 'control_worker_patch_result_missing', now);
          return { state: 'outcome', outcome: 'blocked' };
        }
        const lease = await this.repository.acquireDeploymentLease({
          target,
          expectedSourceVersionId: target.expectedSourceVersionId ?? target.patchResultVersionId!,
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
          return { state: 'outcome', outcome: 'deferred' };
        }
        return { state: 'ready', phase: 'stabilizing', target };
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
        return { state: 'outcome', outcome: 'deferred' };
      }
      const currentDeployments = await this.api.listWorkerDeployments(target.workerScriptName);
      const currentActive = activeWorkerDeployment(currentDeployments);

      if (target.state === 'rollback_required') {
        return {
          state: 'outcome',
          outcome: await this.rollback(target, lease, currentDeployments),
        };
      }
      if (target.state === 'pending') {
        const patchResult = await this.ensurePatched(
          target,
          lease,
          currentDeployments,
          currentActive,
          desiredBindings
        );
        if (patchResult.state !== 'patched') {
          if (patchResult.state === 'rollback_required') {
            await this.repository.releaseDeploymentLease(lease);
          }
          return {
            state: 'outcome',
            outcome: patchResult.state === 'blocked' ? 'blocked' : 'deferred',
          };
        }
        // Keep the deployment lease through smoke and stabilization. The repository extends it
        // after each verified observation and releases it only after the final stable result.
        return { state: 'ready', phase: 'initial', target: patchResult.target };
      }
      return { state: 'ready', phase: 'initial', target };
    } catch (error) {
      const failure = classifyError(error);
      if (failure.permanent) {
        await this.repository.markBlocked(target, failure.code, now);
        return { state: 'outcome', outcome: 'blocked' };
      }
      await this.repository.recordTransientError(target, failure.code, retryAt(error, now), now);
      return { state: 'outcome', outcome: 'deferred' };
    }
  }

  private async ensurePatched(
    target: WorkerBindingTarget,
    lease: WorkerDeploymentLease,
    deploymentsBefore: CloudflareWorkerDeployment[],
    activeBefore: ReturnType<typeof activeWorkerDeployment>,
    desiredBindings?: CloudflareWorkerBinding[]
  ) {
    const common = {
      target,
      lease,
      deploymentsBefore,
      activeBefore,
      api: this.api,
      state: this.repository,
      now: this.now,
      retrySeconds: RETRY_SECONDS,
    };
    const result = desiredBindings
      ? await ensureWorkerBindingsPatched({ ...common, desiredBindings })
      : await ensureWorkerBindingPatched(common);
    return result;
  }

  private async recordInitialSmokeResults(
    target: WorkerBindingTarget,
    attempts: number[],
    results: RuntimeSmokeBatchResult[]
  ): Promise<'deferred'> {
    const expectedVersionId = target.patchResultVersionId;
    if (!expectedVersionId) throw new Error('control_worker_patch_result_missing');
    let attempt = target.smokeAttemptCount;
    let consecutive = target.consecutiveSmokeSuccesses;
    try {
      for (let index = 0; index < results.length; index += 1) {
        const item = results[index];
        attempt = attempts[index] ?? attempt + 1;
        if (!item) throw new Error('control_worker_smoke_result_batch_length_mismatch');
        if (!item.ok) {
          const errorCode = smokeFailureCode(item.errorCode, 'control_worker_smoke_failed');
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
            retryAt(item, this.now()),
            this.now()
          );
          return 'deferred';
        }
        if (!assertSmokeResult({ result: item.result, target, expectedVersionId })) {
          const deployments = await this.api.listWorkerDeployments(target.workerScriptName);
          const active = activeWorkerDeployment(deployments);
          if (active.versionId !== item.result.observedVersionId) {
            throw new Error('control_worker_smoke_result_version_mismatch');
          }
          const lease = await this.repository.acquireDeploymentLease({
            target,
            expectedSourceVersionId: active.versionId,
            now: this.now(),
            ttlSeconds: WORKER_DEPLOYMENT_LEASE_SECONDS,
          });
          if (!lease) {
            throw new Error('control_worker_deployment_lease_lost');
          }
          try {
            await this.repository.adoptSupersedingSmokeDeployment({
              target,
              lease,
              versionId: active.versionId,
              deploymentId: active.deploymentId,
              now: this.now(),
            });
          } finally {
            await this.repository.releaseDeploymentLease(lease);
          }
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
      }
      return 'deferred';
    } catch (error) {
      // Another bounded reconciler may have committed the same or a newer checkpoint just before
      // this write. Do not overwrite that durable result with a synthetic smoke failure.
      if (isSmokeCheckpointConflict(error)) return 'deferred';
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
        retryAt(error, this.now()),
        this.now()
      );
      return 'deferred';
    }
  }

  private async runWorkerSmokeBatches(
    targets: WorkerBindingTarget[]
  ): Promise<Array<'deferred' | 'blocked'>> {
    const outcomes: Array<'deferred' | 'blocked'> = [];
    let smoke: RuntimeSmokeServiceBinding;
    try {
      smoke = resolveSmokeService(this.env, targets[0]);
    } catch (error) {
      const now = this.now();
      const failure = classifyError(error);
      if (failure.permanent) {
        await Promise.all(
          targets.map((target) => this.repository.markBlocked(target, failure.code, now))
        );
        return targets.map(() => 'blocked' as const);
      }
      await Promise.all(
        targets.map((target) =>
          this.repository.recordTransientError(target, failure.code, retryAt(error, now), now)
        )
      );
      return targets.map(() => 'deferred' as const);
    }
    for (let offset = 0; offset < targets.length; ) {
      const chunk: Array<{ target: WorkerBindingTarget; attempts: number[] }> = [];
      let tokenCount = 0;
      while (offset < targets.length) {
        const target = targets[offset];
        const attempts = Array.from(
          { length: Math.max(0, 3 - target.consecutiveSmokeSuccesses) },
          (_unused, index) => target.smokeAttemptCount + index + 1
        );
        if (chunk.length > 0 && tokenCount + attempts.length > MAX_SMOKE_TOKENS_PER_INVOCATION) {
          break;
        }
        chunk.push({ target, attempts });
        tokenCount += attempts.length;
        offset += 1;
      }
      const tokens = await Promise.all(
        chunk.flatMap(({ target, attempts }) =>
          attempts.map((attempt) =>
            signControlRuntimeSmokeRequest({
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
            })
          )
        )
      );
      let results: RuntimeSmokeBatchResult[];
      try {
        results = await invokeSmokeBatch(smoke, tokens, this.serviceBindingBudget);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'control_service_binding_invocation_budget_exhausted'
        ) {
          outcomes.push(...chunk.map(() => 'deferred' as const));
          outcomes.push(...targets.slice(offset).map(() => 'deferred' as const));
          break;
        }
        results = tokens.map(() => ({
          ok: false as const,
          errorCode: smokeFailureCode(error, 'control_worker_smoke_failed'),
        }));
      }
      let resultOffset = 0;
      for (const item of chunk) {
        const targetResults = results.slice(resultOffset, resultOffset + item.attempts.length);
        resultOffset += item.attempts.length;
        outcomes.push(
          await this.recordInitialSmokeResults(item.target, item.attempts, targetResults)
        );
      }
    }
    return outcomes;
  }

  private async recordStabilizationResult(
    target: WorkerBindingTarget,
    item: RuntimeSmokeBatchResult
  ): Promise<'succeeded' | 'deferred' | 'blocked'> {
    const now = this.now();
    if (!target.patchResultVersionId || !target.patchResultDeploymentId) {
      await this.repository.markBlocked(target, 'control_worker_patch_result_missing', now);
      return 'blocked';
    }
    const attempt = target.smokeAttemptCount + 1;
    try {
      if (!item.ok) throw new Error(item.errorCode);
      if (
        !assertSmokeResult({
          result: item.result,
          target,
          expectedVersionId: target.patchResultVersionId,
        })
      ) {
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
      if (isSmokeCheckpointConflict(error)) return 'deferred';
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
      await this.repository.recordTransientError(target, errorCode, retryAt(error, now), now);
      return 'deferred';
    }
  }

  private async finishWorkerStabilizationBatches(
    targets: WorkerBindingTarget[]
  ): Promise<Array<'succeeded' | 'deferred' | 'blocked'>> {
    const outcomes: Array<'succeeded' | 'deferred' | 'blocked'> = [];
    let smoke: RuntimeSmokeServiceBinding;
    try {
      smoke = resolveSmokeService(this.env, targets[0]);
    } catch (error) {
      const now = this.now();
      const failure = classifyError(error);
      if (failure.permanent) {
        await Promise.all(
          targets.map((target) => this.repository.markBlocked(target, failure.code, now))
        );
        return targets.map(() => 'blocked' as const);
      }
      await Promise.all(
        targets.map((target) =>
          this.repository.recordTransientError(target, failure.code, retryAt(error, now), now)
        )
      );
      return targets.map(() => 'deferred' as const);
    }
    for (let offset = 0; offset < targets.length; offset += MAX_SMOKE_TOKENS_PER_INVOCATION) {
      const chunk = targets.slice(offset, offset + MAX_SMOKE_TOKENS_PER_INVOCATION);
      const tokens = await Promise.all(
        chunk.map((target) =>
          signControlRuntimeSmokeRequest({
            env: this.env,
            request: {
              environmentId: target.environmentId,
              operationId: target.operationId,
              attempt: target.smokeAttemptCount + 1,
              targetWorker: target.workerScriptName,
              bindingRef: target.bindingRef,
              expectedMigrationGeneration: target.migrationGeneration,
              dataRole: target.dataRole,
              residencyPartition: target.residencyPartition,
            },
            now: this.now(),
          })
        )
      );
      let results: RuntimeSmokeBatchResult[];
      try {
        results = await invokeSmokeBatch(smoke, tokens, this.serviceBindingBudget);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'control_service_binding_invocation_budget_exhausted'
        ) {
          outcomes.push(...chunk.map(() => 'deferred' as const));
          outcomes.push(...targets.slice(offset + chunk.length).map(() => 'deferred' as const));
          break;
        }
        results = tokens.map(() => ({
          ok: false as const,
          errorCode: smokeFailureCode(error, 'control_worker_stabilization_smoke_failed'),
        }));
      }
      for (let index = 0; index < chunk.length; index += 1) {
        const target = chunk[index];
        const item = results[index];
        if (!target || !item) {
          if (target) {
            await this.repository.markBlocked(
              target,
              'control_worker_stabilization_smoke_result_batch_length_mismatch',
              this.now()
            );
            outcomes.push('blocked');
          }
          continue;
        }
        outcomes.push(await this.recordStabilizationResult(target, item));
      }
    }
    return outcomes;
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
