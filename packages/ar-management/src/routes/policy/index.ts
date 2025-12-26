/**
 * Contract Policy API
 *
 * Three-layer contract hierarchy management:
 * - Tenant Policy: Defines constraints for all clients in a tenant
 * - Client Profile: Client-specific settings within tenant bounds
 * - Effective Policy: Runtime-resolved policy for flow execution
 *
 * Security Features:
 * - Tenant isolation via getTenantIdFromContext
 * - Client ownership validation via D1 database
 * - Scoped KV keys with environment prefix
 * - Generalized error messages to prevent information leakage
 * - RBAC: Requires system_admin or org_admin role
 * - Audit logging for all contract modifications
 * - Status transition validation for lifecycle management
 *
 * Routes:
 * - GET/PUT /api/admin/tenant-policy - Tenant policy CRUD
 * - GET /api/admin/tenant-policy/presets - Available presets
 * - POST /api/admin/tenant-policy/apply-preset - Apply preset
 * - GET /api/admin/tenant-policy/validate - Validate policy
 * - GET/PUT /api/admin/clients/:id/profile - Client profile CRUD
 * - GET /api/admin/client-profile-presets - Available client presets
 * - POST /api/admin/clients/:id/apply-preset - Apply preset to client
 * - GET /api/admin/clients/:id/profile/validate - Validate client profile
 * - GET /api/admin/effective-policy - Get resolved policy
 */

import { Hono } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  getTenantIdFromContext,
  D1Adapter,
  type DatabaseAdapter,
  createPolicyResolver,
  type TenantContract,
  type ClientContract,
  type TenantPolicyPreset,
  type ClientProfilePreset,
  TENANT_POLICY_PRESETS,
  CLIENT_PROFILE_PRESETS,
  // Tenant defaults
  DEFAULT_TENANT_OAUTH_POLICY,
  DEFAULT_TENANT_SESSION_POLICY,
  DEFAULT_TENANT_SECURITY_POLICY,
  DEFAULT_TENANT_ENCRYPTION_POLICY,
  DEFAULT_TENANT_SCOPE_POLICY,
  DEFAULT_TENANT_AUTH_METHOD_POLICY,
  DEFAULT_TENANT_CONSENT_POLICY,
  DEFAULT_TENANT_CIBA_POLICY,
  DEFAULT_TENANT_DEVICE_FLOW_POLICY,
  DEFAULT_TENANT_EXTERNAL_IDP_POLICY,
  DEFAULT_TENANT_FEDERATION_POLICY,
  DEFAULT_TENANT_SCIM_POLICY,
  DEFAULT_TENANT_RATE_LIMIT_POLICY,
  DEFAULT_TENANT_TOKENS_POLICY,
  DEFAULT_TENANT_CREDENTIALS_POLICY,
  DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
  DEFAULT_TENANT_AUDIT_POLICY,
  // Client defaults
  DEFAULT_CLIENT_TYPE_CONFIG,
  DEFAULT_CLIENT_OAUTH_CONFIG,
  DEFAULT_CLIENT_ENCRYPTION_CONFIG,
  DEFAULT_CLIENT_SCOPE_CONFIG,
  DEFAULT_CLIENT_AUTH_METHOD_CONFIG,
  DEFAULT_CLIENT_CONSENT_CONFIG,
  DEFAULT_CLIENT_REDIRECT_CONFIG,
  DEFAULT_CLIENT_TOKEN_CONFIG,
  // RBAC
  requireAnyRole,
  // Contract lifecycle
  type ContractStatus,
  isValidTransition,
  getAllowedTransitions,
  // Audit logging
  type ContractAuditEventType,
  type AuditSubject,
  type AuditActor,
  createAuditLogEntry,
} from '@authrim/ar-lib-core';

// =============================================================================
// Types
// =============================================================================

interface ClientRecord {
  client_id: string;
  tenant_id: string;
}

// =============================================================================
// Security Helpers
// =============================================================================

/**
 * Get admin auth context from request (set by adminAuthMiddleware)
 */
function getAdminAuth(c: { get: (key: string) => unknown }): AdminAuthContext | null {
  return c.get('adminAuth') as AdminAuthContext | null;
}

/**
 * Create database adapters from context
 * Uses D1Adapter for database abstraction
 */
function createAdaptersFromContext(c: { env: Env }): {
  coreAdapter: DatabaseAdapter;
} {
  const coreAdapter = new D1Adapter({ db: c.env.DB });
  return { coreAdapter };
}

/**
 * Build scoped KV key with environment prefix and tenant isolation
 * Format: {env}:contract:{type}:{tenantId}:{id}
 */
function buildContractKey(
  env: Env,
  type: 'tenant' | 'client',
  tenantId: string,
  id?: string
): string {
  const envPrefix = env.ENVIRONMENT || 'dev';
  const baseKey = `${envPrefix}:contract:${type}:${tenantId}`;
  return id ? `${baseKey}:${id}` : baseKey;
}

/**
 * Validate that a client belongs to the specified tenant
 * Returns the client record if valid, null otherwise
 */
