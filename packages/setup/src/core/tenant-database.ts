import { existsSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import {
  buildTenantDatabaseBindingPlan,
  TENANT_DATABASE_BINDING_PATTERN,
} from '@authrim/ar-lib-core/services/tenant-database-naming';

export type TenantDatabaseRole = 'tenant_core' | 'tenant_pii';
export type TenantDatabaseDataRole = 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
export type ControlGeneratedDatabaseDataRole = TenantDatabaseDataRole | 'lookup';
export type TenantDatabaseProvisioningState =
  | 'requested'
  | 'provisioning'
  | 'ready'
  | 'active'
  | 'degraded'
  | 'degraded_pending_snapshot'
  | 'restored_pending'
  | 'failed'
  | 'disabled'
  | 'retired'
  | 'deleting'
  | 'deleted';

export const TENANT_DATABASE_PROVISIONING_STATES: readonly TenantDatabaseProvisioningState[] = [
  'requested',
  'provisioning',
  'ready',
  'active',
  'degraded',
  'degraded_pending_snapshot',
  'restored_pending',
  'failed',
  'disabled',
  'retired',
  'deleting',
  'deleted',
] as const;

export interface TenantDatabasePlanInput {
  env: string;
  tenantId: string;
  tenantSlug?: string;
  generation?: number;
}

export interface TenantDatabaseResourcePlan {
  role: TenantDatabaseRole;
  databaseName: string;
  binding: string;
  generation: number;
}

export interface TenantDatabaseRegistryResourceInput extends TenantDatabaseResourcePlan {
  databaseId: string;
  shardGroup?: string;
  shardIndex?: number;
  shardCount?: number;
  shardKeyStrategy?: string;
  schemaVersion?: number;
  status?: TenantDatabaseProvisioningState;
  signature?: string | null;
  signatureKeyId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TenantDatabaseProvisioningPlan {
  tenantId: string;
  tenantSlug?: string;
  generation: number;
  resources: TenantDatabaseResourcePlan[];
}

export interface TenantDatabaseRegistrySignatureConfig {
  secret: string;
  keyId: string;
}

export interface TenantDatabaseMigrationTarget {
  binding: string;
  databaseId: string;
  databaseName: string;
  role: TenantDatabaseRole;
}

export interface TenantDatabaseMigrationPlan {
  canaryTargets: TenantDatabaseMigrationTarget[];
  remainingTargets: TenantDatabaseMigrationTarget[];
  concurrency: number;
}

export interface TenantDatabaseBindingCapacity {
  currentBindings: number;
  addedBindings: number;
  projectedBindings: number;
  warningThreshold: number;
  strongWarningThreshold: number;
  hardLimit: number;
  state: 'ok' | 'warning' | 'strong_warning' | 'exceeds_limit';
}

export interface TenantDatabaseSizeStats {
  accountCount?: number | null;
  activeUserCount?: number | null;
  activePendingUserCount?: number | null;
  d1FileSizeBytes?: number | null;
  checkedAt?: string | null;
}

export interface TenantDatabaseSizeWarning {
  state: 'ok' | 'warning' | 'strong_warning';
  reasons: string[];
  accountCount: number | null;
  activeUserCount: number | null;
  activePendingUserCount: number | null;
  d1FileSizeBytes: number | null;
  storageRatio: number | null;
  warningAccountThreshold: number;
  strongWarningAccountThreshold: number;
  warningStorageRatio: number;
  strongWarningStorageRatio: number;
  maxD1SizeBytes: number;
}

export interface TenantDatabaseStatsFreshness {
  state: 'fresh' | 'stale' | 'unknown';
  checkedAt: string | null;
  staleAfterHours: number;
}

export interface TenantWorkerShardSplitJobConfig {
  sourceDeploymentTarget: string;
  targetDeploymentTarget: string;
  roles: TenantDatabaseRole[];
  mode: 'plan_only' | 'operator_apply';
  reason: string;
}

export type TenantDatabaseMigrationOperatorAction = 'resume' | 'rollback' | 'repair';

export interface TenantDatabaseMigrationOperatorActionJobConfig {
  action: TenantDatabaseMigrationOperatorAction;
  tenantId: string;
  roles: TenantDatabaseRole[];
  generation?: number | null;
  bindings?: string[];
  mode: 'plan_only' | 'operator_apply';
  reason: string;
}

export interface TenantDatabaseActivationTarget {
  tenantId: string;
  generation: number;
  roles: TenantDatabaseRole[];
}

export interface TenantDatabaseActivationBatchJobConfig {
  activationBatchId: string;
  targets: TenantDatabaseActivationTarget[];
  mode: 'plan_only' | 'operator_apply';
  scheduledFor?: string | null;
  windowName?: string | null;
  requireHealthCheck: boolean;
  requireDeployedBindings: boolean;
  reason: string;
}

export interface TenantRuntimePackageRoleRequirement {
  packageName: string;
  roles: TenantDatabaseRole[];
}

export interface TenantDatabaseReconciliationIssue {
  type: 'missing_lock_entry' | 'missing_cloudflare_database' | 'database_id_mismatch';
  binding: string;
  databaseName?: string;
  lockDatabaseId?: string;
  cloudflareDatabaseId?: string;
}

export interface TenantDatabaseReconciliationResult {
  checkedBindings: number;
  issues: TenantDatabaseReconciliationIssue[];
  status: 'ok' | 'drift_detected';
}

export const TENANT_RUNTIME_PACKAGE_ROLE_REQUIREMENTS: readonly TenantRuntimePackageRoleRequirement[] =
  [
    { packageName: '@authrim/ar-auth', roles: ['tenant_core', 'tenant_pii'] },
    { packageName: '@authrim/ar-token', roles: ['tenant_core', 'tenant_pii'] },
    { packageName: '@authrim/ar-userinfo', roles: ['tenant_core', 'tenant_pii'] },
    { packageName: '@authrim/ar-saml', roles: ['tenant_core', 'tenant_pii'] },
    { packageName: '@authrim/ar-bridge', roles: ['tenant_core', 'tenant_pii'] },
    { packageName: '@authrim/ar-vc', roles: ['tenant_core', 'tenant_pii'] },
    { packageName: '@authrim/ar-management', roles: ['tenant_core', 'tenant_pii'] },
    { packageName: '@authrim/ar-policy', roles: ['tenant_core'] },
  ];

export const DEFAULT_D1_MAX_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_TENANT_ACCOUNT_WARNING_THRESHOLD = 700_000;
export const DEFAULT_TENANT_ACCOUNT_STRONG_WARNING_THRESHOLD = 800_000;
export const DEFAULT_TENANT_STORAGE_WARNING_RATIO = 0.7;
export const DEFAULT_TENANT_STORAGE_STRONG_WARNING_RATIO = 0.8;
export const DEFAULT_TENANT_STATS_STALE_AFTER_HOURS = 36;
const BINDING_ROLE_SUFFIX: Record<string, TenantDatabaseRole> = {
  CORE: 'tenant_core',
  PII: 'tenant_pii',
};

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

export function buildTenantDatabaseProvisioningPlan(
  input: TenantDatabasePlanInput
): TenantDatabaseProvisioningPlan {
  const generation = input.generation ?? 1;
  const resources: TenantDatabaseResourcePlan[] = (['tenant_core', 'tenant_pii'] as const).map(
    (role) => {
      const plan = buildTenantDatabaseBindingPlan({
        environment: input.env,
        tenantId: input.tenantId,
        tenantSlug: input.tenantSlug,
        role,
      });
      return {
        role,
        databaseName: plan.databaseName,
        binding: plan.bindingRef,
        generation,
      };
    }
  );

  return {
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    generation,
    resources,
  };
}

export function isTenantDatabaseBinding(binding: string): boolean {
  const markerIndex = binding.indexOf('_TDB_');
  if (markerIndex <= 0) return false;
  const canonical = binding.slice(markerIndex + 1);
  return (
    TENANT_DATABASE_BINDING_PATTERN.test(binding) &&
    /^TDB_[A-Z0-9_]+_(CORE|PII|AUDIT|CUSTOM)(?:_S[0-9]+)?$/u.test(canonical)
  );
}

export function isLookupDatabaseBinding(binding: string): boolean {
  const markerIndex = binding.indexOf('_TDB_');
  if (markerIndex <= 0) return false;
  const canonical = binding.slice(markerIndex + 1);
  return (
    TENANT_DATABASE_BINDING_PATTERN.test(binding) &&
    /^TDB_LOOKUP_[A-Z0-9_]+_LOOKUP$/u.test(canonical)
  );
}

export function isControlGeneratedDatabaseBinding(binding: string): boolean {
  return isTenantDatabaseBinding(binding) || isLookupDatabaseBinding(binding);
}

export function getTenantDatabaseRoleFromBinding(binding: string): TenantDatabaseRole | null {
  const match = binding.match(/_(CORE|PII)(?:_S[0-9]+)?$/u);
  return match ? (BINDING_ROLE_SUFFIX[match[1]] ?? null) : null;
}

export function getTenantDatabaseDataRoleFromBinding(
  binding: string
): TenantDatabaseDataRole | null {
  if (!isTenantDatabaseBinding(binding)) return null;
  const canonical = binding.slice(binding.indexOf('_TDB_') + 1);
  if (/^TDB_DEFAULT_[A-Z0-9_]*_CORE(?:_S[0-9]+)?$/u.test(canonical)) {
    return 'tenant_core/default';
  }
  if (/^TDB_USERS_[A-Z0-9_]*_CORE(?:_S[0-9]+)?$/u.test(canonical)) {
    return 'tenant_core/users';
  }
  if (/^TDB_PII_[A-Z0-9_]*_PII(?:_S[0-9]+)?$/u.test(canonical)) {
    return 'tenant_pii';
  }
  return null;
}

export function getControlGeneratedDatabaseDataRoleFromBinding(
  binding: string
): ControlGeneratedDatabaseDataRole | null {
  if (isLookupDatabaseBinding(binding)) return 'lookup';
  return getTenantDatabaseDataRoleFromBinding(binding);
}

export function listTenantDatabaseMigrationTargets(
  lock: { d1: Record<string, { id: string; name: string }> },
  options: {
    roles?: TenantDatabaseRole[];
    bindings?: string[];
  } = {}
): TenantDatabaseMigrationTarget[] {
  const roleFilter = new Set(options.roles ?? ['tenant_core', 'tenant_pii']);
  const bindingFilter = options.bindings ? new Set(options.bindings) : null;

  return Object.entries(lock.d1)
    .flatMap(([binding, resource]) => {
      if (!isTenantDatabaseBinding(binding)) {
        return [];
      }
      if (bindingFilter && !bindingFilter.has(binding)) {
        return [];
      }
      const role = getTenantDatabaseRoleFromBinding(binding);
      if (!role || !roleFilter.has(role)) {
        return [];
      }
      return [
        {
          binding,
          databaseId: resource.id,
          databaseName: resource.name,
          role,
        },
      ];
    })
    .sort((a, b) => a.binding.localeCompare(b.binding));
}

export function buildTenantDatabaseMigrationPlan(
  targets: TenantDatabaseMigrationTarget[],
  options: {
    concurrency?: number;
    canaryBindings?: string[];
    canaryCount?: number;
  } = {}
): TenantDatabaseMigrationPlan {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const canaryBindingSet = new Set(options.canaryBindings ?? []);
  const explicitCanaries = targets.filter((target) => canaryBindingSet.has(target.binding));
  const canaryCount = Math.max(0, Math.floor(options.canaryCount ?? 0));
  const automaticCanaries = targets
    .filter((target) => !canaryBindingSet.has(target.binding))
    .slice(0, canaryCount);
  const canaryTargets = [...explicitCanaries, ...automaticCanaries];
  const canaryTargetSet = new Set(canaryTargets.map((target) => target.binding));

  return {
    canaryTargets,
    remainingTargets: targets.filter((target) => !canaryTargetSet.has(target.binding)),
    concurrency,
  };
}

export function evaluateTenantDatabaseBindingCapacity(options: {
  currentBindings: number;
  addedBindings: number;
  warningThreshold?: number;
  strongWarningThreshold?: number;
  hardLimit?: number;
}): TenantDatabaseBindingCapacity {
  const warningThreshold = options.warningThreshold ?? 3000;
  const strongWarningThreshold = options.strongWarningThreshold ?? 4000;
  const hardLimit = options.hardLimit ?? 5000;
  const projectedBindings = options.currentBindings + options.addedBindings;

  return {
    currentBindings: options.currentBindings,
    addedBindings: options.addedBindings,
    projectedBindings,
    warningThreshold,
    strongWarningThreshold,
    hardLimit,
    state:
      projectedBindings >= hardLimit
        ? 'exceeds_limit'
        : projectedBindings >= strongWarningThreshold
          ? 'strong_warning'
          : projectedBindings >= warningThreshold
            ? 'warning'
            : 'ok',
  };
}

export function evaluateTenantDatabaseSizeWarning(
  stats: TenantDatabaseSizeStats,
  options: {
    warningAccountThreshold?: number;
    strongWarningAccountThreshold?: number;
    warningStorageRatio?: number;
    strongWarningStorageRatio?: number;
    maxD1SizeBytes?: number;
  } = {}
): TenantDatabaseSizeWarning {
  const warningAccountThreshold =
    options.warningAccountThreshold ?? DEFAULT_TENANT_ACCOUNT_WARNING_THRESHOLD;
  const strongWarningAccountThreshold =
    options.strongWarningAccountThreshold ?? DEFAULT_TENANT_ACCOUNT_STRONG_WARNING_THRESHOLD;
  const warningStorageRatio = options.warningStorageRatio ?? DEFAULT_TENANT_STORAGE_WARNING_RATIO;
  const strongWarningStorageRatio =
    options.strongWarningStorageRatio ?? DEFAULT_TENANT_STORAGE_STRONG_WARNING_RATIO;
  const maxD1SizeBytes = options.maxD1SizeBytes ?? DEFAULT_D1_MAX_SIZE_BYTES;
  const accountCount = stats.accountCount ?? null;
  const activeUserCount = stats.activeUserCount ?? null;
  const activePendingUserCount = stats.activePendingUserCount ?? null;
  const d1FileSizeBytes = stats.d1FileSizeBytes ?? null;
  const storageRatio =
    d1FileSizeBytes === null || maxD1SizeBytes <= 0 ? null : d1FileSizeBytes / maxD1SizeBytes;
  const reasons: string[] = [];
  let state: TenantDatabaseSizeWarning['state'] = 'ok';

  if (accountCount !== null && accountCount >= strongWarningAccountThreshold) {
    state = 'strong_warning';
    reasons.push('account_count_strong_threshold');
  } else if (accountCount !== null && accountCount >= warningAccountThreshold) {
    state = 'warning';
    reasons.push('account_count_warning_threshold');
  }

  if (storageRatio !== null && storageRatio >= strongWarningStorageRatio) {
    state = 'strong_warning';
    reasons.push('storage_ratio_strong_threshold');
  } else if (storageRatio !== null && storageRatio >= warningStorageRatio) {
    if (state !== 'strong_warning') {
      state = 'warning';
    }
    reasons.push('storage_ratio_warning_threshold');
  }

  return {
    state,
    reasons,
    accountCount,
    activeUserCount,
    activePendingUserCount,
    d1FileSizeBytes,
    storageRatio,
    warningAccountThreshold,
    strongWarningAccountThreshold,
    warningStorageRatio,
    strongWarningStorageRatio,
    maxD1SizeBytes,
  };
}

export function evaluateTenantDatabaseStatsFreshness(
  checkedAt: string | null | undefined,
  options: {
    now?: Date;
    staleAfterHours?: number;
  } = {}
): TenantDatabaseStatsFreshness {
  const staleAfterHours = options.staleAfterHours ?? DEFAULT_TENANT_STATS_STALE_AFTER_HOURS;
  if (!checkedAt) {
    return { state: 'unknown', checkedAt: null, staleAfterHours };
  }

  const checkedAtDate = new Date(checkedAt);
  if (Number.isNaN(checkedAtDate.getTime())) {
    return { state: 'unknown', checkedAt, staleAfterHours };
  }

  const now = options.now ?? new Date();
  const staleAfterMs = staleAfterHours * 60 * 60 * 1000;
  return {
    state: now.getTime() - checkedAtDate.getTime() > staleAfterMs ? 'stale' : 'fresh',
    checkedAt,
    staleAfterHours,
  };
}

export function getLatestMigrationVersionFromDirectory(migrationsDir: string): number {
  if (!existsSync(migrationsDir)) {
    return 0;
  }

  return readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith('.sql') && !filename.startsWith('.'))
    .reduce((latest, filename) => {
      const match = filename.match(/^(\d+)_/u);
      if (!match) {
        return latest;
      }
      return Math.max(latest, Number.parseInt(match[1], 10));
    }, 0);
}

export function getLatestMigrationVersionFromFilenames(filenames: readonly string[]): number {
  return filenames.reduce((latest, filename) => {
    const basename = filename.split('/').at(-1) ?? filename;
    const match = basename.match(/^(\d+)_/u);
    return match ? Math.max(latest, Number.parseInt(match[1], 10)) : latest;
  }, 0);
}

const _SIGNED_TENANT_DATABASE_REGISTRY_FIELDS = [
  'tenant_id',
  'role',
  'provider',
  'database_id',
  'binding_ref',
  'schema_version',
  'status',
  'generation',
  'shard_group',
  'shard_index',
  'shard_count',
  'shard_key_strategy',
  'worker_shard',
  'deployment_target',
  'region_hint',
  'jurisdiction',
] as const;

function encodeBase64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function buildTenantDatabaseRegistrySignaturePayload(input: {
  tenantId: string;
  resource: TenantDatabaseRegistryResourceInput;
  schemaVersion: number;
  status: TenantDatabaseProvisioningState;
}): string {
  const shardGroup = input.resource.shardGroup ?? 'default';
  const shardIndex = input.resource.shardIndex ?? 0;
  const shardCount = input.resource.shardCount ?? 1;
  const shardKeyStrategy = input.resource.shardKeyStrategy ?? 'none';
  const values: Record<(typeof _SIGNED_TENANT_DATABASE_REGISTRY_FIELDS)[number], unknown> = {
    tenant_id: input.tenantId,
    role: input.resource.role,
    provider: 'd1',
    database_id: input.resource.databaseId,
    binding_ref: input.resource.binding,
    schema_version: input.schemaVersion,
    status: input.status,
    generation: input.resource.generation,
    shard_group: shardGroup,
    shard_index: shardIndex,
    shard_count: shardCount,
    shard_key_strategy: shardKeyStrategy,
    worker_shard: 'primary',
    deployment_target: null,
    region_hint: null,
    jurisdiction: null,
  };
  return JSON.stringify(values);
}

export function loadTenantDatabaseRegistrySignatureConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): TenantDatabaseRegistrySignatureConfig | null {
  const secret = env.TENANT_DATABASE_REGISTRY_SIGNATURE_SECRET?.trim();
  if (!secret) {
    return null;
  }
  return {
    secret,
    keyId: env.TENANT_DATABASE_REGISTRY_SIGNATURE_KEY_ID?.trim() || 'current',
  };
}

