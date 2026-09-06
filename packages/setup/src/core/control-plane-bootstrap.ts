import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  buildPolicyConstrainedRegionShardConfig,
  buildRegionShardConfigKvKey,
  validateRegionShardResidencyStrict,
  type RegionShardConfigV2,
  type RegionShardResidencyProjection,
} from '@authrim/ar-lib-core/utils/region-sharding';
import {
  createLookupAliasIndex,
  type LookupAliasIndex,
} from '@authrim/ar-lib-core/services/lookup-directory/blind-index';
import {
  RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM,
  RUNTIME_REGISTRY_SNAPSHOT_VERSION,
  signRuntimeRegistrySnapshotPayloadJws,
  verifyRuntimeRegistrySnapshotPayloadJws,
} from '@authrim/ar-lib-core/services/tenant-runtime-registry-snapshot';
import {
  deriveControlRegionShardAllowedRegions,
  getTenantDatabaseBootstrapBinding,
  type ControlRegionShardJurisdiction,
  type ControlRegionShardLocationHint,
} from '@authrim/ar-lib-core/control-plane';
import type { AuthrimConfig } from './config.js';
import { loadLockFileAuto, saveLockFile, type AuthrimLock } from './lock.js';
import {
  buildAssignmentReleaseMigrationTarget,
  calculateReleaseManifestChecksum,
  type ReleaseMigrationManifest,
} from './release-migrations.js';
import {
  buildInitialTenantBootstrapSql,
  createD1Database,
  executeD1Command,
  executeD1Migration,
  findMigrationsRoot,
  getKVKeyByNamespaceId,
  getOptionalKVKeyByNamespaceId,
  putKVKeyByNamespaceId,
  queryD1Rows,
  runD1Migrations,
  getProvisioningResourceAdoptionPolicy,
} from './cloudflare.js';
import {
  beginOrResumeProvisioningIntent,
  completeProvisioningIntent,
  loadProvisioningIntent,
  recordProvisionedResource,
  recordProvisioningResourceCreateIssued,
  recordProvisioningResourceCreateRejected,
  recordProvisioningResourceIdentified,
  type ProvisioningIntent,
  type ProvisioningResourceIdentity,
} from './provisioning-intent.js';
import {
  buildTenantDatabaseRegistrySql,
  getLatestMigrationVersionFromDirectory,
  getLatestMigrationVersionFromFilenames,
  signTenantDatabaseRegistryResources,
  type TenantDatabaseRegistryResourceInput,
} from './tenant-database.js';
import { withPrivateTemporaryTextFile } from './private-temporary-file.js';

const RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS = 30 * 60;
const RUNTIME_REGISTRY_GENERATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const INITIAL_RUNTIME_REGISTRY_VERIFY_RETRY_DELAYS_MS = [
  250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
] as const;

interface RuntimeGenerationPointer {
  runtimeGeneration: number;
  routeStatus: string;
  quarantineDenyGeneration: number;
  publishedAt: string;
  expiresAt: string;
}

interface RuntimeRegistryVerificationOptions {
  /** Deterministic test override. Production callers use the bounded exponential schedule above. */
  retryDelaysMs?: readonly number[];
  /** Deterministic test override. Production callers use a real timer. */
  wait?: (milliseconds: number) => Promise<void>;
}

function isRecoverableInitialHandoffError(errorCode: unknown): boolean {
  return (
    typeof errorCode === 'string' &&
    (errorCode === 'control_bootstrap_provider_capability_rejected' ||
      /^control_bootstrap_worker_[a-z0-9_]+$/u.test(errorCode))
  );
}

type InitialControlPlaneBootstrapResource = TenantDatabaseRegistryResourceInput & {
  databaseName: string;
  binding: string;
  databaseId: string;
  schemaVersion: number;
  shardGroup: string;
};

export type InitialControlPlaneResourceRole =
  | 'lookup'
  | 'tenant_core/default'
  | 'tenant_core/users'
  | 'tenant_pii';

export interface InitialControlPlaneResourcePlan {
  role: InitialControlPlaneResourceRole;
  binding: string;
  databaseName: string;
  databaseId: string;
  operationId: string;
  desiredResourceId: string;
  observedResourceId: string;
  shardId: string | null;
  lookupShardId: string | null;
  logicalShardId: string;
  ownershipFingerprint: string;
  migrationStreamId: 'd1-core' | 'd1-pii' | 'd1-lookup';
  releaseId: string;
  manifestDigest: string;
  migrationFiles: Array<{ path: string; checksum: string }>;
}

function initialTenantShardDefinitions(env: string) {
  return [
    {
      role: 'tenant_core/default' as const,
      binding: getTenantDatabaseBootstrapBinding(env, 'default'),
      nameRole: 'default',
      streamId: 'd1-core' as const,
    },
    {
      role: 'tenant_core/users' as const,
      binding: getTenantDatabaseBootstrapBinding(env, 'users'),
      nameRole: 'users',
      streamId: 'd1-core' as const,
    },
    {
      role: 'tenant_pii' as const,
      binding: getTenantDatabaseBootstrapBinding(env, 'pii'),
      nameRole: 'pii',
      streamId: 'd1-pii' as const,
    },
  ];
}

function bootstrapDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bootstrapDatabaseName(env: string, nameRole: string): string {
  const normalizedEnv = env
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 24);
  if (!normalizedEnv) throw new Error('initial_control_plane_environment_invalid');
  return `${normalizedEnv}-authrim-tenant-${nameRole}-bootstrap-db`;
}

export function buildInitialControlPlaneResourcePlans(input: {
  env: string;
  lock: AuthrimLock;
  release: ReleaseMigrationManifest;
  releaseDraft?: boolean;
}): InitialControlPlaneResourcePlan[] {
  const manifestDigest = calculateReleaseManifestChecksum(input.release);
  const releaseId = input.releaseDraft
    ? `${input.release.productVersion}-draft.${manifestDigest.slice(0, 12)}`
    : input.release.productVersion;
  const definitions: Array<{
    role: InitialControlPlaneResourceRole;
    binding: string;
    databaseName: string;
    streamId: 'd1-core' | 'd1-pii' | 'd1-lookup';
  }> = [
    {
      role: 'lookup',
      binding: 'LOOKUP_DB',
      databaseName: input.lock.d1.LOOKUP_DB?.name ?? '',
      streamId: 'd1-lookup',
    },
    ...initialTenantShardDefinitions(input.env).map((definition) => ({
      role: definition.role,
      binding: definition.binding,
      databaseName:
        input.lock.d1[definition.binding]?.name ??
        bootstrapDatabaseName(input.env, definition.nameRole),
      streamId: definition.streamId,
    })),
  ];

  return definitions.map((definition) => {
    const locked = input.lock.d1[definition.binding];
    if (!locked || !locked.id || !locked.name || locked.name !== definition.databaseName) {
      throw new Error(`initial_control_plane_binding_missing:${definition.binding}`);
    }
    const stream = input.release.streams.find((candidate) => candidate.id === definition.streamId);
    if (!stream || stream.files.length === 0) {
      throw new Error(`release_migration_stream_not_found:${definition.streamId}`);
    }
    const digest = bootstrapDigest(`${input.env}\0${definition.role}\0${definition.databaseName}`);
    return {
      role: definition.role,
      binding: definition.binding,
      databaseName: definition.databaseName,
      databaseId: locked.id,
      operationId: `op_bootstrap_${digest.slice(0, 32)}`,
      desiredResourceId: `d1_bootstrap_${digest.slice(0, 32)}`,
      observedResourceId: `observed_bootstrap_${digest.slice(0, 32)}`,
      shardId: definition.role === 'lookup' ? null : `shard_bootstrap_${digest.slice(0, 32)}`,
      lookupShardId:
        definition.role === 'lookup' ? `lookup_bootstrap_${digest.slice(0, 32)}` : null,
      logicalShardId: `bootstrap:${definition.role}:default`,
      ownershipFingerprint: digest,
      migrationStreamId: definition.streamId,
      releaseId,
      manifestDigest,
      migrationFiles: stream.files.map((file) => ({ path: file.path, checksum: file.checksum })),
    };
  });
}

