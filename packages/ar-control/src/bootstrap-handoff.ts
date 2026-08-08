import {
  AUTHRIM_MIGRATION_HISTORY_SQL,
  CloudflareControlApiError,
  calculateControlBootstrapOwnershipFingerprint,
  digestCloudflareWorkerSettings,
  type CloudflareD1Database,
  type CloudflareD1Query,
  type CloudflareD1QueryResult,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerSettings,
  type ControlBootstrapOwnershipResource,
  type ControlBootstrapResourceRole,
} from '@authrim/ar-lib-core/control-plane';

const MAX_PENDING_HANDOFFS = 5;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ERROR = /^control_bootstrap_[a-z0-9_]{1,96}$/u;
const TRANSIENT_NOT_READY_ERROR = 'control_bootstrap_not_ready';
const EXPECTED_STREAMS = ['d1-core', 'd1-pii', 'd1-lookup'] as const;

export interface BootstrapHandoff {
  environmentId: string;
  environmentName: string;
  ownershipFingerprint: string;
  releaseManifestDigest: string;
  observedDeploymentId: string | null;
  observedVersionId: string | null;
}

export interface BootstrapMigrationFile {
  path: string;
  checksum: string;
}

export interface BootstrapResource extends ControlBootstrapOwnershipResource {
  desiredResourceScope: string;
  desiredTenantId: string | null;
  provisioningState: string;
  observedState: string;
  observedOwnershipFingerprint: string | null;
  desiredObservedResourceId: string | null;
  observedResourceId: string;
  desiredSpecJson: string;
  migrationState: string | null;
  migrationStreamId: string | null;
  migrationReleaseId: string | null;
  migrationManifestDigest: string | null;
  migrationExpectedFileCount: number | null;
  migrationAppliedFileCount: number | null;
  shardStatus: string | null;
  capacityHealthStatus: string | null;
  lookupStatus: string | null;
  allocationScope: string | null;
  ownerTenantId: string | null;
  assignmentCount: number;
  assignmentTenantId: string | null;
  assignmentState: string | null;
  placementIsolationPolicy: string | null;
  placementPolicyState: string | null;
}

export interface BootstrapWorkerEvidence {
  workerScriptName: string;
  expectedDeploymentId: string | null;
  expectedVersionId: string | null;
  expectedSettingsDigest: string | null;
  requiredDataRoles: ControlBootstrapResourceRole[];
}

export interface BootstrapReleaseStream {
  streamId: string;
  releaseId: string;
  manifestDigest: string;
  state: 'active' | 'retired';
}

export interface BootstrapWorkerObservation {
  workerScriptName: string;
  settingsDigest: string;
}

export interface BootstrapHandoffRepository {
  listPending(limit: number): Promise<BootstrapHandoff[]>;
  listResources(environmentId: string): Promise<BootstrapResource[]>;
  listWorkers(environmentId: string): Promise<BootstrapWorkerEvidence[]>;
  listPinnedReleaseStreams(
    environmentId: string,
    manifestDigest: string
  ): Promise<BootstrapReleaseStream[]>;
  accept(
    handoff: BootstrapHandoff,
    observations: readonly BootstrapWorkerObservation[],
    now: number
  ): Promise<void>;
  block(handoff: BootstrapHandoff, errorCode: string, now: number): Promise<void>;
}

export interface BootstrapHandoffApi {
  getD1Database(this: void, databaseId: string): Promise<CloudflareD1Database>;
  queryD1Batch(
    this: void,
    databaseId: string,
    queries: readonly CloudflareD1Query[]
  ): Promise<CloudflareD1QueryResult[]>;
  getWorkerSettings(this: void, scriptName: string): Promise<CloudflareWorkerSettings>;
  listWorkerDeployments(this: void, scriptName: string): Promise<CloudflareWorkerDeployment[]>;
}

interface BootstrapDesiredSpec {
  bootstrap: true;
  bootstrap_role: ControlBootstrapResourceRole;
  migration_stream_id: string;
  release_id: string;
  manifest_digest: string;
  migration_files: BootstrapMigrationFile[];
  data_role?: ControlBootstrapResourceRole;
  allocation_scope?: 'tenant_exclusive';
  owner_tenant_id?: string;
}

interface MigrationHistoryRow {
  filename?: unknown;
  checksum?: unknown;
}

function safeLimit(limit: number): number {
  if (!Number.isFinite(limit)) throw new Error('control_bootstrap_limit_invalid');
  return Math.max(1, Math.min(Math.floor(limit), MAX_PENDING_HANDOFFS));
}

