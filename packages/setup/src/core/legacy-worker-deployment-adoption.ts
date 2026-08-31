import { getWorkerDeployments, listWorkers } from './cloudflare.js';
import {
  requireCloudflareScriptTag,
  requireCloudflareVersionId,
  type AuthrimLock,
} from './lock.js';
import { CORE_WORKER_COMPONENTS } from './naming.js';

const RECOVERABLE_WORKER_COMPONENTS = new Set<string>([
  ...CORE_WORKER_COMPONENTS,
  'ar-login-ui',
  'ar-admin-ui',
]);

export interface LegacyWorkerDeploymentTarget {
  component: string;
  workerName: string;
  expectedPackageVersion: string;
}

export interface LegacyWorkerDeploymentEvidence {
  component: string;
  workerName: string;
  scriptTag: string;
  activeVersionId: string;
  deployedAt: string;
  deploymentSource: string;
  expectedPackageVersion: string;
}

interface LegacyWorkerDeploymentAdoptionDependencies {
  list?: () => Promise<Array<{ name: string; id: string; tag?: string }>>;
  getDeployment?: typeof getWorkerDeployments;
}

function exactWorkerInventory(
  workers: ReadonlyArray<{ name: string; id: string; tag?: string }>
): ReadonlyMap<string, { name: string; id: string; tag?: string }> {
  const byName = new Map<string, { name: string; id: string; tag?: string }>();
  const tagOwners = new Map<string, string>();
  for (const [index, worker] of workers.entries()) {
    const name = worker.name?.trim();
    if (!name || worker.id?.trim() !== name || byName.has(name)) {
      throw new Error(`legacy_worker_recovery_inventory_invalid:${index}`);
    }
    const tag = worker.tag?.trim();
    if (!tag) {
      byName.set(name, { name, id: name });
      continue;
    }
    const previousOwner = tagOwners.get(tag);
    if (previousOwner) {
      throw new Error(`legacy_worker_recovery_duplicate_script_tag:${previousOwner}:${name}`);
    }
    tagOwners.set(tag, name);
    byName.set(name, { name, id: name, tag });
  }
  return byName;
}

function assertRecoveryTargets(input: {
  environment: string;
  productVersion: string;
  targets: readonly LegacyWorkerDeploymentTarget[];
}): void {
  const components = new Set<string>();
  const names = new Set<string>();
  for (const target of input.targets) {
    if (
      !RECOVERABLE_WORKER_COMPONENTS.has(target.component) ||
      target.workerName !== `${input.environment}-${target.component}` ||
      target.expectedPackageVersion !== input.productVersion ||
      components.has(target.component) ||
      names.has(target.workerName)
    ) {
      throw new Error('legacy_worker_recovery_target_set_invalid');
    }
    components.add(target.component);
    names.add(target.workerName);
  }
  if (input.targets.length === 0) throw new Error('legacy_worker_recovery_target_set_empty');
}

/**
 * Explicitly checkpoint Workers from a failed pre-ownership deployment.
 *
 * This is deliberately narrower than normal ownership reconciliation. Only a canonical Worker
 * whose lock and provisional ownership entries are both absent can be adopted, and only when the
 * provider returns one immutable script tag plus one active deployment version with timestamp and
 * source metadata. The expected local package version is recorded so the following normal deploy
 * guard owns and replaces/verifies the recovered script rather than treating it as fresh absence.
 */
