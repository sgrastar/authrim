/**
 * Authrim Lock File Module
 *
 * Manages lock files which record created resource IDs.
 * This file allows re-deployment and resource management.
 *
 * Uses the fresh-install .authrim/{env}/lock.json structure.
 */

import { open, writeFile, readFile, mkdir, rename, rm, link, lstat } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { DeletionWorkerIdentity, ProvisionedResources } from './cloudflare.js';
import { getAuthrimRoot, getEnvironmentPaths, getLegacyPaths } from './paths.js';
import { D1_DATABASES, KV_NAMESPACES, getD1DatabaseName, getKVNamespaceName } from './naming.js';
import { isTenantDatabaseBinding } from './tenant-database.js';

// =============================================================================
// Schema
// =============================================================================

const ResourceEntrySchema = z.object({
  name: z.string(),
  id: z.string(),
});

const KVResourceEntrySchema = ResourceEntrySchema.extend({
  previewId: z.string().optional(),
});

const CloudflareVersionIdSchema = z.string().uuid();
const CloudflareScriptTagSchema = z.string().trim().min(1).max(256);

const WorkerEntrySchema = z.object({
  name: z.string(),
  deployedAt: z.string().datetime().optional(),
  version: z.string().optional(),
  cloudflareVersionId: CloudflareVersionIdSchema.optional(),
  /** Cloudflare's immutable script identity. Unlike the script name, this changes on delete/recreate. */
  cloudflareScriptTag: CloudflareScriptTagSchema.optional(),
});

const WorkerScriptOwnershipCheckpointSchema = z.discriminatedUnion('state', [
  z.object({
    name: z.string().min(1),
    cloudflareScriptTag: CloudflareScriptTagSchema,
    state: z.literal('provisional'),
    updatedAt: z.string().datetime(),
  }),
  z.object({
    name: z.string().min(1),
    pendingCloudflareVersionId: CloudflareVersionIdSchema,
    state: z.literal('pending_tag'),
    updatedAt: z.string().datetime(),
  }),
]);

const DnsRecordRestoreSnapshotSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.literal('CNAME'),
  name: z.string().min(1).max(253),
  content: z.string().min(1).max(4096),
  proxied: z.boolean().optional(),
  ttl: z.number().int().nonnegative().optional(),
  comment: z.string().max(500).nullable().optional(),
  tags: z.array(z.string().max(256)).max(100).optional(),
  settings: z
    .record(z.string().max(128), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});

export const DnsOwnershipRoleSchema = z.enum(['api_base', 'tenant_wildcard']);

const DnsOwnershipEntrySchema = z
  .object({
    role: DnsOwnershipRoleSchema,
    state: z.enum(['mutation_pending', 'managed']),
    action: z.enum(['created', 'updated', 'adopted']),
    operationId: z.string().uuid(),
    zoneId: z.string().min(1).max(256),
    recordId: z.string().min(1).max(256).optional(),
    name: z.string().min(1).max(253),
    target: z.string().min(1).max(4096),
    marker: z.string().min(1).max(500).optional(),
    previous: DnsRecordRestoreSnapshotSchema.nullable().optional(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((entry, context) => {
    if (entry.state === 'managed' && !entry.recordId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'dns_record_id_required' });
    }
    if (entry.action === 'adopted') {
      if (entry.state !== 'managed' || entry.marker !== undefined || entry.previous !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'dns_adoption_invalid' });
      }
      return;
    }
    if (!entry.marker) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'dns_marker_required' });
    }
    if (entry.action === 'created' && entry.previous !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'dns_created_previous_invalid' });
    }
    if (entry.action === 'updated') {
      if (!entry.previous) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'dns_previous_required' });
      } else if (entry.recordId && entry.recordId !== entry.previous.id) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'dns_updated_identity_changed' });
      }
    }
  });

const ReleaseUpdateStateSchema = z.object({
  targetVersion: z.string().min(1),
  previousProductVersion: z.string().min(1).optional(),
  phase: z.enum([
    'planned',
    'control_handoff',
    'awaiting_setup',
    'schema_applied',
    'workers_deployed',
    'verified',
    'database_only_verified',
  ]),
  manifestChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  appliedTargets: z.array(z.string()).default([]),
  manualTargets: z.array(z.string()).default([]),
  controlOperationId: z
    .string()
    .regex(/^op_release_rollout_[a-f0-9]{32}$/u)
    .optional(),
  controlCompletedTargets: z.number().int().nonnegative().optional(),
  controlTotalTargets: z.number().int().nonnegative().optional(),
  initialWorkerRedeployRequired: z.boolean().optional(),
});

const SchemaTargetStateSchema = z.object({
  productVersion: z.string().min(1),
  manifestChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
  streamId: z.string().min(1).optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        checksum: z.string().regex(/^[a-f0-9]{64}$/u),
      })
    )
    .optional(),
  appliedBy: z.enum(['automatic', 'operator']),
  updatedAt: z.string().datetime(),
});

const ControlSigningKeyFields = {
  activeSlot: z.enum(['A', 'B']),
  activeKeyId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u),
  activeFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  previousSlot: z.enum(['A', 'B']).optional(),
  previousKeyId: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u)
    .optional(),
  previousFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  updatedAt: z.number().int().positive(),
};

function validateControlKeyPrevious(
  value: {
    activeSlot: 'A' | 'B';
    activeKeyId: string;
    activeFingerprint: string;
    previousSlot?: 'A' | 'B';
    previousKeyId?: string;
    previousFingerprint?: string;
  },
  context: z.RefinementCtx
): void {
  const previous = [value.previousSlot, value.previousKeyId, value.previousFingerprint];
  if (previous.some((item) => item !== undefined) && previous.some((item) => item === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'previous_key_metadata_incomplete' });
    return;
  }
  if (
    value.previousSlot === value.activeSlot ||
    value.previousKeyId === value.activeKeyId ||
    value.previousFingerprint === value.activeFingerprint
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'previous_key_metadata_conflict' });
  }
}

const ControlSigningKeyStateSchema = z
  .object(ControlSigningKeyFields)
  .superRefine(validateControlKeyPrevious);

const ControlLookupHmacKeyStateSchema = z
  .object({
    ...ControlSigningKeyFields,
    stateRevision: z.number().int().positive(),
    activeGeneration: z.number().int().positive(),
    previousGeneration: z.number().int().positive().optional(),
  })
  .superRefine((value, context) => {
    validateControlKeyPrevious(value, context);
    const previousMetadataPresent = value.previousSlot !== undefined;
    if (previousMetadataPresent !== (value.previousGeneration !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'previous_generation_incomplete' });
    } else if (
      value.previousGeneration !== undefined &&
      value.previousGeneration >= value.activeGeneration
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'previous_generation_conflict' });
    }
  });

const ControlKeyStateSchema = z.object({
  runtimeRegistry: ControlSigningKeyStateSchema,
  smokeRpc: ControlSigningKeyStateSchema,
  lookupHmac: ControlLookupHmacKeyStateSchema,
});

export const TopologyUpdateKindSchema = z.literal('r2');

const R2ResourceEntrySchema = z
  .object({
    name: z.string().min(1),
    creationDate: z.string().datetime().optional(),
    ownershipMarkerKey: z
      .string()
      .regex(/^__authrim_setup__\/ownership-v1-[a-f0-9-]{36}\.json$/u)
      .optional(),
    ownershipId: z.string().uuid().optional(),
  })
  .superRefine((value, context) => {
    const ownershipFieldCount = [
      value.creationDate,
      value.ownershipMarkerKey,
      value.ownershipId,
    ].filter((field) => field !== undefined).length;
    // Name-only entries remain readable for pre-fix locks, but never authorize automatic
    // deletion. New entries must carry the complete provider generation + marker identity.
    if (ownershipFieldCount !== 0 && ownershipFieldCount !== 3) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'r2_ownership_incomplete' });
    }
  });

const PagesResourceEntrySchema = z.object({
  name: z.string().min(1),
  id: z.string().min(1),
  createdOn: z.string().datetime(),
});