type RuntimeRegistryPrivateJwk = {
  kty?: string;
  crv?: string;
  d?: string;
  kid?: string;
  [key: string]: unknown;
};

interface CountRow extends Record<string, unknown> {
  count: number | string;
}

interface InitialTenantAliasBootstrap {
  indexes: LookupAliasIndex[];
  projectionJson: string;
  sql: string;
}

export interface ControlPlaneBootstrapResult {
  success: boolean;
  skipped?: boolean;
  createdCount?: number;
  migratedCount?: number;
  publishedSnapshot?: boolean;
  error?: string;
}

export interface ControlPlaneTopologyIssue {
  binding: string;
  reason: 'missing_binding' | 'schema_not_registered';
  targetId?: string;
}

interface RuntimeSnapshotStore {
  tenantId: string;
  role: string;
  dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
  residencyPolicyId: string;
  residencyPartition: string;
  shardId: string;
  assignmentGeneration: number;
  bindingRouteGeneration: number;
  placementPolicyGeneration: number;
  allocationScope: 'shared_pool' | 'tenant_exclusive';
  ownerTenantId: string | null;
  generation: number;
  runtimeGeneration: number;
  schemaVersion: number;
  shardGroup: string;
  shardIndex: number;
  shardCount: number;
  shardKeyStrategy: string;
  provider: string;
  driver: string;
  bindingRef: string | null;
  connectionRef: string | null;
  deploymentTarget: string | null;
  status: string;
  healthStatus: string;
  databaseId: string | null;
  databaseName: string | null;
  regionHint: string | null;
  jurisdiction: string | null;
}

interface RuntimeSnapshot {
  version: number;
  tenantId: string;
  snapshotScope: 'tenant';
  deploymentTarget: string;
  runtimeGeneration: number;
  routeStatus: 'active';
  quarantineDenyGeneration: number;
  backend: { provider: 'd1'; resolver: 'control-plane' };
  placement: {
    isolationPolicy: 'shared_pool' | 'tenant_exclusive';
    policyGeneration: number;
  };
  publishedAt: string;
  expiresAt: string;
  stores: RuntimeSnapshotStore[];
  metadata: {
    storeCount: number;
    roles: string[];
    signature: string | null;
    signatureKeyId: string | null;
    signatureAlgorithm?: string | null;
    signedAt?: string | null;
  };
}

function tenantIdForConfig(config: AuthrimConfig): string {
  return config.tenant?.name?.trim() || 'default';
}

export async function buildInitialTenantAliasBootstrap(input: {
  environmentId: string;
  tenantId: string;
  tenantCode: string;
  defaultStore: RuntimeSnapshotStore;
  now?: number;
}): Promise<InitialTenantAliasBootstrap> {
  const bindingRef = input.defaultStore.bindingRef?.trim();
  if (!bindingRef) throw new Error('initial_tenant_alias_binding_ref_missing');
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new Error('initial_tenant_alias_timestamp_invalid');
  }
  const projection = {
    schemaVersion: 1,
    tenantRouteGeneration: input.defaultStore.bindingRouteGeneration,
    residencyPolicyId: input.defaultStore.residencyPolicyId,
    target: {
      dataRole: 'tenant_core/default',
      residencyPartition: input.defaultStore.residencyPartition,
      shardId: input.defaultStore.shardId,
      bindingRef,
      requiredBindingRouteGeneration: input.defaultStore.bindingRouteGeneration,
    },
  };
  const projectionJson = JSON.stringify(projection);
  const indexes = await Promise.all([
    createLookupAliasIndex('tenant_code', input.tenantCode),
    createLookupAliasIndex('tenant_slug', input.tenantId),
    createLookupAliasIndex('environment_tenant', input.environmentId),
  ]);
  const values = indexes
    .map(
      (index) =>
        `(${index.virtualBucket}, ${sqlString(index.aliasKind)}, ${sqlString(index.digest)}, ` +
        `${sqlString(input.tenantId)}, 1, ${sqlString(projectionJson)}, ` +
        `'active', 'active', 'active', ${now}, ${now})`
    )
    .join(',\n');

  return {
    indexes,
    projectionJson,
    sql: `INSERT INTO lookup_tenant_aliases (
      virtual_bucket, alias_kind, alias_sha256_digest, tenant_id,
      route_schema_version, route_projection_json, tenant_lifecycle_state,
      runtime_route_status, lifecycle_state, created_at, updated_at
    ) VALUES
    ${values}
    ON CONFLICT(virtual_bucket, alias_kind, alias_sha256_digest, tenant_id) DO UPDATE SET
      route_schema_version = excluded.route_schema_version,
      route_projection_json = excluded.route_projection_json,
      tenant_lifecycle_state = excluded.tenant_lifecycle_state,
      runtime_route_status = excluded.runtime_route_status,
      lifecycle_state = excluded.lifecycle_state,
      updated_at = excluded.updated_at;`,
  };
}

interface InitialTenantRegionPolicyRow extends Record<string, unknown> {
  residency_policy_id: string;
  residency_partition: string;
  policy_generation: number | string;
  policy_updated_at: number | string;
  jurisdiction: string | null;
  location_hint: string | null;
  data_role: string;
  shard_id: string;
  selected_shard_id: string;
}

const INITIAL_TENANT_DATA_ROLES = new Set([
  'tenant_core/default',
  'tenant_core/users',
  'tenant_pii',
]);

function parseControlRegionPlacement(row: InitialTenantRegionPolicyRow): {
  jurisdiction: ControlRegionShardJurisdiction;
  locationHint: ControlRegionShardLocationHint;
} {
  if (row.jurisdiction !== null && row.jurisdiction !== 'eu' && row.jurisdiction !== 'fedramp') {
    throw new Error('initial_tenant_region_jurisdiction_invalid');
  }
  if (
    row.location_hint !== null &&
    !['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'].includes(row.location_hint)
  ) {
    throw new Error('initial_tenant_region_location_hint_invalid');
  }
  return {
    jurisdiction: row.jurisdiction,
    locationHint: row.location_hint as ControlRegionShardLocationHint,
  };
}

function sameResidencyProjection(
  observed: RegionShardResidencyProjection | undefined,
  expected: RegionShardResidencyProjection
): boolean {
  return (
    observed?.version === expected.version &&
    observed.residencyPolicyId === expected.residencyPolicyId &&
    observed.residencyPartition === expected.residencyPartition &&
    observed.policyGeneration === expected.policyGeneration &&
    observed.jurisdiction === expected.jurisdiction &&
    observed.allowedRegions.length === expected.allowedRegions.length &&
    observed.allowedRegions.every((region) => expected.allowedRegions.includes(region))
  );
}

