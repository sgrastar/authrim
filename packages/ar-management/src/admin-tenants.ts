/**
 * Admin Tenants API Endpoints
 *
 * CRUD management for tenants:
 * - GET    /api/admin/tenants          - List all tenants
 * - POST   /api/admin/tenants          - Create tenant
 * - GET    /api/admin/tenants/:id      - Get tenant
 * - PATCH  /api/admin/tenants/:id      - Update tenant (name, description, lifecycle_state)
 * - DELETE /api/admin/tenants/:id      - Delete tenant (primary tenant not allowed)
 * - POST   /api/admin/tenants/:id/set-default - Set as default tenant
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createD1Adapter,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  createAuditLog,
  createAuditLogFromContext,
  getLogger,
  getPrimaryTenantId,
  getTenantIdFromContext,
  // Contract provisioning
  TENANT_POLICY_PRESETS,
  type TenantContract,
  buildContractKey,
  buildIssuerUrl,
  requireAdminDatabaseAdapter,
  TenantDatabaseRegistryRepository,
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
  publishTenantRuntimeRegistrySnapshot,
  usesNakedDomainIssuer,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  putTenantExistsCache,
  deleteTenantExistsCache,
  resolveTenantDatabaseSourceFromRegistry,
  ensureDatabaseAdapter,
  type ControlTenantDefaultRouteAllocation,
  type ControlTenantShardCapacityTarget,
  type ControlTenantRuntimeRouteObservation,
  seedBuiltinProfileClaimSchemas,
} from '@authrim/ar-lib-core';
import { createOpaqueTenantKey } from './logging-tenant-key';
import { materializeDisabledTenantEmailProviderOrder } from './notification-provider-projection';
import {
  activateTenantAliasDirectory,
  disableTenantAliasDirectory,
  prepareTenantAliasDirectory,
} from './tenant-alias-directory';
import {
  TenantProvisioningOperationRepository,
  type TenantProvisioningOperationView,
} from './tenant-provisioning-operation';
import {
  decodeTenantProvisioningRoute,
  runTenantProvisioningSaga,
  type TenantProvisioningSagaDependencies,
} from './tenant-provisioning-orchestrator';
import { createControlRuntimeRegistrySigner } from './control-runtime-registry-signer';
import { resolveTenantRuntimePlacementSnapshot } from './tenant-runtime-placement';
import { ensureTenantProvisioningRegionShardConfig } from './tenant-region-shard-policy';
import {
  cleanupTenantCloneKvArtifacts,
  prepareTenantCloneForProvisioning,
} from './admin-tenant-clone';

/**
 * Synchronize the tenant existence positive cache with lifecycle changes.
 * Only active tenants get a positive cache entry; every other state deletes it.
 */
async function syncTenantExistsCache(
  kv: KVNamespace | undefined,
  tenantId: string,
  lifecycleState: TenantLifecycleState
): Promise<void> {
  if (lifecycleState === 'active') {
    await putTenantExistsCache(kv, tenantId);
    return;
  }
  await deleteTenantExistsCache(kv, tenantId);
}
import { z } from 'zod';
import {
  createSingleTenantMutationError,
  ensureSupportedTenantId,
  getSingleTenantId,
  isSingleTenantMode,
} from './single-tenant-guard';
import {
  getAdminAuth,
  getTenantInventoryScope,
  hasPlatformTenantManagementAuthority,
  requirePlatformTenantManagementAuthority,
} from './admin-tenant-access';

// =============================================================================
// Constants
// =============================================================================

/**
 * Tables to delete when removing a tenant.
 * Order matters: child tables first, then parent tables.
 * Exported for reuse in the async delete Cron job.
 */
export const TENANT_TABLES_TO_DELETE = [
  // Tables with explicit FK CASCADE in schema (still delete manually for safety)
  'idempotency_keys',
  'operational_logs',
  'security_alerts',
  // Access management
  'access_review_items',
  'access_reviews',
  // Jobs
  'admin_jobs',
  // Attributes
  'attribute_verifications',
  'verified_attributes',
  'user_verified_attributes',
  // Audit
  'audit_log',
  // Branding
  'branding_settings',
  // API keys
  'check_api_keys',
  // Auth flows
  'ciba_requests',
  'device_codes',
  'external_idp_auth_states',
  'flows',
  'password_reset_tokens',
  // Consents
  'client_consent_overrides',
  'client_trust_policies',
  'consent_history',
  'consent_item_history',
  'consent_policies',
  'consent_policy_items',
  'consent_policy_versions',
  'consent_records',
  'consent_statement_localizations',
  'consent_statement_versions',
  'consent_statements',
  'oauth_client_consents',
  'sign_in_confirmation_policies',
  'tenant_consent_requirements',
  'user_consent_records',
  // Flow runtime resources
  'screens',
  'oidc_scopes',
  // Compliance
  'compliance_reports',
  'data_export_requests',
  // Credentials (VC)
  'credential_configurations',
  'issued_credentials',
  'presentation_definitions',
  'status_lists',
  'trusted_issuers',
  'vp_requests',
  // Identity
  'identity_providers',
  'linked_identities',
  'passkeys',
  'subject_identifiers',
  'upstream_providers',
  // Clients
  'oauth_clients',
  // Organizations
  'org_domain_mappings',
  'subject_org_membership',
  'organizations',
  // Policies
  'permission_change_audit',
  'permission_check_audit',
  'policy_rules',
  'policy_simulations',
  'relation_definitions',
  'relationship_closure',
  'relationships',
  'resource_permissions',
  'role_assignment_rules',
  // Roles
  'role_assignments',
  'user_roles',
  'roles',
  // Security
  'security_threats',
  'suspicious_activities',
  // Sessions
  'sessions',
  // Settings
  'settings_history',
  // Custom claims
  'custom_claim_schema_history',
  'custom_claim_schemas',
  // Token claim rules
  'token_claim_rules',
  // Refresh token sharding
  'refresh_token_shard_configs',
  // Users (tenant-specific user data, separate from shared canonical identity tables)
  'user_custom_fields',
  'user_token_families',
  'users',
  // Webhooks
  'webhook_delivery_logs',
  'webhook_configs',
] as const;

// =============================================================================
// Types
// =============================================================================

interface TenantRow {
  id: string;
  tenant_code: string;
  name: string;
  description: string | null;
  isolation_policy: 'shared_pool' | 'tenant_exclusive';
  lifecycle_state: TenantLifecycleState;
  is_default: number;
  created_at: number;
  updated_at: number;
}

type TenantLifecycleState =
  | 'provisioning'
  | 'active'
  | 'suspended'
  | 'frozen'
  | 'migration_read_only'
  | 'deleting'
  | 'deleted'
  | 'restore_pending'
  | 'restore_validating';

const TENANT_LIFECYCLE_STATES = [
  'provisioning',
  'active',
  'suspended',
  'frozen',
  'migration_read_only',
  'deleting',
  'deleted',
  'restore_pending',
  'restore_validating',
] as const satisfies readonly TenantLifecycleState[];

const TENANT_OPERATOR_MUTABLE_LIFECYCLE_STATES = [
  'active',
  'suspended',
  'frozen',
  'migration_read_only',
] as const satisfies readonly TenantLifecycleState[];

function isRuntimeActiveLifecycleState(state: TenantLifecycleState): boolean {
  return state === 'active';
}

function isOperatorMutableLifecycleState(state: TenantLifecycleState): boolean {
  return (TENANT_OPERATOR_MUTABLE_LIFECYCLE_STATES as readonly TenantLifecycleState[]).includes(
    state
  );
}

export interface TenantControlPlaneProvisioningInput {
  id: string;
  tenantCode: string;
  name: string;
  description: string | null;
  isolationPolicy: 'shared_pool' | 'tenant_exclusive';
  operationKind?: 'create' | 'clone';
  sourceTenantId?: string | null;
  preparationPayload?: Record<string, unknown> | null;
}

// =============================================================================
// Helpers
// =============================================================================

function getDefaultTenantGuard(isDefault: boolean): string | null {
  return isDefault ? 'default' : null;
}

function createAdapter(c: Context<{ Bindings: Env }>): DatabaseAdapter {
  // Tenant inventory routes intentionally run without a request-scoped tenant
  // metadata context. The deployment Core binding is the platform directory
  // that contains the tenant inventory and provisioning drafts.
  return createD1Adapter(c.env.DB, 'tenant-inventory');
}