const TopologyUpdateStateSchema = z.object({
  kind: TopologyUpdateKindSchema,
  phase: z.enum(['config_staged', 'preparing', 'pending_deploy']),
  targetProductVersion: z.string().min(1),
  subject: z.string().min(1).optional(),
  configChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
  authorizationTokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const AuthrimLockSchema = z.object({
  version: z.string().default('1.0.0'),
  productVersion: z.string().optional(),
  releaseUpdate: ReleaseUpdateStateSchema.optional(),
  schemaTargets: z.record(z.string(), SchemaTargetStateSchema).optional(),
  controlKeyState: ControlKeyStateSchema.optional(),
  topologyUpdate: TopologyUpdateStateSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  env: z.string(),

  d1: z.record(ResourceEntrySchema).default({}),
  kv: z.record(KVResourceEntrySchema).default({}),
  queues: z.record(ResourceEntrySchema).optional(),
  r2: z.record(R2ResourceEntrySchema).optional(),
  /** Exact provider identities for retired Pages projects retained only for safe cleanup. */
  pages: z.record(PagesResourceEntrySchema).optional(),
  dns: z.record(DnsOwnershipRoleSchema, DnsOwnershipEntrySchema).optional(),
  workers: z.record(WorkerEntrySchema).optional(),
  /** Crash-safe ownership evidence for scripts created before deployment health is verified. */
  workerScriptOwnership: z.record(WorkerScriptOwnershipCheckpointSchema).optional(),
});

export type AuthrimLock = z.infer<typeof AuthrimLockSchema>;
export type ResourceEntry = z.infer<typeof ResourceEntrySchema>;
export type KVResourceEntry = z.infer<typeof KVResourceEntrySchema>;
export type WorkerEntry = z.infer<typeof WorkerEntrySchema>;
export type WorkerScriptOwnershipCheckpoint = z.infer<typeof WorkerScriptOwnershipCheckpointSchema>;
export type DnsRecordRestoreSnapshot = z.infer<typeof DnsRecordRestoreSnapshotSchema>;
export type DnsOwnershipRole = z.infer<typeof DnsOwnershipRoleSchema>;
export type DnsOwnershipEntry = z.infer<typeof DnsOwnershipEntrySchema>;
export type ControlKeyState = z.infer<typeof ControlKeyStateSchema>;
export type TopologyUpdateKind = z.infer<typeof TopologyUpdateKindSchema>;
export type TopologyUpdateState = z.infer<typeof TopologyUpdateStateSchema>;
export type R2ResourceEntry = z.infer<typeof R2ResourceEntrySchema>;
export type PagesResourceEntry = z.infer<typeof PagesResourceEntrySchema>;

export interface D1LockReconciliationResult {
  lock: AuthrimLock;
  updatedBindings: string[];
  missingBindings: Array<{ binding: string; name: string }>;
  identityMismatches: Array<{
    binding: string;
    expectedName: string;
    lockedName?: string;
    lockedId?: string;
    liveId: string;
  }>;
}

export interface SharedKVLockReconciliationResult {
  lock: AuthrimLock;
  updatedBindings: string[];
  missingBindings: Array<{ binding: string; name: string }>;
  identityMismatches: Array<{
    binding: string;
    expectedName: string;
    lockedName?: string;
    lockedId?: string;
    liveId: string;
  }>;
}

export type QueueIdentityMismatchReason =
  | 'locked_identity_missing'
  | 'locked_name_mismatch'
  | 'live_identity_unavailable'
  | 'live_identity_ambiguous'
  | 'live_identity_mismatch';

export interface QueueLockReconciliationResult {
  lock: AuthrimLock;
  updatedBindings: string[];
  missingBindings: Array<{ binding: string; name: string }>;
  identityMismatches: Array<{
    binding: string;
    expectedName: string;
    lockedName?: string;
    lockedId?: string;
    liveId?: string;
    reason: QueueIdentityMismatchReason;
  }>;
}

export interface DeletedEnvironmentResourceNames {
  workers: string[];
  d1: string[];
  kv: string[];
  queues: string[];
  r2: string[];
  pages?: string[];
  dns?: string[];
}

function omitResourceNames<T extends { name: string }>(
  resources: Record<string, T> | undefined,
  deletedNames: string[]
): Record<string, T> | undefined {
  if (!resources || deletedNames.length === 0) return resources;
  const deleted = new Set(deletedNames);
  return Object.fromEntries(
    Object.entries(resources).filter(([, resource]) => !deleted.has(resource.name))
  );
}

/**
 * Build the strongest available Worker identities for deletion. An unfinished deployment
 * checkpoint supersedes the older final entry for the same component because it describes the
 * most recent uploaded script, while Cloudflare deletion preflight still verifies that immutable
 * identity before mutating anything.
 */
export function collectWorkerDeletionIdentities(
  lock: Pick<AuthrimLock, 'workers' | 'workerScriptOwnership'>
): DeletionWorkerIdentity[] {
  const byComponent = new Map<string, DeletionWorkerIdentity>();
  for (const [component, worker] of Object.entries(lock.workers ?? {})) {
    byComponent.set(component, {
      name: worker.name,
      ...(worker.cloudflareScriptTag ? { cloudflareScriptTag: worker.cloudflareScriptTag } : {}),
      ...(worker.cloudflareVersionId ? { cloudflareVersionId: worker.cloudflareVersionId } : {}),
    });
  }
  for (const [component, checkpoint] of Object.entries(lock.workerScriptOwnership ?? {})) {
    byComponent.set(
      component,
      checkpoint.state === 'provisional'
        ? { name: checkpoint.name, cloudflareScriptTag: checkpoint.cloudflareScriptTag }
        : {
            name: checkpoint.name,
            cloudflareVersionId: checkpoint.pendingCloudflareVersionId,
            cloudflareVersionState: 'uploaded',
          }
    );
  }
  return Array.from(byComponent.values());
}

/** Persist a Version-ID checkpoint after deletion preflight resolves its immutable script tag. */
export function withBackfilledWorkerDeletionIdentities(
  lock: AuthrimLock,
  resources: readonly DeletionWorkerIdentity[]
): AuthrimLock {
  const workers = { ...lock.workers };
  const workerScriptOwnership = { ...lock.workerScriptOwnership };
  for (const resource of resources) {
    const component =
      Object.entries(workers).find(([, worker]) => worker.name === resource.name)?.[0] ??
      Object.entries(workerScriptOwnership).find(
        ([, checkpoint]) => checkpoint.name === resource.name
      )?.[0];
    if (!component || !resource.cloudflareScriptTag) {
      throw new Error(`Worker identity backfill target is unavailable: ${resource.name}`);
    }
    workers[component] = {
      ...workers[component],
      name: resource.name,
      ...(resource.cloudflareVersionId
        ? { cloudflareVersionId: resource.cloudflareVersionId }
        : {}),
      cloudflareScriptTag: resource.cloudflareScriptTag,
    };
    delete workerScriptOwnership[component];
  }
  return {
    ...lock,
    workers,
    workerScriptOwnership:
      Object.keys(workerScriptOwnership).length > 0 ? workerScriptOwnership : undefined,
    updatedAt: new Date().toISOString(),
  };
}

/** Preserve an environment lock after partial deletion while removing stale resource entries. */
export function reconcileLockAfterResourceDeletion(
  lock: AuthrimLock,
  deleted: DeletedEnvironmentResourceNames
): AuthrimLock {
  const deletedDnsNames = new Set(deleted.dns ?? []);
  return {
    ...lock,
    d1: omitResourceNames(lock.d1, deleted.d1) ?? {},
    kv: omitResourceNames(lock.kv, deleted.kv) ?? {},
    queues: omitResourceNames(lock.queues, deleted.queues),
    r2: omitResourceNames(lock.r2, deleted.r2),
    pages: omitResourceNames(lock.pages, deleted.pages ?? []),
    dns:
      deletedDnsNames.size > 0
        ? Object.fromEntries(
            Object.entries(lock.dns ?? {}).filter(([, record]) => !deletedDnsNames.has(record.name))
          )
        : lock.dns,
    workers: omitResourceNames(lock.workers, deleted.workers),
    workerScriptOwnership: omitResourceNames(lock.workerScriptOwnership, deleted.workers),
  };
}

/** Persist a DNS ownership transition while preserving all unrelated lock state. */
export function withDnsOwnershipEntry(lock: AuthrimLock, entry: DnsOwnershipEntry): AuthrimLock {
  return AuthrimLockSchema.parse({
    ...lock,
    updatedAt: new Date().toISOString(),
    dns: {
      ...lock.dns,
      [entry.role]: entry,
    },
  });
}

// =============================================================================
// Lock File Operations
// =============================================================================

/**
 * Create a new lock file from provisioned resources
 */
export function createLockFile(env: string, resources: ProvisionedResources): AuthrimLock {
  const now = new Date().toISOString();

  const lock: AuthrimLock = {
    version: '1.0.0',
    createdAt: now,
    updatedAt: now,
    env,
    d1: {},
    kv: {},
  };

  // Add D1 databases
  for (const db of resources.d1) {
    lock.d1[db.binding] = {
      name: db.name,
      id: db.id,
    };
  }

  // Add KV namespaces
  for (const kv of resources.kv) {
    lock.kv[kv.binding] = {
      name: kv.name,
      id: kv.id,
      previewId: kv.previewId,
    };
  }

  // Add Queues
  if (resources.queues.length > 0) {
    lock.queues = {};
    for (const q of resources.queues) {
      lock.queues[q.binding] = {
        name: q.name,
        id: q.id,
      };
    }
  }

  // Add R2 buckets
  if (resources.r2.length > 0) {
    lock.r2 = {};
    for (const r of resources.r2) {
      lock.r2[r.binding] = {
        name: r.name,
        creationDate: r.creationDate,
        ownershipMarkerKey: r.ownershipMarkerKey,
        ownershipId: r.ownershipId,
      };
    }
  }

  return lock;
}

/** True once a provisioning-only lock has been consumed by deployment or release orchestration. */
export function hasPostProvisioningLockState(lock: AuthrimLock): boolean {
  return Boolean(
    lock.productVersion ||
    lock.releaseUpdate ||
    lock.schemaTargets ||
    lock.controlKeyState ||
    lock.topologyUpdate ||
    Object.keys(lock.workers ?? {}).length > 0
  );
}

/**
 * Refresh only resource identities in an interrupted provisioning-only lock.
 * Callers must never use this to replace a lock that already carries deployment state.
 */
export function mergeProvisionedResourcesIntoLock(
  existing: AuthrimLock,
  provisioned: AuthrimLock
): AuthrimLock {
  if (existing.env !== provisioned.env) {
    throw new Error('provisioning_lock_environment_mismatch');
  }
  if (hasPostProvisioningLockState(existing)) {
    throw new Error('provisioning_lock_contains_post_provision_state');
  }
  return AuthrimLockSchema.parse({
    ...existing,
    updatedAt: new Date().toISOString(),
    d1: provisioned.d1,
    kv: provisioned.kv,
    queues: provisioned.queues,
    r2: provisioned.r2,
  });
}

// =============================================================================
// Path Resolution for Lock Files
// =============================================================================

export interface LockFileOptions {
  /** Base directory (defaults to cwd) */
  baseDir?: string;
  /** Environment name */
  env?: string;
  /** Use legacy structure (authrim-lock.json) */
  legacy?: boolean;
  /** Direct path to lock file (overrides baseDir/env/legacy) */
  path?: string;
}

/**
 * Resolve lock file path based on options
 *
 * Explicit paths are supported for internal transactional writes; otherwise an environment is
 * required and resolves to the fresh-install structure.
 */
export function resolveLockFilePath(options: LockFileOptions | string = {}): string {
  // Support legacy call with just a path string
  if (typeof options === 'string') {
    return options;
  }

  const { baseDir = process.cwd(), env, legacy, path: explicitPath } = options;

  // Explicit path takes priority
  if (explicitPath) {
    return explicitPath;
  }

  if (legacy) throw new LockFileError('Legacy lock-file structure is not supported');

  if (!env) {
    throw new LockFileError('Environment is required when no lock path is provided');
  }
  return getEnvironmentPaths({ baseDir, env }).lock;
}

/**
 * Get lock file path for new structure
 */
export function getNewLockFilePath(baseDir: string, env: string): string {
  return getEnvironmentPaths({ baseDir, env }).lock;
}

/**
 * Get lock file path for legacy structure
 */
export function getLegacyLockFilePath(baseDir: string): string {
  return getLegacyPaths(baseDir, 'default').lock;
}

/**
 * Check if lock file exists for an environment
 * Checks the fresh-install structure.
 */
export function lockFileExists(baseDir: string, env: string): boolean {
  return existsSync(getEnvironmentPaths({ baseDir, env }).lock);
}

// =============================================================================
// Lock File Operations
// =============================================================================

/**
 * Save lock file to disk
 *
 * Supports both:
 * - New structure: .authrim/{env}/lock.json
 * - Legacy structure: authrim-lock.json
 *
 * @param lock - Lock data to save
 * @param options - Options for path resolution, or direct path string (legacy)
 */
export async function saveLockFile(
  lock: AuthrimLock,
  options: LockFileOptions | string = {}
): Promise<void> {
  const path = resolveLockFilePath(options);

  // Ensure parent directory exists
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  lock.updatedAt = new Date().toISOString();
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(lock, null, 2), 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    const directoryHandle = await open(dir, 'r').catch(() => undefined);
    if (directoryHandle) {
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export interface EnvironmentOperationLock {
  path: string;
  release: () => Promise<void>;
}

export interface LockedEnvironmentOperation extends EnvironmentOperationLock {
  lock: AuthrimLock | null;
  lockFilePath: string;
}

export const DEPLOY_CONFIG_LOCK_FILE = 'deploy-config.operation-lock';

const DEPLOY_CONFIG_LOCK_PROOF_BRAND: unique symbol = Symbol('authrim.deploy-config-lock-proof');

/**
 * Opaque, runtime-verifiable evidence that this process still owns one exact workspace lock.
 * It can only be obtained from acquireDeployConfigLock(); callers cannot self-assert ownership.
 */
export interface DeployConfigLockProof {
  readonly [DEPLOY_CONFIG_LOCK_PROOF_BRAND]: true;
  assertOwned(input: { baseDir: string; env: string }): Promise<void>;
}

interface DeployConfigLockProofState {
  path: string;
  identity: FileIdentity;
  owner: OperationLockOwner;
  resolvedBaseDir: string;
  isReleased: () => boolean;
}

const DEPLOY_CONFIG_LOCK_PROOF_STATES = new WeakMap<
  DeployConfigLockProof,
  DeployConfigLockProofState
>();

export interface DeployConfigLock extends EnvironmentOperationLock {
  readonly proof: DeployConfigLockProof;
}

/** Verify that a proof was issued by this module and still owns its exact lock inode. */
export async function assertDeployConfigLockProofOwned(
  proof: DeployConfigLockProof,
  expected: { baseDir: string; env: string }
): Promise<void> {
  const state = DEPLOY_CONFIG_LOCK_PROOF_STATES.get(proof);
  if (!state) {
    throw new Error('deploy_config_lock_proof_invalid');
  }
  if (state.isReleased()) {
    throw new Error('deploy_config_lock_proof_released');
  }
  if (resolve(expected.baseDir) !== state.resolvedBaseDir) {
    throw new Error('deploy_config_lock_proof_workspace_mismatch');
  }
  if (!state.owner.env || expected.env !== state.owner.env) {
    throw new Error('deploy_config_lock_proof_environment_mismatch');
  }
  const observed = await observeOperationLock(
    state.path,
    'deploy_config_operation_lock_unreadable'
  );
  if (
    !observed ||
    !sameFileIdentity(observed.identity, state.identity) ||
    observed.owner?.token !== state.owner.token ||
    observed.owner.pid !== state.owner.pid
  ) {
    throw new Error('deploy_config_lock_proof_ownership_lost');
  }
}

export interface DeployConfigLockInput {
  /** Authrim repository/workspace root containing package-level wrangler.toml files. */
  baseDir: string;
  operation: string;
  /** Diagnostic metadata only; every environment in the workspace shares this lock. */
  env?: string;
}

interface DeployConfigOperationLockOwner {
  token: string;
  pid: number;
  operation: string;
  env?: string;
  startedAt: string;
}

interface EnvironmentOperationLockOwner {
  token: string;
  pid: number;
  operation: string;
  startedAt: string;
}

interface OperationLockOwner {
  token: string;
  pid: number;
  operation: string;
  env?: string;
  startedAt: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface ObservedOperationLock {
  identity: FileIdentity;
  modifiedAtMs: number;
  owner: Partial<OperationLockOwner> | undefined;
}

const OPERATION_LOCK_RECOVERY_SUFFIX = '.recovery';
const OPERATION_LOCK_RECOVERY_ATTEMPTS = 32;
const OPERATION_LOCK_RECOVERY_RETRY_MS = 1;
const OPERATION_LOCK_RECLAIMER_GENERATIONS = 32;
const OPERATION_LOCK_HEARTBEAT_MS = 30 * 1_000;
const OPERATION_LOCK_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function waitForOperationLockRecovery(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, OPERATION_LOCK_RECOVERY_RETRY_MS));
}

async function observeOperationLock(
  path: string,
  unreadableCode: string
): Promise<ObservedOperationLock | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`${unreadableCode}:${path}`, { cause: error });
    }

    let owner: Partial<OperationLockOwner> | undefined;
    if (before.isFile()) {
      try {
        owner = JSON.parse(await readFile(path, 'utf-8')) as Partial<OperationLockOwner>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        if (!(error instanceof SyntaxError)) {
          throw new Error(`${unreadableCode}:${path}`, { cause: error });
        }
      }
    }

    let after: Awaited<ReturnType<typeof lstat>>;
    try {
      after = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`${unreadableCode}:${path}`, { cause: error });
    }
    const beforeIdentity = { dev: before.dev, ino: before.ino };
    const afterIdentity = { dev: after.dev, ino: after.ino };
    if (sameFileIdentity(beforeIdentity, afterIdentity)) {
      return { identity: afterIdentity, modifiedAtMs: after.mtimeMs, owner };
    }
  }
  throw new Error(`${unreadableCode}_changed:${path}`);
}