export async function ensureInitialTenantRegionShardConfig(input: {
  environmentId: string;
  tenantId: string;
  controlDatabaseName: string;
  configNamespaceId: string;
  query?: typeof queryD1Rows;
  getOptionalKv?: typeof getOptionalKVKeyByNamespaceId;
  putKv?: typeof putKVKeyByNamespaceId;
}): Promise<{ created: boolean; config: RegionShardConfigV2 }> {
  const tenantIdSql = sqlString(input.tenantId);
  const environmentIdSql = sqlString(input.environmentId);
  const rows = await (input.query ?? queryD1Rows)<InitialTenantRegionPolicyRow>(
    input.controlDatabaseName,
    `SELECT allocation.residency_policy_id, allocation.residency_partition,
            policy.policy_generation, policy.updated_at AS policy_updated_at,
            partition.jurisdiction, partition.location_hint,
            assignment.data_role, assignment.shard_id, allocation.selected_shard_id
       FROM control_tenant_default_allocations allocation
       JOIN control_tenant_placement_policies policy
         ON policy.environment_id = allocation.environment_id
        AND policy.tenant_id = allocation.tenant_id
        AND policy.policy_state = 'active'
       JOIN control_residency_partitions partition
         ON partition.environment_id = allocation.environment_id
        AND partition.residency_policy_id = allocation.residency_policy_id
        AND partition.residency_partition = allocation.residency_partition
        AND partition.status = 'active'
       JOIN control_tenant_shard_assignments assignment
         ON assignment.environment_id = allocation.environment_id
        AND assignment.tenant_id = allocation.tenant_id
        AND assignment.residency_policy_id = allocation.residency_policy_id
        AND assignment.residency_partition = allocation.residency_partition
        AND assignment.assignment_state = 'active'
      WHERE allocation.environment_id = ${environmentIdSql}
        AND allocation.tenant_id = ${tenantIdSql}
        AND allocation.reservation_state = 'committed'
      ORDER BY assignment.data_role;`
  );
  const first = rows[0];
  const roles = new Set(rows.map((row) => row.data_role));
  if (
    !first ||
    rows.length !== INITIAL_TENANT_DATA_ROLES.size ||
    roles.size !== INITIAL_TENANT_DATA_ROLES.size ||
    [...roles].some((role) => !INITIAL_TENANT_DATA_ROLES.has(role)) ||
    rows.some(
      (row) =>
        row.residency_policy_id !== first.residency_policy_id ||
        row.residency_partition !== first.residency_partition ||
        Number(row.policy_generation) !== Number(first.policy_generation) ||
        row.jurisdiction !== first.jurisdiction ||
        row.location_hint !== first.location_hint
    ) ||
    rows.some(
      (row) => row.data_role === 'tenant_core/default' && row.shard_id !== row.selected_shard_id
    )
  ) {
    throw new Error('initial_tenant_region_control_topology_incomplete');
  }
  const policyGeneration = Number(first.policy_generation);
  const policyUpdatedAt = Number(first.policy_updated_at);
  if (
    !Number.isSafeInteger(policyGeneration) ||
    policyGeneration < 1 ||
    !Number.isSafeInteger(policyUpdatedAt) ||
    policyUpdatedAt < 1
  ) {
    throw new Error('initial_tenant_region_policy_generation_invalid');
  }
  const placement = parseControlRegionPlacement(first);
  const residency: RegionShardResidencyProjection = {
    version: 1,
    residencyPolicyId: first.residency_policy_id,
    residencyPartition: first.residency_partition,
    policyGeneration,
    allowedRegions: deriveControlRegionShardAllowedRegions(placement),
    jurisdiction: placement.jurisdiction,
  };
  const expected = buildPolicyConstrainedRegionShardConfig({
    residency,
    now: policyUpdatedAt * 1000,
    updatedBy: 'setup:control-residency-policy',
  });
  const key = buildRegionShardConfigKvKey(input.tenantId);
  const existingText = await (input.getOptionalKv ?? getOptionalKVKeyByNamespaceId)(
    input.configNamespaceId,
    key
  );
  if (existingText !== null) {
    let existing: RegionShardConfigV2;
    try {
      existing = JSON.parse(existingText) as RegionShardConfigV2;
      validateRegionShardResidencyStrict(existing);
    } catch {
      throw new Error('initial_tenant_region_config_invalid');
    }
    if (!sameResidencyProjection(existing.residency, residency)) {
      throw new Error('initial_tenant_region_config_policy_stale');
    }
    return { created: false, config: existing };
  }
  await (input.putKv ?? putKVKeyByNamespaceId)(
    input.configNamespaceId,
    key,
    JSON.stringify(expected)
  );
  return { created: true, config: expected };
}

function registryResourceFromInitialPlan(input: {
  plan: InitialControlPlaneResourcePlan;
  schemaVersion: number;
  tenantId: string;
  placementPolicy: 'shared_pool' | 'tenant_exclusive';
}): InitialControlPlaneBootstrapResource {
  if (input.plan.role === 'lookup') {
    throw new Error('initial_control_plane_lookup_not_tenant_store');
  }
  return {
    role: input.plan.role === 'tenant_pii' ? 'tenant_pii' : 'tenant_core',
    shardGroup: input.plan.role === 'tenant_core/users' ? 'users' : 'default',
    databaseName: input.plan.databaseName,
    binding: input.plan.binding,
    generation: 1,
    databaseId: input.plan.databaseId,
    schemaVersion: input.schemaVersion,
    status: 'active',
    metadata: {
      control_data_role: input.plan.role,
      control_residency_policy_id: 'builtin:residency:default',
      control_residency_partition: 'default',
      control_shard_id: input.plan.shardId,
      control_assignment_generation: 1,
      control_allocation_scope: input.placementPolicy,
      control_owner_tenant_id: input.placementPolicy === 'tenant_exclusive' ? input.tenantId : null,
      control_placement_policy_generation: 1,
    },
  };
}

/**
 * Report Control Plane topology drift without mutating Cloudflare or the lock file.
 * Worker-only redeploys use this to fail closed instead of implicitly creating
 * databases or applying migrations.
 */
export function inspectInitialControlPlaneTopology(input: {
  env: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  productVersion: string;
  manifest: ReleaseMigrationManifest;
}): ControlPlaneTopologyIssue[] {
  const manifestChecksum = calculateReleaseManifestChecksum(input.manifest);
  const issues: ControlPlaneTopologyIssue[] = [];

  for (const resource of initialTenantShardDefinitions(input.env)) {
    const locked = input.lock.d1[resource.binding];
    if (!locked) {
      issues.push({ binding: resource.binding, reason: 'missing_binding' });
      continue;
    }

    const target = buildAssignmentReleaseMigrationTarget({
      binding: resource.binding,
      databaseId: locked.id,
      databaseName: locked.name,
      role: resource.role === 'tenant_pii' ? 'tenant_pii' : 'tenant_core',
    });
    const state = input.lock.schemaTargets?.[target.id];
    if (
      !state ||
      state.productVersion !== input.productVersion ||
      state.manifestChecksum !== manifestChecksum ||
      state.streamId !== target.streamId
    ) {
      issues.push({
        binding: resource.binding,
        reason: 'schema_not_registered',
        targetId: target.id,
      });
    }
  }

  return issues;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function countValue(row: CountRow | undefined): number {
  if (typeof row?.count === 'number') return row.count;
  if (typeof row?.count === 'string') return Number.parseInt(row.count, 10) || 0;
  return 0;
}

function canonicalizeJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('runtime_registry_snapshot_unsupported_canonical_json_value');
}

function createSnapshotSigningPayload(snapshot: RuntimeSnapshot): Uint8Array {
  const signingSnapshot: RuntimeSnapshot = {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      signature: null,
      signatureKeyId: null,
      signatureAlgorithm: null,
      signedAt: null,
    },
  };
  return new TextEncoder().encode(canonicalizeJson(signingSnapshot));
}

