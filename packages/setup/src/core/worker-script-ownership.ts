import {
  requireCloudflareScriptTag,
  requireCloudflareVersionId,
  saveLockFile,
  withPendingWorkerScriptVersionOwnership,
  withProvisionalWorkerScriptOwnership,
  type AuthrimLock,
} from './lock.js';
import { getWorkerDeployments, getWorkerVersion, listWorkers } from './cloudflare.js';

export interface WorkerScriptOwnershipTarget {
  component: string;
  workerName: string;
}

export interface WorkerScriptIdentity {
  name: string;
  tag: string;
}

export type WorkerScriptOwnershipEvidence =
  | {
      workerName: string;
      state: 'absent';
    }
  | {
      workerName: string;
      state: 'owned';
      tag: string;
    };

export interface WorkerScriptOwnershipGuard {
  /** Re-read Cloudflare immediately before a script upload and reject delete/recreate races. */
  assertBeforeMutation(workerName: string): Promise<void>;
  /** Durably correlate a successful fresh upload before the script tag becomes visible. */
  checkpointCommittedVersion(workerName: string, cloudflareVersionId: string): Promise<void>;
  /** Read back the immutable tag after a successful upload and transition fresh absence evidence. */
  captureAfterMutation(workerName: string): Promise<string>;
  getEvidence(workerName: string): WorkerScriptOwnershipEvidence | undefined;
}

interface WorkerInventoryEntry {
  name: string;
  tag?: string;
}

interface WorkerDeploymentIdentity {
  exists: boolean;
  versionId: string | null;
}

interface WorkerScriptOwnershipDependencies {
  list?: () => Promise<WorkerInventoryEntry[]>;
  getDeployment?: (workerName: string) => Promise<WorkerDeploymentIdentity>;
  getVersion?: (workerName: string, versionId: string) => Promise<WorkerDeploymentIdentity>;
  sleep?: (delayMs: number) => Promise<void>;
  captureMaxAttempts?: number;
}

function exactWorkerInventory(
  workers: readonly WorkerInventoryEntry[]
): ReadonlyMap<string, WorkerInventoryEntry> {
  const byName = new Map<string, WorkerInventoryEntry>();
  const tagOwners = new Map<string, string>();
  for (const [index, worker] of workers.entries()) {
    const name = worker.name?.trim();
    if (!name) {
      throw new Error(`worker_script_inventory_invalid_name:${index}`);
    }
    if (byName.has(name)) {
      throw new Error(`worker_script_inventory_duplicate_name:${name}`);
    }
    const tag = worker.tag?.trim();
    if (worker.tag !== undefined && !tag) {
      throw new Error(`worker_script_inventory_invalid_tag:${name}`);
    }
    if (tag) {
      const previousName = tagOwners.get(tag);
      if (previousName) {
        throw new Error(`worker_script_inventory_duplicate_tag:${tag}:${previousName}:${name}`);
      }
      tagOwners.set(tag, name);
    }
    byName.set(name, { name, ...(tag ? { tag } : {}) });
  }
  return byName;
}

function requireLiveTag(workerName: string, live: WorkerInventoryEntry | undefined): string {
  if (!live) {
    throw new Error(`worker_script_missing:${workerName}`);
  }
  if (!live.tag) {
    throw new Error(`worker_script_immutable_tag_unavailable:${workerName}`);
  }
  try {
    return requireCloudflareScriptTag(live.tag);
  } catch {
    throw new Error(`worker_script_immutable_tag_invalid:${workerName}`);
  }
}

function assertUniqueTargets(targets: readonly WorkerScriptOwnershipTarget[]): void {
  const components = new Set<string>();
  const workerNames = new Set<string>();
  for (const target of targets) {
    if (!target.component.trim() || !target.workerName.trim()) {
      throw new Error('worker_script_ownership_target_invalid');
    }
    if (components.has(target.component)) {
      throw new Error(`worker_script_ownership_duplicate_component:${target.component}`);
    }
    if (workerNames.has(target.workerName)) {
      throw new Error(`worker_script_ownership_duplicate_name:${target.workerName}`);
    }
    components.add(target.component);
    workerNames.add(target.workerName);
  }
}