async function removeObservedOperationLock(
  path: string,
  observed: ObservedOperationLock
): Promise<boolean> {
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!sameFileIdentity(observed.identity, { dev: current.dev, ino: current.ino })) return false;
  await rm(path);
  return true;
}

function removeOwnedOperationLockSync(
  path: string,
  owner: OperationLockOwner,
  identity: FileIdentity
): void {
  try {
    const current = lstatSync(path);
    if (!sameFileIdentity(identity, { dev: current.dev, ino: current.ino })) return;
    const currentOwner = JSON.parse(readFileSync(path, 'utf-8')) as Partial<OperationLockOwner>;
    if (currentOwner.token !== owner.token || currentOwner.pid !== owner.pid) return;
    rmSync(path);
  } catch {
    // Process-exit cleanup is best effort. A surviving exact inode is recovered as stale later.
  }
}

async function removeOwnedOperationLock(
  path: string,
  owner: OperationLockOwner,
  identity: FileIdentity
): Promise<boolean> {
  const observed = await observeOperationLock(path, 'operation_lock_unreadable');
  if (
    !observed ||
    !sameFileIdentity(observed.identity, identity) ||
    observed.owner?.token !== owner.token ||
    observed.owner.pid !== owner.pid
  ) {
    return false;
  }
  return removeObservedOperationLock(path, observed);
}