async function signSnapshot(
  snapshot: RuntimeSnapshot,
  keysDir: string,
  signedAt: string,
  activeKey?: { slot: 'A' | 'B'; keyId: string }
): Promise<RuntimeSnapshot> {
  const privateKeyFile =
    activeKey?.slot === 'B'
      ? 'runtime_registry_signing_jwk_slot_b.private.jwk.json'
      : 'tenant_runtime_registry_signing_private.jwk.json';
  const privateJwkText = await readFile(join(keysDir, privateKeyFile), 'utf-8');
  const privateJwk = JSON.parse(privateJwkText) as RuntimeRegistryPrivateJwk;
  const keyIdFromFile = await readFile(
    join(keysDir, 'tenant_runtime_registry_signing_key_id.txt'),
    'utf-8'
  ).catch(() => '');
  const reflectedKeyId = keyIdFromFile.trim();
  if (activeKey && reflectedKeyId && reflectedKeyId !== activeKey.keyId) {
    throw new Error('runtime_registry_snapshot_signing_key_id_file_mismatch');
  }
  const keyId = activeKey?.keyId ?? (reflectedKeyId || privateJwk.kid || null);
  if (
    privateJwk.kty !== 'OKP' ||
    privateJwk.crv !== 'Ed25519' ||
    typeof privateJwk.d !== 'string'
  ) {
    throw new Error('runtime_registry_snapshot_signing_key_must_be_ed25519_private_jwk');
  }
  if (!keyId) {
    throw new Error('runtime_registry_snapshot_signing_key_id_required');
  }

  const payload = createSnapshotSigningPayload(snapshot);
  const signature = await signRuntimeRegistrySnapshotPayloadJws({
    payload,
    privateJwk,
    keyId,
  });
  if (
    !(await verifyRuntimeRegistrySnapshotPayloadJws({
      token: signature,
      payload,
      keys: [
        {
          publicJwk: { ...privateJwk, d: undefined, key_ops: ['verify'] },
          keyId,
        },
      ],
      expectedKeyId: keyId,
    }))
  ) {
    throw new Error('runtime_registry_snapshot_signing_self_verification_failed');
  }

  return {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      signature,
      signatureKeyId: keyId,
      signatureAlgorithm: RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM,
      signedAt,
    },
  };
}

function buildSnapshotKey(tenantId: string, deploymentTarget = 'default'): string {
  return `tenant:${tenantId}:runtime-registry:snapshot:tenant:${deploymentTarget}`;
}

function buildGenerationKey(tenantId: string, deploymentTarget = 'default'): string {
  return `tenant:${tenantId}:runtime-registry:generation:tenant:${deploymentTarget}`;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function controlSnapshotMetadata(resource: InitialControlPlaneBootstrapResource): {
  dataRole: RuntimeSnapshotStore['dataRole'];
  residencyPolicyId: string;
  residencyPartition: string;
  shardId: string;
  assignmentGeneration: number;
  placementPolicyGeneration: number;
  allocationScope: RuntimeSnapshotStore['allocationScope'];
  ownerTenantId: string | null;
} {
  const metadata = resource.metadata ?? {};
  const dataRole = metadata.control_data_role;
  const residencyPolicyId = metadata.control_residency_policy_id;
  const residencyPartition = metadata.control_residency_partition;
  const shardId = metadata.control_shard_id;
  const assignmentGeneration = metadata.control_assignment_generation;
  const placementPolicyGeneration = metadata.control_placement_policy_generation;
  const allocationScope = metadata.control_allocation_scope;
  const ownerTenantId = metadata.control_owner_tenant_id;
  if (
    typeof dataRole !== 'string' ||
    !['tenant_core/default', 'tenant_core/users', 'tenant_pii'].includes(dataRole) ||
    typeof residencyPolicyId !== 'string' ||
    residencyPolicyId.length === 0 ||
    typeof residencyPartition !== 'string' ||
    residencyPartition.length === 0 ||
    typeof shardId !== 'string' ||
    shardId.length === 0 ||
    !Number.isSafeInteger(assignmentGeneration) ||
    Number(assignmentGeneration) <= 0 ||
    !Number.isSafeInteger(placementPolicyGeneration) ||
    Number(placementPolicyGeneration) <= 0 ||
    !['shared_pool', 'tenant_exclusive'].includes(String(allocationScope)) ||
    (ownerTenantId !== null && typeof ownerTenantId !== 'string')
  ) {
    throw new Error('initial_control_plane_snapshot_metadata_invalid');
  }
  return {
    dataRole: dataRole as RuntimeSnapshotStore['dataRole'],
    residencyPolicyId,
    residencyPartition,
    shardId,
    assignmentGeneration: Number(assignmentGeneration),
    placementPolicyGeneration: Number(placementPolicyGeneration),
    allocationScope: allocationScope as RuntimeSnapshotStore['allocationScope'],
    ownerTenantId,
  };
}

function buildRuntimeSnapshot(input: {
  tenantId: string;
  placementPolicy: 'shared_pool' | 'tenant_exclusive';
  resources: InitialControlPlaneBootstrapResource[];
  now?: Date;
}): RuntimeSnapshot {
  const now = input.now ?? new Date();
  const publishedAt = now.toISOString();
  const expiresAt = addSeconds(now, RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS).toISOString();
  const runtimeGeneration = 1;
  const stores: RuntimeSnapshotStore[] = input.resources.map((resource) => {
    const control = controlSnapshotMetadata(resource);
    const expectedOwnerTenantId =
      input.placementPolicy === 'tenant_exclusive' ? input.tenantId : null;
    if (
      control.allocationScope !== input.placementPolicy ||
      control.ownerTenantId !== expectedOwnerTenantId
    ) {
      throw new Error('initial_control_plane_snapshot_ownership_invalid');
    }
    return {
      tenantId: input.tenantId,
      role: resource.role,
      dataRole: control.dataRole,
      residencyPolicyId: control.residencyPolicyId,
      residencyPartition: control.residencyPartition,
      shardId: control.shardId,
      assignmentGeneration: control.assignmentGeneration,
      bindingRouteGeneration: resource.generation,
      placementPolicyGeneration: control.placementPolicyGeneration,
      allocationScope: control.allocationScope,
      ownerTenantId: control.ownerTenantId,
      generation: resource.generation,
      runtimeGeneration,
      schemaVersion: resource.schemaVersion,
      shardGroup: resource.shardGroup,
      shardIndex: 0,
      shardCount: 1,
      shardKeyStrategy: 'none',
      provider: 'd1',
      driver: 'd1',
      bindingRef: resource.binding,
      connectionRef: null,
      deploymentTarget: null,
      status: 'active',
      healthStatus: 'active',
      databaseId: resource.databaseId,
      databaseName: resource.databaseName,
      regionHint: null,
      jurisdiction: null,
    };
  });

  return {
    version: RUNTIME_REGISTRY_SNAPSHOT_VERSION,
    tenantId: input.tenantId,
    snapshotScope: 'tenant',
    deploymentTarget: 'default',
    runtimeGeneration,
    routeStatus: 'active',
    quarantineDenyGeneration: 0,
    backend: { provider: 'd1', resolver: 'control-plane' },
    placement: { isolationPolicy: input.placementPolicy, policyGeneration: 1 },
    publishedAt,
    expiresAt,
    stores,
    metadata: {
      storeCount: stores.length,
      roles: Array.from(new Set(stores.map((store) => store.role))).sort(),
      signature: null,
      signatureKeyId: null,
      signatureAlgorithm: null,
      signedAt: null,
    },
  };
}

async function executeAdminSql(input: {
  adminDatabaseId: string;
  tenantId: string;
  sql: string;
}): Promise<void> {
  await withPrivateTemporaryTextFile(
    input.sql,
    async (sqlPath) => {
      const result = await executeD1Migration(input.adminDatabaseId, sqlPath);
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to write initial tenant database registry rows');
      }
    },
    { directoryPrefix: 'authrim-control-bootstrap-', filename: 'admin.sql' }
  );
}

class RuntimeRegistryTransientReadError extends Error {}