function formatTenant(row: TenantRow) {
  return {
    id: row.id,
    tenant_code: row.tenant_code,
    name: row.name,
    description: row.description,
    isolation_policy: row.isolation_policy,
    lifecycle_state: row.lifecycle_state,
    is_default: row.is_default === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getAdminActorId(c: Context<{ Bindings: Env }>): string {
  const adminContext = c as unknown as Context<{
    Bindings: Env;
    Variables: { adminAuth?: { adminId?: string } | null };
  }>;
  const adminAuth = adminContext.get('adminAuth');
  return adminAuth?.adminId ?? 'admin-ui';
}

function requiredPathParam(c: Context<{ Bindings: Env }>, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new Error(`tenant_path_parameter_missing:${name}`);
  return value;
}

// =============================================================================
// Validation Schemas
// =============================================================================

// DNS label format: starts and ends with alphanumeric, hyphens allowed in the middle
const TENANT_ID_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const CreateTenantSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(63)
    .regex(
      TENANT_ID_REGEX,
      'id must start and end with a lowercase letter or digit (hyphens allowed in between)'
    ),
  name: z.string().min(1).max(200),
  tenant_code: z
    .string()
    .min(1)
    .max(63)
    .regex(
      TENANT_ID_REGEX,
      'tenant_code must start and end with a lowercase letter or digit (hyphens allowed in between)'
    )
    .optional(),
  description: z.string().max(500).optional(),
  isolation_policy: z.enum(['shared_pool', 'tenant_exclusive']).default('tenant_exclusive'),
});

const UpdateTenantSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    tenant_code: z
      .string()
      .min(1)
      .max(63)
      .regex(
        TENANT_ID_REGEX,
        'tenant_code must start and end with a lowercase letter or digit (hyphens allowed in between)'
      )
      .optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .strict();

const TenantLifecycleCommandSchema = z.object({
  expected_state: z.enum(TENANT_LIFECYCLE_STATES),
  expected_updated_at: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(1000),
  break_glass: z.boolean().optional().default(false),
});

type TenantLifecycleCommand = 'suspend' | 'resume' | 'freeze' | 'unfreeze' | 'restore-validate';

const TENANT_LIFECYCLE_TRANSITIONS: Record<
  TenantLifecycleCommand,
  readonly { from: TenantLifecycleState; to: TenantLifecycleState; async: boolean }[]
> = {
  suspend: [{ from: 'active', to: 'suspended', async: false }],
  resume: [{ from: 'suspended', to: 'active', async: true }],
  freeze: [
    { from: 'active', to: 'frozen', async: false },
    { from: 'migration_read_only', to: 'frozen', async: false },
  ],
  unfreeze: [{ from: 'frozen', to: 'active', async: true }],
  'restore-validate': [
    { from: 'restore_pending', to: 'restore_validating', async: true },
    { from: 'restore_validating', to: 'restore_validating', async: true },
  ],
};

export function validateTenantLifecycleTransition(
  command: TenantLifecycleCommand,
  currentState: TenantLifecycleState,
  breakGlass = false
): { targetState: TenantLifecycleState; async: boolean } {
  const transition = TENANT_LIFECYCLE_TRANSITIONS[command].find(
    (candidate) => candidate.from === currentState
  );
  if (transition) return { targetState: transition.to, async: transition.async };
  if (breakGlass && !['deleted', 'deleting', 'provisioning'].includes(currentState)) {
    const fallbackTarget: TenantLifecycleState =
      command === 'suspend'
        ? 'suspended'
        : command === 'freeze'
          ? 'frozen'
          : command === 'restore-validate'
            ? 'restore_validating'
            : 'active';
    return {
      targetState: fallbackTarget,
      async: ['resume', 'unfreeze', 'restore-validate'].includes(command),
    };
  }
  throw new Error(`Invalid lifecycle transition: ${currentState} -> ${command}`);
}

// =============================================================================
// Tenant Provisioning Helpers
// =============================================================================

/**
 * Build default allowed origins for a new tenant.
 * Includes tenant subdomain, naked domain (if primary), and UI URLs.
 */
function buildDefaultAllowedOrigins(tenantId: string, env: Env): string {
  const origins: string[] = [];
  if (env.BASE_DOMAIN) {
    origins.push(`https://${tenantId}.${env.BASE_DOMAIN}`);
    // Naked domain only for the primary tenant
    if (usesNakedDomainIssuer(env, tenantId)) {
      origins.push(`https://${env.BASE_DOMAIN}`);
    }
  }
  if (env.UI_URL) origins.push(env.UI_URL);
  if (env.ADMIN_UI_URL) origins.push(env.ADMIN_UI_URL);
  return origins.join(',');
}

/**
 * Build default TenantContract using the b2c-standard preset.
 */
function buildDefaultTenantContract(tenantId: string): TenantContract {
  const preset = TENANT_POLICY_PRESETS.find((p) => p.id === 'b2c-standard');
  if (!preset) throw new Error('tenant_default_policy_preset_missing');
  const now = new Date().toISOString();

  return {
    ...preset.defaults,
    tenantId,
    version: 1,
    preset: 'b2c-standard',
    profile: 'human',
    metadata: {
      createdAt: now,
      updatedAt: now,
      createdBy: 'system',
      status: 'active',
    },
  } as TenantContract;
}

/**
 * Seed default per-tenant settings into KV.
 * Writes to AUTHRIM_CONFIG (tenant settings) and SETTINGS (UI settings).
 */
async function seedTenantDefaultSettings(env: Env, tenantId: string) {
  const allowedOrigins = buildDefaultAllowedOrigins(tenantId, env);
  const allowedIdentifiers = (() => {
    try {
      const issuerUrl = buildIssuerUrl(env, tenantId);
      const host = new URL(issuerUrl).hostname;
      return `${issuerUrl},did:web:${host}`;
    } catch {
      return '';
    }
  })();
  const allowedDomain = (() => {
    try {
      return new URL(buildIssuerUrl(env, tenantId)).hostname;
    } catch {
      return '';
    }
  })();

  await Promise.all([
    env.AUTHRIM_CONFIG?.put(
      `settings:tenant:${tenantId}:tenant`,
      JSON.stringify({
        'tenant.allowed_origins': allowedOrigins,
        'tenant.allowed_domains': allowedDomain,
        'tenant.allowed_identifiers': allowedIdentifiers,
      })
    ),
    env.AUTHRIM_CONFIG?.put(
      `settings:tenant:${tenantId}:email-settings`,
      JSON.stringify({ strategy: 'priority_failover', providerOrder: [] })
    ),
    materializeDisabledTenantEmailProviderOrder(env, tenantId),
    env.SETTINGS?.put(
      `settings:tenant:${tenantId}:login-ui`,
      JSON.stringify({ 'login-ui.brand_name': tenantId })
    ),
    env.SETTINGS?.put(`settings:tenant:${tenantId}:tenant-discovery-ui`, JSON.stringify({})),
    env.SETTINGS?.put(`settings:tenant:${tenantId}:authentication-methods`, JSON.stringify({})),
    env.SETTINGS?.put(
      `settings:tenant:${tenantId}:directory-connectors`,
      JSON.stringify({
        enabled: false,
        default_connector_id: 'campus',
        auto_provision: false,
        connectors: [],
      })
    ),
    env.SETTINGS?.put(`settings:tenant:${tenantId}:login-entry`, JSON.stringify({})),
  ]);
}

/**
 * Initialize KeyManager DO for a tenant (idempotent).
 * Creates signing keys only if none exist yet.
 */
async function initTenantKeyManager(
  keyManagerBinding: Env['KEY_MANAGER'],
  tenantId: string
): Promise<void> {
  // All tenants (including 'default') use ${tenantId}-v3 as the DO name
  const km = keyManagerBinding.get(keyManagerBinding.idFromName(`${tenantId}-v3`));
  const status = await km.getStatusRpc();
  if (!status.activeKeyId) {
    // No keys yet — generate the initial key
    await km.rotateKeysRpc();
  }
  // If activeKeyId exists (idempotent: same tenant ID re-provisioned), reuse existing keys
}

async function cleanupTenantProvisioningArtifacts(
  c: Context<{ Bindings: Env }>,
  adapter: DatabaseAdapter,
  tenantId: string,
  strict = false
): Promise<void> {
  const deploymentTarget =
    (c.env as Env & { AUTHRIM_DEPLOYMENT_TARGET?: string }).AUTHRIM_DEPLOYMENT_TARGET ?? 'default';
  const results = await Promise.allSettled([
    adapter.execute('DELETE FROM tenant_database_active_pointers WHERE tenant_id = ?', [tenantId]),
    adapter.execute('DELETE FROM tenant_database_registry WHERE tenant_id = ?', [tenantId]),
    adapter.execute(
      `UPDATE tenant_runtime_registry_snapshots
          SET status = 'invalid'
        WHERE tenant_id = ?
          AND status = 'active'`,
      [tenantId]
    ),
    c.env.TENANT_RUNTIME_REGISTRY?.delete(
      buildTenantRuntimeRegistrySnapshotKey(tenantId, deploymentTarget)
    ),
    c.env.TENANT_RUNTIME_REGISTRY?.delete(
      buildTenantRuntimeRegistryGenerationKey(tenantId, deploymentTarget)
    ),
  ]);
  if (strict && results.some((result) => result.status === 'rejected')) {
    throw new Error('tenant_provisioning_registry_cleanup_failed');
  }
}