function operationInProgressError(
  kind: 'environment' | 'deploy_config',
  owner: Partial<OperationLockOwner>
): Error {
  return kind === 'deploy_config'
    ? new Error(
        `deploy_config_operation_in_progress:${owner.operation ?? 'unknown'}:${owner.pid ?? 'unknown'}:${owner.env ?? 'unknown'}`
      )
    : new Error(
        `environment_operation_in_progress:${owner.operation ?? 'unknown'}:${owner.pid ?? 'unknown'}`
      );
}

function operationRecoveryIdentityPath(path: string, identity: FileIdentity): string {
  return `${path}.stale-${identity.dev}-${identity.ino}`;
}

async function ensureOperationRecoveryIdentityClaim(input: {
  kind: 'environment' | 'deploy_config';
  recoveryPath: string;
  observed: ObservedOperationLock;
}): Promise<{ path: string; identity: FileIdentity } | null> {
  const identityPath = operationRecoveryIdentityPath(input.recoveryPath, input.observed.identity);
  try {
    // This immutable hard link is deliberately retained. Besides proving which inode was
    // observed, retaining it prevents that dev/inode pair from being reused for a later lock.
    await link(input.recoveryPath, identityPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const identityClaim = await observeOperationLock(
    identityPath,
    `${input.kind}_operation_recovery_identity_unreadable`
  );
  if (!identityClaim || !sameFileIdentity(identityClaim.identity, input.observed.identity)) {
    // The fixed path changed before our hard-link syscall, or a conflicting claim already
    // exists. Do not unlink either path; the caller must re-observe the current generation.
    return null;
  }
  const current = await observeOperationLock(
    input.recoveryPath,
    `${input.kind}_operation_recovery_lock_unreadable`
  );
  if (!current || !sameFileIdentity(current.identity, input.observed.identity)) return null;
  return { path: identityPath, identity: identityClaim.identity };
}

async function acquireOperationReclaimerClaim(input: {
  kind: 'environment' | 'deploy_config';
  recoveryPath: string;
  staleIdentity: FileIdentity;
  identityClaim: { path: string; identity: FileIdentity };
  candidatePath: string;
  candidateIdentity: FileIdentity;
  owner: OperationLockOwner;
}): Promise<{ path: string; identity: FileIdentity } | null> {
  for (let generation = 0; generation < OPERATION_LOCK_RECLAIMER_GENERATIONS; generation += 1) {
    const current = await observeOperationLock(
      input.recoveryPath,
      `${input.kind}_operation_recovery_lock_unreadable`
    );
    if (!current || !sameFileIdentity(current.identity, input.staleIdentity)) return null;

    const reclaimerPath = `${input.identityClaim.path}.reclaimer-${generation}`;
    let reclaimerLinked = false;
    try {
      // A generation is append-only. If its winner crashes, later contenders preserve that
      // evidence and atomically elect exactly one winner in the next generation.
      await link(input.candidatePath, reclaimerPath);
      reclaimerLinked = true;
      const claimed = await observeOperationLock(
        reclaimerPath,
        `${input.kind}_operation_reclaimer_claim_unreadable`
      );
      if (
        !claimed ||
        !sameFileIdentity(claimed.identity, input.candidateIdentity) ||
        claimed.owner?.token !== input.owner.token ||
        claimed.owner.pid !== input.owner.pid
      ) {
        if (claimed && sameFileIdentity(claimed.identity, input.candidateIdentity)) {
          await removeOwnedOperationLock(reclaimerPath, input.owner, input.candidateIdentity).catch(
            () => false
          );
        }
        throw new Error(`${input.kind}_operation_reclaimer_claim_invalid`);
      }

      const identityClaim = await observeOperationLock(
        input.identityClaim.path,
        `${input.kind}_operation_recovery_identity_unreadable`
      );
      const after = await observeOperationLock(
        input.recoveryPath,
        `${input.kind}_operation_recovery_lock_unreadable`
      );
      if (
        !identityClaim ||
        !sameFileIdentity(identityClaim.identity, input.identityClaim.identity) ||
        !after ||
        !sameFileIdentity(after.identity, input.staleIdentity)
      ) {
        await removeOwnedOperationLock(reclaimerPath, input.owner, input.candidateIdentity).catch(
          () => false
        );
        return null;
      }
      return { path: reclaimerPath, identity: claimed.identity };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (reclaimerLinked) {
          await removeOwnedOperationLock(reclaimerPath, input.owner, input.candidateIdentity).catch(
            () => false
          );
        }
        throw error;
      }
    }

    const existing = await observeOperationLock(
      reclaimerPath,
      `${input.kind}_operation_reclaimer_claim_unreadable`
    );
    if (!existing) {
      generation -= 1;
      continue;
    }
    if (existing.owner?.pid && processIsAlive(existing.owner.pid)) {
      await waitForOperationLockRecovery();
      const after = await observeOperationLock(
        input.recoveryPath,
        `${input.kind}_operation_recovery_lock_unreadable`
      );
      if (!after || !sameFileIdentity(after.identity, input.staleIdentity)) return null;
      throw operationInProgressError(input.kind, existing.owner);
    }
  }
  throw new Error(`${input.kind}_operation_reclaimer_generations_exhausted`);
}

async function assertOperationReclaimerClaimOwned(input: {
  kind: 'environment' | 'deploy_config';
  claim: { path: string; identity: FileIdentity };
  owner: OperationLockOwner;
}): Promise<void> {
  const observed = await observeOperationLock(
    input.claim.path,
    `${input.kind}_operation_reclaimer_claim_unreadable`
  );
  if (
    !observed ||
    !sameFileIdentity(observed.identity, input.claim.identity) ||
    observed.owner?.token !== input.owner.token ||
    observed.owner.pid !== input.owner.pid
  ) {
    throw new Error(`${input.kind}_operation_reclaimer_claim_ownership_lost`);
  }
}

async function acquireOperationRecoveryGate(input: {
  kind: 'environment' | 'deploy_config';
  operationLockPath: string;
  candidatePath: string;
  candidateIdentity: FileIdentity;
  owner: OperationLockOwner;
}): Promise<{ path: string; identity: FileIdentity }> {
  const recoveryPath = `${input.operationLockPath}${OPERATION_LOCK_RECOVERY_SUFFIX}`;
  const unreadableCode = `${input.kind}_operation_recovery_lock_unreadable`;
  for (let attempt = 0; attempt < OPERATION_LOCK_RECOVERY_ATTEMPTS; attempt += 1) {
    let directlyLinked = false;
    try {
      await link(input.candidatePath, recoveryPath);
      directlyLinked = true;
      const claimed = await observeOperationLock(recoveryPath, unreadableCode);
      if (
        !claimed ||
        !sameFileIdentity(claimed.identity, input.candidateIdentity) ||
        claimed.owner?.token !== input.owner.token ||
        claimed.owner.pid !== input.owner.pid
      ) {
        throw new Error(`${input.kind}_operation_recovery_lock_claim_invalid`);
      }
      return { path: recoveryPath, identity: claimed.identity };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (directlyLinked) {
          await removeOwnedOperationLock(recoveryPath, input.owner, input.candidateIdentity).catch(
            () => false
          );
        }
        throw error;
      }
      const existing = await observeOperationLock(recoveryPath, unreadableCode);
      if (!existing) continue;
      if (existing.owner?.pid && processIsAlive(existing.owner.pid)) {
        if (attempt + 1 < OPERATION_LOCK_RECOVERY_ATTEMPTS) {
          await waitForOperationLockRecovery();
          continue;
        }
        throw operationInProgressError(input.kind, existing.owner);
      }

      const identityClaim = await ensureOperationRecoveryIdentityClaim({
        kind: input.kind,
        recoveryPath,
        observed: existing,
      });
      if (!identityClaim) continue;
      const reclaimer = await acquireOperationReclaimerClaim({
        kind: input.kind,
        recoveryPath,
        staleIdentity: existing.identity,
        identityClaim,
        candidatePath: input.candidatePath,
        candidateIdentity: input.candidateIdentity,
        owner: input.owner,
      });
      if (!reclaimer) continue;

      const staleCandidatePath =
        typeof existing.owner?.token === 'string' && OPERATION_LOCK_TOKEN.test(existing.owner.token)
          ? `${input.operationLockPath}.candidate-${existing.owner.token}`
          : undefined;
      let replacementLinked = false;
      try {
        await assertOperationReclaimerClaimOwned({
          kind: input.kind,
          claim: reclaimer,
          owner: input.owner,
        });
        const current = await observeOperationLock(recoveryPath, unreadableCode);
        if (!current || !sameFileIdentity(current.identity, existing.identity)) continue;
        // Only the elected, live reclaimer can reach this unlink. All other compliant actors
        // observe its immutable generation claim and cannot replace the fixed path underneath it.
        if (!(await removeObservedOperationLock(recoveryPath, current))) continue;
        if (staleCandidatePath) {
          const staleCandidate = await observeOperationLock(
            staleCandidatePath,
            `${input.kind}_operation_recovery_candidate_unreadable`
          ).catch(() => null);
          if (staleCandidate && sameFileIdentity(staleCandidate.identity, existing.identity)) {
            await removeObservedOperationLock(staleCandidatePath, staleCandidate).catch(
              () => false
            );
          }
        }
        await assertOperationReclaimerClaimOwned({
          kind: input.kind,
          claim: reclaimer,
          owner: input.owner,
        });
        try {
          await link(input.candidatePath, recoveryPath);
          replacementLinked = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          continue;
        }
        const claimed = await observeOperationLock(recoveryPath, unreadableCode);
        if (
          !claimed ||
          !sameFileIdentity(claimed.identity, input.candidateIdentity) ||
          claimed.owner?.token !== input.owner.token ||
          claimed.owner.pid !== input.owner.pid
        ) {
          if (claimed && sameFileIdentity(claimed.identity, input.candidateIdentity)) {
            await removeOwnedOperationLock(
              recoveryPath,
              input.owner,
              input.candidateIdentity
            ).catch(() => false);
          }
          throw new Error(`${input.kind}_operation_recovery_lock_claim_invalid`);
        }
        return { path: recoveryPath, identity: claimed.identity };
      } catch (error) {
        if (replacementLinked) {
          await removeOwnedOperationLock(recoveryPath, input.owner, input.candidateIdentity).catch(
            () => false
          );
        }
        throw error;
      } finally {
        await removeOwnedOperationLock(reclaimer.path, input.owner, reclaimer.identity).catch(
          () => false
        );
      }
    }
  }
  throw new Error(`${input.kind}_operation_recovery_lock_unavailable:${recoveryPath}`);
}