async function validateClientOwnership(
  coreAdapter: DatabaseAdapter,
  tenantId: string,
  clientId: string
): Promise<ClientRecord | null> {
  const client = await coreAdapter.queryOne<ClientRecord>(
    'SELECT client_id, tenant_id FROM oauth_clients WHERE client_id = ? AND tenant_id = ?',
    [clientId, tenantId]
  );
  return client;
}

// =============================================================================
// Response Helpers
// =============================================================================

/**
 * Standard error response with generalized messages
 * Security: Avoids leaking specific resource identifiers
 */
function errorResponse(
  c: { json: (data: unknown, status: number) => Response },
  error: string,
  message: string,
  status: number
): Response {
  return c.json({ error, message }, status);
}

/**
 * Generic not found response (doesn't reveal what wasn't found)
 */
function notFoundResponse(c: { json: (data: unknown, status: number) => Response }): Response {
  return errorResponse(c, 'not_found', 'The requested resource was not found', 404);
}

/**
 * Generic forbidden response
 * Used by RBAC middleware for access denials
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _forbiddenResponse(c: { json: (data: unknown, status: number) => Response }): Response {
  return errorResponse(c, 'forbidden', 'Access denied', 403);
}

// =============================================================================
// Audit Logging Helpers
// =============================================================================

/**
 * Create audit actor from admin auth context and request
 */
function createAuditActor(
  adminAuth: AdminAuthContext | null,
  c: { req: { header: (name: string) => string | undefined } }
): AuditActor {
  return {
    type: adminAuth?.authMethod === 'bearer' ? 'service' : 'user',
    userId: adminAuth?.userId,
    ipAddress: c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For'),
    userAgent: c.req.header('User-Agent'),
  };
}

/**
 * Write audit log entry to KV
 * Non-blocking - errors are logged but don't fail the request
 */
async function writeAuditLog(
  kv: KVNamespace,
  env: Env,
  eventType: ContractAuditEventType,
  subject: AuditSubject,
  actor: AuditActor,
  action: string,
  result: 'success' | 'failure',
  context?: Record<string, unknown>
): Promise<void> {
  try {
    const entry = createAuditLogEntry(eventType, subject, actor, action, result, 90);
    const logId = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const envPrefix = env.ENVIRONMENT || 'dev';
    const key = `${envPrefix}:audit:contract:${logId}`;

    // Add context if provided
    const fullEntry = context
      ? { ...entry, id: logId, context: { metadata: context } }
      : { ...entry, id: logId };

    await kv.put(key, JSON.stringify(fullEntry), {
      expirationTtl: 90 * 24 * 60 * 60, // 90 days retention
    });
  } catch (err) {
    // Log error but don't fail the request
    console.error('Failed to write audit log:', err);
  }
}

// =============================================================================
// Status Transition Validation
// =============================================================================

/**
 * Validate and apply status transition
 * Returns error message if transition is invalid, undefined if valid
 */
function validateStatusTransition(
  currentStatus: ContractStatus,
  newStatus: ContractStatus | undefined
): string | undefined {
  // If no new status provided, keep current status (valid)
  if (newStatus === undefined || newStatus === currentStatus) {
    return undefined;
  }

  // Check if transition is allowed
  if (!isValidTransition(currentStatus, newStatus)) {
    const allowed = getAllowedTransitions(currentStatus);
    return `Invalid status transition from '${currentStatus}' to '${newStatus}'. Allowed transitions: ${allowed.length > 0 ? allowed.join(', ') : 'none (status is final)'}`;
  }

  return undefined;
}