export function signTenantDatabaseRegistryResource(input: {
  tenantId: string;
  resource: TenantDatabaseRegistryResourceInput;
  signatureConfig: TenantDatabaseRegistrySignatureConfig;
}): { signature: string; signatureKeyId: string } {
  const schemaVersion = input.resource.schemaVersion ?? 1;
  const status = input.resource.status ?? 'ready';
  const canonicalPayload = buildTenantDatabaseRegistrySignaturePayload({
    tenantId: input.tenantId,
    resource: input.resource,
    schemaVersion,
    status,
  });
  return {
    signature: encodeBase64Url(
      createHmac('sha256', input.signatureConfig.secret).update(canonicalPayload).digest()
    ),
    signatureKeyId: input.signatureConfig.keyId,
  };
}

export function signTenantDatabaseRegistryResources(input: {
  tenantId: string;
  resources: TenantDatabaseRegistryResourceInput[];
  signatureConfig: TenantDatabaseRegistrySignatureConfig | null;
}): TenantDatabaseRegistryResourceInput[] {
  if (!input.signatureConfig) {
    return input.resources;
  }
  const signatureConfig = input.signatureConfig;
  return input.resources.map((resource) => {
    const signed = signTenantDatabaseRegistryResource({
      tenantId: input.tenantId,
      resource,
      signatureConfig,
    });
    return {
      ...resource,
      signature: signed.signature,
      signatureKeyId: signed.signatureKeyId,
    };
  });
}