function permanentError(error: unknown): boolean {
  if (error instanceof CloudflareControlApiError) {
    // Secret-triggered Control Worker versions can become active before the newly
    // registered child token is accepted by every provider endpoint. Keep 401/403
    // retryable during the initial handoff; Setup's bounded handoff wait will still
    // surface a timeout when the capability is genuinely missing.
    return (
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 401 &&
      error.status !== 403 &&
      error.status !== 408 &&
      error.status !== 429
    );
  }
  return (
    error instanceof Error &&
    error.message !== TRANSIENT_NOT_READY_ERROR &&
    SAFE_ERROR.test(error.message)
  );
}

function errorCode(error: unknown): string {
  if (error instanceof Error && SAFE_ERROR.test(error.message)) return error.message;
  if (
    error instanceof CloudflareControlApiError &&
    (error.status === 401 || error.status === 403)
  ) {
    return 'control_bootstrap_provider_capability_rejected';
  }
  if (error instanceof CloudflareControlApiError && error.status >= 400 && error.status < 500) {
    return 'control_bootstrap_provider_request_rejected';
  }
  return 'control_bootstrap_verification_failed';
}

function parseDesiredSpec(resource: BootstrapResource): BootstrapDesiredSpec {
  let value: unknown;
  try {
    value = JSON.parse(resource.desiredSpecJson);
  } catch {
    throw new Error('control_bootstrap_desired_spec_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_bootstrap_desired_spec_invalid');
  }
  const record = value as Record<string, unknown>;
  const files = record.migration_files;
  if (
    record.bootstrap !== true ||
    record.bootstrap_role !== resource.role ||
    record.migration_stream_id !== resource.migrationStreamId ||
    record.release_id !== resource.migrationReleaseId ||
    record.manifest_digest !== resource.manifestDigest ||
    !Array.isArray(files) ||
    files.length === 0
  ) {
    throw new Error('control_bootstrap_desired_spec_invalid');
  }
  if (resource.role === 'lookup') {
    if (
      record.data_role !== 'lookup' ||
      record.allocation_scope !== undefined ||
      record.owner_tenant_id !== undefined
    ) {
      throw new Error('control_bootstrap_desired_spec_invalid');
    }
  } else if (
    record.data_role !== resource.role ||
    record.allocation_scope !== 'tenant_exclusive' ||
    typeof record.owner_tenant_id !== 'string' ||
    record.owner_tenant_id.length === 0 ||
    record.owner_tenant_id !== resource.desiredTenantId
  ) {
    throw new Error('control_bootstrap_desired_spec_invalid');
  }
  const seen = new Set<string>();
  const migrationFiles = files.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('control_bootstrap_migration_files_invalid');
    }
    const file = candidate as Record<string, unknown>;
    if (
      typeof file.path !== 'string' ||
      file.path.length === 0 ||
      file.path.length > 255 ||
      typeof file.checksum !== 'string' ||
      !SHA256.test(file.checksum) ||
      seen.has(file.path)
    ) {
      throw new Error('control_bootstrap_migration_files_invalid');
    }
    seen.add(file.path);
    return { path: file.path, checksum: file.checksum };
  });
  return {
    bootstrap: true,
    bootstrap_role: resource.role,
    migration_stream_id: resource.migrationStreamId!,
    release_id: resource.migrationReleaseId!,
    manifest_digest: resource.manifestDigest,
    migration_files: migrationFiles,
    data_role: record.data_role as ControlBootstrapResourceRole,
    allocation_scope: record.allocation_scope,
    owner_tenant_id: record.owner_tenant_id,
  };
}