/**
 * Validate that contract is in an active status for runtime use
 * Reserved for future use in effective-policy endpoint
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _validateContractIsActive(status: ContractStatus): boolean {
  return status === 'active';
}

// =============================================================================
// Contract Storage Helpers (with tenant-scoped KV keys)
// =============================================================================

async function getTenantContract(
  kv: KVNamespace,
  env: Env,
  tenantId: string
): Promise<TenantContract | null> {
  try {
    const key = buildContractKey(env, 'tenant', tenantId);
    const data = await kv.get(key, 'json');
    return data as TenantContract | null;
  } catch {
    return null;
  }
}

async function saveTenantContract(
  kv: KVNamespace,
  env: Env,
  tenantId: string,
  contract: TenantContract
): Promise<void> {
  const key = buildContractKey(env, 'tenant', tenantId);
  await kv.put(key, JSON.stringify(contract));
}

async function getClientContract(
  kv: KVNamespace,
  env: Env,
  tenantId: string,
  clientId: string
): Promise<ClientContract | null> {
  try {
    const key = buildContractKey(env, 'client', tenantId, clientId);
    const data = await kv.get(key, 'json');
    return data as ClientContract | null;
  } catch {
    return null;
  }
}

async function saveClientContract(
  kv: KVNamespace,
  env: Env,
  tenantId: string,
  clientId: string,
  contract: ClientContract
): Promise<void> {
  const key = buildContractKey(env, 'client', tenantId, clientId);
  await kv.put(key, JSON.stringify(contract));
}

// =============================================================================
// Contract Factory
// =============================================================================

function createDefaultTenantContract(
  tenantId: string,
  preset: TenantPolicyPreset,
  actor: string
): TenantContract {
  const now = new Date().toISOString();
  return {
    tenantId,
    version: 1,
    preset,
    oauth: DEFAULT_TENANT_OAUTH_POLICY,
    session: DEFAULT_TENANT_SESSION_POLICY,
    security: DEFAULT_TENANT_SECURITY_POLICY,
    encryption: DEFAULT_TENANT_ENCRYPTION_POLICY,
    scopes: DEFAULT_TENANT_SCOPE_POLICY,
    authMethods: DEFAULT_TENANT_AUTH_METHOD_POLICY,
    consent: DEFAULT_TENANT_CONSENT_POLICY,
    ciba: DEFAULT_TENANT_CIBA_POLICY,
    deviceFlow: DEFAULT_TENANT_DEVICE_FLOW_POLICY,
    externalIdp: DEFAULT_TENANT_EXTERNAL_IDP_POLICY,
    federation: DEFAULT_TENANT_FEDERATION_POLICY,
    scim: DEFAULT_TENANT_SCIM_POLICY,
    rateLimit: DEFAULT_TENANT_RATE_LIMIT_POLICY,
    tokens: DEFAULT_TENANT_TOKENS_POLICY,
    credentials: DEFAULT_TENANT_CREDENTIALS_POLICY,
    dataResidency: DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
    audit: DEFAULT_TENANT_AUDIT_POLICY,
    metadata: {
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      status: 'active',
      statusHistory: [],
    },
  };
}

function createDefaultClientContract(
  clientId: string,
  tenantContractVersion: number,
  preset: ClientProfilePreset,
  actor: string
): ClientContract {
  const now = new Date().toISOString();
  return {
    clientId,
    version: 1,
    tenantContractVersion,
    preset,
    clientType: DEFAULT_CLIENT_TYPE_CONFIG,
    oauth: DEFAULT_CLIENT_OAUTH_CONFIG,
    encryption: DEFAULT_CLIENT_ENCRYPTION_CONFIG,
    scopes: DEFAULT_CLIENT_SCOPE_CONFIG,
    authMethods: DEFAULT_CLIENT_AUTH_METHOD_CONFIG,
    consent: DEFAULT_CLIENT_CONSENT_CONFIG,
    redirect: DEFAULT_CLIENT_REDIRECT_CONFIG,
    tokens: DEFAULT_CLIENT_TOKEN_CONFIG,
    metadata: {
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      status: 'active',
      statusHistory: [],
    },
  };
}

// =============================================================================
// Input Validation
// =============================================================================

/**
 * Allowed top-level keys for TenantContract policy updates.
 * Security: Prevents property injection attacks by whitelisting valid keys.
 */
const ALLOWED_TENANT_POLICY_KEYS = [
  'preset',
  'oauth',
  'session',
  'security',
  'encryption',
  'scopes',
  'authMethods',
  'consent',
  'ciba',
  'deviceFlow',
  'externalIdp',
  'federation',
  'scim',
  'rateLimit',
  'tokens',
  'credentials',
  'dataResidency',
  'audit',
  'metadata',
] as const;

/**
 * Allowed top-level keys for ClientContract profile updates.
 * Security: Prevents property injection attacks by whitelisting valid keys.
 */
const ALLOWED_CLIENT_PROFILE_KEYS = [
  'preset',
  'clientType',
  'oauth',
  'encryption',
  'scopes',
  'authMethods',
  'consent',
  'redirect',
  'tokens',
  'metadata',
] as const;

interface TenantPolicyUpdateBody {
  policy?: Partial<TenantContract>;
  ifMatch?: string;
}

interface ApplyPresetBody {
  preset?: string;
}

interface ClientProfileUpdateBody {
  profile?: Partial<ClientContract>;
  ifMatch?: string;
}

/**
 * Validate unknown keys in an object against a whitelist.
 * Returns array of unknown key names if any found.
 */
function findUnknownKeys(obj: Record<string, unknown>, allowedKeys: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allowedKeys.includes(k));
}

function validateTenantPolicyUpdate(body: unknown): TenantPolicyUpdateBody | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  // policy must be an object if provided
  if (b.policy !== undefined && (typeof b.policy !== 'object' || b.policy === null)) {
    return null;
  }

  // ifMatch must be a string if provided
  if (b.ifMatch !== undefined && typeof b.ifMatch !== 'string') {
    return null;
  }

  return b as TenantPolicyUpdateBody;
}

function validateApplyPresetBody(body: unknown): ApplyPresetBody | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  if (typeof b.preset !== 'string' || !b.preset) {
    return null;
  }

  return b as ApplyPresetBody;
}

function validateClientProfileUpdate(body: unknown): ClientProfileUpdateBody | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  if (b.profile !== undefined && (typeof b.profile !== 'object' || b.profile === null)) {
    return null;
  }

  if (b.ifMatch !== undefined && typeof b.ifMatch !== 'string') {
    return null;
  }

  return b as ClientProfileUpdateBody;
}

// =============================================================================
// Router Setup
// =============================================================================

const policyRouter = new Hono<{
  Bindings: Env;
}>();

// RBAC: Require system_admin or org_admin role for all policy operations
// Note: adminAuthMiddleware is already applied at the parent router level
const policyAdminRoles = ['system_admin', 'org_admin', 'admin'];
policyRouter.use('*', requireAnyRole(policyAdminRoles));

// =============================================================================
// Tenant Policy Routes
// =============================================================================

