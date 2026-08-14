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
  getLogger,
  DEFAULT_TENANT_ID,
  isDatabaseSource,
  resolveAccountDataContext,
  resolveAccountDataContextFromHono,
} from '@authrim/ar-lib-core';
import {
  type DatabaseAdapter,
  type CanonicalRuntimeUserWriteInput,
  CanonicalIdentityRepository,
  CanonicalRuntimeUserProjectionRepository,
  CanonicalRuntimeUserWriter,
  CanonicalSensitiveValueResolver,
  generateId,
  generateUserIdFromSettings,
  validateCustomClaimWrite,
  persistCustomClaimWrite,
  syncUserLifecycleState,
  resolveCustomClaimRuntimeSourcesFromEnv,
  ensureDatabaseAdapter,
  transitionAccountAuthenticationState,
} from '@authrim/ar-lib-core';
import { logScimAudit } from '@authrim/ar-lib-scim';
import { canonicalProjectionToScimInternalUser } from './identity-canonical-runtime';
import {
  AccountCreationOperationRepository,
  hashAccountCreationRequest,
} from './account-creation-operation';
import {
  executeDurableInitialAccountDirectoryWrite,
  resolveInitialAccountDirectoryWriteTargets,
  type DurableInitialAccountDirectoryWriteResult,
} from './account-directory-producer';
import { writeCanonicalAccountAuthoritative } from './account-authoritative-write';
import {
  attemptImmediateAccountDirectoryRemovals,
  eraseAccountPiiAfterDirectoryRemovalPrepared,
  markAccountDirectoryRemovalsReady,
  prepareAccountDirectoryRemoval,
} from './account-directory-removal-producer';
import {
  CrossShardAccountListService,
  type CrossShardAccountListItem,
} from './cross-shard-account-list';
import { applyScimInboundIdentityMapping, ScimIdentityMappingError } from './scim-identity-mapping';
import { getScimInboundSettings } from './scim-settings';

interface ScimUserReadOptions {
  canonicalProjectionRepository?: CanonicalRuntimeUserProjectionRepository | null;
  includeInactive?: boolean;
}

type CanonicalUserFilterValue = string | number | boolean | null | undefined;

interface ScimAccountAdapters {
  coreAdapter: DatabaseAdapter;
  piiAdapter: DatabaseAdapter;
}

