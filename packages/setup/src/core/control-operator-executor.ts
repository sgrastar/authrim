import {
  CloudflareControlApiClient,
  ApiMigrationEngine,
  CONTROL_ENSURE_WORKER_BINDING_TARGETS_SQL,
  MigrationReleaseArtifactReader,
  activeWorkerDeployment,
  assertControlPlaneRecordIsSecretFree,
  ensureControlProvisioningD1,
  ensureWorkerBindingsPatched,
  ensureWorkerBindingPatched,
  executeControlProvisioningEffect,
  type CloudflareD1Query,
  type CloudflareD1QueryResult,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerBinding,
  type CloudflareWorkerSettings,
  type ControlProvisioningFailureDecision,
  type ReleaseArtifactObject,
  type ReleaseArtifactStore,
  type WorkerBindingPatchState,
} from '@authrim/ar-lib-core/control-plane';
import {
  getAccountId,
  getCloudflareApiToken,
  getR2ObjectBytes,
  refreshPinnedCloudflareOAuthToken,
  type CloudflareApiToken,
} from './cloudflare.js';
import type {
  PendingControlOperatorOperation,
  PendingTenantDisasterRecoveryOperatorOperation,
} from './control-operator-operations.js';

const LEASE_SECONDS = 5 * 60;
const WORKER_BINDING_LEASE_SECONDS = 15 * 60;

interface ClaimedOperationRow extends Record<string, unknown> {
  operation_id: string;
  environment_id: string;
  operation_kind: string;
  status: string;
  attempt_count: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  retry_budget_started_at: number | null;
  created_at: number;
  updated_at: number;
  fencing_token: number;
}

export interface SetupOperatorLease {
  operationId: string;
  environmentId: string;
  ownerId: string;
  fencingToken: number;
  attemptCount: number;
  createdAt: number;
  retryBudgetStartedAt: number;
}

export interface SetupOperatorExecutionResult {
  operationId: string;
  state:
    | 'awaiting_migration'
    | 'awaiting_worker_bindings'
    | 'awaiting_smoke'
    | 'awaiting_quarantine'
    | 'succeeded'
    | 'retry_required'
    | 'blocked'
    | 'lease_unavailable';
  errorCode: string | null;
  nextAttemptAt: number | null;
}

class SetupR2ReleaseArtifactStore implements ReleaseArtifactStore {
  constructor(
    private readonly bucketName: string,
    private readonly verifyBucketOwnership?: () => Promise<void>
  ) {}

  async get(key: string): Promise<ReleaseArtifactObject | null> {
    await this.verifyBucketOwnership?.();
    const bytes = await getR2ObjectBytes({
      bucketName: this.bucketName,
      objectKey: key,
      maxBytes: 16 * 1024 * 1024,
    });
    if (!bytes) return null;
    return {
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }
}

export interface SetupOperatorD1Client {
  listD1Databases: CloudflareControlApiClient['listD1Databases'];
  getD1Database: CloudflareControlApiClient['getD1Database'];
  createD1Database: CloudflareControlApiClient['createD1Database'];
  updateD1Database: CloudflareControlApiClient['updateD1Database'];
  queryD1: CloudflareControlApiClient['queryD1'];
  queryD1Batch(
    databaseId: string,
    batch: readonly CloudflareD1Query[]
  ): Promise<CloudflareD1QueryResult[]>;
}

export interface SetupOperatorControlClient extends SetupOperatorD1Client {
  getWorkerSettings(scriptName: string): Promise<CloudflareWorkerSettings>;
  patchWorkerSettings(
    scriptName: string,
    settings: CloudflareWorkerSettings
  ): Promise<CloudflareWorkerSettings>;
  listWorkerDeployments(scriptName: string): Promise<CloudflareWorkerDeployment[]>;
}

export function setupOperatorCredentialMap(token: string): {
  d1: string;
  workers: string;
  kv: string;
  r2: string;
} {
  const value = token.trim();
  if (!value) throw new Error('wrangler_oauth_credentials_required');
  return { d1: value, workers: value, kv: value, r2: value };
}

type SetupOperatorClientFactory = (accountId: string, token: string) => CloudflareControlApiClient;

function isRefreshableCloudflareAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const candidate = error as { status?: unknown; providerCodes?: unknown };
  return (
    candidate.status === 401 ||
    candidate.status === 403 ||
    (Array.isArray(candidate.providerCodes) && candidate.providerCodes.includes(10_000))
  );
}

/**
 * Build the short-lived Setup operator client used by Web/CLI orchestration.
 *
 * Control's split CLOUDFLARE_*_API_TOKEN secrets are deliberately not accepted here. Setup uses
 * Wrangler OAuth, or the generic CLOUDFLARE_API_TOKEN in headless operation. If Wrangler rotates
 * its OAuth access token during a long deployment, retry the rejected request once with a freshly
 * resolved, account-pinned credential.
 */
export function createRefreshingSetupOperatorClient(input: {
  accountId: string;
  credential: CloudflareApiToken;
  createClient?: SetupOperatorClientFactory;
  refreshOAuth?: typeof refreshPinnedCloudflareOAuthToken;
}): CloudflareControlApiClient {
  const createClient =
    input.createClient ??
    ((accountId: string, token: string) =>
      new CloudflareControlApiClient({
        accountId,
        tokens: setupOperatorCredentialMap(token),
      }));
  const refreshOAuth = input.refreshOAuth ?? refreshPinnedCloudflareOAuthToken;
  let credential = input.credential;
  let client = createClient(input.accountId, credential.token);
  let generation = 0;
  let refreshPromise: Promise<boolean> | null = null;

  const refresh = async (rejectedGeneration: number): Promise<boolean> => {
    if (credential.source !== 'oauth') return false;
    if (generation !== rejectedGeneration) return true;
    refreshPromise ??= (async () => {
      const refreshed = await refreshOAuth(input.accountId);
      if (!refreshed) return false;
      credential = refreshed;
      client = createClient(input.accountId, refreshed.token);
      generation += 1;
      return true;
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  };

  const invoke = async <T>(operation: (active: CloudflareControlApiClient) => Promise<T>) => {
    const requestGeneration = generation;
    try {
      return await operation(client);
    } catch (error) {
      if (!isRefreshableCloudflareAuthenticationError(error)) throw error;
      if (!(await refresh(requestGeneration))) throw error;
      return operation(client);
    }
  };

  // Proxy the complete client so plugin and cleanup operators receive the same refresh behavior
  // without maintaining a second, inevitably incomplete method list here.
  return new Proxy(client, {
    get(_target, property) {
      const value = Reflect.get(client, property, client) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        invoke(async (active) => {
          const method = Reflect.get(active, property, active) as (...values: unknown[]) => unknown;
          return (await method.apply(active, args)) as unknown;
        });
    },
  });
}

interface SetupWorkerBindingTarget {
  operationId: string;
  environmentId: string;
  environmentName: string;
  workerScriptName: string;
  shardId: string;
  bindingRef: string;
  dataRole: PendingControlOperatorOperation['dataRole'];
  residencyPartition: string;
  migrationGeneration: number;
  databaseId: string;
  state: 'pending';
  expectedSourceVersionId: string | null;
  previousDeploymentId: string | null;
  patchResultVersionId: string | null;
  patchResultDeploymentId: string | null;
  previousRestoreSettingsJson: string | null;
}

type PendingWorkerBindingOperation =
  | Pick<
      PendingControlOperatorOperation,
      | 'operationId'
      | 'environmentId'
      | 'currentStep'
      | 'shardId'
      | 'bindingRef'
      | 'dataRole'
      | 'residencyPartition'
      | 'migration'
    >
  | Pick<
      PendingTenantDisasterRecoveryOperatorOperation,
      'operationId' | 'environmentId' | 'currentStep' | 'bindingTargets'
    >;

interface SetupWorkerDeploymentLease {
  environmentId: string;
  workerScriptName: string;
  operationId: string;
  fencingToken: number;
  expectedSourceVersionId: string;
  mutationStarted: boolean;
  mutationStartedAt: number | null;
  previousDeploymentId: string | null;
  patchResultVersionId: string | null;
  patchResultDeploymentId: string | null;
  leaseExpiresAt: number;
}

function resultRows<T extends Record<string, unknown>>(
  result: CloudflareD1QueryResult | undefined
): T[] {
  if (!result || result.success !== true || !Array.isArray(result.results)) {
    throw new Error('control_operator_state_response_invalid');
  }
  return result.results.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('control_operator_state_response_invalid');
    }
    return row as T;
  });
}

function assertBatch(results: CloudflareD1QueryResult[], expected: number): void {
  if (results.length !== expected || results.some((result) => result.success !== true)) {
    throw new Error('control_operator_state_batch_failed');
  }
}

async function claimCreate(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  operation: PendingControlOperatorOperation;
  ownerId: string;
  now: number;
}): Promise<SetupOperatorLease | null> {
  const leaseExpiresAt = input.now + LEASE_SECONDS;
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_operations AS candidate
               SET status = 'running', attempt_count = attempt_count + 1,
                   next_attempt_at = NULL, last_error_code = NULL, last_error_redacted = NULL,
                   lock_owner = ?, lock_expires_at = ?, fencing_token = fencing_token + 1,
                   started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND operation_kind = 'provision_shard'
               AND status = 'blocked' AND last_error_code = 'operator_action_required'
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
               AND EXISTS (
                 SELECT 1 FROM control_operation_steps step
                  WHERE step.operation_id = candidate.operation_id
                    AND step.step_key = 'create_d1' AND step.status = 'blocked'
               )
               AND (
                 SELECT COUNT(*) FROM control_operations active
                  WHERE active.environment_id = candidate.environment_id
                    AND active.operation_kind = 'provision_shard'
                    AND active.status = 'running'
                    AND active.operation_id <> candidate.operation_id
               ) < COALESCE((
                 SELECT policy.max_concurrent_provisioning
                   FROM control_environment_resource_policies policy
                  WHERE policy.environment_id = candidate.environment_id
               ), 0)
             RETURNING operation_id, environment_id, operation_kind, status, attempt_count,
                       next_attempt_at, last_error_code, retry_budget_started_at,
                       created_at, updated_at, fencing_token`,
      params: [
        input.ownerId,
        leaseExpiresAt,
        input.now,
        input.now,
        input.operation.operationId,
        input.operation.environmentId,
        input.now,
      ],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'running', attempt_count = attempt_count + 1,
                   next_attempt_at = NULL, last_error_code = NULL, last_error_redacted = NULL,
                   started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE operation_id = ? AND step_key = 'create_d1' AND status = 'blocked'
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.lock_owner = ? AND operation.status = 'running'
               )`,
      params: [
        input.now,
        input.now,
        input.operation.operationId,
        input.operation.operationId,
        input.operation.environmentId,
        input.ownerId,
      ],
    },
    {
      sql: `UPDATE control_desired_resources
               SET provisioning_state = 'creating',
                   create_started_at = COALESCE(create_started_at, ?), updated_at = ?
             WHERE desired_resource_id = ? AND environment_id = ?
               AND origin_operation_id = ?
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.lock_owner = ?
                    AND operation.status = 'running'
               )`,
      params: [
        input.now,
        input.now,
        input.operation.desiredResourceId,
        input.operation.environmentId,
        input.operation.operationId,
        input.operation.operationId,
        input.ownerId,
      ],
    },
    {
      sql: `UPDATE control_tenant_shards
               SET status = 'provisioning', updated_at = ?
             WHERE shard_id = ? AND environment_id = ?
               AND d1_desired_resource_id = ?
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.lock_owner = ?
                    AND operation.status = 'running'
               )`,
      params: [
        input.now,
        input.operation.shardId,
        input.operation.environmentId,
        input.operation.desiredResourceId,
        input.operation.operationId,
        input.ownerId,
      ],
    },
    {
      sql: `SELECT operation.status AS operation_status,
                   operation.lock_owner, operation.fencing_token,
                   step.status AS step_status,
                   desired.provisioning_state, shard.status AS shard_status
              FROM control_operations operation
              JOIN control_operation_steps step
                ON step.operation_id = operation.operation_id AND step.step_key = 'create_d1'
              JOIN control_desired_resources desired
                ON desired.origin_operation_id = operation.operation_id
               AND desired.desired_resource_id = ?
              JOIN control_tenant_shards shard
                ON shard.d1_desired_resource_id = desired.desired_resource_id
               AND shard.shard_id = ?
             WHERE operation.operation_id = ? AND operation.environment_id = ?`,
      params: [
        input.operation.desiredResourceId,
        input.operation.shardId,
        input.operation.operationId,
        input.operation.environmentId,
      ],
    },
  ]);
  assertBatch(results, 5);
  const [row] = resultRows<ClaimedOperationRow>(results[0]);
  if (!row) return null;
  if (
    row.operation_id !== input.operation.operationId ||
    row.environment_id !== input.operation.environmentId ||
    row.operation_kind !== 'provision_shard' ||
    row.status !== 'running' ||
    !Number.isSafeInteger(row.attempt_count) ||
    !Number.isSafeInteger(row.created_at) ||
    !Number.isSafeInteger(row.fencing_token) ||
    row.fencing_token < 1
  ) {
    throw new Error('control_operator_lease_invalid');
  }
  const [reflected] = resultRows<Record<string, unknown>>(results[4]);
  if (
    !reflected ||
    reflected.operation_status !== 'running' ||
    reflected.lock_owner !== input.ownerId ||
    reflected.fencing_token !== row.fencing_token ||
    reflected.step_status !== 'running' ||
    reflected.provisioning_state !== 'creating' ||
    reflected.shard_status !== 'provisioning'
  ) {
    throw new Error('control_operator_lease_reflection_mismatch');
  }
  return {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    ownerId: input.ownerId,
    fencingToken: row.fencing_token,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    retryBudgetStartedAt: row.retry_budget_started_at ?? row.created_at,
  };
}

