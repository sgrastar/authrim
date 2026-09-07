import {
  ApiMigrationEngine,
  MigrationReleaseArtifactReader,
  activeWorkerDeployment,
  assertControlPlaneRecordIsSecretFree,
  ensureWorkerBindingsPatched,
  type CloudflareControlApiClient,
  type CloudflareD1Query,
  type CloudflareD1QueryResult,
  type CloudflareWorkerBinding,
  type ReleaseArtifactObject,
  type ReleaseArtifactStore,
  type WorkerBindingPatchLease,
  type WorkerBindingPatchState,
} from '@authrim/ar-lib-core/control-plane';
import {
  assertR2OwnershipMarker,
  buildR2OwnershipMarkerKey,
  getR2ObjectBytes,
  writeAndVerifyR2OwnershipMarker,
} from './cloudflare.js';
import {
  createSetupOperatorD1Client,
  type SetupOperatorExecutionResult,
} from './control-operator-executor.js';
import type {
  PendingPluginControlOperatorOperation,
  PendingPluginControlOperatorResource,
} from './control-operator-operations.js';

type PluginOperatorClient = CloudflareControlApiClient;
type SqlRow = Record<string, unknown>;

interface PluginOperationLease {
  operationId: string;
  environmentId: string;
  ownerId: string;
  fencingToken: number;
}

interface PluginBindingTarget {
  operationId: string;
  environmentId: string;
  pluginInstallationId: string;
  workerScriptName: string;
  previousRestoreSettingsJson: string | null;
}

interface PluginDeploymentLease extends WorkerBindingPatchLease {
  environmentId: string;
  workerScriptName: string;
  ownerOperationId: string;
  fencingToken: number;
  leaseExpiresAt: number;
}

interface PluginR2OwnershipOperations {
  assert(input: {
    bucketName: string;
    markerKey: string;
    ownershipId: string;
    environment?: string;
    binding?: string;
  }): Promise<void>;
  writeAndVerify(input: {
    environment: string;
    binding: string;
    bucketName: string;
    markerKey: string;
    ownershipId: string;
  }): Promise<void>;
}

const DEFAULT_R2_OWNERSHIP: PluginR2OwnershipOperations = {
  assert: assertR2OwnershipMarker,
  writeAndVerify: writeAndVerifyR2OwnershipMarker,
};

class SetupPluginReleaseArtifactStore implements ReleaseArtifactStore {
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
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
  }
}

function rows<T extends SqlRow>(result: CloudflareD1QueryResult | undefined): T[] {
  if (!result?.success || !Array.isArray(result.results)) {
    throw new Error('control_plugin_operator_control_query_failed');
  }
  return result.results as T[];
}

async function batch(
  client: PluginOperatorClient,
  databaseId: string,
  queries: readonly CloudflareD1Query[]
): Promise<CloudflareD1QueryResult[]> {
  const results = await client.queryD1Batch(databaseId, queries);
  if (results.length !== queries.length || results.some((result) => !result.success)) {
    throw new Error('control_plugin_operator_control_query_failed');
  }
  return results;
}

async function claimOperation(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  ownerId: string;
  now: number;
}): Promise<PluginOperationLease | null> {
  const results = await input.client.queryD1(
    input.controlDatabaseId,
    `UPDATE control_operations
        SET status = 'running', lock_owner = ?, lock_expires_at = ?,
            fencing_token = fencing_token + 1, attempt_count = attempt_count + 1,
            next_attempt_at = NULL, last_error_code = NULL, last_error_redacted = NULL,
            started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE operation_id = ? AND environment_id = ?
        AND operation_kind = 'provision_plugin_resources'
        AND status = 'blocked' AND last_error_code = 'operator_action_required'
        AND (lock_owner IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?)
      RETURNING operation_id, environment_id, lock_owner, fencing_token`,
    [
      input.ownerId,
      input.now + 300,
      input.now,
      input.now,
      input.operation.operationId,
      input.operation.environmentId,
      input.now,
    ]
  );
  const row = rows<{
    operation_id: string;
    environment_id: string;
    lock_owner: string;
    fencing_token: number;
  }>(results[0])[0];
  if (!row) return null;
  if (
    row.operation_id !== input.operation.operationId ||
    row.environment_id !== input.operation.environmentId ||
    row.lock_owner !== input.ownerId ||
    !Number.isSafeInteger(row.fencing_token) ||
    row.fencing_token < 1
  ) {
    throw new Error('control_plugin_operator_lease_invalid');
  }
  return {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    ownerId: row.lock_owner,
    fencingToken: row.fencing_token,
  };
}

function providerStep(resource: PendingPluginControlOperatorResource): string {
  return `plugin_resource_${resource.ownershipFingerprint.slice(0, 20)}_provider`;
}

function migrationStep(resource: PendingPluginControlOperatorResource): string {
  return `plugin_resource_${resource.ownershipFingerprint.slice(0, 20)}_migration`;
}

function pluginCreateWasDefinitelyRejected(error: unknown): boolean {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const status = (error as { status?: unknown }).status;
  if (!Number.isSafeInteger(status)) return false;
  const code = status as number;
  return (
    code === 401 || code === 403 || code === 429 || (code >= 400 && code < 500 && code !== 408)
  );
}

async function markPluginCreateIssued(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  lease: PluginOperationLease;
  resource: PendingPluginControlOperatorResource;
  markerKey: string | null;
  ownershipId: string | null;
  now: number;
}): Promise<void> {
  const results = await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_plugin_desired_resources
               SET provider_create_state = 'issued', provider_ownership_marker_key = ?,
                   provider_ownership_id = ?, status = 'provisioning', updated_at = ?
             WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
               AND lifecycle_mode = 'managed' AND provider_create_state = 'not_started'
               AND provider_resource_id IS NULL AND provider_name IS NULL
               AND provider_creation_date IS NULL
               AND provider_identity_checkpointed_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.lock_owner = ? AND operation.fencing_token = ?
               )`,
      params: [
        input.markerKey,
        input.ownershipId,
        input.now,
        input.resource.pluginResourceId,
        input.operation.environmentId,
        input.operation.operationId,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error('plugin_resource_create_issue_checkpoint_failed');
  }
}

async function markPluginCreateDefinitelyRejected(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  lease: PluginOperationLease;
  resource: PendingPluginControlOperatorResource;
  now: number;
}): Promise<void> {
  const results = await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_plugin_desired_resources
               SET provider_create_state = 'not_started', provider_ownership_marker_key = NULL,
                   provider_ownership_id = NULL, status = 'pending', updated_at = ?
             WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
               AND lifecycle_mode = 'managed' AND provider_create_state = 'issued'
               AND provider_resource_id IS NULL AND provider_name IS NULL
               AND provider_creation_date IS NULL
               AND provider_identity_checkpointed_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.lock_owner = ? AND operation.fencing_token = ?
               )`,
      params: [
        input.now,
        input.resource.pluginResourceId,
        input.operation.environmentId,
        input.operation.operationId,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error('plugin_resource_create_rejection_checkpoint_failed');
  }
}