export function buildTenantDatabaseRegistrySql(options: {
  tenantId: string;
  tenantSlug?: string;
  actorId?: string;
  resources: TenantDatabaseRegistryResourceInput[];
  activate?: boolean;
  activePointerMode?: 'increment' | 'preserve_existing_generation';
}): string {
  const now = new Date().toISOString();
  const actor = options.actorId ?? 'setup';
  const statements: string[] = [];

  for (const resource of options.resources) {
    const shardGroup = resource.shardGroup?.trim() || 'default';
    const shardIndex = resource.shardIndex ?? 0;
    const shardCount = resource.shardCount ?? 1;
    const shardKeyStrategy = resource.shardKeyStrategy?.trim() || 'none';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(shardGroup)) {
      throw new Error(`tenant_database_shard_group_invalid:${shardGroup}`);
    }
    if (!Number.isSafeInteger(shardIndex) || shardIndex < 0) {
      throw new Error(`tenant_database_shard_index_invalid:${shardIndex}`);
    }
    if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 32) {
      throw new Error(`tenant_database_shard_count_invalid:${shardCount}`);
    }
    if (shardIndex >= shardCount) {
      throw new Error(`tenant_database_shard_index_out_of_range:${shardIndex}:${shardCount}`);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(shardKeyStrategy)) {
      throw new Error(`tenant_database_shard_key_strategy_invalid:${shardKeyStrategy}`);
    }
    const schemaVersion = resource.schemaVersion ?? 1;
    const status = resource.status ?? 'ready';
    const signature = resource.signature ? `'${escapeSql(resource.signature)}'` : 'NULL';
    const signatureKeyId = resource.signatureKeyId
      ? `'${escapeSql(resource.signatureKeyId)}'`
      : 'NULL';
    const metadataJson = escapeSql(
      JSON.stringify({
        creation_slug: options.tenantSlug ?? options.tenantId,
        current_slug: options.tenantSlug ?? options.tenantId,
        provisioning_tool: 'authrim-setup control-plane',
        ...(resource.metadata ?? {}),
      })
    );
    statements.push(
      `
INSERT INTO tenant_database_registry (
  tenant_id, role, generation, shard_group, shard_index, provider,
  database_id, database_name, binding_ref, connection_ref, schema_version,
  status, shard_count, shard_key_strategy, worker_shard, deployment_target,
  region_hint, jurisdiction, signature, signature_key_id, metadata_json,
  created_at, updated_at, created_by, updated_by
) VALUES (
  '${escapeSql(options.tenantId)}', '${resource.role}', ${resource.generation}, '${escapeSql(shardGroup)}', ${shardIndex}, 'd1',
  '${escapeSql(resource.databaseId)}', '${escapeSql(resource.databaseName)}', '${escapeSql(resource.binding)}', NULL, ${schemaVersion},
  '${status}', ${shardCount}, '${escapeSql(shardKeyStrategy)}', 'primary', NULL,
  NULL, NULL, ${signature}, ${signatureKeyId}, '${metadataJson}',
  '${now}', '${now}', '${escapeSql(actor)}', '${escapeSql(actor)}'
)
ON CONFLICT(tenant_id, role, generation, shard_group, shard_index) DO UPDATE SET
  provider = excluded.provider,
  database_id = excluded.database_id,
  database_name = excluded.database_name,
  binding_ref = excluded.binding_ref,
  connection_ref = excluded.connection_ref,
  schema_version = excluded.schema_version,
  status = excluded.status,
  shard_count = excluded.shard_count,
  shard_key_strategy = excluded.shard_key_strategy,
  worker_shard = excluded.worker_shard,
  deployment_target = excluded.deployment_target,
  region_hint = excluded.region_hint,
  jurisdiction = excluded.jurisdiction,
  signature = excluded.signature,
  signature_key_id = excluded.signature_key_id,
  metadata_json = excluded.metadata_json,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by;`.trim()
    );

    if (options.activate) {
      const runtimeGenerationUpdate =
        options.activePointerMode === 'preserve_existing_generation'
          ? `CASE
    WHEN tenant_database_active_pointers.generation = excluded.generation
    THEN tenant_database_active_pointers.runtime_generation
    ELSE tenant_database_active_pointers.runtime_generation + 1
  END`
          : 'tenant_database_active_pointers.runtime_generation + 1';
      statements.push(
        `
INSERT INTO tenant_database_active_pointers (
  tenant_id, role, shard_group, generation, shard_count, shard_key_strategy,
  runtime_generation, status, updated_at, updated_by, metadata_json
) VALUES (
  '${escapeSql(options.tenantId)}', '${resource.role}', '${escapeSql(shardGroup)}', ${resource.generation}, ${shardCount}, '${escapeSql(shardKeyStrategy)}',
  1, 'active', '${now}', '${escapeSql(actor)}', NULL
)
ON CONFLICT(tenant_id, role, shard_group) DO UPDATE SET
  generation = excluded.generation,
  shard_count = excluded.shard_count,
  shard_key_strategy = excluded.shard_key_strategy,
  runtime_generation = ${runtimeGenerationUpdate},
  status = excluded.status,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by;`.trim()
      );
    }
  }

  return statements.join('\n\n');
}

