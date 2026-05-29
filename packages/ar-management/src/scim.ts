/**
 * SCIM 2.0 User and Group Provisioning Endpoints
 *
 * Implements RFC 7643 (Core Schema) and RFC 7644 (Protocol)
 *
 * Endpoints:
 * - GET    /scim/v2/Users           - List users with filtering and pagination
 * - GET    /scim/v2/Users/{id}      - Get user by ID
 * - POST   /scim/v2/Users           - Create new user
 * - PUT    /scim/v2/Users/{id}      - Replace user
 * - PATCH  /scim/v2/Users/{id}      - Update user (partial)
 * - DELETE /scim/v2/Users/{id}      - Delete user
 * - GET    /scim/v2/Groups          - List groups
 * - GET    /scim/v2/Groups/{id}     - Get group by ID
 * - POST   /scim/v2/Groups          - Create new group
 * - PUT    /scim/v2/Groups/{id}     - Replace group
 * - PATCH  /scim/v2/Groups/{id}     - Update group (partial)
 * - DELETE /scim/v2/Groups/{id}     - Delete group
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7643
 * @see https://datatracker.ietf.org/doc/html/rfc7644
 */

import { Hono, Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  invalidateUserCache,
  getTenantIdFromContext,
  createAuthContextFromHono,
  createPIIContextFromHono,
  hasPIIDatabase,
  getLogger,
  DEFAULT_TENANT_ID,
} from '@authrim/ar-lib-core';
import {
  type DatabaseAdapter,
  type IdentityAccountRow,
  CanonicalIdentityRepository,
  CanonicalRuntimeUserProjectionRepository,
  CanonicalRuntimeUserWriter,
  CanonicalSensitiveValueResolver,
  generateId,
  generateUserIdFromSettings,
  hashPassword,
  validateCustomClaimWrite,
  persistCustomClaimWrite,
  syncUserLifecycleState,
  resolveCustomClaimRuntimeSourcesFromEnv,
} from '@authrim/ar-lib-core';
import { logScimAudit } from '@authrim/ar-lib-scim';
import { canonicalProjectionToScimInternalUser } from './identity-canonical-runtime';

interface ScimUserReadOptions {
  canonicalProjectionRepository?: CanonicalRuntimeUserProjectionRepository | null;
  includeInactive?: boolean;
}

type CanonicalUserFilterValue = string | number | boolean | null | undefined;

/**
 * Create database adapters from Hono context.
 * Keeping this at the route edge lets the shared custom-claims logic stay
 * backend-agnostic while Workers still supply raw D1 bindings today.
 */
function createAdaptersFromContext(c: Context<{ Bindings: Env }>): {
  coreAdapter: DatabaseAdapter;
  piiAdapter: DatabaseAdapter | null;
} {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const coreAdapter = authCtx.coreAdapter;
  const piiAdapter = hasPIIDatabase(c)
    ? createPIIContextFromHono(c, tenantId).defaultPiiAdapter
    : null;
  return { coreAdapter, piiAdapter };
}

function createCanonicalProjectionRepository(
  _c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter | null,
  tenantId: string
): CanonicalRuntimeUserProjectionRepository | null {
  if (!piiAdapter) {
    return null;
  }
  return new CanonicalRuntimeUserProjectionRepository(
    coreAdapter,
    tenantId,
    new CanonicalSensitiveValueResolver(piiAdapter)
  );
}

async function maybeCreateCanonicalRuntimeUser(
  c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  internalUser: Partial<InternalUser>
): Promise<void> {
  const writer = new CanonicalRuntimeUserWriter(
    new CanonicalIdentityRepository(coreAdapter, tenantId),
    piiAdapter
  );
  await writer.createFromRuntimeUser({
    userId,
    tenantId,
    active: internalUser.active === undefined ? true : internalUser.active !== 0,
    emailVerified: Boolean(internalUser.email_verified),
    phoneNumberVerified: Boolean(internalUser.phone_number_verified),
    userType: 'end_user',
    displayName: internalUser.name ?? internalUser.preferred_username ?? internalUser.email ?? null,
    locale: internalUser.locale ?? null,
    zoneinfo: internalUser.zoneinfo ?? null,
    sourceRef: 'scim:/Users',
    externalId: internalUser.external_id ?? null,
    passwordHash: internalUser.password_hash ?? null,
    addressJson: internalUser.address_json ?? null,
    customAttributesJson: internalUser.custom_attributes_json ?? null,
    piiFields: {
      email: true,
      phone_number: true,
      name: true,
      given_name: true,
      family_name: true,
      middle_name: true,
      nickname: true,
      preferred_username: true,
      profile: true,
      picture: true,
      website: true,
      gender: true,
      birthdate: true,
      zoneinfo: true,
      locale: true,
    },
    sensitiveValues: {
      email: internalUser.email,
      phone_number: internalUser.phone_number,
      name: internalUser.name,
      given_name: internalUser.given_name,
      family_name: internalUser.family_name,
      middle_name: internalUser.middle_name,
      nickname: internalUser.nickname,
      preferred_username: internalUser.preferred_username,
      profile: internalUser.profile,
      picture: internalUser.picture,
      website: internalUser.website,
      gender: internalUser.gender,
      birthdate: internalUser.birthdate,
      zoneinfo: internalUser.zoneinfo,
      locale: internalUser.locale,
    },
  });
}

async function maybeSyncCanonicalRuntimeUser(
  c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  internalUser: Partial<InternalUser>
): Promise<void> {
  const writer = new CanonicalRuntimeUserWriter(
    new CanonicalIdentityRepository(coreAdapter, tenantId),
    piiAdapter
  );
  await writer.syncFromRuntimeUser({
    userId,
    tenantId,
    active: internalUser.active === undefined ? true : internalUser.active !== 0,
    emailVerified: Boolean(internalUser.email_verified),
    phoneNumberVerified: Boolean(internalUser.phone_number_verified),
    userType: 'end_user',
    displayName: internalUser.name ?? internalUser.preferred_username ?? internalUser.email ?? null,
    locale: internalUser.locale ?? null,
    zoneinfo: internalUser.zoneinfo ?? null,
    sourceRef: 'scim:/Users',
    externalId: internalUser.external_id ?? null,
    passwordHash: internalUser.password_hash ?? null,
    addressJson: internalUser.address_json ?? null,
    customAttributesJson: internalUser.custom_attributes_json ?? null,
    piiFields: {
      email: true,
      phone_number: true,
      name: true,
      given_name: true,
      family_name: true,
      middle_name: true,
      nickname: true,
      preferred_username: true,
      profile: true,
      picture: true,
      website: true,
      gender: true,
      birthdate: true,
      zoneinfo: true,
      locale: true,
    },
    sensitiveValues: {
      email: internalUser.email,
      phone_number: internalUser.phone_number,
      name: internalUser.name,
      given_name: internalUser.given_name,
      family_name: internalUser.family_name,
      middle_name: internalUser.middle_name,
      nickname: internalUser.nickname,
      preferred_username: internalUser.preferred_username,
      profile: internalUser.profile,
      picture: internalUser.picture,
      website: internalUser.website,
      gender: internalUser.gender,
      birthdate: internalUser.birthdate,
      zoneinfo: internalUser.zoneinfo,
      locale: internalUser.locale,
    },
  });
}

async function maybeDeleteCanonicalRuntimeUser(
  c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<void> {
  const writer = new CanonicalRuntimeUserWriter(
    new CanonicalIdentityRepository(coreAdapter, tenantId),
    piiAdapter
  );
  await writer.deleteRuntimeUser(userId);
}

/**
 * Fetch user from both Core and PII databases and merge into InternalUser
 */
async function fetchUserWithPII(
  userId: string,
  options: ScimUserReadOptions
): Promise<InternalUser | null> {
  const canonicalProjection = await options.canonicalProjectionRepository?.findByLegacyUserId(
    userId,
    { includeInactive: options.includeInactive }
  );
  return canonicalProjection ? canonicalProjectionToScimInternalUser(canonicalProjection) : null;
}

function parseScimCustomAttributes(
  internalUser: Partial<InternalUser>
): Record<string, unknown> | undefined {
  if (!internalUser.custom_attributes_json) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(internalUser.custom_attributes_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed custom attribute payloads from mapping.
  }

  return {};
}

async function validateScimCustomClaimWrite(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  internalUser: Partial<InternalUser>,
  options?: {
    userId?: string;
    mergeExistingValues?: boolean;
    deleteMissingFields?: boolean;
  }
) {
  const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
  return validateCustomClaimWrite({
    db: customClaimSources.nonPiiDb,
    dbPii: customClaimSources.piiDb,
    schemaDb: customClaimSources.schemaDb,
    tenantId,
    userId: options?.userId,
    submitted: parseScimCustomAttributes(internalUser),
    requireCompleteRecord: true,
    mergeExistingValues: options?.mergeExistingValues,
    deleteMissingFields: options?.deleteMissingFields,
  });
}

async function persistScimCustomClaimWrite(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userId: string,
  validation: Awaited<ReturnType<typeof validateScimCustomClaimWrite>>
) {
  if (!validation.ok) {
    return;
  }

  const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
  await persistCustomClaimWrite({
    db: customClaimSources.nonPiiDb,
    dbPii: customClaimSources.piiDb,
    tenantId,
    userId,
    validation,
  });

  await syncUserLifecycleState({
    db: customClaimSources.nonPiiDb,
    dbPii: customClaimSources.piiDb,
    schemaDb: customClaimSources.schemaDb,
    stateDb: createAuthContextFromHono(c, tenantId).coreAdapter,
    tenantId,
    userId,
  });
}

async function fetchCanonicalUsers(
  coreAdapter: DatabaseAdapter,
  projectionRepository: CanonicalRuntimeUserProjectionRepository,
  tenantId: string,
  options: { includeInactive?: boolean } = {}
): Promise<InternalUser[]> {
  const lifecycleClause = options.includeInactive ? '' : " AND lifecycle_state = 'active'";
  const accounts = await coreAdapter.query<IdentityAccountRow>(
    `SELECT *
       FROM identity_accounts
      WHERE tenant_id = ?
        AND legacy_user_id IS NOT NULL${lifecycleClause}
      ORDER BY created_at DESC`,
    [tenantId]
  );

  const users: InternalUser[] = [];
  for (const account of accounts) {
    if (!account.legacy_user_id) {
      continue;
    }
    const projection = await projectionRepository.findByLegacyUserId(account.legacy_user_id, {
      includeInactive: options.includeInactive,
    });
    if (projection) {
      users.push(canonicalProjectionToScimInternalUser(projection));
    }
  }
  return users;
}

function getScimUserFilterValue(user: InternalUser, attribute: string): CanonicalUserFilterValue {
  switch (attribute) {
    case 'id':
      return user.id;
    case 'userName':
    case 'preferred_username':
      return user.preferred_username || user.email;
    case 'emails.value':
    case 'email':
      return user.email;
    case 'name':
    case 'displayName':
      return user.name;
    case 'name.givenName':
    case 'given_name':
      return user.given_name;
    case 'name.familyName':
    case 'family_name':
      return user.family_name;
    case 'active':
      return Boolean(user.active);
    case 'externalId':
    case 'external_id':
      return user.external_id;
    default:
      return undefined;
  }
}

function userMatchesScimFilter(user: InternalUser, filter: string): boolean {
  const match = filter.match(/^([\w.]+)\s+(eq|co|sw|ew)\s+"?([^"]+)"?$/i);
  if (!match) {
    throw new Error('Unsupported SCIM filter');
  }
  const [, attribute, operator, rawExpected] = match;
  const actual = getScimUserFilterValue(user, attribute);
  if (operator.toLowerCase() === 'eq' && attribute === 'active') {
    return Boolean(actual) === (rawExpected.toLowerCase() === 'true');
  }
  const actualString = actual == null ? '' : String(actual).toLowerCase();
  const expected = rawExpected.toLowerCase();
  switch (operator.toLowerCase()) {
    case 'eq':
      return actualString === expected;
    case 'co':
      return actualString.includes(expected);
    case 'sw':
      return actualString.startsWith(expected);
    case 'ew':
      return actualString.endsWith(expected);
    default:
      return false;
  }
}