async function checkpointPluginProviderIdentity(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  lease: PluginOperationLease;
  resource: PendingPluginControlOperatorResource;
  identity: { id: string; name: string };
  creationDate: string | null;
  markerKey: string | null;
  ownershipId: string | null;
  now: number;
}): Promise<void> {
  const results = await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_plugin_desired_resources
               SET provider_create_state = 'identified', provider_resource_id = ?,
                   provider_name = ?, provider_creation_date = ?,
                   provider_ownership_marker_key = ?, provider_ownership_id = ?,
                   provider_identity_checkpointed_at = COALESCE(
                     provider_identity_checkpointed_at, ?
                   ), updated_at = ?
             WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
               AND lifecycle_mode = 'managed'
               AND (provider_create_state = 'issued' OR
                    (provider_create_state = 'not_started' AND provider_resource_id = ?
                     AND provider_name = ?) OR
                    (provider_create_state = 'identified' AND provider_resource_id = ?
                     AND provider_name = ?))
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.lock_owner = ? AND operation.fencing_token = ?
               )`,
      params: [
        input.identity.id,
        input.identity.name,
        input.creationDate,
        input.markerKey,
        input.ownershipId,
        input.now,
        input.now,
        input.resource.pluginResourceId,
        input.operation.environmentId,
        input.operation.operationId,
        input.identity.id,
        input.identity.name,
        input.identity.id,
        input.identity.name,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error('plugin_resource_provider_identity_checkpoint_failed');
  }
}

async function markLegacyR2Unverified(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  lease: PluginOperationLease;
  resource: PendingPluginControlOperatorResource;
  now: number;
}): Promise<void> {
  const results = await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_plugin_desired_resources
               SET provider_create_state = 'legacy_unverified', status = 'failed', updated_at = ?
             WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
               AND lifecycle_mode = 'managed' AND resource_kind = 'r2_bucket'
               AND provider_create_state = 'not_started'
               AND provider_resource_id = ? AND provider_name = ?
               AND EXISTS (
                 SELECT 1 FROM control_operations operation
                  WHERE operation.operation_id = ? AND operation.environment_id = ?
                    AND operation.lock_owner = ? AND operation.fencing_token = ?
               )`,
      params: [
        input.now,
        input.resource.pluginResourceId,
        input.operation.environmentId,
        input.operation.operationId,
        input.resource.providerResourceId,
        input.resource.providerName,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error('plugin_resource_legacy_r2_checkpoint_failed');
  }
}

async function verifyExistingProviderResource(
  client: PluginOperatorClient,
  resource: PendingPluginControlOperatorResource
): Promise<{ id: string; name: string }> {
  if (!resource.providerResourceId || !resource.providerName) {
    throw new Error('plugin_resource_existing_identity_missing');
  }
  if (resource.kind === 'd1') {
    const value = await client.getD1Database(resource.providerResourceId);
    if (value.uuid !== resource.providerResourceId || value.name !== resource.providerName) {
      throw new Error('plugin_resource_existing_identity_mismatch');
    }
    return { id: value.uuid, name: value.name };
  }
  if (resource.kind === 'kv_namespace') {
    const value = (await client.listKvNamespaces()).find(
      (candidate) => candidate.id === resource.providerResourceId
    );
    if (!value || value.title !== resource.providerName) {
      throw new Error('plugin_resource_existing_identity_mismatch');
    }
    return { id: value.id, name: value.title };
  }
  if (resource.providerResourceId !== resource.providerName) {
    throw new Error('plugin_resource_existing_identity_mismatch');
  }
  const value = (await client.listR2Buckets()).find(
    (candidate) => candidate.name === resource.providerName
  );
  if (!value) throw new Error('plugin_resource_existing_identity_mismatch');
  return { id: value.name, name: value.name };
}

async function ensureManagedD1(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  lease: PluginOperationLease;
  resource: PendingPluginControlOperatorResource;
  now: number;
}): Promise<{ id: string; name: string }> {
  const resource = input.resource;
  if (resource.providerCreateState === 'legacy_unverified') {
    throw new Error('plugin_resource_provider_checkpoint_invalid');
  }
  let database;
  if (resource.providerCreateState === 'identified') {
    if (
      !resource.providerResourceId ||
      resource.providerName !== resource.deterministicName ||
      resource.providerIdentityCheckpointedAt === null
    ) {
      throw new Error('plugin_resource_provider_checkpoint_invalid');
    }
    database = await input.client.getD1Database(resource.providerResourceId);
  } else if (resource.providerCreateState === 'issued') {
    throw new Error('plugin_resource_create_outcome_ambiguous');
  } else if (resource.providerResourceId && resource.providerName) {
    database = await input.client.getD1Database(resource.providerResourceId);
    if (database.uuid !== resource.providerResourceId || database.name !== resource.providerName) {
      throw new Error('plugin_resource_provider_reflection_mismatch');
    }
    await checkpointPluginProviderIdentity({
      ...input,
      identity: { id: database.uuid, name: database.name },
      creationDate: null,
      markerKey: null,
      ownershipId: null,
    });
  } else {
    if (
      (await input.client.listD1Databases()).some(
        (candidate) => candidate.name === resource.deterministicName
      )
    ) {
      throw new Error('plugin_resource_provider_name_conflict');
    }
    await markPluginCreateIssued({ ...input, markerKey: null, ownershipId: null });
    try {
      database = await input.client.createD1Database({ name: resource.deterministicName });
    } catch (error) {
      if (pluginCreateWasDefinitelyRejected(error)) {
        await markPluginCreateDefinitelyRejected(input);
        throw error;
      }
      throw new Error('plugin_resource_create_outcome_ambiguous');
    }
    if (!database.uuid) throw new Error('plugin_resource_create_outcome_ambiguous');
    await checkpointPluginProviderIdentity({
      ...input,
      identity: { id: database.uuid, name: database.name },
      creationDate: null,
      markerKey: null,
      ownershipId: null,
    });
  }
  if (
    !database.uuid ||
    (resource.providerResourceId !== null && database.uuid !== resource.providerResourceId) ||
    database.name !== resource.deterministicName
  ) {
    throw new Error('plugin_resource_provider_reflection_mismatch');
  }
  if (database.read_replication?.mode !== 'disabled') {
    await input.client.updateD1Database(database.uuid, {
      read_replication: { mode: 'disabled' },
    });
  }
  const reflected = await input.client.getD1Database(database.uuid);
  if (reflected.uuid !== database.uuid || reflected.name !== resource.deterministicName) {
    throw new Error('plugin_resource_provider_reflection_mismatch');
  }
  return { id: reflected.uuid, name: reflected.name };
}