/**
 * Establish exact script ownership before a deployment operation.
 *
 * A fresh target is authorized only by strict absence. Existing targets require an exact immutable
 * tag. Pending upload checkpoints are upgraded only while their exact Version still belongs to the
 * script. Legacy final locks still require their pinned active Version to match; a same-name script
 * alone is never adopted.
 */
export async function prepareWorkerScriptOwnership(input: {
  lock: AuthrimLock;
  targets: readonly WorkerScriptOwnershipTarget[];
  dependencies?: WorkerScriptOwnershipDependencies;
  persistProvisional?: (input: {
    component: string;
    workerName: string;
    cloudflareScriptTag: string;
  }) => Promise<void>;
  persistCommittedVersion?: (input: {
    component: string;
    workerName: string;
    cloudflareVersionId: string;
  }) => Promise<void>;
}): Promise<{
  lock: AuthrimLock;
  changed: boolean;
  guard: WorkerScriptOwnershipGuard;
}> {
  assertUniqueTargets(input.targets);
  const list = input.dependencies?.list ?? (() => listWorkers());
  const getDeployment = input.dependencies?.getDeployment ?? getWorkerDeployments;
  const getVersion = input.dependencies?.getVersion ?? getWorkerVersion;
  const sleep =
    input.dependencies?.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const captureMaxAttempts = Math.max(
    1,
    input.dependencies?.captureMaxAttempts ?? (process.env.NODE_ENV === 'test' ? 3 : 8)
  );
  const inventory = exactWorkerInventory(await list());
  const evidence = new Map<string, WorkerScriptOwnershipEvidence>();
  const componentByWorkerName = new Map(
    input.targets.map((target) => [target.workerName, target.component] as const)
  );
  let provisionalPersistence: Promise<void> = Promise.resolve();
  let changed = false;
  const workers = { ...input.lock.workers };
  const ownershipCheckpoints = { ...input.lock.workerScriptOwnership };

  for (const target of input.targets) {
    const locked = workers[target.component];
    const provisional = input.lock.workerScriptOwnership?.[target.component];
    const live = inventory.get(target.workerName);
    if (!locked) {
      if (provisional) {
        if (provisional.name !== target.workerName) {
          throw new Error(
            `worker_script_provisional_name_mismatch:${target.component}:${provisional.name}:${target.workerName}`
          );
        }
        if (provisional.state === 'pending_tag') {
          const version = await getVersion(
            target.workerName,
            provisional.pendingCloudflareVersionId
          );
          if (
            !version.exists ||
            !version.versionId ||
            version.versionId !== provisional.pendingCloudflareVersionId
          ) {
            throw new Error(
              `worker_script_pending_version_mismatch:${target.workerName}:${provisional.pendingCloudflareVersionId}:${version.versionId ?? 'missing'}`
            );
          }
          const liveTag = requireLiveTag(target.workerName, live);
          ownershipCheckpoints[target.component] = {
            name: target.workerName,
            cloudflareScriptTag: liveTag,
            state: 'provisional',
            updatedAt: new Date().toISOString(),
          };
          changed = true;
          evidence.set(target.workerName, {
            workerName: target.workerName,
            state: 'owned',
            tag: liveTag,
          });
          continue;
        }
        const liveTag = requireLiveTag(target.workerName, live);
        if (liveTag !== provisional.cloudflareScriptTag) {
          throw new Error(
            `worker_script_immutable_tag_mismatch:${target.workerName}:${provisional.cloudflareScriptTag}:${liveTag}`
          );
        }
        evidence.set(target.workerName, {
          workerName: target.workerName,
          state: 'owned',
          tag: liveTag,
        });
        continue;
      }
      if (live) {
        throw new Error(`worker_script_fresh_name_conflict:${target.workerName}`);
      }
      evidence.set(target.workerName, { workerName: target.workerName, state: 'absent' });
      continue;
    }
    if (locked.name !== target.workerName) {
      throw new Error(
        `worker_script_locked_name_mismatch:${target.component}:${locked.name}:${target.workerName}`
      );
    }

    const liveTag = requireLiveTag(target.workerName, live);
    if (locked.cloudflareScriptTag) {
      if (locked.cloudflareScriptTag !== liveTag) {
        throw new Error(
          `worker_script_immutable_tag_mismatch:${target.workerName}:${locked.cloudflareScriptTag}:${liveTag}`
        );
      }
      evidence.set(target.workerName, {
        workerName: target.workerName,
        state: 'owned',
        tag: liveTag,
      });
      continue;
    }

    if (!locked.cloudflareVersionId) {
      throw new Error(`worker_script_legacy_identity_insufficient:${target.workerName}`);
    }
    const deployment = await getDeployment(target.workerName);
    if (
      !deployment.exists ||
      !deployment.versionId ||
      deployment.versionId !== locked.cloudflareVersionId
    ) {
      throw new Error(
        `worker_script_legacy_version_mismatch:${target.workerName}:${locked.cloudflareVersionId}:${deployment.versionId ?? 'missing'}`
      );
    }

    workers[target.component] = {
      ...locked,
      cloudflareScriptTag: liveTag,
    };
    changed = true;
    evidence.set(target.workerName, {
      workerName: target.workerName,
      state: 'owned',
      tag: liveTag,
    });
  }

  const readExactLiveIdentity = async (
    workerName: string
  ): Promise<WorkerInventoryEntry | undefined> =>
    exactWorkerInventory(await list()).get(workerName);

  const guard: WorkerScriptOwnershipGuard = {
    async assertBeforeMutation(workerName) {
      const expected = evidence.get(workerName);
      if (!expected) {
        throw new Error(`worker_script_ownership_evidence_missing:${workerName}`);
      }
      const live = await readExactLiveIdentity(workerName);
      if (expected.state === 'absent') {
        if (live) {
          throw new Error(`worker_script_fresh_name_conflict:${workerName}`);
        }
        return;
      }
      const liveTag = requireLiveTag(workerName, live);
      if (liveTag !== expected.tag) {
        throw new Error(
          `worker_script_immutable_tag_mismatch:${workerName}:${expected.tag}:${liveTag}`
        );
      }
    },
    async checkpointCommittedVersion(workerName, cloudflareVersionId) {
      const expected = evidence.get(workerName);
      if (!expected) {
        throw new Error(`worker_script_ownership_evidence_missing:${workerName}`);
      }
      // Existing owned scripts already have stronger immutable-tag evidence in the durable lock.
      if (expected.state === 'owned') return;
      const component = componentByWorkerName.get(workerName);
      if (!component || !input.persistCommittedVersion) {
        throw new Error(`worker_script_version_checkpoint_unavailable:${workerName}`);
      }
      const versionId = requireCloudflareVersionId(cloudflareVersionId);
      provisionalPersistence = provisionalPersistence.then(() =>
        input.persistCommittedVersion!({
          component,
          workerName,
          cloudflareVersionId: versionId,
        })
      );
      await provisionalPersistence;
    },
    async captureAfterMutation(workerName) {
      const expected = evidence.get(workerName);
      if (!expected) {
        throw new Error(`worker_script_ownership_evidence_missing:${workerName}`);
      }
      let lastError: unknown;
      for (let attempt = 1; attempt <= captureMaxAttempts; attempt++) {
        try {
          const live = await readExactLiveIdentity(workerName);
          const liveTag = live?.tag?.trim();
          if (expected.state === 'owned' && liveTag && liveTag !== expected.tag) {
            // A non-empty different immutable tag is deletion/recreation evidence, not eventual
            // consistency. Stop immediately before it can be adopted.
            throw new Error(
              `worker_script_immutable_tag_mismatch:${workerName}:${expected.tag}:${liveTag}`
            );
          }
          if (liveTag) {
            if (expected.state === 'absent') {
              const component = componentByWorkerName.get(workerName);
              if (!component || !input.persistProvisional) {
                throw new Error(`worker_script_provisional_checkpoint_unavailable:${workerName}`);
              }
              provisionalPersistence = provisionalPersistence.then(() =>
                input.persistProvisional!({
                  component,
                  workerName,
                  cloudflareScriptTag: liveTag,
                })
              );
              await provisionalPersistence;
            }
            evidence.set(workerName, { workerName, state: 'owned', tag: liveTag });
            return liveTag;
          }
          lastError = new Error(`worker_script_immutable_tag_unavailable:${workerName}`);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith('worker_script_immutable_tag_mismatch:')
          ) {
            throw error;
          }
          lastError = error;
        }
        if (attempt < captureMaxAttempts) {
          await sleep(
            process.env.NODE_ENV === 'test' ? 0 : Math.min(250 * 2 ** (attempt - 1), 2_000)
          );
        }
      }
      throw new Error(
        `worker_script_identity_readback_timeout:${workerName}:${lastError instanceof Error ? lastError.message : String(lastError)}`
      );
    },
    getEvidence(workerName) {
      return evidence.get(workerName);
    },
  };

  return {
    lock: changed
      ? {
          ...input.lock,
          workers,
          workerScriptOwnership:
            Object.keys(ownershipCheckpoints).length > 0 ? ownershipCheckpoints : undefined,
          updatedAt: new Date().toISOString(),
        }
      : input.lock,
    changed,
    guard,
  };
}