async function assertOperationRecoveryGateOwned(input: {
  kind: 'environment' | 'deploy_config';
  gate: { path: string; identity: FileIdentity };
  owner: OperationLockOwner;
}): Promise<void> {
  const observed = await observeOperationLock(
    input.gate.path,
    `${input.kind}_operation_recovery_lock_unreadable`
  );
  if (
    !observed ||
    !sameFileIdentity(observed.identity, input.gate.identity) ||
    observed.owner?.token !== input.owner.token ||
    observed.owner.pid !== input.owner.pid
  ) {
    throw new Error(`${input.kind}_operation_recovery_lock_ownership_lost`);
  }
}

async function acquireOperationLockPath(input: {
  kind: 'environment' | 'deploy_config';
  operationLockPath: string;
  candidatePath: string;
  owner: OperationLockOwner;
}): Promise<FileIdentity> {
  const candidate = await lstat(input.candidatePath);
  const candidateIdentity = { dev: candidate.dev, ino: candidate.ino };
  const gate = await acquireOperationRecoveryGate({ ...input, candidateIdentity });
  let claimedIdentity: FileIdentity | undefined;
  let mainLinkCreated = false;
  try {
    const existing = await observeOperationLock(
      input.operationLockPath,
      `${input.kind}_operation_lock_unreadable`
    );
    if (existing && operationLockLeaseIsActive(existing)) {
      throw operationInProgressError(input.kind, existing.owner ?? {});
    }
    if (existing) {
      // The fixed recovery gate serializes every protocol participant. Reconfirm the exact inode
      // immediately before unlinking so a previously observed stale pathname can never authorize
      // deletion of a later owner.
      await assertOperationRecoveryGateOwned({ kind: input.kind, gate, owner: input.owner });
      const current = await observeOperationLock(
        input.operationLockPath,
        `${input.kind}_operation_lock_unreadable`
      );
      if (!current || !sameFileIdentity(current.identity, existing.identity)) {
        throw new Error(`${input.kind}_operation_lock_changed_during_recovery`);
      }
      if (!(await removeObservedOperationLock(input.operationLockPath, current))) {
        throw new Error(`${input.kind}_operation_lock_changed_during_recovery`);
      }
    }

    await assertOperationRecoveryGateOwned({ kind: input.kind, gate, owner: input.owner });
    try {
      await link(input.candidatePath, input.operationLockPath);
      mainLinkCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const concurrent = await observeOperationLock(
        input.operationLockPath,
        `${input.kind}_operation_lock_unreadable`
      );
      if (concurrent) throw operationInProgressError(input.kind, concurrent.owner ?? {});
      throw new Error(`${input.kind}_operation_lock_unavailable:${input.operationLockPath}`);
    }
    const claimed = await observeOperationLock(
      input.operationLockPath,
      `${input.kind}_operation_lock_unreadable`
    );
    if (
      !claimed ||
      !sameFileIdentity(claimed.identity, candidateIdentity) ||
      claimed.owner?.token !== input.owner.token ||
      claimed.owner.pid !== input.owner.pid
    ) {
      throw new Error(`${input.kind}_operation_lock_claim_invalid`);
    }
    claimedIdentity = claimed.identity;
    return claimed.identity;
  } catch (error) {
    if (mainLinkCreated) {
      await removeOwnedOperationLock(
        input.operationLockPath,
        input.owner,
        claimedIdentity ?? candidateIdentity
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await removeOwnedOperationLock(gate.path, input.owner, gate.identity).catch(() => undefined);
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function operationLockLeaseIsActive(lock: ObservedOperationLock): boolean {
  const pid = lock.owner?.pid;
  // The heartbeat is diagnostic evidence, not authority to preempt a live owner. A suspended
  // terminal, sleeping host, blocked event loop, or long synchronous build can legitimately stop
  // mtime updates for an unbounded period while the process still owns Cloudflare/local mutation
  // state. Stealing in that window permits two setup processes to mutate the same environment.
  //
  // Fail closed while the recorded PID exists. Once it no longer exists, the inode-checked
  // recovery protocol above can safely elect exactly one replacement owner. A rare reused PID can
  // therefore delay automatic recovery, but never weakens mutual exclusion; stopping that process
  // makes the stale lock automatically recoverable on the next attempt.
  return Boolean(pid && processIsAlive(pid));
}

async function startOperationLockHeartbeat(input: {
  path: string;
  identity: FileIdentity;
}): Promise<() => Promise<void>> {
  const handle = await open(input.path, 'r+');
  const opened = await handle.stat();
  if (!sameFileIdentity(input.identity, { dev: opened.dev, ino: opened.ino })) {
    await handle.close();
    throw new Error(`operation_lock_heartbeat_identity_mismatch:${input.path}`);
  }
  let stopped = false;
  let update = Promise.resolve();
  const refresh = (): void => {
    update = update
      .then(async () => {
        if (stopped) return;
        const now = new Date();
        await handle.utimes(now, now);
      })
      // Heartbeats are diagnostic only: live-PID ownership is deliberately fail-closed. Attach
      // the rejection handler in the same turn that creates the promise so unlink/rename races
      // can never surface as an unhandled rejection while still letting release await the update.
      .catch(() => undefined);
  };
  const interval = setInterval(refresh, OPERATION_LOCK_HEARTBEAT_MS);
  interval.unref();
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    await update.catch(() => undefined);
    await handle.close();
  };
}

export function getDeployConfigLockPath(baseDir: string): string {
  return join(getAuthrimRoot(baseDir), DEPLOY_CONFIG_LOCK_FILE);
}

/**
 * Acquire the workspace-wide lock protecting generated package-level wrangler.toml files.
 *
 * Callers must acquire their environment operation lock first and release this
 * lock before releasing the environment lock. Acquisition is deliberately
 * fail-fast so a second environment can never wait and later deploy config that
 * was generated for the first environment.
 */
export async function acquireDeployConfigLock(
  input: DeployConfigLockInput
): Promise<DeployConfigLock> {
  const operation = input.operation.trim();
  if (!operation) {
    throw new Error('deploy_config_operation_lock_operation_required');
  }

  const operationLockPath = getDeployConfigLockPath(input.baseDir);
  const token = randomUUID();
  const candidatePath = `${operationLockPath}.candidate-${token}`;
  const owner: DeployConfigOperationLockOwner = {
    token,
    pid: process.pid,
    operation,
    ...(input.env ? { env: input.env } : {}),
    startedAt: new Date().toISOString(),
  };

  await mkdir(dirname(operationLockPath), { recursive: true, mode: 0o700 });
  await writeFile(candidatePath, JSON.stringify(owner, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
    flag: 'wx',
  });

  try {
    const identity = await acquireOperationLockPath({
      kind: 'deploy_config',
      operationLockPath,
      candidatePath,
      owner,
    });
    const stopHeartbeat = await startOperationLockHeartbeat({
      path: operationLockPath,
      identity,
    }).catch(async (error) => {
      await removeOwnedOperationLock(operationLockPath, owner, identity).catch(() => false);
      throw error;
    });
    const cleanupOnExit = (): void => {
      removeOwnedOperationLockSync(operationLockPath, owner, identity);
    };
    process.once('exit', cleanupOnExit);
    let released = false;
    const resolvedBaseDir = resolve(input.baseDir);
    let proof!: DeployConfigLockProof;
    proof = Object.freeze({
      [DEPLOY_CONFIG_LOCK_PROOF_BRAND]: true as const,
      assertOwned: (expected: { baseDir: string; env: string }) =>
        assertDeployConfigLockProofOwned(proof, expected),
    });
    DEPLOY_CONFIG_LOCK_PROOF_STATES.set(proof, {
      path: operationLockPath,
      identity,
      owner,
      resolvedBaseDir,
      isReleased: () => released,
    });
    return {
      path: operationLockPath,
      proof,
      release: async () => {
        if (released) return;
        await stopHeartbeat();
        await removeOwnedOperationLock(operationLockPath, owner, identity);
        released = true;
        process.off('exit', cleanupOnExit);
      },
    };
  } finally {
    await rm(candidatePath, { force: true }).catch(() => undefined);
  }
}

export async function withDeployConfigLock<T>(
  input: DeployConfigLockInput,
  callback: (operation: DeployConfigLock) => Promise<T>
): Promise<T> {
  const operation = await acquireDeployConfigLock(input);
  try {
    return await callback(operation);
  } finally {
    await operation.release();
  }
}

export async function acquireEnvironmentOperationLock(
  lockFilePath: string,
  operation: string
): Promise<EnvironmentOperationLock> {
  const operationLockPath = `${lockFilePath}.operation-lock`;
  const token = randomUUID();
  const candidatePath = `${operationLockPath}.candidate-${token}`;
  const owner: EnvironmentOperationLockOwner = {
    token,
    pid: process.pid,
    operation,
    startedAt: new Date().toISOString(),
  };

  await mkdir(dirname(operationLockPath), { recursive: true });
  await writeFile(candidatePath, JSON.stringify(owner, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    const identity = await acquireOperationLockPath({
      kind: 'environment',
      operationLockPath,
      candidatePath,
      owner,
    });
    const stopHeartbeat = await startOperationLockHeartbeat({
      path: operationLockPath,
      identity,
    }).catch(async (error) => {
      await removeOwnedOperationLock(operationLockPath, owner, identity).catch(() => false);
      throw error;
    });
    const cleanupOnExit = (): void => {
      removeOwnedOperationLockSync(operationLockPath, owner, identity);
    };
    process.once('exit', cleanupOnExit);
    let released = false;
    return {
      path: operationLockPath,
      release: async () => {
        if (released) return;
        await stopHeartbeat();
        await removeOwnedOperationLock(operationLockPath, owner, identity);
        released = true;
        process.off('exit', cleanupOnExit);
      },
    };
  } finally {
    await rm(candidatePath, { force: true }).catch(() => undefined);
  }
}

export async function acquireEnvironmentOperationForEnvironment(input: {
  baseDir: string;
  env: string;
  operation: string;
  requireExisting?: boolean;
}): Promise<LockedEnvironmentOperation> {
  const before = await loadLockFileAuto(input.baseDir, input.env);
  const lockFilePath =
    before.path ?? getEnvironmentPaths({ baseDir: input.baseDir, env: input.env }).lock;
  const operationLock = await acquireEnvironmentOperationLock(lockFilePath, input.operation);
  try {
    const after = await loadLockFileAuto(input.baseDir, input.env);
    if (JSON.stringify(after.lock) !== JSON.stringify(before.lock)) {
      throw new Error(`environment_changed_while_waiting_for_operation_lock:${input.operation}`);
    }
    if (input.requireExisting && !after.lock) {
      throw new Error(`environment_not_found:${input.env}`);
    }
    return {
      ...operationLock,
      lock: after.lock,
      lockFilePath: after.path ?? lockFilePath,
    };
  } catch (error) {
    await operationLock.release();
    throw error;
  }
}

export async function withEnvironmentOperationForEnvironment<T>(
  input: Parameters<typeof acquireEnvironmentOperationForEnvironment>[0],
  callback: (operation: LockedEnvironmentOperation) => Promise<T>
): Promise<T> {
  const operation = await acquireEnvironmentOperationForEnvironment(input);
  try {
    return await callback(operation);
  } finally {
    await operation.release();
  }
}

/** Error class for lock file operations */
export class LockFileError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'LockFileError';
  }
}

/**
 * Load lock file from disk
 *
 * Supports both:
 * - New structure: .authrim/{env}/lock.json
 * - Legacy structure: authrim-lock.json
 *
 * @param options - Options for path resolution, or direct path string (legacy)
 * @throws LockFileError if file exists but cannot be parsed
 */
export async function loadLockFile(
  options: LockFileOptions | string = {}
): Promise<AuthrimLock | null> {
  const path = resolveLockFilePath(options);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = await readFile(path, 'utf-8');
    const data = JSON.parse(content);
    return AuthrimLockSchema.parse(data);
  } catch (error) {
    // Re-throw with context for better debugging
    if (error instanceof SyntaxError) {
      throw new LockFileError('Invalid JSON in lock file', error);
    }
    if (error instanceof z.ZodError) {
      throw new LockFileError(
        `Invalid lock file schema: ${error.issues.map((i) => i.message).join(', ')}`,
        error
      );
    }
    throw new LockFileError('Failed to read lock file', error instanceof Error ? error : undefined);
  }
}

/**
 * Load a lock file from the fresh-install environment structure.
 */
export async function loadLockFileAuto(
  baseDir: string,
  env: string
): Promise<{ lock: AuthrimLock | null; path: string; type: 'new' | 'legacy' }> {
  const newPath = getEnvironmentPaths({ baseDir, env }).lock;
  const lock = await loadLockFile({ path: newPath });
  if (lock && lock.env !== env) {
    throw new LockFileError(
      `Lock environment identity mismatch: expected ${env}, found ${lock.env}`
    );
  }
  return { lock, path: newPath, type: 'new' };
}

/**
 * Verify every managed D1 lock entry against Cloudflare's current database list.
 *
 * A Cloudflare D1 UUID is immutable. A canonical name resolving to a different UUID therefore
 * means the original database was deleted and another resource now occupies its name. Adopting that
 * resource would silently point Workers at an empty or unrelated database, so reconciliation is
 * deliberately read-only and reports the identity drift for explicit recovery.
 */
export function reconcileD1ResourcesInLock(
  lock: AuthrimLock,
  env: string,
  databases: Array<{ name: string; uuid: string }>
): D1LockReconciliationResult {
  const databasesByName = new Map(databases.map((database) => [database.name, database]));
  const updatedBindings: string[] = [];
  const missingBindings: Array<{ binding: string; name: string }> = [];
  const identityMismatches: D1LockReconciliationResult['identityMismatches'] = [];
  const fixedBindings = new Set<string>(D1_DATABASES.map((database) => database.binding));

  for (const database of D1_DATABASES) {
    const expectedName = getD1DatabaseName(env, database.dbType);
    const liveDatabase = databasesByName.get(expectedName);
    if (!liveDatabase) {
      missingBindings.push({ binding: database.binding, name: expectedName });
      continue;
    }

    const lockedDatabase = lock.d1[database.binding];
    if (lockedDatabase?.name === liveDatabase.name && lockedDatabase.id === liveDatabase.uuid) {
      continue;
    }

    identityMismatches.push({
      binding: database.binding,
      expectedName,
      ...(lockedDatabase?.name ? { lockedName: lockedDatabase.name } : {}),
      ...(lockedDatabase?.id ? { lockedId: lockedDatabase.id } : {}),
      liveId: liveDatabase.uuid,
    });
  }

  for (const [binding, lockedDatabase] of Object.entries(lock.d1)) {
    if (fixedBindings.has(binding)) continue;
    if (!isTenantDatabaseBinding(binding)) continue;

    const liveDatabase = databasesByName.get(lockedDatabase.name);
    if (!liveDatabase) {
      missingBindings.push({ binding, name: lockedDatabase.name });
      continue;
    }
    if (lockedDatabase.id === liveDatabase.uuid) continue;

    identityMismatches.push({
      binding,
      expectedName: lockedDatabase.name,
      lockedName: lockedDatabase.name,
      lockedId: lockedDatabase.id,
      liveId: liveDatabase.uuid,
    });
  }

  return {
    lock,
    updatedBindings,
    missingBindings,
    identityMismatches,
  };
}

/**
 * Verify every canonical KV binding without adopting a same-name namespace with a different ID.
 */
export function reconcileSharedKVResourcesInLock(
  lock: AuthrimLock,
  env: string,
  namespaces: Array<{ title: string; id: string }>
): SharedKVLockReconciliationResult {
  const namespacesByTitle = new Map(namespaces.map((namespace) => [namespace.title, namespace]));
  const updatedBindings: string[] = [];
  const missingBindings: Array<{ binding: string; name: string }> = [];
  const identityMismatches: SharedKVLockReconciliationResult['identityMismatches'] = [];

  for (const binding of KV_NAMESPACES) {
    const expectedName = getKVNamespaceName(env, binding);
    const liveNamespace = namespacesByTitle.get(expectedName);
    if (!liveNamespace) {
      missingBindings.push({ binding, name: expectedName });
      continue;
    }

    const lockedNamespace = lock.kv[binding];
    if (lockedNamespace?.name === liveNamespace.title && lockedNamespace.id === liveNamespace.id) {
      continue;
    }

    identityMismatches.push({
      binding,
      expectedName,
      ...(lockedNamespace?.name ? { lockedName: lockedNamespace.name } : {}),
      ...(lockedNamespace?.id ? { lockedId: lockedNamespace.id } : {}),
      liveId: liveNamespace.id,
    });
  }

  return {
    lock,
    updatedBindings,
    missingBindings,
    identityMismatches,
  };
}

/**
 * Verify every setup-managed Queue without adopting or inventing an immutable Queue ID.
 *
 * Wrangler's human-readable Queue table can omit Queue IDs. A same-name row without an ID is
 * presence evidence only; it cannot prove that the Queue is the resource recorded in the lock.
 * Callers must therefore obtain an ID-complete provider inventory and this final guard still fails
 * closed if an incomplete or ambiguous row reaches it.
 *
 * `requiredQueues` comes from the persisted environment configuration. The union with the lock
 * entries ensures that a disabled feature does not stop protecting Queues that Setup still owns,
 * while an enabled feature cannot silently fall back to deterministic names when its lock entry is
 * absent.
 */
export function reconcileQueueResourcesInLock(
  lock: AuthrimLock,
  queues: Array<{ name: string; id?: string }>,
  requiredQueues: Array<{ binding: string; name: string }> = []
): QueueLockReconciliationResult {
  const expectedByBinding = new Map<string, { binding: string; name: string }>();
  for (const [binding, queue] of Object.entries(lock.queues ?? {})) {
    expectedByBinding.set(binding, { binding, name: queue.name });
  }
  for (const required of requiredQueues) {
    expectedByBinding.set(required.binding, required);
  }

  const queuesByName = new Map<string, Array<{ name: string; id?: string }>>();
  for (const queue of queues) {
    const matches = queuesByName.get(queue.name) ?? [];
    matches.push(queue);
    queuesByName.set(queue.name, matches);
  }

  const updatedBindings: string[] = [];
  const missingBindings: QueueLockReconciliationResult['missingBindings'] = [];
  const identityMismatches: QueueLockReconciliationResult['identityMismatches'] = [];

  for (const { binding, name: expectedName } of expectedByBinding.values()) {
    const lockedQueue = lock.queues?.[binding];
    const liveQueues = queuesByName.get(expectedName) ?? [];
    const liveQueue = liveQueues.length === 1 ? liveQueues[0] : undefined;

    if (!lockedQueue) {
      if (liveQueues.length === 0) {
        missingBindings.push({ binding, name: expectedName });
      } else {
        identityMismatches.push({
          binding,
          expectedName,
          ...(liveQueue?.id ? { liveId: liveQueue.id } : {}),
          reason: 'locked_identity_missing',
        });
      }
      continue;
    }

    if (lockedQueue.name !== expectedName) {
      identityMismatches.push({
        binding,
        expectedName,
        lockedName: lockedQueue.name,
        lockedId: lockedQueue.id,
        ...(liveQueue?.id ? { liveId: liveQueue.id } : {}),
        reason: 'locked_name_mismatch',
      });
      continue;
    }

    if (liveQueues.length === 0) {
      missingBindings.push({ binding, name: expectedName });
      continue;
    }
    if (liveQueues.length !== 1) {
      identityMismatches.push({
        binding,
        expectedName,
        lockedName: lockedQueue.name,
        lockedId: lockedQueue.id,
        reason: 'live_identity_ambiguous',
      });
      continue;
    }

    const liveId = liveQueue?.id?.trim();
    if (!liveId) {
      identityMismatches.push({
        binding,
        expectedName,
        lockedName: lockedQueue.name,
        lockedId: lockedQueue.id,
        reason: 'live_identity_unavailable',
      });
      continue;
    }
    if (!lockedQueue.id || lockedQueue.id !== liveId) {
      identityMismatches.push({
        binding,
        expectedName,
        lockedName: lockedQueue.name,
        ...(lockedQueue.id ? { lockedId: lockedQueue.id } : {}),
        liveId,
        reason: 'live_identity_mismatch',
      });
    }
  }

  return {
    lock,
    updatedBindings,
    missingBindings,
    identityMismatches,
  };
}

/**
 * Update worker deployment info in lock file
 */
export function updateWorkerDeployment(
  lock: AuthrimLock,
  workerName: string,
  deploymentName: string,
  version?: string
): AuthrimLock {
  if (!lock.workers) {
    lock.workers = {};
  }

  lock.workers[workerName] = {
    name: deploymentName,
    deployedAt: new Date().toISOString(),
    version,
  };

  return lock;
}

export function withProvisionalWorkerScriptOwnership(
  lock: AuthrimLock,
  input: { component: string; name: string; cloudflareScriptTag: string }
): AuthrimLock {
  const cloudflareScriptTag = requireCloudflareScriptTag(input.cloudflareScriptTag);
  const updatedAt = new Date().toISOString();
  return {
    ...lock,
    workerScriptOwnership: {
      ...lock.workerScriptOwnership,
      [input.component]: {
        name: input.name,
        cloudflareScriptTag,
        state: 'provisional',
        updatedAt,
      },
    },
    updatedAt,
  };
}

export function requireCloudflareScriptTag(value: string): string {
  const parsed = CloudflareScriptTagSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('invalid_cloudflare_worker_script_tag');
  }
  return parsed.data;
}