async function ensureManagedKv(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  lease: PluginOperationLease;
  resource: PendingPluginControlOperatorResource;
  now: number;
}): Promise<{ id: string; name: string }> {
  const resource = input.resource;
  if (resource.providerCreateState === 'legacy_unverified') {
    throw new Error('plugin_resource_provider_checkpoint_invalid');
  }
  let namespace;
  if (resource.providerCreateState === 'identified') {
    if (
      !resource.providerResourceId ||
      resource.providerName !== resource.deterministicName ||
      resource.providerIdentityCheckpointedAt === null
    ) {
      throw new Error('plugin_resource_provider_checkpoint_invalid');
    }
    namespace = (await input.client.listKvNamespaces()).find(
      (candidate) => candidate.id === resource.providerResourceId
    );
  } else if (resource.providerCreateState === 'issued') {
    throw new Error('plugin_resource_create_outcome_ambiguous');
  } else if (resource.providerResourceId && resource.providerName) {
    namespace = (await input.client.listKvNamespaces()).find(
      (candidate) => candidate.id === resource.providerResourceId
    );
    if (!namespace || namespace.title !== resource.providerName) {
      throw new Error('plugin_resource_provider_reflection_mismatch');
    }
    await checkpointPluginProviderIdentity({
      ...input,
      identity: { id: namespace.id, name: namespace.title },
      creationDate: null,
      markerKey: null,
      ownershipId: null,
    });
  } else {
    if (
      (await input.client.listKvNamespaces()).some(
        (candidate) => candidate.title === resource.deterministicName
      )
    ) {
      throw new Error('plugin_resource_provider_name_conflict');
    }
    await markPluginCreateIssued({ ...input, markerKey: null, ownershipId: null });
    try {
      namespace = await input.client.createKvNamespace(resource.deterministicName);
    } catch (error) {
      if (pluginCreateWasDefinitelyRejected(error)) {
        await markPluginCreateDefinitelyRejected(input);
        throw error;
      }
      throw new Error('plugin_resource_create_outcome_ambiguous');
    }
    if (!namespace.id) throw new Error('plugin_resource_create_outcome_ambiguous');
    await checkpointPluginProviderIdentity({
      ...input,
      identity: { id: namespace.id, name: namespace.title },
      creationDate: null,
      markerKey: null,
      ownershipId: null,
    });
  }
  if (
    !namespace ||
    (resource.providerResourceId !== null && namespace.id !== resource.providerResourceId) ||
    namespace.title !== resource.deterministicName
  ) {
    throw new Error('plugin_resource_provider_reflection_mismatch');
  }
  const reflected = (await input.client.listKvNamespaces()).find(
    (candidate) => candidate.id === namespace.id
  );
  if (!reflected || reflected.title !== resource.deterministicName) {
    throw new Error('plugin_resource_provider_reflection_mismatch');
  }
  return { id: reflected.id, name: reflected.title };
}

async function ensureManagedR2(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  lease: PluginOperationLease;
  resource: PendingPluginControlOperatorResource;
  r2Ownership: PluginR2OwnershipOperations;
  now: number;
}): Promise<{ id: string; name: string }> {
  const resource = input.resource;
  if (resource.providerCreateState === 'legacy_unverified') {
    throw new Error('plugin_resource_legacy_r2_identity_unverified');
  }
  if (
    resource.providerCreateState === 'not_started' &&
    resource.providerResourceId &&
    resource.providerName
  ) {
    await markLegacyR2Unverified(input);
    throw new Error('plugin_resource_legacy_r2_identity_unverified');
  }

  let markerKey = resource.providerOwnershipMarkerKey;
  let ownershipId = resource.providerOwnershipId;
  let expectedCreationDate = resource.providerCreationDate;
  if (resource.providerCreateState === 'identified') {
    if (
      !resource.providerResourceId ||
      resource.providerResourceId !== resource.deterministicName ||
      resource.providerName !== resource.deterministicName ||
      !expectedCreationDate ||
      !markerKey ||
      !ownershipId ||
      resource.providerIdentityCheckpointedAt === null
    ) {
      throw new Error('plugin_resource_provider_checkpoint_invalid');
    }
  } else if (resource.providerCreateState === 'issued') {
    if (!markerKey || !ownershipId) {
      throw new Error('plugin_resource_create_outcome_ambiguous');
    }
  } else {
    if (
      (await input.client.listR2Buckets()).some(
        (candidate) => candidate.name === resource.deterministicName
      )
    ) {
      throw new Error('plugin_resource_provider_name_conflict');
    }
    ownershipId = crypto.randomUUID().toLowerCase();
    markerKey = buildR2OwnershipMarkerKey(ownershipId);
    await markPluginCreateIssued({ ...input, markerKey, ownershipId });
    try {
      const created = await input.client.createR2Bucket(resource.deterministicName);
      if (created.name !== resource.deterministicName) {
        throw new Error('plugin_resource_provider_reflection_mismatch');
      }
      expectedCreationDate = created.creation_date ?? null;
    } catch (error) {
      if (pluginCreateWasDefinitelyRejected(error)) {
        await markPluginCreateDefinitelyRejected(input);
        throw error;
      }
      throw new Error('plugin_resource_create_outcome_ambiguous');
    }
    try {
      await input.r2Ownership.writeAndVerify({
        environment: input.operation.environmentId,
        binding: resource.hostBindingRef,
        bucketName: resource.deterministicName,
        markerKey,
        ownershipId,
      });
    } catch {
      throw new Error('plugin_resource_create_outcome_ambiguous');
    }
  }

  const reflected = (await input.client.listR2Buckets()).find(
    (candidate) => candidate.name === resource.deterministicName
  );
  if (
    !reflected?.creation_date ||
    (expectedCreationDate !== null && reflected.creation_date !== expectedCreationDate) ||
    !markerKey ||
    !ownershipId
  ) {
    throw new Error('plugin_resource_create_outcome_ambiguous');
  }
  await input.r2Ownership.assert({
    environment: input.operation.environmentId,
    binding: resource.hostBindingRef,
    bucketName: resource.deterministicName,
    markerKey,
    ownershipId,
  });
  if (resource.providerCreateState !== 'identified') {
    await checkpointPluginProviderIdentity({
      ...input,
      identity: { id: reflected.name, name: reflected.name },
      creationDate: reflected.creation_date,
      markerKey,
      ownershipId,
    });
  }
  return { id: reflected.name, name: reflected.name };
}