async function reserveCreate(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  lease: SetupOperatorLease;
  now: number;
}): Promise<boolean> {
  const budgetDay = Math.floor(input.now / 86_400);
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `INSERT OR IGNORE INTO control_d1_create_budget_reservations (
              operation_id, environment_id, budget_day, created_at
            )
            SELECT operation.operation_id, operation.environment_id, ?, ?
              FROM control_operations operation
              JOIN control_environment_resource_policies policy
                ON policy.environment_id = operation.environment_id
             WHERE operation.operation_id = ? AND operation.environment_id = ?
               AND operation.lock_owner = ? AND operation.fencing_token = ?
               AND operation.operation_kind = 'provision_shard'
               AND (
                 SELECT COUNT(*) FROM control_d1_create_budget_reservations reservation
                  WHERE reservation.environment_id = operation.environment_id
                    AND reservation.budget_day = ?
               ) < policy.daily_d1_create_budget`,
      params: [
        budgetDay,
        input.now,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
        budgetDay,
      ],
    },
    {
      sql: `SELECT operation_id FROM control_d1_create_budget_reservations
             WHERE operation_id = ? AND environment_id = ?`,
      params: [input.lease.operationId, input.lease.environmentId],
    },
  ]);
  assertBatch(results, 2);
  return resultRows<{ operation_id: string }>(results[1]).some(
    (row) => row.operation_id === input.lease.operationId
  );
}

async function markCreateIssued(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  operation: PendingControlOperatorOperation;
  lease: SetupOperatorLease;
  now: number;
}): Promise<void> {
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_desired_resources
               SET provider_create_state = 'issued', updated_at = ?
             WHERE desired_resource_id = ? AND environment_id = ? AND origin_operation_id = ?
               AND provider_create_state = 'not_started' AND provider_resource_id IS NULL
               AND provider_identity_checkpointed_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.lock_owner = ? AND operation.fencing_token = ?
                    AND operation.status = 'running'
               )`,
      params: [
        input.now,
        input.operation.desiredResourceId,
        input.operation.environmentId,
        input.operation.operationId,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
  ]);
  assertBatch(results, 1);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error('control_d1_create_issue_checkpoint_failed');
  }
}

async function markCreateDefinitelyRejected(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  operation: PendingControlOperatorOperation;
  lease: SetupOperatorLease;
  now: number;
}): Promise<void> {
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_desired_resources
               SET provider_create_state = 'not_started', updated_at = ?
             WHERE desired_resource_id = ? AND environment_id = ? AND origin_operation_id = ?
               AND provider_create_state = 'issued' AND provider_resource_id IS NULL
               AND provider_identity_checkpointed_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.lock_owner = ? AND operation.fencing_token = ?
                    AND operation.status = 'running'
               )`,
      params: [
        input.now,
        input.operation.desiredResourceId,
        input.operation.environmentId,
        input.operation.operationId,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
  ]);
  assertBatch(results, 1);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error('control_d1_create_rejection_checkpoint_failed');
  }
}

