import type { CloudflareWorkerDeployment } from './cloudflare-control-api-client.js';
import {
  buildPreservingWorkerSettingsPatch,
  verifyWorkerSettingsPreserved,
  verifyWorkerSettingsRestoreIntent,
  type CloudflareWorkerBinding,
  type CloudflareWorkerSettings,
} from './cloudflare-worker-settings.js';

export interface WorkerSettingsPatchTarget {
  operationId: string;
  workerScriptName: string;
  previousRestoreSettingsJson: string | null;
}

export interface WorkerBindingPatchTarget extends WorkerSettingsPatchTarget {
  bindingRef: string;
  databaseId: string;
}

export const CONTROL_ENSURE_WORKER_BINDING_TARGETS_SQL = `WITH shard_inventory AS (
  SELECT d1_desired_resource_id, shard_id, binding_ref, data_role,
         residency_partition, generation, status
    FROM control_tenant_shards
  UNION ALL
  SELECT d1_desired_resource_id, lookup_shard_id, binding_ref, 'lookup',
         residency_partition, 1, status
    FROM control_lookup_physical_shards
)
INSERT OR IGNORE INTO control_worker_binding_reconciliations (
  operation_id, environment_id, worker_script_name, shard_id, binding_ref,
  data_role, residency_partition, migration_generation, provider_database_id,
  state, created_at, updated_at
)
SELECT o.operation_id, o.environment_id, i.worker_script_name, s.shard_id,
       s.binding_ref, s.data_role, s.residency_partition, s.generation,
       m.provider_database_id, 'pending', ?, ?
  FROM control_operations o
  JOIN control_tenant_database_migration_state m ON m.operation_id = o.operation_id
  JOIN shard_inventory s ON s.d1_desired_resource_id = m.desired_resource_id
  JOIN control_worker_required_data_roles r
    ON r.environment_id = o.environment_id AND r.data_role = s.data_role
  JOIN control_desired_worker_inventory i
    ON i.environment_id = r.environment_id
   AND i.worker_script_name = r.worker_script_name
   AND i.status = 'active'
 WHERE o.operation_kind = 'provision_shard'
   AND (
     o.status IN ('waiting_retry', 'running') OR
     (o.status = 'blocked' AND o.last_error_code = 'operator_action_required')
   )
   AND m.state = 'ready'
   AND m.provider_database_id IS NOT NULL
   AND s.status = 'ready'`;

export interface WorkerBindingPatchLease {
  expectedSourceVersionId: string;
  mutationStarted: boolean;
  mutationStartedAt?: number | null;
  previousDeploymentId: string | null;
}

export interface ActiveWorkerDeployment {
  deploymentId: string;
  versionId: string;
  createdAt: number;
}

export interface WorkerBindingSettingsApi {
  getWorkerSettings(scriptName: string): Promise<CloudflareWorkerSettings>;
  patchWorkerSettings(
    scriptName: string,
    settings: CloudflareWorkerSettings
  ): Promise<CloudflareWorkerSettings>;
  listWorkerDeployments(scriptName: string): Promise<CloudflareWorkerDeployment[]>;
}

export interface WorkerBindingPatchState<TTarget, TLease> {
  leaseIsCurrent(lease: TLease, now: number): Promise<boolean>;
  recordAlreadySatisfied(input: {
    target: TTarget;
    lease: TLease;
    versionId: string;
    deploymentId: string;
    settingsJson: string;
    now: number;
  }): Promise<void>;
  recordPatchStarted(input: {
    target: TTarget;
    lease: TLease;
    previousDeploymentId: string;
    restoreSettingsJson: string;
    now: number;
  }): Promise<void>;
  rearmPatchIntent?(input: { target: TTarget; lease: TLease; now: number }): Promise<boolean>;
  recordPatchResult(input: {
    target: TTarget;
    lease: TLease;
    versionId: string;
    deploymentId: string;
    now: number;
  }): Promise<void>;
  recordTransientError(
    target: TTarget,
    errorCode: string,
    nextAttemptAt: number,
    now: number
  ): Promise<void>;
  markRollbackRequired(target: TTarget, errorCode: string, now: number): Promise<void>;
  markBlocked(target: TTarget, errorCode: string, now: number): Promise<void>;
}