async function ensureProviderResource(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  lease: PluginOperationLease;
  resource: PendingPluginControlOperatorResource;
  r2Ownership: PluginR2OwnershipOperations;
  now: number;
}): Promise<{ id: string; name: string }> {
  if (input.resource.lifecycleMode === 'existing') {
    return verifyExistingProviderResource(input.client, input.resource);
  }
  if (input.resource.kind === 'd1') return ensureManagedD1(input);
  if (input.resource.kind === 'kv_namespace') return ensureManagedKv(input);
  return ensureManagedR2(input);
}

async function handoffNextStage(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  lease: PluginOperationLease;
  nextStep: 'migration' | 'binding';
  now: number;
}): Promise<void> {
  const suffix = input.nextStep === 'migration' ? '_migration' : '_binding';
  const results = await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_operation_steps
               SET status = 'blocked', next_attempt_at = NULL,
                   last_error_code = 'operator_action_required',
                   last_error_redacted = 'operator_action_required', updated_at = ?
             WHERE operation_id = ? AND step_key = (
               SELECT step_key FROM control_operation_steps
                WHERE operation_id = ? AND step_key LIKE ? AND status IN ('queued', 'waiting_retry')
                ORDER BY display_order, step_key LIMIT 1
             )`,
      params: [input.now, input.operation.operationId, input.operation.operationId, `%${suffix}`],
    },
    {
      sql: `UPDATE control_operations
               SET status = 'blocked', lock_owner = NULL, lock_expires_at = NULL,
                   last_error_code = 'operator_action_required',
                   last_error_redacted = 'operator_action_required', updated_at = ?
             WHERE operation_id = ? AND environment_id = ? AND lock_owner = ? AND fencing_token = ?`,
      params: [
        input.now,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error('control_plugin_operator_fence_lost');
  }
}

async function recordOperatorFailure(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  lease: PluginOperationLease;
  now: number;
}): Promise<void> {
  await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_operation_steps
               SET status = 'blocked', next_attempt_at = NULL,
                   last_error_code = 'operator_action_required',
                   last_error_redacted = 'operator_action_required', updated_at = ?
             WHERE operation_id = ? AND status = 'running'`,
      params: [input.now, input.operation.operationId],
    },
    {
      sql: `UPDATE control_operations
               SET status = 'blocked', lock_owner = NULL, lock_expires_at = NULL,
                   next_attempt_at = NULL, last_error_code = 'operator_action_required',
                   last_error_redacted = 'operator_action_required', updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND lock_owner = ? AND fencing_token = ? AND status <> 'succeeded'`,
      params: [
        input.now,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
    {
      sql: `INSERT OR IGNORE INTO control_audit_events (
              event_id, environment_id, operation_id, event_type, actor_type, actor_id,
              resource_kind, resource_id, outcome, redacted_payload_json, created_at
            ) VALUES (?, ?, ?, 'plugin.resources.setup_operator.failed', 'setup',
              'authrim-setup', 'plugin_resource_operation', ?, 'failed',
              '{"code":"operator_action_required"}', ?)`,
      params: [
        `audit_plugin_setup_failure_${input.operation.operationId.slice(-32)}_${input.lease.fencingToken}`,
        input.operation.environmentId,
        input.operation.operationId,
        input.operation.operationId,
        input.now,
      ],
    },
  ]);
}