class RuntimeRegistryMalformedError extends Error {}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRuntimeSnapshotObservation(text: string): RuntimeSnapshot {
  if (text.trim().length === 0) {
    throw new RuntimeRegistryTransientReadError('initial_control_plane_runtime_snapshot_missing');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RuntimeRegistryMalformedError('initial_control_plane_runtime_snapshot_malformed', {
      cause: error,
    });
  }
  if (
    !isJsonRecord(value) ||
    typeof value.version !== 'number' ||
    typeof value.tenantId !== 'string' ||
    typeof value.snapshotScope !== 'string' ||
    typeof value.deploymentTarget !== 'string' ||
    !Number.isSafeInteger(value.runtimeGeneration) ||
    typeof value.routeStatus !== 'string' ||
    !Number.isSafeInteger(value.quarantineDenyGeneration) ||
    !isJsonRecord(value.backend) ||
    !isJsonRecord(value.placement) ||
    typeof value.publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.publishedAt)) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !Array.isArray(value.stores) ||
    value.stores.some((store) => !isJsonRecord(store)) ||
    !isJsonRecord(value.metadata)
  ) {
    throw new RuntimeRegistryMalformedError('initial_control_plane_runtime_snapshot_malformed');
  }
  return value as unknown as RuntimeSnapshot;
}

function parseRuntimeGenerationObservation(text: string): RuntimeGenerationPointer {
  if (text.trim().length === 0) {
    throw new RuntimeRegistryTransientReadError('initial_control_plane_runtime_generation_missing');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RuntimeRegistryMalformedError('initial_control_plane_runtime_generation_malformed', {
      cause: error,
    });
  }
  if (
    !isJsonRecord(value) ||
    !Number.isSafeInteger(value.runtimeGeneration) ||
    typeof value.routeStatus !== 'string' ||
    !Number.isSafeInteger(value.quarantineDenyGeneration) ||
    typeof value.publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.publishedAt)) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new RuntimeRegistryMalformedError('initial_control_plane_runtime_generation_malformed');
  }
  return value as unknown as RuntimeGenerationPointer;
}

async function waitForRuntimeRegistryVerification(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function readExpectedRuntimeRegistryPublication(input: {
  runtimeRegistryNamespaceId: string;
  tenantId: string;
  expectedSnapshot: RuntimeSnapshot;
  expectedGeneration: RuntimeGenerationPointer;
  verification?: RuntimeRegistryVerificationOptions;
  onProgress?: (message: string) => void;
}): Promise<{ snapshot: RuntimeSnapshot; generation: RuntimeGenerationPointer }> {
  const retryDelaysMs =
    input.verification?.retryDelaysMs ?? INITIAL_RUNTIME_REGISTRY_VERIFY_RETRY_DELAYS_MS;
  if (
    retryDelaysMs.length > INITIAL_RUNTIME_REGISTRY_VERIFY_RETRY_DELAYS_MS.length ||
    retryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 30_000)
  ) {
    throw new Error('initial_control_plane_runtime_verification_retry_schedule_invalid');
  }
  const wait = input.verification?.wait ?? waitForRuntimeRegistryVerification;
  const expectedSnapshotCanonical = canonicalizeJson(input.expectedSnapshot);
  const expectedGenerationCanonical = canonicalizeJson(input.expectedGeneration);
  let lastReadError: unknown = null;
  let lastObservationWasReadError = false;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const snapshotText = await getKVKeyByNamespaceId(
        input.runtimeRegistryNamespaceId,
        buildSnapshotKey(input.tenantId)
      );
      const snapshot = parseRuntimeSnapshotObservation(snapshotText);
      const generationText = await getKVKeyByNamespaceId(
        input.runtimeRegistryNamespaceId,
        buildGenerationKey(input.tenantId)
      );
      const generation = parseRuntimeGenerationObservation(generationText);
      lastObservationWasReadError = false;
      if (
        canonicalizeJson(snapshot) === expectedSnapshotCanonical &&
        canonicalizeJson(generation) === expectedGenerationCanonical
      ) {
        return { snapshot, generation };
      }
    } catch (error) {
      if (error instanceof RuntimeRegistryMalformedError) throw error;
      lastObservationWasReadError = true;
      lastReadError = error;
    }

    const delayMs = retryDelaysMs[attempt];
    if (delayMs === undefined) break;
    input.onProgress?.(
      `  ⏳ Runtime registry KV has not converged yet; retrying verification ` +
        `(${attempt + 2}/${retryDelaysMs.length + 1})...`
    );
    await wait(delayMs);
  }

  if (lastObservationWasReadError) {
    throw new Error('initial_control_plane_runtime_snapshot_read_failed', {
      cause: lastReadError,
    });
  }
  throw new Error('initial_control_plane_runtime_snapshot_smoke_failed');
}

async function verifyInitialControlPlaneBootstrap(input: {
  adminDatabaseId: string;
  lookupDatabaseId: string;
  runtimeRegistryNamespaceId: string;
  tenantId: string;
  coreDatabaseId: string;
  resources: readonly InitialControlPlaneBootstrapResource[];
  expectedSnapshot: RuntimeSnapshot;
  expectedGeneration: RuntimeGenerationPointer;
  expectedAliases: InitialTenantAliasBootstrap;
  verification?: RuntimeRegistryVerificationOptions;
  onProgress?: (message: string) => void;
}): Promise<void> {
  const tenantIdSql = sqlString(input.tenantId);
  const [pointerRow] = await queryD1Rows<CountRow>(
    input.adminDatabaseId,
    `SELECT COUNT(*) AS count
       FROM tenant_database_active_pointers
      WHERE tenant_id = ${tenantIdSql}
        AND ((role = 'tenant_core' AND shard_group IN ('default', 'users'))
          OR (role = 'tenant_pii' AND shard_group = 'default'))
        AND status = 'active';`
  );
  if (countValue(pointerRow) !== 3) {
    throw new Error('initial_control_plane_active_pointer_verification_failed');
  }

  const [tenantRow] = await queryD1Rows<CountRow>(
    input.coreDatabaseId,
    `SELECT COUNT(*) AS count
      FROM tenants
      WHERE id = ${tenantIdSql}
        AND lifecycle_state = 'active';`
  );
  if (countValue(tenantRow) !== 1) {
    throw new Error('initial_control_plane_core_tenant_verification_failed');
  }

  const aliasPredicates = input.expectedAliases.indexes
    .map(
      (index) =>
        `(virtual_bucket = ${index.virtualBucket} AND alias_kind = ${sqlString(index.aliasKind)} ` +
        `AND alias_sha256_digest = ${sqlString(index.digest)})`
    )
    .join(' OR ');
  const [aliasRow] = await queryD1Rows<CountRow>(
    input.lookupDatabaseId,
    `SELECT COUNT(*) AS count
       FROM lookup_tenant_aliases
      WHERE tenant_id = ${tenantIdSql}
        AND route_schema_version = 1
        AND route_projection_json = ${sqlString(input.expectedAliases.projectionJson)}
        AND tenant_lifecycle_state = 'active'
        AND runtime_route_status = 'active'
        AND lifecycle_state = 'active'
        AND (${aliasPredicates});`
  );
  if (countValue(aliasRow) !== input.expectedAliases.indexes.length) {
    throw new Error('initial_control_plane_tenant_alias_verification_failed');
  }

  const { snapshot } = await readExpectedRuntimeRegistryPublication({
    runtimeRegistryNamespaceId: input.runtimeRegistryNamespaceId,
    tenantId: input.tenantId,
    expectedSnapshot: input.expectedSnapshot,
    expectedGeneration: input.expectedGeneration,
    verification: input.verification,
    onProgress: input.onProgress,
  });
  const expectedStores = new Map(
    input.resources.map((resource) => [`${resource.role}:${resource.shardGroup}`, resource])
  );
  if (
    snapshot.version !== RUNTIME_REGISTRY_SNAPSHOT_VERSION ||
    snapshot.tenantId !== input.tenantId ||
    snapshot.snapshotScope !== 'tenant' ||
    snapshot.routeStatus !== 'active' ||
    snapshot.backend?.provider !== 'd1' ||
    snapshot.backend?.resolver !== 'control-plane' ||
    snapshot.placement?.isolationPolicy !==
      (input.resources[0]?.metadata?.control_allocation_scope as string) ||
    snapshot.placement?.policyGeneration !== 1 ||
    !Array.isArray(snapshot.stores) ||
    snapshot.stores.length !== expectedStores.size ||
    snapshot.metadata?.storeCount !== expectedStores.size
  ) {
    throw new Error('initial_control_plane_runtime_snapshot_smoke_failed');
  }
  const observedStoreKeys = new Set<string>();
  for (const store of snapshot.stores) {
    const key = `${store.role}:${store.shardGroup}`;
    const expected = expectedStores.get(key);
    const control = expected ? controlSnapshotMetadata(expected) : null;
    if (
      !expected ||
      !control ||
      observedStoreKeys.has(key) ||
      store.tenantId !== input.tenantId ||
      store.dataRole !== control.dataRole ||
      store.residencyPolicyId !== control.residencyPolicyId ||
      store.residencyPartition !== control.residencyPartition ||
      store.shardId !== control.shardId ||
      store.assignmentGeneration !== control.assignmentGeneration ||
      store.bindingRouteGeneration !== expected.generation ||
      store.placementPolicyGeneration !== control.placementPolicyGeneration ||
      store.allocationScope !== control.allocationScope ||
      store.ownerTenantId !== control.ownerTenantId ||
      store.bindingRef !== expected.binding ||
      store.databaseId !== expected.databaseId ||
      store.databaseName !== expected.databaseName ||
      store.generation !== expected.generation ||
      store.runtimeGeneration !== snapshot.runtimeGeneration ||
      store.provider !== 'd1' ||
      store.driver !== 'd1' ||
      store.connectionRef !== null ||
      store.status !== 'active' ||
      store.healthStatus !== 'active'
    ) {
      throw new Error('initial_control_plane_runtime_snapshot_smoke_failed');
    }
    observedStoreKeys.add(key);
  }
  if (observedStoreKeys.size !== expectedStores.size) {
    throw new Error('initial_control_plane_runtime_snapshot_smoke_failed');
  }
}