function tenantDefaultDatabase(env: Env, route: ControlTenantDefaultRouteAllocation): D1Database {
  const value = (env as unknown as Record<string, unknown>)[route.target.bindingRef];
  if (!value || typeof value !== 'object' || typeof (value as D1Database).prepare !== 'function') {
    throw new Error('tenant_provisioning_default_binding_unavailable');
  }
  return value as D1Database;
}

function aliasInput(
  operation: TenantProvisioningOperationView,
  route: ControlTenantDefaultRouteAllocation
) {
  return {
    tenantId: operation.tenantId,
    tenantCode: operation.tenantCode,
    tenantSlug: operation.tenantId,
    routeProjection: {
      schemaVersion: 1,
      tenantRouteGeneration: route.target.routeGeneration,
      residencyPolicyId: operation.residencyPolicyId,
      target: {
        dataRole: 'tenant_core/default' as const,
        residencyPartition: operation.residencyPartition,
        shardId: route.target.shardId,
        bindingRef: route.target.bindingRef,
        requiredBindingRouteGeneration: route.target.routeGeneration,
      },
    },
  };
}

export async function resolveActiveTenantRuntimeRouteObservation(
  env: Env,
  tenantId: string
): Promise<ControlTenantRuntimeRouteObservation> {
  const requestCache = new Map();
  const entries = await Promise.all([
    resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId,
      role: 'tenant_core',
      shardGroup: 'default',
      shardIndex: 0,
      requestCache,
    }),
    resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId,
      role: 'tenant_core',
      shardGroup: 'users',
      shardIndex: 0,
      requestCache,
    }),
    resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId,
      role: 'tenant_pii',
      shardGroup: 'default',
      shardIndex: 0,
      requestCache,
    }),
  ]);
  const registry = new TenantDatabaseRegistryRepository(
    requireAdminDatabaseAdapter(env, 'tenant-runtime-route-observation')
  );
  const registryRows = await Promise.all(
    entries.map((entry) =>
      registry.getRegistryRow({
        tenant_id: tenantId,
        role: entry.role,
        generation: entry.generation,
        shard_group: entry.shardGroup,
        shard_index: entry.shardIndex,
      })
    )
  );
  const runtimeGeneration = entries[0]?.runtimeGeneration;
  if (
    !Number.isSafeInteger(runtimeGeneration) ||
    Number(runtimeGeneration) < 1 ||
    entries.some((entry) => entry.runtimeGeneration !== runtimeGeneration)
  ) {
    throw new Error('tenant_runtime_registry_route_observation_generation_invalid');
  }
  const targets = entries.map((entry, index) => {
    const registryRow = registryRows[index];
    if (
      !registryRow ||
      registryRow.status !== 'active' ||
      registryRow.binding_ref !== entry.bindingRef ||
      registryRow.generation !== entry.generation
    ) {
      throw new Error('tenant_runtime_registry_route_observation_registry_mismatch');
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(registryRow.metadata_json ?? 'null') as unknown;
    } catch {
      throw new Error('tenant_runtime_registry_route_observation_metadata_invalid');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('tenant_runtime_registry_route_observation_metadata_invalid');
    }
    const record = metadata as Record<string, unknown>;
    const dataRole = ['tenant_core/default', 'tenant_core/users', 'tenant_pii'][
      index
    ] as ControlTenantRuntimeRouteObservation['targets'][number]['dataRole'];
    if (
      record.control_data_role !== dataRole ||
      typeof record.control_shard_id !== 'string' ||
      !record.control_shard_id ||
      !entry.bindingRef
    ) {
      throw new Error('tenant_runtime_registry_route_observation_metadata_invalid');
    }
    return {
      dataRole,
      shardId: record.control_shard_id,
      bindingRef: entry.bindingRef,
      generation: entry.generation,
    };
  });
  return {
    runtimeGeneration: Number(runtimeGeneration),
    registryPublicationGeneration: Number(runtimeGeneration),
    tenantLifecycleState: 'active',
    routeStatus: 'active',
    targets,
  };
}

async function publishProvisionedTenantRegistry(
  env: Env,
  adminAdapter: DatabaseAdapter,
  operation: TenantProvisioningOperationView,
  route: ControlTenantDefaultRouteAllocation
): Promise<void> {
  if (!env.CONTROL?.getTenantProvisioningRouteTargets) {
    throw new Error('tenant_provisioning_control_unavailable');
  }
  const targets = await env.CONTROL.getTenantProvisioningRouteTargets({
    tenantId: operation.tenantId,
    residencyPolicyId: operation.residencyPolicyId,
    residencyPartition: operation.residencyPartition,
  });
  const expectedRoles = new Set<ControlTenantShardCapacityTarget['dataRole']>([
    'tenant_core/default',
    'tenant_core/users',
    'tenant_pii',
  ]);
  if (
    !Array.isArray(targets) ||
    targets.length !== 3 ||
    targets.some((target) => {
      if (!target || typeof target !== 'object' || !expectedRoles.delete(target.dataRole)) {
        return true;
      }
      return (
        target.residencyPolicyId !== operation.residencyPolicyId ||
        target.residencyPartition !== operation.residencyPartition ||
        target.allocationScope !== operation.isolationPolicy ||
        (operation.isolationPolicy === 'tenant_exclusive' &&
          target.ownerTenantId !== operation.tenantId) ||
        (operation.isolationPolicy === 'shared_pool' && target.ownerTenantId !== null)
      );
    }) ||
    expectedRoles.size !== 0
  ) {
    throw new Error('tenant_provisioning_runtime_routes_invalid');
  }
  const defaultTarget = targets.find((target) => target.dataRole === 'tenant_core/default');
  if (
    !defaultTarget ||
    defaultTarget.shardId !== route.target.shardId ||
    defaultTarget.bindingRef !== route.target.bindingRef ||
    defaultTarget.databaseId !== route.target.databaseId ||
    defaultTarget.databaseName !== route.target.databaseName ||
    defaultTarget.routeGeneration !== route.target.routeGeneration
  ) {
    throw new Error('tenant_provisioning_default_route_mismatch');
  }

  const repository = new TenantDatabaseRegistryRepository(adminAdapter);
  const placement = await resolveTenantRuntimePlacementSnapshot(env, operation.tenantId);
  if (placement.isolationPolicy !== operation.isolationPolicy) {
    throw new Error('tenant_provisioning_runtime_placement_mismatch');
  }
  for (const target of targets) {
    const role = target.dataRole === 'tenant_pii' ? 'tenant_pii' : 'tenant_core';
    const shardGroup = target.dataRole === 'tenant_core/users' ? 'users' : 'default';
    await repository.upsertRegistryRow({
      tenant_id: operation.tenantId,
      role,
      generation: target.routeGeneration,
      provider: 'd1',
      database_id: target.databaseId,
      database_name: target.databaseName,
      binding_ref: target.bindingRef,
      schema_version: 1,
      status: 'active',
      shard_group: shardGroup,
      shard_index: 0,
      shard_count: 1,
      shard_key_strategy: 'none',
      worker_shard: 'primary',
      actor_id: operation.createdBy,
      region_hint: null,
      jurisdiction: null,
      metadata_json: JSON.stringify({
        control_allocation_id:
          target.dataRole === 'tenant_core/default' ? route.allocationId : null,
        control_shard_id: target.shardId,
        control_assignment_generation: target.assignmentGeneration,
        control_data_role: target.dataRole,
        control_residency_policy_id: operation.residencyPolicyId,
        control_residency_partition: target.residencyPartition,
        control_allocation_scope: target.allocationScope,
        control_owner_tenant_id: target.ownerTenantId,
        control_placement_policy_generation: placement.policyGeneration,
      }),
    });
    await repository.setActivePointer({
      tenant_id: operation.tenantId,
      role,
      shard_group: shardGroup,
      generation: target.routeGeneration,
      runtime_generation: target.routeGeneration,
      status: 'active',
      updated_by: operation.createdBy,
    });
  }
  await ensureTenantProvisioningRegionShardConfig(env, {
    tenantId: operation.tenantId,
    residencyPolicyId: operation.residencyPolicyId,
    residencyPartition: operation.residencyPartition,
  });
  const published = await publishTenantRuntimeRegistrySnapshot({
    tenantId: operation.tenantId,
    placement,
    repository,
    snapshotStore: env.TENANT_RUNTIME_REGISTRY,
    deploymentTarget: (env as Env & { AUTHRIM_DEPLOYMENT_TARGET?: string })
      .AUTHRIM_DEPLOYMENT_TARGET,
    actorId: operation.createdBy,
    externalSigner: await createControlRuntimeRegistrySigner(env),
  });
  if (
    published.snapshot.runtimeGeneration !== route.target.routeGeneration ||
    published.snapshot.stores.length !== 3 ||
    targets.some((target) => {
      const expectedRole = target.dataRole === 'tenant_pii' ? 'tenant_pii' : 'tenant_core';
      const expectedGroup = target.dataRole === 'tenant_core/users' ? 'users' : 'default';
      return !published.snapshot.stores.some(
        (store) =>
          store.role === expectedRole &&
          store.shardGroup === expectedGroup &&
          store.bindingRef === target.bindingRef &&
          store.databaseId === target.databaseId
      );
    })
  ) {
    throw new Error('tenant_provisioning_registry_generation_mismatch');
  }
  await prepareTenantAliasDirectory(env, aliasInput(operation, route));
}