async function executeProviderStage(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  lease: PluginOperationLease;
  r2Ownership: PluginR2OwnershipOperations;
  now: number;
}): Promise<SetupOperatorExecutionResult> {
  await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_operation_steps
               SET status = 'running', attempt_count = attempt_count + 1,
                   started_at = COALESCE(started_at, ?),
                   last_error_code = NULL, last_error_redacted = NULL, updated_at = ?
             WHERE operation_id = ? AND step_key LIKE 'plugin_resource_%_provider'
               AND status IN ('blocked', 'queued', 'waiting_retry')`,
      params: [input.now, input.now, input.operation.operationId],
    },
  ]);
  for (const resource of input.operation.resources) {
    if (
      resource.status === 'ready' &&
      (resource.lifecycleMode === 'existing' || resource.providerCreateState === 'identified')
    ) {
      continue;
    }
    const identity = await ensureProviderResource({ ...input, resource });
    const assertionId = `plugin-provider-setup:${resource.pluginResourceId}:${input.lease.fencingToken}`;
    const results = await batch(input.client, input.controlDatabaseId, [
      {
        sql: `UPDATE control_plugin_desired_resources
                 SET provider_resource_id = ?, provider_name = ?, status = 'ready', updated_at = ?
               WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
                 AND status IN ('pending', 'provisioning', 'ready', 'failed')
                 AND (lifecycle_mode = 'existing' OR
                      (provider_create_state = 'identified' AND provider_resource_id = ?
                       AND provider_name = ? AND provider_identity_checkpointed_at IS NOT NULL))
                 AND NOT EXISTS (
                   SELECT 1 FROM control_plugin_desired_resources conflicting
                    WHERE conflicting.environment_id = ?
                      AND conflicting.resource_kind = ? AND conflicting.status <> 'deleted'
                      AND conflicting.plugin_resource_id <> ?
                      AND (conflicting.provider_resource_id = ? OR conflicting.provider_name = ?)
                 )
                 AND EXISTS (
                   SELECT 1 FROM control_operations operation
                    WHERE operation.operation_id = ? AND operation.environment_id = ?
                      AND operation.lock_owner = ? AND operation.fencing_token = ?
                 )`,
        params: [
          identity.id,
          identity.name,
          input.now,
          resource.pluginResourceId,
          input.operation.environmentId,
          input.operation.operationId,
          identity.id,
          identity.name,
          input.operation.environmentId,
          resource.kind,
          resource.pluginResourceId,
          identity.id,
          identity.name,
          input.operation.operationId,
          input.operation.environmentId,
          input.lease.ownerId,
          input.lease.fencingToken,
        ],
      },
      {
        sql: `UPDATE control_operation_steps
                 SET status = 'succeeded', observed_resource_id = ?, completed_at = ?,
                     last_error_code = NULL, last_error_redacted = NULL, updated_at = ?
               WHERE operation_id = ? AND step_key = ?
                 AND status IN ('blocked', 'queued', 'waiting_retry', 'running')
                 AND EXISTS (
                   SELECT 1 FROM control_plugin_desired_resources resource
                    WHERE resource.plugin_resource_id = ? AND resource.status = 'ready'
                      AND resource.provider_resource_id = ? AND resource.provider_name = ?
                 )`,
        params: [
          identity.id,
          input.now,
          input.now,
          input.operation.operationId,
          providerStep(resource),
          resource.pluginResourceId,
          identity.id,
          identity.name,
        ],
      },
      {
        sql: `INSERT INTO control_plugin_provider_projection_assertions (
                assertion_id, environment_id, plugin_resource_id, valid, created_at
              ) VALUES (?, ?, ?, CASE WHEN
                EXISTS (
                  SELECT 1 FROM control_plugin_desired_resources projected
                   WHERE projected.plugin_resource_id = ? AND projected.environment_id = ?
                     AND projected.operation_id = ? AND projected.status = 'ready'
                     AND projected.provider_resource_id = ? AND projected.provider_name = ?
                     AND (
                       projected.lifecycle_mode = 'existing' OR (
                         projected.lifecycle_mode = 'managed'
                         AND projected.provider_create_state = 'identified'
                         AND projected.provider_identity_checkpointed_at IS NOT NULL
                         AND (
                           projected.resource_kind <> 'r2_bucket' OR (
                             projected.provider_creation_date IS NOT NULL
                             AND projected.provider_ownership_marker_key IS NOT NULL
                             AND projected.provider_ownership_id IS NOT NULL
                           )
                         )
                       )
                     )
                ) AND EXISTS (
                  SELECT 1 FROM control_operation_steps step
                   WHERE step.operation_id = ? AND step.step_key = ?
                     AND step.status = 'succeeded' AND step.observed_resource_id = ?
                ) AND EXISTS (
                  SELECT 1 FROM control_operations operation
                   WHERE operation.operation_id = ? AND operation.environment_id = ?
                     AND operation.status = 'running' AND operation.lock_owner = ?
                     AND operation.fencing_token = ?
                ) THEN 1 ELSE 0 END, ?)`,
        params: [
          assertionId,
          input.operation.environmentId,
          resource.pluginResourceId,
          resource.pluginResourceId,
          input.operation.environmentId,
          input.operation.operationId,
          identity.id,
          identity.name,
          input.operation.operationId,
          providerStep(resource),
          identity.id,
          input.operation.operationId,
          input.operation.environmentId,
          input.lease.ownerId,
          input.lease.fencingToken,
          input.now,
        ],
      },
      {
        sql: `DELETE FROM control_plugin_provider_projection_assertions
               WHERE assertion_id = ? AND environment_id = ? AND plugin_resource_id = ?`,
        params: [assertionId, input.operation.environmentId, resource.pluginResourceId],
      },
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      throw new Error('control_plugin_operator_provider_reflection_failed');
    }
  }
  const nextStep = input.operation.resources.some((resource) => resource.migration)
    ? 'migration'
    : 'binding';
  await handoffNextStage({ ...input, nextStep });
  return {
    operationId: input.operation.operationId,
    state: nextStep === 'migration' ? 'awaiting_migration' : 'awaiting_worker_bindings',
    errorCode: null,
    nextAttemptAt: null,
  };
}

async function executeMigrationStage(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  migrationReleaseBucketName: string;
  operation: PendingPluginControlOperatorOperation;
  lease: PluginOperationLease;
  artifactStore?: ReleaseArtifactStore;
  verifyMigrationReleaseBucketOwnership?: () => Promise<void>;
  now: number;
}): Promise<SetupOperatorExecutionResult> {
  await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_operation_steps
               SET status = 'running', attempt_count = attempt_count + 1,
                   started_at = COALESCE(started_at, ?),
                   last_error_code = NULL, last_error_redacted = NULL, updated_at = ?
             WHERE operation_id = ? AND step_key LIKE 'plugin_resource_%_migration'
               AND status IN ('blocked', 'queued', 'waiting_retry')`,
      params: [input.now, input.now, input.operation.operationId],
    },
  ]);
  const engine = new ApiMigrationEngine(
    new MigrationReleaseArtifactReader(
      input.artifactStore ??
        new SetupPluginReleaseArtifactStore(
          input.migrationReleaseBucketName,
          input.verifyMigrationReleaseBucketOwnership
        )
    ),
    input.client,
    () => input.now
  );
  for (const resource of input.operation.resources) {
    if (!resource.migration || resource.migration.state === 'ready') continue;
    if (
      !resource.providerResourceId ||
      (resource.lifecycleMode === 'managed' &&
        (resource.providerCreateState !== 'identified' ||
          resource.providerIdentityCheckpointedAt === null))
    ) {
      throw new Error('control_plugin_operator_migration_database_missing');
    }
    const applied = await engine.apply({
      databaseId: resource.providerResourceId,
      pin: {
        environmentId: input.operation.environmentId,
        streamId: resource.migration.streamId,
        releaseId: resource.migration.releaseId,
        manifestDigest: resource.migration.manifestDigest,
        manifestObjectKey: resource.migration.manifestObjectKey,
      },
    });
    if (
      applied.releaseId !== resource.migration.releaseId ||
      applied.manifestDigest !== resource.migration.manifestDigest ||
      applied.streamId !== resource.migration.streamId ||
      applied.appliedFiles + applied.skippedFiles !== applied.totalFiles
    ) {
      throw new Error('control_plugin_operator_migration_result_mismatch');
    }
    const results = await batch(input.client, input.controlDatabaseId, [
      {
        sql: `UPDATE control_plugin_resource_migration_state
                 SET state = 'ready', provider_database_id = ?, expected_file_count = ?,
                     applied_file_count = ?, last_filename = ?, completed_at = ?,
                     last_error_code = NULL, updated_at = ?
               WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
                 AND release_id = ? AND manifest_digest = ?
                 AND state IN ('requested', 'applying', 'waiting_retry', 'blocked')
                 AND EXISTS (
                   SELECT 1 FROM control_operations operation
                    WHERE operation.operation_id = ? AND operation.environment_id = ?
                      AND operation.lock_owner = ? AND operation.fencing_token = ?
                 )`,
        params: [
          resource.providerResourceId,
          applied.totalFiles,
          applied.totalFiles,
          applied.lastFilename,
          input.now,
          input.now,
          resource.pluginResourceId,
          input.operation.environmentId,
          input.operation.operationId,
          resource.migration.releaseId,
          resource.migration.manifestDigest,
          input.operation.operationId,
          input.operation.environmentId,
          input.lease.ownerId,
          input.lease.fencingToken,
        ],
      },
      {
        sql: `UPDATE control_operation_steps
                 SET status = 'succeeded', observed_resource_id = ?, completed_at = ?,
                     last_error_code = NULL, last_error_redacted = NULL, updated_at = ?
               WHERE operation_id = ? AND step_key = ?
                 AND status IN ('blocked', 'queued', 'waiting_retry', 'running')`,
        params: [
          resource.providerResourceId,
          input.now,
          input.now,
          input.operation.operationId,
          migrationStep(resource),
        ],
      },
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      throw new Error('control_plugin_operator_migration_reflection_failed');
    }
  }
  await handoffNextStage({ ...input, nextStep: 'binding' });
  return {
    operationId: input.operation.operationId,
    state: 'awaiting_worker_bindings',
    errorCode: null,
    nextAttemptAt: null,
  };
}