export type WorkerBindingPatchResult<TTarget> =
  | { state: 'patched'; target: TTarget }
  | { state: 'deferred' | 'rollback_required' | 'blocked'; target: null };

const PATCH_RESPONSE_PROPAGATION_GRACE_SECONDS = 60;

export function activeWorkerDeployment(
  deployments: readonly CloudflareWorkerDeployment[]
): ActiveWorkerDeployment {
  const candidates = deployments
    .map((deployment) => {
      const versions = Array.isArray(deployment.versions) ? deployment.versions : [];
      const version = versions.length === 1 && versions[0]?.percentage === 100 ? versions[0] : null;
      const createdAt = Date.parse(deployment.created_on);
      if (!deployment.id || !version?.version_id || !Number.isFinite(createdAt)) return null;
      return {
        deploymentId: deployment.id,
        versionId: version.version_id,
        createdAt,
      };
    })
    .filter((candidate): candidate is ActiveWorkerDeployment => candidate !== null)
    .sort((left, right) => right.createdAt - left.createdAt);
  const latest = candidates[0];
  if (!latest) throw new Error('control_worker_active_deployment_missing');
  if (candidates.length > 1 && candidates[0]?.createdAt === candidates[1]?.createdAt) {
    throw new Error('control_worker_active_deployment_ambiguous');
  }
  return latest;
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

export async function ensureWorkerBindingsPatched<
  TTarget extends WorkerSettingsPatchTarget,
  TLease extends WorkerBindingPatchLease,
>(input: {
  target: TTarget;
  lease: TLease;
  desiredBindings: CloudflareWorkerBinding[];
  deploymentsBefore: CloudflareWorkerDeployment[];
  activeBefore: ActiveWorkerDeployment;
  api: WorkerBindingSettingsApi;
  state: WorkerBindingPatchState<TTarget, TLease>;
  now: () => number;
  retrySeconds?: number;
}): Promise<WorkerBindingPatchResult<TTarget>> {
  const now = input.now();
  const retrySeconds = input.retrySeconds ?? 15;
  if (!(await input.state.leaseIsCurrent(input.lease, now))) {
    throw new Error('control_worker_deployment_lease_lost');
  }
  const currentSettings = await input.api.getWorkerSettings(input.target.workerScriptName);
  const desiredBindings = input.desiredBindings;
  const desiredBindingIssues = verifyWorkerSettingsPreserved({
    before: currentSettings,
    after: currentSettings,
    desiredBindings,
  });
  if (desiredBindingIssues.length === 0 && !input.lease.mutationStarted) {
    const reflectedActive = activeWorkerDeployment(
      await input.api.listWorkerDeployments(input.target.workerScriptName)
    );
    if (
      reflectedActive.deploymentId !== input.activeBefore.deploymentId ||
      reflectedActive.versionId !== input.lease.expectedSourceVersionId
    ) {
      throw new Error('control_worker_source_version_changed');
    }
    await input.state.recordAlreadySatisfied({
      target: input.target,
      lease: input.lease,
      versionId: reflectedActive.versionId,
      deploymentId: reflectedActive.deploymentId,
      settingsJson: JSON.stringify(currentSettings),
      now,
    });
    return {
      state: 'patched',
      target: {
        ...input.target,
        state: 'settings_patched',
        patchResultVersionId: reflectedActive.versionId,
        patchResultDeploymentId: reflectedActive.deploymentId,
      },
    };
  }

  if (input.lease.mutationStarted) {
    if (input.activeBefore.versionId === input.lease.expectedSourceVersionId) {
      if (
        desiredBindingIssues.length > 0 &&
        input.lease.mutationStartedAt !== null &&
        input.lease.mutationStartedAt !== undefined &&
        input.state.rearmPatchIntent !== undefined &&
        now - input.lease.mutationStartedAt >= PATCH_RESPONSE_PROPAGATION_GRACE_SECONDS
      ) {
        const rearmed = await input.state.rearmPatchIntent({
          target: input.target,
          lease: input.lease,
          now,
        });
        if (!rearmed) throw new Error('control_worker_deployment_lease_lost');
      } else {
        const propagationDeadline =
          input.lease.mutationStartedAt === null || input.lease.mutationStartedAt === undefined
            ? now + retrySeconds
            : input.lease.mutationStartedAt + PATCH_RESPONSE_PROPAGATION_GRACE_SECONDS;
        await input.state.recordTransientError(
          input.target,
          'control_worker_patch_propagating',
          Math.max(now + retrySeconds, propagationDeadline),
          now
        );
      }
      return { state: 'deferred', target: null };
    }
    const previousIndex = input.deploymentsBefore
      .slice()
      .sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on))
      .findIndex((deployment) => deployment.id === input.lease.previousDeploymentId);
    if (previousIndex !== 1) {
      await input.state.markBlocked(
        input.target,
        'control_worker_concurrent_deployment_detected',
        now
      );
      return { state: 'blocked', target: null };
    }
    await input.state.recordPatchResult({
      target: input.target,
      lease: input.lease,
      versionId: input.activeBefore.versionId,
      deploymentId: input.activeBefore.deploymentId,
      now,
    });
    const issues = verifyWorkerSettingsRestoreIntent({
      restoreSettings: parseRestoreSettings(input.target.previousRestoreSettingsJson),
      after: currentSettings,
      desiredBindings,
    });
    if (issues.length > 0) {
      await input.state.markRollbackRequired(
        input.target,
        'control_worker_settings_preservation_failed',
        now
      );
      return { state: 'rollback_required', target: null };
    }
    return {
      state: 'patched',
      target: {
        ...input.target,
        state: 'settings_patched',
        patchResultVersionId: input.activeBefore.versionId,
        patchResultDeploymentId: input.activeBefore.deploymentId,
      },
    };
  }

  if (input.activeBefore.versionId !== input.lease.expectedSourceVersionId) {
    throw new Error('control_worker_source_version_changed');
  }
  const restoreSettings = buildPreservingWorkerSettingsPatch({
    currentSettings,
    sourceVersionId: input.lease.expectedSourceVersionId,
    desiredBindings: [],
  });
  await input.state.recordPatchStarted({
    target: input.target,
    lease: input.lease,
    previousDeploymentId: input.activeBefore.deploymentId,
    restoreSettingsJson: JSON.stringify(restoreSettings),
    now,
  });
  if (!(await input.state.leaseIsCurrent(input.lease, input.now()))) {
    throw new Error('control_worker_deployment_lease_lost');
  }
  const patch = buildPreservingWorkerSettingsPatch({
    currentSettings,
    sourceVersionId: input.lease.expectedSourceVersionId,
    desiredBindings,
  });
  const activeImmediatelyBeforePatch = activeWorkerDeployment(
    await input.api.listWorkerDeployments(input.target.workerScriptName)
  );
  if (
    activeImmediatelyBeforePatch.deploymentId !== input.activeBefore.deploymentId ||
    activeImmediatelyBeforePatch.versionId !== input.lease.expectedSourceVersionId
  ) {
    throw new Error('control_worker_source_version_changed');
  }
  try {
    await input.api.patchWorkerSettings(input.target.workerScriptName, patch);
  } catch (patchError) {
    // A network failure can hide a successful provider mutation. Reconcile the observable
    // deployment and settings before returning the original transient error so a retry never
    // issues a duplicate PATCH merely because the response was lost.
    let recovered:
      | {
          active: ActiveWorkerDeployment;
          settings: CloudflareWorkerSettings;
        }
      | undefined;
    try {
      const recoveredDeployments = await input.api.listWorkerDeployments(
        input.target.workerScriptName
      );
      const recoveredActive = activeWorkerDeployment(recoveredDeployments);
      const beforeIds = new Set(input.deploymentsBefore.map((deployment) => deployment.id));
      const recoveredNewDeployments = recoveredDeployments.filter(
        (deployment) => !beforeIds.has(deployment.id)
      );
      if (
        recoveredActive.versionId !== input.lease.expectedSourceVersionId &&
        recoveredNewDeployments.length === 1 &&
        recoveredNewDeployments[0]?.id === recoveredActive.deploymentId
      ) {
        recovered = {
          active: recoveredActive,
          settings: await input.api.getWorkerSettings(input.target.workerScriptName),
        };
      }
    } catch {
      // Keep the original provider error. The persisted mutation intent makes the next attempt
      // observe deployments/settings before it is allowed to send another PATCH.
    }
    if (!recovered) throw patchError;
    await input.state.recordPatchResult({
      target: input.target,
      lease: input.lease,
      versionId: recovered.active.versionId,
      deploymentId: recovered.active.deploymentId,
      now: input.now(),
    });
    const recoveredIssues = verifyWorkerSettingsPreserved({
      before: currentSettings,
      after: recovered.settings,
      desiredBindings,
    });
    if (recoveredIssues.length > 0) {
      await input.state.markRollbackRequired(
        input.target,
        'control_worker_settings_preservation_failed',
        input.now()
      );
      return { state: 'rollback_required', target: null };
    }
    return {
      state: 'patched',
      target: {
        ...input.target,
        state: 'settings_patched',
        expectedSourceVersionId: input.lease.expectedSourceVersionId,
        previousDeploymentId: input.activeBefore.deploymentId,
        previousRestoreSettingsJson: JSON.stringify(restoreSettings),
        patchResultVersionId: recovered.active.versionId,
        patchResultDeploymentId: recovered.active.deploymentId,
      },
    };
  }

  const deploymentsAfter = await input.api.listWorkerDeployments(input.target.workerScriptName);
  const activeAfter = activeWorkerDeployment(deploymentsAfter);
  if (activeAfter.versionId === input.lease.expectedSourceVersionId) {
    await input.state.recordTransientError(
      input.target,
      'control_worker_patch_propagating',
      now + retrySeconds,
      now
    );
    return { state: 'deferred', target: null };
  }
  const beforeIds = new Set(input.deploymentsBefore.map((deployment) => deployment.id));
  const newDeployments = deploymentsAfter.filter((deployment) => !beforeIds.has(deployment.id));
  if (newDeployments.length !== 1 || newDeployments[0]?.id !== activeAfter.deploymentId) {
    await input.state.markBlocked(
      input.target,
      'control_worker_concurrent_deployment_detected',
      now
    );
    return { state: 'blocked', target: null };
  }
  const reflected = await input.api.getWorkerSettings(input.target.workerScriptName);
  await input.state.recordPatchResult({
    target: input.target,
    lease: input.lease,
    versionId: activeAfter.versionId,
    deploymentId: activeAfter.deploymentId,
    now,
  });
  const issues = verifyWorkerSettingsPreserved({
    before: currentSettings,
    after: reflected,
    desiredBindings,
  });
  if (issues.length > 0) {
    await input.state.markRollbackRequired(
      input.target,
      'control_worker_settings_preservation_failed',
      now
    );
    return { state: 'rollback_required', target: null };
  }
  return {
    state: 'patched',
    target: {
      ...input.target,
      state: 'settings_patched',
      expectedSourceVersionId: input.lease.expectedSourceVersionId,
      previousDeploymentId: input.activeBefore.deploymentId,
      previousRestoreSettingsJson: JSON.stringify(restoreSettings),
      patchResultVersionId: activeAfter.versionId,
      patchResultDeploymentId: activeAfter.deploymentId,
    },
  };
}

export function ensureWorkerBindingPatched<
  TTarget extends WorkerBindingPatchTarget,
  TLease extends WorkerBindingPatchLease,
>(
  input: Omit<Parameters<typeof ensureWorkerBindingsPatched<TTarget, TLease>>[0], 'desiredBindings'>
): Promise<WorkerBindingPatchResult<TTarget>> {
  return ensureWorkerBindingsPatched({
    ...input,
    desiredBindings: [
      {
        name: input.target.bindingRef,
        type: 'd1',
        database_id: input.target.databaseId,
      },
    ],
  });
}