export function buildTenantWorkerShardSplitJobConfig(
  input: Omit<TenantWorkerShardSplitJobConfig, 'mode'> & {
    mode?: TenantWorkerShardSplitJobConfig['mode'];
  }
): TenantWorkerShardSplitJobConfig {
  return {
    sourceDeploymentTarget: input.sourceDeploymentTarget,
    targetDeploymentTarget: input.targetDeploymentTarget,
    roles: Array.from(new Set(input.roles)),
    mode: input.mode ?? 'plan_only',
    reason: input.reason,
  };
}

export function buildTenantDatabaseMigrationOperatorActionJobConfig(
  input: Omit<TenantDatabaseMigrationOperatorActionJobConfig, 'mode' | 'roles' | 'bindings'> & {
    roles?: TenantDatabaseRole[];
    bindings?: string[];
    mode?: TenantDatabaseMigrationOperatorActionJobConfig['mode'];
  }
): TenantDatabaseMigrationOperatorActionJobConfig {
  return {
    action: input.action,
    tenantId: input.tenantId,
    roles: Array.from(new Set(input.roles ?? ['tenant_core', 'tenant_pii'])),
    generation: input.generation ?? null,
    bindings: input.bindings ? Array.from(new Set(input.bindings)).sort() : [],
    mode: input.mode ?? 'plan_only',
    reason: input.reason,
  };
}