async function checkpointProviderIdentity(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  operation: PendingControlOperatorOperation;
  lease: SetupOperatorLease;
  databaseId: string;
  now: number;
}): Promise<void> {
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_desired_resources
               SET provider_create_state = 'identified', provider_resource_id = ?,
                   provider_identity_checkpointed_at = COALESCE(provider_identity_checkpointed_at, ?),
                   updated_at = ?
             WHERE desired_resource_id = ? AND environment_id = ? AND origin_operation_id = ?
               AND (provider_create_state = 'issued' OR
                    (provider_create_state = 'identified' AND provider_resource_id = ?))
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.lock_owner = ? AND operation.fencing_token = ?
                    AND operation.status = 'running'
               )`,
      params: [
        input.databaseId,
        input.now,
        input.now,
        input.operation.desiredResourceId,
        input.operation.environmentId,
        input.operation.operationId,
        input.databaseId,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
  ]);
  assertBatch(results, 1);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error('control_d1_provider_identity_checkpoint_failed');
  }
}

async function markCreateSucceeded(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  operation: PendingControlOperatorOperation;
  lease: SetupOperatorLease;
  databaseId: string;
  now: number;
}): Promise<SetupOperatorExecutionResult> {
  const observedId = `observed:${input.operation.desiredResourceId}`;
  const projectionAssertionId = `projection:${input.lease.operationId}:${input.lease.fencingToken}:setup`;
  const shardProjectionTable =
    input.operation.dataRole === 'lookup'
      ? 'control_lookup_physical_shards'
      : 'control_tenant_shards';
  const shardProjectionIdColumn =
    input.operation.dataRole === 'lookup' ? 'lookup_shard_id' : 'shard_id';
  const fence = [input.lease.operationId, input.lease.ownerId, input.lease.fencingToken] as const;
  const identity = [
    input.operation.desiredResourceId,
    input.operation.environmentId,
    input.databaseId,
  ] as const;
  const identityGuard = `EXISTS (
    SELECT 1 FROM control_desired_resources identity
     WHERE identity.desired_resource_id = ? AND identity.environment_id = ?
       AND identity.provider_create_state = 'identified'
       AND identity.provider_resource_id = ?
       AND identity.provider_identity_checkpointed_at IS NOT NULL
  )`;
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `INSERT INTO control_observed_resources (
              observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
              provider_name, resource_kind, ownership_fingerprint, observed_state,
              observed_spec_json, observed_at
            ) SELECT ?, ?, ?, ?, ?, 'd1', ?, 'present', '{}', ?
              WHERE EXISTS (
                SELECT 1 FROM control_operations operation
                 WHERE operation.operation_id = ? AND operation.lock_owner = ?
                   AND operation.fencing_token = ?
              ) AND ${identityGuard}
            ON CONFLICT(observed_resource_id) DO UPDATE SET
              provider_resource_id = excluded.provider_resource_id,
              provider_name = excluded.provider_name,
              ownership_fingerprint = excluded.ownership_fingerprint,
              observed_state = 'present', observed_at = excluded.observed_at
            WHERE EXISTS (
              SELECT 1 FROM control_operations operation
               WHERE operation.operation_id = ? AND operation.lock_owner = ?
                 AND operation.fencing_token = ?
            ) AND ${identityGuard}`,
      params: [
        observedId,
        input.operation.environmentId,
        input.operation.desiredResourceId,
        input.databaseId,
        input.operation.databaseName,
        input.operation.ownershipFingerprint,
        input.now,
        ...fence,
        ...identity,
        ...fence,
        ...identity,
      ],
    },
    {
      sql: `UPDATE control_tenant_database_migration_state
               SET provider_database_id = ?, state = 'requested', last_error_code = NULL,
                   updated_at = ?
             WHERE desired_resource_id = ? AND environment_id = ?
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.lock_owner = ?
                    AND operation.fencing_token = ?
               ) AND ${identityGuard}`,
      params: [
        input.databaseId,
        input.now,
        input.operation.desiredResourceId,
        input.operation.environmentId,
        ...fence,
        ...identity,
      ],
    },
    {
      sql: `UPDATE ${shardProjectionTable}
               SET read_replication_mode = ?, observed_replication_state = ?,
                   replication_checked_at = ?, replication_error_code = NULL, updated_at = ?
             WHERE ${shardProjectionIdColumn} = ? AND environment_id = ?
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.lock_owner = ?
                    AND operation.fencing_token = ?
               ) AND ${identityGuard}`,
      params: [
        input.operation.readReplicationMode,
        input.operation.readReplicationMode,
        input.now,
        input.now,
        input.operation.shardId,
        input.operation.environmentId,
        ...fence,
        ...identity,
      ],
    },
    {
      sql: `UPDATE control_desired_resources
               SET observed_resource_id = ?, provisioning_state = 'creating', updated_at = ?
             WHERE desired_resource_id = ? AND environment_id = ?
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.lock_owner = ?
                    AND operation.fencing_token = ?
               ) AND ${identityGuard}`,
      params: [
        observedId,
        input.now,
        input.operation.desiredResourceId,
        input.operation.environmentId,
        ...fence,
        ...identity,
      ],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'succeeded', observed_resource_id = ?, completed_at = ?, updated_at = ?
             WHERE operation_id = ? AND step_key = 'create_d1' AND status = 'running'
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.lock_owner = ?
                    AND operation.fencing_token = ?
               ) AND ${identityGuard}`,
      params: [
        input.databaseId,
        input.now,
        input.now,
        input.lease.operationId,
        ...fence,
        ...identity,
      ],
    },
    {
      sql: `UPDATE control_operations
               SET status = 'waiting_retry', next_attempt_at = NULL,
                   lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND lock_owner = ? AND fencing_token = ? AND ${identityGuard}`,
      params: [
        input.now,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
        ...identity,
      ],
    },
    {
      sql: `UPDATE control_operations
               SET status = 'blocked', next_attempt_at = NULL,
                   last_error_code = 'operator_action_required',
                   last_error_redacted = 'Continue this operation with setup.', updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND status = 'waiting_retry' AND fencing_token = ?`,
      params: [
        input.now,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'blocked', next_attempt_at = NULL,
                   last_error_code = 'operator_action_required',
                   last_error_redacted = 'Continue this operation with setup.', updated_at = ?
             WHERE operation_id = ? AND step_key = 'apply_migrations' AND status = 'queued'
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.status = 'blocked' AND operation.fencing_token = ?
               )`,
      params: [
        input.now,
        input.lease.operationId,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `INSERT INTO control_provider_identity_projection_assertions (
              assertion_id, environment_id, desired_resource_id, valid, created_at
            ) VALUES (?, ?, ?, CASE WHEN
              EXISTS (
                SELECT 1 FROM control_observed_resources observed
                 WHERE observed.observed_resource_id = ? AND observed.environment_id = ?
                   AND observed.desired_resource_id = ? AND observed.provider_resource_id = ?
                   AND observed.provider_name = ? AND observed.observed_state = 'present'
              ) AND EXISTS (
                SELECT 1 FROM control_tenant_database_migration_state migration
                 WHERE migration.desired_resource_id = ? AND migration.environment_id = ?
                   AND migration.operation_id = ? AND migration.provider_database_id = ?
                   AND migration.state = 'requested'
              ) AND EXISTS (
                SELECT 1 FROM ${shardProjectionTable} shard
                 WHERE shard.${shardProjectionIdColumn} = ? AND shard.environment_id = ?
                   AND shard.read_replication_mode = ?
                   AND shard.observed_replication_state = ?
              ) AND EXISTS (
                SELECT 1 FROM control_desired_resources desired
                 WHERE desired.desired_resource_id = ? AND desired.environment_id = ?
                   AND desired.observed_resource_id = ?
                   AND desired.provisioning_state = 'creating'
                   AND desired.provider_create_state = 'identified'
                   AND desired.provider_resource_id = ?
                   AND desired.provider_identity_checkpointed_at IS NOT NULL
              ) AND EXISTS (
                SELECT 1 FROM control_operation_steps create_step
                 WHERE create_step.operation_id = ? AND create_step.step_key = 'create_d1'
                   AND create_step.status = 'succeeded'
                   AND create_step.observed_resource_id = ?
              ) AND EXISTS (
                SELECT 1 FROM control_operation_steps migration_step
                 WHERE migration_step.operation_id = ?
                   AND migration_step.step_key = 'apply_migrations'
                   AND migration_step.status = 'blocked'
                   AND migration_step.last_error_code = 'operator_action_required'
              ) AND EXISTS (
                SELECT 1 FROM control_operations operation
                 WHERE operation.operation_id = ? AND operation.environment_id = ?
                   AND operation.status = 'blocked'
                   AND operation.last_error_code = 'operator_action_required'
                   AND operation.lock_owner IS NULL AND operation.lock_expires_at IS NULL
                   AND operation.fencing_token = ?
              ) THEN 1 ELSE 0 END, ?)`,
      params: [
        projectionAssertionId,
        input.operation.environmentId,
        input.operation.desiredResourceId,
        observedId,
        input.operation.environmentId,
        input.operation.desiredResourceId,
        input.databaseId,
        input.operation.databaseName,
        input.operation.desiredResourceId,
        input.operation.environmentId,
        input.operation.operationId,
        input.databaseId,
        input.operation.shardId,
        input.operation.environmentId,
        input.operation.readReplicationMode,
        input.operation.readReplicationMode,
        input.operation.desiredResourceId,
        input.operation.environmentId,
        observedId,
        input.databaseId,
        input.operation.operationId,
        input.databaseId,
        input.operation.operationId,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.fencingToken,
        input.now,
      ],
    },
    {
      sql: `DELETE FROM control_provider_identity_projection_assertions
             WHERE assertion_id = ? AND environment_id = ? AND desired_resource_id = ?`,
      params: [
        projectionAssertionId,
        input.operation.environmentId,
        input.operation.desiredResourceId,
      ],
    },
    {
      sql: `INSERT OR IGNORE INTO control_audit_events (
              event_id, environment_id, operation_id, event_type, actor_type,
              resource_kind, resource_id, outcome, redacted_payload_json, created_at
            ) SELECT ?, ?, ?, 'control.d1.create', 'setup', 'd1', ?, 'succeeded', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM control_operations operation
                 WHERE operation.operation_id = ? AND operation.environment_id = ?
                   AND operation.status = 'blocked' AND operation.fencing_token = ?
              )`,
      params: [
        `audit:${input.lease.operationId}:${input.lease.fencingToken}:setup-d1-created`,
        input.lease.environmentId,
        input.lease.operationId,
        input.operation.desiredResourceId,
        JSON.stringify({ provider_resource_id: input.databaseId }),
        input.now,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `SELECT operation.status AS operation_status,
                   operation.last_error_code AS operation_error_code,
                   operation.lock_owner, operation.fencing_token,
                   create_step.status AS create_status,
                   migration_step.status AS migration_status,
                   desired.observed_resource_id, migration.provider_database_id
              FROM control_operations operation
              JOIN control_operation_steps create_step
                ON create_step.operation_id = operation.operation_id
               AND create_step.step_key = 'create_d1'
              JOIN control_operation_steps migration_step
                ON migration_step.operation_id = operation.operation_id
               AND migration_step.step_key = 'apply_migrations'
              JOIN control_desired_resources desired
                ON desired.origin_operation_id = operation.operation_id
               AND desired.desired_resource_id = ?
               AND desired.provider_create_state = 'identified'
               AND desired.provider_resource_id = ?
               AND desired.provider_identity_checkpointed_at IS NOT NULL
              JOIN control_tenant_database_migration_state migration
                ON migration.operation_id = operation.operation_id
               AND migration.desired_resource_id = desired.desired_resource_id
             WHERE operation.operation_id = ? AND operation.environment_id = ?`,
      params: [
        input.operation.desiredResourceId,
        input.databaseId,
        input.lease.operationId,
        input.lease.environmentId,
      ],
    },
  ]);
  assertBatch(results, 12);
  const [reflected] = resultRows<Record<string, unknown>>(results[11]);
  if (
    !reflected ||
    reflected.operation_status !== 'blocked' ||
    reflected.operation_error_code !== 'operator_action_required' ||
    reflected.lock_owner !== null ||
    reflected.fencing_token !== input.lease.fencingToken ||
    reflected.create_status !== 'succeeded' ||
    reflected.migration_status !== 'blocked' ||
    reflected.observed_resource_id !== observedId ||
    reflected.provider_database_id !== input.databaseId
  ) {
    throw new Error('control_operator_create_commit_reflection_mismatch');
  }
  return {
    operationId: input.lease.operationId,
    state: 'awaiting_migration',
    errorCode: null,
    nextAttemptAt: null,
  };
}

async function markCreateFailure(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  lease: SetupOperatorLease;
  decision: ControlProvisioningFailureDecision;
  now: number;
}): Promise<SetupOperatorExecutionResult> {
  const retry = input.decision.disposition === 'retry';
  const operationCode = retry ? 'operator_action_required' : input.decision.code;
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_operations
               SET status = 'blocked', next_attempt_at = ?, last_error_code = ?,
                   last_error_redacted = ?, lock_owner = NULL, lock_expires_at = NULL,
                   updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND lock_owner = ? AND fencing_token = ?`,
      params: [
        input.decision.nextAttemptAt,
        operationCode,
        retry ? 'Retry this operation with setup.' : null,
        input.now,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'blocked', next_attempt_at = ?, last_error_code = ?,
                   last_error_redacted = NULL, updated_at = ?
             WHERE operation_id = ? AND step_key = 'create_d1' AND status = 'running'
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.status = 'blocked' AND operation.fencing_token = ?
               )`,
      params: [
        input.decision.nextAttemptAt,
        input.decision.code,
        input.now,
        input.lease.operationId,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `INSERT OR IGNORE INTO control_audit_events (
              event_id, environment_id, operation_id, event_type, actor_type,
              resource_kind, resource_id, outcome, redacted_payload_json, created_at
            ) SELECT ?, environment_id, operation_id, 'control.d1.create', 'setup',
                     'd1', NULL, ?, ?, ?
                FROM control_operations
               WHERE operation_id = ? AND environment_id = ?
                 AND status = 'blocked' AND fencing_token = ?`,
      params: [
        `audit:${input.lease.operationId}:${input.lease.fencingToken}:setup-create-${retry ? 'retry' : 'blocked'}`,
        retry ? 'failed' : 'blocked',
        JSON.stringify({
          error_code: input.decision.code,
          retry_at: input.decision.nextAttemptAt,
        }),
        input.now,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `SELECT operation.status AS operation_status,
                   operation.last_error_code AS operation_error_code,
                   operation.next_attempt_at, operation.lock_owner,
                   operation.fencing_token, step.status AS step_status,
                   step.last_error_code AS step_error_code
              FROM control_operations operation
              JOIN control_operation_steps step
                ON step.operation_id = operation.operation_id AND step.step_key = 'create_d1'
             WHERE operation.operation_id = ? AND operation.environment_id = ?`,
      params: [input.lease.operationId, input.lease.environmentId],
    },
  ]);
  assertBatch(results, 4);
  const [reflected] = resultRows<Record<string, unknown>>(results[3]);
  if (
    !reflected ||
    reflected.operation_status !== 'blocked' ||
    reflected.operation_error_code !== operationCode ||
    reflected.next_attempt_at !== input.decision.nextAttemptAt ||
    reflected.lock_owner !== null ||
    reflected.fencing_token !== input.lease.fencingToken ||
    reflected.step_status !== 'blocked' ||
    reflected.step_error_code !== input.decision.code
  ) {
    throw new Error('control_operator_create_failure_reflection_mismatch');
  }
  return {
    operationId: input.lease.operationId,
    state: retry ? 'retry_required' : 'blocked',
    errorCode: input.decision.code,
    nextAttemptAt: input.decision.nextAttemptAt,
  };
}

async function claimMigration(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  operation: PendingControlOperatorOperation;
  ownerId: string;
  now: number;
}): Promise<SetupOperatorLease | null> {
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_operations AS candidate
               SET status = 'running', attempt_count = attempt_count + 1,
                   next_attempt_at = NULL, last_error_code = NULL, last_error_redacted = NULL,
                   lock_owner = ?, lock_expires_at = ?, fencing_token = fencing_token + 1,
                   started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND operation_kind = 'provision_shard'
               AND (
                 (status = 'blocked' AND last_error_code = 'operator_action_required') OR
                 (status = 'running' AND last_error_code IS NULL
                   AND lock_expires_at IS NOT NULL AND lock_expires_at <= ?)
               )
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
               AND EXISTS (
                 SELECT 1 FROM control_operation_steps step
                  WHERE step.operation_id = candidate.operation_id
                    AND step.step_key = 'apply_migrations'
                    AND step.status IN ('blocked', 'running')
               )
               AND EXISTS (
                 SELECT 1 FROM control_tenant_database_migration_state migration
                  WHERE migration.operation_id = candidate.operation_id
                    AND migration.provider_database_id IS NOT NULL
                    AND migration.state IN ('requested', 'applying', 'waiting_retry', 'ready')
               )
               AND (
                 SELECT COUNT(*) FROM control_operations active
                  WHERE active.environment_id = candidate.environment_id
                    AND active.operation_kind = 'provision_shard'
                    AND active.status = 'running'
                    AND active.operation_id <> candidate.operation_id
               ) < COALESCE((
                 SELECT policy.max_concurrent_provisioning
                   FROM control_environment_resource_policies policy
                  WHERE policy.environment_id = candidate.environment_id
               ), 0)
             RETURNING operation_id, environment_id, operation_kind, status, attempt_count,
                       next_attempt_at, last_error_code, retry_budget_started_at,
                       created_at, updated_at, fencing_token`,
      params: [
        input.ownerId,
        input.now + LEASE_SECONDS,
        input.now,
        input.now,
        input.operation.operationId,
        input.operation.environmentId,
        input.now,
        input.now,
      ],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'running', attempt_count = attempt_count + 1,
                   next_attempt_at = NULL, last_error_code = NULL, last_error_redacted = NULL,
                   started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE operation_id = ? AND step_key = 'apply_migrations'
               AND status IN ('blocked', 'running')
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.lock_owner = ? AND operation.status = 'running'
               )`,
      params: [
        input.now,
        input.now,
        input.operation.operationId,
        input.operation.operationId,
        input.operation.environmentId,
        input.ownerId,
      ],
    },
    {
      sql: `UPDATE control_tenant_database_migration_state
               SET state = CASE WHEN state = 'ready' THEN 'ready' ELSE 'applying' END,
                   last_error_code = NULL,
                   started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND provider_database_id IS NOT NULL
               AND state IN ('requested', 'applying', 'waiting_retry', 'ready')
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.lock_owner = ?
                    AND operation.status = 'running'
               )`,
      params: [
        input.now,
        input.now,
        input.operation.operationId,
        input.operation.environmentId,
        input.operation.operationId,
        input.ownerId,
      ],
    },
    {
      sql: `SELECT operation.status AS operation_status,
                   operation.lock_owner, operation.fencing_token,
                   step.status AS step_status, migration.state AS migration_state
              FROM control_operations operation
              JOIN control_operation_steps step
                ON step.operation_id = operation.operation_id
               AND step.step_key = 'apply_migrations'
              JOIN control_tenant_database_migration_state migration
                ON migration.operation_id = operation.operation_id
             WHERE operation.operation_id = ? AND operation.environment_id = ?`,
      params: [input.operation.operationId, input.operation.environmentId],
    },
  ]);
  assertBatch(results, 4);
  const [row] = resultRows<ClaimedOperationRow>(results[0]);
  if (!row) return null;
  if (
    row.operation_id !== input.operation.operationId ||
    row.environment_id !== input.operation.environmentId ||
    row.operation_kind !== 'provision_shard' ||
    row.status !== 'running' ||
    !Number.isSafeInteger(row.attempt_count) ||
    !Number.isSafeInteger(row.created_at) ||
    !Number.isSafeInteger(row.fencing_token) ||
    row.fencing_token < 1
  ) {
    throw new Error('control_operator_lease_invalid');
  }
  const [reflected] = resultRows<Record<string, unknown>>(results[3]);
  if (
    !reflected ||
    reflected.operation_status !== 'running' ||
    reflected.lock_owner !== input.ownerId ||
    reflected.fencing_token !== row.fencing_token ||
    reflected.step_status !== 'running' ||
    !['applying', 'ready'].includes(String(reflected.migration_state))
  ) {
    throw new Error('control_operator_lease_reflection_mismatch');
  }
  return {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    ownerId: input.ownerId,
    fencingToken: row.fencing_token,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    retryBudgetStartedAt: row.retry_budget_started_at ?? row.created_at,
  };
}

async function writeSetupMigrationMetadata(input: {
  client: SetupOperatorD1Client;
  operation: PendingControlOperatorOperation;
  result: { totalFiles: number; lastFilename: string };
  now: number;
}): Promise<void> {
  const migration = input.operation.migration;
  if (!migration) throw new Error('control_operator_migration_state_missing');
  const response = await input.client.queryD1Batch(migration.databaseId, [
    {
      sql: `INSERT INTO authrim_control_plane_shard_metadata (
              singleton_id, binding_ref, data_role, residency_partition, migration_generation,
              release_id, manifest_digest, expected_file_count, last_filename, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(singleton_id) DO UPDATE SET
              binding_ref = excluded.binding_ref,
              data_role = excluded.data_role,
              residency_partition = excluded.residency_partition,
              migration_generation = excluded.migration_generation,
              release_id = excluded.release_id,
              manifest_digest = excluded.manifest_digest,
              expected_file_count = excluded.expected_file_count,
              last_filename = excluded.last_filename,
              updated_at = excluded.updated_at`,
      params: [
        input.operation.bindingRef,
        input.operation.dataRole,
        input.operation.residencyPartition,
        migration.generation,
        migration.releaseId,
        migration.manifestDigest,
        input.result.totalFiles,
        input.result.lastFilename,
        input.now,
      ],
    },
    {
      sql: `SELECT binding_ref, data_role, residency_partition, migration_generation,
                   release_id, manifest_digest, expected_file_count, last_filename
              FROM authrim_control_plane_shard_metadata
             WHERE singleton_id = 1`,
    },
  ]);
  assertBatch(response, 2);
  const [reflected] = resultRows<Record<string, unknown>>(response[1]);
  if (
    !reflected ||
    reflected.binding_ref !== input.operation.bindingRef ||
    reflected.data_role !== input.operation.dataRole ||
    reflected.residency_partition !== input.operation.residencyPartition ||
    reflected.migration_generation !== migration.generation ||
    reflected.release_id !== migration.releaseId ||
    reflected.manifest_digest !== migration.manifestDigest ||
    reflected.expected_file_count !== input.result.totalFiles ||
    reflected.last_filename !== input.result.lastFilename
  ) {
    throw new Error('control_migration_metadata_write_failed');
  }
}

async function markMigrationSucceeded(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  operation: PendingControlOperatorOperation;
  lease: SetupOperatorLease;
  result: {
    totalFiles: number;
    appliedFiles: number;
    skippedFiles: number;
    responseLossRecoveries: number;
    lastFilename: string;
  };
  now: number;
}): Promise<SetupOperatorExecutionResult> {
  const migration = input.operation.migration;
  if (!migration) throw new Error('control_operator_migration_state_missing');
  const sentinel = JSON.stringify({
    stream_id: migration.streamId,
    release_id: migration.releaseId,
    manifest_digest: migration.manifestDigest,
    applied_file_count: input.result.totalFiles,
    last_filename: input.result.lastFilename,
    state: 'ready',
  });
  const fence = [input.lease.operationId, input.lease.ownerId, input.lease.fencingToken] as const;
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_tenant_database_migration_state
               SET state = 'ready', expected_file_count = ?, applied_file_count = ?,
                   last_filename = ?, observed_sentinel_json = ?, last_error_code = NULL,
                   completed_at = ?, updated_at = ?
             WHERE desired_resource_id = ? AND operation_id = ? AND environment_id = ?
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.lock_owner = ?
                    AND operation.fencing_token = ?
               )`,
      params: [
        input.result.totalFiles,
        input.result.totalFiles,
        input.result.lastFilename,
        sentinel,
        input.now,
        input.now,
        input.operation.desiredResourceId,
        input.lease.operationId,
        input.lease.environmentId,
        ...fence,
      ],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'succeeded', progress_current = ?, progress_total = ?,
                   last_error_code = NULL, last_error_redacted = NULL,
                   completed_at = ?, updated_at = ?
             WHERE operation_id = ? AND step_key = 'apply_migrations' AND status = 'running'
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.lock_owner = ?
                    AND operation.fencing_token = ?
               )`,
      params: [
        input.result.totalFiles,
        input.result.totalFiles,
        input.now,
        input.now,
        input.lease.operationId,
        ...fence,
      ],
    },
    {
      sql: `UPDATE control_desired_resources
               SET provisioning_state = 'ready', updated_at = ?
             WHERE desired_resource_id = ? AND environment_id = ?
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.lock_owner = ?
                    AND operation.fencing_token = ?
               )`,
      params: [input.now, input.operation.desiredResourceId, input.lease.environmentId, ...fence],
    },
    {
      sql: `UPDATE control_tenant_shards SET status = 'ready', updated_at = ?
             WHERE shard_id = ? AND environment_id = ?
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.lock_owner = ?
                    AND operation.fencing_token = ?
               )`,
      params: [input.now, input.operation.shardId, input.lease.environmentId, ...fence],
    },
    {
      sql: `UPDATE control_operations
               SET status = 'waiting_retry', completed_at = NULL, next_attempt_at = NULL,
                   last_error_code = NULL, last_error_redacted = NULL,
                   lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND lock_owner = ? AND fencing_token = ?`,
      params: [
        input.now,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `UPDATE control_operations
               SET status = 'blocked', last_error_code = 'operator_action_required',
                   last_error_redacted = 'Continue this operation with setup.', updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND status = 'waiting_retry' AND fencing_token = ?`,
      params: [
        input.now,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'blocked', next_attempt_at = NULL,
                   last_error_code = 'operator_action_required',
                   last_error_redacted = 'Continue this operation with setup.', updated_at = ?
             WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'
               AND status = 'queued'
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.status = 'blocked' AND operation.fencing_token = ?
               )`,
      params: [
        input.now,
        input.lease.operationId,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `INSERT OR IGNORE INTO control_audit_events (
              event_id, environment_id, operation_id, event_type, actor_type,
              resource_kind, resource_id, outcome, redacted_payload_json, created_at
            ) SELECT ?, ?, ?, 'control.d1.migrate', 'setup', 'd1', ?, 'succeeded', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM control_operations operation
                 WHERE operation.operation_id = ? AND operation.environment_id = ?
                   AND operation.status = 'blocked' AND operation.fencing_token = ?
              )`,
      params: [
        `audit:${input.lease.operationId}:${input.lease.fencingToken}:setup-migration-ready`,
        input.lease.environmentId,
        input.lease.operationId,
        input.operation.desiredResourceId,
        JSON.stringify({
          stream_id: migration.streamId,
          release_id: migration.releaseId,
          total_files: input.result.totalFiles,
          applied_files: input.result.appliedFiles,
          skipped_files: input.result.skippedFiles,
          response_loss_recoveries: input.result.responseLossRecoveries,
        }),
        input.now,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `SELECT operation.status AS operation_status,
                   operation.last_error_code AS operation_error_code,
                   operation.lock_owner, operation.fencing_token,
                   migration.state AS migration_state,
                   migration.expected_file_count, migration.applied_file_count,
                   migration.last_filename,
                   migration_step.status AS migration_step_status,
                   binding_step.status AS binding_step_status,
                   desired.provisioning_state, shard.status AS shard_status
              FROM control_operations operation
              JOIN control_tenant_database_migration_state migration
                ON migration.operation_id = operation.operation_id
               AND migration.desired_resource_id = ?
              JOIN control_operation_steps migration_step
                ON migration_step.operation_id = operation.operation_id
               AND migration_step.step_key = 'apply_migrations'
              JOIN control_operation_steps binding_step
                ON binding_step.operation_id = operation.operation_id
               AND binding_step.step_key = 'reconcile_worker_bindings'
              JOIN control_desired_resources desired
                ON desired.desired_resource_id = migration.desired_resource_id
              JOIN control_tenant_shards shard
                ON shard.d1_desired_resource_id = desired.desired_resource_id
             WHERE operation.operation_id = ? AND operation.environment_id = ?`,
      params: [
        input.operation.desiredResourceId,
        input.lease.operationId,
        input.lease.environmentId,
      ],
    },
  ]);
  assertBatch(results, 9);
  const [reflected] = resultRows<Record<string, unknown>>(results[8]);
  if (
    !reflected ||
    reflected.operation_status !== 'blocked' ||
    reflected.operation_error_code !== 'operator_action_required' ||
    reflected.lock_owner !== null ||
    reflected.fencing_token !== input.lease.fencingToken ||
    reflected.migration_state !== 'ready' ||
    reflected.expected_file_count !== input.result.totalFiles ||
    reflected.applied_file_count !== input.result.totalFiles ||
    reflected.last_filename !== input.result.lastFilename ||
    reflected.migration_step_status !== 'succeeded' ||
    reflected.binding_step_status !== 'blocked' ||
    reflected.provisioning_state !== 'ready' ||
    reflected.shard_status !== 'ready'
  ) {
    throw new Error('control_operator_migration_commit_reflection_mismatch');
  }
  return {
    operationId: input.lease.operationId,
    state: 'awaiting_worker_bindings',
    errorCode: null,
    nextAttemptAt: null,
  };
}