export async function adoptLegacyWorkerDeployments(input: {
  lock: AuthrimLock;
  environment: string;
  authenticatedAccountId: string;
  configuredAccountId: string | undefined;
  productVersion: string;
  targets: readonly LegacyWorkerDeploymentTarget[];
  requireAllTargets?: boolean;
  allowNoop?: boolean;
  dependencies?: LegacyWorkerDeploymentAdoptionDependencies;
}): Promise<{ lock: AuthrimLock; adopted: LegacyWorkerDeploymentEvidence[] }> {
  if (input.lock.env !== input.environment) {
    throw new Error('legacy_worker_recovery_environment_mismatch');
  }
  if (
    !input.configuredAccountId?.trim() ||
    input.configuredAccountId.trim() !== input.authenticatedAccountId.trim()
  ) {
    throw new Error('legacy_worker_recovery_account_mismatch');
  }
  assertRecoveryTargets(input);

  const list = input.dependencies?.list ?? (() => listWorkers());
  const getDeployment = input.dependencies?.getDeployment ?? getWorkerDeployments;
  const inventory = exactWorkerInventory(await list());
  const workers = { ...(input.lock.workers ?? {}) };
  const adopted: LegacyWorkerDeploymentEvidence[] = [];

  for (const target of input.targets) {
    const locked = input.lock.workers?.[target.component];
    const provisional = input.lock.workerScriptOwnership?.[target.component];
    if (locked) {
      if (locked.name !== target.workerName) {
        throw new Error(`legacy_worker_recovery_locked_name_mismatch:${target.component}`);
      }
      continue;
    }
    if (provisional) {
      if (provisional.name !== target.workerName) {
        throw new Error(`legacy_worker_recovery_provisional_name_mismatch:${target.component}`);
      }
      continue;
    }

    const live = inventory.get(target.workerName);
    if (!live) {
      if (input.requireAllTargets) {
        throw new Error(
          `legacy_worker_recovery_evidence_insufficient_delete_or_recreate:${target.workerName}:missing`
        );
      }
      continue;
    }
    let scriptTag: string;
    try {
      scriptTag = requireCloudflareScriptTag(live.tag ?? '');
    } catch {
      throw new Error(
        `legacy_worker_recovery_evidence_insufficient_delete_or_recreate:${target.workerName}:script_tag`
      );
    }
    const deployment = await getDeployment(target.workerName);
    let activeVersionId: string;
    try {
      activeVersionId = requireCloudflareVersionId(deployment.versionId ?? '');
    } catch {
      throw new Error(
        `legacy_worker_recovery_evidence_insufficient_delete_or_recreate:${target.workerName}:active_version`
      );
    }
    const deployedAt = deployment.lastDeployedAt?.trim();
    const deploymentSource = deployment.source?.trim();
    if (
      !deployment.exists ||
      deployment.name !== target.workerName ||
      !deployedAt ||
      !Number.isFinite(Date.parse(deployedAt)) ||
      !deploymentSource
    ) {
      throw new Error(
        `legacy_worker_recovery_evidence_insufficient_delete_or_recreate:${target.workerName}:deployment_metadata`
      );
    }

    workers[target.component] = {
      name: target.workerName,
      version: target.expectedPackageVersion,
      deployedAt,
      cloudflareVersionId: activeVersionId,
      cloudflareScriptTag: scriptTag,
    };
    adopted.push({
      component: target.component,
      workerName: target.workerName,
      scriptTag,
      activeVersionId,
      deployedAt,
      deploymentSource,
      expectedPackageVersion: target.expectedPackageVersion,
    });
  }

  if (adopted.length === 0 && input.allowNoop !== true) {
    throw new Error('legacy_worker_recovery_not_required');
  }
  return {
    lock: { ...input.lock, workers },
    adopted: adopted.sort((left, right) => left.component.localeCompare(right.component)),
  };
}

export function assertLegacyWorkerDeploymentAdoptionPersisted(
  lock: AuthrimLock | null,
  environment: string,
  evidence: readonly LegacyWorkerDeploymentEvidence[]
): void {
  if (!lock || lock.env !== environment || evidence.length === 0) {
    throw new Error('legacy_worker_recovery_checkpoint_verification_failed');
  }
  for (const adopted of evidence) {
    const checkpoint = lock.workers?.[adopted.component];
    if (
      checkpoint?.name !== adopted.workerName ||
      checkpoint.version !== adopted.expectedPackageVersion ||
      checkpoint.deployedAt !== adopted.deployedAt ||
      checkpoint.cloudflareVersionId !== adopted.activeVersionId ||
      checkpoint.cloudflareScriptTag !== adopted.scriptTag
    ) {
      throw new Error(`legacy_worker_recovery_checkpoint_verification_failed:${adopted.component}`);
    }
  }
}