export function buildTenantDatabaseActivationBatchJobConfig(
  input: Omit<
    TenantDatabaseActivationBatchJobConfig,
    'mode' | 'requireHealthCheck' | 'requireDeployedBindings' | 'targets'
  > & {
    targets: Array<
      Omit<TenantDatabaseActivationTarget, 'roles'> & { roles?: TenantDatabaseRole[] }
    >;
    mode?: TenantDatabaseActivationBatchJobConfig['mode'];
    requireHealthCheck?: boolean;
    requireDeployedBindings?: boolean;
  }
): TenantDatabaseActivationBatchJobConfig {
  return {
    activationBatchId: input.activationBatchId,
    targets: input.targets.map((target) => ({
      tenantId: target.tenantId,
      generation: target.generation,
      roles: Array.from(new Set(target.roles ?? ['tenant_core', 'tenant_pii'])),
    })),
    mode: input.mode ?? 'plan_only',
    scheduledFor: input.scheduledFor ?? null,
    windowName: input.windowName ?? null,
    requireHealthCheck: input.requireHealthCheck ?? true,
    requireDeployedBindings: input.requireDeployedBindings ?? true,
    reason: input.reason,
  };
}

export function buildTenantRuntimePackageRoleRequirementManifest(): {
  version: 1;
  packages: TenantRuntimePackageRoleRequirement[];
} {
  return {
    version: 1,
    packages: TENANT_RUNTIME_PACKAGE_ROLE_REQUIREMENTS.map((entry) => ({
      packageName: entry.packageName,
      roles: [...entry.roles],
    })),
  };
}