export async function activateProvisionedTenantLifecycle(input: {
  platformAdapter: DatabaseAdapter;
  tenantAdapter: DatabaseAdapter;
  tenantId: string;
  now: number;
}): Promise<void> {
  await input.platformAdapter.execute(
    "UPDATE tenants SET lifecycle_state = 'active', updated_at = ? WHERE id = ? AND lifecycle_state = 'provisioning'",
    [input.now, input.tenantId]
  );
  // Runtime destination validation reads this row, so it is the final activation commit.
  await input.tenantAdapter.execute(
    "UPDATE tenants SET lifecycle_state = 'active', updated_at = ? WHERE id = ? AND lifecycle_state = 'provisioning'",
    [input.now, input.tenantId]
  );
  const [tenantRow, platformRow] = await Promise.all([
    input.tenantAdapter.queryOne<{ lifecycle_state: string }>(
      'SELECT lifecycle_state FROM tenants WHERE id = ?',
      [input.tenantId]
    ),
    input.platformAdapter.queryOne<{ lifecycle_state: string }>(
      'SELECT lifecycle_state FROM tenants WHERE id = ?',
      [input.tenantId]
    ),
  ]);
  if (tenantRow?.lifecycle_state !== 'active' || platformRow?.lifecycle_state !== 'active') {
    throw new Error('tenant_provisioning_lifecycle_commit_failed');
  }
}

function tenantProvisioningDependencies(
  env: Env,
  platformAdapter: DatabaseAdapter,
  adminAdapter: DatabaseAdapter
): TenantProvisioningSagaDependencies {
  return {
    async validatePlatformDraft(operation) {
      const draft = await platformAdapter.queryOne<{
        id: string;
        tenant_code: string;
        name: string;
        description: string | null;
        lifecycle_state: string;
      }>(
        `SELECT id, tenant_code, name, description, lifecycle_state
           FROM tenants WHERE id = ?`,
        [operation.tenantId]
      );
      if (!draft) {
        const codeOwner = await platformAdapter.queryOne<{ id: string }>(
          'SELECT id FROM tenants WHERE tenant_code = ?',
          [operation.tenantCode]
        );
        if (codeOwner && codeOwner.id !== operation.tenantId) {
          throw new Error('tenant_provisioning_platform_draft_conflict');
        }
        throw new Error('tenant_provisioning_platform_draft_missing');
      }
      if (
        draft.tenant_code !== operation.tenantCode ||
        draft.name !== operation.tenantName ||
        draft.description !== operation.tenantDescription ||
        draft.lifecycle_state !== 'provisioning'
      ) {
        throw new Error('tenant_provisioning_platform_draft_conflict');
      }
    },
    async seedTenant(operation, route) {
      const now = Math.floor(Date.now() / 1000);
      const tenantAdapter = createD1Adapter(
        tenantDefaultDatabase(env, route),
        `tenant-provisioning:${operation.tenantId}`
      );
      await upsertTenantRow(tenantAdapter, {
        id: operation.tenantId,
        tenantCode: operation.tenantCode,
        name: operation.tenantName,
        description: operation.tenantDescription,
        isolationPolicy: operation.isolationPolicy,
        lifecycleState: 'provisioning',
        nowTs: now,
      });
      await seedBuiltinProfileClaimSchemas({
        db: tenantAdapter,
        tenantId: operation.tenantId,
        now,
      });
      await env.AUTHRIM_CONFIG?.put(
        buildContractKey(env, 'tenant', operation.tenantId),
        JSON.stringify(buildDefaultTenantContract(operation.tenantId))
      );
      await seedTenantDefaultSettings(env, operation.tenantId);
      await initTenantKeyManager(env.KEY_MANAGER, operation.tenantId);
    },
    publishRegistry(operation, route) {
      return publishProvisionedTenantRegistry(env, adminAdapter, operation, route);
    },
    async smokeTenant(operation, route) {
      const resolved = await resolveTenantDatabaseSourceFromRegistry(env, {
        tenantId: operation.tenantId,
        role: 'tenant_core',
        shardGroup: 'default',
        shardIndex: 0,
      });
      const expected = aliasInput(operation, route).routeProjection;
      if (
        resolved.bindingRef !== expected.target.bindingRef ||
        resolved.runtimeGeneration !== expected.tenantRouteGeneration
      ) {
        throw new Error('tenant_provisioning_registry_readback_mismatch');
      }
      const tenant = await ensureDatabaseAdapter(
        resolved.source,
        `tenant-provisioning-smoke:${operation.tenantId}`
      ).queryOne<{ id: string; lifecycle_state: string }>(
        'SELECT id, lifecycle_state FROM tenants WHERE id = ?',
        [operation.tenantId]
      );
      if (tenant?.id !== operation.tenantId || tenant.lifecycle_state !== 'provisioning') {
        throw new Error('tenant_provisioning_tenant_readback_failed');
      }
      await env.SETTINGS?.get(`settings:tenant:${operation.tenantId}:login-entry`);
      await env.SETTINGS?.get(`settings:tenant:${operation.tenantId}:login-ui`);
    },
    async prepareTenant(operation, route) {
      return operation.operationKind === 'clone'
        ? prepareTenantCloneForProvisioning(env, operation, route)
        : null;
    },
    activateLookup(operation, route) {
      return activateTenantAliasDirectory(env, aliasInput(operation, route));
    },
    async activateTenant(operation, route) {
      const now = Math.floor(Date.now() / 1000);
      const tenantAdapter = createD1Adapter(
        tenantDefaultDatabase(env, route),
        `tenant-provisioning:${operation.tenantId}`
      );
      await activateProvisionedTenantLifecycle({
        platformAdapter,
        tenantAdapter,
        tenantId: operation.tenantId,
        now,
      });
      await syncTenantExistsCache(env.AUTHRIM_CONFIG, operation.tenantId, 'active');
      if (operation.operationKind === 'clone') {
        await createAuditLog(env, {
          tenantId: operation.tenantId,
          userId: operation.createdBy,
          action: 'tenant.cloned',
          resource: 'tenant',
          resourceId: operation.tenantId,
          ipAddress: 'internal',
          userAgent: 'tenant-provisioning-saga',
          metadata: JSON.stringify({
            operation_id: operation.operationId,
            source_tenant_id: operation.sourceTenantId,
            ...(operation.preparationResult ?? {}),
          }),
          severity: 'info',
        });
      }
      return resolveActiveTenantRuntimeRouteObservation(env, operation.tenantId);
    },
  };
}

export async function processNextTenantProvisioning(env: Env): Promise<boolean> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId) throw new Error('tenant_provisioning_environment_missing');
  const adminAdapter = requireAdminDatabaseAdapter(env, 'tenant-provisioning-saga');
  const platformAdapter = ensureDatabaseAdapter(env.DB, 'tenant-provisioning-platform');
  const repository = new TenantProvisioningOperationRepository(adminAdapter);
  const lease = await repository.claimNext(
    environmentId,
    `management:${crypto.randomUUID()}`,
    Math.floor(Date.now() / 1000)
  );
  if (!lease) return false;
  await runTenantProvisioningSaga({
    env,
    repository,
    lease,
    dependencies: tenantProvisioningDependencies(env, platformAdapter, adminAdapter),
    now: () => Math.floor(Date.now() / 1000),
  });
  return true;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function formatTenantProvisioningOperation(operation: TenantProvisioningOperationView) {
  return {
    operation_id: operation.operationId,
    tenant_id: operation.tenantId,
    operation_kind: operation.operationKind,
    source_tenant_id: operation.sourceTenantId,
    isolation_policy: operation.isolationPolicy,
    status: operation.status,
    current_step: operation.currentStep,
    attempt_count: operation.attemptCount,
    next_attempt_at: operation.nextAttemptAt,
    last_error_code: operation.lastErrorCode,
    created_at: operation.createdAt,
    updated_at: operation.updatedAt,
    completed_at: operation.completedAt,
    preparation_result: operation.preparationResult,
    capacity_operation_ids: operation.capacityOperationIds,
    steps: operation.steps.map((step) => ({
      step_key: step.stepKey,
      status: step.status,
      attempt_count: step.attemptCount,
      next_attempt_at: step.nextAttemptAt,
      last_error_code: step.lastErrorCode,
      observed_resource_id: step.observedResourceId,
      started_at: step.startedAt,
      completed_at: step.completedAt,
      updated_at: step.updatedAt,
    })),
  };
}