type InitialTenantShardDefinition = ReturnType<typeof initialTenantShardDefinitions>[number];

function assertLockedShardMatchesIntentCheckpoint(input: {
  intent: ProvisioningIntent;
  definition: InitialTenantShardDefinition;
  environment: string;
  locked: { id: string; name: string };
}): void {
  const checkpoint = input.intent.resources[`d1:${input.definition.binding}`];
  if (!checkpoint) return;
  const expectedName = bootstrapDatabaseName(input.environment, input.definition.nameRole);
  if (
    checkpoint.kind !== 'd1' ||
    checkpoint.binding !== input.definition.binding ||
    checkpoint.name !== expectedName ||
    checkpoint.state !== 'created' ||
    checkpoint.id !== input.locked.id ||
    input.locked.name !== expectedName
  ) {
    throw new Error(`initial_control_plane_intent_lock_mismatch:${input.definition.binding}`);
  }
}

function assertInitialControlPlaneIntentCoveredByLock(input: {
  intent: ProvisioningIntent;
  definitions: readonly InitialTenantShardDefinition[];
  environment: string;
  lock: AuthrimLock;
}): void {
  const definitions = new Map<string, InitialTenantShardDefinition>(
    input.definitions.map((definition) => [`d1:${definition.binding}`, definition] as const)
  );
  for (const checkpointKey of Object.keys(input.intent.resources)) {
    const definition = definitions.get(checkpointKey);
    if (!definition) {
      throw new Error(`initial_control_plane_intent_resource_unexpected:${checkpointKey}`);
    }
    const locked = input.lock.d1[definition.binding];
    if (!locked) {
      throw new Error(`initial_control_plane_intent_lock_missing:${definition.binding}`);
    }
    assertLockedShardMatchesIntentCheckpoint({
      intent: input.intent,
      definition,
      environment: input.environment,
      locked,
    });
  }
}

function lockWithoutD1Binding(lock: AuthrimLock, binding: string): AuthrimLock {
  const d1 = { ...lock.d1 };
  delete d1[binding];
  return { ...lock, d1 };
}

/** Replace a caller-owned lock object without retaining keys absent from the durable checkpoint. */
function replaceLockContents(target: AuthrimLock, source: AuthrimLock): void {
  const mutableTarget = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutableTarget)) {
    if (!Reflect.deleteProperty(mutableTarget, key)) {
      throw new Error(`initial_control_plane_lock_replacement_failed:${key}`);
    }
  }
  Object.assign(mutableTarget, source);
}

async function persistInitialControlPlaneLockCheckpoint(input: {
  rootDir: string;
  environment: string;
  lock: AuthrimLock;
  binding: string;
  resource: { id: string; name: string };
}): Promise<void> {
  const current = await loadLockFileAuto(input.rootDir, input.environment);
  if (!current.lock || !current.path) {
    throw new Error('initial_control_plane_lock_checkpoint_target_missing');
  }
  const alreadyPersisted = current.lock.d1[input.binding];
  if (alreadyPersisted) {
    if (
      alreadyPersisted.id !== input.resource.id ||
      alreadyPersisted.name !== input.resource.name
    ) {
      throw new Error(`initial_control_plane_lock_checkpoint_conflict:${input.binding}`);
    }
    replaceLockContents(input.lock, current.lock);
    return;
  }
  if (
    canonicalizeJson(current.lock) !==
    canonicalizeJson(lockWithoutD1Binding(input.lock, input.binding))
  ) {
    throw new Error(`initial_control_plane_lock_changed_before_checkpoint:${input.binding}`);
  }
  const checkpointed: AuthrimLock = {
    ...current.lock,
    d1: { ...current.lock.d1, [input.binding]: input.resource },
  };
  await saveLockFile(checkpointed, current.path);
  replaceLockContents(input.lock, checkpointed);
}