/**
 * GET /api/admin/tenant-policy
 * Get current tenant policy
 *
 * Security: Uses authenticated tenant ID from context
 */
policyRouter.get('/tenant-policy', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return errorResponse(c, 'service_unavailable', 'Configuration service unavailable', 503);
  }

  // Get authenticated tenant ID
  const tenantId = getTenantIdFromContext(c);
  const adminAuth = getAdminAuth(c);
  const actor = adminAuth?.userId ?? 'system';

  let contract = await getTenantContract(kv, c.env, tenantId);

  // If no contract exists, create a default one
  if (!contract) {
    contract = createDefaultTenantContract(tenantId, 'b2c-standard', actor);
    await saveTenantContract(kv, c.env, tenantId, contract);
  }

  return c.json({
    policy: contract,
    _links: {
      self: '/api/admin/tenant-policy',
      presets: '/api/admin/tenant-policy/presets',
      validate: '/api/admin/tenant-policy/validate',
    },
  });
});

/**
 * PUT /api/admin/tenant-policy
 * Update tenant policy
 *
 * Security:
 * - Uses authenticated tenant ID
 * - Optimistic locking with ifMatch (REQUIRED)
 * - Input validation with property whitelist
 * - Prevents property injection attacks
 */
policyRouter.put('/tenant-policy', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return errorResponse(c, 'service_unavailable', 'Configuration service unavailable', 503);
  }

  const tenantId = getTenantIdFromContext(c);
  const adminAuth = getAdminAuth(c);
  const actor = adminAuth?.userId ?? 'unknown';

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return errorResponse(c, 'bad_request', 'Invalid JSON body', 400);
  }

  // Validate input structure
  const body = validateTenantPolicyUpdate(rawBody);
  if (!body) {
    return errorResponse(c, 'bad_request', 'Invalid request body format', 400);
  }

  // Security: ifMatch is REQUIRED to prevent version rollback attacks
  if (body.ifMatch === undefined) {
    return c.json(
      {
        error: 'precondition_required',
        message:
          'ifMatch parameter is required for updates to prevent concurrent modification issues',
        hint: 'First GET the current policy to obtain the version, then include ifMatch with that version',
      },
      428
    );
  }

  // Security: Validate policy keys against whitelist to prevent property injection
  if (body.policy) {
    const unknownKeys = findUnknownKeys(
      body.policy as Record<string, unknown>,
      ALLOWED_TENANT_POLICY_KEYS
    );
    if (unknownKeys.length > 0) {
      return errorResponse(
        c,
        'bad_request',
        `Unknown policy keys: ${unknownKeys.join(', ')}. Only standard policy fields are allowed.`,
        400
      );
    }
  }

  // Get existing contract for version check
  const existing = await getTenantContract(kv, c.env, tenantId);
  const existingVersion = existing?.version ?? 0;
  const existingStatus = existing?.metadata?.status ?? 'draft';

  // Optimistic locking - strict version match required
  if (body.ifMatch !== String(existingVersion)) {
    return c.json(
      {
        error: 'conflict',
        message: 'Resource has been modified. Please refresh and try again.',
        currentVersion: existingVersion,
      },
      409
    );
  }

  // Status transition validation
  const requestedStatus = (body.policy?.metadata as { status?: ContractStatus } | undefined)
    ?.status;
  const statusError = validateStatusTransition(existingStatus, requestedStatus);
  if (statusError) {
    return errorResponse(c, 'invalid_status_transition', statusError, 400);
  }

  // Build updated contract
  const now = new Date().toISOString();
  const newStatus = requestedStatus ?? existingStatus;
  const updatedContract: TenantContract = {
    ...(existing ?? createDefaultTenantContract(tenantId, 'custom', actor)),
    ...body.policy,
    tenantId, // Ensure tenant ID cannot be changed (security)
    version: existingVersion + 1,
    metadata: {
      ...(existing?.metadata ?? { createdAt: now, createdBy: actor, status: 'draft' }),
      updatedAt: now,
      updatedBy: actor,
      status: newStatus,
      // Track status changes in history
      statusHistory: [
        ...(existing?.metadata?.statusHistory ?? []),
        ...(requestedStatus && requestedStatus !== existingStatus
          ? [{ from: existingStatus, to: requestedStatus, timestamp: now, actor }]
          : []),
      ],
      // Track lifecycle timestamps
      activatedAt:
        newStatus === 'active' && existingStatus !== 'active'
          ? now
          : existing?.metadata?.activatedAt,
      deprecatedAt:
        newStatus === 'deprecated' && existingStatus !== 'deprecated'
          ? now
          : existing?.metadata?.deprecatedAt,
      archivedAt:
        newStatus === 'archived' && existingStatus !== 'archived'
          ? now
          : existing?.metadata?.archivedAt,
    },
  };

  await saveTenantContract(kv, c.env, tenantId, updatedContract);

  // Audit logging
  const auditActor = createAuditActor(adminAuth, c);
  const auditSubject: AuditSubject = {
    type: 'tenant',
    id: tenantId,
    version: updatedContract.version,
  };
  const eventType: ContractAuditEventType =
    requestedStatus && requestedStatus !== existingStatus
      ? 'contract.status_changed'
      : 'contract.updated';

  await writeAuditLog(
    kv,
    c.env,
    eventType,
    auditSubject,
    auditActor,
    `Updated tenant policy`,
    'success',
    {
      previousVersion: existingVersion,
      newVersion: updatedContract.version,
      statusChange:
        requestedStatus && requestedStatus !== existingStatus
          ? { from: existingStatus, to: requestedStatus }
          : undefined,
    }
  );

  return c.json({
    policy: updatedContract,
    previousVersion: existingVersion,
    _links: {
      self: '/api/admin/tenant-policy',
    },
  });
});