function desiredBinding(resource: PendingPluginControlOperatorResource): CloudflareWorkerBinding {
  if (!resource.providerResourceId || !resource.providerName) {
    throw new Error('control_plugin_operator_binding_identity_missing');
  }
  if (
    resource.lifecycleMode === 'managed' &&
    (resource.providerCreateState !== 'identified' ||
      resource.providerIdentityCheckpointedAt === null ||
      (resource.kind === 'r2_bucket' &&
        (!resource.providerCreationDate ||
          !resource.providerOwnershipMarkerKey ||
          !resource.providerOwnershipId)))
  ) {
    throw new Error('control_plugin_operator_binding_identity_unverified');
  }
  if (resource.kind === 'd1') {
    return { name: resource.hostBindingRef, type: 'd1', database_id: resource.providerResourceId };
  }
  if (resource.kind === 'kv_namespace') {
    return {
      name: resource.hostBindingRef,
      type: 'kv_namespace',
      namespace_id: resource.providerResourceId,
    };
  }
  return { name: resource.hostBindingRef, type: 'r2_bucket', bucket_name: resource.providerName };
}

async function prepareBindingTarget(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  now: number;
}): Promise<PluginBindingTarget> {
  const desiredBindings = input.operation.resources.map(desiredBinding);
  const resourceMap = {
    schemaVersion: 1,
    pluginId: input.operation.pluginId,
    capabilityManifestDigest: input.operation.capabilityManifestDigest,
    resources: input.operation.resources.map((resource) => ({
      logicalResourceId: resource.logicalResourceId,
      binding: resource.binding,
      kind: resource.kind,
      access: resource.access,
      hostBindingRef: resource.hostBindingRef,
      ownershipFingerprint: resource.ownershipFingerprint,
    })),
  };
  const results = await batch(input.client, input.controlDatabaseId, [
    {
      sql: `INSERT OR IGNORE INTO control_plugin_resource_binding_reconciliations (
              operation_id, environment_id, plugin_installation_id, tenant_id,
              worker_script_name, desired_bindings_json, resource_map_json,
              state, created_at, updated_at
            )
            SELECT ?, ?, ?, ?, inventory.worker_script_name, ?, ?, 'pending', ?, ?
              FROM control_desired_worker_inventory inventory
             WHERE inventory.environment_id = ? AND inventory.status = 'active'
               AND inventory.package_name = '@authrim/ar-plugin-runner'
               AND (SELECT COUNT(*) FROM control_desired_worker_inventory candidate
                     WHERE candidate.environment_id = ? AND candidate.status = 'active'
                       AND candidate.package_name = '@authrim/ar-plugin-runner') = 1`,
      params: [
        input.operation.operationId,
        input.operation.environmentId,
        input.operation.pluginInstallationId,
        input.operation.tenantId,
        JSON.stringify(desiredBindings),
        JSON.stringify(resourceMap),
        input.now,
        input.now,
        input.operation.environmentId,
        input.operation.environmentId,
      ],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'running', attempt_count = attempt_count + 1,
                   started_at = COALESCE(started_at, ?),
                   last_error_code = NULL, last_error_redacted = NULL, updated_at = ?
             WHERE operation_id = ? AND step_key LIKE 'plugin_resource_%_binding'
               AND status IN ('blocked', 'queued', 'waiting_retry')`,
      params: [input.now, input.now, input.operation.operationId],
    },
    {
      sql: `SELECT operation_id, environment_id, plugin_installation_id,
                   worker_script_name, previous_restore_settings_json
              FROM control_plugin_resource_binding_reconciliations
             WHERE operation_id = ? AND environment_id = ? AND plugin_installation_id = ?`,
      params: [
        input.operation.operationId,
        input.operation.environmentId,
        input.operation.pluginInstallationId,
      ],
    },
  ]);
  const row = rows<{
    operation_id: string;
    environment_id: string;
    plugin_installation_id: string;
    worker_script_name: string;
    previous_restore_settings_json: string | null;
  }>(results[2])[0];
  if (
    !row ||
    row.operation_id !== input.operation.operationId ||
    row.environment_id !== input.operation.environmentId ||
    row.plugin_installation_id !== input.operation.pluginInstallationId ||
    !row.worker_script_name
  ) {
    throw new Error('control_plugin_operator_runner_inventory_invalid');
  }
  return {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    pluginInstallationId: row.plugin_installation_id,
    workerScriptName: row.worker_script_name,
    previousRestoreSettingsJson: row.previous_restore_settings_json,
  };
}

async function acquireDeploymentLease(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  target: PluginBindingTarget;
  expectedVersionId: string;
  now: number;
}): Promise<PluginDeploymentLease | null> {
  const results = await input.client.queryD1(
    input.controlDatabaseId,
    `INSERT INTO control_worker_deployment_leases (
       environment_id, worker_script_name, owner_operation_id, fencing_token,
       lease_expires_at, expected_source_version_id, mutation_started, updated_at
     ) VALUES (?, ?, ?, 1, ?, ?, 0, ?)
     ON CONFLICT(environment_id, worker_script_name) DO UPDATE SET
       owner_operation_id = excluded.owner_operation_id,
       fencing_token = control_worker_deployment_leases.fencing_token + 1,
       lease_expires_at = excluded.lease_expires_at,
       expected_source_version_id = CASE
         WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
          AND control_worker_deployment_leases.mutation_started = 1
         THEN control_worker_deployment_leases.expected_source_version_id
         ELSE excluded.expected_source_version_id END,
       mutation_started = CASE
         WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
         THEN control_worker_deployment_leases.mutation_started ELSE 0 END,
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
     WHERE control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
        OR control_worker_deployment_leases.lease_expires_at <= ?
     RETURNING *`,
    [
      input.target.environmentId,
      input.target.workerScriptName,
      input.target.operationId,
      input.now + 900,
      input.expectedVersionId,
      input.now,
      input.now,
    ]
  );
  const row = rows<Record<string, unknown>>(results[0])[0];
  if (!row) return null;
  if (
    row.environment_id !== input.target.environmentId ||
    row.worker_script_name !== input.target.workerScriptName ||
    row.owner_operation_id !== input.target.operationId ||
    !Number.isSafeInteger(row.fencing_token) ||
    !Number.isSafeInteger(row.lease_expires_at) ||
    typeof row.expected_source_version_id !== 'string'
  ) {
    throw new Error('control_plugin_operator_deployment_lease_invalid');
  }
  return {
    environmentId: row.environment_id as string,
    workerScriptName: row.worker_script_name as string,
    ownerOperationId: row.owner_operation_id as string,
    fencingToken: row.fencing_token as number,
    leaseExpiresAt: row.lease_expires_at as number,
    expectedSourceVersionId: row.expected_source_version_id,
    mutationStarted: row.mutation_started === 1,
    previousDeploymentId:
      typeof row.previous_deployment_id === 'string' ? row.previous_deployment_id : null,
  };
}

function bindingState(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
}): WorkerBindingPatchState<PluginBindingTarget, PluginDeploymentLease> {
  const leaseWhere = `environment_id = ? AND worker_script_name = ?
    AND owner_operation_id = ? AND fencing_token = ? AND lease_expires_at > ?`;
  return {
    async leaseIsCurrent(lease, now) {
      const result = await input.client.queryD1(
        input.controlDatabaseId,
        `SELECT 1 AS active FROM control_worker_deployment_leases WHERE ${leaseWhere}`,
        [
          lease.environmentId,
          lease.workerScriptName,
          lease.ownerOperationId,
          lease.fencingToken,
          now,
        ]
      );
      return rows<{ active: number }>(result[0])[0]?.active === 1;
    },
    async recordAlreadySatisfied(value) {
      const results = await batch(input.client, input.controlDatabaseId, [
        {
          sql: `UPDATE control_plugin_resource_binding_reconciliations
                   SET state = 'settings_patched', expected_source_version_id = ?,
                       previous_deployment_id = ?, patch_result_version_id = ?,
                       patch_result_deployment_id = ?, previous_restore_settings_json = ?,
                       last_error_code = NULL, updated_at = ?
                 WHERE operation_id = ? AND plugin_installation_id = ? AND state = 'pending'
                   AND EXISTS (SELECT 1 FROM control_worker_deployment_leases WHERE ${leaseWhere})`,
          params: [
            value.lease.expectedSourceVersionId,
            value.deploymentId,
            value.versionId,
            value.deploymentId,
            value.settingsJson,
            value.now,
            value.target.operationId,
            value.target.pluginInstallationId,
            value.lease.environmentId,
            value.lease.workerScriptName,
            value.lease.ownerOperationId,
            value.lease.fencingToken,
            value.now,
          ],
        },
      ]);
      if (Number(results[0]?.meta?.changes ?? 0) !== 1)
        throw new Error('control_plugin_operator_fence_lost');
    },
    async recordPatchStarted(value) {
      const results = await batch(input.client, input.controlDatabaseId, [
        {
          sql: `UPDATE control_worker_deployment_leases
                   SET mutation_started = 1, previous_deployment_id = ?, updated_at = ?
                 WHERE ${leaseWhere}`,
          params: [
            value.previousDeploymentId,
            value.now,
            value.lease.environmentId,
            value.lease.workerScriptName,
            value.lease.ownerOperationId,
            value.lease.fencingToken,
            value.now,
          ],
        },
        {
          sql: `UPDATE control_plugin_resource_binding_reconciliations
                   SET expected_source_version_id = ?, previous_deployment_id = ?,
                       previous_restore_settings_json = ?, updated_at = ?
                 WHERE operation_id = ? AND plugin_installation_id = ? AND state = 'pending'
                   AND EXISTS (SELECT 1 FROM control_worker_deployment_leases WHERE ${leaseWhere})`,
          params: [
            value.lease.expectedSourceVersionId,
            value.previousDeploymentId,
            value.restoreSettingsJson,
            value.now,
            value.target.operationId,
            value.target.pluginInstallationId,
            value.lease.environmentId,
            value.lease.workerScriptName,
            value.lease.ownerOperationId,
            value.lease.fencingToken,
            value.now,
          ],
        },
      ]);
      if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
        throw new Error('control_plugin_operator_fence_lost');
      }
    },
    async recordPatchResult(value) {
      const results = await batch(input.client, input.controlDatabaseId, [
        {
          sql: `UPDATE control_worker_deployment_leases
                   SET patch_result_version_id = ?, patch_result_deployment_id = ?, updated_at = ?
                 WHERE ${leaseWhere}`,
          params: [
            value.versionId,
            value.deploymentId,
            value.now,
            value.lease.environmentId,
            value.lease.workerScriptName,
            value.lease.ownerOperationId,
            value.lease.fencingToken,
            value.now,
          ],
        },
        {
          sql: `UPDATE control_plugin_resource_binding_reconciliations
                   SET state = 'settings_patched', patch_result_version_id = ?,
                       patch_result_deployment_id = ?, last_error_code = NULL, updated_at = ?
                 WHERE operation_id = ? AND plugin_installation_id = ? AND state = 'pending'
                   AND EXISTS (SELECT 1 FROM control_worker_deployment_leases WHERE ${leaseWhere})`,
          params: [
            value.versionId,
            value.deploymentId,
            value.now,
            value.target.operationId,
            value.target.pluginInstallationId,
            value.lease.environmentId,
            value.lease.workerScriptName,
            value.lease.ownerOperationId,
            value.lease.fencingToken,
            value.now,
          ],
        },
      ]);
      if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
        throw new Error('control_plugin_operator_fence_lost');
      }
    },
    async recordTransientError(target, errorCode, nextAttemptAt, now) {
      await batch(input.client, input.controlDatabaseId, [
        {
          sql: `UPDATE control_plugin_resource_binding_reconciliations
                   SET last_error_code = ?, updated_at = ?
                 WHERE operation_id = ? AND plugin_installation_id = ? AND state = 'pending'`,
          params: [errorCode, now, target.operationId, target.pluginInstallationId],
        },
        {
          sql: `UPDATE control_operations SET status = 'waiting_retry', next_attempt_at = ?,
                   last_error_code = ?, last_error_redacted = ?, updated_at = ?
                 WHERE operation_id = ? AND environment_id = ? AND status = 'running'`,
          params: [
            nextAttemptAt,
            errorCode,
            errorCode,
            now,
            target.operationId,
            target.environmentId,
          ],
        },
      ]);
    },
    async markRollbackRequired(target, errorCode, now) {
      await batch(input.client, input.controlDatabaseId, [
        {
          sql: `UPDATE control_plugin_resource_binding_reconciliations
                   SET state = 'rollback_required', last_error_code = ?, updated_at = ?
                 WHERE operation_id = ? AND plugin_installation_id = ? AND state = 'pending'`,
          params: [errorCode, now, target.operationId, target.pluginInstallationId],
        },
      ]);
    },
    async markBlocked(target, errorCode, now) {
      await batch(input.client, input.controlDatabaseId, [
        {
          sql: `UPDATE control_plugin_resource_binding_reconciliations
                   SET state = 'blocked', last_error_code = ?, updated_at = ?
                 WHERE operation_id = ? AND plugin_installation_id = ? AND state <> 'succeeded'`,
          params: [errorCode, now, target.operationId, target.pluginInstallationId],
        },
        {
          sql: `UPDATE control_operations SET status = 'blocked', next_attempt_at = NULL,
                   last_error_code = ?, last_error_redacted = ?, updated_at = ?
                 WHERE operation_id = ? AND environment_id = ? AND status <> 'succeeded'`,
          params: [errorCode, errorCode, now, target.operationId, target.environmentId],
        },
      ]);
    },
  };
}

async function executeBindingStage(input: {
  client: PluginOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlOperatorOperation;
  operationLease: PluginOperationLease;
  now: number;
}): Promise<SetupOperatorExecutionResult> {
  const target = await prepareBindingTarget(input);
  const deployments = await input.client.listWorkerDeployments(target.workerScriptName);
  const active = activeWorkerDeployment(deployments);
  const lease = await acquireDeploymentLease({
    ...input,
    target,
    expectedVersionId: active.versionId,
  });
  if (!lease) {
    return {
      operationId: input.operation.operationId,
      state: 'lease_unavailable',
      errorCode: 'control_worker_deployment_lease_busy',
      nextAttemptAt: null,
    };
  }
  const result = await ensureWorkerBindingsPatched({
    target,
    lease,
    desiredBindings: input.operation.resources.map(desiredBinding),
    deploymentsBefore: deployments,
    activeBefore: active,
    api: input.client,
    state: bindingState(input),
    now: () => input.now,
  });
  await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_operations
               SET lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND lock_owner = ? AND fencing_token = ?`,
      params: [
        input.now,
        input.operation.operationId,
        input.operation.environmentId,
        input.operationLease.ownerId,
        input.operationLease.fencingToken,
      ],
    },
  ]);
  if (result.state !== 'patched') {
    return {
      operationId: input.operation.operationId,
      state: result.state === 'deferred' ? 'retry_required' : 'blocked',
      errorCode: `control_plugin_operator_binding_${result.state}`,
      nextAttemptAt: result.state === 'deferred' ? input.now + 15 : null,
    };
  }
  return {
    operationId: input.operation.operationId,
    state: 'awaiting_smoke',
    errorCode: null,
    nextAttemptAt: null,
  };
}