async function formatTenantProvisioningStatus(
  env: Env,
  operation: TenantProvisioningOperationView
) {
  const base = formatTenantProvisioningOperation(operation);
  const control = env.CONTROL;
  if (!control?.getProvisioningOperation) {
    return { ...base, capacity_operations: [] };
  }
  const entries = await Promise.all(
    Object.entries(operation.capacityOperationIds).map(async ([dataRole, operationId]) => {
      try {
        const detail = await control.getProvisioningOperation!(operationId);
        if (!detail) return null;
        return {
          data_role: dataRole,
          operation_id: detail.operationId,
          status: detail.status,
          attempt_count: detail.attemptCount,
          next_attempt_at: detail.nextAttemptAt,
          last_error_code: detail.lastErrorCode,
          updated_at: detail.updatedAt,
          steps: detail.steps.map((step) => ({
            step_key: step.stepKey,
            status: step.status,
            attempt_count: step.attemptCount,
            next_attempt_at: step.nextAttemptAt,
            last_error_code: step.lastErrorCode,
            observed_resource_id: step.observedResourceId,
            progress_current: step.progressCurrent,
            progress_total: step.progressTotal,
            started_at: step.startedAt,
            completed_at: step.completedAt,
            updated_at: step.updatedAt,
          })),
        };
      } catch {
        return null;
      }
    })
  );
  return { ...base, capacity_operations: entries.filter((entry) => entry !== null) };
}

export async function beginTenantProvisioning(
  c: Context<{ Bindings: Env }>,
  input: TenantControlPlaneProvisioningInput
): Promise<{ tenant: TenantRow; operation: TenantProvisioningOperationView } | Response> {
  const environmentId = c.env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId) throw new Error('tenant_provisioning_environment_missing');
  const platformAdapter = createAdapter(c);
  const adminAdapter = requireAdminDatabaseAdapter(c.env, 'tenant-provisioning-create');
  const repository = new TenantProvisioningOperationRepository(adminAdapter);
  const requestHash = await sha256Hex(
    JSON.stringify({
      tenantId: input.id,
      tenantCode: input.tenantCode,
      name: input.name,
      description: input.description,
      operationKind: input.operationKind ?? 'create',
      sourceTenantId: input.sourceTenantId ?? null,
      preparationPayload: input.preparationPayload ?? null,
      residencyPolicyId: c.env.DEFAULT_RESIDENCY_PROFILE_ID ?? 'builtin:residency:default',
      residencyPartition: 'default',
      isolationPolicy: input.isolationPolicy,
    })
  );
  const existingOperation = await repository.getByTenant(input.id, environmentId);
  if (existingOperation) {
    if (existingOperation.requestHash !== requestHash) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'id',
          reason: 'Tenant provisioning request conflicts with existing operation',
        },
      });
    }
    let tenant = await platformAdapter.queryOne<TenantRow>(
      'SELECT id, tenant_code, name, description, isolation_policy, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [input.id]
    );
    if (!tenant) {
      await upsertTenantRow(platformAdapter, {
        id: existingOperation.tenantId,
        tenantCode: existingOperation.tenantCode,
        name: existingOperation.tenantName,
        description: existingOperation.tenantDescription,
        isolationPolicy: existingOperation.isolationPolicy,
        lifecycleState: existingOperation.status === 'succeeded' ? 'active' : 'provisioning',
        nowTs: Math.floor(Date.now() / 1000),
      });
      tenant = await platformAdapter.queryOne<TenantRow>(
        'SELECT id, tenant_code, name, description, isolation_policy, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
        [input.id]
      );
    }
    if (!tenant) throw new Error('tenant_provisioning_draft_missing');
    if (
      existingOperation.status === 'queued' ||
      existingOperation.status === 'running' ||
      existingOperation.status === 'waiting_retry'
    ) {
      c.executionCtx?.waitUntil(processNextTenantProvisioning(c.env));
    }
    return { tenant, operation: existingOperation };
  }

  const existingTenant = await platformAdapter.queryOne<{ id: string }>(
    'SELECT id FROM tenants WHERE id = ?',
    [input.id]
  );
  if (existingTenant) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'id', reason: 'Tenant ID already exists' },
    });
  }
  const existingCode = await platformAdapter.queryOne<{ id: string }>(
    'SELECT id FROM tenants WHERE tenant_code = ?',
    [input.tenantCode]
  );
  if (existingCode) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'tenant_code', reason: 'Tenant code already exists' },
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const operationKind = input.operationKind ?? 'create';
  const operationId = `tenant_${operationKind}_${(await sha256Hex(`${environmentId}\0${input.id}`)).slice(0, 32)}`;
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || operationId;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(idempotencyKey)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'Idempotency-Key', reason: 'Invalid idempotency key' },
    });
  }

  let operation: TenantProvisioningOperationView;
  try {
    operation = await repository.create({
      operationId,
      environmentId,
      tenantId: input.id,
      tenantCode: input.tenantCode,
      tenantName: input.name,
      tenantDescription: input.description,
      operationKind,
      sourceTenantId: input.sourceTenantId ?? null,
      preparationPayload: input.preparationPayload ?? null,
      residencyPolicyId: c.env.DEFAULT_RESIDENCY_PROFILE_ID ?? 'builtin:residency:default',
      residencyPartition: 'default',
      isolationPolicy: input.isolationPolicy,
      requestHash,
      idempotencyKey,
      createdBy: getAdminActorId(c),
      now,
    });
  } catch (error) {
    const concurrent = await repository.getByTenant(input.id, environmentId);
    if (!concurrent) throw error;
    if (concurrent.requestHash !== requestHash) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'id',
          reason: 'Tenant provisioning request conflicts with existing operation',
        },
      });
    }
    operation = concurrent;
  }
  await upsertTenantRow(platformAdapter, {
    id: operation.tenantId,
    tenantCode: operation.tenantCode,
    name: operation.tenantName,
    description: operation.tenantDescription,
    isolationPolicy: operation.isolationPolicy,
    lifecycleState: operation.status === 'succeeded' ? 'active' : 'provisioning',
    nowTs: now,
  });
  const tenant = await platformAdapter.queryOne<TenantRow>(
    'SELECT id, tenant_code, name, description, isolation_policy, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
    [input.id]
  );
  if (!tenant) throw new Error('tenant_provisioning_draft_missing');
  c.executionCtx?.waitUntil(processNextTenantProvisioning(c.env));
  return { tenant, operation };
}

async function upsertTenantRow(
  adapter: DatabaseAdapter,
  input: {
    id: string;
    tenantCode: string;
    name: string;
    description: string | null;
    isolationPolicy: 'shared_pool' | 'tenant_exclusive';
    lifecycleState: TenantLifecycleState;
    nowTs: number;
  }
): Promise<void> {
  const tenantKey = createOpaqueTenantKey();
  await adapter.execute(
    `INSERT INTO tenants (
       id, tenant_code, tenant_key, name, description, isolation_policy, lifecycle_state, is_default,
       default_tenant_guard, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       tenant_code = excluded.tenant_code,
       name = excluded.name,
       description = excluded.description,
       lifecycle_state = excluded.lifecycle_state,
       updated_at = excluded.updated_at`,
    [
      input.id,
      input.tenantCode,
      tenantKey,
      input.name,
      input.description,
      input.isolationPolicy,
      input.lifecycleState,
      getDefaultTenantGuard(false),
      input.nowTs,
      input.nowTs,
    ]
  );
}