async function markMigrationFailure(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  lease: SetupOperatorLease;
  decision: ControlProvisioningFailureDecision;
  now: number;
}): Promise<SetupOperatorExecutionResult> {
  const retry = input.decision.disposition === 'retry';
  const operationCode = retry ? 'operator_action_required' : input.decision.code;
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_operations
               SET status = 'blocked', next_attempt_at = ?, last_error_code = ?,
                   last_error_redacted = ?, lock_owner = NULL, lock_expires_at = NULL,
                   updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND lock_owner = ? AND fencing_token = ?`,
      params: [
        input.decision.nextAttemptAt,
        operationCode,
        retry ? 'Retry this operation with setup.' : null,
        input.now,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'blocked', next_attempt_at = ?, last_error_code = ?,
                   last_error_redacted = NULL, updated_at = ?
             WHERE operation_id = ? AND step_key = 'apply_migrations' AND status = 'running'
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.status = 'blocked' AND operation.fencing_token = ?
               )`,
      params: [
        input.decision.nextAttemptAt,
        input.decision.code,
        input.now,
        input.lease.operationId,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `UPDATE control_tenant_database_migration_state
               SET state = ?, last_error_code = ?, updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.status = 'blocked'
                    AND operation.fencing_token = ?
               )`,
      params: [
        retry ? 'waiting_retry' : 'blocked',
        input.decision.code,
        input.now,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.operationId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `INSERT OR IGNORE INTO control_audit_events (
              event_id, environment_id, operation_id, event_type, actor_type,
              resource_kind, resource_id, outcome, redacted_payload_json, created_at
            ) SELECT ?, operation.environment_id, operation.operation_id,
                     'control.d1.migrate', 'setup', 'd1', migration.desired_resource_id,
                     ?, ?, ?
                FROM control_operations operation
                JOIN control_tenant_database_migration_state migration
                  ON migration.operation_id = operation.operation_id
               WHERE operation.operation_id = ? AND operation.environment_id = ?
                 AND operation.status = 'blocked' AND operation.fencing_token = ?`,
      params: [
        `audit:${input.lease.operationId}:${input.lease.fencingToken}:setup-migration-${retry ? 'retry' : 'blocked'}`,
        retry ? 'failed' : 'blocked',
        JSON.stringify({
          error_code: input.decision.code,
          retry_at: input.decision.nextAttemptAt,
        }),
        input.now,
        input.lease.operationId,
        input.lease.environmentId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `SELECT operation.status AS operation_status,
                   operation.last_error_code AS operation_error_code,
                   operation.next_attempt_at, operation.lock_owner,
                   operation.fencing_token, step.status AS step_status,
                   step.last_error_code AS step_error_code,
                   migration.state AS migration_state,
                   migration.last_error_code AS migration_error_code
              FROM control_operations operation
              JOIN control_operation_steps step
                ON step.operation_id = operation.operation_id
               AND step.step_key = 'apply_migrations'
              JOIN control_tenant_database_migration_state migration
                ON migration.operation_id = operation.operation_id
             WHERE operation.operation_id = ? AND operation.environment_id = ?`,
      params: [input.lease.operationId, input.lease.environmentId],
    },
  ]);
  assertBatch(results, 5);
  const [reflected] = resultRows<Record<string, unknown>>(results[4]);
  if (
    !reflected ||
    reflected.operation_status !== 'blocked' ||
    reflected.operation_error_code !== operationCode ||
    reflected.next_attempt_at !== input.decision.nextAttemptAt ||
    reflected.lock_owner !== null ||
    reflected.fencing_token !== input.lease.fencingToken ||
    reflected.step_status !== 'blocked' ||
    reflected.step_error_code !== input.decision.code ||
    reflected.migration_state !== (retry ? 'waiting_retry' : 'blocked') ||
    reflected.migration_error_code !== input.decision.code
  ) {
    throw new Error('control_operator_migration_failure_reflection_mismatch');
  }
  return {
    operationId: input.lease.operationId,
    state: retry ? 'retry_required' : 'blocked',
    errorCode: input.decision.code,
    nextAttemptAt: input.decision.nextAttemptAt,
  };
}