export function requireCloudflareVersionId(value: string): string {
  const parsed = CloudflareVersionIdSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new Error('invalid_cloudflare_worker_version_id');
  }
  return parsed.data;
}

/**
 * Journal a successful fresh Worker upload before the eventually-consistent script inventory has
 * exposed its immutable tag. This version is not ownership by itself: resume must match it against
 * Cloudflare's active version before promoting the checkpoint to an immutable tag.
 */
export function withPendingWorkerScriptVersionOwnership(
  lock: AuthrimLock,
  input: { component: string; name: string; pendingCloudflareVersionId: string }
): AuthrimLock {
  const parsedVersionId = requireCloudflareVersionId(input.pendingCloudflareVersionId);
  const updatedAt = new Date().toISOString();
  return {
    ...lock,
    workerScriptOwnership: {
      ...lock.workerScriptOwnership,
      [input.component]: {
        name: input.name,
        pendingCloudflareVersionId: parsedVersionId,
        state: 'pending_tag',
        updatedAt,
      },
    },
    updatedAt,
  };
}

export function clearProvisionalWorkerScriptOwnership(
  lock: AuthrimLock,
  components: readonly string[]
): AuthrimLock {
  if (!lock.workerScriptOwnership || components.length === 0) return lock;
  const remaining = { ...lock.workerScriptOwnership };
  for (const component of components) delete remaining[component];
  return {
    ...lock,
    workerScriptOwnership: Object.keys(remaining).length > 0 ? remaining : undefined,
  };
}