/** Prepare ownership and durably journal any fresh script immediately after Cloudflare creates it. */
export async function prepareManagedWorkerScriptOwnership(input: {
  lock: AuthrimLock;
  lockPath: string;
  targets: readonly WorkerScriptOwnershipTarget[];
  dependencies?: WorkerScriptOwnershipDependencies;
}): Promise<{
  lock: AuthrimLock;
  changed: boolean;
  guard: WorkerScriptOwnershipGuard;
}> {
  // Keep the returned lock object live. Callers commonly merge successful Worker results into this
  // object after a multi-Worker run; replacing only an internal snapshot here would let that final
  // save erase a sibling Worker's pending ownership checkpoint after a partial commit.
  let managedLock = input.lock;
  let persistedLock = managedLock;
  const applyOwnershipCheckpoint = (updated: AuthrimLock): void => {
    managedLock.workerScriptOwnership = updated.workerScriptOwnership;
    managedLock.updatedAt = updated.updatedAt;
    persistedLock = managedLock;
  };
  const prepared = await prepareWorkerScriptOwnership({
    lock: input.lock,
    targets: input.targets,
    dependencies: input.dependencies,
    persistProvisional: async ({ component, workerName, cloudflareScriptTag }) => {
      const updated = withProvisionalWorkerScriptOwnership(persistedLock, {
        component,
        name: workerName,
        cloudflareScriptTag,
      });
      applyOwnershipCheckpoint(updated);
      await saveLockFile(persistedLock, input.lockPath);
    },
    persistCommittedVersion: async ({ component, workerName, cloudflareVersionId }) => {
      const updated = withPendingWorkerScriptVersionOwnership(persistedLock, {
        component,
        name: workerName,
        pendingCloudflareVersionId: cloudflareVersionId,
      });
      applyOwnershipCheckpoint(updated);
      await saveLockFile(persistedLock, input.lockPath);
    },
  });
  managedLock = prepared.lock;
  persistedLock = managedLock;
  if (prepared.changed) {
    await saveLockFile(persistedLock, input.lockPath);
  }
  return { ...prepared, lock: persistedLock };
}