function createTenantMetadataAdapterFromContext(c: Context<{ Bindings: Env }>): DatabaseAdapter {
  const tenantId = getTenantIdFromContext(c);
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

function createCanonicalProjectionRepository(
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter,
  tenantId: string
): CanonicalRuntimeUserProjectionRepository {
  return new CanonicalRuntimeUserProjectionRepository(
    coreAdapter,
    tenantId,
    new CanonicalSensitiveValueResolver(piiAdapter)
  );
}

function adaptersFromAccountRoute(
  route: Awaited<ReturnType<typeof resolveAccountDataContext>>
): ScimAccountAdapters {
  return {
    coreAdapter: ensureDatabaseAdapter(route.coreDb, 'scim-account-core'),
    piiAdapter: ensureDatabaseAdapter(route.piiDb, 'scim-account-pii'),
  };
}

async function resolveScimAccountAdaptersFromContext(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<ScimAccountAdapters | null> {
  try {
    return adaptersFromAccountRoute(await resolveAccountDataContextFromHono(c, userId));
  } catch (error) {
    if (error instanceof Error && error.message === 'account_data_route_not_found') return null;
    throw error;
  }
}

async function resolveScimAccountAdapters(
  env: Env,
  tenantId: string,
  userId: string
): Promise<ScimAccountAdapters | null> {
  try {
    return adaptersFromAccountRoute(
      await resolveAccountDataContext(env, { tenantId, accountId: userId })
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'account_data_route_not_found') return null;
    throw error;
  }
}

function adaptersFromCrossShardItem(
  env: Env,
  item: CrossShardAccountListItem
): ScimAccountAdapters {
  const core = (env as unknown as Record<string, unknown>)[item.coreBindingRef];
  const pii = (env as unknown as Record<string, unknown>)[item.piiBindingRef];
  if (!isDatabaseSource(core) || !isDatabaseSource(pii)) {
    throw new Error('scim_account_route_binding_unavailable');
  }
  return {
    coreAdapter: ensureDatabaseAdapter(core, 'scim-list-account-core'),
    piiAdapter: ensureDatabaseAdapter(pii, 'scim-list-account-pii'),
  };
}

async function mapScimConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function canonicalScimRuntimeUser(
  internalUser: Partial<InternalUser>
): Omit<CanonicalRuntimeUserWriteInput, 'userId' | 'tenantId'> {
  return {
    active: internalUser.active === undefined ? true : internalUser.active !== 0,
    emailVerified: Boolean(internalUser.email_verified),
    phoneNumberVerified: Boolean(internalUser.phone_number_verified),
    userType: 'end_user',
    displayName: internalUser.name ?? internalUser.preferred_username ?? internalUser.email ?? null,
    locale: internalUser.locale ?? null,
    zoneinfo: internalUser.zoneinfo ?? null,
    sourceRef: 'scim:/Users',
    externalId: internalUser.external_id ?? null,
    passwordHash: null,
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
  };
}

async function maybeSyncCanonicalRuntimeUser(
  c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  internalUser: Partial<InternalUser>
): Promise<void> {
  const active = internalUser.active === undefined ? true : internalUser.active !== 0;
  const lifecycleVersionMs = Date.now();
  if (!active) {
    await transitionAccountAuthenticationState(c.env, {
      tenantId,
      userId,
      lifecycle: 'inactive',
      sourceVersionMs: lifecycleVersionMs,
      operationId: crypto.randomUUID(),
      revokeSessions: true,
    });
  }
  const writer = new CanonicalRuntimeUserWriter(
    new CanonicalIdentityRepository(coreAdapter, tenantId),
    piiAdapter
  );
  await writer.syncFromRuntimeUser({
    userId,
    tenantId,
    active,
    emailVerified: Boolean(internalUser.email_verified),
    phoneNumberVerified: Boolean(internalUser.phone_number_verified),
    userType: 'end_user',
    displayName: internalUser.name ?? internalUser.preferred_username ?? internalUser.email ?? null,
    locale: internalUser.locale ?? null,
    zoneinfo: internalUser.zoneinfo ?? null,
    sourceRef: 'scim:/Users',
    externalId: internalUser.external_id ?? null,
    passwordHash: null,
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
  if (active) {
    await transitionAccountAuthenticationState(c.env, {
      tenantId,
      userId,
      lifecycle: 'active',
      sourceVersionMs: lifecycleVersionMs,
      operationId: crypto.randomUUID(),
      revokeSessions: false,
    });
  }
}

async function maybeDeleteCanonicalRuntimeUser(
  c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<void> {
  const deletingVersionMs = Date.now();
  await transitionAccountAuthenticationState(c.env, {
    tenantId,
    userId,
    lifecycle: 'deleting',
    sourceVersionMs: deletingVersionMs,
    operationId: crypto.randomUUID(),
    revokeSessions: true,
  });
  const writer = new CanonicalRuntimeUserWriter(
    new CanonicalIdentityRepository(coreAdapter, tenantId),
    piiAdapter
  );
  await writer.deleteRuntimeUser(userId);
  await transitionAccountAuthenticationState(c.env, {
    tenantId,
    userId,
    lifecycle: 'deleted',
    sourceVersionMs: Math.max(Date.now(), deletingVersionMs + 1),
    operationId: crypto.randomUUID(),
    revokeSessions: true,
  });
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
  const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(
    c.env,
    tenantId,
    options?.userId ? { accountId: options.userId } : {}
  );
  const creating = !options?.userId;
  const nonPiiDb = customClaimSources.nonPiiDb ?? customClaimSources.schemaDb;
  return validateCustomClaimWrite({
    db: nonPiiDb,
    dbPii: customClaimSources.piiDb,
    piiStorageAvailable: creating,
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

  const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId, {
    accountId: userId,
  });
  if (!customClaimSources.nonPiiDb) throw new Error('scim_account_route_incomplete');
  await persistCustomClaimWrite({
    db: customClaimSources.nonPiiDb,
    dbPii: customClaimSources.piiDb,
    schemaDb: customClaimSources.schemaDb,
    tenantId,
    userId,
    validation,
  });

  // Validation requires a complete custom-claim record. Keep this lifecycle write D1-only; the
  // caller performs the single ordered AccountAuthState transition from the SCIM `active` value.
  await syncUserLifecycleState({
    db: customClaimSources.nonPiiDb,
    dbPii: customClaimSources.piiDb,
    schemaDb: customClaimSources.schemaDb,
    stateDb: ensureDatabaseAdapter(customClaimSources.nonPiiDb, 'scim-account-state'),
    tenantId,
    userId,
  });
}

const SCIM_ACCOUNT_CREATION_OPERATION_SCHEMA =
  'urn:authrim:params:scim:api:messages:2.0:AccountCreationOperation';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function scimActorId(c: ScimContext): Promise<string> {
  const authorization = c.req.header('Authorization');
  const match = authorization?.match(/^Bearer ([^\s]+)$/u);
  if (!match) throw new Error('scim_account_actor_unavailable');
  return `scim-token:${await sha256Hex(match[1])}`;
}

function explicitScimIdempotencyKey(c: ScimContext): string | null {
  const header = c.req.header('Idempotency-Key');
  if (header === undefined) return null;
  const value = header.trim();
  if (
    value.length < 8 ||
    value.length > 128 ||
    // eslint-disable-next-line no-control-regex -- reject header control bytes before persistence
    /[\x00-\x1f\x7f]/u.test(value)
  ) {
    throw new Error('scim_account_idempotency_key_invalid');
  }
  return value;
}

type ScimAccountCreationSource = { kind: 'single' } | { kind: 'bulk'; bulkId: string };

type ValidScimCustomClaimWrite = Extract<
  Awaited<ReturnType<typeof validateScimCustomClaimWrite>>,
  { ok: true }
>;

async function executeScimAccountCreation(
  c: ScimContext,
  tenantId: string,
  scimUser: Partial<ScimUser>,
  internalUser: Partial<InternalUser>,
  customFieldValidation: ValidScimCustomClaimWrite,
  source: ScimAccountCreationSource
): Promise<DurableInitialAccountDirectoryWriteResult> {
  const requestHash = await hashAccountCreationRequest({ source, user: scimUser });
  const explicitKey = source.kind === 'single' ? explicitScimIdempotencyKey(c) : null;
  const idempotencyKey = explicitKey ?? `scim-create:${requestHash}`;
  const actorId = await scimActorId(c);
  const candidateUserId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId, c.env);
  const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
  const operationRepository = new AccountCreationOperationRepository(
    createAuthContextFromHono(c, tenantId).coreAdapter
  );
  const externalId =
    typeof internalUser.external_id === 'string' && internalUser.external_id.trim()
      ? internalUser.external_id.trim()
      : null;

  return executeDurableInitialAccountDirectoryWrite(
    c.env,
    {
      tenantId,
      actorId,
      idempotencyKey,
      requestHash,
      candidateOperationId: `account-create-${crypto.randomUUID()}`,
      candidateUserId,
      email: typeof internalUser.email === 'string' ? internalUser.email : null,
      externalSubject: externalId
        ? { issuer: `urn:authrim:scim:${tenantId}`, subject: externalId }
        : null,
      residencyPolicyId: c.env.DEFAULT_RESIDENCY_PROFILE_ID ?? 'builtin:residency:default',
      residencyPartition: 'default',
    },
    {
      operationRepository,
      async writeAuthoritative(context) {
        const { userId } = await writeCanonicalAccountAuthoritative({
          publication: context.publication,
          tenantCoreUsers: context.tenantCoreUsers,
          tenantPii: context.tenantPii,
          runtimeUser: canonicalScimRuntimeUser(internalUser),
        });
        await persistCustomClaimWrite({
          db: context.tenantCoreUsers,
          dbPii: context.tenantPii,
          schemaDb: customClaimSources.schemaDb,
          tenantId,
          userId,
          validation: customFieldValidation,
        });
        await syncUserLifecycleState({
          db: context.tenantCoreUsers,
          dbPii: context.tenantPii,
          schemaDb: customClaimSources.schemaDb,
          stateDb: context.tenantCoreUsers,
          tenantId,
          userId,
          accountAuthenticationEnv: c.env,
        });
      },
    }
  );
}

function scimAccountCreationPending(baseUrl: string, operationId: string): Record<string, unknown> {
  return {
    schemas: [SCIM_ACCOUNT_CREATION_OPERATION_SCHEMA],
    id: operationId,
    status: 'directory_pending',
    operationId,
    meta: {
      resourceType: 'AccountCreationOperation',
      location: `${baseUrl}/scim/v2/Operations/${encodeURIComponent(operationId)}`,
    },
  };
}

const SCIM_MAX_USER_RESULTS = 1000;
const SCIM_ACCOUNT_PAGE_SIZE = 100;

async function fetchCrossShardCanonicalUsers(env: Env, tenantId: string): Promise<InternalUser[]> {
  const service = new CrossShardAccountListService(env, () => Math.floor(Date.now() / 1000));
  const users: InternalUser[] = [];
  let cursor: string | undefined;

  while (users.length < SCIM_MAX_USER_RESULTS) {
    const page = await service.list({
      tenantId,
      accountType: 'user',
      limit: SCIM_ACCOUNT_PAGE_SIZE,
      cursor,
    });
    const projected = await mapScimConcurrent(page.items, 4, async (item) => {
      const { coreAdapter, piiAdapter } = adaptersFromCrossShardItem(env, item);
      const projection = await createCanonicalProjectionRepository(
        coreAdapter,
        piiAdapter,
        tenantId
      ).findByAccountId(item.id);
      if (!projection || projection.id !== item.legacyUserId || projection.tenant_id !== tenantId) {
        throw new Error('scim_account_route_projection_invalid');
      }
      return canonicalProjectionToScimInternalUser(projection);
    });
    users.push(...projected);
    if (!page.nextCursor) break;
    if (page.nextCursor === cursor) throw new Error('scim_account_cursor_stalled');
    cursor = page.nextCursor;
  }

  return users.slice(0, SCIM_MAX_USER_RESULTS);
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
  env: Env,
  coreAdapter: DatabaseAdapter,
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

  return mapScimConcurrent(roleMembers, 4, async (member) => {
    const adapters = await resolveScimAccountAdapters(env, tenantId, member.user_id);
    if (!adapters) {
      return { user_id: member.user_id, email: '' };
    }
    const projection = await createCanonicalProjectionRepository(
      adapters.coreAdapter,
      adapters.piiAdapter,
      tenantId
    ).findByLegacyUserId(member.user_id);
    return { user_id: member.user_id, email: projection?.email ?? '' };
  });
}

async function fetchUserGroups(
  coreAdapter: DatabaseAdapter,
  userId: string,
  tenantId: string,
  baseUrl: string
): Promise<NonNullable<ScimUser['groups']>> {
  const roles = await coreAdapter.query<{ id: string; name: string }>(
    `SELECT r.id, r.name
       FROM user_roles ur
       INNER JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
      WHERE ur.tenant_id = ? AND ur.user_id = ?
      ORDER BY r.name ASC`,
    [tenantId, userId]
  );
  return roles.map((role) => ({
    value: role.id,
    $ref: `${baseUrl}/scim/v2/Groups/${encodeURIComponent(role.id)}`,
    display: role.name,
    type: 'direct',
  }));
}

async function findMissingTenantUserIds(
  env: Env,
  tenantId: string,
  userIds: string[]
): Promise<string[]> {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueUserIds.length === 0) {
    return [];
  }

  const resolved = await mapScimConcurrent(uniqueUserIds, 4, async (userId) =>
    resolveScimAccountAdapters(env, tenantId, userId)
  );
  return uniqueUserIds.filter((_userId, index) => resolved[index] === null);
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

function isScimDiscoveryRequest(method: string, pathname: string): boolean {
  if (method !== 'GET') return false;

  const mountIndex = pathname.indexOf('/scim/v2');
  const routePath = mountIndex >= 0 ? pathname.slice(mountIndex + '/scim/v2'.length) : pathname;
  return SCIM_DISCOVERY_PATHS.some(
    (discoveryPath) =>
      routePath === discoveryPath ||
      (discoveryPath !== '/ServiceProviderConfig' &&
        routePath.startsWith(`${discoveryPath}/`) &&
        !routePath.slice(discoveryPath.length + 1).includes('/'))
  );
}

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
  // Skip auth only for anchored GET discovery routes. Reserved-looking resource
  // IDs such as /Users/Schemas must still pass through SCIM authentication.
  if (isScimDiscoveryRequest(c.req.method, path)) {
    return next();
  }
  return scimAuthMiddleware(c, next);
});

app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (isScimDiscoveryRequest(c.req.method, path)) return next();
  const settings = await getScimInboundSettings(c.env, getTenantIdFromContext(c));
  if (!settings.enabled) return scimError(c, 403, 'SCIM inbound provisioning is disabled');
  if (path.includes('/Users') && !settings.usersEnabled) {
    return scimError(c, 403, 'SCIM User provisioning is disabled');
  }
  if (path.includes('/Groups') && !settings.groupsEnabled) {
    return scimError(c, 403, 'SCIM Group provisioning is disabled');
  }
  if (path.endsWith('/Bulk') && !settings.bulkEnabled) {
    return scimError(c, 403, 'SCIM Bulk operations are disabled');
  }
  return next();
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
  status: 400 | 401 | 403 | 404 | 409 | 412 | 413 | 500 | 503,
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

function scimMappingError(c: ScimContext, error: unknown): Response | null {
  if (!(error instanceof ScimIdentityMappingError)) return null;
  return scimError(c, 503, error.message, 'invalidValue', { code: error.code });
}

const SCIM_PASSWORD_UNSUPPORTED_DETAIL =
  'SCIM password provisioning is not supported; use Passkey, Email Code, Directory Connector, or External IdP authentication';

function hasScimPasswordCredential(scimUser: Partial<ScimUser>): boolean {
  return Object.prototype.hasOwnProperty.call(scimUser, 'password');
}

function scimPasswordUnsupportedError(c: ScimContext): Response {
  return scimError(c, 400, SCIM_PASSWORD_UNSUPPORTED_DETAIL, 'invalidValue');
}

function scimPasswordUnsupportedBulkResponse(
  method: ScimBulkMethod,
  bulkId?: string
): ScimBulkOperationResponse {
  return {
    method,
    bulkId,
    status: '400',
    response: {
      schemas: [SCIM_SCHEMAS.ERROR],
      status: '400',
      detail: SCIM_PASSWORD_UNSUPPORTED_DETAIL,
      scimType: 'invalidValue',
    },
  };
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

function projectScimResource<T extends object>(
  resource: T,
  params: Pick<ScimQueryParams, 'attributes' | 'excludedAttributes'>
): T {
  const source = resource as Record<string, unknown>;
  let projected: Record<string, unknown> = structuredClone(source);
  if (params.attributes?.length) {
    projected = {};
    for (const alwaysReturned of ['schemas', 'id', 'meta']) {
      if (alwaysReturned in source)
        projected[alwaysReturned] = structuredClone(source[alwaysReturned]);
    }
    for (const path of params.attributes) copyScimPath(source, projected, path);
  }
  for (const path of params.excludedAttributes ?? []) {
    const [topLevel] = scimPathParts(path);
    if (topLevel && ['schemas', 'id', 'meta'].includes(topLevel)) continue;
    deleteScimPath(projected, path);
  }
  return projected as T;
}

function scimPathParts(path: string): string[] {
  const enterprisePrefix = `${SCIM_SCHEMAS.ENTERPRISE_USER}:`;
  if (path.startsWith(enterprisePrefix)) {
    return [SCIM_SCHEMAS.ENTERPRISE_USER, ...path.slice(enterprisePrefix.length).split('.')];
  }
  return path.split('.').filter(Boolean);
}

function copyScimPath(
  source: Record<string, unknown>,
  destination: Record<string, unknown>,
  path: string
): void {
  const parts = scimPathParts(path);
  let sourceCursor: unknown = source;
  let destinationCursor = destination;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (!sourceCursor || typeof sourceCursor !== 'object' || !(part in sourceCursor)) return;
    const value = (sourceCursor as Record<string, unknown>)[part];
    if (index === parts.length - 1) {
      destinationCursor[part] = structuredClone(value);
      return;
    }
    if (!destinationCursor[part] || typeof destinationCursor[part] !== 'object') {
      destinationCursor[part] = {};
    }
    destinationCursor = destinationCursor[part] as Record<string, unknown>;
    sourceCursor = value;
  }
}

function deleteScimPath(resource: Record<string, unknown>, path: string): void {
  const parts = scimPathParts(path);
  let cursor = resource;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = cursor[parts[index]!];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    cursor = next as Record<string, unknown>;
  }
  delete cursor[parts.at(-1)!];
}

function invalidProjectionParameters(params: ScimQueryParams): boolean {
  return Boolean(params.attributes?.length && params.excludedAttributes?.length);
}

// ============================================================================
// SCIM Discovery Endpoints (RFC 7644 Section 4)
// ============================================================================

/**
 * GET /scim/v2/ServiceProviderConfig - Service Provider Configuration
 * RFC 7644 Section 4 - REQUIRED endpoint
 */
app.get('/ServiceProviderConfig', async (c) => {
  const baseUrl = getBaseUrl(c);
  const settings = await getScimInboundSettings(c.env, getTenantIdFromContext(c));

  const config: ScimServiceProviderConfig = {
    schemas: [SCIM_SCHEMAS.SERVICE_PROVIDER_CONFIG],
    documentationUri: `${baseUrl}/docs/scim`,
    patch: {
      supported: true,
    },
    bulk: {
      supported: settings.enabled && settings.bulkEnabled,
      maxOperations: settings.bulkMaxOperations,
      maxPayloadSize: settings.bulkMaxPayloadSize,
    },
    filter: {
      supported: true,
      maxResults: 1000,
    },
    changePassword: {
      supported: false,
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

  // Supported SCIM Core and Enterprise User schema definitions.
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
            name: 'externalId',
            type: 'string',
            multiValued: false,
            required: false,
            caseExact: true,
            mutability: 'readWrite',
            returned: 'default',
            uniqueness: 'none',
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
            name: 'nickName',
            type: 'string',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
          },
          {
            name: 'profileUrl',
            type: 'reference',
            referenceTypes: ['external'],
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
          },
          {
            name: 'title',
            type: 'string',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
          },
          {
            name: 'userType',
            type: 'string',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
          },
          {
            name: 'preferredLanguage',
            type: 'string',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
          },
          {
            name: 'locale',
            type: 'string',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
          },
          {
            name: 'timezone',
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
            name: 'addresses',
            type: 'complex',
            multiValued: true,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
            subAttributes: [
              { name: 'formatted', type: 'string', multiValued: false, required: false },
              { name: 'streetAddress', type: 'string', multiValued: false, required: false },
              { name: 'locality', type: 'string', multiValued: false, required: false },
              { name: 'region', type: 'string', multiValued: false, required: false },
              { name: 'postalCode', type: 'string', multiValued: false, required: false },
              { name: 'country', type: 'string', multiValued: false, required: false },
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
            name: 'costCenter',
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
          {
            name: 'division',
            type: 'string',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
          },
          {
            name: 'manager',
            type: 'complex',
            multiValued: false,
            required: false,
            mutability: 'readWrite',
            returned: 'default',
            subAttributes: [
              { name: 'value', type: 'string', multiValued: false, required: false },
              { name: '$ref', type: 'reference', multiValued: false, required: false },
              { name: 'displayName', type: 'string', multiValued: false, required: false },
            ],
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
          name: 'externalId',
          type: 'string',
          multiValued: false,
          required: false,
          caseExact: true,
          mutability: 'readWrite',
          returned: 'default',
          uniqueness: 'none',
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
          name: 'nickName',
          type: 'string',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'profileUrl',
          type: 'reference',
          referenceTypes: ['external'],
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'title',
          type: 'string',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'userType',
          type: 'string',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'preferredLanguage',
          type: 'string',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'locale',
          type: 'string',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'timezone',
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
          name: 'addresses',
          type: 'complex',
          multiValued: true,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
          subAttributes: [
            { name: 'formatted', type: 'string', multiValued: false, required: false },
            { name: 'streetAddress', type: 'string', multiValued: false, required: false },
            { name: 'locality', type: 'string', multiValued: false, required: false },
            { name: 'region', type: 'string', multiValued: false, required: false },
            { name: 'postalCode', type: 'string', multiValued: false, required: false },
            { name: 'country', type: 'string', multiValued: false, required: false },
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
          name: 'costCenter',
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
        {
          name: 'division',
          type: 'string',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
        },
        {
          name: 'manager',
          type: 'complex',
          multiValued: false,
          required: false,
          mutability: 'readWrite',
          returned: 'default',
          subAttributes: [
            { name: 'value', type: 'string', multiValued: false, required: false },
            { name: '$ref', type: 'reference', multiValued: false, required: false },
            { name: 'displayName', type: 'string', multiValued: false, required: false },
          ],
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
    if (invalidProjectionParameters(params)) {
      return scimError(
        c,
        400,
        'attributes and excludedAttributes are mutually exclusive',
        'invalidValue'
      );
    }

    // Pagination defaults
    const startIndex = params.startIndex || 1; // SCIM uses 1-based indexing
    const count = Math.min(params.count || 100, 1000); // Max 1000 per page
    const offset = startIndex - 1;

    if (params.filter) {
      try {
        parseScimFilter(params.filter);
      } catch (error) {
        // Log full error for debugging but don't expose to client
        const log = getLogger(c).module('SCIM');
        log.error('Invalid filter syntax', { action: 'list_users' }, error as Error);
        // SECURITY: Do not expose filter parsing error details
        return scimError(c, 400, 'Invalid filter syntax', 'invalidFilter');
      }
    }

    const sortColumn = params.sortBy
      ? validateSortColumn(params.sortBy, ALLOWED_USER_SORT_COLUMNS)
      : null;
    if (params.sortBy && !sortColumn) {
      return scimError(
        c,
        400,
        `Invalid sortBy attribute: ${params.sortBy}. Allowed values: ${Object.keys(ALLOWED_USER_SORT_COLUMNS).join(', ')}`,
        'invalidValue'
      );
    }

    let users = await fetchCrossShardCanonicalUsers(c.env, tenantId);
    if (params.filter) {
      users = users.filter((user) => userMatchesScimFilter(user, params.filter!));
    }
    const totalResults = users.length;

    if (sortColumn) {
      const sortDirection = params.sortOrder === 'descending' ? -1 : 1;
      users.sort((a, b) => {
        const aValue = getScimUserFilterValue(a, sortColumn);
        const bValue = getScimUserFilterValue(b, sortColumn);
        return String(aValue ?? '').localeCompare(String(bValue ?? '')) * sortDirection;
      });
    }

    const pageUsers = users.slice(offset, offset + count);

    // Convert to SCIM format
    const scimUsers = pageUsers.map((user) =>
      projectScimResource(userToScim(user, { baseUrl, includeGroups: false }), params)
    );

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
    const params = parseQueryParams(c);
    if (invalidProjectionParameters(params)) {
      return scimError(
        c,
        400,
        'attributes and excludedAttributes are mutually exclusive',
        'invalidValue'
      );
    }
    const tenantId = getTenantIdFromContext(c);
    const adapters = await resolveScimAccountAdaptersFromContext(c, userId);
    if (!adapters) {
      return scimError(c, 404, 'The requested resource was not found');
    }
    const { coreAdapter, piiAdapter } = adapters;
    const canonicalProjectionRepository = createCanonicalProjectionRepository(
      coreAdapter,
      piiAdapter,
      tenantId
    );
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

    const groups = await fetchUserGroups(
      createTenantMetadataAdapterFromContext(c),
      userId,
      tenantId,
      baseUrl
    );
    const scimUser = userToScim(user, { baseUrl, includeGroups: true, groups });

    // Set ETag header
    c.header('ETag', scimUser.meta.version || '');

    return c.json(projectScimResource(scimUser, params));
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM get user error', { action: 'get_user' }, error as Error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * GET /scim/v2/Operations/{id} - Read one account creation operation.
 */
app.get('/Operations/:id', async (c) => {
  try {
    const tenantId = getTenantIdFromContext(c);
    const actorId = await scimActorId(c);
    const operation = await new AccountCreationOperationRepository(
      createAuthContextFromHono(c, tenantId).coreAdapter
    ).findForActor({ tenantId, actorId, operationId: c.req.param('id')! });
    if (!operation) {
      return scimError(c, 404, 'The requested resource was not found');
    }
    const baseUrl = getBaseUrl(c);
    return c.json({
      ...scimAccountCreationPending(baseUrl, operation.operationId),
      status: operation.status,
      ...(operation.status === 'succeeded'
        ? {
            userId: operation.userId,
            resourceLocation: `${baseUrl}/scim/v2/Users/${encodeURIComponent(operation.userId)}`,
          }
        : {}),
    });
  } catch (error) {
    const log = getLogger(c).module('SCIM');
    log.error('SCIM account creation operation error', { action: 'get_operation' }, error as Error);
    if (
      error instanceof Error &&
      /^(account_creation_(tenant|actor|operation)_id_invalid)$/u.test(error.message)
    ) {
      return scimError(c, 404, 'The requested resource was not found');
    }
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

    // Validate required fields
    const validation = validateScimUser(scimUser);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }
    if (hasScimPasswordCredential(scimUser)) {
      return scimPasswordUnsupportedError(c);
    }

    // Convert SCIM user to internal format
    const internalUser = await applyScimInboundIdentityMapping({
      env: c.env,
      tenantId,
      user: scimUser,
    });
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

    // Set defaults
    if (!internalUser.email_verified) internalUser.email_verified = 0;
    if (internalUser.active === undefined) internalUser.active = 1;

    const result = await executeScimAccountCreation(
      c,
      tenantId,
      scimUser,
      internalUser,
      customFieldValidation,
      { kind: 'single' }
    );
    if (result.delivery.status === 202) {
      c.header(
        'Location',
        `${baseUrl}/scim/v2/Operations/${encodeURIComponent(result.operation.operationId)}`
      );
      logScimAudit(c, 'scim.user.create', 'scim_user', result.operation.userId, {
        externalId: scimUser.externalId,
        operationId: result.operation.operationId,
        status: 'directory_pending',
      });
      return c.json(scimAccountCreationPending(baseUrl, result.operation.operationId), 202);
    }

    const targets = await resolveInitialAccountDirectoryWriteTargets(c.env, result.publication);
    const canonicalProjectionRepository = new CanonicalRuntimeUserProjectionRepository(
      ensureDatabaseAdapter(targets.tenantCoreUsers, 'scim-user-create-result-core'),
      tenantId,
      new CanonicalSensitiveValueResolver(
        ensureDatabaseAdapter(targets.tenantPii, 'scim-user-create-result-pii')
      )
    );

    const createdUser = await fetchUserWithPII(result.operation.userId, {
      canonicalProjectionRepository,
    });

    if (!createdUser) {
      return scimError(c, 500, 'Failed to create user');
    }

    const responseUser = userToScim(createdUser, { baseUrl, includeGroups: false });

    // Set Location header
    c.header('Location', responseUser.meta.location);

    // Audit log (non-blocking)
    logScimAudit(c, 'scim.user.create', 'scim_user', result.operation.userId, {
      externalId: scimUser.externalId,
      operationId: result.operation.operationId,
    });

    return c.json(responseUser, 201);
  } catch (error) {
    const mappingResponse = scimMappingError(c, error);
    if (mappingResponse) return mappingResponse;
    const log = getLogger(c).module('SCIM');
    log.error('SCIM create user error', { action: 'create_user' }, error as Error);
    if (error instanceof Error) {
      if (error.message === 'scim_account_idempotency_key_invalid') {
        return scimError(
          c,
          400,
          'Idempotency-Key must contain 8 to 128 safe characters',
          'invalidValue'
        );
      }
      if (
        error.message === 'account_creation_operation_idempotency_conflict' ||
        error.message === 'directory_identifier_reservation_conflict'
      ) {
        return scimError(c, 409, 'User identifier already exists', 'uniqueness');
      }
      if (error.message === 'control_account_allocation_capacity_unavailable') {
        return scimError(c, 503, 'Account storage capacity is temporarily unavailable');
      }
    }
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
    const adapters = await resolveScimAccountAdaptersFromContext(c, userId);
    if (!adapters) {
      return scimError(c, 404, 'The requested resource was not found');
    }
    const { coreAdapter, piiAdapter } = adapters;
    const canonicalProjectionRepository = createCanonicalProjectionRepository(
      coreAdapter,
      piiAdapter,
      tenantId
    );

    // Validate required fields
    const validation = validateScimUser(scimUser);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }
    if (hasScimPasswordCredential(scimUser)) {
      return scimPasswordUnsupportedError(c);
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
    const internalUser = await applyScimInboundIdentityMapping({
      env: c.env,
      tenantId,
      user: scimUser,
    });
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
    const mappingResponse = scimMappingError(c, error);
    if (mappingResponse) return mappingResponse;
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
    const adapters = await resolveScimAccountAdaptersFromContext(c, userId);
    if (!adapters) {
      return scimError(c, 404, 'The requested resource was not found');
    }
    const { coreAdapter, piiAdapter } = adapters;
    const canonicalProjectionRepository = createCanonicalProjectionRepository(
      coreAdapter,
      piiAdapter,
      tenantId
    );

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
    if (hasScimPasswordCredential(scimUser)) {
      return scimPasswordUnsupportedError(c);
    }

    // Convert back to internal format
    const internalUser = await applyScimInboundIdentityMapping({
      env: c.env,
      tenantId,
      user: scimUser,
    });
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
    const mappingResponse = scimMappingError(c, error);
    if (mappingResponse) return mappingResponse;
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
    const adapters = await resolveScimAccountAdaptersFromContext(c, userId);
    if (!adapters) {
      return scimError(c, 404, 'The requested resource was not found');
    }
    const { coreAdapter, piiAdapter } = adapters;
    const canonicalProjectionRepository = createCanonicalProjectionRepository(
      coreAdapter,
      piiAdapter,
      tenantId
    );

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
    const directoryRemovals = await prepareAccountDirectoryRemoval(c.env, {
      tenantId,
      userId,
      core: coreAdapter,
      pii: piiAdapter,
    });

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

    await eraseAccountPiiAfterDirectoryRemovalPrepared(
      piiAdapter,
      { tenantId, userId },
      Math.floor(now / 1000)
    );

    await maybeDeleteCanonicalRuntimeUser(c, coreAdapter, piiAdapter, tenantId, userId);
    await markAccountDirectoryRemovalsReady(coreAdapter, directoryRemovals);
    await attemptImmediateAccountDirectoryRemovals(c.env.ACCOUNT_DIRECTORY, directoryRemovals);

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
    if (invalidProjectionParameters(params)) {
      return scimError(
        c,
        400,
        'attributes and excludedAttributes are mutually exclusive',
        'invalidValue'
      );
    }
    const baseUrl = getBaseUrl(c);
    const tenantId = getTenantIdFromContext(c);
    const coreAdapter = createTenantMetadataAdapterFromContext(c);

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
        c.env,
        coreAdapter,
        group.id as string,
        tenantId
      );

      scimGroups.push(
        projectScimResource(groupToScim(group, { baseUrl, includeMembers: true }, members), params)
      );
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
    const params = parseQueryParams(c);
    if (invalidProjectionParameters(params)) {
      return scimError(
        c,
        400,
        'attributes and excludedAttributes are mutually exclusive',
        'invalidValue'
      );
    }
    const tenantId = getTenantIdFromContext(c);
    const coreAdapter = createTenantMetadataAdapterFromContext(c);

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
    const members = await fetchGroupMembersWithPII(c.env, coreAdapter, groupId, tenantId);

    const scimGroup = groupToScim(group, { baseUrl, includeMembers: true }, members);

    // Set ETag header
    c.header('ETag', scimGroup.meta.version || '');

    return c.json(projectScimResource(scimGroup, params));
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
    const coreAdapter = createTenantMetadataAdapterFromContext(c);

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
    const missingMemberIds = await findMissingTenantUserIds(c.env, tenantId, memberIds);
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
    const members = await fetchGroupMembersWithPII(c.env, coreAdapter, groupId, tenantId);

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
    const coreAdapter = createTenantMetadataAdapterFromContext(c);

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

    const memberIds = resolveScimGroupMemberIds(scimGroup.members);
    const missingMemberIds = await findMissingTenantUserIds(c.env, tenantId, memberIds);
    if (missingMemberIds.length > 0) {
      return scimError(c, 400, 'Group member does not exist in this tenant', 'invalidValue');
    }

    // Update group
    await coreAdapter.execute(
      `UPDATE roles SET name = ?, description = ?, external_id = ? WHERE id = ? AND tenant_id = ?`,
      [internalGroup.name, internalGroup.description, internalGroup.external_id, groupId, tenantId]
    );

    // Update members only after every routed account has been validated.
    await coreAdapter.execute('DELETE FROM user_roles WHERE tenant_id = ? AND role_id = ?', [
      tenantId,
      groupId,
    ]);

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
    const members = await fetchGroupMembersWithPII(c.env, coreAdapter, groupId, tenantId);

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
    const coreAdapter = createTenantMetadataAdapterFromContext(c);

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
    const currentMembers = await fetchGroupMembersWithPII(c.env, coreAdapter, groupId, tenantId);

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

    const memberIds =
      scimGroup.members === undefined ? null : resolveScimGroupMemberIds(scimGroup.members);
    if (memberIds) {
      const missingMemberIds = await findMissingTenantUserIds(c.env, tenantId, memberIds);
      if (missingMemberIds.length > 0) {
        return scimError(c, 400, 'Group member does not exist in this tenant', 'invalidValue');
      }
    }

    // Update group
    await coreAdapter.execute(
      `UPDATE roles SET name = ?, description = ?, external_id = ? WHERE id = ? AND tenant_id = ?`,
      [internalGroup.name, internalGroup.description, internalGroup.external_id, groupId, tenantId]
    );

    // Update members if changed
    if (memberIds) {
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
    const updatedMembers = await fetchGroupMembersWithPII(c.env, coreAdapter, groupId, tenantId);

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
    const coreAdapter = createTenantMetadataAdapterFromContext(c);

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
    const metadataAdapter = createTenantMetadataAdapterFromContext(c);

    // Get bulk config from KV
    const inboundSettings = await getScimInboundSettings(c.env, tenantId);
    const bulkConfig: BulkOperationConfig = {
      maxOperations: inboundSettings.bulkMaxOperations,
      maxPayloadSize: inboundSettings.bulkMaxPayloadSize,
    };

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

    // Measure the actual body too. Content-Length can be absent or inaccurate.
    let bulkRequest: ScimBulkRequest;
    try {
      const body = await c.req.text();
      if (new TextEncoder().encode(body).byteLength > bulkConfig.maxPayloadSize) {
        return scimError(
          c,
          413,
          `Request payload exceeds maximum size of ${bulkConfig.maxPayloadSize} bytes`,
          'tooMany'
        );
      }
      bulkRequest = JSON.parse(body) as ScimBulkRequest;
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
        metadataAdapter,
        c,
        {
          usersEnabled: inboundSettings.usersEnabled,
          groupsEnabled: inboundSettings.groupsEnabled,
        }
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
  metadataAdapter: DatabaseAdapter,
  c: Context<{ Bindings: Env }>,
  permissions: { usersEnabled: boolean; groupsEnabled: boolean }
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

  if (
    (resourceType === 'Users' && !permissions.usersEnabled) ||
    (resourceType === 'Groups' && !permissions.groupsEnabled)
  ) {
    return {
      method,
      bulkId,
      status: '403',
      response: {
        schemas: [SCIM_SCHEMAS.ERROR],
        status: '403',
        detail: `SCIM ${resourceType} provisioning is disabled`,
      },
    };
  }

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

  if (
    method === 'POST' &&
    (typeof bulkId !== 'string' ||
      bulkId.length < 1 ||
      bulkId.length > 128 ||
      // eslint-disable-next-line no-control-regex -- bulkId is persisted in the derived operation hash
      /[\x00-\x1f\x7f]/u.test(bulkId))
  ) {
    return {
      method,
      bulkId,
      status: '400',
      response: {
        schemas: [SCIM_SCHEMAS.ERROR],
        status: '400',
        detail: 'POST operations require a valid bulkId',
        scimType: 'invalidValue',
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
        metadataAdapter,
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
    const mappingError = error instanceof ScimIdentityMappingError ? error : null;
    return {
      method,
      bulkId,
      status: mappingError ? '503' : '500',
      response: {
        schemas: [SCIM_SCHEMAS.ERROR],
        status: mappingError ? '503' : '500',
        detail: mappingError?.message ?? 'Internal server error processing operation',
        ...(mappingError ? { code: mappingError.code } : {}),
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
  bulkIdMap: Map<string, string>,
  c: Context<{ Bindings: Env }>
): Promise<ScimBulkOperationResponse> {
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
      if (hasScimPasswordCredential(scimUser)) {
        return scimPasswordUnsupportedBulkResponse('POST', bulkId);
      }

      // Convert and create
      const internalUser = await applyScimInboundIdentityMapping({
        env: c.env,
        tenantId,
        user: scimUser,
      });
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
      const now = new Date().toISOString();
      internalUser.created_at = now;
      internalUser.updated_at = now;
      if (!internalUser.email_verified) internalUser.email_verified = 0;
      if (internalUser.active === undefined) internalUser.active = 1;

      let result: DurableInitialAccountDirectoryWriteResult;
      try {
        result = await executeScimAccountCreation(
          c,
          tenantId,
          scimUser,
          internalUser,
          customFieldValidation,
          { kind: 'bulk', bulkId: bulkId! }
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === 'account_creation_operation_idempotency_conflict' ||
            error.message === 'directory_identifier_reservation_conflict')
        ) {
          return {
            method: 'POST',
            bulkId,
            status: '409',
            response: {
              schemas: [SCIM_SCHEMAS.ERROR],
              status: '409',
              detail: 'User identifier already exists',
              scimType: 'uniqueness',
            },
          };
        }
        if (
          error instanceof Error &&
          error.message === 'control_account_allocation_capacity_unavailable'
        ) {
          return {
            method: 'POST',
            bulkId,
            status: '503',
            response: {
              schemas: [SCIM_SCHEMAS.ERROR],
              status: '503',
              detail: 'Account storage capacity is temporarily unavailable',
            },
          };
        }
        throw error;
      }
      const userId = result.operation.userId;

      // Store bulkId mapping for cross-references
      if (bulkId) {
        bulkIdMap.set(bulkId, userId);
      }

      if (result.delivery.status === 202) {
        return {
          method: 'POST',
          bulkId,
          location: `${baseUrl}/scim/v2/Operations/${encodeURIComponent(
            result.operation.operationId
          )}`,
          status: '202',
          response: scimAccountCreationPending(baseUrl, result.operation.operationId) as Record<
            string,
            unknown
          >,
        };
      }

      const targets = await resolveInitialAccountDirectoryWriteTargets(c.env, result.publication);
      const createdProjectionRepository = new CanonicalRuntimeUserProjectionRepository(
        ensureDatabaseAdapter(targets.tenantCoreUsers, 'scim-bulk-user-create-result-core'),
        tenantId,
        new CanonicalSensitiveValueResolver(
          ensureDatabaseAdapter(targets.tenantPii, 'scim-bulk-user-create-result-pii')
        )
      );
      const createdUser = await fetchUserWithPII(userId, {
        canonicalProjectionRepository: createdProjectionRepository,
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
      const adapters = await resolveScimAccountAdapters(c.env, tenantId, resourceId!);
      if (!adapters) {
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
      const { coreAdapter, piiAdapter } = adapters;
      const canonicalProjectionRepository = createCanonicalProjectionRepository(
        coreAdapter,
        piiAdapter,
        tenantId
      );
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
      if (hasScimPasswordCredential(scimUser)) {
        return scimPasswordUnsupportedBulkResponse('PUT');
      }

      const internalUser = await applyScimInboundIdentityMapping({
        env: c.env,
        tenantId,
        user: scimUser,
      });
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
      const adapters = await resolveScimAccountAdapters(c.env, tenantId, resourceId!);
      if (!adapters) {
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
      const { coreAdapter, piiAdapter } = adapters;
      const canonicalProjectionRepository = createCanonicalProjectionRepository(
        coreAdapter,
        piiAdapter,
        tenantId
      );
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
      if (hasScimPasswordCredential(scimUser)) {
        return scimPasswordUnsupportedBulkResponse('PATCH');
      }

      const internalUser = await applyScimInboundIdentityMapping({
        env: c.env,
        tenantId,
        user: scimUser,
      });
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
      const adapters = await resolveScimAccountAdapters(c.env, tenantId, resourceId!);
      if (!adapters) {
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
      const { coreAdapter, piiAdapter } = adapters;
      const canonicalProjectionRepository = createCanonicalProjectionRepository(
        coreAdapter,
        piiAdapter,
        tenantId
      );
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
  bulkIdMap: Map<string, string>,
  c: Context<{ Bindings: Env }>
): Promise<ScimBulkOperationResponse> {
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
      const missingMemberIds = await findMissingTenantUserIds(c.env, tenantId, memberIds);
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
      const members = await fetchGroupMembersWithPII(c.env, coreAdapter, groupId, tenantId);
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

      const memberIds = resolveScimGroupMemberIds(scimGroup.members, bulkIdMap);
      const missingMemberIds = await findMissingTenantUserIds(c.env, tenantId, memberIds);
      if (missingMemberIds.length > 0) {
        return invalidGroupMemberBulkResponse('PUT');
      }

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

      // Update members only after every routed account has been validated.
      await coreAdapter.execute('DELETE FROM user_roles WHERE tenant_id = ? AND role_id = ?', [
        tenantId,
        resourceId,
      ]);

      if (memberIds.length > 0) {
        const now = new Date().toISOString();
        await insertTenantGroupMembers(coreAdapter, tenantId, resourceId!, memberIds, now);
      }

      const updatedGroup = await coreAdapter.queryOne<InternalGroup>(
        'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
        [resourceId, tenantId]
      );
      const members = await fetchGroupMembersWithPII(c.env, coreAdapter, resourceId!, tenantId);
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
        c.env,
        coreAdapter,
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

      const memberIds =
        scimGroup.members === undefined
          ? null
          : resolveScimGroupMemberIds(scimGroup.members, bulkIdMap);
      if (memberIds) {
        const missingMemberIds = await findMissingTenantUserIds(c.env, tenantId, memberIds);
        if (missingMemberIds.length > 0) {
          return invalidGroupMemberBulkResponse('PATCH');
        }
      }

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
      if (memberIds) {
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
      const members = await fetchGroupMembersWithPII(c.env, coreAdapter, resourceId!, tenantId);
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