export async function ensureInitialControlPlaneResources(input: {
  env: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  rootDir: string;
  release?: { manifest: ReleaseMigrationManifest; draft: boolean };
  onProgress?: (message: string) => void;
  /** Test override; production persists every newly-created shard into the environment lock. */
  persistLockCheckpoint?: (lock: AuthrimLock) => Promise<void>;
}): Promise<ControlPlaneBootstrapResult> {
  let createdCount = 0;

  try {
    if (!input.release) throw new Error('initial_control_plane_release_required');
    const controlDatabaseId = input.lock.d1.CONTROL_DB?.id;
    if (!controlDatabaseId) throw new Error('control_database_id_required');
    const [handoff] = await queryD1Rows<{ state: string; verification_error_code: string | null }>(
      controlDatabaseId,
      `SELECT state, verification_error_code
         FROM control_bootstrap_handoffs
        WHERE environment_id = ${sqlString(input.env)}`
    );
    const shardDefinitions = initialTenantShardDefinitions(input.env);
    const shardResourceSpec = {
      purpose: 'initial_control_plane_tenant_shards',
      resources: shardDefinitions.map((definition) => ({
        kind: 'd1',
        binding: definition.binding,
        name: bootstrapDatabaseName(input.env, definition.nameRole),
      })),
    } as const;
    const existingProvisioningIntent = await loadProvisioningIntent({
      baseDir: input.rootDir,
      environment: input.env,
    });
    if (handoff?.state === 'accepted') {
      const incompleteBinding = shardDefinitions.find((definition) => {
        const locked = input.lock.d1[definition.binding];
        return !locked || locked.name !== bootstrapDatabaseName(input.env, definition.nameRole);
      });
      if (incompleteBinding) {
        throw new Error(
          `initial_control_plane_accepted_lock_incomplete:${incompleteBinding.binding}`
        );
      }
      if (existingProvisioningIntent) {
        const provisioningAttempt = await beginOrResumeProvisioningIntent({
          baseDir: input.rootDir,
          environment: input.env,
          accountId:
            input.config.cloudflare?.accountId?.trim() || existingProvisioningIntent.accountId,
          resourceSpec: shardResourceSpec,
        });
        assertInitialControlPlaneIntentCoveredByLock({
          intent: provisioningAttempt.intent,
          definitions: shardDefinitions,
          environment: input.env,
          lock: input.lock,
        });
        await completeProvisioningIntent({
          baseDir: input.rootDir,
          environment: input.env,
          expectedIntentId: provisioningAttempt.intent.id,
        });
      }
      return { success: true, skipped: true };
    }
    if (
      handoff?.state === 'blocked' &&
      !isRecoverableInitialHandoffError(handoff.verification_error_code)
    ) {
      throw new Error(`initial_control_plane_handoff_${handoff.state}`);
    }

    const missingShard = shardDefinitions.some(
      (definition) => input.lock.d1[definition.binding] === undefined
    );
    const accountId = input.config.cloudflare?.accountId?.trim();
    if (missingShard && !accountId && !existingProvisioningIntent) {
      throw new Error('cloudflare_account_id_required_for_initial_control_plane_provisioning');
    }
    const provisioningAttempt =
      missingShard || existingProvisioningIntent
        ? await beginOrResumeProvisioningIntent({
            baseDir: input.rootDir,
            environment: input.env,
            accountId: accountId || existingProvisioningIntent!.accountId,
            resourceSpec: shardResourceSpec,
          })
        : null;

    input.onProgress?.('🔧 Ensuring initial Control-plane tenant shards exist (3 D1)...');
    for (const definition of shardDefinitions) {
      const existing = input.lock.d1[definition.binding];
      const currentIntent = provisioningAttempt
        ? await loadProvisioningIntent({
            baseDir: input.rootDir,
            environment: input.env,
          })
        : null;
      if (
        provisioningAttempt &&
        (!currentIntent || currentIntent.id !== provisioningAttempt.intent.id)
      ) {
        throw new Error('initial_control_plane_provisioning_intent_changed');
      }
      if (existing) {
        const expectedName = bootstrapDatabaseName(input.env, definition.nameRole);
        if (existing.name !== expectedName) {
          throw new Error(`initial_control_plane_binding_conflict:${definition.binding}`);
        }
        if (currentIntent) {
          assertLockedShardMatchesIntentCheckpoint({
            intent: currentIntent,
            definition,
            environment: input.env,
            locked: existing,
          });
        }
        input.onProgress?.(`  ✓ ${definition.binding} already locked`);
        continue;
      }
      if (!provisioningAttempt || !currentIntent) {
        throw new Error('initial_control_plane_provisioning_intent_missing');
      }
      const resource: ProvisioningResourceIdentity = {
        kind: 'd1',
        binding: definition.binding,
        name: bootstrapDatabaseName(input.env, definition.nameRole),
      };
      const adoption = getProvisioningResourceAdoptionPolicy(currentIntent.resources, resource);
      if (adoption.recordedState === 'create_issued') {
        throw new Error(
          `initial_control_plane_resource_create_ambiguous:${resource.binding}:${resource.name}:` +
            'Cloudflare D1 create outcome is unknown and automatic recovery is unavailable; ' +
            `inspect the exact name "${resource.name}" in Cloudflare, then run ` +
            `"pnpm run setup delete --env ${input.env} --all --yes"; if deletion stops because ` +
            `its immutable identity is missing, manually delete only that exact ambiguous name in ` +
            `Cloudflare and rerun the same setup delete command to clean local state; verify the ` +
            `environment is empty, then run "pnpm run setup init --env ${input.env}"`
        );
      }
      const database = await createD1Database(
        resource.name,
        definition.role === 'tenant_pii' ? input.config.database?.pii : input.config.database?.core,
        {
          ...adoption,
          onCreateIssued: () =>
            recordProvisioningResourceCreateIssued({
              baseDir: input.rootDir,
              environment: input.env,
              expectedIntentId: provisioningAttempt.intent.id,
              resource,
            }),
          onCreateRejected: () =>
            recordProvisioningResourceCreateRejected({
              baseDir: input.rootDir,
              environment: input.env,
              expectedIntentId: provisioningAttempt.intent.id,
              resource,
            }),
          onProviderIdentityIdentified: ({ id }) => {
            if (!id) {
              throw new Error(
                `initial_control_plane_provider_identity_missing:${definition.binding}`
              );
            }
            return recordProvisioningResourceIdentified({
              baseDir: input.rootDir,
              environment: input.env,
              expectedIntentId: provisioningAttempt.intent.id,
              resource: { ...resource, state: 'identified', id },
            });
          },
        }
      );
      if (!database.id || database.name !== resource.name) {
        throw new Error(`initial_control_plane_provider_identity_mismatch:${definition.binding}`);
      }
      await recordProvisionedResource({
        baseDir: input.rootDir,
        environment: input.env,
        expectedIntentId: provisioningAttempt.intent.id,
        resource: {
          ...resource,
          state: 'created',
          id: database.id,
        },
      });
      input.lock.d1[definition.binding] = { id: database.id, name: database.name };
      if (input.persistLockCheckpoint) {
        await input.persistLockCheckpoint(input.lock);
      } else {
        await persistInitialControlPlaneLockCheckpoint({
          rootDir: input.rootDir,
          environment: input.env,
          lock: input.lock,
          binding: definition.binding,
          resource: { id: database.id, name: database.name },
        });
      }
      createdCount += 1;
      input.onProgress?.(`  ✓ ${definition.binding} -> ${database.name}`);
    }
    if (provisioningAttempt) {
      const completedIntent = await loadProvisioningIntent({
        baseDir: input.rootDir,
        environment: input.env,
      });
      if (!completedIntent || completedIntent.id !== provisioningAttempt.intent.id) {
        throw new Error('initial_control_plane_provisioning_intent_changed');
      }
      assertInitialControlPlaneIntentCoveredByLock({
        intent: completedIntent,
        definitions: shardDefinitions,
        environment: input.env,
        lock: input.lock,
      });
      await completeProvisioningIntent({
        baseDir: input.rootDir,
        environment: input.env,
        expectedIntentId: provisioningAttempt.intent.id,
      });
    }

    const migrationsRoot = await findMigrationsRoot(input.rootDir, input.onProgress, {
      strictRoot: true,
    });
    if (!migrationsRoot.path) {
      throw new Error(
        `Migrations directory not found. Searched: ${migrationsRoot.searchPaths.join(', ')}`
      );
    }

    const plans = buildInitialControlPlaneResourcePlans({
      env: input.env,
      lock: input.lock,
      release: input.release.manifest,
      releaseDraft: input.release.draft,
    });
    for (const plan of plans.filter((candidate) => candidate.role !== 'lookup')) {
      const migrationPath =
        plan.role === 'tenant_pii' ? join(migrationsRoot.path, 'pii') : migrationsRoot.path;
      const result = await runD1Migrations(plan.databaseId, migrationPath, input.onProgress, {
        manifestFiles: plan.migrationFiles,
        releaseVersion: plan.releaseId,
        backfillLegacyChecksums: input.release.draft === false,
      });
      if (!result.success) {
        throw new Error(
          `${plan.role} Control Plane shard migration failed for ${plan.binding}: ${result.error}`
        );
      }
      const lastFilename = plan.migrationFiles.at(-1)?.path;
      if (!lastFilename) throw new Error('initial_control_plane_migration_files_empty');
      await executeD1Command(
        plan.databaseId,
        `INSERT INTO authrim_control_plane_shard_metadata (
           singleton_id, binding_ref, data_role, residency_partition, migration_generation,
           release_id, manifest_digest, expected_file_count, last_filename, updated_at
         ) VALUES (
           1, ${sqlString(plan.binding)}, ${sqlString(plan.role)}, 'default', 1,
           ${sqlString(plan.releaseId)}, ${sqlString(plan.manifestDigest)},
           ${plan.migrationFiles.length}, ${sqlString(lastFilename)}, ${Math.floor(Date.now() / 1000)}
         ) ON CONFLICT(singleton_id) DO UPDATE SET
           binding_ref = excluded.binding_ref,
           data_role = excluded.data_role,
           residency_partition = excluded.residency_partition,
           migration_generation = excluded.migration_generation,
           release_id = excluded.release_id,
           manifest_digest = excluded.manifest_digest,
           expected_file_count = excluded.expected_file_count,
           last_filename = excluded.last_filename,
           updated_at = excluded.updated_at;`
      );
    }

    return {
      success: true,
      createdCount,
      migratedCount: plans.length - 1,
    };
  } catch (error) {
    return {
      success: false,
      createdCount,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function publishInitialControlPlaneRuntimeSnapshot(input: {
  env: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  rootDir: string;
  keysDir: string;
  release?: ReleaseMigrationManifest;
  onProgress?: (message: string) => void;
  /** Deterministic verification hooks for tests; production callers must omit this. */
  runtimeRegistryVerification?: RuntimeRegistryVerificationOptions;
}): Promise<ControlPlaneBootstrapResult> {
  const tenantId = tenantIdForConfig(input.config);
  const adminDatabaseId = input.lock.d1.DB_ADMIN?.id;
  const controlDatabaseId = input.lock.d1.CONTROL_DB?.id;
  const lookupDatabaseId = input.lock.d1.LOOKUP_DB?.id;
  const configNamespaceId = input.lock.kv.AUTHRIM_CONFIG?.id;
  const runtimeRegistryNamespaceId = input.lock.kv.TENANT_RUNTIME_REGISTRY?.id;
  if (!adminDatabaseId) {
    return { success: false, error: 'DB_ADMIN is missing from the lock file' };
  }
  if (!runtimeRegistryNamespaceId) {
    return { success: false, error: 'TENANT_RUNTIME_REGISTRY KV is missing from the lock file' };
  }
  if (!controlDatabaseId) {
    return { success: false, error: 'CONTROL_DB is missing from the lock file' };
  }
  if (!lookupDatabaseId) {
    return { success: false, error: 'LOOKUP_DB is missing from the lock file' };
  }
  if (!configNamespaceId) {
    return { success: false, error: 'AUTHRIM_CONFIG KV is missing from the lock file' };
  }

  try {
    await ensureInitialTenantRegionShardConfig({
      environmentId: input.env,
      tenantId,
      controlDatabaseName: controlDatabaseId,
      configNamespaceId,
    });
    const migrationsRoot = await findMigrationsRoot(input.rootDir, input.onProgress, {
      strictRoot: true,
    });
    if (!migrationsRoot.path) {
      throw new Error(
        `Migrations directory not found. Searched: ${migrationsRoot.searchPaths.join(', ')}`
      );
    }
    const migrationsRootPath = migrationsRoot.path;

    if (!input.release) throw new Error('initial_control_plane_release_required');
    const plans = buildInitialControlPlaneResourcePlans({
      env: input.env,
      lock: input.lock,
      release: input.release,
    }).filter((plan) => plan.role !== 'lookup');
    const coreStream = input.release?.streams.find((stream) => stream.id === 'd1-core');
    const piiStream = input.release?.streams.find((stream) => stream.id === 'd1-pii');
    const coreSchemaVersion = coreStream
      ? getLatestMigrationVersionFromFilenames(coreStream.files.map((file) => file.path))
      : getLatestMigrationVersionFromDirectory(migrationsRootPath);
    const piiSchemaVersion = piiStream
      ? getLatestMigrationVersionFromFilenames(piiStream.files.map((file) => file.path))
      : getLatestMigrationVersionFromDirectory(join(migrationsRootPath, 'pii'));
    const resources = plans.map((plan) =>
      registryResourceFromInitialPlan({
        plan,
        schemaVersion: plan.role === 'tenant_pii' ? piiSchemaVersion : coreSchemaVersion,
        tenantId,
        placementPolicy: input.config.tenant.placementPolicy,
      })
    );
    const defaultCoreResource = resources.find(
      (resource) => resource.role === 'tenant_core' && resource.shardGroup === 'default'
    );
    if (!defaultCoreResource) {
      throw new Error('initial_control_plane_default_core_resource_missing');
    }

    input.onProgress?.(
      `🔧 Ensuring initial tenant exists in ${defaultCoreResource.databaseName}...`
    );
    await executeD1Command(
      defaultCoreResource.databaseId,
      buildInitialTenantBootstrapSql(input.config)
    );
    const registryResources = signTenantDatabaseRegistryResources({
      tenantId,
      signatureConfig: null,
      resources,
    });
    const registrySql = buildTenantDatabaseRegistrySql({
      tenantId,
      tenantSlug: tenantId,
      resources: registryResources,
      activate: true,
      activePointerMode: 'preserve_existing_generation',
    });
    input.onProgress?.(`🔧 Publishing initial Control Plane runtime snapshot (${tenantId})...`);
    await executeAdminSql({
      adminDatabaseId,
      tenantId,
      sql: registrySql,
    });

    const signedAt = new Date().toISOString();
    const snapshot = await signSnapshot(
      buildRuntimeSnapshot({
        tenantId,
        placementPolicy: input.config.tenant.placementPolicy,
        resources,
        now: new Date(signedAt),
      }),
      input.keysDir,
      signedAt,
      input.lock.controlKeyState?.runtimeRegistry
        ? {
            slot: input.lock.controlKeyState.runtimeRegistry.activeSlot,
            keyId: input.lock.controlKeyState.runtimeRegistry.activeKeyId,
          }
        : undefined
    );
    const generation: RuntimeGenerationPointer = {
      runtimeGeneration: snapshot.runtimeGeneration,
      routeStatus: snapshot.routeStatus,
      quarantineDenyGeneration: snapshot.quarantineDenyGeneration,
      publishedAt: snapshot.publishedAt,
      expiresAt: addSeconds(
        new Date(snapshot.publishedAt),
        RUNTIME_REGISTRY_GENERATION_TTL_SECONDS
      ).toISOString(),
    };
    await putKVKeyByNamespaceId(
      runtimeRegistryNamespaceId,
      buildSnapshotKey(tenantId),
      JSON.stringify(snapshot),
      { expirationTtl: RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS }
    );
    await putKVKeyByNamespaceId(
      runtimeRegistryNamespaceId,
      buildGenerationKey(tenantId),
      JSON.stringify(generation),
      { expirationTtl: RUNTIME_REGISTRY_GENERATION_TTL_SECONDS }
    );

    const defaultStore = snapshot.stores.find(
      (store) => store.role === 'tenant_core' && store.shardGroup === 'default'
    );
    if (!defaultStore) throw new Error('initial_tenant_alias_default_store_missing');
    const aliases = await buildInitialTenantAliasBootstrap({
      environmentId: input.env,
      tenantId,
      tenantCode: input.config.tenant.name,
      defaultStore,
    });
    input.onProgress?.(`🔧 Ensuring initial tenant discovery aliases (${tenantId})...`);
    await executeD1Command(lookupDatabaseId, aliases.sql);

    input.onProgress?.(`🔎 Verifying initial Control Plane bootstrap (${tenantId})...`);
    await verifyInitialControlPlaneBootstrap({
      adminDatabaseId,
      lookupDatabaseId,
      runtimeRegistryNamespaceId,
      tenantId,
      coreDatabaseId: defaultCoreResource.databaseId,
      resources,
      expectedSnapshot: snapshot,
      expectedGeneration: generation,
      expectedAliases: aliases,
      verification: input.runtimeRegistryVerification,
      onProgress: input.onProgress,
    });

    input.onProgress?.(`  ✅ Initial Control Plane runtime snapshot published: ${tenantId}`);
    return {
      success: true,
      publishedSnapshot: true,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