function activeDeployment(deployments: readonly CloudflareWorkerDeployment[]): {
  deploymentId: string;
  versionId: string;
} {
  const active = deployments
    .map((deployment) => {
      const version =
        deployment.versions.length === 1 && deployment.versions[0]?.percentage === 100
          ? deployment.versions[0]
          : null;
      const createdAt = Date.parse(deployment.created_on);
      if (!deployment.id || !version?.version_id || !Number.isFinite(createdAt)) return null;
      return {
        deploymentId: deployment.id,
        versionId: version.version_id,
        createdAt,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || right.deploymentId.localeCompare(left.deploymentId)
    );
  if (!active[0]) throw new Error('control_bootstrap_worker_deployment_missing');
  if (active[1]?.createdAt === active[0].createdAt) {
    throw new Error('control_bootstrap_worker_deployment_ambiguous');
  }
  return active[0];
}

function verifyMigrationHistory(
  query: CloudflareD1QueryResult | undefined,
  files: readonly BootstrapMigrationFile[]
): void {
  if (query?.success !== true || !Array.isArray(query.results)) {
    throw new Error('control_bootstrap_migration_history_invalid');
  }
  const actual = query.results as MigrationHistoryRow[];
  if (actual.length !== files.length) {
    throw new Error('control_bootstrap_migration_history_mismatch');
  }
  const expectedByPath = new Map(files.map((file) => [file.path, file.checksum]));
  for (const row of actual) {
    if (
      typeof row.filename !== 'string' ||
      typeof row.checksum !== 'string' ||
      expectedByPath.get(row.filename) !== row.checksum
    ) {
      throw new Error('control_bootstrap_migration_history_mismatch');
    }
    expectedByPath.delete(row.filename);
  }
  if (expectedByPath.size !== 0) {
    throw new Error('control_bootstrap_migration_history_mismatch');
  }
}

function verifyShardSentinel(
  query: CloudflareD1QueryResult | undefined,
  resource: BootstrapResource,
  spec: BootstrapDesiredSpec
): void {
  const row = query?.results?.[0];
  if (query?.success !== true || !row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('control_bootstrap_migration_sentinel_invalid');
  }
  const value = row as Record<string, unknown>;
  if (
    value.binding_ref !== resource.bindingRef ||
    value.data_role !== resource.role ||
    value.residency_partition !== 'default' ||
    value.migration_generation !== 1 ||
    value.release_id !== spec.release_id ||
    value.manifest_digest !== spec.manifest_digest ||
    value.expected_file_count !== spec.migration_files.length ||
    value.last_filename !== spec.migration_files.at(-1)?.path
  ) {
    throw new Error('control_bootstrap_migration_sentinel_mismatch');
  }
}

function d1BindingDatabaseId(binding: Record<string, unknown>): string | null {
  const value = binding.database_id ?? binding.id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class BootstrapHandoffVerifier {
  constructor(
    private readonly repository: BootstrapHandoffRepository,
    private readonly api: BootstrapHandoffApi,
    private readonly now: () => number
  ) {}

  async reconcile(limit = MAX_PENDING_HANDOFFS): Promise<{
    attempted: number;
    accepted: number;
    blocked: number;
    retrying: number;
  }> {
    const handoffs = await this.repository.listPending(safeLimit(limit));
    let accepted = 0;
    let blocked = 0;
    let retrying = 0;
    for (const handoff of handoffs) {
      try {
        const observations = await this.verify(handoff);
        await this.repository.accept(handoff, observations, this.now());
        accepted += 1;
      } catch (error) {
        if (permanentError(error)) {
          await this.repository.block(handoff, errorCode(error), this.now());
          blocked += 1;
        } else {
          retrying += 1;
        }
      }
    }
    return { attempted: handoffs.length, accepted, blocked, retrying };
  }

  private async verify(handoff: BootstrapHandoff): Promise<BootstrapWorkerObservation[]> {
    if (
      !SHA256.test(handoff.ownershipFingerprint) ||
      !SHA256.test(handoff.releaseManifestDigest) ||
      !handoff.observedDeploymentId ||
      !handoff.observedVersionId
    ) {
      throw new Error('control_bootstrap_handoff_record_invalid');
    }
    const [resources, workers, streams] = await Promise.all([
      this.repository.listResources(handoff.environmentId),
      this.repository.listWorkers(handoff.environmentId),
      this.repository.listPinnedReleaseStreams(
        handoff.environmentId,
        handoff.releaseManifestDigest
      ),
    ]);
    if (
      streams.length !== EXPECTED_STREAMS.length ||
      EXPECTED_STREAMS.some((streamId) => {
        const pinnedReleaseIds = new Set(
          resources
            .filter((resource) => resource.migrationStreamId === streamId)
            .map((resource) => resource.migrationReleaseId)
        );
        return (
          pinnedReleaseIds.size !== 1 ||
          !streams.some(
            (stream) =>
              stream.streamId === streamId &&
              stream.releaseId === [...pinnedReleaseIds][0] &&
              stream.manifestDigest === handoff.releaseManifestDigest &&
              (stream.state === 'active' || stream.state === 'retired')
          )
        );
      })
    ) {
      throw new Error('control_bootstrap_release_catalog_mismatch');
    }

    let fingerprint: string;
    try {
      fingerprint = await calculateControlBootstrapOwnershipFingerprint(resources);
    } catch {
      throw new Error('control_bootstrap_resource_set_incomplete');
    }
    if (fingerprint !== handoff.ownershipFingerprint) {
      throw new Error('control_bootstrap_ownership_fingerprint_mismatch');
    }
    const resourceByRole = new Map(resources.map((resource) => [resource.role, resource]));
    for (const resource of resources) {
      await this.verifyResource(resource, handoff.releaseManifestDigest);
    }

    if (workers.length === 0) throw new Error('control_bootstrap_worker_evidence_missing');
    const controlWorker = workers.find(
      (worker) => worker.workerScriptName === `${handoff.environmentName}-ar-control`
    );
    if (
      !controlWorker ||
      controlWorker.expectedDeploymentId !== handoff.observedDeploymentId ||
      controlWorker.expectedVersionId !== handoff.observedVersionId
    ) {
      throw new Error('control_bootstrap_control_deployment_mismatch');
    }

    const observations: BootstrapWorkerObservation[] = [];
    for (const worker of workers) {
      if (
        !worker.expectedDeploymentId ||
        !worker.expectedVersionId ||
        !worker.expectedSettingsDigest ||
        !SHA256.test(worker.expectedSettingsDigest)
      ) {
        throw new Error('control_bootstrap_worker_evidence_missing');
      }
      const [settings, deployments] = await Promise.all([
        this.api.getWorkerSettings(worker.workerScriptName),
        this.api.listWorkerDeployments(worker.workerScriptName),
      ]);
      const active = activeDeployment(deployments);
      if (
        active.deploymentId !== worker.expectedDeploymentId ||
        active.versionId !== worker.expectedVersionId
      ) {
        throw new Error('control_bootstrap_worker_deployment_mismatch');
      }
      let settingsDigest: string;
      try {
        settingsDigest = await digestCloudflareWorkerSettings(settings);
      } catch {
        throw new Error('control_bootstrap_worker_settings_invalid');
      }
      if (settingsDigest !== worker.expectedSettingsDigest) {
        throw new Error('control_bootstrap_worker_settings_mismatch');
      }
      const bindings = Array.isArray(settings.bindings) ? settings.bindings : [];
      for (const role of worker.requiredDataRoles) {
        const resource = resourceByRole.get(role);
        if (!resource) throw new Error('control_bootstrap_resource_set_incomplete');
        const binding = bindings.find((candidate) => candidate.name === resource.bindingRef);
        if (
          !binding ||
          binding.type !== 'd1' ||
          d1BindingDatabaseId(binding) !== resource.providerDatabaseId
        ) {
          throw new Error('control_bootstrap_worker_binding_mismatch');
        }
      }
      observations.push({ workerScriptName: worker.workerScriptName, settingsDigest });
    }
    return observations;
  }

  private async verifyResource(resource: BootstrapResource, manifestDigest: string): Promise<void> {
    const spec = parseDesiredSpec(resource);
    if (
      resource.manifestDigest !== manifestDigest ||
      resource.migrationManifestDigest !== manifestDigest ||
      resource.provisioningState !== 'ready' ||
      resource.observedState !== 'present' ||
      resource.desiredObservedResourceId !== resource.observedResourceId ||
      resource.observedOwnershipFingerprint !== resource.ownershipFingerprint ||
      resource.migrationState !== 'ready' ||
      resource.migrationExpectedFileCount !== spec.migration_files.length ||
      resource.migrationAppliedFileCount !== spec.migration_files.length
    ) {
      throw new Error('control_bootstrap_resource_state_mismatch');
    }
    if (resource.role === 'lookup') {
      if (
        resource.lookupStatus !== 'ready' ||
        resource.desiredResourceScope !== 'platform' ||
        resource.desiredTenantId !== null ||
        resource.allocationScope !== null ||
        resource.ownerTenantId !== null ||
        resource.assignmentCount !== 0 ||
        resource.assignmentTenantId !== null ||
        resource.assignmentState !== null ||
        resource.placementIsolationPolicy !== null ||
        resource.placementPolicyState !== null
      ) {
        throw new Error('control_bootstrap_resource_state_mismatch');
      }
    } else {
      if (
        resource.desiredResourceScope !== 'tenant' ||
        !resource.desiredTenantId ||
        resource.allocationScope !== 'tenant_exclusive' ||
        resource.ownerTenantId !== resource.desiredTenantId ||
        resource.assignmentCount !== 1 ||
        resource.assignmentTenantId !== resource.desiredTenantId ||
        resource.assignmentState !== 'active' ||
        resource.placementIsolationPolicy !== 'tenant_exclusive' ||
        resource.placementPolicyState !== 'active'
      ) {
        throw new Error('control_bootstrap_resource_scope_mismatch');
      }
      if (resource.shardStatus === 'ready' && resource.capacityHealthStatus === null) {
        throw new Error(TRANSIENT_NOT_READY_ERROR);
      }
      if (resource.shardStatus !== 'active' || resource.capacityHealthStatus !== 'healthy') {
        throw new Error('control_bootstrap_resource_state_mismatch');
      }
    }

    const actual = await this.api.getD1Database(resource.providerDatabaseId);
    if (actual.uuid !== resource.providerDatabaseId || actual.name !== resource.providerName) {
      throw new Error('control_bootstrap_d1_actual_mismatch');
    }
    const queries: CloudflareD1Query[] = [{ sql: AUTHRIM_MIGRATION_HISTORY_SQL }];
    if (resource.role !== 'lookup') {
      queries.push({
        sql: `SELECT binding_ref, data_role, residency_partition, migration_generation,
                     release_id, manifest_digest, expected_file_count, last_filename
                FROM authrim_control_plane_shard_metadata
               WHERE singleton_id = 1`,
      });
    }
    const results = await this.api.queryD1Batch(resource.providerDatabaseId, queries);
    verifyMigrationHistory(results[0], spec.migration_files);
    if (resource.role !== 'lookup') verifyShardSentinel(results[1], resource, spec);
  }
}

interface HandoffRow {
  environment_id: string;
  environment_name: string;
  ownership_fingerprint: string;
  release_manifest_digest: string;
  observed_deployment_id: string | null;
  observed_version_id: string | null;
}

interface ResourceRow {
  desired_resource_id: string;
  provider_database_id: string;
  provider_name: string;
  ownership_fingerprint: string;
  binding_ref: string;
  bootstrap_role: ControlBootstrapResourceRole;
  desired_spec_json: string;
  desired_resource_scope: string;
  desired_tenant_id: string | null;
  provisioning_state: string;
  observed_state: string;
  observed_ownership_fingerprint: string | null;
  desired_observed_resource_id: string | null;
  observed_resource_id: string;
  migration_state: string | null;
  migration_stream_id: string | null;
  migration_release_id: string | null;
  migration_manifest_digest: string | null;
  migration_expected_file_count: number | null;
  migration_applied_file_count: number | null;
  shard_status: string | null;
  capacity_health_status: string | null;
  lookup_status: string | null;
  allocation_scope: string | null;
  owner_tenant_id: string | null;
  assignment_count: number | string;
  assignment_tenant_id: string | null;
  assignment_state: string | null;
  placement_isolation_policy: string | null;
  placement_policy_state: string | null;
}

interface WorkerRow {
  worker_script_name: string;
  expected_deployment_id: string | null;
  expected_version_id: string | null;
  expected_settings_digest: string | null;
  required_roles_json: string;
}

interface BootstrapD1Result<T = unknown> {
  results: T[];
  meta: { changes?: number };
}

interface BootstrapD1PreparedStatement {
  bind(...values: unknown[]): BootstrapD1PreparedStatement;
  all<T>(): Promise<BootstrapD1Result<T>>;
}

interface BootstrapD1Database {
  prepare(query: string): BootstrapD1PreparedStatement;
  batch<T = unknown>(
    statements: readonly BootstrapD1PreparedStatement[]
  ): Promise<BootstrapD1Result<T>[]>;
}

export class D1BootstrapHandoffRepository implements BootstrapHandoffRepository {
  constructor(private readonly db: BootstrapD1Database) {}

  async listPending(limit: number): Promise<BootstrapHandoff[]> {
    const rows = await this.db
      .prepare(
        `SELECT handoff.environment_id, environment.environment_name,
                handoff.ownership_fingerprint, handoff.release_manifest_digest,
                handoff.observed_deployment_id, handoff.observed_version_id
           FROM control_bootstrap_handoffs handoff
           JOIN control_environments environment
             ON environment.environment_id = handoff.environment_id
          WHERE handoff.state = 'pending_verification'
          ORDER BY handoff.updated_at, handoff.environment_id
          LIMIT ?`
      )
      .bind(safeLimit(limit))
      .all<HandoffRow>();
    return rows.results.map((row) => ({
      environmentId: row.environment_id,
      environmentName: row.environment_name,
      ownershipFingerprint: row.ownership_fingerprint,
      releaseManifestDigest: row.release_manifest_digest,
      observedDeploymentId: row.observed_deployment_id,
      observedVersionId: row.observed_version_id,
    }));
  }

  async listResources(environmentId: string): Promise<BootstrapResource[]> {
    const rows = await this.db
      .prepare(
        `SELECT desired.desired_resource_id,
                observed.provider_resource_id AS provider_database_id,
                observed.provider_name, desired.ownership_fingerprint,
                COALESCE(shard.binding_ref, lookup.binding_ref) AS binding_ref,
                json_extract(desired.desired_spec_json, '$.bootstrap_role') AS bootstrap_role,
                desired.desired_spec_json, desired.resource_scope AS desired_resource_scope,
                desired.tenant_id AS desired_tenant_id, desired.provisioning_state,
                observed.observed_state,
                observed.ownership_fingerprint AS observed_ownership_fingerprint,
                desired.observed_resource_id AS desired_observed_resource_id,
                observed.observed_resource_id,
                COALESCE(migration.state,
                  CASE WHEN lookup.lookup_shard_id IS NOT NULL THEN 'ready' END
                ) AS migration_state,
                COALESCE(migration.stream_id,
                  json_extract(desired.desired_spec_json, '$.migration_stream_id')
                ) AS migration_stream_id,
                COALESCE(migration.release_id,
                  json_extract(desired.desired_spec_json, '$.release_id')
                ) AS migration_release_id,
                COALESCE(migration.manifest_digest,
                  json_extract(desired.desired_spec_json, '$.manifest_digest')
                ) AS migration_manifest_digest,
                COALESCE(migration.expected_file_count,
                  json_array_length(desired.desired_spec_json, '$.migration_files')
                ) AS migration_expected_file_count,
                COALESCE(migration.applied_file_count,
                  json_array_length(desired.desired_spec_json, '$.migration_files')
                ) AS migration_applied_file_count,
                shard.status AS shard_status, capacity.health_status AS capacity_health_status,
                lookup.status AS lookup_status, shard.allocation_scope, shard.owner_tenant_id,
                (SELECT COUNT(*) FROM control_tenant_shard_assignments assignment
                  WHERE assignment.environment_id = desired.environment_id
                    AND assignment.shard_id = shard.shard_id) AS assignment_count,
                (SELECT MIN(assignment.tenant_id) FROM control_tenant_shard_assignments assignment
                  WHERE assignment.environment_id = desired.environment_id
                    AND assignment.shard_id = shard.shard_id) AS assignment_tenant_id,
                (SELECT MIN(assignment.assignment_state)
                   FROM control_tenant_shard_assignments assignment
                  WHERE assignment.environment_id = desired.environment_id
                    AND assignment.shard_id = shard.shard_id) AS assignment_state,
                policy.isolation_policy AS placement_isolation_policy,
                policy.policy_state AS placement_policy_state
           FROM control_desired_resources desired
           JOIN control_observed_resources observed
             ON observed.desired_resource_id = desired.desired_resource_id
            AND observed.environment_id = desired.environment_id
           LEFT JOIN control_tenant_shards shard
             ON shard.d1_desired_resource_id = desired.desired_resource_id
            AND shard.environment_id = desired.environment_id
           LEFT JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
           LEFT JOIN control_tenant_placement_policies policy
             ON policy.environment_id = shard.environment_id
            AND policy.tenant_id = shard.owner_tenant_id
           LEFT JOIN control_lookup_physical_shards lookup
             ON lookup.d1_desired_resource_id = desired.desired_resource_id
            AND lookup.environment_id = desired.environment_id
           LEFT JOIN control_tenant_database_migration_state migration
             ON migration.desired_resource_id = desired.desired_resource_id
            AND migration.environment_id = desired.environment_id
          WHERE desired.environment_id = ? AND desired.resource_kind = 'd1'
            AND json_extract(desired.desired_spec_json, '$.bootstrap') = 1
          ORDER BY bootstrap_role`
      )
      .bind(environmentId)
      .all<ResourceRow>();
    return rows.results.map((row) => ({
      role: row.bootstrap_role,
      desiredResourceId: row.desired_resource_id,
      providerDatabaseId: row.provider_database_id,
      providerName: row.provider_name,
      ownershipFingerprint: row.ownership_fingerprint,
      bindingRef: row.binding_ref,
      manifestDigest: row.migration_manifest_digest ?? '',
      provisioningState: row.provisioning_state,
      observedState: row.observed_state,
      observedOwnershipFingerprint: row.observed_ownership_fingerprint,
      desiredObservedResourceId: row.desired_observed_resource_id,
      observedResourceId: row.observed_resource_id,
      desiredSpecJson: row.desired_spec_json,
      desiredResourceScope: row.desired_resource_scope,
      desiredTenantId: row.desired_tenant_id,
      migrationState: row.migration_state,
      migrationStreamId: row.migration_stream_id,
      migrationReleaseId: row.migration_release_id,
      migrationManifestDigest: row.migration_manifest_digest,
      migrationExpectedFileCount: row.migration_expected_file_count,
      migrationAppliedFileCount: row.migration_applied_file_count,
      shardStatus: row.shard_status,
      capacityHealthStatus: row.capacity_health_status,
      lookupStatus: row.lookup_status,
      allocationScope: row.allocation_scope,
      ownerTenantId: row.owner_tenant_id,
      assignmentCount:
        typeof row.assignment_count === 'number'
          ? row.assignment_count
          : Number.parseInt(row.assignment_count, 10),
      assignmentTenantId: row.assignment_tenant_id,
      assignmentState: row.assignment_state,
      placementIsolationPolicy: row.placement_isolation_policy,
      placementPolicyState: row.placement_policy_state,
    }));
  }

  async listWorkers(environmentId: string): Promise<BootstrapWorkerEvidence[]> {
    const rows = await this.db
      .prepare(
        `SELECT inventory.worker_script_name, evidence.expected_deployment_id,
                evidence.expected_version_id, evidence.expected_settings_digest,
                COALESCE((
                  SELECT json_group_array(role.data_role)
                    FROM control_worker_required_data_roles role
                   WHERE role.environment_id = inventory.environment_id
                     AND role.worker_script_name = inventory.worker_script_name
                     AND role.data_role IN (
                       'tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup'
                     )
                ), '[]') AS required_roles_json
           FROM control_desired_worker_inventory inventory
           LEFT JOIN control_bootstrap_worker_evidence evidence
             ON evidence.environment_id = inventory.environment_id
            AND evidence.worker_script_name = inventory.worker_script_name
          WHERE inventory.environment_id = ? AND inventory.status = 'active'
          ORDER BY inventory.worker_script_name`
      )
      .bind(environmentId)
      .all<WorkerRow>();
    return rows.results.map((row) => {
      let requiredDataRoles: ControlBootstrapResourceRole[];
      try {
        requiredDataRoles = JSON.parse(row.required_roles_json) as ControlBootstrapResourceRole[];
      } catch {
        throw new Error('control_bootstrap_worker_roles_invalid');
      }
      if (
        !Array.isArray(requiredDataRoles) ||
        requiredDataRoles.some(
          (role) =>
            !['lookup', 'tenant_core/default', 'tenant_core/users', 'tenant_pii'].includes(role)
        ) ||
        new Set(requiredDataRoles).size !== requiredDataRoles.length
      ) {
        throw new Error('control_bootstrap_worker_roles_invalid');
      }
      requiredDataRoles.sort((left, right) => left.localeCompare(right));
      return {
        workerScriptName: row.worker_script_name,
        expectedDeploymentId: row.expected_deployment_id,
        expectedVersionId: row.expected_version_id,
        expectedSettingsDigest: row.expected_settings_digest,
        requiredDataRoles,
      };
    });
  }

  async listPinnedReleaseStreams(
    environmentId: string,
    manifestDigest: string
  ): Promise<BootstrapReleaseStream[]> {
    const rows = await this.db
      .prepare(
        `SELECT stream_id, release_id, manifest_digest, state
           FROM control_migration_release_catalog
          WHERE environment_id = ? AND manifest_digest = ? AND state IN ('active', 'retired')
            AND stream_id IN ('d1-core', 'd1-pii', 'd1-lookup')
          ORDER BY stream_id`
      )
      .bind(environmentId, manifestDigest)
      .all<{
        stream_id: string;
        release_id: string;
        manifest_digest: string;
        state: 'active' | 'retired';
      }>();
    return rows.results.map((row) => ({
      streamId: row.stream_id,
      releaseId: row.release_id,
      manifestDigest: row.manifest_digest,
      state: row.state,
    }));
  }

  async accept(
    handoff: BootstrapHandoff,
    observations: readonly BootstrapWorkerObservation[],
    now: number
  ): Promise<void> {
    const updates = observations.map((observation) =>
      this.db
        .prepare(
          `UPDATE control_bootstrap_worker_evidence
              SET state = 'verified', observed_settings_digest = ?, observed_at = ?,
                  verification_error_code = NULL, updated_at = ?
            WHERE environment_id = ? AND worker_script_name = ? AND state = 'pending'
              AND expected_settings_digest = ?`
        )
        .bind(
          observation.settingsDigest,
          now,
          now,
          handoff.environmentId,
          observation.workerScriptName,
          observation.settingsDigest
        )
    );
    const results = await this.db.batch([
      ...updates,
      this.db
        .prepare(
          `UPDATE control_lookup_physical_shards SET status = 'active', updated_at = ?
            WHERE environment_id = ? AND status = 'ready'
              AND d1_desired_resource_id IN (
                SELECT desired_resource_id FROM control_desired_resources
                 WHERE environment_id = ?
                   AND json_extract(desired_spec_json, '$.bootstrap') = 1
                   AND json_extract(desired_spec_json, '$.bootstrap_role') = 'lookup'
              )`
        )
        .bind(now, handoff.environmentId, handoff.environmentId),
      this.db
        .prepare(
          `UPDATE control_bootstrap_handoffs
              SET state = 'accepted', verification_error_code = NULL,
                  verified_at = ?, accepted_at = ?, updated_at = ?
            WHERE environment_id = ? AND state = 'pending_verification'
              AND ownership_fingerprint = ? AND release_manifest_digest = ?
              AND NOT EXISTS (
                SELECT 1 FROM control_bootstrap_worker_evidence evidence
                 WHERE evidence.environment_id = control_bootstrap_handoffs.environment_id
                   AND evidence.state <> 'verified'
              )`
        )
        .bind(
          now,
          now,
          now,
          handoff.environmentId,
          handoff.ownershipFingerprint,
          handoff.releaseManifestDigest
        ),
      this.db
        .prepare(
          `UPDATE control_environments SET lifecycle_state = 'active', updated_at = ?
            WHERE environment_id = ? AND lifecycle_state = 'creating'
              AND EXISTS (
                SELECT 1 FROM control_bootstrap_handoffs handoff
                 WHERE handoff.environment_id = control_environments.environment_id
                   AND handoff.state = 'accepted'
              )`
        )
        .bind(now, handoff.environmentId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, event_type, actor_type, resource_kind,
             resource_id, outcome, redacted_payload_json, created_at
           ) SELECT ?, ?, 'control.bootstrap_handoff.accepted', 'reconciler',
                    'environment', ?, 'succeeded', ?, ?
             WHERE EXISTS (
               SELECT 1 FROM control_bootstrap_handoffs
                WHERE environment_id = ? AND state = 'accepted'
             )`
        )
        .bind(
          `audit:${handoff.environmentId}:bootstrap-handoff:accepted`,
          handoff.environmentId,
          handoff.environmentId,
          JSON.stringify({
            ownership_fingerprint: handoff.ownershipFingerprint,
            release_manifest_digest: handoff.releaseManifestDigest,
            worker_count: observations.length,
          }),
          now,
          handoff.environmentId
        ),
    ]);
    const handoffResult = results[updates.length + 1];
    if ((handoffResult?.meta.changes ?? 0) !== 1) {
      throw new Error('control_bootstrap_accept_conflict');
    }
  }

  async block(handoff: BootstrapHandoff, errorCode: string, now: number): Promise<void> {
    if (!SAFE_ERROR.test(errorCode)) throw new Error('control_bootstrap_error_code_invalid');
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_bootstrap_handoffs
              SET state = 'blocked', verification_error_code = ?, verified_at = ?, updated_at = ?
            WHERE environment_id = ? AND state = 'pending_verification'`
        )
        .bind(errorCode, now, now, handoff.environmentId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, event_type, actor_type, resource_kind,
             resource_id, outcome, redacted_payload_json, created_at
           ) SELECT ?, ?, 'control.bootstrap_handoff.blocked', 'reconciler',
                    'environment', ?, 'blocked', ?, ?
             WHERE EXISTS (
               SELECT 1 FROM control_bootstrap_handoffs
                WHERE environment_id = ? AND state = 'blocked'
             )`
        )
        .bind(
          `audit:${handoff.environmentId}:bootstrap-handoff:blocked:${errorCode}`,
          handoff.environmentId,
          handoff.environmentId,
          JSON.stringify({ error_code: errorCode }),
          now,
          handoff.environmentId
        ),
    ]);
  }
}