async function ensureSetupWorkerBindingTargets(input: {
  client: SetupOperatorControlClient;
  controlDatabaseId: string;
  operation: PendingWorkerBindingOperation;
  now: number;
}): Promise<SetupWorkerBindingTarget[]> {
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    { sql: CONTROL_ENSURE_WORKER_BINDING_TARGETS_SQL, params: [input.now, input.now] },
    {
      sql: `UPDATE control_operation_steps
               SET progress_total = (
                 SELECT COUNT(*) FROM control_worker_binding_reconciliations target
                  WHERE target.operation_id = control_operation_steps.operation_id
               ), progress_current = COALESCE(progress_current, 0), updated_at = ?
             WHERE operation_id = ? AND step_key IN (
               'reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings'
             )`,
      params: [input.now, input.operation.operationId],
    },
    {
      sql: `SELECT target.operation_id, target.environment_id, environment.environment_name,
                   target.worker_script_name, target.shard_id, target.binding_ref,
                   target.data_role, target.residency_partition, target.migration_generation,
                   target.provider_database_id, target.state,
                   target.expected_source_version_id, target.previous_deployment_id,
                   target.patch_result_version_id, target.patch_result_deployment_id,
                   target.previous_restore_settings_json
              FROM control_worker_binding_reconciliations target
              JOIN control_environments environment
                ON environment.environment_id = target.environment_id
             WHERE target.operation_id = ? AND target.environment_id = ?
               AND target.state = 'pending'
             ORDER BY target.worker_script_name, target.binding_ref`,
      params: [input.operation.operationId, input.operation.environmentId],
    },
    {
      sql: `SELECT COUNT(*) AS total_count,
                   SUM(CASE WHEN state = 'settings_patched' THEN 1 ELSE 0 END) AS patched_count
              FROM control_worker_binding_reconciliations
             WHERE operation_id = ? AND environment_id = ?`,
      params: [input.operation.operationId, input.operation.environmentId],
    },
  ]);
  assertBatch(results, 4);
  const rows = resultRows<Record<string, unknown>>(results[2]);
  const [summary] = resultRows<Record<string, unknown>>(results[3]);
  if (
    !summary ||
    !Number.isSafeInteger(summary.total_count) ||
    !Number.isSafeInteger(summary.patched_count) ||
    (summary.total_count as number) <= 0 ||
    (summary.patched_count as number) < 0 ||
    (summary.patched_count as number) > (summary.total_count as number)
  ) {
    throw new Error('control_worker_binding_targets_missing');
  }
  const expectedTargets =
    'bindingTargets' in input.operation
      ? input.operation.bindingTargets
      : [
          {
            workerScriptName: null,
            shardId: input.operation.shardId,
            bindingRef: input.operation.bindingRef,
            dataRole: input.operation.dataRole,
            residencyPartition: input.operation.residencyPartition,
            databaseId: input.operation.migration?.databaseId ?? null,
            migrationGeneration: input.operation.migration?.generation ?? null,
          },
        ];
  if (
    'bindingTargets' in input.operation &&
    (summary.total_count as number) !== expectedTargets.length
  ) {
    throw new Error('control_operator_worker_binding_target_invalid');
  }
  const targets = rows.map((row): SetupWorkerBindingTarget => {
    const expected = expectedTargets.find(
      (target) =>
        (target.workerScriptName === null || target.workerScriptName === row.worker_script_name) &&
        target.shardId === row.shard_id &&
        target.bindingRef === row.binding_ref &&
        target.dataRole === row.data_role &&
        target.residencyPartition === row.residency_partition &&
        target.databaseId === row.provider_database_id &&
        target.migrationGeneration === row.migration_generation
    );
    if (
      !expected ||
      row.operation_id !== input.operation.operationId ||
      row.environment_id !== input.operation.environmentId ||
      typeof row.environment_name !== 'string' ||
      typeof row.worker_script_name !== 'string' ||
      !row.worker_script_name.startsWith(`${row.environment_name}-`) ||
      row.state !== 'pending' ||
      (row.expected_source_version_id !== null &&
        typeof row.expected_source_version_id !== 'string') ||
      (row.previous_deployment_id !== null && typeof row.previous_deployment_id !== 'string') ||
      (row.patch_result_version_id !== null && typeof row.patch_result_version_id !== 'string') ||
      (row.patch_result_deployment_id !== null &&
        typeof row.patch_result_deployment_id !== 'string') ||
      (row.previous_restore_settings_json !== null &&
        typeof row.previous_restore_settings_json !== 'string')
    ) {
      throw new Error('control_operator_worker_binding_target_invalid');
    }
    return {
      operationId: input.operation.operationId,
      environmentId: input.operation.environmentId,
      environmentName: row.environment_name,
      workerScriptName: row.worker_script_name,
      shardId: expected.shardId,
      bindingRef: expected.bindingRef,
      dataRole: expected.dataRole,
      residencyPartition: expected.residencyPartition,
      migrationGeneration: expected.migrationGeneration ?? 0,
      databaseId: expected.databaseId ?? '',
      state: 'pending',
      expectedSourceVersionId: row.expected_source_version_id,
      previousDeploymentId: row.previous_deployment_id,
      patchResultVersionId: row.patch_result_version_id,
      patchResultDeploymentId: row.patch_result_deployment_id,
      previousRestoreSettingsJson: row.previous_restore_settings_json,
    };
  });
  if (
    targets.length === 0 &&
    (summary.patched_count as number) !== (summary.total_count as number)
  ) {
    throw new Error('control_operator_worker_binding_target_invalid');
  }
  return targets;
}

async function setupWorkerBindingTargetIsPatched(input: {
  client: SetupOperatorControlClient;
  controlDatabaseId: string;
  target: SetupWorkerBindingTarget;
}): Promise<boolean> {
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `SELECT state, patch_result_version_id, patch_result_deployment_id
              FROM control_worker_binding_reconciliations
             WHERE operation_id = ? AND environment_id = ? AND worker_script_name = ?
               AND binding_ref = ?`,
      params: [
        input.target.operationId,
        input.target.environmentId,
        input.target.workerScriptName,
        input.target.bindingRef,
      ],
    },
  ]);
  assertBatch(results, 1);
  const [row] = resultRows<Record<string, unknown>>(results[0]);
  if (!row) throw new Error('control_operator_worker_binding_target_invalid');
  if (row.state !== 'settings_patched') return false;
  if (
    typeof row.patch_result_version_id !== 'string' ||
    !row.patch_result_version_id ||
    typeof row.patch_result_deployment_id !== 'string' ||
    !row.patch_result_deployment_id
  ) {
    throw new Error('control_operator_worker_binding_target_invalid');
  }
  return true;
}

async function acquireSetupWorkerDeploymentLease(input: {
  client: SetupOperatorControlClient;
  controlDatabaseId: string;
  target: SetupWorkerBindingTarget;
  expectedSourceVersionId: string;
  now: number;
}): Promise<SetupWorkerDeploymentLease | null> {
  const expiresAt = input.now + WORKER_BINDING_LEASE_SECONDS;
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `INSERT INTO control_worker_deployment_leases (
              environment_id, worker_script_name, owner_operation_id, fencing_token,
              lease_expires_at, expected_source_version_id, mutation_started,
              mutation_started_at, updated_at
            ) VALUES (?, ?, ?, 1, ?, ?, 0, NULL, ?)
            ON CONFLICT(environment_id, worker_script_name) DO UPDATE SET
              owner_operation_id = excluded.owner_operation_id,
              fencing_token = control_worker_deployment_leases.fencing_token + 1,
              lease_expires_at = CASE
                WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
                 AND control_worker_deployment_leases.mutation_started = 1
                THEN control_worker_deployment_leases.lease_expires_at
                ELSE excluded.lease_expires_at
              END,
              expected_source_version_id = CASE
                WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
                 AND control_worker_deployment_leases.mutation_started = 1
                THEN control_worker_deployment_leases.expected_source_version_id
                ELSE excluded.expected_source_version_id
              END,
              mutation_started = CASE
                WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
                THEN control_worker_deployment_leases.mutation_started ELSE 0 END,
              mutation_started_at = CASE
                WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
                THEN control_worker_deployment_leases.mutation_started_at ELSE NULL END,
              previous_deployment_id = CASE
                WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
                THEN control_worker_deployment_leases.previous_deployment_id ELSE NULL END,
              patch_result_version_id = CASE
                WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
                THEN control_worker_deployment_leases.patch_result_version_id ELSE NULL END,
              patch_result_deployment_id = CASE
                WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
                THEN control_worker_deployment_leases.patch_result_deployment_id ELSE NULL END,
              updated_at = excluded.updated_at
            WHERE control_worker_deployment_leases.lease_expires_at <= excluded.updated_at
               OR control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id`,
      params: [
        input.target.environmentId,
        input.target.workerScriptName,
        input.target.operationId,
        expiresAt,
        input.expectedSourceVersionId,
        input.now,
      ],
    },
    {
      sql: `SELECT environment_id, worker_script_name, owner_operation_id, fencing_token,
                   expected_source_version_id, mutation_started, mutation_started_at,
                   previous_deployment_id,
                   patch_result_version_id, patch_result_deployment_id, lease_expires_at
              FROM control_worker_deployment_leases
             WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?`,
      params: [input.target.environmentId, input.target.workerScriptName, input.target.operationId],
    },
  ]);
  assertBatch(results, 2);
  const [row] = resultRows<Record<string, unknown>>(results[1]);
  if (!row) return null;
  if (
    row.environment_id !== input.target.environmentId ||
    row.worker_script_name !== input.target.workerScriptName ||
    row.owner_operation_id !== input.target.operationId ||
    !Number.isSafeInteger(row.fencing_token) ||
    typeof row.expected_source_version_id !== 'string' ||
    (row.mutation_started !== 0 && row.mutation_started !== 1) ||
    (row.mutation_started_at !== null &&
      row.mutation_started_at !== undefined &&
      !Number.isSafeInteger(row.mutation_started_at)) ||
    !Number.isSafeInteger(row.lease_expires_at) ||
    (row.lease_expires_at as number) < 1 ||
    (row.mutation_started === 0 && row.lease_expires_at !== expiresAt)
  ) {
    throw new Error('control_operator_worker_binding_lease_invalid');
  }
  return {
    environmentId: input.target.environmentId,
    workerScriptName: input.target.workerScriptName,
    operationId: input.target.operationId,
    fencingToken: row.fencing_token as number,
    expectedSourceVersionId: row.expected_source_version_id,
    mutationStarted: row.mutation_started === 1,
    mutationStartedAt: typeof row.mutation_started_at === 'number' ? row.mutation_started_at : null,
    previousDeploymentId: row.previous_deployment_id as string | null,
    patchResultVersionId: row.patch_result_version_id as string | null,
    patchResultDeploymentId: row.patch_result_deployment_id as string | null,
    leaseExpiresAt: row.lease_expires_at as number,
  };
}

async function resetExpiredUnappliedWorkerBindingMutation(input: {
  client: SetupOperatorControlClient;
  controlDatabaseId: string;
  target: SetupWorkerBindingTarget;
  lease: SetupWorkerDeploymentLease;
  now: number;
}): Promise<{
  target: SetupWorkerBindingTarget;
  lease: SetupWorkerDeploymentLease;
} | null> {
  if (!input.lease.mutationStarted || input.lease.leaseExpiresAt > input.now) return null;

  const deployments = await input.client.listWorkerDeployments(input.target.workerScriptName);
  const active = activeWorkerDeployment(deployments);
  if (
    active.versionId !== input.lease.expectedSourceVersionId ||
    active.deploymentId !== input.lease.previousDeploymentId
  ) {
    return null;
  }
  const settings = await input.client.getWorkerSettings(input.target.workerScriptName);
  const matchingBindings = Array.isArray(settings.bindings)
    ? settings.bindings.filter((binding) => binding.name === input.target.bindingRef)
    : [];
  if (matchingBindings.length !== 0) {
    throw new Error('control_worker_ambiguous_mutation_binding_present');
  }
  const activeImmediatelyBeforeReset = activeWorkerDeployment(
    await input.client.listWorkerDeployments(input.target.workerScriptName)
  );
  if (
    activeImmediatelyBeforeReset.versionId !== input.lease.expectedSourceVersionId ||
    activeImmediatelyBeforeReset.deploymentId !== input.lease.previousDeploymentId
  ) {
    throw new Error('control_worker_source_version_changed');
  }

  const nextLeaseExpiresAt = input.now + WORKER_BINDING_LEASE_SECONDS;
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_worker_deployment_leases
               SET mutation_started = 0, mutation_started_at = NULL, lease_expires_at = ?,
                   expected_source_version_id = ?, previous_deployment_id = NULL,
                   patch_result_version_id = NULL, patch_result_deployment_id = NULL,
                   updated_at = ?
             WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
               AND fencing_token = ? AND mutation_started = 1 AND lease_expires_at <= ?`,
      params: [
        nextLeaseExpiresAt,
        active.versionId,
        input.now,
        input.lease.environmentId,
        input.lease.workerScriptName,
        input.lease.operationId,
        input.lease.fencingToken,
        input.now,
      ],
    },
    {
      sql: `UPDATE control_worker_binding_reconciliations
               SET expected_source_version_id = NULL, previous_deployment_id = NULL,
                   patch_result_version_id = NULL, patch_result_deployment_id = NULL,
                   previous_restore_settings_json = NULL, last_error_code = NULL, updated_at = ?
             WHERE operation_id = ? AND environment_id = ? AND worker_script_name = ?
               AND binding_ref = ? AND state = 'pending' AND patch_result_version_id IS NULL
               AND patch_result_deployment_id IS NULL`,
      params: [
        input.now,
        input.target.operationId,
        input.target.environmentId,
        input.target.workerScriptName,
        input.target.bindingRef,
      ],
    },
    {
      sql: `UPDATE control_operations
               SET status = 'running', last_error_code = NULL, last_error_redacted = NULL,
                   next_attempt_at = NULL, updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND status IN ('waiting_retry', 'blocked', 'running')`,
      params: [input.now, input.target.operationId, input.target.environmentId],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'running', last_error_code = NULL, last_error_redacted = NULL,
                   next_attempt_at = NULL, updated_at = ?
             WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'
               AND status IN ('blocked', 'running')`,
      params: [input.now, input.target.operationId],
    },
    {
      sql: `SELECT lease.mutation_started, lease.lease_expires_at, lease.fencing_token,
                   target.state, target.expected_source_version_id,
                   operation.status AS operation_status, step.status AS step_status
              FROM control_worker_deployment_leases lease
              JOIN control_worker_binding_reconciliations target
                ON target.operation_id = lease.owner_operation_id
               AND target.environment_id = lease.environment_id
               AND target.worker_script_name = lease.worker_script_name
               AND target.binding_ref = ?
              JOIN control_operations operation ON operation.operation_id = target.operation_id
              JOIN control_operation_steps step ON step.operation_id = target.operation_id
               AND step.step_key = 'reconcile_worker_bindings'
             WHERE lease.environment_id = ? AND lease.worker_script_name = ?
               AND lease.owner_operation_id = ? AND lease.fencing_token = ?`,
      params: [
        input.target.bindingRef,
        input.lease.environmentId,
        input.lease.workerScriptName,
        input.lease.operationId,
        input.lease.fencingToken,
      ],
    },
  ]);
  assertBatch(results, 5);
  const [reflected] = resultRows<Record<string, unknown>>(results[4]);
  if (
    !reflected ||
    reflected.mutation_started !== 0 ||
    reflected.lease_expires_at !== nextLeaseExpiresAt ||
    reflected.fencing_token !== input.lease.fencingToken ||
    reflected.state !== 'pending' ||
    reflected.expected_source_version_id !== null ||
    reflected.operation_status !== 'running' ||
    reflected.step_status !== 'running'
  ) {
    throw new Error('control_worker_ambiguous_mutation_reset_failed');
  }

  return {
    target: {
      ...input.target,
      expectedSourceVersionId: null,
      previousDeploymentId: null,
      patchResultVersionId: null,
      patchResultDeploymentId: null,
      previousRestoreSettingsJson: null,
    },
    lease: {
      ...input.lease,
      expectedSourceVersionId: active.versionId,
      mutationStarted: false,
      mutationStartedAt: null,
      previousDeploymentId: null,
      patchResultVersionId: null,
      patchResultDeploymentId: null,
      leaseExpiresAt: nextLeaseExpiresAt,
    },
  };
}

