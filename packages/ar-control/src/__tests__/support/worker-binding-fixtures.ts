import { vi } from 'vitest';
import type { ControlEnv, RuntimeSmokeServiceBinding } from '../../types';
import type { WorkerBindingTarget, WorkerDeploymentLease } from '../../worker-binding-repository';

export const beforeSettings = {
  bindings: [{ name: 'DB', type: 'd1', database_id: 'shared-db' }],
  compatibility_date: '2026-07-01',
  compatibility_flags: ['nodejs_compat'],
  observability: { enabled: true },
};

export const reflectedSettings = {
  ...beforeSettings,
  bindings: [
    { name: 'DB', type: 'd1', database_id: 'shared-db' },
    { name: 'TEST_TDB_USERS_001', type: 'd1', database_id: 'tenant-db' },
  ],
};

export const oldDeployment = {
  id: 'deployment-old',
  created_on: '2026-07-29T00:00:00.000Z',
  source: 'api',
  strategy: 'percentage' as const,
  versions: [{ percentage: 100, version_id: 'version-old' }],
};

export const newDeployment = {
  id: 'deployment-new',
  created_on: '2026-07-29T00:00:01.000Z',
  source: 'api',
  strategy: 'percentage' as const,
  versions: [{ percentage: 100, version_id: 'version-new' }],
};

export function target(overrides: Partial<WorkerBindingTarget> = {}): WorkerBindingTarget {
  return {
    operationId: 'operation-1',
    environmentId: 'env-test',
    environmentName: 'test',
    workerScriptName: 'test-ar-auth',
    shardId: 'shard-1',
    bindingRef: 'TEST_TDB_USERS_001',
    dataRole: 'tenant_core/users',
    residencyPartition: 'global',
    migrationGeneration: 1,
    databaseId: 'tenant-db',
    state: 'pending',
    expectedSourceVersionId: null,
    previousDeploymentId: null,
    patchResultVersionId: null,
    patchResultDeploymentId: null,
    previousRestoreSettingsJson: null,
    smokeAttemptCount: 0,
    consecutiveSmokeSuccesses: 0,
    stabilizationNotBefore: null,
    lastErrorCode: null,
    manualSettingsRestoreRequested: false,
    ...overrides,
  };
}

export function lease(overrides: Partial<WorkerDeploymentLease> = {}): WorkerDeploymentLease {
  return {
    environmentId: 'env-test',
    workerScriptName: 'test-ar-auth',
    operationId: 'operation-1',
    fencingToken: 1,
    expectedSourceVersionId: 'version-old',
    mutationStarted: false,
    mutationStartedAt: null,
    previousDeploymentId: null,
    patchResultVersionId: null,
    patchResultDeploymentId: null,
    ...overrides,
  };
}

export async function signingKey(kid = 'smoke-key') {
  const generated = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  if (!('privateKey' in generated)) throw new Error('expected_crypto_key_pair');
  return {
    privateJwk: {
      ...(await crypto.subtle.exportKey('jwk', generated.privateKey)),
      kid,
      alg: 'EdDSA',
      use: 'sig',
    },
    kid,
  };
}

export function repositoryMock(targets: WorkerBindingTarget[], deploymentLease = lease()) {
  return {
    ensurePendingTargets: vi.fn().mockResolvedValue(undefined),
    listDueTargets: vi.fn().mockResolvedValue(targets),
    listDueTargetsForWorkers: vi.fn().mockResolvedValue(targets),
    acquireReconcilerLease: vi.fn().mockResolvedValue(true),
    releaseReconcilerLease: vi.fn().mockResolvedValue(true),
    acquireDeploymentLease: vi.fn().mockResolvedValue(deploymentLease),
    leaseIsCurrent: vi.fn().mockResolvedValue(true),
    releaseDeploymentLease: vi.fn().mockResolvedValue(true),
    recordAlreadySatisfied: vi.fn().mockResolvedValue(undefined),
    recordPatchStarted: vi.fn().mockResolvedValue(undefined),
    rearmPatchIntent: vi.fn().mockResolvedValue(true),
    recordPatchResult: vi.fn().mockResolvedValue(undefined),
    recordSmokeProgress: vi.fn().mockResolvedValue(undefined),
    adoptSupersedingSmokeDeployment: vi.fn().mockResolvedValue(undefined),
    markSucceeded: vi.fn().mockResolvedValue(undefined),
    markRollbackRequired: vi.fn().mockResolvedValue(undefined),
    recordTransientError: vi.fn().mockResolvedValue(undefined),
    markRolledBack: vi.fn().mockResolvedValue(undefined),
    markBlocked: vi.fn().mockResolvedValue(undefined),
    completeOperationIfReady: vi.fn().mockResolvedValue(true),
  };
}

export function inventoryMock(found = true) {
  return {
    getActiveDesiredWorker: vi.fn().mockResolvedValue(
      found
        ? {
            environment_id: 'env-test',
            worker_script_name: 'test-ar-auth',
            package_name: '@authrim/ar-auth',
            deployment_target: 'test-ar-auth',
            capability_manifest_digest: 'a'.repeat(64),
            source_kind: 'core_manifest',
            status: 'active',
          }
        : null
    ),
    markOperationAwaitingOperator: vi.fn().mockResolvedValue(undefined),
  };
}

export async function controlEnv(smoke?: RuntimeSmokeServiceBinding): Promise<ControlEnv> {
  const key = await signingKey();
  return {
    CONTROL_DB: {} as D1Database,
    MIGRATION_RELEASES: {} as ControlEnv['MIGRATION_RELEASES'],
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_D1_API_TOKEN: 'd1-token',
    CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
    SMOKE_RPC_SIGNING_JWK_SLOT_A: JSON.stringify(key.privateJwk),
    SMOKE_RPC_SIGNING_ACTIVE_SLOT: 'A',
    SMOKE_RPC_SIGNING_ACTIVE_KID: key.kid,
    SMOKE_AR_AUTH:
      smoke ??
      ({
        smokeTenantBinding: vi.fn().mockResolvedValue({
          bindingRef: 'TEST_TDB_USERS_001',
          migrationGeneration: 1,
          dataRole: 'tenant_core/users',
          residencyPartition: 'global',
          checkedAt: 1_800_000_000,
          observedVersionId: 'version-new',
          observedVersionTag: 'release',
          observedVersionTimestamp: '2026-07-29T00:00:01.000Z',
        }),
      } satisfies RuntimeSmokeServiceBinding),
  };
}
