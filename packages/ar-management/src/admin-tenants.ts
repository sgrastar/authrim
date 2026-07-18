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
  createAuthContextFromHono,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  createAuditLogFromContext,
  getDefaultTenantId,
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
} from '@authrim/ar-lib-core';
import { createOpaqueTenantKey } from './logging-tenant-key';

/**
 * Invalidate the tenant existence KV cache for a given tenant.
 * Called after create, lifecycle_state change, and deactivate to ensure
 * request-context middleware picks up the new state promptly.
 */
async function invalidateTenantExistsCache(
  kv: KVNamespace | undefined,
  tenantId: string
): Promise<void> {
  await kv?.delete(`v1:tenant-exists:${tenantId}`).catch(() => {});
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

const TENANT_INTERNAL_LIFECYCLE_STATES = [
  'provisioning',
  'deleting',
  'deleted',
  'restore_pending',
  'restore_validating',
] as const satisfies readonly TenantLifecycleState[];

function isRuntimeActiveLifecycleState(state: TenantLifecycleState): boolean {
  return state === 'active';
}

function isInternalLifecycleState(state: TenantLifecycleState): boolean {
  return (TENANT_INTERNAL_LIFECYCLE_STATES as readonly TenantLifecycleState[]).includes(state);
}

function isOperatorMutableLifecycleState(state: TenantLifecycleState): boolean {
  return (TENANT_OPERATOR_MUTABLE_LIFECYCLE_STATES as readonly TenantLifecycleState[]).includes(
    state
  );
}

interface TenantDatabaseSlotRow {
  slot_id: string;
  slot_number: number;
  core_binding_ref: string;
  pii_binding_ref: string;
  core_database_name: string;
  pii_database_name: string;
  core_database_id: string;
  pii_database_id: string;
  state: string;
  assigned_tenant_id: string | null;
}

interface TenantProvisioningMetadata {
  provisioning_status: 'active' | 'inactive' | 'provisioning_failed';
  provisioning_error: string | null;
  provisioning_slot_id: string | null;
  provisioning_updated_at: number | null;
}

interface TenantD1ProvisioningInput {
  id: string;
  tenantCode: string;
  name: string;
  description: string | null;
}

type TenantD1ProvisioningResult =
  | { ok: true; tenant: TenantRow }
  | { ok: false; response: Response };

export interface TenantProvisionInput {
  id: string;
  tenantCode: string;
  name: string;
  description: string | null;
  /** Keep the tenant hidden from runtime resolution until activateProvisionedTenant() succeeds. */
  deferActivation?: boolean;
}

export type TenantProvisionResult =
  | {
      ok: true;
      tenant: ReturnType<typeof formatTenant>;
      provisioning?: {
        mode: 'tenant-d1-preallocated-pool';
        slot_id: string;
        smoke_test: 'passed';
      };
    }
  | { ok: false; response: Response };

// =============================================================================
// Helpers
// =============================================================================

const TENANT_D1_STORAGE_PROFILE_ID = 'builtin:storage:tenant-d1';
const TENANT_CREATE_SMOKE_TIMEOUT_MS = 15_000;
const TENANT_CREATE_SMOKE_BACKOFF_MS = [250, 500, 1000, 2000];

function getDefaultTenantGuard(isDefault: boolean): string | null {
  return isDefault ? 'default' : null;
}

function createAdapter(c: Context<{ Bindings: Env }>): DatabaseAdapter {
  return createAuthContextFromHono(c, getTenantIdFromContext(c)).coreAdapter;
}

function isTenantD1PoolMode(env: Env): boolean {
  return env.DEFAULT_STORAGE_PROFILE_ID === TENANT_D1_STORAGE_PROFILE_ID;
}

function formatTenant(row: TenantRow) {
  return {
    id: row.id,
    tenant_code: row.tenant_code,
    name: row.name,
    description: row.description,
    lifecycle_state: row.lifecycle_state,
    is_default: row.is_default === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatTenantWithProvisioning(row: TenantRow, metadata: TenantProvisioningMetadata | null) {
  return {
    ...formatTenant(row),
    ...(metadata ?? {
      provisioning_status: isRuntimeActiveLifecycleState(row.lifecycle_state)
        ? 'active'
        : 'inactive',
      provisioning_error: null,
      provisioning_slot_id: null,
      provisioning_updated_at: null,
    }),
  };
}

async function getTenantProvisioningMetadata(
  env: Env,
  row: TenantRow
): Promise<TenantProvisioningMetadata | null> {
  if (!isTenantD1PoolMode(env)) {
    return null;
  }

  try {
    const adminAdapter = requireAdminDatabaseAdapter(env, 'tenant-d1-provisioning-status');
    const slot = await adminAdapter.queryOne<{
      slot_id: string;
      state: string;
      updated_at: number | null;
    }>(
      `SELECT slot_id, state, updated_at
         FROM tenant_database_slots
        WHERE assigned_tenant_id = ?
          AND state IN ('reset_required', 'unavailable')
        ORDER BY updated_at DESC
        LIMIT 1`,
      [row.id]
    );

    let provisioningSlot = slot;
    let failure: {
      error_code: string | null;
      created_at: number | null;
      slot_id?: string;
      result?: string;
    } | null = null;

    if (!isRuntimeActiveLifecycleState(row.lifecycle_state)) {
      const latestTerminalEvent = await adminAdapter.queryOne<{
        slot_id: string;
        error_code: string | null;
        created_at: number | null;
        result: string;
      }>(
        `SELECT slot_id, error_code, created_at, result
           FROM tenant_database_slot_audit_events
          WHERE tenant_id = ?
            AND result IN ('failed', 'succeeded')
            AND slot_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1`,
        [row.id]
      );
      failure = latestTerminalEvent?.result === 'failed' ? latestTerminalEvent : null;
    }

    if (!provisioningSlot && failure?.slot_id) {
      provisioningSlot = await adminAdapter.queryOne<{
        slot_id: string;
        state: string;
        updated_at: number | null;
      }>('SELECT slot_id, state, updated_at FROM tenant_database_slots WHERE slot_id = ?', [
        failure.slot_id,
      ]);
    }

    if (failure && !isRuntimeActiveLifecycleState(row.lifecycle_state)) {
      return {
        provisioning_status: 'provisioning_failed',
        provisioning_error: failure.error_code ?? null,
        provisioning_slot_id: failure.slot_id ?? provisioningSlot?.slot_id ?? null,
        provisioning_updated_at:
          failure.created_at ?? provisioningSlot?.updated_at ?? row.updated_at,
      };
    }

    if (!failure && !provisioningSlot) {
      return {
        provisioning_status: isRuntimeActiveLifecycleState(row.lifecycle_state)
          ? 'active'
          : 'inactive',
        provisioning_error: null,
        provisioning_slot_id: null,
        provisioning_updated_at: null,
      };
    }

    if (!provisioningSlot || !['reset_required', 'unavailable'].includes(provisioningSlot.state)) {
      return {
        provisioning_status: isRuntimeActiveLifecycleState(row.lifecycle_state)
          ? 'active'
          : 'inactive',
        provisioning_error: null,
        provisioning_slot_id: null,
        provisioning_updated_at: null,
      };
    }

    failure = await adminAdapter.queryOne<{
      error_code: string | null;
      created_at: number | null;
    }>(
      `SELECT error_code, created_at
         FROM tenant_database_slot_audit_events
        WHERE tenant_id = ?
          AND slot_id = ?
          AND result = 'failed'
        ORDER BY created_at DESC
        LIMIT 1`,
      [row.id, provisioningSlot.slot_id]
    );

    return {
      provisioning_status: 'provisioning_failed',
      provisioning_error: failure?.error_code ?? null,
      provisioning_slot_id: provisioningSlot.slot_id,
      provisioning_updated_at: failure?.created_at ?? provisioningSlot.updated_at ?? row.updated_at,
    };
  } catch {
    return null;
  }
}

function getAdminActorId(c: Context<{ Bindings: Env }>): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call
  const adminAuth = (c as any).get?.('adminAuth') as { adminId?: string } | null | undefined;
  return adminAuth?.adminId ?? 'admin-ui';
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
  const preset = TENANT_POLICY_PRESETS.find((p) => p.id === 'b2c-standard')!;
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
async function seedTenantDefaultSettings(c: Context<{ Bindings: Env }>, tenantId: string) {
  const env = c.env;
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

async function recordTenantSlotAudit(
  adapter: DatabaseAdapter,
  input: {
    tenantId?: string | null;
    slotId?: string | null;
    stage: string;
    actor: string;
    result: 'started' | 'succeeded' | 'failed' | 'skipped';
    errorCode?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<void> {
  await adapter
    .execute(
      `INSERT INTO tenant_database_slot_audit_events (
        id, tenant_id, slot_id, stage, actor, result, error_code, request_id, metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        input.tenantId ?? null,
        input.slotId ?? null,
        input.stage,
        input.actor,
        input.result,
        input.errorCode ?? null,
        input.requestId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        Math.floor(Date.now() / 1000),
      ]
    )
    .catch(() => {});
}

async function reserveTenantDatabaseSlot(
  adapter: DatabaseAdapter,
  tenantId: string,
  actor: string
): Promise<TenantDatabaseSlotRow | null> {
  const now = Math.floor(Date.now() / 1000);
  return adapter.transaction(async (tx) => {
    const slot = await tx.queryOne<TenantDatabaseSlotRow>(
      `SELECT * FROM tenant_database_slots
        WHERE state = 'available'
        ORDER BY slot_number ASC
        LIMIT 1`
    );
    if (!slot) {
      return null;
    }

    await tx.execute(
      `UPDATE tenant_database_slots
          SET state = 'reserved', assigned_tenant_id = ?, reserved_by = ?,
              reserved_at = ?, updated_at = ?
        WHERE slot_id = ? AND state = 'available'`,
      [tenantId, actor, now, now, slot.slot_id]
    );

    const reserved = await tx.queryOne<TenantDatabaseSlotRow>(
      'SELECT * FROM tenant_database_slots WHERE slot_id = ? AND state = ? AND assigned_tenant_id = ?',
      [slot.slot_id, 'reserved', tenantId]
    );
    if (!reserved) {
      return null;
    }
    return reserved;
  });
}

async function reserveTenantDatabaseSlotById(
  adapter: DatabaseAdapter,
  slotId: string,
  tenantId: string,
  actor: string
): Promise<{ slot: TenantDatabaseSlotRow | null; currentState: string | null }> {
  const now = Math.floor(Date.now() / 1000);
  return adapter.transaction(async (tx) => {
    const current = await tx.queryOne<TenantDatabaseSlotRow>(
      'SELECT * FROM tenant_database_slots WHERE slot_id = ?',
      [slotId]
    );
    if (!current) {
      return { slot: null, currentState: null };
    }
    if (current.state !== 'available') {
      return { slot: null, currentState: current.state };
    }

    await tx.execute(
      `UPDATE tenant_database_slots
          SET state = 'reserved', assigned_tenant_id = ?, reserved_by = ?,
              reserved_at = ?, updated_at = ?
        WHERE slot_id = ? AND state = 'available'`,
      [tenantId, actor, now, now, slotId]
    );

    const reserved = await tx.queryOne<TenantDatabaseSlotRow>(
      'SELECT * FROM tenant_database_slots WHERE slot_id = ? AND state = ? AND assigned_tenant_id = ?',
      [slotId, 'reserved', tenantId]
    );
    return { slot: reserved, currentState: reserved ? 'reserved' : current.state };
  });
}

async function releaseTenantDatabaseSlot(
  adapter: DatabaseAdapter,
  slotId: string,
  state: 'available' | 'reset_required'
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await adapter.execute(
    `UPDATE tenant_database_slots
        SET state = ?, reserved_by = NULL, reserved_at = NULL,
            assigned_tenant_id = CASE WHEN ? = 'available' THEN NULL ELSE assigned_tenant_id END,
            updated_at = ?
      WHERE slot_id = ?`,
    [state, state, now, slotId]
  );
}

async function activateTenantDatabaseSlot(
  adapter: DatabaseAdapter,
  slotId: string,
  tenantId: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await adapter.execute(
    `UPDATE tenant_database_slots
        SET state = 'assigned', assigned_tenant_id = ?, assigned_at = ?,
            reserved_by = NULL, reserved_at = NULL, updated_at = ?
      WHERE slot_id = ?`,
    [tenantId, now, now, slotId]
  );
}

async function cleanupTenantD1ProvisioningArtifacts(
  c: Context<{ Bindings: Env }>,
  adapter: DatabaseAdapter,
  tenantId: string
): Promise<void> {
  const deploymentTarget =
    (c.env as Env & { AUTHRIM_DEPLOYMENT_TARGET?: string }).AUTHRIM_DEPLOYMENT_TARGET ?? 'default';
  await Promise.allSettled([
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
}

async function provisionTenantDatabaseRegistry(
  c: Context<{ Bindings: Env }>,
  adapter: DatabaseAdapter,
  tenantId: string,
  slot: TenantDatabaseSlotRow,
  actor: string
): Promise<void> {
  const repository = new TenantDatabaseRegistryRepository(adapter);
  await repository.upsertRegistryRow({
    tenant_id: tenantId,
    role: 'tenant_core',
    generation: 1,
    provider: 'd1',
    database_id: slot.core_database_id,
    database_name: slot.core_database_name,
    binding_ref: slot.core_binding_ref,
    schema_version: 1,
    status: 'active',
    shard_count: 1,
    shard_key_strategy: 'none',
    worker_shard: 'primary',
    actor_id: actor,
    metadata_json: JSON.stringify({ slot_id: slot.slot_id, slot_number: slot.slot_number }),
  });
  await repository.upsertRegistryRow({
    tenant_id: tenantId,
    role: 'tenant_pii',
    generation: 1,
    provider: 'd1',
    database_id: slot.pii_database_id,
    database_name: slot.pii_database_name,
    binding_ref: slot.pii_binding_ref,
    schema_version: 1,
    status: 'active',
    shard_count: 1,
    shard_key_strategy: 'none',
    worker_shard: 'primary',
    actor_id: actor,
    metadata_json: JSON.stringify({ slot_id: slot.slot_id, slot_number: slot.slot_number }),
  });
  await repository.setActivePointer({
    tenant_id: tenantId,
    role: 'tenant_core',
    generation: 1,
    status: 'active',
    updated_by: actor,
  });
  await repository.setActivePointer({
    tenant_id: tenantId,
    role: 'tenant_pii',
    generation: 1,
    status: 'active',
    updated_by: actor,
  });

  await publishTenantRuntimeRegistrySnapshot({
    tenantId,
    storageProfileId: c.env.DEFAULT_STORAGE_PROFILE_ID ?? TENANT_D1_STORAGE_PROFILE_ID,
    repository,
    snapshotStore: c.env.TENANT_RUNTIME_REGISTRY,
    deploymentTarget: (c.env as Env & { AUTHRIM_DEPLOYMENT_TARGET?: string })
      .AUTHRIM_DEPLOYMENT_TARGET,
    actorId: actor,
    signingKey: c.env.TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK
      ? {
          privateJwk: c.env.TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK,
          keyId: c.env.TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID,
        }
      : null,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTenantCreateSmokeTest(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<void> {
  const deadline = Date.now() + TENANT_CREATE_SMOKE_TIMEOUT_MS;
  let attempt = 0;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      const tenantContext = createAuthContextFromHono(c, tenantId);
      const tenantAdapter = tenantContext.coreAdapter;
      const tenant = await tenantAdapter.queryOne<{ id: string }>(
        'SELECT id FROM tenants WHERE id = ?',
        [tenantId]
      );
      if (!tenant) {
        throw new Error('tenant_info_not_readable');
      }
      await c.env.SETTINGS?.get(`settings:tenant:${tenantId}:login-entry`);
      await c.env.SETTINGS?.get(`settings:tenant:${tenantId}:login-ui`);
      return;
    } catch (error) {
      lastError = error;
      const waitMs =
        TENANT_CREATE_SMOKE_BACKOFF_MS[
          Math.min(attempt, TENANT_CREATE_SMOKE_BACKOFF_MS.length - 1)
        ];
      attempt += 1;
      if (Date.now() + waitMs > deadline) {
        break;
      }
      await sleep(waitMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('tenant_create_smoke_test_failed');
}

async function upsertTenantRow(
  adapter: DatabaseAdapter,
  input: {
    id: string;
    tenantCode: string;
    name: string;
    description: string | null;
    lifecycleState: TenantLifecycleState;
    nowTs: number;
  }
): Promise<void> {
  const tenantKey = createOpaqueTenantKey();
  await adapter.execute(
    `INSERT INTO tenants (
       id, tenant_code, tenant_key, name, description, lifecycle_state, is_default,
       default_tenant_guard, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
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
      input.lifecycleState,
      getDefaultTenantGuard(false),
      input.nowTs,
      input.nowTs,
    ]
  );
}

async function runTenantD1PoolProvisioning(
  c: Context<{ Bindings: Env }>,
  adapter: DatabaseAdapter,
  adminAdapter: DatabaseAdapter,
  input: TenantD1ProvisioningInput,
  slot: TenantDatabaseSlotRow,
  actor: string,
  options: {
    failureStage: string;
    deleteTenantRowBeforeTenantDbWrite: boolean;
    deferActivation?: boolean;
  }
): Promise<TenantD1ProvisioningResult> {
  const nowTs = Math.floor(Date.now() / 1000);
  const contractKey = buildContractKey(c.env, 'tenant', input.id);
  let tenantDbWritten = false;

  try {
    await recordTenantSlotAudit(adminAdapter, {
      tenantId: input.id,
      slotId: slot.slot_id,
      stage: 'reservation',
      actor,
      result: 'succeeded',
    });

    await upsertTenantRow(adapter, {
      id: input.id,
      tenantCode: input.tenantCode,
      name: input.name,
      description: input.description,
      lifecycleState: 'provisioning',
      nowTs,
    });

    await recordTenantSlotAudit(adminAdapter, {
      tenantId: input.id,
      slotId: slot.slot_id,
      stage: 'registry',
      actor,
      result: 'started',
    });
    await provisionTenantDatabaseRegistry(c, adminAdapter, input.id, slot, actor);
    await recordTenantSlotAudit(adminAdapter, {
      tenantId: input.id,
      slotId: slot.slot_id,
      stage: 'snapshot',
      actor,
      result: 'succeeded',
    });

    const tenantAdapter = createAuthContextFromHono(c, input.id).coreAdapter;
    await upsertTenantRow(tenantAdapter, {
      id: input.id,
      tenantCode: input.tenantCode,
      name: input.name,
      description: input.description,
      lifecycleState: 'active',
      nowTs,
    });
    tenantDbWritten = true;

    await recordTenantSlotAudit(adminAdapter, {
      tenantId: input.id,
      slotId: slot.slot_id,
      stage: 'seed',
      actor,
      result: 'started',
    });
    await c.env.AUTHRIM_CONFIG!.put(
      contractKey,
      JSON.stringify(buildDefaultTenantContract(input.id))
    );
    await seedTenantDefaultSettings(c, input.id);
    await initTenantKeyManager(c.env.KEY_MANAGER, input.id);
    await recordTenantSlotAudit(adminAdapter, {
      tenantId: input.id,
      slotId: slot.slot_id,
      stage: 'seed',
      actor,
      result: 'succeeded',
    });

    await recordTenantSlotAudit(adminAdapter, {
      tenantId: input.id,
      slotId: slot.slot_id,
      stage: 'smoke',
      actor,
      result: 'started',
    });
    await runTenantCreateSmokeTest(c, input.id);
    await recordTenantSlotAudit(adminAdapter, {
      tenantId: input.id,
      slotId: slot.slot_id,
      stage: 'smoke',
      actor,
      result: 'succeeded',
    });

    if (!options.deferActivation) {
      await adapter.execute(
        "UPDATE tenants SET lifecycle_state = 'active', updated_at = ? WHERE id = ?",
        [nowTs, input.id]
      );
    }
    await activateTenantDatabaseSlot(adminAdapter, slot.slot_id, input.id);
    // Delete stale positive entries too: deferred tenants must be re-evaluated as provisioning.
    await invalidateTenantExistsCache(c.env.AUTHRIM_CONFIG, input.id);
    await recordTenantSlotAudit(adminAdapter, {
      tenantId: input.id,
      slotId: slot.slot_id,
      stage: 'activation',
      actor,
      result: options.deferActivation ? 'skipped' : 'succeeded',
      metadata: options.deferActivation ? { reason: 'deferred_for_tenant_clone' } : null,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Tenant D1 pool provisioning failed', { tenantId: input.id }, error as Error);
    await recordTenantSlotAudit(adminAdapter, {
      tenantId: input.id,
      slotId: slot.slot_id,
      stage: options.failureStage,
      actor,
      result: 'failed',
      errorCode: errorMessage,
    });
    await releaseTenantDatabaseSlot(
      adminAdapter,
      slot.slot_id,
      tenantDbWritten ? 'reset_required' : 'available'
    );
    if (tenantDbWritten || !options.deleteTenantRowBeforeTenantDbWrite) {
      await adapter.execute(
        "UPDATE tenants SET lifecycle_state = 'suspended', updated_at = ? WHERE id = ?",
        [Math.floor(Date.now() / 1000), input.id]
      );
    }
    await cleanupTenantD1ProvisioningArtifacts(c, adminAdapter, input.id);
    const cleanupTasks: Promise<unknown>[] = [
      ...(c.env.AUTHRIM_CONFIG
        ? [
            c.env.AUTHRIM_CONFIG.delete(contractKey),
            c.env.AUTHRIM_CONFIG.delete(`settings:tenant:${input.id}:tenant`),
            c.env.AUTHRIM_CONFIG.delete(`v1:tenant-exists:${input.id}`),
          ]
        : []),
      ...(c.env.SETTINGS
        ? [
            c.env.SETTINGS.delete(`settings:tenant:${input.id}:login-ui`),
            c.env.SETTINGS.delete(`settings:tenant:${input.id}:tenant-discovery-ui`),
            c.env.SETTINGS.delete(`settings:tenant:${input.id}:authentication-methods`),
            c.env.SETTINGS.delete(`settings:tenant:${input.id}:directory-connectors`),
            c.env.SETTINGS.delete(`settings:tenant:${input.id}:login-entry`),
          ]
        : []),
    ];
    if (!tenantDbWritten && options.deleteTenantRowBeforeTenantDbWrite) {
      cleanupTasks.unshift(adapter.execute('DELETE FROM tenants WHERE id = ?', [input.id]));
    }
    await Promise.allSettled(cleanupTasks);
    return { ok: false, response: await createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR) };
  }

  const tenant = await adapter.queryOne<TenantRow>(
    'SELECT id, tenant_code, name, description, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
    [input.id]
  );
  return { ok: true, tenant: tenant! };
}

/**
 * Provision a tenant through the same storage, contract, settings, and signing-key path used by
 * the public create endpoint. The caller owns authorization, request validation, and audit events.
 */
export async function provisionTenant(
  c: Context<{ Bindings: Env }>,
  input: TenantProvisionInput
): Promise<TenantProvisionResult> {
  const adapter = createAdapter(c);
  const existing = await adapter.queryOne<{ id: string }>('SELECT id FROM tenants WHERE id = ?', [
    input.id,
  ]);
  if (existing) {
    return {
      ok: false,
      response: await createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'id', reason: 'Tenant ID already exists' },
      }),
    };
  }

  const existingTenantCode = await adapter.queryOne<{ id: string }>(
    'SELECT id FROM tenants WHERE tenant_code = ?',
    [input.tenantCode]
  );
  if (existingTenantCode) {
    return {
      ok: false,
      response: await createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'tenant_code', reason: 'Tenant code already exists' },
      }),
    };
  }

  const nowTs = Math.floor(Date.now() / 1000);
  if (isTenantD1PoolMode(c.env)) {
    const actor = getAdminActorId(c);
    const adminAdapter = requireAdminDatabaseAdapter(c.env, 'tenant-d1-slot-create');
    const slot = await reserveTenantDatabaseSlot(adminAdapter, input.id, actor);
    if (!slot) {
      return {
        ok: false,
        response: c.json(
          {
            error: 'tenant_d1_slot_exhausted',
            message: 'No preallocated tenant D1 slots are available',
            current_capacity: await adminAdapter
              .queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM tenant_database_slots')
              .then((row) => row?.total ?? 0)
              .catch(() => 0),
            available_slots: 0,
            required_additional_slots: 1,
          },
          409
        ),
      };
    }

    const provisioning = await runTenantD1PoolProvisioning(
      c,
      adapter,
      adminAdapter,
      input,
      slot,
      actor,
      {
        failureStage: 'provisioning',
        deleteTenantRowBeforeTenantDbWrite: true,
        deferActivation: input.deferActivation,
      }
    );
    if (!provisioning.ok) return provisioning;

    return {
      ok: true,
      tenant: formatTenant(provisioning.tenant),
      provisioning: {
        mode: 'tenant-d1-preallocated-pool',
        slot_id: slot.slot_id,
        smoke_test: 'passed',
      },
    };
  }

  const tenantKey = createOpaqueTenantKey();
  await adapter.execute(
    `INSERT INTO tenants (
       id, tenant_code, tenant_key, name, description, lifecycle_state, is_default,
       default_tenant_guard, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      input.id,
      input.tenantCode,
      tenantKey,
      input.name,
      input.description,
      input.deferActivation ? 'provisioning' : 'active',
      getDefaultTenantGuard(false),
      nowTs,
      nowTs,
    ]
  );

  const contractKey = buildContractKey(c.env, 'tenant', input.id);
  try {
    await c.env.AUTHRIM_CONFIG!.put(
      contractKey,
      JSON.stringify(buildDefaultTenantContract(input.id))
    );
    await seedTenantDefaultSettings(c, input.id);
    await initTenantKeyManager(c.env.KEY_MANAGER, input.id);
    // Delete stale positive entries too: deferred tenants must be re-evaluated as provisioning.
    await invalidateTenantExistsCache(c.env.AUTHRIM_CONFIG, input.id);
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Tenant provisioning failed - rolling back', { tenantId: input.id }, error as Error);
    await Promise.allSettled([
      adapter.execute('DELETE FROM tenants WHERE id = ?', [input.id]),
      adapter.execute('DELETE FROM custom_claim_schemas WHERE tenant_id = ?', [input.id]),
      c.env.AUTHRIM_CONFIG?.delete(contractKey),
      c.env.AUTHRIM_CONFIG?.delete(`settings:tenant:${input.id}:tenant`),
      c.env.AUTHRIM_CONFIG?.delete(`v1:tenant-exists:${input.id}`),
      c.env.SETTINGS?.delete(`settings:tenant:${input.id}:login-ui`),
      c.env.SETTINGS?.delete(`settings:tenant:${input.id}:tenant-discovery-ui`),
      c.env.SETTINGS?.delete(`settings:tenant:${input.id}:authentication-methods`),
      c.env.SETTINGS?.delete(`settings:tenant:${input.id}:directory-connectors`),
      c.env.SETTINGS?.delete(`settings:tenant:${input.id}:login-entry`),
    ]);
    return { ok: false, response: await createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR) };
  }

  const created = await adapter.queryOne<TenantRow>(
    'SELECT id, tenant_code, name, description, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
    [input.id]
  );
  if (!created) {
    return { ok: false, response: await createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR) };
  }
  return { ok: true, tenant: formatTenant(created) };
}

/** Publish a fully prepared tenant only after every clone side effect and audit write succeeded. */
export async function activateProvisionedTenant(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<ReturnType<typeof formatTenant>> {
  const nowTs = Math.floor(Date.now() / 1000);
  const platformAdapter = createAdapter(c);
  const tenantAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;

  await tenantAdapter.execute(
    "UPDATE tenants SET lifecycle_state = 'active', updated_at = ? WHERE id = ? AND lifecycle_state = 'provisioning'",
    [nowTs, tenantId]
  );
  if (isTenantD1PoolMode(c.env)) {
    const adminAdapter = requireAdminDatabaseAdapter(c.env, 'tenant-clone-activation');
    const slot = await adminAdapter.queryOne<{ slot_id: string }>(
      'SELECT slot_id FROM tenant_database_slots WHERE assigned_tenant_id = ? LIMIT 1',
      [tenantId]
    );
    if (!slot) throw new Error('tenant_clone_slot_missing');
    await recordTenantSlotAudit(adminAdapter, {
      tenantId,
      slotId: slot.slot_id,
      stage: 'activation',
      actor: getAdminActorId(c),
      result: 'succeeded',
      metadata: { operation: 'tenant_clone' },
    });
  }
  await platformAdapter.execute(
    "UPDATE tenants SET lifecycle_state = 'active', updated_at = ? WHERE id = ? AND lifecycle_state = 'provisioning'",
    [nowTs, tenantId]
  );
  await invalidateTenantExistsCache(c.env.AUTHRIM_CONFIG, tenantId);

  const activated = await platformAdapter.queryOne<TenantRow>(
    'SELECT id, tenant_code, name, description, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
    [tenantId]
  );
  if (!activated || activated.lifecycle_state !== 'active') {
    throw new Error('tenant_clone_activation_failed');
  }
  return formatTenant(activated);
}

/** Ensure a retried clone never resumes issuance with a signing key from an earlier failed attempt. */
export async function rotateProvisionedTenantSigningKey(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<void> {
  const keyManager = c.env.KEY_MANAGER.get(c.env.KEY_MANAGER.idFromName(`${tenantId}-v3`));
  await keyManager.rotateKeysRpc();
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

export interface TenantRollbackResult {
  ok: boolean;
  failures: string[];
}

/** Compensate a failed clone and report every artifact that could not be removed. */
export async function rollbackProvisionedTenant(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<TenantRollbackResult> {
  const platformAdapter = createAdapter(c);
  const tenantAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
  const failures: string[] = [];
  const safeExecute = async (
    label: string,
    adapter: DatabaseAdapter,
    sql: string,
    params: unknown[]
  ): Promise<void> => {
    try {
      await adapter.execute(sql, params);
    } catch {
      failures.push(label);
    }
  };

  // Preserve child-before-parent order for adapters that enforce foreign keys.
  await safeExecute(
    'role_assignment_rules',
    tenantAdapter,
    'DELETE FROM role_assignment_rules WHERE tenant_id = ?',
    [tenantId]
  );
  await safeExecute(
    'role_assignments',
    tenantAdapter,
    'DELETE FROM role_assignments WHERE tenant_id = ?',
    [tenantId]
  );
  await safeExecute('user_roles', tenantAdapter, 'DELETE FROM user_roles WHERE tenant_id = ?', [
    tenantId,
  ]);
  await safeExecute('roles', tenantAdapter, 'DELETE FROM roles WHERE tenant_id = ?', [tenantId]);
  await safeExecute(
    'webhook_configs',
    tenantAdapter,
    'DELETE FROM webhook_configs WHERE tenant_id = ?',
    [tenantId]
  );
  await safeExecute(
    'client_consent_overrides',
    tenantAdapter,
    'DELETE FROM client_consent_overrides WHERE tenant_id = ?',
    [tenantId]
  );
  await safeExecute(
    'client_trust_policies',
    tenantAdapter,
    'DELETE FROM client_trust_policies WHERE tenant_id = ?',
    [tenantId]
  );
  await safeExecute(
    'web_origin_registry',
    tenantAdapter,
    'DELETE FROM web_origin_registry WHERE tenant_id = ?',
    [tenantId]
  );
  await safeExecute(
    'oauth_clients',
    tenantAdapter,
    'DELETE FROM oauth_clients WHERE tenant_id = ?',
    [tenantId]
  );
  await safeExecute(
    'custom_claim_schemas',
    tenantAdapter,
    'DELETE FROM custom_claim_schemas WHERE tenant_id = ?',
    [tenantId]
  );
  await safeExecute('tenant_database_row', tenantAdapter, 'DELETE FROM tenants WHERE id = ?', [
    tenantId,
  ]);
  await safeExecute('platform_tenant_row', platformAdapter, 'DELETE FROM tenants WHERE id = ?', [
    tenantId,
  ]);

  const cleanupTasks: Array<[string, Promise<unknown> | undefined]> = [
    ['tenant_settings', deleteKvPrefix(c.env.SETTINGS, `settings:tenant:${tenantId}:`)],
    ['client_settings', deleteKvPrefix(c.env.SETTINGS, `settings:client:${tenantId}:`)],
    [
      'client_contracts',
      deleteKvPrefix(
        c.env.AUTHRIM_CONFIG,
        `${c.env.ENVIRONMENT || 'dev'}:contract:client:${tenantId}:`
      ),
    ],
    ['tenant_contract', c.env.AUTHRIM_CONFIG?.delete(buildContractKey(c.env, 'tenant', tenantId))],
    [
      'tenant_identity_settings',
      c.env.AUTHRIM_CONFIG?.delete(`settings:tenant:${tenantId}:tenant`),
    ],
    ['tenant_exists_cache', c.env.AUTHRIM_CONFIG?.delete(`v1:tenant-exists:${tenantId}`)],
  ];
  const cleanupResults = await Promise.allSettled(cleanupTasks.map(([, task]) => task));
  cleanupResults.forEach((result, index) => {
    if (result.status === 'rejected') failures.push(cleanupTasks[index]![0]);
  });

  if (isTenantD1PoolMode(c.env)) {
    let adminAdapter: DatabaseAdapter | null = null;
    try {
      adminAdapter = requireAdminDatabaseAdapter(c.env, 'tenant-clone-rollback');
    } catch {
      failures.push('tenant_database_adapter');
    }
    if (adminAdapter) {
      let slot: { slot_id: string } | null = null;
      try {
        slot = await adminAdapter.queryOne<{ slot_id: string }>(
          'SELECT slot_id FROM tenant_database_slots WHERE assigned_tenant_id = ? LIMIT 1',
          [tenantId]
        );
      } catch {
        failures.push('tenant_database_slot_lookup');
      }
      if (slot) {
        try {
          await releaseTenantDatabaseSlot(adminAdapter, slot.slot_id, 'reset_required');
        } catch {
          failures.push('tenant_database_slot');
        }
      }
      try {
        await cleanupTenantD1ProvisioningArtifacts(c, adminAdapter, tenantId);
      } catch {
        failures.push('tenant_database_registry');
      }
    }
  }
  return { ok: failures.length === 0, failures };
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
      'SELECT id, tenant_code, name, description, lifecycle_state, is_default, created_at, updated_at FROM tenants',
      tenantFilters.length > 0 ? `WHERE ${tenantFilters.join(' AND ')}` : '',
      'ORDER BY is_default DESC, name ASC',
    ]
      .filter(Boolean)
      .join(' ');
    const rows = await adapter.query<TenantRow>(query, tenantParams);
    const tenantD1Pool = isTenantD1PoolMode(c.env)
      ? await requireAdminDatabaseAdapter(c.env, 'tenant-d1-slot-list')
          .query<{
            state: string;
            count: number;
          }>('SELECT state, COUNT(*) AS count FROM tenant_database_slots GROUP BY state')
          .then((slotRows) => {
            const counts = Object.fromEntries(slotRows.map((row) => [row.state, row.count]));
            return {
              enabled: true,
              capacity: slotRows.reduce((sum, row) => sum + Number(row.count), 0),
              available_slots: Number(counts.available ?? 0),
              reserved_slots: Number(counts.reserved ?? 0),
              assigned_slots: Number(counts.assigned ?? 0),
              pending_binding_slots: Number(counts.pending_binding ?? 0),
              unavailable_slots: Number(counts.unavailable ?? 0),
              reset_required_slots: Number(counts.reset_required ?? 0),
            };
          })
          .catch(() => ({ enabled: true, capacity: 0, available_slots: 0 }))
      : { enabled: false };

    const tenants = await Promise.all(
      rows.map(async (row) =>
        formatTenantWithProvisioning(row, await getTenantProvisioningMetadata(c.env, row))
      )
    );

    return c.json({
      tenants,
      total: rows.length,
      tenant_d1_pool: tenantD1Pool,
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

    const { id, name, description } = parseResult.data;
    const tenantCode = parseResult.data.tenant_code || id;
    const provisioned = await provisionTenant(c, {
      id,
      tenantCode,
      name,
      description: description ?? null,
    });
    if (!provisioned.ok) return provisioned.response;

    await createAuditLogFromContext(c, 'tenant.created', 'tenant', id, {
      name,
      tenant_code: tenantCode,
      description: description ?? null,
      ...(provisioned.provisioning ? { tenant_d1_slot_id: provisioned.provisioning.slot_id } : {}),
    });

    return c.json(
      {
        ...provisioned.tenant,
        ...(provisioned.provisioning ? { provisioning: provisioned.provisioning } : {}),
      },
      201
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to create tenant', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
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

  const id = c.req.param('id')!;
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  try {
    const adapter = createAdapter(c);
    const tenant = await adapter.queryOne<TenantRow>(
      'SELECT id, tenant_code, name, description, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    if (!tenant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    return c.json(
      formatTenantWithProvisioning(tenant, await getTenantProvisioningMetadata(c.env, tenant))
    );
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

  const id = c.req.param('id')!;
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
      'SELECT id, tenant_code, name, description, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
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
      'SELECT id, tenant_code, name, description, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    await createAuditLogFromContext(c, 'tenant.updated', 'tenant', id, {
      changes: updates,
    });

    return c.json(formatTenant(updated!));
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

  const id = c.req.param('id')!;
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
        progress: existingJob.progress ? JSON.parse(existingJob.progress) : null,
      },
      existingJob.status === 'completed' ? 200 : 202
    );
  }

  const tenant = await adapter.queryOne<TenantRow>(
    'SELECT id, tenant_code, name, description, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
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

  await invalidateTenantExistsCache(c.env.AUTHRIM_CONFIG, id);
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
  const id = c.req.param('id')!;
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
      progress: job.progress ? JSON.parse(job.progress) : null,
      result: job.result ? JSON.parse(job.result) : null,
      config: job.config ? JSON.parse(job.config) : null,
    })),
  });
}

export async function adminTenantLifecycleJobRetryHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) return platformError;
  const id = c.req.param('id')!;
  const jobId = c.req.param('jobId')!;
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
 * Retry a failed tenant D1 provisioning draft after the slot has been reset.
 */
export async function adminTenantProvisioningRetryHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) {
    return platformError;
  }

  const id = c.req.param('id')!;
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  if (!isTenantD1PoolMode(c.env)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'tenant',
        reason: 'Tenant D1 provisioning retry is only available in tenant-d1 pool mode',
      },
    });
  }

  try {
    const adapter = createAdapter(c);
    const tenant = await adapter.queryOne<TenantRow>(
      'SELECT id, tenant_code, name, description, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    if (!tenant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    const metadata = await getTenantProvisioningMetadata(c.env, tenant);
    if (metadata?.provisioning_status !== 'provisioning_failed' || !metadata.provisioning_slot_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'tenant',
          reason: 'Tenant is not in provisioning_failed state',
        },
      });
    }

    const actor = getAdminActorId(c);
    const adminAdapter = requireAdminDatabaseAdapter(c.env, 'tenant-d1-provisioning-retry');
    const reservation = await reserveTenantDatabaseSlotById(
      adminAdapter,
      metadata.provisioning_slot_id,
      id,
      actor
    );

    if (!reservation.slot) {
      const requiresReset =
        reservation.currentState === 'reset_required' || reservation.currentState === 'unavailable';
      await recordTenantSlotAudit(adminAdapter, {
        tenantId: id,
        slotId: metadata.provisioning_slot_id,
        stage: 'retry',
        actor,
        result: 'skipped',
        errorCode: requiresReset ? 'tenant_d1_slot_reset_required' : 'tenant_d1_slot_unavailable',
        metadata: { current_state: reservation.currentState },
      });
      return c.json(
        {
          error: requiresReset ? 'tenant_d1_slot_reset_required' : 'tenant_d1_slot_unavailable',
          message: requiresReset
            ? 'Reset, migrate, and verify the tenant D1 slot from the setup tool before retrying.'
            : 'The failed tenant D1 slot is not available for retry.',
          tenant_id: id,
          slot_id: metadata.provisioning_slot_id,
          current_state: reservation.currentState,
        },
        409
      );
    }

    await recordTenantSlotAudit(adminAdapter, {
      tenantId: id,
      slotId: reservation.slot.slot_id,
      stage: 'retry',
      actor,
      result: 'started',
    });

    const provisioning = await runTenantD1PoolProvisioning(
      c,
      adapter,
      adminAdapter,
      {
        id,
        tenantCode: tenant.tenant_code,
        name: tenant.name,
        description: tenant.description,
      },
      reservation.slot,
      actor,
      {
        failureStage: 'retry',
        deleteTenantRowBeforeTenantDbWrite: false,
      }
    );
    if (!provisioning.ok) {
      return provisioning.response;
    }

    await recordTenantSlotAudit(adminAdapter, {
      tenantId: id,
      slotId: reservation.slot.slot_id,
      stage: 'retry',
      actor,
      result: 'succeeded',
    });
    await createAuditLogFromContext(c, 'tenant.provisioning_retry.succeeded', 'tenant', id, {
      tenant_d1_slot_id: reservation.slot.slot_id,
    });

    return c.json({
      ...formatTenant(provisioning.tenant),
      provisioning: {
        mode: 'tenant-d1-preallocated-pool',
        slot_id: reservation.slot.slot_id,
        smoke_test: 'passed',
        retry: 'succeeded',
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
 * Remove a failed tenant draft while keeping the contaminated slot in reset_required.
 */
export async function adminTenantProvisioningCleanupHandler(c: Context<{ Bindings: Env }>) {
  const platformError = await requirePlatformTenantManagementAuthority(c);
  if (platformError) {
    return platformError;
  }

  const id = c.req.param('id')!;
  const blocked = await ensureSupportedTenantId(c, id);
  if (blocked) {
    return blocked;
  }

  if (!isTenantD1PoolMode(c.env)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'tenant',
        reason: 'Tenant D1 provisioning cleanup is only available in tenant-d1 pool mode',
      },
    });
  }

  try {
    const adapter = createAdapter(c);
    const tenant = await adapter.queryOne<TenantRow>(
      'SELECT id, tenant_code, name, description, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    if (!tenant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    const metadata = await getTenantProvisioningMetadata(c.env, tenant);
    if (metadata?.provisioning_status !== 'provisioning_failed') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'tenant',
          reason: 'Tenant is not in provisioning_failed state',
        },
      });
    }

    const actor = getAdminActorId(c);
    const adminAdapter = requireAdminDatabaseAdapter(c.env, 'tenant-d1-provisioning-cleanup');
    await cleanupTenantD1ProvisioningArtifacts(c, adminAdapter, id);
    await Promise.allSettled([
      adapter.execute(
        "UPDATE tenants SET lifecycle_state = 'deleted', updated_at = ? WHERE id = ?",
        [Math.floor(Date.now() / 1000), id]
      ),
      c.env.AUTHRIM_CONFIG?.delete(buildContractKey(c.env, 'tenant', id)),
      c.env.AUTHRIM_CONFIG?.delete(`settings:tenant:${id}:tenant`),
      c.env.AUTHRIM_CONFIG?.delete(`v1:tenant-exists:${id}`),
      c.env.SETTINGS?.delete(`settings:tenant:${id}:login-ui`),
      c.env.SETTINGS?.delete(`settings:tenant:${id}:tenant-discovery-ui`),
      c.env.SETTINGS?.delete(`settings:tenant:${id}:authentication-methods`),
      c.env.SETTINGS?.delete(`settings:tenant:${id}:directory-connectors`),
      c.env.SETTINGS?.delete(`settings:tenant:${id}:login-entry`),
    ]);
    await recordTenantSlotAudit(adminAdapter, {
      tenantId: id,
      slotId: metadata.provisioning_slot_id,
      stage: 'cleanup',
      actor,
      result: 'succeeded',
      metadata: { action: 'delete_failed_tenant_draft' },
    });

    return c.json({
      status: 'cleaned',
      tenant_id: id,
      slot_id: metadata.provisioning_slot_id,
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

  const id = c.req.param('id')!;
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
    await invalidateTenantExistsCache(c.env.AUTHRIM_CONFIG, id);

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

  const id = c.req.param('id')!;
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
      'SELECT id, tenant_code, name, description, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?',
      [id]
    );

    await createAuditLogFromContext(c, 'tenant.set_default', 'tenant', id, { tenant_id: id });

    return c.json(formatTenant(updated!));
  } catch (error) {
    const log = getLogger(c).module('ADMIN-TENANTS');
    log.error('Failed to set default tenant', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