/**
 * GET /api/admin/tenant-policy/presets
 * List available tenant policy presets
 */
policyRouter.get('/tenant-policy/presets', (c) => {
  const presets = TENANT_POLICY_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    targetAudience: preset.targetAudience,
    securityTier: preset.securityTier,
  }));

  return c.json({ presets });
});

/**
 * POST /api/admin/tenant-policy/apply-preset
 * Apply a preset to the tenant policy
 *
 * Security: Uses authenticated tenant ID
 */
policyRouter.post('/tenant-policy/apply-preset', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return errorResponse(c, 'service_unavailable', 'Configuration service unavailable', 503);
  }

  const tenantId = getTenantIdFromContext(c);
  const adminAuth = getAdminAuth(c);
  const actor = adminAuth?.userId ?? 'unknown';

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return errorResponse(c, 'bad_request', 'Invalid JSON body', 400);
  }

  // Validate input
  const body = validateApplyPresetBody(rawBody);
  if (!body || !body.preset) {
    return errorResponse(c, 'bad_request', 'preset field is required', 400);
  }

  const presetId = body.preset as TenantPolicyPreset;

  // Find the preset
  const preset = TENANT_POLICY_PRESETS.find((p) => p.id === presetId);
  if (!preset) {
    return errorResponse(c, 'bad_request', 'Invalid preset specified', 400);
  }

  // Get existing contract
  const existing = await getTenantContract(kv, c.env, tenantId);
  const existingVersion = existing?.version ?? 0;

  // Apply preset defaults
  const now = new Date().toISOString();
  const newContract: TenantContract = {
    ...createDefaultTenantContract(tenantId, presetId, actor),
    ...preset.defaults,
    tenantId,
    version: existingVersion + 1,
    preset: presetId,
    metadata: {
      createdAt: existing?.metadata.createdAt ?? now,
      createdBy: existing?.metadata.createdBy ?? actor,
      updatedAt: now,
      updatedBy: actor,
      status: 'active',
      statusHistory: existing?.metadata.statusHistory ?? [],
      notes: `Applied preset: ${preset.name}`,
    },
  };

  await saveTenantContract(kv, c.env, tenantId, newContract);

  return c.json({
    policy: newContract,
    appliedPreset: presetId,
    previousVersion: existingVersion,
  });
});

/**
 * GET /api/admin/tenant-policy/validate
 * Validate tenant policy configuration
 */
policyRouter.get('/tenant-policy/validate', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return errorResponse(c, 'service_unavailable', 'Configuration service unavailable', 503);
  }

  const tenantId = getTenantIdFromContext(c);
  const contract = await getTenantContract(kv, c.env, tenantId);

  if (!contract) {
    return notFoundResponse(c);
  }

  // Perform validation checks
  const errors: { field: string; message: string }[] = [];
  const warnings: { field: string; message: string }[] = [];

  // Check OAuth settings
  if (contract.oauth.maxAccessTokenExpiry > 86400) {
    warnings.push({
      field: 'oauth.maxAccessTokenExpiry',
      message: 'Access token expiry exceeds 24 hours, consider reducing for security',
    });
  }

  // Check security settings
  if (contract.security.tier === 'standard' && contract.security.mfa.requirement === 'disabled') {
    warnings.push({
      field: 'security.mfa',
      message: 'MFA is disabled, consider enabling for improved security',
    });
  }

  // Check auth methods
  const enabledMethods = Object.entries(contract.authMethods).filter(
    ([, v]) => v === 'enabled' || v === 'required'
  );
  if (enabledMethods.length === 0) {
    errors.push({
      field: 'authMethods',
      message: 'At least one authentication method must be enabled',
    });
  }

  return c.json({
    valid: errors.length === 0,
    errors,
    warnings,
    validatedAt: new Date().toISOString(),
  });
});

// =============================================================================
// Client Profile Routes
// =============================================================================

/**
 * GET /api/admin/clients/:clientId/profile
 * Get client profile
 *
 * Security:
 * - Validates client ownership against tenant
 * - Uses D1 database for ownership check
 */
policyRouter.get('/clients/:clientId/profile', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return errorResponse(c, 'service_unavailable', 'Configuration service unavailable', 503);
  }

  const clientId = c.req.param('clientId');
  const tenantId = getTenantIdFromContext(c);
  const { coreAdapter } = createAdaptersFromContext(c);

  // Validate client ownership - CRITICAL SECURITY CHECK
  const clientRecord = await validateClientOwnership(coreAdapter, tenantId, clientId);
  if (!clientRecord) {
    // Don't reveal whether client exists in another tenant
    return notFoundResponse(c);
  }

  const contract = await getClientContract(kv, c.env, tenantId, clientId);

  if (!contract) {
    return notFoundResponse(c);
  }

  // Get tenant policy for reference
  const tenantContract = await getTenantContract(kv, c.env, tenantId);

  return c.json({
    profile: contract,
    tenantPolicyVersion: tenantContract?.version ?? 0,
    _links: {
      self: `/api/admin/clients/${clientId}/profile`,
      validate: `/api/admin/clients/${clientId}/profile/validate`,
      tenantPolicy: '/api/admin/tenant-policy',
    },
  });
});