/**
 * Fetch group members with PII from both Core and PII databases
 * PII/Non-PII DB separation: Cannot JOIN, so query user_roles and PII DB separately
 */
async function fetchGroupMembersWithPII(
  coreAdapter: DatabaseAdapter,
  projectionRepository: CanonicalRuntimeUserProjectionRepository | null,
  roleId: string,
  tenantId: string
): Promise<{ user_id: string; email: string }[]> {
  // Get user_ids from user_roles (Core DB) via Adapter
  const roleMembers = await coreAdapter.query<{ user_id: string }>(
    'SELECT user_id FROM user_roles WHERE tenant_id = ? AND role_id = ?',
    [tenantId, roleId]
  );

  if (roleMembers.length === 0) {
    return [];
  }

  const emailMap = new Map<string, string>();
  if (projectionRepository) {
    for (const member of roleMembers) {
      const projection = await projectionRepository.findByLegacyUserId(member.user_id);
      if (projection?.email) {
        emailMap.set(member.user_id, projection.email);
      }
    }
  }

  // Merge results
  return roleMembers.map((r) => ({
    user_id: r.user_id,
    email: emailMap.get(r.user_id) || '',
  }));
}

async function findMissingTenantUserIds(
  coreAdapter: DatabaseAdapter,
  tenantId: string,
  userIds: string[]
): Promise<string[]> {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueUserIds.length === 0) {
    return [];
  }

  const placeholders = uniqueUserIds.map(() => '?').join(',');
  const rows = await coreAdapter.query<{ id: string }>(
    `SELECT legacy_user_id as id
       FROM identity_accounts
      WHERE tenant_id = ?
        AND legacy_user_id IN (${placeholders})
        AND lifecycle_state = 'active'`,
    [tenantId, ...uniqueUserIds]
  );
  const found = new Set(rows.map((row) => row.id));
  return uniqueUserIds.filter((userId) => !found.has(userId));
}

function resolveScimGroupMemberIds(
  members: ScimGroup['members'] | undefined,
  bulkIdMap?: Map<string, string>
): string[] {
  return (members ?? []).map((member) => {
    if (bulkIdMap && member.value.startsWith('bulkId:')) {
      return bulkIdMap.get(member.value.substring(7)) ?? member.value;
    }
    return member.value;
  });
}

async function insertTenantGroupMembers(
  coreAdapter: DatabaseAdapter,
  tenantId: string,
  roleId: string,
  memberIds: string[],
  createdAt: string
): Promise<void> {
  for (const memberId of memberIds) {
    await coreAdapter.execute(
      `INSERT INTO user_roles (user_id, role_id, tenant_id, created_at) VALUES (?, ?, ?, ?)`,
      [memberId, roleId, tenantId, createdAt]
    );
  }
}

function invalidGroupMemberBulkResponse(
  method: string,
  bulkId?: string
): ScimBulkOperationResponse {
  return {
    method: method as ScimBulkMethod,
    bulkId,
    status: '400',
    response: {
      schemas: [SCIM_SCHEMAS.ERROR],
      status: '400',
      detail: 'Group member does not exist in this tenant',
      scimType: 'invalidValue',
    },
  };
}
import {
  // Types
  SCIM_SCHEMAS,
  SCIM_BULK_SCHEMAS,
  type ScimUser,
  type ScimGroup,
  type ScimListResponse,
  type ScimError,
  type ScimPatchOp,
  type ScimQueryParams,
  type ScimErrorType,
  type ScimBulkRequest,
  type ScimBulkResponse,
  type ScimBulkOperation,
  type ScimBulkOperationResponse,
  type ScimBulkMethod,
  type BulkOperationConfig,
  // Mapper utilities
  userToScim,
  scimToUser,
  groupToScim,
  scimToGroup,
  generateEtag,
  parseEtag,
  applyPatchOperations,
  validateScimUser,
  validateScimGroup,
  type InternalUser,
  type InternalGroup,
  // Filter utilities
  parseScimFilter,
  filterToSql,
  // Auth middleware
  scimAuthMiddleware,
} from '@authrim/ar-lib-scim';

/**
 * SCIM Service Provider Configuration type (RFC 7643 Section 5)
 */
interface ScimServiceProviderConfig {
  schemas: string[];
  documentationUri?: string;
  patch: { supported: boolean };
  bulk: { supported: boolean; maxOperations: number; maxPayloadSize: number };
  filter: { supported: boolean; maxResults: number };
  changePassword: { supported: boolean };
  sort: { supported: boolean };
  etag: { supported: boolean };
  authenticationSchemes: Array<{
    type: string;
    name: string;
    description: string;
    specUri?: string;
    documentationUri?: string;
    primary?: boolean;
  }>;
  meta: {
    location: string;
    resourceType: string;
    created?: string;
    lastModified?: string;
    version?: string;
  };
}

const app = new Hono<{ Bindings: Env }>();

// SCIM Discovery endpoints that should be accessible without authentication (RFC 7644 Section 4)
const SCIM_DISCOVERY_PATHS = ['/ServiceProviderConfig', '/ResourceTypes', '/Schemas'];

function resolveScimTenantId(c: ScimContext): string | null {
  const contextTenantId = (c as any).get?.('tenantId');
  if (typeof contextTenantId === 'string' && contextTenantId.trim()) {
    return contextTenantId.trim();
  }

  // Single-tenant deployments have an explicit deployment default. Multi-tenant
  // SCIM must be host/context resolved by the outer request context middleware.
  if (!c.env.BASE_DOMAIN) {
    return c.env.DEFAULT_TENANT_ID || DEFAULT_TENANT_ID;
  }

  return null;
}

// Set SCIM Content-Type for all responses (RFC 7644 Section 3.1)
app.use('*', async (c, next) => {
  await next();
  // Set Content-Type to application/scim+json for JSON responses
  const contentType = c.res.headers.get('Content-Type');
  if (contentType?.includes('application/json')) {
    c.res.headers.set('Content-Type', 'application/scim+json; charset=utf-8');
  }
});

// Fail closed if a multi-tenant SCIM request reaches this router without a
// tenant context. In single-tenant mode we materialize the deployment default
// tenant instead of relying on an implicit string fallback in route handlers.
app.use('*', async (c, next) => {
  const tenantId = resolveScimTenantId(c);
  if (!tenantId) {
    return scimError(c, 403, 'Tenant context is required', 'invalidValue');
  }
  (c as any).set('tenantId', tenantId);
  return next();
});

// Apply SCIM authentication to all routes EXCEPT discovery endpoints
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  // Skip auth for discovery endpoints (RFC 7644 Section 4 recommends unauthenticated access)
  for (const discoveryPath of SCIM_DISCOVERY_PATHS) {
    if (path.endsWith(discoveryPath) || path.includes(`${discoveryPath}/`)) {
      return next();
    }
  }
  return scimAuthMiddleware(c, next);
});

/**
 * SCIM Context type alias
 */
type ScimContext = Context<{ Bindings: Env }>;

/**
 * Helper: Get base URL from request
 */
function getBaseUrl(c: ScimContext): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * Helper: Return SCIM error response
 */
function scimError(
  c: ScimContext,
  status: 400 | 401 | 403 | 404 | 409 | 412 | 413 | 500,
  detail: string,
  scimType?: ScimErrorType,
  extensions?: Record<string, unknown>
): Response {
  const error: ScimError & Record<string, unknown> = {
    schemas: [SCIM_SCHEMAS.ERROR],
    status: status.toString(),
    detail,
  };

  if (scimType) {
    error.scimType = scimType;
  }

  if (extensions) {
    Object.assign(error, extensions);
  }

  return c.json(error, status);
}

function toCustomClaimErrorExtensions(validation: {
  missingRequiredFields?: Array<{ fieldKey: string; label: string; fieldType: string }>;
}): Record<string, unknown> | undefined {
  if (!validation.missingRequiredFields || validation.missingRequiredFields.length === 0) {
    return undefined;
  }

  return {
    missing_required_fields: validation.missingRequiredFields.map((field) => ({
      field_key: field.fieldKey,
      label: field.label,
      field_type: field.fieldType,
    })),
  };
}

/**
 * Allowed sortBy columns for Users (SCIM attribute -> DB column)
 * Prevents SQL injection by whitelisting valid column names
 */
const ALLOWED_USER_SORT_COLUMNS: Record<string, string> = {
  userName: 'preferred_username',
  displayName: 'name',
  name: 'name',
  'name.givenName': 'given_name',
  'name.familyName': 'family_name',
  'emails.value': 'email',
  email: 'email',
  created: 'created_at',
  lastModified: 'updated_at',
  // Also allow direct DB column names for backwards compatibility
  preferred_username: 'preferred_username',
  given_name: 'given_name',
  family_name: 'family_name',
  created_at: 'created_at',
  updated_at: 'updated_at',
  id: 'id',
};

/**
 * Allowed sortBy columns for Groups (SCIM attribute -> DB column)
 */
const ALLOWED_GROUP_SORT_COLUMNS: Record<string, string> = {
  displayName: 'name',
  name: 'name',
  created: 'created_at',
  // Also allow direct DB column names
  created_at: 'created_at',
  id: 'id',
};

/**
 * Validate and map sortBy parameter to safe DB column name
 * @returns DB column name or null if invalid
 */
function validateSortColumn(sortBy: string, allowedColumns: Record<string, string>): string | null {
  return allowedColumns[sortBy] || null;
}

/**
 * Helper: Parse query parameters
 */
function parseQueryParams(c: ScimContext): ScimQueryParams {
  const params: ScimQueryParams = {};

  const filter = c.req.query('filter');
  if (filter) params.filter = filter;

  const sortBy = c.req.query('sortBy');
  if (sortBy) params.sortBy = sortBy;

  const sortOrder = c.req.query('sortOrder');
  if (sortOrder) params.sortOrder = sortOrder as 'ascending' | 'descending';

  const startIndex = c.req.query('startIndex');
  if (startIndex) params.startIndex = parseInt(startIndex, 10);

  const count = c.req.query('count');
  if (count) params.count = parseInt(count, 10);

  const attributes = c.req.query('attributes');
  if (attributes) params.attributes = attributes.split(',').map((a: string) => a.trim());

  const excludedAttributes = c.req.query('excludedAttributes');
  if (excludedAttributes)
    params.excludedAttributes = excludedAttributes.split(',').map((a: string) => a.trim());

  return params;
}

// ============================================================================
// SCIM Discovery Endpoints (RFC 7644 Section 4)
// ============================================================================

/**
 * GET /scim/v2/ServiceProviderConfig - Service Provider Configuration
 * RFC 7644 Section 4 - REQUIRED endpoint
 */