/**
 * Convert lock file to ResourceIds format for wrangler.ts
 */
export function lockToResourceIds(lock: AuthrimLock): {
  d1: Record<string, { id: string; name: string }>;
  kv: Record<string, { id: string; name: string }>;
  queues?: Record<string, { id: string; name: string }>;
  r2?: Record<string, { name: string }>;
} {
  return {
    d1: lock.d1,
    kv: Object.fromEntries(
      Object.entries(lock.kv).map(([key, value]) => [key, { id: value.id, name: value.name }])
    ),
    queues: lock.queues,
    r2: lock.r2
      ? Object.fromEntries(
          Object.entries(lock.r2).map(([binding, bucket]) => [binding, { name: bucket.name }])
        )
      : undefined,
  };
}

/**
 * Merge two lock files (for updating existing)
 */
export function mergeLockFiles(existing: AuthrimLock, newData: Partial<AuthrimLock>): AuthrimLock {
  return {
    ...existing,
    ...newData,
    d1: { ...existing.d1, ...newData.d1 },
    kv: { ...existing.kv, ...newData.kv },
    queues: { ...existing.queues, ...newData.queues },
    r2: { ...existing.r2, ...newData.r2 },
    pages: { ...existing.pages, ...newData.pages },
    workers: { ...existing.workers, ...newData.workers },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Validate that all required resources exist in lock file
 */
export function validateLockFile(lock: AuthrimLock): {
  valid: boolean;
  missing: string[];
} {
  const missing: string[] = [];

  // Check required D1 databases
  const requiredD1 = ['DB', 'PII_DB'];
  for (const binding of requiredD1) {
    if (!lock.d1[binding]) {
      missing.push(`D1: ${binding}`);
    }
  }

  // Check required KV namespaces
  const requiredKV = ['CLIENTS_CACHE', 'SETTINGS', 'AUTHRIM_CONFIG', 'USER_CACHE'];
  for (const binding of requiredKV) {
    if (!lock.kv[binding]) {
      missing.push(`KV: ${binding}`);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Generate summary of resources in lock file
 */
export function getLockFileSummary(lock: AuthrimLock): string {
  const lines: string[] = [
    `Environment: ${lock.env}`,
    `Created: ${lock.createdAt}`,
    `Updated: ${lock.updatedAt || 'N/A'}`,
    '',
    'D1 Databases:',
  ];

  for (const [binding, db] of Object.entries(lock.d1)) {
    lines.push(`  • ${binding}: ${db.name} (${db.id.slice(0, 8)}...)`);
  }

  lines.push('', 'KV Namespaces:');
  for (const [binding, kv] of Object.entries(lock.kv)) {
    lines.push(`  • ${binding}: ${kv.name} (${kv.id.slice(0, 8)}...)`);
  }

  if (lock.queues && Object.keys(lock.queues).length > 0) {
    lines.push('', 'Queues:');
    for (const [binding, q] of Object.entries(lock.queues)) {
      lines.push(`  • ${binding}: ${q.name}`);
    }
  }

  if (lock.r2 && Object.keys(lock.r2).length > 0) {
    lines.push('', 'R2 Buckets:');
    for (const [binding, r] of Object.entries(lock.r2)) {
      lines.push(`  • ${binding}: ${r.name}`);
    }
  }

  if (lock.workers && Object.keys(lock.workers).length > 0) {
    lines.push('', 'Workers:');
    for (const [name, w] of Object.entries(lock.workers)) {
      lines.push(`  • ${name}: ${w.name} (deployed: ${w.deployedAt || 'N/A'})`);
    }
  }

  return lines.join('\n');
}