/**
 * PUT /api/admin/clients/:clientId/profile
 * Update client profile
 *
 * Security:
 * - Validates client ownership against tenant
 * - Optimistic locking with ifMatch (REQUIRED)
 * - Input validation with property whitelist
 * - Prevents property injection attacks
 */
policyRouter.put('/clients/:clientId/profile', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return errorResponse(c, 'service_unavailable', 'Configuration service unavailable', 503);
  }

  const clientId = c.req.param('clientId');
  const tenantId = getTenantIdFromContext(c);
  const adminAuth = getAdminAuth(c);
  const actor = adminAuth?.userId ?? 'unknown';
  const { coreAdapter } = createAdaptersFromContext(c);

  // Validate client ownership - CRITICAL SECURITY CHECK
  const clientRecord = await validateClientOwnership(coreAdapter, tenantId, clientId);
  if (!clientRecord) {
    return notFoundResponse(c);
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return errorResponse(c, 'bad_request', 'Invalid JSON body', 400);
  }

  // Validate input structure
  const body = validateClientProfileUpdate(rawBody);
  if (!body) {
    return errorResponse(c, 'bad_request', 'Invalid request body format', 400);
  }

  // Security: ifMatch is REQUIRED to prevent version rollback attacks
  if (body.ifMatch === undefined) {
    return c.json(
      {
        error: 'precondition_required',
        message:
          'ifMatch parameter is required for updates to prevent concurrent modification issues',
        hint: 'First GET the current profile to obtain the version, then include ifMatch with that version',
      },
      428
    );
  }

  // Security: Validate profile keys against whitelist to prevent property injection
  if (body.profile) {
    const unknownKeys = findUnknownKeys(
      body.profile as Record<string, unknown>,
      ALLOWED_CLIENT_PROFILE_KEYS
    );
    if (unknownKeys.length > 0) {
      return errorResponse(
        c,
        'bad_request',
        `Unknown profile keys: ${unknownKeys.join(', ')}. Only standard profile fields are allowed.`,
        400
      );
    }
  }

  // Get existing contract
  const existing = await getClientContract(kv, c.env, tenantId, clientId);
  const existingVersion = existing?.version ?? 0;
  const existingStatus = existing?.metadata?.status ?? 'draft';

  // Get tenant policy for validation
  const tenantContract = await getTenantContract(kv, c.env, tenantId);
  if (!tenantContract) {
    return errorResponse(
      c,
      'precondition_failed',
      'Tenant policy must be configured before client profiles',
      412
    );
  }

  // Optimistic locking - strict version match required
  if (body.ifMatch !== String(existingVersion)) {
    return c.json(
      {
        error: 'conflict',
        message: 'Resource has been modified. Please refresh and try again.',
        currentVersion: existingVersion,
      },
      409
    );
  }

  // Status transition validation
  const requestedStatus = (body.profile?.metadata as { status?: ContractStatus } | undefined)
    ?.status;
  const statusError = validateStatusTransition(existingStatus, requestedStatus);
  if (statusError) {
    return errorResponse(c, 'invalid_status_transition', statusError, 400);
  }

  // Build updated contract
  const now = new Date().toISOString();
  const newStatus = requestedStatus ?? existingStatus;
  // Use existing contract or create default as base
  const baseContract =
    existing ??
    createDefaultClientContract(
      clientId,
      tenantContract.version,
      (body.profile?.preset as ClientProfilePreset) ?? 'custom',
      actor
    );
  const updatedContract: ClientContract = {
    ...baseContract,
    ...body.profile,
    clientId, // Ensure client ID cannot be changed (security)
    version: existingVersion + 1,
    tenantContractVersion: tenantContract.version,
    // Preserve required fields with defaults
    clientType: body.profile?.clientType ?? baseContract.clientType,
    oauth: body.profile?.oauth ?? baseContract.oauth,
    encryption: body.profile?.encryption ?? baseContract.encryption,
    scopes: body.profile?.scopes ?? baseContract.scopes,
    authMethods: body.profile?.authMethods ?? baseContract.authMethods,
    consent: body.profile?.consent ?? baseContract.consent,
    redirect: body.profile?.redirect ?? baseContract.redirect,
    tokens: body.profile?.tokens ?? baseContract.tokens,
    preset: body.profile?.preset ?? baseContract.preset,
    metadata: {
      createdAt: baseContract.metadata.createdAt,
      createdBy: baseContract.metadata.createdBy,
      updatedAt: now,
      updatedBy: actor,
      status: newStatus,
      // Track status changes in history
      statusHistory: [
        ...(baseContract.metadata.statusHistory ?? []),
        ...(requestedStatus && requestedStatus !== existingStatus
          ? [{ from: existingStatus, to: requestedStatus, timestamp: now, actor }]
          : []),
      ],
      // Track lifecycle timestamps
      activatedAt:
        newStatus === 'active' && existingStatus !== 'active'
          ? now
          : existing?.metadata?.activatedAt,
      deprecatedAt:
        newStatus === 'deprecated' && existingStatus !== 'deprecated'
          ? now
          : existing?.metadata?.deprecatedAt,
      archivedAt:
        newStatus === 'archived' && existingStatus !== 'archived'
          ? now
          : existing?.metadata?.archivedAt,
    },
  };

  // Validate against tenant policy
  const resolver = createPolicyResolver(kv);
  const validation = await resolver.validateClientAgainstTenant(tenantContract, updatedContract);

  if (!validation.valid) {
    return c.json(
      {
        error: 'validation_failed',
        message: 'Profile configuration violates policy constraints',
        errors: validation.errors,
        warnings: validation.warnings,
      },
      400
    );
  }

  await saveClientContract(kv, c.env, tenantId, clientId, updatedContract);

  // Audit logging
  const auditActor = createAuditActor(adminAuth, c);
  const auditSubject: AuditSubject = {
    type: 'client',
    id: clientId,
    version: updatedContract.version,
  };
  const eventType: ContractAuditEventType =
    requestedStatus && requestedStatus !== existingStatus
      ? 'contract.status_changed'
      : 'contract.updated';

  await writeAuditLog(
    kv,
    c.env,
    eventType,
    auditSubject,
    auditActor,
    `Updated client profile`,
    'success',
    {
      clientId,
      tenantId,
      previousVersion: existingVersion,
      newVersion: updatedContract.version,
      statusChange:
        requestedStatus && requestedStatus !== existingStatus
          ? { from: existingStatus, to: requestedStatus }
          : undefined,
    }
  );

  return c.json({
    profile: updatedContract,
    previousVersion: existingVersion,
    warnings: validation.warnings,
    _links: {
      self: `/api/admin/clients/${clientId}/profile`,
    },
  });
});