async function deleteKvPrefix(kv: KVNamespace | undefined, prefix: string): Promise<void> {
  if (!kv) return;
  let cursor: string | undefined;
  const keys: string[] = [];
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  for (let offset = 0; offset < keys.length; offset += 25) {
    await Promise.all(keys.slice(offset, offset + 25).map((key) => kv.delete(key)));
  }
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/tenants
 * List all tenants
 */
export async function adminTenantsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const adminAuth = getAdminAuth(c);
    const hasPlatformAuthority = hasPlatformTenantManagementAuthority(adminAuth);
    const scopedTenantIds = hasPlatformAuthority ? [] : getTenantInventoryScope(adminAuth);

    if (!hasPlatformAuthority && scopedTenantIds.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS, {
        variables: {
          required_scope: 'tenant',
          reason: 'No tenant inventory scope is available for this administrator',
        },
      });
    }

    const adapter = createAdapter(c);
    const singleTenantMode = isSingleTenantMode(c.env);
    const tenantFilters: string[] = [];
    const tenantParams: string[] = [];
    if (singleTenantMode) {
      tenantFilters.push('id = ?');
      tenantParams.push(getSingleTenantId(c.env));
    } else if (!hasPlatformAuthority) {
      tenantFilters.push(`id IN (${scopedTenantIds.map(() => '?').join(', ')})`);
      tenantParams.push(...scopedTenantIds);
    }

    const query = [
      'SELECT id, tenant_code, name, description, isolation_policy, lifecycle_state, is_default, created_at, updated_at FROM tenants',
      tenantFilters.length > 0 ? `WHERE ${tenantFilters.join(' AND ')}` : '',
      'ORDER BY is_default DESC, name ASC',
    ]
      .filter(Boolean)
      .join(' ');
    const rows = await adapter.query<TenantRow>(query, tenantParams);
    return c.json({
      tenants: rows.map(formatTenant),
      total: rows.length,
      single_tenant_mode: singleTenantMode,
      single_tenant_reason: singleTenantMode
        ? 'API custom domain is not configured. This deployment runs in single-tenant mode.'
        : null,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to list tenants', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/tenants
 * Create a new tenant
 */
export async function adminTenantCreateHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) {
    return platformError;
  }

  if (isSingleTenantMode(c.env)) {
    return createSingleTenantMutationError(c, 'tenant');
  }

  try {
    const body = await c.req.json<unknown>();
    const parseResult = CreateTenantSchema.safeParse(body);

    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const { id, name, description, isolation_policy } = parseResult.data;
    const tenantCode = parseResult.data.tenant_code || id;
    const started = await beginTenantProvisioning(c, {
      id,
      tenantCode,
      name,
      description: description ?? null,
      isolationPolicy: isolation_policy,
    });
    if (started instanceof Response) return started;
    await createAuditLogFromContext(c, 'tenant.provisioning_requested', 'tenant', id, {
      operation_id: started.operation.operationId,
      tenant_code: tenantCode,
      isolation_policy,
    });
    return c.json(
      {
        ...formatTenant(started.tenant),
        provisioning: {
          mode: 'control-plane',
          ...formatTenantProvisioningOperation(started.operation),
        },
      },
      202
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to create tenant', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/** GET /api/admin/tenants/:id/provisioning */
export async function adminTenantProvisioningStatusHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) return platformError;
  const tenantId = requiredPathParam(c, 'id');
  const environmentId = c.env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId) throw new Error('tenant_provisioning_environment_missing');
  const repository = new TenantProvisioningOperationRepository(
    requireAdminDatabaseAdapter(c.env, 'tenant-provisioning-status')
  );
  const operation = await repository.getByTenant(tenantId, environmentId);
  if (!operation) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
      variables: { resource: 'tenant_provisioning_operation', id: tenantId },
    });
  }
  if (['queued', 'waiting_retry', 'running'].includes(operation.status)) {
    c.executionCtx?.waitUntil(processNextTenantProvisioning(c.env));
  }
  return c.json(await formatTenantProvisioningStatus(c.env, operation));
}

/**
 * GET /api/admin/tenants/:id
 * Get a single tenant
 */