function createSetupWorkerBindingPatchState(input: {
  client: SetupOperatorControlClient;
  controlDatabaseId: string;
}): WorkerBindingPatchState<SetupWorkerBindingTarget, SetupWorkerDeploymentLease> {
  const query = (batch: readonly CloudflareD1Query[]) =>
    input.client.queryD1Batch(input.controlDatabaseId, batch);
  return {
    leaseIsCurrent: async (lease, now) => {
      const results = await query([
        {
          sql: `SELECT 1 AS valid FROM control_worker_deployment_leases
                 WHERE environment_id = ? AND worker_script_name = ?
                   AND owner_operation_id = ? AND fencing_token = ? AND lease_expires_at > ?`,
          params: [
            lease.environmentId,
            lease.workerScriptName,
            lease.operationId,
            lease.fencingToken,
            now,
          ],
        },
      ]);
      assertBatch(results, 1);
      return resultRows<Record<string, unknown>>(results[0])[0]?.valid === 1;
    },
    recordAlreadySatisfied: async ({
      target,
      lease,
      versionId,
      deploymentId,
      settingsJson,
      now,
    }) => {
      const results = await query([
        {
          sql: `UPDATE control_operations
                   SET status = 'running', last_error_code = NULL, last_error_redacted = NULL,
                       next_attempt_at = NULL, updated_at = ?
                 WHERE operation_id = ? AND environment_id = ?
                   AND (status IN ('waiting_retry', 'running') OR
                        (status = 'blocked' AND last_error_code = 'operator_action_required'))`,
          params: [now, target.operationId, target.environmentId],
        },
        {
          sql: `UPDATE control_worker_deployment_leases
                   SET patch_result_version_id = ?, patch_result_deployment_id = ?, updated_at = ?
                 WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
                   AND fencing_token = ? AND lease_expires_at > ? AND mutation_started = 0`,
          params: [
            versionId,
            deploymentId,
            now,
            lease.environmentId,
            lease.workerScriptName,
            lease.operationId,
            lease.fencingToken,
            now,
          ],
        },
        {
          sql: `UPDATE control_worker_binding_reconciliations
                   SET state = 'settings_patched', expected_source_version_id = ?,
                       previous_deployment_id = ?, patch_result_version_id = ?,
                       patch_result_deployment_id = ?, previous_restore_settings_json = ?,
                       last_error_code = NULL, updated_at = ?
                 WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
                   AND state = 'pending' AND EXISTS (
                     SELECT 1 FROM control_worker_deployment_leases lease
                      WHERE lease.environment_id = ? AND lease.worker_script_name = ?
                        AND lease.owner_operation_id = ? AND lease.fencing_token = ?
                        AND lease.lease_expires_at > ? AND lease.mutation_started = 0
                   )`,
          params: [
            versionId,
            deploymentId,
            versionId,
            deploymentId,
            settingsJson,
            now,
            target.operationId,
            target.workerScriptName,
            target.bindingRef,
            lease.environmentId,
            lease.workerScriptName,
            lease.operationId,
            lease.fencingToken,
            now,
          ],
        },
        {
          sql: `UPDATE control_operation_steps
                   SET status = CASE WHEN COALESCE(progress_current, 0) + 1 >= progress_total
                                     THEN 'succeeded' ELSE 'running' END,
                       attempt_count = attempt_count + 1,
                       progress_current = MIN(progress_total, COALESCE(progress_current, 0) + 1),
                       started_at = COALESCE(started_at, ?),
                       completed_at = CASE WHEN COALESCE(progress_current, 0) + 1 >= progress_total
                                           THEN ? ELSE completed_at END,
                       last_error_code = NULL, last_error_redacted = NULL, updated_at = ?
                 WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'
                   AND status IN ('queued', 'running', 'blocked')`,
          params: [now, now, now, target.operationId],
        },
        {
          sql: `UPDATE control_operation_steps
                   SET status = 'running', attempt_count = attempt_count + 1,
                       started_at = COALESCE(started_at, ?), last_error_code = NULL,
                       last_error_redacted = NULL, next_attempt_at = NULL, updated_at = ?
                 WHERE operation_id = ? AND step_key = 'smoke_bindings'
                   AND (status = 'queued' OR
                        (status = 'blocked' AND last_error_code = 'operator_action_required'))
                   AND EXISTS (
                     SELECT 1 FROM control_operation_steps binding_step
                      WHERE binding_step.operation_id = control_operation_steps.operation_id
                        AND binding_step.step_key = 'reconcile_worker_bindings'
                        AND binding_step.status = 'succeeded'
                   )`,
          params: [now, now, target.operationId],
        },
        {
          sql: `SELECT target.state, target.patch_result_version_id,
                       target.patch_result_deployment_id, operation.status AS operation_status,
                       lease.patch_result_version_id AS lease_version_id,
                       lease.patch_result_deployment_id AS lease_deployment_id,
                       binding_step.status AS binding_step_status,
                       smoke_step.status AS smoke_step_status
                  FROM control_worker_binding_reconciliations target
                  JOIN control_worker_deployment_leases lease
                    ON lease.environment_id = target.environment_id
                   AND lease.worker_script_name = target.worker_script_name
                   AND lease.owner_operation_id = target.operation_id
                  JOIN control_operations operation
                    ON operation.operation_id = target.operation_id
                  JOIN control_operation_steps binding_step
                    ON binding_step.operation_id = target.operation_id
                   AND binding_step.step_key = 'reconcile_worker_bindings'
                  JOIN control_operation_steps smoke_step
                    ON smoke_step.operation_id = target.operation_id
                   AND smoke_step.step_key = 'smoke_bindings'
                 WHERE target.operation_id = ? AND target.worker_script_name = ?
                   AND target.binding_ref = ?`,
          params: [target.operationId, target.workerScriptName, target.bindingRef],
        },
      ]);
      assertBatch(results, 6);
      const [reflected] = resultRows<Record<string, unknown>>(results[5]);
      if (
        !reflected ||
        reflected.state !== 'settings_patched' ||
        reflected.patch_result_version_id !== versionId ||
        reflected.patch_result_deployment_id !== deploymentId ||
        reflected.lease_version_id !== versionId ||
        reflected.lease_deployment_id !== deploymentId ||
        reflected.operation_status !== 'running' ||
        !['running', 'succeeded'].includes(String(reflected.binding_step_status)) ||
        reflected.smoke_step_status !==
          (reflected.binding_step_status === 'succeeded' ? 'running' : 'queued')
      ) {
        throw new Error('control_worker_binding_already_satisfied_stale');
      }
    },
    recordPatchStarted: async ({
      target,
      lease,
      previousDeploymentId,
      restoreSettingsJson,
      now,
    }) => {
      const results = await query([
        {
          sql: `UPDATE control_operations
                   SET status = 'running', last_error_code = NULL, last_error_redacted = NULL,
                       next_attempt_at = NULL, updated_at = ?
                 WHERE operation_id = ? AND environment_id = ?
                   AND (status IN ('running', 'waiting_retry') OR
                        (status = 'blocked' AND last_error_code = 'operator_action_required'))`,
          params: [now, target.operationId, target.environmentId],
        },
        {
          sql: `UPDATE control_worker_deployment_leases
                   SET mutation_started = 1,
                       mutation_started_at = COALESCE(mutation_started_at, ?),
                       previous_deployment_id = ?, updated_at = ?
                 WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
                   AND fencing_token = ? AND lease_expires_at > ? AND mutation_started = 0`,
          params: [
            now,
            previousDeploymentId,
            now,
            lease.environmentId,
            lease.workerScriptName,
            lease.operationId,
            lease.fencingToken,
            now,
          ],
        },
        {
          sql: `UPDATE control_worker_binding_reconciliations
                   SET expected_source_version_id = ?, previous_deployment_id = ?,
                       previous_restore_settings_json = ?, last_error_code = NULL, updated_at = ?
                 WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
                   AND state = 'pending'`,
          params: [
            lease.expectedSourceVersionId,
            previousDeploymentId,
            restoreSettingsJson,
            now,
            target.operationId,
            target.workerScriptName,
            target.bindingRef,
          ],
        },
        {
          sql: `UPDATE control_operation_steps
                   SET status = 'running', attempt_count = attempt_count + 1,
                       last_error_code = NULL, last_error_redacted = NULL,
                       started_at = COALESCE(started_at, ?), updated_at = ?
                 WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'
                   AND status IN ('blocked', 'running')`,
          params: [now, now, target.operationId],
        },
        {
          sql: `SELECT operation.status AS operation_status, step.status AS step_status,
                       lease.mutation_started, lease.fencing_token,
                       target.expected_source_version_id, target.previous_deployment_id
                  FROM control_operations operation
                  JOIN control_operation_steps step ON step.operation_id = operation.operation_id
                   AND step.step_key = 'reconcile_worker_bindings'
                  JOIN control_worker_deployment_leases lease
                    ON lease.owner_operation_id = operation.operation_id
                   AND lease.environment_id = operation.environment_id
                   AND lease.worker_script_name = ?
                  JOIN control_worker_binding_reconciliations target
                    ON target.operation_id = operation.operation_id
                   AND target.worker_script_name = lease.worker_script_name
                   AND target.binding_ref = ?
                 WHERE operation.operation_id = ? AND operation.environment_id = ?`,
          params: [
            target.workerScriptName,
            target.bindingRef,
            target.operationId,
            target.environmentId,
          ],
        },
      ]);
      assertBatch(results, 5);
      const [reflected] = resultRows<Record<string, unknown>>(results[4]);
      if (
        !reflected ||
        reflected.operation_status !== 'running' ||
        reflected.step_status !== 'running' ||
        reflected.mutation_started !== 1 ||
        reflected.fencing_token !== lease.fencingToken ||
        reflected.expected_source_version_id !== lease.expectedSourceVersionId ||
        reflected.previous_deployment_id !== previousDeploymentId
      ) {
        throw new Error('control_worker_binding_stale_fencing_token');
      }
    },
    rearmPatchIntent: async ({ target, lease, now }) => {
      const results = await query([
        {
          sql: `UPDATE control_worker_deployment_leases
                   SET mutation_started = 0, mutation_started_at = NULL,
                       previous_deployment_id = NULL, updated_at = ?
                 WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
                   AND fencing_token = ? AND lease_expires_at > ?
                   AND mutation_started = 1 AND patch_result_version_id IS NULL
                   AND patch_result_deployment_id IS NULL`,
          params: [
            now,
            lease.environmentId,
            lease.workerScriptName,
            lease.operationId,
            lease.fencingToken,
            now,
          ],
        },
        {
          sql: `UPDATE control_worker_binding_reconciliations
                   SET expected_source_version_id = NULL, previous_deployment_id = NULL,
                       previous_restore_settings_json = NULL, last_error_code = NULL, updated_at = ?
                 WHERE operation_id = ? AND environment_id = ? AND worker_script_name = ?
                   AND binding_ref = ? AND state = 'pending'
                   AND patch_result_version_id IS NULL AND patch_result_deployment_id IS NULL
                   AND EXISTS (
                     SELECT 1 FROM control_worker_deployment_leases current_lease
                      WHERE current_lease.environment_id = ?
                        AND current_lease.worker_script_name = ?
                        AND current_lease.owner_operation_id = ?
                        AND current_lease.fencing_token = ?
                        AND current_lease.mutation_started = 0
                   )`,
          params: [
            now,
            target.operationId,
            target.environmentId,
            target.workerScriptName,
            target.bindingRef,
            lease.environmentId,
            lease.workerScriptName,
            lease.operationId,
            lease.fencingToken,
          ],
        },
        {
          sql: `SELECT mutation_started, mutation_started_at
                  FROM control_worker_deployment_leases
                 WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
                   AND fencing_token = ?`,
          params: [
            lease.environmentId,
            lease.workerScriptName,
            lease.operationId,
            lease.fencingToken,
          ],
        },
      ]);
      assertBatch(results, 3);
      const [reflected] = resultRows<Record<string, unknown>>(results[2]);
      return reflected?.mutation_started === 0 && reflected.mutation_started_at === null;
    },
    recordPatchResult: async ({ target, lease, versionId, deploymentId, now }) => {
      const results = await query([
        {
          sql: `UPDATE control_operations
                   SET status = 'running', last_error_code = NULL, last_error_redacted = NULL,
                       next_attempt_at = NULL, updated_at = ?
                 WHERE operation_id = ? AND environment_id = ?
                   AND (status = 'running' OR
                        (status = 'blocked' AND last_error_code = 'operator_action_required'))`,
          params: [now, target.operationId, target.environmentId],
        },
        {
          sql: `UPDATE control_operation_steps
                   SET status = 'running', attempt_count = attempt_count + 1,
                       last_error_code = NULL, last_error_redacted = NULL,
                       started_at = COALESCE(started_at, ?), updated_at = ?
                 WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'
                   AND status IN ('blocked', 'running')`,
          params: [now, now, target.operationId],
        },
        {
          sql: `UPDATE control_worker_deployment_leases
                   SET patch_result_version_id = ?, patch_result_deployment_id = ?, updated_at = ?
                 WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
                   AND fencing_token = ? AND mutation_started = 1`,
          params: [
            versionId,
            deploymentId,
            now,
            lease.environmentId,
            lease.workerScriptName,
            lease.operationId,
            lease.fencingToken,
          ],
        },
        {
          sql: `UPDATE control_worker_binding_reconciliations
                   SET state = 'settings_patched', patch_result_version_id = ?,
                       patch_result_deployment_id = ?, updated_at = ?
                 WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
                   AND state = 'pending'`,
          params: [
            versionId,
            deploymentId,
            now,
            target.operationId,
            target.workerScriptName,
            target.bindingRef,
          ],
        },
        {
          sql: `UPDATE control_operation_steps
                   SET progress_current = MIN(progress_total, COALESCE(progress_current, 0) + 1),
                       status = CASE WHEN COALESCE(progress_current, 0) + 1 >= progress_total
                                     THEN 'succeeded' ELSE status END,
                       completed_at = CASE WHEN COALESCE(progress_current, 0) + 1 >= progress_total
                                           THEN ? ELSE completed_at END,
                       updated_at = ?
                 WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'
                   AND status = 'running'`,
          params: [now, now, target.operationId],
        },
        {
          sql: `UPDATE control_operation_steps
                   SET status = 'running', attempt_count = attempt_count + 1,
                       started_at = COALESCE(started_at, ?), last_error_code = NULL,
                       last_error_redacted = NULL, next_attempt_at = NULL, updated_at = ?
                 WHERE operation_id = ? AND step_key = 'smoke_bindings'
                   AND (status = 'queued' OR
                        (status = 'blocked' AND last_error_code = 'operator_action_required'))
                   AND EXISTS (
                     SELECT 1 FROM control_operation_steps binding_step
                      WHERE binding_step.operation_id = control_operation_steps.operation_id
                        AND binding_step.step_key = 'reconcile_worker_bindings'
                        AND binding_step.status = 'succeeded'
                   )`,
          params: [now, now, target.operationId],
        },
        {
          sql: `SELECT target.state, target.patch_result_version_id,
                       target.patch_result_deployment_id, lease.fencing_token,
                       binding_step.status AS binding_step_status,
                       smoke_step.status AS smoke_step_status
                  FROM control_worker_binding_reconciliations target
                  JOIN control_worker_deployment_leases lease
                    ON lease.environment_id = target.environment_id
                   AND lease.worker_script_name = target.worker_script_name
                   AND lease.owner_operation_id = target.operation_id
                  JOIN control_operation_steps binding_step
                    ON binding_step.operation_id = target.operation_id
                   AND binding_step.step_key = 'reconcile_worker_bindings'
                  JOIN control_operation_steps smoke_step
                    ON smoke_step.operation_id = target.operation_id
                   AND smoke_step.step_key = 'smoke_bindings'
                 WHERE target.operation_id = ? AND target.worker_script_name = ?
                   AND target.binding_ref = ?`,
          params: [target.operationId, target.workerScriptName, target.bindingRef],
        },
      ]);
      assertBatch(results, 7);
      const [reflected] = resultRows<Record<string, unknown>>(results[6]);
      if (
        !reflected ||
        reflected.state !== 'settings_patched' ||
        reflected.patch_result_version_id !== versionId ||
        reflected.patch_result_deployment_id !== deploymentId ||
        reflected.fencing_token !== lease.fencingToken ||
        !['running', 'succeeded'].includes(String(reflected.binding_step_status)) ||
        reflected.smoke_step_status !==
          (reflected.binding_step_status === 'succeeded' ? 'running' : 'queued')
      ) {
        throw new Error('control_worker_binding_patch_result_stale');
      }
    },
    recordTransientError: async (target, errorCode, nextAttemptAt, now) => {
      const results = await query([
        {
          sql: `UPDATE control_worker_binding_reconciliations SET last_error_code = ?, updated_at = ?
                 WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
                   AND state = 'pending'`,
          params: [errorCode, now, target.operationId, target.workerScriptName, target.bindingRef],
        },
        {
          sql: `UPDATE control_operations
                   SET status = 'blocked', last_error_code = 'operator_action_required',
                       last_error_redacted = 'Retry this operation with setup.',
                       next_attempt_at = ?, updated_at = ?
                 WHERE operation_id = ? AND (
                   status = 'running' OR
                   (status = 'blocked' AND last_error_code = 'operator_action_required')
                 )`,
          params: [nextAttemptAt, now, target.operationId],
        },
        {
          sql: `UPDATE control_operation_steps
                   SET status = 'blocked', last_error_code = ?, next_attempt_at = ?, updated_at = ?
                 WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'
                   AND status IN ('running', 'blocked')`,
          params: [errorCode, nextAttemptAt, now, target.operationId],
        },
      ]);
      assertBatch(results, 3);
    },
    markRollbackRequired: async (target, errorCode, now) => {
      const results = await query([
        {
          sql: `UPDATE control_worker_binding_reconciliations
                   SET state = 'rollback_required', last_error_code = ?, updated_at = ?
                 WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
                   AND state = 'pending'`,
          params: [errorCode, now, target.operationId, target.workerScriptName, target.bindingRef],
        },
        {
          sql: `UPDATE control_operations SET status = 'blocked', last_error_code = ?,
                       last_error_redacted = NULL, next_attempt_at = NULL, updated_at = ?
                 WHERE operation_id = ? AND status = 'running'`,
          params: [errorCode, now, target.operationId],
        },
      ]);
      assertBatch(results, 2);
    },
    markBlocked: async (target, errorCode, now) => {
      const results = await query([
        {
          sql: `UPDATE control_worker_binding_reconciliations
                   SET state = CASE
                         WHEN expected_source_version_id IS NOT NULL
                          AND previous_restore_settings_json IS NOT NULL
                         THEN 'blocked' ELSE state END,
                       last_error_code = ?, updated_at = ?
                 WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
                   AND state <> 'settings_patched'`,
          params: [errorCode, now, target.operationId, target.workerScriptName, target.bindingRef],
        },
        {
          sql: `UPDATE control_operations SET status = 'blocked', last_error_code = ?,
                       last_error_redacted = NULL, next_attempt_at = NULL, updated_at = ?
                 WHERE operation_id = ? AND status IN ('running', 'blocked')`,
          params: [errorCode, now, target.operationId],
        },
        {
          sql: `UPDATE control_operation_steps
                   SET status = 'blocked', last_error_code = ?, next_attempt_at = NULL,
                       last_error_redacted = NULL, updated_at = ?
                 WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'
                   AND status IN ('running', 'blocked')`,
          params: [errorCode, now, target.operationId],
        },
      ]);
      assertBatch(results, 3);
    },
  };
}