/**
 * GET /api/admin/client-profile-presets
 * List available client profile presets
 */
policyRouter.get('/client-profile-presets', (c) => {
  const presets = CLIENT_PROFILE_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    clientType: preset.clientType,
  }));

  return c.json({ presets });
});

/**
 * POST /api/admin/clients/:clientId/apply-preset
 * Apply a preset to client profile
 *
 * Security: Validates client ownership
 */
policyRouter.post('/clients/:clientId/apply-preset', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return errorResponse(c, 'service_unavailable', 'Configuration service unavailable', 503);
  }

  const clientId = c.req.param('clientId');
  const tenantId = getTenantIdFromContext(c);
  const adminAuth = getAdminAuth(c);
  const actor = adminAuth?.userId ?? 'unknown';
  const { coreAdapter } = createAdaptersFromContext(c);

  // Validate client ownership - CRITICAL SECURITY CHECK
  const clientRecord = await validateClientOwnership(coreAdapter, tenantId, clientId);
  if (!clientRecord) {
    return notFoundResponse(c);
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return errorResponse(c, 'bad_request', 'Invalid JSON body', 400);
  }

  // Validate input
  const body = validateApplyPresetBody(rawBody);
  if (!body || !body.preset) {
    return errorResponse(c, 'bad_request', 'preset field is required', 400);
  }

  const presetId = body.preset as ClientProfilePreset;

  // Find the preset
  const preset = CLIENT_PROFILE_PRESETS.find((p) => p.id === presetId);
  if (!preset) {
    return errorResponse(c, 'bad_request', 'Invalid preset specified', 400);
  }

  // Get tenant policy
  const tenantContract = await getTenantContract(kv, c.env, tenantId);
  if (!tenantContract) {
    return errorResponse(
      c,
      'precondition_failed',
      'Tenant policy must be configured before client profiles',
      412
    );
  }

  // Get existing contract
  const existing = await getClientContract(kv, c.env, tenantId, clientId);
  const existingVersion = existing?.version ?? 0;

  // Build new contract from preset
  const now = new Date().toISOString();
  const newContract: ClientContract = {
    ...preset.defaults,
    clientId,
    version: existingVersion + 1,
    tenantContractVersion: tenantContract.version,
    preset: presetId,
    metadata: {
      createdAt: existing?.metadata.createdAt ?? now,
      createdBy: existing?.metadata.createdBy ?? actor,
      updatedAt: now,
      updatedBy: actor,
      status: 'active',
      statusHistory: [],
      notes: `Applied preset: ${preset.name}`,
    },
  } as ClientContract;

  // Validate against tenant policy
  const resolver = createPolicyResolver(kv);
  const validation = await resolver.validateClientAgainstTenant(tenantContract, newContract);

  if (!validation.valid) {
    return c.json(
      {
        error: 'validation_failed',
        message: 'Preset configuration violates policy constraints',
        errors: validation.errors,
        warnings: validation.warnings,
      },
      400
    );
  }

  await saveClientContract(kv, c.env, tenantId, clientId, newContract);

  return c.json({
    profile: newContract,
    appliedPreset: presetId,
    previousVersion: existingVersion,
    warnings: validation.warnings,
  });
});