export async function adminTenantGetHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) {
    return platformError;
  }

  const id = requiredPathParam(c, 'id');
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  try {
    const adapter = createAdapter(c);
    const tenant = await adapter.queryOne<TenantRow>(
      'SELECT id, tenant_code, name, description, isolation_policy, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    if (!tenant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    return c.json(formatTenant(tenant));
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to get tenant', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * PATCH /api/admin/tenants/:id
 * Update tenant (name, description, lifecycle_state)
 * Note: id and is_default cannot be changed via this endpoint
 */
export async function adminTenantUpdateHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) {
    return platformError;
  }

  const id = requiredPathParam(c, 'id');
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  try {
    const body = await c.req.json<unknown>();
    const parseResult = UpdateTenantSchema.safeParse(body);

    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const updates = parseResult.data;
    const adapter = createAdapter(c);

    // Check tenant exists
    const existing = await adapter.queryOne<TenantRow>(
      'SELECT id, tenant_code, name, description, isolation_policy, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    // Build update fields
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.tenant_code !== undefined) {
      const collision = await adapter.queryOne<{ id: string }>(
        'SELECT id FROM tenants WHERE tenant_code = ? AND id != ?',
        [updates.tenant_code, id]
      );

      if (collision) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'tenant_code', reason: 'Tenant code already exists' },
        });
      }

      fields.push('tenant_code = ?');
      values.push(updates.tenant_code);
    }
    if ('description' in updates) {
      fields.push('description = ?');
      values.push(updates.description ?? null);
    }
    if (fields.length === 0) {
      return c.json(formatTenant(existing));
    }

    const nowTs = Math.floor(Date.now() / 1000);
    fields.push('updated_at = ?');
    values.push(nowTs);
    values.push(id);

    await adapter.execute(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`, values);

    const updated = await adapter.queryOne<TenantRow>(
      'SELECT id, tenant_code, name, description, isolation_policy, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    await createAuditLogFromContext(c, 'tenant.updated', 'tenant', id, {
      changes: updates,
    });

    if (!updated) throw new Error('tenant_update_reflection_failed');
    return c.json(formatTenant(updated));
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to update tenant', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

async function executeTenantLifecycleCommand(
  c: Context<{ Bindings: Env }>,
  command: TenantLifecycleCommand
): Promise<Response> {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) return platformError;

  const id = requiredPathParam(c, 'id');
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) return blocked;

  const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'A valid Idempotency-Key header is required',
      },
      400
    );
  }

  const parsed = TenantLifecycleCommandSchema.safeParse(await c.req.json<unknown>());
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: parsed.error.issues.map((issue) => issue.message).join(', '),
      },
      400
    );
  }

  const adminAuth = getAdminAuth(c);
  if (
    parsed.data.break_glass &&
    !hasAdminPermission(
      adminAuth?.permissions ?? [],
      ADMIN_PERMISSIONS.TENANT_LIFECYCLE_BREAK_GLASS
    )
  ) {
    return c.json(
      {
        error: 'insufficient_permissions',
        error_description: 'Break-glass tenant lifecycle permission is required',
      },
      403
    );
  }

  const adapter = createAdapter(c);
  const existingJob = await adapter.queryOne<{
    id: string;
    status: string;
    progress: string | null;
    config: string | null;
  }>(
    `SELECT id, status, progress, config FROM admin_jobs
      WHERE tenant_id = ? AND job_type = 'tenants/lifecycle-validation'
        AND json_extract(config, '$.idempotency_key') = ?
      ORDER BY created_at DESC LIMIT 1`,
    [id, idempotencyKey]
  );
  if (existingJob) {
    const existingConfig = existingJob.config
      ? (JSON.parse(existingJob.config) as Record<string, unknown>)
      : {};
    const samePayload =
      existingConfig.command === command &&
      existingConfig.source_state === parsed.data.expected_state &&
      existingConfig.expected_updated_at === parsed.data.expected_updated_at &&
      existingConfig.reason === parsed.data.reason &&
      existingConfig.break_glass === parsed.data.break_glass;
    if (!samePayload) {
      return c.json(
        {
          error: 'idempotency_conflict',
          error_description: 'Idempotency-Key was already used with a different request payload',
        },
        409
      );
    }
    return c.json(
      {
        job_id: existingJob.id,
        status: existingJob.status,
        idempotent_replay: true,
        progress: existingJob.progress ? (JSON.parse(existingJob.progress) as unknown) : null,
      },
      existingJob.status === 'completed' ? 200 : 202
    );
  }

  const tenant = await adapter.queryOne<TenantRow>(
    'SELECT id, tenant_code, name, description, isolation_policy, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
    [id]
  );
  if (!tenant) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
      variables: { resource: 'tenant' },
    });
  }
  if (
    tenant.lifecycle_state !== parsed.data.expected_state ||
    tenant.updated_at !== parsed.data.expected_updated_at
  ) {
    return c.json(
      {
        error: 'lifecycle_conflict',
        error_description: 'Tenant lifecycle state or version changed',
        current_state: tenant.lifecycle_state,
        current_updated_at: tenant.updated_at,
      },
      409
    );
  }
  if (tenant.is_default === 1 && command !== 'resume' && command !== 'unfreeze') {
    return c.json(
      { error: 'invalid_request', error_description: 'Cannot deactivate the default tenant' },
      400
    );
  }

  let transition: { targetState: TenantLifecycleState; async: boolean };
  try {
    transition = validateTenantLifecycleTransition(
      command,
      tenant.lifecycle_state,
      parsed.data.break_glass
    );
  } catch (error) {
    return c.json(
      { error: 'invalid_lifecycle_transition', error_description: (error as Error).message },
      409
    );
  }

  const nowTs = Math.max(Math.floor(Date.now() / 1000), tenant.updated_at + 1);
  const jobId = crypto.randomUUID();
  const validationKind = command === 'restore-validate' ? 'restore' : command;
  const config = {
    command,
    validation_kind: validationKind,
    source_state: tenant.lifecycle_state,
    target_state: transition.targetState,
    reason: parsed.data.reason,
    break_glass: parsed.data.break_glass,
    idempotency_key: idempotencyKey,
    expected_updated_at: parsed.data.expected_updated_at,
    actor_id: adminAuth?.actorId ?? adminAuth?.userId ?? null,
  };
  const nextState =
    command === 'restore-validate'
      ? 'restore_validating'
      : transition.async
        ? tenant.lifecycle_state
        : transition.targetState;
  const status = transition.async ? 'pending' : 'completed';
  const progress = transition.async
    ? { stage: 'queued', checks: [] }
    : { stage: 'completed', checks: [], transitioned_to: nextState };

  try {
    await adapter.transaction(async (tx) => {
      const update = await tx.execute(
        'UPDATE tenants SET lifecycle_state = ?, updated_at = ? WHERE id = ? AND lifecycle_state = ? AND updated_at = ?',
        [nextState, nowTs, id, tenant.lifecycle_state, tenant.updated_at]
      );
      if (update.rowsAffected === 0) throw new Error('lifecycle_conflict');
      await tx.execute(
        `INSERT INTO admin_jobs (
        id, tenant_id, job_type, status, progress, config, created_by,
        created_at, updated_at, estimated_completion, attempt_count, max_attempts
      ) VALUES (?, ?, 'tenants/lifecycle-validation', ?, ?, ?, ?, ?, ?, ?, 0, 3)`,
        [
          jobId,
          id,
          status,
          JSON.stringify(progress),
          JSON.stringify(config),
          adminAuth?.actorId ?? adminAuth?.userId ?? 'unknown',
          nowTs,
          nowTs,
          transition.async ? nowTs + 300 : nowTs,
        ]
      );
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'lifecycle_conflict') {
      return c.json(
        { error: 'lifecycle_conflict', error_description: 'Tenant lifecycle changed concurrently' },
        409
      );
    }
    throw error;
  }

  await syncTenantExistsCache(c.env.AUTHRIM_CONFIG, id, nextState);
  await createAuditLogFromContext(c, `tenant.lifecycle.${command}`, 'tenant', id, {
    job_id: jobId,
    source_state: tenant.lifecycle_state,
    target_state: nextState,
    reason: parsed.data.reason,
    break_glass: parsed.data.break_glass,
    idempotency_key: idempotencyKey,
  });

  return c.json(
    {
      job_id: jobId,
      status,
      tenant_id: id,
      lifecycle_state: nextState,
      validation_required: transition.async,
    },
    transition.async ? 202 : 200
  );
}

export const adminTenantSuspendHandler = (c: Context<{ Bindings: Env }>) =>
  executeTenantLifecycleCommand(c, 'suspend');
export const adminTenantResumeHandler = (c: Context<{ Bindings: Env }>) =>
  executeTenantLifecycleCommand(c, 'resume');
export const adminTenantFreezeHandler = (c: Context<{ Bindings: Env }>) =>
  executeTenantLifecycleCommand(c, 'freeze');
export const adminTenantUnfreezeHandler = (c: Context<{ Bindings: Env }>) =>
  executeTenantLifecycleCommand(c, 'unfreeze');
export const adminTenantRestoreValidateHandler = (c: Context<{ Bindings: Env }>) =>
  executeTenantLifecycleCommand(c, 'restore-validate');

export async function adminTenantLifecycleJobsHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) return platformError;
  const id = requiredPathParam(c, 'id');
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) return blocked;

  const adapter = createAdapter(c);
  const jobs = await adapter.query<{
    id: string;
    status: string;
    progress: string | null;
    result: string | null;
    config: string | null;
    error_message: string | null;
    attempt_count: number | null;
    max_attempts: number | null;
    next_run_at: number | null;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
  }>(
    `SELECT id, status, progress, result, config, error_message, attempt_count, max_attempts,
            next_run_at, created_at, updated_at, completed_at
       FROM admin_jobs
      WHERE tenant_id = ? AND job_type = 'tenants/lifecycle-validation'
      ORDER BY created_at DESC LIMIT 20`,
    [id]
  );
  return c.json({
    jobs: jobs.map((job) => ({
      ...job,
      progress: job.progress ? (JSON.parse(job.progress) as unknown) : null,
      result: job.result ? (JSON.parse(job.result) as unknown) : null,
      config: job.config ? (JSON.parse(job.config) as unknown) : null,
    })),
  });
}

export async function adminTenantLifecycleJobRetryHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) return platformError;
  const id = requiredPathParam(c, 'id');
  const jobId = requiredPathParam(c, 'jobId');
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) return blocked;

  const adapter = createAdapter(c);
  const job = await adapter.queryOne<{ id: string; status: string; config: string | null }>(
    `SELECT id, status, config FROM admin_jobs
      WHERE id = ? AND tenant_id = ? AND job_type = 'tenants/lifecycle-validation'`,
    [jobId, id]
  );
  if (!job) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
      variables: { resource: 'tenant lifecycle job' },
    });
  }
  if (!['failed', 'partial_failure'].includes(job.status)) {
    return c.json(
      {
        error: 'invalid_job_state',
        error_description: 'Only failed lifecycle jobs can be retried',
      },
      409
    );
  }

  const nowTs = Math.floor(Date.now() / 1000);
  await adapter.execute(
    `UPDATE admin_jobs
        SET status = 'pending', progress = ?, result = NULL, error_code = NULL,
            error_message = NULL, attempt_count = 0, next_run_at = ?,
            dead_lettered_at = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status IN ('failed', 'partial_failure')`,
    [JSON.stringify({ stage: 'retry_queued', checks: [] }), nowTs, nowTs, jobId, id]
  );
  await createAuditLogFromContext(c, 'tenant.lifecycle.validation_retry_requested', 'tenant', id, {
    job_id: jobId,
    prior_status: job.status,
    config: job.config ? JSON.parse(job.config) : null,
  });
  const config = job.config
    ? (JSON.parse(job.config) as { source_state?: TenantLifecycleState })
    : {};
  return c.json(
    {
      job_id: jobId,
      status: 'pending',
      tenant_id: id,
      lifecycle_state: config.source_state ?? 'frozen',
      validation_required: true,
    },
    202
  );
}

/**
 * POST /api/admin/tenants/:id/provisioning/retry
 * Retry a blocked Control Plane tenant provisioning operation.
 */
export async function adminTenantProvisioningRetryHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) {
    return platformError;
  }

  const id = requiredPathParam(c, 'id');
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  try {
    const environmentId = c.env.AUTHRIM_ENVIRONMENT_NAME;
    if (!environmentId) throw new Error('tenant_provisioning_environment_missing');
    const controlRepository = new TenantProvisioningOperationRepository(
      requireAdminDatabaseAdapter(c.env, 'tenant-provisioning-retry')
    );
    const controlOperation = await controlRepository.getByTenant(id, environmentId);
    if (controlOperation) {
      if (controlOperation.status !== 'blocked') {
        return c.json(
          {
            error: 'tenant_provisioning_not_blocked',
            message: 'Tenant provisioning is not waiting for an administrator retry.',
            provisioning: formatTenantProvisioningOperation(controlOperation),
          },
          409
        );
      }
      const retried = await controlRepository.retryBlocked(
        controlOperation.operationId,
        environmentId,
        Math.floor(Date.now() / 1000)
      );
      if (!retried) throw new Error('tenant_provisioning_retry_conflict');
      c.executionCtx?.waitUntil(processNextTenantProvisioning(c.env));
      await createAuditLogFromContext(c, 'tenant.provisioning_retry.requested', 'tenant', id, {
        operation_id: retried.operationId,
      });
      return c.json(formatTenantProvisioningOperation(retried), 202);
    }

    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
      variables: {
        resource: 'tenant_provisioning_operation',
        id,
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to retry tenant provisioning', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/tenants/:id/provisioning/cleanup
 * Remove a failed tenant draft and release any uncommitted Control allocation.
 */
export async function adminTenantProvisioningCleanupHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) {
    return platformError;
  }

  const id = requiredPathParam(c, 'id');
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  try {
    const environmentId = c.env.AUTHRIM_ENVIRONMENT_NAME;
    if (!environmentId) throw new Error('tenant_provisioning_environment_missing');
    const adminAdapter = requireAdminDatabaseAdapter(c.env, 'tenant-provisioning-cleanup');
    const controlRepository = new TenantProvisioningOperationRepository(adminAdapter);
    let controlOperation = await controlRepository.getByTenant(id, environmentId);
    if (controlOperation) {
      if (controlOperation.status === 'succeeded' || controlOperation.status === 'running') {
        return c.json(
          {
            error: 'tenant_provisioning_cleanup_conflict',
            message: 'Running or completed tenant provisioning cannot be cleaned up.',
            provisioning: formatTenantProvisioningOperation(controlOperation),
          },
          409
        );
      }
      if (
        controlOperation.currentStep === 'lookup_activate' ||
        controlOperation.currentStep === 'tenant_active'
      ) {
        return c.json(
          {
            error: 'tenant_provisioning_cleanup_conflict',
            message:
              'Lookup activation may already be externally visible. Retry provisioning to complete activation.',
            provisioning: formatTenantProvisioningOperation(controlOperation),
          },
          409
        );
      }
      if (controlOperation.status !== 'canceled') {
        const canceled = await controlRepository.cancel(
          controlOperation.operationId,
          environmentId,
          Math.floor(Date.now() / 1000)
        );
        if (!canceled) throw new Error('tenant_provisioning_cleanup_conflict');
        controlOperation = canceled;
      }

      const route = decodeTenantProvisioningRoute(
        controlOperation.defaultRouteAllocation,
        controlOperation
      );
      const registryWasPublished = controlOperation.steps.some(
        (step) => step.stepKey === 'registry_publish' && step.status === 'succeeded'
      );
      if (route && registryWasPublished) {
        try {
          await disableTenantAliasDirectory(c.env, aliasInput(controlOperation, route));
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'tenant_alias_lifecycle_terminal') {
            throw error;
          }
        }
      }
      await cleanupTenantProvisioningArtifacts(c, adminAdapter, id, true);
      if (controlOperation.operationKind === 'clone') {
        await cleanupTenantCloneKvArtifacts(c.env, id);
      }
      if (route) {
        const tenantAdapter = createD1Adapter(
          tenantDefaultDatabase(c.env, route),
          `tenant-provisioning-cleanup:${id}`
        );
        await tenantAdapter.execute(
          "DELETE FROM tenants WHERE id = ? AND lifecycle_state = 'provisioning'",
          [id]
        );
      }
      const adapter = createAdapter(c);
      await adapter.execute(
        "UPDATE tenants SET lifecycle_state = 'deleted', updated_at = ? WHERE id = ? AND lifecycle_state = 'provisioning'",
        [Math.floor(Date.now() / 1000), id]
      );
      await Promise.all([
        c.env.AUTHRIM_CONFIG?.delete(buildContractKey(c.env, 'tenant', id)),
        c.env.AUTHRIM_CONFIG?.delete(`settings:tenant:${id}:tenant`),
        c.env.AUTHRIM_CONFIG?.delete(`settings:tenant:${id}:email-settings`),
        deleteTenantExistsCache(c.env.AUTHRIM_CONFIG, id),
        deleteKvPrefix(c.env.SETTINGS, `settings:tenant:${id}:`),
      ]);
      if (route?.state === 'reserved') {
        if (!c.env.CONTROL?.releaseTenantDefaultRoute) {
          throw new Error('tenant_provisioning_control_unavailable');
        }
        await c.env.CONTROL.releaseTenantDefaultRoute({ allocationId: route.allocationId });
      }
      await createAuditLogFromContext(c, 'tenant.provisioning_cleanup.succeeded', 'tenant', id, {
        operation_id: controlOperation.operationId,
      });
      return c.json({
        status: 'cleaned',
        tenant_id: id,
        operation_id: controlOperation.operationId,
      });
    }

    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
      variables: {
        resource: 'tenant_provisioning_operation',
        id,
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to cleanup tenant provisioning draft', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/tenants/:id
 * Schedule a tenant deletion as an async job.
 * The tenant is immediately deactivated; all data is deleted by the Cron job.
 * Returns 202 Accepted with the job ID.
 * The primary tenant cannot be deleted.
 */
export async function adminTenantDeleteHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) {
    return platformError;
  }

  const id = requiredPathParam(c, 'id');
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  const protectedTenantId = getPrimaryTenantId(c.env);
  if (id === protectedTenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'id', reason: 'Cannot delete the primary tenant' },
    });
  }

  try {
    const adapter = createAdapter(c);

    const existing = await adapter.queryOne<{
      id: string;
      is_default: number;
      lifecycle_state: TenantLifecycleState;
    }>('SELECT id, is_default, lifecycle_state FROM tenants WHERE id = ?', [id]);

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    if (id === protectedTenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'id', reason: 'Cannot delete the primary tenant' },
      });
    }

    if (existing.is_default === 1) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'id', reason: 'Cannot delete the default tenant' },
      });
    }

    if (!isOperatorMutableLifecycleState(existing.lifecycle_state)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'lifecycle_state',
          reason: 'Lifecycle state requires a dedicated operation',
        },
      });
    }

    // Get admin identity for job attribution
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const adminAuth = (c as any).get('adminAuth') as { adminId?: string } | null;
    const createdBy = adminAuth?.adminId ?? 'unknown';

    const nowTs = Math.floor(Date.now() / 1000);
    const jobId = crypto.randomUUID();
    // Estimate completion: max 1 hour (next hourly cron tick)
    const estimatedCompletion = nowTs + 3600;

    await adapter.transaction(async (tx) => {
      // Immediately move the tenant out of the runtime-active lifecycle to block new requests.
      await tx.execute(
        "UPDATE tenants SET lifecycle_state = 'deleting', updated_at = ? WHERE id = ?",
        [nowTs, id]
      );

      await tx.execute(
        `INSERT INTO admin_jobs (
          id, tenant_id, job_type, status, progress, config,
          created_by, created_at, updated_at, estimated_completion
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          jobId,
          getTenantIdFromContext(c),
          'tenants/delete',
          'pending',
          JSON.stringify({ stage: 'queued' }),
          JSON.stringify({ tenant_id: id }),
          createdBy,
          nowTs,
          nowTs,
          estimatedCompletion,
        ]
      );
    });

    // Invalidate cache so subsequent requests to this tenant return 404 immediately.
    await syncTenantExistsCache(c.env.AUTHRIM_CONFIG, id, 'deleting');

    await createAuditLogFromContext(c, 'tenant.delete_queued', 'tenant', id, {
      tenant_id: id,
      job_id: jobId,
    });

    return c.json(
      {
        job_id: jobId,
        status: 'pending',
        estimated_completion: estimatedCompletion,
      },
      202
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to queue tenant deletion', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/tenants/:id/set-default
 * Set a tenant as the default tenant (atomically, using D1 batch)
 */
export async function adminTenantSetDefaultHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) {
    return platformError;
  }

  const id = requiredPathParam(c, 'id');
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  if (isSingleTenantMode(c.env)) {
    return createSingleTenantMutationError(c, 'id');
  }

  try {
    const adapter = createAdapter(c);

    const existing = await adapter.queryOne<{ id: string; lifecycle_state: TenantLifecycleState }>(
      'SELECT id, lifecycle_state FROM tenants WHERE id = ?',
      [id]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    if (!isRuntimeActiveLifecycleState(existing.lifecycle_state)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'id', reason: 'Cannot set a non-active tenant as default' },
      });
    }

    const nowTs = Math.floor(Date.now() / 1000);

    await adapter.transaction(async (tx) => {
      await tx.execute(
        'UPDATE tenants SET is_default = 0, default_tenant_guard = NULL, updated_at = ? WHERE is_default = 1',
        [nowTs]
      );
      await tx.execute(
        'UPDATE tenants SET is_default = 1, default_tenant_guard = ?, updated_at = ? WHERE id = ?',
        [getDefaultTenantGuard(true), nowTs, id]
      );
    });

    const updated = await adapter.queryOne<TenantRow>(
      'SELECT id, tenant_code, name, description, isolation_policy, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    await createAuditLogFromContext(c, 'tenant.set_default', 'tenant', id, { tenant_id: id });

    if (!updated) throw new Error('tenant_default_reflection_failed');
    return c.json(formatTenant(updated));
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to set default tenant', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