app.get('/ServiceProviderConfig', (c) => {
  const baseUrl = getBaseUrl(c);

  const config: ScimServiceProviderConfig = {
    schemas: [SCIM_SCHEMAS.SERVICE_PROVIDER_CONFIG],
    documentationUri: `${baseUrl}/docs/scim`,
    patch: {
      supported: true,
    },
    bulk: {
      supported: true,
      maxOperations: 100, // Configurable via KV: SCIM_BULK_MAX_OPERATIONS
      maxPayloadSize: 1048576, // 1MB, configurable via KV: SCIM_BULK_MAX_PAYLOAD_SIZE
    },
    filter: {
      supported: true,
      maxResults: 1000,
    },
    changePassword: {
      supported: true,
    },
    sort: {
      supported: true,
    },
    etag: {
      supported: true,
    },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'Authentication scheme using the OAuth Bearer Token Standard',
        specUri: 'https://tools.ietf.org/html/rfc6750',
        primary: true,
      },
    ],
    meta: {
      location: `${baseUrl}/scim/v2/ServiceProviderConfig`,
      resourceType: 'ServiceProviderConfig',
      created: '2024-01-01T00:00:00Z',
      lastModified: '2024-12-22T00:00:00Z',
    },
  };

  return c.json(config);
});

/**
 * GET /scim/v2/ResourceTypes - Resource Type definitions
 * RFC 7644 Section 4 - REQUIRED endpoint
 */
app.get('/ResourceTypes', (c) => {
  const baseUrl = getBaseUrl(c);

  const resourceTypes = {
    schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
    totalResults: 2,
    Resources: [
      {
        schemas: [SCIM_SCHEMAS.RESOURCE_TYPE],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        description: 'User Account',
        schema: SCIM_SCHEMAS.USER,
        schemaExtensions: [
          {
            schema: SCIM_SCHEMAS.ENTERPRISE_USER,
            required: false,
          },
        ],
        meta: {
          location: `${baseUrl}/scim/v2/ResourceTypes/User`,
          resourceType: 'ResourceType',
        },
      },
      {
        schemas: [SCIM_SCHEMAS.RESOURCE_TYPE],
        id: 'Group',
        name: 'Group',
        endpoint: '/Groups',
        description: 'Group',
        schema: SCIM_SCHEMAS.GROUP,
        meta: {
          location: `${baseUrl}/scim/v2/ResourceTypes/Group`,
          resourceType: 'ResourceType',
        },
      },
    ],
  };

  return c.json(resourceTypes);
});

/**
 * GET /scim/v2/ResourceTypes/:name - Single Resource Type
 */
app.get('/ResourceTypes/:name', (c) => {
  const name = c.req.param('name')!;
  const baseUrl = getBaseUrl(c);

  if (name === 'User') {
    return c.json({
      schemas: [SCIM_SCHEMAS.RESOURCE_TYPE],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      description: 'User Account',
      schema: SCIM_SCHEMAS.USER,
      schemaExtensions: [
        {
          schema: SCIM_SCHEMAS.ENTERPRISE_USER,
          required: false,
        },
      ],
      meta: {
        location: `${baseUrl}/scim/v2/ResourceTypes/User`,
        resourceType: 'ResourceType',
      },
    });
  }

  if (name === 'Group') {
    return c.json({
      schemas: [SCIM_SCHEMAS.RESOURCE_TYPE],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      description: 'Group',
      schema: SCIM_SCHEMAS.GROUP,
      meta: {
        location: `${baseUrl}/scim/v2/ResourceTypes/Group`,
        resourceType: 'ResourceType',
      },
    });
  }

  return scimError(c, 404, 'The requested resource was not found');
});

/**
 * GET /scim/v2/Schemas - Schema definitions
 * RFC 7644 Section 4 - REQUIRED endpoint
 */
app.get('/Schemas', (c) => {
  const baseUrl = getBaseUrl(c);

  // Simplified schema definitions - full SCIM Core Schema
  const schemas = {
    schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
    totalResults: 3,
    Resources: [
      {
        schemas: [SCIM_SCHEMAS.SCHEMA],
        id: SCIM_SCHEMAS.USER,
        name: 'User',
        description: 'User Account',
        attributes: [
          {
            name: 'userName',
            type: 'string',
            multiValued: false,
            required: true,
            caseExact: false,
            mutability: 'readWrite',
            returned: 'default',
            uniqueness: 'server',
          },
          {
            name: 'name',
            type: 'complex',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
            subAttributes: [
              { name: 'formatted', type: 'string', multiValued: false, required: false },
              { name: 'familyName', type: 'string', multiValued: false, required: false },
              { name: 'givenName', type: 'string', multiValued: false, required: false },
              { name: 'middleName', type: 'string', multiValued: false, required: false },
              { name: 'honorificPrefix', type: 'string', multiValued: false, required: false },
              { name: 'honorificSuffix', type: 'string', multiValued: false, required: false },
            ],
          },
          {
            name: 'displayName',
            type: 'string',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
          },
          {
            name: 'emails',
            type: 'complex',
            multiValued: true,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
            subAttributes: [
              { name: 'value', type: 'string', multiValued: false, required: false },
              { name: 'type', type: 'string', multiValued: false, required: false },
              { name: 'primary', type: 'boolean', multiValued: false, required: false },
            ],
          },
          {
            name: 'phoneNumbers',
            type: 'complex',
            multiValued: true,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
            subAttributes: [
              { name: 'value', type: 'string', multiValued: false, required: false },
              { name: 'type', type: 'string', multiValued: false, required: false },
              { name: 'primary', type: 'boolean', multiValued: false, required: false },
            ],
          },
          {
            name: 'active',
            type: 'boolean',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
          },
        ],
        meta: {
          location: `${baseUrl}/scim/v2/Schemas/${encodeURIComponent(SCIM_SCHEMAS.USER)}`,
          resourceType: 'Schema',
        },
      },
      {
        schemas: [SCIM_SCHEMAS.SCHEMA],
        id: SCIM_SCHEMAS.GROUP,
        name: 'Group',
        description: 'Group',
        attributes: [
          {
            name: 'displayName',
            type: 'string',
            multiValued: false,
            required: true,
            mutability: 'readWrite',
            returned: 'default',
          },
          {
            name: 'members',
            type: 'complex',
            multiValued: true,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
            subAttributes: [
              { name: 'value', type: 'string', multiValued: false, required: false },
              { name: '$ref', type: 'reference', multiValued: false, required: false },
              { name: 'type', type: 'string', multiValued: false, required: false },
            ],
          },
        ],
        meta: {
          location: `${baseUrl}/scim/v2/Schemas/${encodeURIComponent(SCIM_SCHEMAS.GROUP)}`,
          resourceType: 'Schema',
        },
      },
      {
        schemas: [SCIM_SCHEMAS.SCHEMA],
        id: SCIM_SCHEMAS.ENTERPRISE_USER,
        name: 'EnterpriseUser',
        description: 'Enterprise User Extension',
        attributes: [
          {
            name: 'employeeNumber',
            type: 'string',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
          },
          {
            name: 'organization',
            type: 'string',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
          },
          {
            name: 'department',
            type: 'string',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
          },
        ],
        meta: {
          location: `${baseUrl}/scim/v2/Schemas/${encodeURIComponent(SCIM_SCHEMAS.ENTERPRISE_USER)}`,
          resourceType: 'Schema',
        },
      },
    ],
  };

  return c.json(schemas);
});

/**
 * GET /scim/v2/Schemas/:id - Single Schema
 */