export function reconcileTenantDatabaseDerivedBindings(input: {
  lock: { d1: Record<string, { id: string; name: string }> };
  cloudflareD1Databases: Array<{ name: string; uuid: string }>;
  expectedBindings?: string[];
}): TenantDatabaseReconciliationResult {
  const cloudflareByName = new Map(
    input.cloudflareD1Databases.map((database) => [database.name, database.uuid])
  );
  const bindings = (input.expectedBindings ?? Object.keys(input.lock.d1))
    .filter(isTenantDatabaseBinding)
    .sort();
  const issues: TenantDatabaseReconciliationIssue[] = [];

  for (const binding of bindings) {
    const lockEntry = input.lock.d1[binding];
    if (!lockEntry) {
      issues.push({ type: 'missing_lock_entry', binding });
      continue;
    }
    const cloudflareDatabaseId = cloudflareByName.get(lockEntry.name);
    if (!cloudflareDatabaseId) {
      issues.push({
        type: 'missing_cloudflare_database',
        binding,
        databaseName: lockEntry.name,
        lockDatabaseId: lockEntry.id,
      });
      continue;
    }
    if (cloudflareDatabaseId !== lockEntry.id) {
      issues.push({
        type: 'database_id_mismatch',
        binding,
        databaseName: lockEntry.name,
        lockDatabaseId: lockEntry.id,
        cloudflareDatabaseId,
      });
    }
  }

  return {
    checkedBindings: bindings.length,
    issues,
    status: issues.length === 0 ? 'ok' : 'drift_detected',
  };
}