export async function createSetupOperatorD1Client(
  input: {
    expectedAccountId?: string;
  } = {}
): Promise<CloudflareControlApiClient> {
  // Resolve the account first. For Wrangler OAuth this may refresh the cached credential; reading
  // the token in parallel can capture the expired pre-refresh value and fail the first operator
  // request even though account discovery succeeded.
  const accountId = await getAccountId();
  const token = await getCloudflareApiToken();
  if (!accountId || !token?.token) throw new Error('wrangler_oauth_credentials_required');
  if (input.expectedAccountId && accountId !== input.expectedAccountId) {
    throw new Error('control_operator_account_mismatch');
  }
  return createRefreshingSetupOperatorClient({
    accountId,
    credential: token,
  });
}

function setupWorkerBindingFailure(error: unknown): {
  code: string;
  permanent: boolean;
} {
  const status =
    error && typeof error === 'object' && !Array.isArray(error) && 'status' in error
      ? (error as { status?: unknown }).status
      : null;
  const message = error instanceof Error ? error.message : '';
  if (status === 401 || status === 403) {
    return { code: 'control_workers_capability_rejected', permanent: true };
  }
  if (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  ) {
    return { code: 'control_worker_settings_request_rejected', permanent: true };
  }
  if (
    message === 'control_worker_active_deployment_ambiguous' ||
    message === 'control_worker_source_version_changed' ||
    message === 'control_worker_binding_batch_conflict' ||
    message.startsWith('worker_settings_binding_') ||
    message.startsWith('worker_settings_payload_too_large')
  ) {
    return { code: message, permanent: true };
  }
  return { code: 'control_worker_settings_request_failed', permanent: false };
}

function setupWorkerBindingRetryAt(error: unknown, now: number): number {
  const value =
    error && typeof error === 'object' && !Array.isArray(error) && 'retryAfterSeconds' in error
      ? (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
      : null;
  const providerDelay =
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : 0;
  return now + Math.max(15, providerDelay);
}

function setupDesiredD1Bindings(
  targets: readonly SetupWorkerBindingTarget[]
): CloudflareWorkerBinding[] {
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

async function releaseSetupWorkerDeploymentLease(input: {
  client: SetupOperatorControlClient;
  controlDatabaseId: string;
  lease: SetupWorkerDeploymentLease;
}): Promise<void> {
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `DELETE FROM control_worker_deployment_leases
             WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
               AND fencing_token = ?`,
      params: [
        input.lease.environmentId,
        input.lease.workerScriptName,
        input.lease.operationId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `SELECT 1 AS lease_exists FROM control_worker_deployment_leases
             WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
               AND fencing_token = ?`,
      params: [
        input.lease.environmentId,
        input.lease.workerScriptName,
        input.lease.operationId,
        input.lease.fencingToken,
      ],
    },
  ]);
  assertBatch(results, 2);
  if (resultRows<Record<string, unknown>>(results[1]).length !== 0) {
    throw new Error('control_worker_deployment_lease_release_failed');
  }
}

async function setupWorkerBindingDurableRetryAt(input: {
  client: SetupOperatorControlClient;
  controlDatabaseId: string;
  operationId: string;
}): Promise<number | null> {
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `SELECT next_attempt_at FROM control_operations WHERE operation_id = ?`,
      params: [input.operationId],
    },
  ]);
  assertBatch(results, 1);
  const [row] = resultRows<Record<string, unknown>>(results[0]);
  if (!row) {
    throw new Error('control_operator_worker_binding_retry_state_invalid');
  }
  if (row.next_attempt_at === null) return null;
  if (!Number.isSafeInteger(row.next_attempt_at) || (row.next_attempt_at as number) < 1) {
    throw new Error('control_operator_worker_binding_retry_state_invalid');
  }
  return row.next_attempt_at as number;
}