app.get('/Schemas/:id', (c) => {
  const schemaId = decodeURIComponent(c.req.param('id')!);
  const baseUrl = getBaseUrl(c);

  // Return schema based on ID
  if (schemaId === SCIM_SCHEMAS.USER) {
    return c.json({
      schemas: [SCIM_SCHEMAS.SCHEMA],
      id: SCIM_SCHEMAS.USER,
      name: 'User',
      description: 'User Account',
      attributes: [
        {
          name: 'userName',
          type: 'string',
          multiValued: false,
          required: true,
          caseExact: false,
          mutability: 'readWrite',
          returned: 'default',
          uniqueness: 'server',
        },
        {
          name: 'name',
          type: 'complex',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
          subAttributes: [
            { name: 'formatted', type: 'string', multiValued: false, required: false },
            { name: 'familyName', type: 'string', multiValued: false, required: false },
            { name: 'givenName', type: 'string', multiValued: false, required: false },
            { name: 'middleName', type: 'string', multiValued: false, required: false },
            { name: 'honorificPrefix', type: 'string', multiValued: false, required: false },
            { name: 'honorificSuffix', type: 'string', multiValued: false, required: false },
          ],
        },
        {
          name: 'displayName',
          type: 'string',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'emails',
          type: 'complex',
          multiValued: true,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
          subAttributes: [
            { name: 'value', type: 'string', multiValued: false, required: false },
            { name: 'type', type: 'string', multiValued: false, required: false },
            { name: 'primary', type: 'boolean', multiValued: false, required: false },
          ],
        },
        {
          name: 'phoneNumbers',
          type: 'complex',
          multiValued: true,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
          subAttributes: [
            { name: 'value', type: 'string', multiValued: false, required: false },
            { name: 'type', type: 'string', multiValued: false, required: false },
            { name: 'primary', type: 'boolean', multiValued: false, required: false },
          ],
        },
        {
          name: 'active',
          type: 'boolean',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
      ],
      meta: {
        location: `${baseUrl}/scim/v2/Schemas/${encodeURIComponent(SCIM_SCHEMAS.USER)}`,
        resourceType: 'Schema',
      },
    });
  }

  if (schemaId === SCIM_SCHEMAS.GROUP) {
    return c.json({
      schemas: [SCIM_SCHEMAS.SCHEMA],
      id: SCIM_SCHEMAS.GROUP,
      name: 'Group',
      description: 'Group',
      attributes: [
        {
          name: 'displayName',
          type: 'string',
          multiValued: false,
          required: true,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'members',
          type: 'complex',
          multiValued: true,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
          subAttributes: [
            { name: 'value', type: 'string', multiValued: false, required: false },
            { name: '$ref', type: 'reference', multiValued: false, required: false },
            { name: 'type', type: 'string', multiValued: false, required: false },
          ],
        },
      ],
      meta: {
        location: `${baseUrl}/scim/v2/Schemas/${encodeURIComponent(SCIM_SCHEMAS.GROUP)}`,
        resourceType: 'Schema',
      },
    });
  }

  if (schemaId === SCIM_SCHEMAS.ENTERPRISE_USER) {
    return c.json({
      schemas: [SCIM_SCHEMAS.SCHEMA],
      id: SCIM_SCHEMAS.ENTERPRISE_USER,
      name: 'EnterpriseUser',
      description: 'Enterprise User Extension',
      attributes: [
        {
          name: 'employeeNumber',
          type: 'string',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'organization',
          type: 'string',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'department',
          type: 'string',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
      ],
      meta: {
        location: `${baseUrl}/scim/v2/Schemas/${encodeURIComponent(SCIM_SCHEMAS.ENTERPRISE_USER)}`,
        resourceType: 'Schema',
      },
    });
  }

  return scimError(c, 404, 'The requested resource was not found');
});

// ============================================================================
// SCIM User Endpoints
// ============================================================================

/**
 * GET /scim/v2/Users - List users with filtering and pagination
 * PII/Non-PII DB separation: Filter on Core DB, fetch PII separately for result set
 */
app.get('/Users', async (c) => {
  try {
    const tenantId = getTenantIdFromContext(c);
    const params = parseQueryParams(c);
    const baseUrl = getBaseUrl(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const canonicalProjectionRepository = createCanonicalProjectionRepository(
      c,
      coreAdapter,
      piiAdapter,
      tenantId
    );
    if (!canonicalProjectionRepository) {
      return scimError(c, 500, 'Configured PII store is not available');
    }

    // Pagination defaults
    const startIndex = params.startIndex || 1; // SCIM uses 1-based indexing
    const count = Math.min(params.count || 100, 1000); // Max 1000 per page
    const offset = startIndex - 1;

    let users = await fetchCanonicalUsers(coreAdapter, canonicalProjectionRepository, tenantId);
    if (params.filter) {
      try {
        parseScimFilter(params.filter);
        users = users.filter((user) => userMatchesScimFilter(user, params.filter!));
      } catch (error) {
        // Log full error for debugging but don't expose to client
        const log = getLogger(c).module('SCIM');
        log.error('Invalid filter syntax', { action: 'list_users' }, error as Error);
        // SECURITY: Do not expose filter parsing error details
        return scimError(c, 400, 'Invalid filter syntax', 'invalidFilter');
      }
    }

    const totalResults = users.length;

    if (params.sortBy) {
      const sortColumn = validateSortColumn(params.sortBy, ALLOWED_USER_SORT_COLUMNS);
      if (!sortColumn) {
        return scimError(
          c,
          400,
          `Invalid sortBy attribute: ${params.sortBy}. Allowed values: ${Object.keys(ALLOWED_USER_SORT_COLUMNS).join(', ')}`,
          'invalidValue'
        );
      }
      const sortDirection = params.sortOrder === 'descending' ? -1 : 1;
      users.sort((a, b) => {
        const aValue = getScimUserFilterValue(a, sortColumn);
        const bValue = getScimUserFilterValue(b, sortColumn);
        return String(aValue ?? '').localeCompare(String(bValue ?? '')) * sortDirection;
      });
    }

    const pageUsers = users.slice(offset, offset + count);

    // Convert to SCIM format
    const scimUsers = pageUsers.map((user) => userToScim(user, { baseUrl, includeGroups: false }));

    const response: ScimListResponse<ScimUser> = {
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults,
      startIndex,
      itemsPerPage: scimUsers.length,
      Resources: scimUsers,
    };

    return c.json(response);
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM list users error', { action: 'list_users' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * GET /scim/v2/Users/{id} - Get user by ID
 * PII/Non-PII DB separation: Fetch from both DBs and merge
 */
app.get('/Users/:id', async (c) => {
  try {
    const userId = c.req.param('id')!;
    const baseUrl = getBaseUrl(c);
    const tenantId = getTenantIdFromContext(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const canonicalProjectionRepository = createCanonicalProjectionRepository(
      c,
      coreAdapter,
      piiAdapter,
      tenantId
    );
    if (!canonicalProjectionRepository || !piiAdapter) {
      return scimError(c, 500, 'Configured PII store is not available');
    }
    const user = await fetchUserWithPII(userId, {
      canonicalProjectionRepository,
    });

    if (!user) {
      return scimError(c, 404, 'The requested resource was not found');
    }

    // Check ETag if If-None-Match header is present
    const ifNoneMatch = c.req.header('If-None-Match');
    if (ifNoneMatch) {
      const currentEtag = generateEtag(user);
      if (ifNoneMatch === currentEtag) {
        return c.body(null, 304); // Not Modified
      }
    }

    const scimUser = userToScim(user, { baseUrl, includeGroups: true });

    // Set ETag header
    c.header('ETag', scimUser.meta.version || '');

    return c.json(scimUser);
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM get user error', { action: 'get_user' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * POST /scim/v2/Users - Create new user
 * PII/Non-PII DB separation: Insert into both Core and PII DBs
 */
app.post('/Users', async (c) => {
  try {
    const scimUser = await c.req.json<Partial<ScimUser>>();
    const baseUrl = getBaseUrl(c);
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const coreAdapter = authCtx.coreAdapter;
    const piiCtx = hasPIIDatabase(c) ? createPIIContextFromHono(c, tenantId) : null;
    const piiAdapter = piiCtx?.defaultPiiAdapter ?? null;
    if (!piiAdapter) {
      return scimError(c, 500, 'Configured PII store is not available');
    }

    // Validate required fields
    const validation = validateScimUser(scimUser);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Check for duplicate userName or email in PII DB via Adapter
    const primaryEmail =
      scimUser.emails?.find((e) => e.primary)?.value || scimUser.emails?.[0]?.value;

    if (primaryEmail) {
      const existing = await piiAdapter.queryOne<{ id: string }>(
        `SELECT owner_id as id
           FROM identity_sensitive_values
          WHERE tenant_id = ?
            AND owner_type = 'runtime_user'
            AND value_key = 'email'
            AND value_json = ?
            AND lifecycle_state = 'active'
          LIMIT 1`,
        [tenantId, JSON.stringify(primaryEmail)]
      );

      if (existing) {
        return scimError(c, 409, 'User with this email already exists', 'uniqueness');
      }
    }

    // Convert SCIM user to internal format
    const internalUser = scimToUser(scimUser);
    const customFieldValidation = await validateScimCustomClaimWrite(c, tenantId, internalUser);
    if (!customFieldValidation.ok) {
      return scimError(
        c,
        400,
        customFieldValidation.error,
        'invalidValue',
        toCustomClaimErrorExtensions(customFieldValidation)
      );
    }

    // Generate ID
    const userId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId);

    // Hash password if provided
    if (scimUser.password) {
      internalUser.password_hash = await hashPassword(scimUser.password);
    }

    // Set defaults
    if (!internalUser.email_verified) internalUser.email_verified = 0;
    if (internalUser.active === undefined) internalUser.active = 1;

    try {
      await maybeCreateCanonicalRuntimeUser(
        c,
        coreAdapter,
        piiAdapter,
        tenantId,
        userId,
        internalUser
      );
      await persistScimCustomClaimWrite(c, tenantId, userId, customFieldValidation);
    } catch (customFieldError) {
      const log = getLogger(c).module('SCIM');
      log.error(
        'SCIM create canonical/custom claim persistence failed',
        { action: 'create_user' },
        customFieldError as Error
      );

      try {
        await maybeDeleteCanonicalRuntimeUser(c, coreAdapter, piiAdapter, tenantId, userId);
      } catch (cleanupError) {
        log.error(
          'SCIM create rollback failed after custom claim persistence error',
          { action: 'create_user' },
          cleanupError as Error
        );
      }

      throw customFieldError;
    }

    const canonicalProjectionRepository = createCanonicalProjectionRepository(
      c,
      coreAdapter,
      piiAdapter,
      tenantId
    );

    // Fetch created user from the configured runtime source.
    const createdUser = await fetchUserWithPII(userId, {
      canonicalProjectionRepository,
      includeInactive: true,
    });

    if (!createdUser) {
      return scimError(c, 500, 'Failed to create user');
    }

    const responseUser = userToScim(createdUser, { baseUrl, includeGroups: false });

    // Set Location header
    c.header('Location', responseUser.meta.location);

    // Audit log (non-blocking)
    logScimAudit(c, 'scim.user.create', 'scim_user', userId, {
      externalId: scimUser.externalId,
    });

    return c.json(responseUser, 201);
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM create user error', { action: 'create_user' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * PUT /scim/v2/Users/{id} - Replace user (full update)
 * PII/Non-PII DB separation: Update both Core and PII DBs
 */
app.put('/Users/:id', async (c) => {
  try {
    const userId = c.req.param('id')!;
    const scimUser = await c.req.json<Partial<ScimUser>>();
    const baseUrl = getBaseUrl(c);
    const tenantId = getTenantIdFromContext(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const canonicalProjectionRepository = createCanonicalProjectionRepository(
      c,
      coreAdapter,
      piiAdapter,
      tenantId
    );
    if (!canonicalProjectionRepository || !piiAdapter) {
      return scimError(c, 500, 'Configured PII store is not available');
    }

    // Validate required fields
    const validation = validateScimUser(scimUser);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Check if user exists - fetch from both DBs
    const existingUser = await fetchUserWithPII(userId, { canonicalProjectionRepository });

    if (!existingUser) {
      return scimError(c, 404, 'The requested resource was not found');
    }

    // Check ETag if If-Match header is present
    const ifMatch = c.req.header('If-Match');
    if (ifMatch) {
      const currentEtag = generateEtag(existingUser);
      const requestEtag = parseEtag(ifMatch);
      if (requestEtag !== currentEtag.replace(/^W\/"|"$/g, '')) {
        return scimError(c, 412, 'Precondition failed - resource was modified', 'invalidVers');
      }
    }

    // Convert SCIM user to internal format
    const internalUser = scimToUser(scimUser);
    const customFieldValidation = await validateScimCustomClaimWrite(c, tenantId, internalUser, {
      userId,
      mergeExistingValues: false,
      deleteMissingFields: true,
    });
    if (!customFieldValidation.ok) {
      return scimError(
        c,
        400,
        customFieldValidation.error,
        'invalidValue',
        toCustomClaimErrorExtensions(customFieldValidation)
      );
    }
    internalUser.updated_at = new Date().toISOString();

    // Hash password if changed
    if (scimUser.password) {
      internalUser.password_hash = await hashPassword(scimUser.password);
    }

    await persistScimCustomClaimWrite(c, tenantId, userId, customFieldValidation);
    await maybeSyncCanonicalRuntimeUser(c, coreAdapter, piiAdapter, tenantId, userId, internalUser);

    // Invalidate user cache (cache invalidation hook)
    await invalidateUserCache(c.env, tenantId, userId);

    // Fetch updated user from the configured runtime source.
    const updatedUser = await fetchUserWithPII(userId, {
      canonicalProjectionRepository,
      includeInactive: true,
    });

    if (!updatedUser) {
      return scimError(c, 500, 'Failed to fetch updated user');
    }

    const responseUser = userToScim(updatedUser, { baseUrl, includeGroups: false });

    // Set ETag header
    c.header('ETag', responseUser.meta.version || '');

    // Audit log (non-blocking)
    logScimAudit(c, 'scim.user.replace', 'scim_user', userId, {
      externalId: scimUser.externalId,
    });

    return c.json(responseUser);
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM replace user error', { action: 'replace_user' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * PATCH /scim/v2/Users/{id} - Update user (partial update)
 * PII/Non-PII DB separation: Update both Core and PII DBs
 */
app.patch('/Users/:id', async (c) => {
  try {
    const userId = c.req.param('id')!;
    const patchOp = await c.req.json<ScimPatchOp>();
    const baseUrl = getBaseUrl(c);
    const tenantId = getTenantIdFromContext(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const canonicalProjectionRepository = createCanonicalProjectionRepository(
      c,
      coreAdapter,
      piiAdapter,
      tenantId
    );
    if (!canonicalProjectionRepository || !piiAdapter) {
      return scimError(c, 500, 'Configured PII store is not available');
    }

    // Check if user exists - fetch from both DBs
    const existingUser = await fetchUserWithPII(userId, { canonicalProjectionRepository });

    if (!existingUser) {
      return scimError(c, 404, 'The requested resource was not found');
    }

    // Check ETag if If-Match header is present
    const ifMatch = c.req.header('If-Match');
    if (ifMatch) {
      const currentEtag = generateEtag(existingUser);
      const requestEtag = parseEtag(ifMatch);
      if (requestEtag !== currentEtag.replace(/^W\/"|"$/g, '')) {
        return scimError(c, 412, 'Precondition failed - resource was modified', 'invalidVers');
      }
    }

    // Convert to SCIM format
    let scimUser = userToScim(existingUser, { baseUrl, includeGroups: false });

    // Apply patch operations (generic function preserves ScimUser type)
    scimUser = applyPatchOperations(scimUser, patchOp.Operations);

    // Validate after patching
    const validation = validateScimUser(scimUser);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Convert back to internal format
    const internalUser = scimToUser(scimUser);
    const customFieldValidation = await validateScimCustomClaimWrite(c, tenantId, internalUser, {
      userId,
      mergeExistingValues: true,
    });
    if (!customFieldValidation.ok) {
      return scimError(
        c,
        400,
        customFieldValidation.error,
        'invalidValue',
        toCustomClaimErrorExtensions(customFieldValidation)
      );
    }
    internalUser.updated_at = new Date().toISOString();

    // Hash password if changed
    if (scimUser.password) {
      internalUser.password_hash = await hashPassword(scimUser.password);
    }

    await persistScimCustomClaimWrite(c, tenantId, userId, customFieldValidation);
    await maybeSyncCanonicalRuntimeUser(c, coreAdapter, piiAdapter, tenantId, userId, internalUser);

    // Invalidate user cache (cache invalidation hook)
    await invalidateUserCache(c.env, tenantId, userId);

    // Fetch updated user from the configured runtime source.
    const updatedUser = await fetchUserWithPII(userId, {
      canonicalProjectionRepository,
      includeInactive: true,
    });

    if (!updatedUser) {
      return scimError(c, 500, 'Failed to fetch updated user');
    }

    const responseUser = userToScim(updatedUser, { baseUrl, includeGroups: false });

    // Set ETag header
    c.header('ETag', responseUser.meta.version || '');

    // Audit log (non-blocking)
    logScimAudit(c, 'scim.user.patch', 'scim_user', userId, {
      operations: patchOp.Operations?.length || 0,
    });

    return c.json(responseUser);
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM patch user error', { action: 'patch_user' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * DELETE /scim/v2/Users/{id} - Delete user
 * PII/Non-PII DB separation: Soft delete in Core, hard delete in PII
 */
app.delete('/Users/:id', async (c) => {
  try {
    const userId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const canonicalProjectionRepository = createCanonicalProjectionRepository(
      c,
      coreAdapter,
      piiAdapter,
      tenantId
    );
    if (!canonicalProjectionRepository || !piiAdapter) {
      return scimError(c, 500, 'Configured PII store is not available');
    }

    // Check if user exists - fetch from both DBs
    const existingUser = await fetchUserWithPII(userId, { canonicalProjectionRepository });

    if (!existingUser) {
      return scimError(c, 404, 'The requested resource was not found');
    }

    // Check ETag if If-Match header is present
    const ifMatch = c.req.header('If-Match');
    if (ifMatch) {
      const currentEtag = generateEtag(existingUser);
      const requestEtag = parseEtag(ifMatch);
      if (requestEtag !== currentEtag.replace(/^W\/"|"$/g, '')) {
        return scimError(c, 412, 'Precondition failed - resource was modified', 'invalidVers');
      }
    }

    const now = Date.now();
    const retentionDays = 90; // GDPR retention period

    // Step 1: Create tombstone record in PII DB for GDPR audit trail
    if (piiAdapter) {
      await piiAdapter
        .execute(
          `INSERT INTO users_pii_tombstone (
          id, tenant_id, deleted_at, deleted_by, deletion_reason, retention_until
        ) VALUES (?, ?, ?, 'scim_api', 'scim_delete', ?)`,
          [
            userId,
            existingUser.tenant_id || getTenantIdFromContext(c),
            now,
            now + retentionDays * 24 * 60 * 60 * 1000,
          ]
        )
        .catch(() => {
          // Ignore tombstone creation errors - not critical
        });
    }

    await maybeDeleteCanonicalRuntimeUser(c, coreAdapter, piiAdapter, tenantId, userId);

    // Audit log (non-blocking) - severity: warning for deletion
    logScimAudit(
      c,
      'scim.user.delete',
      'scim_user',
      userId,
      {
        externalId: existingUser.external_id,
      },
      'warning'
    );

    return c.body(null, 204); // No Content
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM delete user error', { action: 'delete_user' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

// ============================================================================
// SCIM Group Endpoints
// ============================================================================

/**
 * GET /scim/v2/Groups - List groups with filtering and pagination
 */
app.get('/Groups', async (c) => {
  try {
    const params = parseQueryParams(c);
    const baseUrl = getBaseUrl(c);
    const tenantId = getTenantIdFromContext(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    const startIndex = params.startIndex || 1;
    const count = Math.min(params.count || 100, 1000);
    const offset = startIndex - 1;

    let sql = 'SELECT * FROM roles WHERE tenant_id = ?';
    const sqlParams: (string | number | boolean | null)[] = [tenantId];

    // Apply filter if present
    if (params.filter) {
      try {
        const filterAst = parseScimFilter(params.filter);
        const attributeMap: Record<string, string> = {
          displayName: 'name',
          externalId: 'external_id',
        };
        const { sql: whereSql, params: whereParams } = filterToSql(filterAst, attributeMap);
        sql += ` AND ${whereSql}`;
        // Filter out undefined values from whereParams
        sqlParams.push(
          ...whereParams.filter((p): p is string | number | boolean | null => p !== undefined)
        );
      } catch (error) {
        // Log full error for debugging but don't expose to client
        const log = getLogger(c).module('SCIM');
        log.error('Invalid filter syntax', { action: 'list_groups' }, error as Error);
        // SECURITY: Do not expose filter parsing error details
        return scimError(c, 400, 'Invalid filter syntax', 'invalidFilter');
      }
    }

    // Get total count
    const countQuery = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
    const totalResult = await coreAdapter.queryOne<{ total: number }>(countQuery, sqlParams);
    const totalResults = totalResult?.total || 0;

    // Apply sorting with whitelist validation (prevents SQL injection)
    if (params.sortBy) {
      const sortColumn = validateSortColumn(params.sortBy, ALLOWED_GROUP_SORT_COLUMNS);
      if (!sortColumn) {
        return scimError(
          c,
          400,
          `Invalid sortBy attribute: ${params.sortBy}. Allowed values: ${Object.keys(ALLOWED_GROUP_SORT_COLUMNS).join(', ')}`,
          'invalidValue'
        );
      }
      const sortDirection = params.sortOrder === 'descending' ? 'DESC' : 'ASC';
      sql += ` ORDER BY ${sortColumn} ${sortDirection}`;
    } else {
      sql += ' ORDER BY created_at DESC';
    }

    // Apply pagination
    sql += ` LIMIT ? OFFSET ?`;
    sqlParams.push(count, offset);

    // Execute query
    const groups = await coreAdapter.query<InternalGroup>(sql, sqlParams);

    // Convert to SCIM format
    const scimGroups: ScimGroup[] = [];
    for (const group of groups) {
      // Fetch members if needed (PII/Non-PII DB separation)
      const members = await fetchGroupMembersWithPII(
        coreAdapter,
        createCanonicalProjectionRepository(c, coreAdapter, piiAdapter, tenantId),
        group.id as string,
        tenantId
      );

      scimGroups.push(groupToScim(group, { baseUrl, includeMembers: true }, members));
    }

    const response: ScimListResponse<ScimGroup> = {
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults,
      startIndex,
      itemsPerPage: scimGroups.length,
      Resources: scimGroups,
    };

    return c.json(response);
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM list groups error', { action: 'list_groups' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * GET /scim/v2/Groups/{id} - Get group by ID
 */
app.get('/Groups/:id', async (c) => {
  try {
    const groupId = c.req.param('id')!;
    const baseUrl = getBaseUrl(c);
    const tenantId = getTenantIdFromContext(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    const group = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
      [groupId, tenantId]
    );

    if (!group) {
      return scimError(c, 404, 'The requested resource was not found');
    }

    // Check ETag
    const ifNoneMatch = c.req.header('If-None-Match');
    if (ifNoneMatch) {
      const currentEtag = generateEtag(group);
      if (ifNoneMatch === currentEtag) {
        return c.body(null, 304);
      }
    }

    // Fetch members (PII/Non-PII DB separation)
    const members = await fetchGroupMembersWithPII(
      coreAdapter,
      createCanonicalProjectionRepository(c, coreAdapter, piiAdapter, tenantId),
      groupId,
      tenantId
    );

    const scimGroup = groupToScim(group, { baseUrl, includeMembers: true }, members);

    // Set ETag header
    c.header('ETag', scimGroup.meta.version || '');

    return c.json(scimGroup);
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM get group error', { action: 'get_group' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * POST /scim/v2/Groups - Create new group
 */
app.post('/Groups', async (c) => {
  try {
    const scimGroup = await c.req.json<Partial<ScimGroup>>();
    const baseUrl = getBaseUrl(c);
    const tenantId = getTenantIdFromContext(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Validate required fields
    const validation = validateScimGroup(scimGroup);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Check for duplicate displayName
    const existing = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM roles WHERE name = ? AND tenant_id = ?',
      [scimGroup.displayName, tenantId]
    );

    if (existing) {
      return scimError(c, 409, 'Group with this name already exists', 'uniqueness');
    }

    // Convert SCIM group to internal format
    const internalGroup = scimToGroup(scimGroup);

    // Generate ID
    const groupId = generateId();

    // Set timestamps
    const now = new Date().toISOString();

    const memberIds = resolveScimGroupMemberIds(scimGroup.members);
    const missingMemberIds = await findMissingTenantUserIds(coreAdapter, tenantId, memberIds);
    if (missingMemberIds.length > 0) {
      return scimError(c, 400, 'Group member does not exist in this tenant', 'invalidValue');
    }

    // Insert group
    await coreAdapter.execute(
      `INSERT INTO roles (id, tenant_id, name, description, permissions_json, external_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        groupId,
        tenantId,
        internalGroup.name,
        internalGroup.description || null,
        JSON.stringify([]), // Empty permissions by default
        internalGroup.external_id,
        now,
      ]
    );

    await insertTenantGroupMembers(coreAdapter, tenantId, groupId, memberIds, now);

    // Fetch created group
    const createdGroup = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
      [groupId, tenantId]
    );

    if (!createdGroup) {
      return scimError(c, 500, 'Failed to create group');
    }

    // Fetch members (PII/Non-PII DB separation)
    const members = await fetchGroupMembersWithPII(
      coreAdapter,
      createCanonicalProjectionRepository(c, coreAdapter, piiAdapter, tenantId),
      groupId,
      tenantId
    );

    const responseGroup = groupToScim(createdGroup, { baseUrl, includeMembers: true }, members);

    // Set Location header
    c.header('Location', responseGroup.meta.location);

    // Audit log (non-blocking)
    logScimAudit(c, 'scim.group.create', 'scim_group', groupId, {
      displayName: scimGroup.displayName,
      externalId: scimGroup.externalId,
      memberCount: scimGroup.members?.length || 0,
    });

    return c.json(responseGroup, 201);
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM create group error', { action: 'create_group' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * PUT /scim/v2/Groups/{id} - Replace group
 */
app.put('/Groups/:id', async (c) => {
  try {
    const groupId = c.req.param('id')!;
    const scimGroup = await c.req.json<Partial<ScimGroup>>();
    const baseUrl = getBaseUrl(c);
    const tenantId = getTenantIdFromContext(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Validate required fields
    const validation = validateScimGroup(scimGroup);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Check if group exists
    const existingGroup = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
      [groupId, tenantId]
    );

    if (!existingGroup) {
      return scimError(c, 404, 'The requested resource was not found');
    }

    // Check ETag
    const ifMatch = c.req.header('If-Match');
    if (ifMatch) {
      const currentEtag = generateEtag(existingGroup);
      const requestEtag = parseEtag(ifMatch);
      if (requestEtag !== currentEtag.replace(/^W\/"|"$/g, '')) {
        return scimError(c, 412, 'Precondition failed - resource was modified', 'invalidVers');
      }
    }

    // Convert SCIM group to internal format
    const internalGroup = scimToGroup(scimGroup);

    // Update group
    await coreAdapter.execute(
      `UPDATE roles SET name = ?, description = ?, external_id = ? WHERE id = ? AND tenant_id = ?`,
      [internalGroup.name, internalGroup.description, internalGroup.external_id, groupId, tenantId]
    );

    // Update members (replace all)
    await coreAdapter.execute('DELETE FROM user_roles WHERE tenant_id = ? AND role_id = ?', [
      tenantId,
      groupId,
    ]);

    const memberIds = resolveScimGroupMemberIds(scimGroup.members);
    const missingMemberIds = await findMissingTenantUserIds(coreAdapter, tenantId, memberIds);
    if (missingMemberIds.length > 0) {
      return scimError(c, 400, 'Group member does not exist in this tenant', 'invalidValue');
    }

    if (memberIds.length > 0) {
      const now = new Date().toISOString();
      await insertTenantGroupMembers(coreAdapter, tenantId, groupId, memberIds, now);
    }

    // Fetch updated group
    const updatedGroup = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
      [groupId, tenantId]
    );

    if (!updatedGroup) {
      return scimError(c, 500, 'Failed to fetch updated group');
    }

    // Fetch members (PII/Non-PII DB separation)
    const members = await fetchGroupMembersWithPII(
      coreAdapter,
      createCanonicalProjectionRepository(c, coreAdapter, piiAdapter, tenantId),
      groupId,
      tenantId
    );

    const responseGroup = groupToScim(updatedGroup, { baseUrl, includeMembers: true }, members);

    // Set ETag header
    c.header('ETag', responseGroup.meta.version || '');

    // Audit log (non-blocking)
    logScimAudit(c, 'scim.group.replace', 'scim_group', groupId, {
      displayName: scimGroup.displayName,
      externalId: scimGroup.externalId,
      memberCount: scimGroup.members?.length || 0,
    });

    return c.json(responseGroup);
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM replace group error', { action: 'replace_group' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * PATCH /scim/v2/Groups/{id} - Update group (partial update)
 */
app.patch('/Groups/:id', async (c) => {
  try {
    const groupId = c.req.param('id')!;
    const patchOp = await c.req.json<ScimPatchOp>();
    const baseUrl = getBaseUrl(c);
    const tenantId = getTenantIdFromContext(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Check if group exists
    const existingGroup = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
      [groupId, tenantId]
    );

    if (!existingGroup) {
      return scimError(c, 404, 'The requested resource was not found');
    }

    // Check ETag
    const ifMatch = c.req.header('If-Match');
    if (ifMatch) {
      const currentEtag = generateEtag(existingGroup);
      const requestEtag = parseEtag(ifMatch);
      if (requestEtag !== currentEtag.replace(/^W\/"|"$/g, '')) {
        return scimError(c, 412, 'Precondition failed - resource was modified', 'invalidVers');
      }
    }

    // Fetch current members (PII/Non-PII DB separation)
    const currentMembers = await fetchGroupMembersWithPII(
      coreAdapter,
      createCanonicalProjectionRepository(c, coreAdapter, piiAdapter, tenantId),
      groupId,
      tenantId
    );

    // Convert to SCIM format
    let scimGroup = groupToScim(existingGroup, { baseUrl, includeMembers: true }, currentMembers);

    // Apply patch operations (generic function preserves ScimGroup type)
    scimGroup = applyPatchOperations(scimGroup, patchOp.Operations);

    // Validate after patching
    const validation = validateScimGroup(scimGroup);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Convert back to internal format
    const internalGroup = scimToGroup(scimGroup);

    // Update group
    await coreAdapter.execute(
      `UPDATE roles SET name = ?, description = ?, external_id = ? WHERE id = ? AND tenant_id = ?`,
      [internalGroup.name, internalGroup.description, internalGroup.external_id, groupId, tenantId]
    );

    // Update members if changed
    if (scimGroup.members !== undefined) {
      const memberIds = resolveScimGroupMemberIds(scimGroup.members);
      const missingMemberIds = await findMissingTenantUserIds(coreAdapter, tenantId, memberIds);
      if (missingMemberIds.length > 0) {
        return scimError(c, 400, 'Group member does not exist in this tenant', 'invalidValue');
      }

      await coreAdapter.execute('DELETE FROM user_roles WHERE tenant_id = ? AND role_id = ?', [
        tenantId,
        groupId,
      ]);

      if (memberIds.length > 0) {
        const now = new Date().toISOString();
        await insertTenantGroupMembers(coreAdapter, tenantId, groupId, memberIds, now);
      }
    }

    // Fetch updated group
    const updatedGroup = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
      [groupId, tenantId]
    );

    if (!updatedGroup) {
      return scimError(c, 500, 'Failed to fetch updated group');
    }

    // Fetch updated members (PII/Non-PII DB separation)
    const updatedMembers = await fetchGroupMembersWithPII(
      coreAdapter,
      createCanonicalProjectionRepository(c, coreAdapter, piiAdapter, tenantId),
      groupId,
      tenantId
    );

    const responseGroup = groupToScim(
      updatedGroup,
      { baseUrl, includeMembers: true },
      updatedMembers
    );

    // Set ETag header
    c.header('ETag', responseGroup.meta.version || '');

    // Audit log (non-blocking)
    logScimAudit(c, 'scim.group.patch', 'scim_group', groupId, {
      operations: patchOp.Operations?.length || 0,
    });

    return c.json(responseGroup);
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM patch group error', { action: 'patch_group' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * DELETE /scim/v2/Groups/{id} - Delete group
 */
app.delete('/Groups/:id', async (c) => {
  try {
    const groupId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Check if group exists
    const existingGroup = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
      [groupId, tenantId]
    );

    if (!existingGroup) {
      return scimError(c, 404, 'The requested resource was not found');
    }

    // Check ETag
    const ifMatch = c.req.header('If-Match');
    if (ifMatch) {
      const currentEtag = generateEtag(existingGroup);
      const requestEtag = parseEtag(ifMatch);
      if (requestEtag !== currentEtag.replace(/^W\/"|"$/g, '')) {
        return scimError(c, 412, 'Precondition failed - resource was modified', 'invalidVers');
      }
    }

    // Delete group (cascade will handle user_roles)
    await coreAdapter.execute('DELETE FROM user_roles WHERE tenant_id = ? AND role_id = ?', [
      tenantId,
      groupId,
    ]);
    await coreAdapter.execute('DELETE FROM roles WHERE id = ? AND tenant_id = ?', [
      groupId,
      tenantId,
    ]);

    // Audit log (non-blocking) - severity: warning for deletion
    logScimAudit(
      c,
      'scim.group.delete',
      'scim_group',
      groupId,
      {
        displayName: existingGroup.name,
        externalId: existingGroup.external_id,
      },
      'warning'
    );

    return c.body(null, 204); // No Content
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM delete group error', { action: 'delete_group' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

// ============================================================================
// SCIM Bulk Operations (RFC 7644 Section 3.7)
// ============================================================================

/**
 * Default bulk operation limits
 */
const DEFAULT_BULK_MAX_OPERATIONS = 100;
const DEFAULT_BULK_MAX_PAYLOAD_SIZE = 1048576; // 1MB

/**
 * Get bulk operation config from KV with defaults
 */
async function getBulkConfig(env: Env): Promise<BulkOperationConfig> {
  let maxOperations = DEFAULT_BULK_MAX_OPERATIONS;
  let maxPayloadSize = DEFAULT_BULK_MAX_PAYLOAD_SIZE;

  if (env.KV) {
    try {
      const maxOpsStr = await env.KV.get('SCIM_BULK_MAX_OPERATIONS');
      if (maxOpsStr) {
        const parsed = parseInt(maxOpsStr, 10);
        if (!isNaN(parsed) && parsed > 0) {
          maxOperations = parsed;
        }
      }
      const maxSizeStr = await env.KV.get('SCIM_BULK_MAX_PAYLOAD_SIZE');
      if (maxSizeStr) {
        const parsed = parseInt(maxSizeStr, 10);
        if (!isNaN(parsed) && parsed > 0) {
          maxPayloadSize = parsed;
        }
      }
    } catch {
      // Use defaults on error
    }
  }

  return { maxOperations, maxPayloadSize };
}

/**
 * Resolve bulkId references in request data
 *
 * Replaces "bulkId:xyz" references with actual created resource IDs
 */
function resolveBulkIdReferences(
  data: Record<string, unknown>,
  bulkIdMap: Map<string, string>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && value.startsWith('bulkId:')) {
      const bulkId = value.substring(7); // Remove "bulkId:" prefix
      const resolvedId = bulkIdMap.get(bulkId);
      if (resolvedId) {
        result[key] = resolvedId;
      } else {
        // Keep original if not yet resolved (will fail later)
        result[key] = value;
      }
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'object' && item !== null) {
          return resolveBulkIdReferences(item as Record<string, unknown>, bulkIdMap);
        }
        if (typeof item === 'string' && item.startsWith('bulkId:')) {
          const bulkId = item.substring(7);
          return bulkIdMap.get(bulkId) || item;
        }
        return item;
      });
    } else if (typeof value === 'object' && value !== null) {
      result[key] = resolveBulkIdReferences(value as Record<string, unknown>, bulkIdMap);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * POST /scim/v2/Bulk - Bulk Operations
 *
 * RFC 7644 Section 3.7 - Bulk operations allow clients to perform
 * multiple operations in a single request.
 */
app.post('/Bulk', async (c) => {
  try {
    const tenantId = getTenantIdFromContext(c);
    const baseUrl = getBaseUrl(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Get bulk config from KV
    const bulkConfig = await getBulkConfig(c.env);

    // Check Content-Length if available
    const contentLength = c.req.header('Content-Length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (size > bulkConfig.maxPayloadSize) {
        return scimError(
          c,
          413,
          `Request payload exceeds maximum size of ${bulkConfig.maxPayloadSize} bytes`,
          'tooMany'
        );
      }
    }

    // Parse request body
    let bulkRequest: ScimBulkRequest;
    try {
      bulkRequest = await c.req.json<ScimBulkRequest>();
    } catch {
      return scimError(c, 400, 'Invalid JSON request body', 'invalidSyntax');
    }

    // Validate schema
    if (!bulkRequest.schemas || !bulkRequest.schemas.includes(SCIM_BULK_SCHEMAS.BULK_REQUEST)) {
      return scimError(
        c,
        400,
        `Request must include schema: ${SCIM_BULK_SCHEMAS.BULK_REQUEST}`,
        'invalidSyntax'
      );
    }

    // Validate operations array
    if (!Array.isArray(bulkRequest.Operations)) {
      return scimError(c, 400, 'Operations must be an array', 'invalidSyntax');
    }

    // Check operation count limit
    if (bulkRequest.Operations.length > bulkConfig.maxOperations) {
      return scimError(
        c,
        413,
        `Number of operations (${bulkRequest.Operations.length}) exceeds maximum of ${bulkConfig.maxOperations}`,
        'tooMany'
      );
    }

    // Process operations
    const failOnErrors = bulkRequest.failOnErrors ?? 0;
    let errorCount = 0;
    const results: ScimBulkOperationResponse[] = [];
    const bulkIdMap = new Map<string, string>(); // bulkId -> created resource ID

    for (const operation of bulkRequest.Operations) {
      // Check if we should stop processing
      if (failOnErrors > 0 && errorCount >= failOnErrors) {
        break;
      }

      const result = await processOperation(
        operation,
        bulkIdMap,
        tenantId,
        baseUrl,
        coreAdapter,
        piiAdapter,
        c
      );

      results.push(result);

      // Track errors
      const statusCode = parseInt(result.status, 10);
      if (statusCode >= 400) {
        errorCount++;
      }
    }

    // Build response
    const response: ScimBulkResponse = {
      schemas: [SCIM_BULK_SCHEMAS.BULK_RESPONSE],
      Operations: results,
    };

    // Audit log (non-blocking)
    logScimAudit(c, 'scim.bulk.execute', 'scim_user', 'bulk', {
      total: results.length,
      succeeded: results.length - errorCount,
      failed: errorCount,
    });

    return c.json(response, 200);
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM bulk operation error', { action: 'bulk' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * Process a single bulk operation
 */
async function processOperation(
  operation: ScimBulkOperation,
  bulkIdMap: Map<string, string>,
  tenantId: string,
  baseUrl: string,
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter | null,
  c: Context<{ Bindings: Env }>
): Promise<ScimBulkOperationResponse> {
  const { method, path, bulkId, version, data } = operation;

  // Validate path
  const pathMatch = path.match(/^\/(Users|Groups)(\/(.+))?$/);
  if (!pathMatch) {
    return {
      method,
      bulkId,
      status: '400',
      response: {
        schemas: [SCIM_SCHEMAS.ERROR],
        status: '400',
        detail: `Invalid path: ${path}. Must be /Users, /Users/{id}, /Groups, or /Groups/{id}`,
      },
    };
  }

  const resourceType = pathMatch[1] as 'Users' | 'Groups';
  const resourceId = pathMatch[3]; // May be undefined for POST

  // Validate method requirements
  if (method === 'POST' && resourceId) {
    return {
      method,
      bulkId,
      status: '400',
      response: {
        schemas: [SCIM_SCHEMAS.ERROR],
        status: '400',
        detail: 'POST operations must not include resource ID in path',
      },
    };
  }

  if (['PUT', 'PATCH', 'DELETE'].includes(method) && !resourceId) {
    return {
      method,
      bulkId,
      status: '400',
      response: {
        schemas: [SCIM_SCHEMAS.ERROR],
        status: '400',
        detail: `${method} operations require resource ID in path`,
      },
    };
  }

  if (['POST', 'PUT', 'PATCH'].includes(method) && !data) {
    return {
      method,
      bulkId,
      status: '400',
      response: {
        schemas: [SCIM_SCHEMAS.ERROR],
        status: '400',
        detail: `${method} operations require request body`,
      },
    };
  }

  // Resolve bulkId references in data
  const resolvedData = data ? resolveBulkIdReferences(data, bulkIdMap) : undefined;

  try {
    if (resourceType === 'Users') {
      return await processUserOperation(
        method,
        resourceId,
        resolvedData,
        bulkId,
        version,
        tenantId,
        baseUrl,
        coreAdapter,
        piiAdapter,
        bulkIdMap,
        c
      );
    } else {
      return await processGroupOperation(
        method,
        resourceId,
        resolvedData,
        bulkId,
        version,
        tenantId,
        baseUrl,
        coreAdapter,
        piiAdapter,
        bulkIdMap,
        c
      );
    }
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error(
      'SCIM bulk operation error',
      { action: 'bulk_operation', method, path },
      error as Error
    );
    return {
      method,
      bulkId,
      status: '500',
      response: {
        schemas: [SCIM_SCHEMAS.ERROR],
        status: '500',
        detail: 'Internal server error processing operation',
      },
    };
  }
}

/**
 * Process a user bulk operation
 */
async function processUserOperation(
  method: string,
  resourceId: string | undefined,
  data: Record<string, unknown> | undefined,
  bulkId: string | undefined,
  version: string | undefined,
  tenantId: string,
  baseUrl: string,
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter | null,
  bulkIdMap: Map<string, string>,
  c: Context<{ Bindings: Env }>
): Promise<ScimBulkOperationResponse> {
  const canonicalProjectionRepository = createCanonicalProjectionRepository(
    c,
    coreAdapter,
    piiAdapter,
    tenantId
  );
  if (!canonicalProjectionRepository || !piiAdapter) {
    return {
      method: method as ScimBulkMethod,
      bulkId,
      status: '500',
      response: {
        schemas: [SCIM_SCHEMAS.ERROR],
        status: '500',
        detail: 'Configured PII store is not available',
      },
    };
  }

  switch (method) {
    case 'POST': {
      // Create user
      const scimUser = data as Partial<ScimUser>;
      const validation = validateScimUser(scimUser);
      if (!validation.valid) {
        return {
          method: 'POST',
          bulkId,
          status: '400',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '400',
            detail: validation.errors.join(', '),
            scimType: 'invalidValue',
          },
        };
      }

      // Check for duplicate email
      const primaryEmail =
        scimUser.emails?.find((e) => e.primary)?.value || scimUser.emails?.[0]?.value;
      if (primaryEmail) {
        const existing = await piiAdapter.queryOne<{ id: string }>(
          `SELECT owner_id as id
             FROM identity_sensitive_values
            WHERE tenant_id = ?
              AND owner_type = 'runtime_user'
              AND value_key = 'email'
              AND value_json = ?
              AND lifecycle_state = 'active'
            LIMIT 1`,
          [tenantId, JSON.stringify(primaryEmail)]
        );
        if (existing) {
          return {
            method: 'POST',
            bulkId,
            status: '409',
            response: {
              schemas: [SCIM_SCHEMAS.ERROR],
              status: '409',
              detail: 'User with this email already exists',
              scimType: 'uniqueness',
            },
          };
        }
      }

      // Convert and create
      const internalUser = scimToUser(scimUser);
      const customFieldValidation = await validateScimCustomClaimWrite(c, tenantId, internalUser);
      if (!customFieldValidation.ok) {
        return {
          method: 'POST',
          bulkId,
          status: '400',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '400',
            detail: customFieldValidation.error,
            scimType: 'invalidValue',
            ...toCustomClaimErrorExtensions(customFieldValidation),
          },
        };
      }
      const userId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId);
      const now = new Date().toISOString();
      internalUser.created_at = now;
      internalUser.updated_at = now;
      if (!internalUser.email_verified) internalUser.email_verified = 0;
      if (internalUser.active === undefined) internalUser.active = 1;

      // Hash password if provided
      if (scimUser.password) {
        internalUser.password_hash = await hashPassword(scimUser.password);
      }

      await maybeCreateCanonicalRuntimeUser(
        c,
        coreAdapter,
        piiAdapter,
        tenantId,
        userId,
        internalUser
      );
      await persistScimCustomClaimWrite(c, tenantId, userId, customFieldValidation);

      // Store bulkId mapping for cross-references
      if (bulkId) {
        bulkIdMap.set(bulkId, userId);
      }

      // Fetch created user from the configured runtime source.
      const createdUser = await fetchUserWithPII(userId, {
        canonicalProjectionRepository,
        includeInactive: true,
      });
      const responseUser = createdUser
        ? userToScim(createdUser, { baseUrl, includeGroups: false })
        : null;

      return {
        method: 'POST',
        bulkId,
        version: responseUser?.meta.version,
        location: `${baseUrl}/scim/v2/Users/${userId}`,
        status: '201',
        response: responseUser ? (responseUser as unknown as Record<string, unknown>) : undefined,
      };
    }

    case 'PUT': {
      // Replace user
      const existingUser = await fetchUserWithPII(resourceId!, { canonicalProjectionRepository });
      if (!existingUser) {
        return {
          method: 'PUT',
          status: '404',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '404',
            detail: 'Resource not found',
          },
        };
      }

      // Check ETag if version provided
      if (version) {
        const currentEtag = generateEtag(existingUser);
        if (version !== currentEtag.replace(/^W\/"|"$/g, '')) {
          return {
            method: 'PUT',
            status: '412',
            response: {
              schemas: [SCIM_SCHEMAS.ERROR],
              status: '412',
              detail: 'Precondition failed - resource was modified',
              scimType: 'invalidVers',
            },
          };
        }
      }

      const scimUser = data as Partial<ScimUser>;
      const validation = validateScimUser(scimUser);
      if (!validation.valid) {
        return {
          method: 'PUT',
          status: '400',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '400',
            detail: validation.errors.join(', '),
            scimType: 'invalidValue',
          },
        };
      }

      const internalUser = scimToUser(scimUser);
      const customFieldValidation = await validateScimCustomClaimWrite(c, tenantId, internalUser, {
        userId: resourceId,
        mergeExistingValues: false,
        deleteMissingFields: true,
      });
      if (!customFieldValidation.ok) {
        return {
          method: 'PUT',
          status: '400',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '400',
            detail: customFieldValidation.error,
            scimType: 'invalidValue',
            ...toCustomClaimErrorExtensions(customFieldValidation),
          },
        };
      }
      internalUser.updated_at = new Date().toISOString();

      if (scimUser.password) {
        internalUser.password_hash = await hashPassword(scimUser.password);
      }

      await persistScimCustomClaimWrite(c, tenantId, resourceId!, customFieldValidation);
      await maybeSyncCanonicalRuntimeUser(
        c,
        coreAdapter,
        piiAdapter,
        tenantId,
        resourceId!,
        internalUser
      );

      await invalidateUserCache(c.env, tenantId, resourceId!);

      const updatedUser = await fetchUserWithPII(resourceId!, {
        canonicalProjectionRepository,
        includeInactive: true,
      });
      const responseUser = updatedUser
        ? userToScim(updatedUser, { baseUrl, includeGroups: false })
        : null;

      return {
        method: 'PUT',
        version: responseUser?.meta.version,
        location: `${baseUrl}/scim/v2/Users/${resourceId}`,
        status: '200',
        response: responseUser ? (responseUser as unknown as Record<string, unknown>) : undefined,
      };
    }

    case 'PATCH': {
      // Partial update user
      const existingUser = await fetchUserWithPII(resourceId!, { canonicalProjectionRepository });
      if (!existingUser) {
        return {
          method: 'PATCH',
          status: '404',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '404',
            detail: 'Resource not found',
          },
        };
      }

      // Check ETag if version provided
      if (version) {
        const currentEtag = generateEtag(existingUser);
        if (version !== currentEtag.replace(/^W\/"|"$/g, '')) {
          return {
            method: 'PATCH',
            status: '412',
            response: {
              schemas: [SCIM_SCHEMAS.ERROR],
              status: '412',
              detail: 'Precondition failed - resource was modified',
              scimType: 'invalidVers',
            },
          };
        }
      }

      const patchOp = data as unknown as ScimPatchOp;
      let scimUser = userToScim(existingUser, { baseUrl, includeGroups: false });
      scimUser = applyPatchOperations(scimUser, patchOp.Operations);

      const validation = validateScimUser(scimUser);
      if (!validation.valid) {
        return {
          method: 'PATCH',
          status: '400',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '400',
            detail: validation.errors.join(', '),
            scimType: 'invalidValue',
          },
        };
      }

      const internalUser = scimToUser(scimUser);
      const customFieldValidation = await validateScimCustomClaimWrite(c, tenantId, internalUser, {
        userId: resourceId,
        mergeExistingValues: true,
      });
      if (!customFieldValidation.ok) {
        return {
          method: 'PATCH',
          status: '400',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '400',
            detail: customFieldValidation.error,
            scimType: 'invalidValue',
            ...toCustomClaimErrorExtensions(customFieldValidation),
          },
        };
      }
      internalUser.updated_at = new Date().toISOString();

      if (scimUser.password) {
        internalUser.password_hash = await hashPassword(scimUser.password);
      }

      await persistScimCustomClaimWrite(c, tenantId, resourceId!, customFieldValidation);
      await maybeSyncCanonicalRuntimeUser(
        c,
        coreAdapter,
        piiAdapter,
        tenantId,
        resourceId!,
        internalUser
      );

      await invalidateUserCache(c.env, tenantId, resourceId!);

      const updatedUser = await fetchUserWithPII(resourceId!, {
        canonicalProjectionRepository,
        includeInactive: true,
      });
      const responseUser = updatedUser
        ? userToScim(updatedUser, { baseUrl, includeGroups: false })
        : null;

      return {
        method: 'PATCH',
        version: responseUser?.meta.version,
        location: `${baseUrl}/scim/v2/Users/${resourceId}`,
        status: '200',
        response: responseUser ? (responseUser as unknown as Record<string, unknown>) : undefined,
      };
    }

    case 'DELETE': {
      // Delete user
      const existingUser = await fetchUserWithPII(resourceId!, { canonicalProjectionRepository });
      if (!existingUser) {
        return {
          method: 'DELETE',
          status: '404',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '404',
            detail: 'Resource not found',
          },
        };
      }

      // Check ETag if version provided
      if (version) {
        const currentEtag = generateEtag(existingUser);
        if (version !== currentEtag.replace(/^W\/"|"$/g, '')) {
          return {
            method: 'DELETE',
            status: '412',
            response: {
              schemas: [SCIM_SCHEMAS.ERROR],
              status: '412',
              detail: 'Precondition failed - resource was modified',
              scimType: 'invalidVers',
            },
          };
        }
      }

      await maybeDeleteCanonicalRuntimeUser(c, coreAdapter, piiAdapter, tenantId, resourceId!);

      return {
        method: 'DELETE',
        status: '204',
      };
    }

    default:
      return {
        method: method as ScimBulkMethod,
        status: '400',
        response: {
          schemas: [SCIM_SCHEMAS.ERROR],
          status: '400',
          detail: `Unsupported method: ${method}`,
        },
      };
  }
}

/**
 * Process a group bulk operation
 */
async function processGroupOperation(
  method: string,
  resourceId: string | undefined,
  data: Record<string, unknown> | undefined,
  bulkId: string | undefined,
  version: string | undefined,
  tenantId: string,
  baseUrl: string,
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter | null,
  bulkIdMap: Map<string, string>,
  c: Context<{ Bindings: Env }>
): Promise<ScimBulkOperationResponse> {
  const canonicalProjectionRepository = createCanonicalProjectionRepository(
    c,
    coreAdapter,
    piiAdapter,
    tenantId
  );
  if (!canonicalProjectionRepository) {
    return {
      method: method as ScimBulkMethod,
      bulkId,
      status: '500',
      response: {
        schemas: [SCIM_SCHEMAS.ERROR],
        status: '500',
        detail: 'Configured PII store is not available',
      },
    };
  }

  switch (method) {
    case 'POST': {
      // Create group
      const scimGroup = data as Partial<ScimGroup>;
      const validation = validateScimGroup(scimGroup);
      if (!validation.valid) {
        return {
          method: 'POST',
          bulkId,
          status: '400',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '400',
            detail: validation.errors.join(', '),
            scimType: 'invalidValue',
          },
        };
      }

      // Check for duplicate
      const existing = await coreAdapter.queryOne<{ id: string }>(
        'SELECT id FROM roles WHERE name = ? AND tenant_id = ?',
        [scimGroup.displayName, tenantId]
      );
      if (existing) {
        return {
          method: 'POST',
          bulkId,
          status: '409',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '409',
            detail: 'Group with this name already exists',
            scimType: 'uniqueness',
          },
        };
      }

      const internalGroup = scimToGroup(scimGroup);
      const groupId = generateId();
      const now = new Date().toISOString();

      const memberIds = resolveScimGroupMemberIds(scimGroup.members, bulkIdMap);
      const missingMemberIds = await findMissingTenantUserIds(coreAdapter, tenantId, memberIds);
      if (missingMemberIds.length > 0) {
        return invalidGroupMemberBulkResponse('POST', bulkId);
      }

      await coreAdapter.execute(
        `INSERT INTO roles (id, tenant_id, name, description, permissions_json, external_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          groupId,
          tenantId,
          internalGroup.name,
          internalGroup.description || null,
          JSON.stringify([]),
          internalGroup.external_id,
          now,
        ]
      );

      await insertTenantGroupMembers(coreAdapter, tenantId, groupId, memberIds, now);

      // Store bulkId mapping
      if (bulkId) {
        bulkIdMap.set(bulkId, groupId);
      }

      const createdGroup = await coreAdapter.queryOne<InternalGroup>(
        'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
        [groupId, tenantId]
      );
      const members = await fetchGroupMembersWithPII(
        coreAdapter,
        canonicalProjectionRepository,
        groupId,
        tenantId
      );
      const responseGroup = createdGroup
        ? groupToScim(createdGroup, { baseUrl, includeMembers: true }, members)
        : null;

      return {
        method: 'POST',
        bulkId,
        version: responseGroup?.meta.version,
        location: `${baseUrl}/scim/v2/Groups/${groupId}`,
        status: '201',
        response: responseGroup ? (responseGroup as unknown as Record<string, unknown>) : undefined,
      };
    }

    case 'PUT': {
      // Replace group
      const existingGroup = await coreAdapter.queryOne<InternalGroup>(
        'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
        [resourceId, tenantId]
      );
      if (!existingGroup) {
        return {
          method: 'PUT',
          status: '404',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '404',
            detail: 'Resource not found',
          },
        };
      }

      if (version) {
        const currentEtag = generateEtag(existingGroup);
        if (version !== currentEtag.replace(/^W\/"|"$/g, '')) {
          return {
            method: 'PUT',
            status: '412',
            response: {
              schemas: [SCIM_SCHEMAS.ERROR],
              status: '412',
              detail: 'Precondition failed - resource was modified',
              scimType: 'invalidVers',
            },
          };
        }
      }

      const scimGroup = data as Partial<ScimGroup>;
      const validation = validateScimGroup(scimGroup);
      if (!validation.valid) {
        return {
          method: 'PUT',
          status: '400',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '400',
            detail: validation.errors.join(', '),
            scimType: 'invalidValue',
          },
        };
      }

      const internalGroup = scimToGroup(scimGroup);

      await coreAdapter.execute(
        `UPDATE roles SET name = ?, description = ?, external_id = ? WHERE id = ? AND tenant_id = ?`,
        [
          internalGroup.name,
          internalGroup.description,
          internalGroup.external_id,
          resourceId,
          tenantId,
        ]
      );

      // Update members
      await coreAdapter.execute('DELETE FROM user_roles WHERE tenant_id = ? AND role_id = ?', [
        tenantId,
        resourceId,
      ]);
      const memberIds = resolveScimGroupMemberIds(scimGroup.members, bulkIdMap);
      const missingMemberIds = await findMissingTenantUserIds(coreAdapter, tenantId, memberIds);
      if (missingMemberIds.length > 0) {
        return invalidGroupMemberBulkResponse('PUT');
      }

      if (memberIds.length > 0) {
        const now = new Date().toISOString();
        await insertTenantGroupMembers(coreAdapter, tenantId, resourceId!, memberIds, now);
      }

      const updatedGroup = await coreAdapter.queryOne<InternalGroup>(
        'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
        [resourceId, tenantId]
      );
      const members = await fetchGroupMembersWithPII(
        coreAdapter,
        canonicalProjectionRepository,
        resourceId!,
        tenantId
      );
      const responseGroup = updatedGroup
        ? groupToScim(updatedGroup, { baseUrl, includeMembers: true }, members)
        : null;

      return {
        method: 'PUT',
        version: responseGroup?.meta.version,
        location: `${baseUrl}/scim/v2/Groups/${resourceId}`,
        status: '200',
        response: responseGroup ? (responseGroup as unknown as Record<string, unknown>) : undefined,
      };
    }

    case 'PATCH': {
      // Partial update group
      const existingGroup = await coreAdapter.queryOne<InternalGroup>(
        'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
        [resourceId, tenantId]
      );
      if (!existingGroup) {
        return {
          method: 'PATCH',
          status: '404',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '404',
            detail: 'Resource not found',
          },
        };
      }

      if (version) {
        const currentEtag = generateEtag(existingGroup);
        if (version !== currentEtag.replace(/^W\/"|"$/g, '')) {
          return {
            method: 'PATCH',
            status: '412',
            response: {
              schemas: [SCIM_SCHEMAS.ERROR],
              status: '412',
              detail: 'Precondition failed - resource was modified',
              scimType: 'invalidVers',
            },
          };
        }
      }

      const currentMembers = await fetchGroupMembersWithPII(
        coreAdapter,
        canonicalProjectionRepository,
        resourceId!,
        tenantId
      );
      let scimGroup = groupToScim(existingGroup, { baseUrl, includeMembers: true }, currentMembers);

      const patchOp = data as unknown as ScimPatchOp;
      scimGroup = applyPatchOperations(scimGroup, patchOp.Operations);

      const validation = validateScimGroup(scimGroup);
      if (!validation.valid) {
        return {
          method: 'PATCH',
          status: '400',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '400',
            detail: validation.errors.join(', '),
            scimType: 'invalidValue',
          },
        };
      }

      const internalGroup = scimToGroup(scimGroup);

      await coreAdapter.execute(
        `UPDATE roles SET name = ?, description = ?, external_id = ? WHERE id = ? AND tenant_id = ?`,
        [
          internalGroup.name,
          internalGroup.description,
          internalGroup.external_id,
          resourceId,
          tenantId,
        ]
      );

      // Update members if changed
      if (scimGroup.members !== undefined) {
        const memberIds = resolveScimGroupMemberIds(scimGroup.members, bulkIdMap);
        const missingMemberIds = await findMissingTenantUserIds(coreAdapter, tenantId, memberIds);
        if (missingMemberIds.length > 0) {
          return invalidGroupMemberBulkResponse('PATCH');
        }

        await coreAdapter.execute('DELETE FROM user_roles WHERE tenant_id = ? AND role_id = ?', [
          tenantId,
          resourceId,
        ]);
        if (memberIds.length > 0) {
          const now = new Date().toISOString();
          await insertTenantGroupMembers(coreAdapter, tenantId, resourceId!, memberIds, now);
        }
      }

      const updatedGroup = await coreAdapter.queryOne<InternalGroup>(
        'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
        [resourceId, tenantId]
      );
      const members = await fetchGroupMembersWithPII(
        coreAdapter,
        canonicalProjectionRepository,
        resourceId!,
        tenantId
      );
      const responseGroup = updatedGroup
        ? groupToScim(updatedGroup, { baseUrl, includeMembers: true }, members)
        : null;

      return {
        method: 'PATCH',
        version: responseGroup?.meta.version,
        location: `${baseUrl}/scim/v2/Groups/${resourceId}`,
        status: '200',
        response: responseGroup ? (responseGroup as unknown as Record<string, unknown>) : undefined,
      };
    }

    case 'DELETE': {
      // Delete group
      const existingGroup = await coreAdapter.queryOne<InternalGroup>(
        'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
        [resourceId, tenantId]
      );
      if (!existingGroup) {
        return {
          method: 'DELETE',
          status: '404',
          response: {
            schemas: [SCIM_SCHEMAS.ERROR],
            status: '404',
            detail: 'Resource not found',
          },
        };
      }

      if (version) {
        const currentEtag = generateEtag(existingGroup);
        if (version !== currentEtag.replace(/^W\/"|"$/g, '')) {
          return {
            method: 'DELETE',
            status: '412',
            response: {
              schemas: [SCIM_SCHEMAS.ERROR],
              status: '412',
              detail: 'Precondition failed - resource was modified',
              scimType: 'invalidVers',
            },
          };
        }
      }

      await coreAdapter.execute('DELETE FROM user_roles WHERE tenant_id = ? AND role_id = ?', [
        tenantId,
        resourceId,
      ]);
      await coreAdapter.execute('DELETE FROM roles WHERE id = ? AND tenant_id = ?', [
        resourceId,
        tenantId,
      ]);

      return {
        method: 'DELETE',
        status: '204',
      };
    }

    default:
      return {
        method: method as ScimBulkMethod,
        status: '400',
        response: {
          schemas: [SCIM_SCHEMAS.ERROR],
          status: '400',
          detail: `Unsupported method: ${method}`,
        },
      };
  }
}

export default app;