export async function executeSetupPluginControlOperator(input: {
  controlDatabaseId: string;
  migrationReleaseBucketName: string;
  operation: PendingPluginControlOperatorOperation;
  client?: PluginOperatorClient;
  expectedAccountId?: string;
  artifactStore?: ReleaseArtifactStore;
  verifyMigrationReleaseBucketOwnership?: () => Promise<void>;
  r2Ownership?: PluginR2OwnershipOperations;
  executionId?: string;
  now?: () => number;
}): Promise<SetupOperatorExecutionResult> {
  const client =
    input.client ??
    (await createSetupOperatorD1Client({ expectedAccountId: input.expectedAccountId }));
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const timestamp = now();
  const lease = await claimOperation({
    client,
    controlDatabaseId: input.controlDatabaseId,
    operation: input.operation,
    ownerId: `setup-plugin:${input.executionId ?? crypto.randomUUID()}`,
    now: timestamp,
  });
  if (!lease) {
    return {
      operationId: input.operation.operationId,
      state: 'lease_unavailable',
      errorCode: 'control_concurrency_limited',
      nextAttemptAt: null,
    };
  }
  try {
    const result =
      input.operation.currentStep === 'binding'
        ? await executeBindingStage({
            client,
            controlDatabaseId: input.controlDatabaseId,
            operation: input.operation,
            operationLease: lease,
            now: timestamp,
          })
        : input.operation.currentStep === 'provider'
          ? await executeProviderStage({
              client,
              controlDatabaseId: input.controlDatabaseId,
              operation: input.operation,
              lease,
              r2Ownership: input.r2Ownership ?? DEFAULT_R2_OWNERSHIP,
              now: timestamp,
            })
          : await executeMigrationStage({
              client,
              controlDatabaseId: input.controlDatabaseId,
              migrationReleaseBucketName: input.migrationReleaseBucketName,
              operation: input.operation,
              lease,
              artifactStore: input.artifactStore,
              verifyMigrationReleaseBucketOwnership: input.verifyMigrationReleaseBucketOwnership,
              now: timestamp,
            });
    assertControlPlaneRecordIsSecretFree(result);
    return result;
  } catch (error) {
    await recordOperatorFailure({
      client,
      controlDatabaseId: input.controlDatabaseId,
      operation: input.operation,
      lease,
      now: timestamp,
    });
    throw error;
  }
}