export async function executeSetupControlOperatorWorkerBindings(input: {
  controlDatabaseId: string;
  operation: PendingWorkerBindingOperation;
  client?: SetupOperatorControlClient;
  expectedAccountId?: string;
  now?: () => number;
  interTargetDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onProgress?: (message: string) => void;
}): Promise<SetupOperatorExecutionResult> {
  if (
    input.operation.currentStep !== 'reconcile_worker_bindings' ||
    (!('bindingTargets' in input.operation) && !input.operation.migration)
  ) {
    throw new Error('control_operator_worker_binding_step_not_pending');
  }
  const client =
    input.client ??
    (await createSetupOperatorD1Client({ expectedAccountId: input.expectedAccountId }));
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const interTargetDelayMs = input.interTargetDelayMs ?? 0;
  if (
    !Number.isSafeInteger(interTargetDelayMs) ||
    interTargetDelayMs < 0 ||
    interTargetDelayMs > 60_000
  ) {
    throw new Error('control_operator_worker_binding_delay_invalid');
  }
  const sleep =
    input.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const targets = await ensureSetupWorkerBindingTargets({
    client,
    controlDatabaseId: input.controlDatabaseId,
    operation: input.operation,
    now: now(),
  });
  const state = createSetupWorkerBindingPatchState({
    client,
    controlDatabaseId: input.controlDatabaseId,
  });
  const targetsByWorker = new Map<string, SetupWorkerBindingTarget[]>();
  for (const target of targets) {
    const workerTargets = targetsByWorker.get(target.workerScriptName) ?? [];
    workerTargets.push(target);
    targetsByWorker.set(target.workerScriptName, workerTargets);
  }
  let targetIndex = 0;
  input.onProgress?.(`Setup operator is reconciling Worker bindings: 0/${targets.length} patched`);
  for (const workerTargets of targetsByWorker.values()) {
    let desiredBindings: CloudflareWorkerBinding[];
    try {
      desiredBindings = setupDesiredD1Bindings(workerTargets);
    } catch (error) {
      const failure = setupWorkerBindingFailure(error);
      const target = workerTargets[0];
      if (!target) continue;
      await state.markBlocked(target, failure.code, now());
      return {
        operationId: input.operation.operationId,
        state: 'blocked',
        errorCode: failure.code,
        nextAttemptAt: null,
      };
    }
    let offeredWorkerBatch = false;
    for (const target of workerTargets) {
      if (targetIndex > 0 && interTargetDelayMs > 0) {
        await sleep(interTargetDelayMs);
      }
      targetIndex += 1;
      let activeTarget = target;
      let activeLease: SetupWorkerDeploymentLease | null = null;
      try {
        const deployments = await client.listWorkerDeployments(target.workerScriptName);
        const active = activeWorkerDeployment(deployments);
        let lease = await acquireSetupWorkerDeploymentLease({
          client,
          controlDatabaseId: input.controlDatabaseId,
          target,
          expectedSourceVersionId: target.expectedSourceVersionId ?? active.versionId,
          now: now(),
        });
        if (!lease) {
          return {
            operationId: input.operation.operationId,
            state: 'lease_unavailable',
            errorCode: 'control_worker_deployment_lease_busy',
            nextAttemptAt: null,
          };
        }
        activeLease = lease;
        const recovered = await resetExpiredUnappliedWorkerBindingMutation({
          client,
          controlDatabaseId: input.controlDatabaseId,
          target,
          lease,
          now: now(),
        });
        if (recovered) {
          activeTarget = recovered.target;
          lease = recovered.lease;
          activeLease = lease;
        }
        const common = {
          target: activeTarget,
          lease,
          deploymentsBefore: deployments,
          activeBefore: active,
          api: client,
          state,
          now,
        };
        const useWorkerBatch = activeTarget.state === 'pending' && !offeredWorkerBatch;
        if (useWorkerBatch) offeredWorkerBatch = true;
        const result = useWorkerBatch
          ? await ensureWorkerBindingsPatched({ ...common, desiredBindings })
          : await ensureWorkerBindingPatched(common);
        if (result.state !== 'patched') {
          if (result.state === 'deferred') {
            // Surface the deadline persisted by the durable state machine instead of returning a
            // shorter UI retry that cannot yet make progress.
            const nextAttemptAt =
              (await setupWorkerBindingDurableRetryAt({
                client,
                controlDatabaseId: input.controlDatabaseId,
                operationId: input.operation.operationId,
              })) ?? now() + 15;
            const deferredResult: SetupOperatorExecutionResult = {
              operationId: input.operation.operationId,
              state: 'retry_required',
              errorCode: 'control_worker_patch_propagating',
              nextAttemptAt,
            };
            assertControlPlaneRecordIsSecretFree(deferredResult);
            return deferredResult;
          }
          return {
            operationId: input.operation.operationId,
            state: 'blocked',
            errorCode:
              result.state === 'rollback_required'
                ? 'control_worker_settings_preservation_failed'
                : 'control_worker_concurrent_deployment_detected',
            nextAttemptAt: null,
          };
        }
        await releaseSetupWorkerDeploymentLease({
          client,
          controlDatabaseId: input.controlDatabaseId,
          lease,
        });
        activeLease = null;
        input.onProgress?.(
          `Setup operator is reconciling Worker bindings: ${targetIndex}/${targets.length} patched`
        );
      } catch (error) {
        try {
          if (
            await setupWorkerBindingTargetIsPatched({
              client,
              controlDatabaseId: input.controlDatabaseId,
              target: activeTarget,
            })
          ) {
            if (activeLease) {
              await releaseSetupWorkerDeploymentLease({
                client,
                controlDatabaseId: input.controlDatabaseId,
                lease: activeLease,
              });
            }
            input.onProgress?.(
              `Setup operator is reconciling Worker bindings: ${targetIndex}/${targets.length} patched`
            );
            continue;
          }
        } catch {
          // Preserve the original failure classification when recovery or lease release cannot be
          // verified. The durable mutation checkpoint makes a later operator pass safe.
        }
        const failure = setupWorkerBindingFailure(error);
        if (failure.permanent) {
          await state.markBlocked(activeTarget, failure.code, now());
          return {
            operationId: input.operation.operationId,
            state: 'blocked',
            errorCode: failure.code,
            nextAttemptAt: null,
          };
        }
        const failedAt = now();
        const nextAttemptAt = setupWorkerBindingRetryAt(error, failedAt);
        await state.recordTransientError(activeTarget, failure.code, nextAttemptAt, failedAt);
        return {
          operationId: input.operation.operationId,
          state: 'retry_required',
          errorCode: failure.code,
          nextAttemptAt,
        };
      }
    }
  }

  const result: SetupOperatorExecutionResult = {
    operationId: input.operation.operationId,
    state: 'awaiting_smoke',
    errorCode: null,
    nextAttemptAt: null,
  };
  assertControlPlaneRecordIsSecretFree(result);
  return result;
}

export async function executeSetupControlOperatorCreate(input: {
  controlDatabaseId: string;
  operation: PendingControlOperatorOperation;
  client?: SetupOperatorD1Client;
  expectedAccountId?: string;
  executionId?: string;
  now?: () => number;
}): Promise<SetupOperatorExecutionResult> {
  if (input.operation.currentStep !== 'create_d1') {
    throw new Error('control_operator_create_step_not_pending');
  }
  const client =
    input.client ??
    (await createSetupOperatorD1Client({ expectedAccountId: input.expectedAccountId }));
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const ownerId = `setup:${input.executionId ?? crypto.randomUUID()}`;
  const lease = await claimCreate({
    client,
    controlDatabaseId: input.controlDatabaseId,
    operation: input.operation,
    ownerId,
    now: now(),
  });
  if (!lease) {
    return {
      operationId: input.operation.operationId,
      state: 'lease_unavailable',
      errorCode: 'control_concurrency_limited',
      nextAttemptAt: null,
    };
  }
  const result = await executeControlProvisioningEffect({
    executor: 'setup',
    effect: 'create_d1',
    operation: {
      operationId: lease.operationId,
      attemptCount: lease.attemptCount,
      createdAt: lease.createdAt,
      retryBudgetStartedAt: lease.retryBudgetStartedAt,
    },
    execute: () =>
      ensureControlProvisioningD1({
        plan: {
          databaseName: input.operation.databaseName,
          jurisdiction: input.operation.jurisdiction ?? undefined,
          locationHint: input.operation.locationHint ?? undefined,
          readReplicationMode: input.operation.readReplicationMode,
        },
        provider: client,
        checkpoint: {
          state: input.operation.providerCreateState,
          providerResourceId: input.operation.providerResourceId,
        },
        reserveCreate: () =>
          reserveCreate({
            client,
            controlDatabaseId: input.controlDatabaseId,
            lease,
            now: now(),
          }),
        markCreateIssued: () =>
          markCreateIssued({
            client,
            controlDatabaseId: input.controlDatabaseId,
            operation: input.operation,
            lease,
            now: now(),
          }),
        markCreateDefinitelyRejected: () =>
          markCreateDefinitelyRejected({
            client,
            controlDatabaseId: input.controlDatabaseId,
            operation: input.operation,
            lease,
            now: now(),
          }),
        checkpointProviderIdentity: (databaseId) =>
          checkpointProviderIdentity({
            client,
            controlDatabaseId: input.controlDatabaseId,
            operation: input.operation,
            lease,
            databaseId,
            now: now(),
          }),
      }),
    onSuccess: (databaseId) =>
      markCreateSucceeded({
        client,
        controlDatabaseId: input.controlDatabaseId,
        operation: input.operation,
        lease,
        databaseId,
        now: now(),
      }),
    onRetry: (decision) =>
      markCreateFailure({
        client,
        controlDatabaseId: input.controlDatabaseId,
        lease,
        decision,
        now: now(),
      }),
    onBlocked: (decision) =>
      markCreateFailure({
        client,
        controlDatabaseId: input.controlDatabaseId,
        lease,
        decision,
        now: now(),
      }),
    now,
  });
  assertControlPlaneRecordIsSecretFree(result);
  return result;
}

export async function executeSetupControlOperatorMigration(input: {
  controlDatabaseId: string;
  migrationReleaseBucketName: string;
  operation: PendingControlOperatorOperation;
  client?: SetupOperatorD1Client;
  expectedAccountId?: string;
  executionId?: string;
  artifactStore?: ReleaseArtifactStore;
  verifyMigrationReleaseBucketOwnership?: () => Promise<void>;
  now?: () => number;
}): Promise<SetupOperatorExecutionResult> {
  if (input.operation.currentStep !== 'apply_migrations' || !input.operation.migration) {
    throw new Error('control_operator_migration_step_not_pending');
  }
  const client =
    input.client ??
    (await createSetupOperatorD1Client({ expectedAccountId: input.expectedAccountId }));
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const ownerId = `setup:${input.executionId ?? crypto.randomUUID()}`;
  const lease = await claimMigration({
    client,
    controlDatabaseId: input.controlDatabaseId,
    operation: input.operation,
    ownerId,
    now: now(),
  });
  if (!lease) {
    return {
      operationId: input.operation.operationId,
      state: 'lease_unavailable',
      errorCode: 'control_concurrency_limited',
      nextAttemptAt: null,
    };
  }
  const migration = input.operation.migration;
  const engine = new ApiMigrationEngine(
    new MigrationReleaseArtifactReader(
      input.artifactStore ??
        new SetupR2ReleaseArtifactStore(
          input.migrationReleaseBucketName,
          input.verifyMigrationReleaseBucketOwnership
        )
    ),
    client,
    now
  );
  const result = await executeControlProvisioningEffect({
    executor: 'setup',
    effect: 'apply_migrations',
    operation: {
      operationId: lease.operationId,
      attemptCount: lease.attemptCount,
      createdAt: lease.createdAt,
      retryBudgetStartedAt: lease.retryBudgetStartedAt,
    },
    execute: async () => {
      const applied = await engine.apply({
        databaseId: migration.databaseId,
        pin: {
          environmentId: input.operation.environmentId,
          streamId: migration.streamId,
          releaseId: migration.releaseId,
          manifestDigest: migration.manifestDigest,
          manifestObjectKey: migration.manifestObjectKey,
        },
      });
      await writeSetupMigrationMetadata({
        client,
        operation: input.operation,
        result: applied,
        now: now(),
      });
      return applied;
    },
    onSuccess: (applied) =>
      markMigrationSucceeded({
        client,
        controlDatabaseId: input.controlDatabaseId,
        operation: input.operation,
        lease,
        result: applied,
        now: now(),
      }),
    onRetry: (decision) =>
      markMigrationFailure({
        client,
        controlDatabaseId: input.controlDatabaseId,
        lease,
        decision,
        now: now(),
      }),
    onBlocked: (decision) =>
      markMigrationFailure({
        client,
        controlDatabaseId: input.controlDatabaseId,
        lease,
        decision,
        now: now(),
      }),
    now,
  });
  assertControlPlaneRecordIsSecretFree(result);
  return result;
}