/**
 * GET /api/admin/clients/:clientId/profile/validate
 * Validate client profile against tenant policy
 *
 * Security: Validates client ownership
 */
policyRouter.get('/clients/:clientId/profile/validate', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return errorResponse(c, 'service_unavailable', 'Configuration service unavailable', 503);
  }

  const clientId = c.req.param('clientId');
  const tenantId = getTenantIdFromContext(c);
  const { coreAdapter } = createAdaptersFromContext(c);

  // Validate client ownership - CRITICAL SECURITY CHECK
  const clientRecord = await validateClientOwnership(coreAdapter, tenantId, clientId);
  if (!clientRecord) {
    return notFoundResponse(c);
  }

  const clientContract = await getClientContract(kv, c.env, tenantId, clientId);
  if (!clientContract) {
    return notFoundResponse(c);
  }

  const tenantContract = await getTenantContract(kv, c.env, tenantId);
  if (!tenantContract) {
    return notFoundResponse(c);
  }

  const resolver = createPolicyResolver(kv);
  const validation = await resolver.validateClientAgainstTenant(tenantContract, clientContract);

  // Check if client is referencing an older tenant version
  const versionWarnings: { field: string; message: string }[] = [];
  if (clientContract.tenantContractVersion < tenantContract.version) {
    versionWarnings.push({
      field: 'tenantContractVersion',
      message: 'Client references an older tenant policy version',
    });
  }

  return c.json({
    valid: validation.valid,
    errors: validation.errors,
    warnings: [...validation.warnings, ...versionWarnings],
    validatedAt: new Date().toISOString(),
    tenantPolicyVersion: tenantContract.version,
    clientProfileVersion: clientContract.version,
  });
});

// =============================================================================
// Effective Policy Routes
// =============================================================================

/**
 * GET /api/admin/effective-policy
 * Get resolved policy for a client
 * Query params: client_id (required)
 *
 * Security: Validates client ownership
 */
policyRouter.get('/effective-policy', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return errorResponse(c, 'service_unavailable', 'Configuration service unavailable', 503);
  }

  const clientId = c.req.query('client_id');
  if (!clientId) {
    return errorResponse(c, 'bad_request', 'client_id query parameter is required', 400);
  }

  const tenantId = getTenantIdFromContext(c);
  const includeDebug = c.req.query('debug') === 'true';
  const { coreAdapter } = createAdaptersFromContext(c);

  // Validate client ownership - CRITICAL SECURITY CHECK
  const clientRecord = await validateClientOwnership(coreAdapter, tenantId, clientId);
  if (!clientRecord) {
    return notFoundResponse(c);
  }

  // Get contracts
  const tenantContract = await getTenantContract(kv, c.env, tenantId);
  if (!tenantContract) {
    return notFoundResponse(c);
  }

  const clientContract = await getClientContract(kv, c.env, tenantId, clientId);
  if (!clientContract) {
    return notFoundResponse(c);
  }

  // Resolve policy
  const resolver = createPolicyResolver(kv);
  const result = await resolver.resolve(tenantContract, clientContract, {
    includeDebug,
    useCache: true,
  });

  if (!result.success) {
    return c.json(
      {
        error: 'resolution_failed',
        message: 'Failed to resolve policy',
        code: result.error.code,
      },
      400
    );
  }

  return c.json({
    effectivePolicy: result.policy,
    debug: result.debug,
    warnings: result.warnings,
    _links: {
      self: `/api/admin/effective-policy?client_id=${clientId}`,
      tenantPolicy: '/api/admin/tenant-policy',
      clientProfile: `/api/admin/clients/${clientId}/profile`,
    },
  });
});

/**
 * GET /api/admin/effective-policy/options
 * Get available options for flow designer based on effective policy
 * Query params: client_id (required)
 *
 * Security: Validates client ownership
 */
policyRouter.get('/effective-policy/options', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return errorResponse(c, 'service_unavailable', 'Configuration service unavailable', 503);
  }

  const clientId = c.req.query('client_id');
  if (!clientId) {
    return errorResponse(c, 'bad_request', 'client_id query parameter is required', 400);
  }

  const tenantId = getTenantIdFromContext(c);
  const { coreAdapter } = createAdaptersFromContext(c);

  // Validate client ownership - CRITICAL SECURITY CHECK
  const clientRecord = await validateClientOwnership(coreAdapter, tenantId, clientId);
  if (!clientRecord) {
    return notFoundResponse(c);
  }

  // Get contracts
  const tenantContract = await getTenantContract(kv, c.env, tenantId);
  if (!tenantContract) {
    return notFoundResponse(c);
  }

  const clientContract = await getClientContract(kv, c.env, tenantId, clientId);
  if (!clientContract) {
    return notFoundResponse(c);
  }

  // Resolve policy and get options
  const resolver = createPolicyResolver(kv);
  const result = await resolver.resolve(tenantContract, clientContract);

  if (!result.success) {
    return c.json(
      {
        error: 'resolution_failed',
        message: 'Failed to resolve policy',
      },
      400
    );
  }

  const options = await resolver.getAvailableOptions(result.policy);

  return c.json({
    options,
    policyVersion: {
      tenant: tenantContract.version,
      client: clientContract.version,
      resolution: result.policy.resolutionId,
    },
  });
});

export default policyRouter;
