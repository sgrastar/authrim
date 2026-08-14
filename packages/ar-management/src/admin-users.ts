import { Context } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  CanonicalIdentityRepository,
  CanonicalRuntimeUserProjectionRepository,
  CanonicalRuntimeUserWriter,
  CanonicalSensitiveValueResolver,
  TombstoneRepository,
  invalidateUserCache,
  getTenantIdFromContext,
  getTenantMetadataContextFromHono,
  createPIIContextFromHono,
  createAccountAuthContextFromHono,
  createAuthContextFromHono,
  hasPIIDatabase,
  generateUserIdFromSettings,
  ensureDatabaseAdapter,
  isDatabaseSource,
  createErrorResponse,
  createTenantPlacementWriteFenceResponse,
  AR_ERROR_CODES,
  escapeLikePattern,
  createAuditLogFromContext,
  getLogger,
  publishEvent,
  USER_EVENTS,
  type UserEventData,
  validateCustomClaimWrite,
  persistCustomClaimWrite,
  syncUserLifecycleState,
  getRequiredCustomClaimViolationStatuses,
  resolveCustomClaimRuntimeSourcesFromEnv,
  resolveCustomClaimRuntimeSourcesFromHono,
  resolveAccountDataContextFromHono,
  transitionAccountAuthenticationState,
  type CanonicalRuntimeUserProjection,
} from '@authrim/ar-lib-core';
import { resolveAaguidAuthenticator } from '@authrim/ar-lib-core/webauthn/aaguid-metadata';
import {
  ADMIN_USER_CREATE_RESERVED_FIELDS,
  ADMIN_USER_UPDATE_RESERVED_FIELDS,
  VALID_USER_LIFECYCLE_STATES,
  extractCustomClaimInput,
  scheduleAdminAuditLog,
  logSanitizedError,
  getErrorDetailsForResponse,
  toMilliseconds,
} from './admin-shared';
import { getAdminAuth } from './admin-tenant-access';
import {
  AccountCreationOperationRepository,
  hashAccountCreationRequest,
} from './account-creation-operation';
import {
  executeDurableInitialAccountDirectoryWrite,
  resolveInitialAccountDirectoryWriteTargets,
} from './account-directory-producer';
import { writeCanonicalAccountAuthoritative } from './account-authoritative-write';
import {
  attemptImmediateAccountDirectoryRemovals,
  eraseAccountPiiAfterDirectoryRemovalPrepared,
  markAccountDirectoryRemovalsReady,
  prepareAccountDirectoryRemoval,
} from './account-directory-removal-producer';
import {
  CrossShardAccountExactSearchService,
  CrossShardAccountListService,
  type CrossShardAccountListItem,
} from './cross-shard-account-list';

type AdminRuntimeUserCore = {
  email_verified: boolean | number;
  phone_number_verified: boolean | number;
  user_type: string;
  is_active?: boolean | number;
};

type AdminRuntimeUserPII = {
  email: string | null;
  phone_number: string | null;
  name: string | null;
  given_name: string | null;
  family_name: string | null;
  nickname: string | null;
  preferred_username: string | null;
  picture: string | null;
};

function usesTenantD1Storage(c: Context<{ Bindings: Env }>): boolean {
  const metadata = getTenantMetadataContextFromHono(c);
  const legacyStorageProfileId = (
    metadata as (typeof metadata & { storageProfileId?: string }) | undefined
  )?.storageProfileId;
  return (
    metadata?.route?.allocationScope === 'tenant_exclusive' ||
    legacyStorageProfileId === 'builtin:storage:tenant-d1'
  );
}

function resolveAdminPiiAdapter(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): DatabaseAdapter | null {
  if (hasPIIDatabase(c)) {
    return createPIIContextFromHono(c, tenantId).defaultPiiAdapter;
  }
  return c.env.DB_PII ? ensureDatabaseAdapter(c.env.DB_PII, 'pii') : null;
}

function createCanonicalRuntimeUserWriter(
  c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  tenantId: string
): CanonicalRuntimeUserWriter {
  const piiAdapter = resolveAdminPiiAdapter(c, tenantId);
  if (!piiAdapter) throw new Error('admin_user_pii_database_required');
  return new CanonicalRuntimeUserWriter(
    new CanonicalIdentityRepository(coreAdapter, tenantId),
    piiAdapter
  );
}

function createCanonicalRuntimeUserProjectionRepository(
  c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  tenantId: string
): CanonicalRuntimeUserProjectionRepository | null {
  if (!hasPIIDatabase(c)) {
    if (!c.env.DB_PII) return null;
  }
  const piiAdapter = resolveAdminPiiAdapter(c, tenantId);
  if (!piiAdapter) return null;
  return new CanonicalRuntimeUserProjectionRepository(
    coreAdapter,
    tenantId,
    new CanonicalSensitiveValueResolver(piiAdapter)
  );
}

function userTypeFromAccountType(accountType: string): string {
  if (accountType === 'admin') {
    return 'admin';
  }
  if (accountType === 'service_account') {
    return 'm2m';
  }
  if (accountType === 'anonymous') {
    return 'anonymous';
  }
  return 'end_user';
}

function normalizeAdminEmailInput(
  email: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof email !== 'string') {
    return { ok: false, error: 'Email is required' };
  }

  const normalized = email.trim();
  if (!normalized) {
    return { ok: false, error: 'Email is required' };
  }
  // eslint-disable-next-line no-control-regex -- reject ASCII controls in an identifier boundary
  if (normalized.length > 254 || /[\s\x00-\x1f\x7f]/.test(normalized)) {
    return { ok: false, error: 'Email must be a valid email address' };
  }

  const parts = normalized.split('@');
  if (parts.length !== 2) {
    return { ok: false, error: 'Email must be a valid email address' };
  }

  const [localPart, domain] = parts;
  if (!localPart || localPart.length > 64 || !domain || domain.length > 253) {
    return { ok: false, error: 'Email must be a valid email address' };
  }
  if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) {
    return { ok: false, error: 'Email must be a valid email address' };
  }

  const labels = domain.split('.');
  const validDomain =
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    );
  if (!validDomain) {
    return { ok: false, error: 'Email must be a valid email address' };
  }

  return { ok: true, value: normalized };
}

function addressPartsFromProjection(projection: CanonicalRuntimeUserProjection): {
  formatted: string | null;
  street_address: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
} {
  if (!projection.address_json) {
    return {
      formatted: null,
      street_address: null,
      locality: null,
      region: null,
      postal_code: null,
      country: null,
    };
  }
  try {
    const parsed = JSON.parse(projection.address_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const address = parsed as Record<string, unknown>;
      return {
        formatted: typeof address.formatted === 'string' ? address.formatted : null,
        street_address: typeof address.street_address === 'string' ? address.street_address : null,
        locality: typeof address.locality === 'string' ? address.locality : null,
        region: typeof address.region === 'string' ? address.region : null,
        postal_code: typeof address.postal_code === 'string' ? address.postal_code : null,
        country: typeof address.country === 'string' ? address.country : null,
      };
    }
  } catch {
    // Ignore malformed canonical address payloads.
  }
  return {
    formatted: null,
    street_address: null,
    locality: null,
    region: null,
    postal_code: null,
    country: null,
  };
}

function buildAddressJsonFromAdminBody(body: {
  address_formatted?: string | null;
  address_street_address?: string | null;
  address_locality?: string | null;
  address_region?: string | null;
  address_postal_code?: string | null;
  address_country?: string | null;
}): string | undefined {
  const address = {
    formatted: body.address_formatted ?? null,
    street_address: body.address_street_address ?? null,
    locality: body.address_locality ?? null,
    region: body.address_region ?? null,
    postal_code: body.address_postal_code ?? null,
    country: body.address_country ?? null,
  };
  const hasAddress = Object.values(address).some((value) => value !== null);
  return hasAddress ? JSON.stringify(address) : undefined;
}

function buildCanonicalPiiDeletionPatch(): Record<string, null> {
  return {
    email: null,
    phone_number: null,
    name: null,
    given_name: null,
    family_name: null,
    middle_name: null,
    nickname: null,
    preferred_username: null,
    profile: null,
    picture: null,
    website: null,
    gender: null,
    birthdate: null,
    zoneinfo: null,
    locale: null,
  };
}

function formatCanonicalAdminUser(
  projection: CanonicalRuntimeUserProjection,
  sessionLastLoginAt: number | null = null
) {
  const address = addressPartsFromProjection(projection);
  const createdAt = Date.parse(projection.created_at);
  const updatedAt = Date.parse(projection.updated_at);
  const lastLoginAt = projection.last_login_at ?? sessionLastLoginAt;
  return {
    id: projection.id,
    tenant_id: projection.tenant_id,
    email: projection.email,
    name: projection.name,
    given_name: projection.given_name,
    family_name: projection.family_name,
    nickname: projection.nickname,
    preferred_username: projection.preferred_username,
    picture: projection.picture,
    phone_number: projection.phone_number,
    website: projection.website,
    gender: projection.gender,
    birthdate: projection.birthdate,
    locale: projection.locale,
    zoneinfo: projection.zoneinfo,
    address_formatted: address.formatted,
    address_street_address: address.street_address,
    address_locality: address.locality,
    address_region: address.region,
    address_postal_code: address.postal_code,
    address_country: address.country,
    declared_residence: null,
    pii_class: 'PROFILE',
    email_verified: projection.email_verified,
    phone_number_verified: projection.phone_number_verified,
    user_type: userTypeFromAccountType(projection.account_type),
    is_active: projection.active,
    pii_partition: 'default',
    pii_status: projection.account_status === 'deleted' ? 'deleted' : 'active',
    created_at: Number.isFinite(createdAt) ? createdAt : null,
    updated_at: Number.isFinite(updatedAt) ? updatedAt : null,
    last_login_at: toMilliseconds(lastLoginAt),
    status: projection.account_status,
    suspended_at: toMilliseconds(projection.suspended_at),
    suspended_until: toMilliseconds(projection.suspended_until),
    locked_at: toMilliseconds(projection.locked_at),
    locked_until: toMilliseconds(projection.locked_until),
    lifecycle_state: projection.lifecycle_state,
  };
}

const ADMIN_RUNTIME_PII_FIELDS = {
  email: true,
  phone_number: true,
  name: true,
  given_name: true,
  family_name: true,
  nickname: true,
  preferred_username: true,
  picture: true,
} as const;

async function mapAdminUsersConcurrent<T, R>(
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

function accountRouteAdapter(
  env: Env,
  bindingRef: string,
  partition: 'core' | 'pii'
): DatabaseAdapter {
  const source = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!isDatabaseSource(source)) throw new Error('admin_user_route_binding_unavailable');
  return ensureDatabaseAdapter(source, `admin-user-${partition}`);
}

async function projectCrossShardAdminUser(
  env: Env,
  tenantId: string,
  item: CrossShardAccountListItem
) {
  const core = accountRouteAdapter(env, item.coreBindingRef, 'core');
  const pii = accountRouteAdapter(env, item.piiBindingRef, 'pii');
  const projection = await new CanonicalRuntimeUserProjectionRepository(
    core,
    tenantId,
    new CanonicalSensitiveValueResolver(pii)
  ).findByAccountId(item.id);
  if (!projection || projection.id !== item.legacyUserId || projection.tenant_id !== tenantId) {
    throw new Error('admin_user_route_projection_invalid');
  }
  const latestSession = await core.queryOne<{ last_login_at: number | null }>(
    `SELECT MAX(created_at) AS last_login_at
       FROM sessions
      WHERE tenant_id = ? AND user_id = ?`,
    [tenantId, projection.id]
  );
  return formatCanonicalAdminUser(projection, latestSession?.last_login_at ?? null);
}

async function crossShardAdminUsersList(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    limit: number;
    cursor?: string;
    search?: string;
    verified?: string;
    piiStatus?: string;
    lifecycleState?: string;
  }
) {
  const exactSearch = Boolean(input.search);
  const page = exactSearch
    ? {
        items: await new CrossShardAccountExactSearchService(c.env).find({
          tenantId: input.tenantId,
          identifier: input.search!,
        }),
        nextCursor: null,
      }
    : await new CrossShardAccountListService(c.env, () => Math.floor(Date.now() / 1000)).list({
        tenantId: input.tenantId,
        limit: input.limit,
        cursor: input.cursor,
        accountType: 'user',
      });
  const projected = await mapAdminUsersConcurrent(page.items, 4, (item) =>
    projectCrossShardAdminUser(c.env, input.tenantId, item)
  );
  const users = exactSearch
    ? projected.filter(
        (user) =>
          (input.verified === undefined ||
            Boolean(user.email_verified) === (input.verified === 'true')) &&
          (input.piiStatus === undefined ||
            input.piiStatus === (user.is_active ? 'active' : 'deleted')) &&
          (input.lifecycleState === undefined || user.lifecycle_state === input.lifecycleState)
      )
    : projected;
  return {
    users,
    pagination: {
      mode: exactSearch ? ('exact' as const) : ('cursor' as const),
      limit: input.limit,
      nextCursor: page.nextCursor,
      hasNext: page.nextCursor !== null,
    },
  };
}

function parseAdminUsersPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number
): number | null {
  const candidate = value ?? String(fallback);
  if (!/^\d+$/u.test(candidate)) return null;
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}

function isInvalidCrossShardCursorError(error: Error): boolean {
  return new Set([
    'invalid_cross_shard_cursor',
    'unsupported_cross_shard_cursor_version',
    'cross_shard_cursor_tenant_mismatch',
    'cross_shard_cursor_query_mismatch',
    'cross_shard_cursor_expired',
    'invalid_cross_shard_cursor_time',
    'invalid_cross_shard_cursor_count',
    'invalid_shard_cursor',
    'duplicate_cursor_shard',
  ]).has(error.message);
}

async function maybeSyncCanonicalRuntimeUserForAdmin(
  c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  userCore: Pick<
    AdminRuntimeUserCore,
    'email_verified' | 'phone_number_verified' | 'user_type' | 'is_active'
  >,
  userPII: AdminRuntimeUserPII | null
): Promise<void> {
  await createCanonicalRuntimeUserWriter(c, coreAdapter, tenantId).syncFromRuntimeUser({
    userId,
    tenantId,
    active: Boolean(userCore.is_active),
    emailVerified: Boolean(userCore.email_verified),
    phoneNumberVerified: Boolean(userCore.phone_number_verified),
    userType: userCore.user_type,
    displayName: userPII?.name ?? userPII?.preferred_username ?? userPII?.email ?? null,
    sourceRef: 'admin:/users',
    piiFields: userPII ? ADMIN_RUNTIME_PII_FIELDS : {},
    sensitiveValues: userPII
      ? {
          email: userPII.email,
          phone_number: userPII.phone_number,
          name: userPII.name,
          given_name: userPII.given_name,
          family_name: userPII.family_name,
          nickname: userPII.nickname,
          preferred_username: userPII.preferred_username,
          picture: userPII.picture,
        }
      : {},
  });
}

async function maybeDeleteCanonicalRuntimeUserForAdmin(
  c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<void> {
  await createCanonicalRuntimeUserWriter(c, coreAdapter, tenantId).deleteRuntimeUser(userId);
}

/**
 * Get admin statistics.
 * GET /admin/stats
 */
export async function adminStatsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const projectionRepository = createCanonicalRuntimeUserProjectionRepository(
      c,
      authCtx.coreAdapter,
      tenantId
    );
    if (!projectionRepository) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const todayStart = new Date().setHours(0, 0, 0, 0);

    const [
      activeUsersResult,
      totalUsersResult,
      totalClientsResult,
      newUsersTodayResult,
      loginsTodayResult,
      piiStatusRows,
      recentUsersCoreResult,
    ] = await Promise.all([
      authCtx.coreAdapter.queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM identity_accounts WHERE tenant_id = ? AND updated_at > ? AND lifecycle_state = 'active'",
        [tenantId, thirtyDaysAgo]
      ),
      authCtx.coreAdapter.queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM identity_accounts WHERE tenant_id = ? AND lifecycle_state = 'active'",
        [tenantId]
      ),
      authCtx.coreAdapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM oauth_clients WHERE tenant_id = ?',
        [tenantId]
      ),
      authCtx.coreAdapter.queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM identity_accounts WHERE tenant_id = ? AND created_at >= ? AND lifecycle_state = 'active'",
        [tenantId, todayStart]
      ),
      authCtx.coreAdapter.queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM identity_accounts WHERE tenant_id = ? AND updated_at >= ? AND lifecycle_state = 'active'",
        [tenantId, todayStart]
      ),
      authCtx.coreAdapter.query<{ pii_status: string; count: number }>(
        "SELECT 'active' as pii_status, COUNT(*) as count FROM identity_accounts WHERE tenant_id = ? AND lifecycle_state = 'active'",
        [tenantId]
      ),
      authCtx.coreAdapter.query<{ id: string; created_at: number }>(
        "SELECT legacy_user_id as id, created_at FROM identity_accounts WHERE tenant_id = ? AND lifecycle_state = 'active' AND legacy_user_id IS NOT NULL ORDER BY created_at DESC LIMIT 10",
        [tenantId]
      ),
    ]);

    const piiStatusCounts = {
      none: 0,
      pending: 0,
      active: 0,
      failed: 0,
      deleted: 0,
    };
    for (const row of piiStatusRows) {
      if (row.pii_status in piiStatusCounts) {
        piiStatusCounts[row.pii_status as keyof typeof piiStatusCounts] = Number(row.count) || 0;
      }
    }

    let recentActivity: {
      type: string;
      userId: string;
      email: string | null;
      name: string | null;
      timestamp: number;
    }[] = [];

    if (recentUsersCoreResult.length > 0) {
      recentActivity = await Promise.all(
        recentUsersCoreResult.map(async (user) => {
          const projection = await projectionRepository.findByLegacyUserId(user.id);
          return {
            type: 'user_registration',
            userId: user.id,
            email: projection?.email ?? null,
            name: projection?.name ?? null,
            timestamp: toMilliseconds(user.created_at) ?? 0,
          };
        })
      );
    }

    return c.json({
      stats: {
        activeUsers: activeUsersResult?.count || 0,
        totalUsers: totalUsersResult?.count || 0,
        registeredClients: totalClientsResult?.count || 0,
        newUsersToday: newUsersTodayResult?.count || 0,
        loginsToday: loginsTodayResult?.count || 0,
        piiHealth: {
          statusCounts: piiStatusCounts,
          repairNeeded: piiStatusCounts.pending + piiStatusCounts.failed,
          partialPIIUsers: piiStatusCounts.pending + piiStatusCounts.failed,
        },
      },
      recentActivity,
    });
  } catch (error) {
    logSanitizedError('Admin stats error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Get paginated list of users.
 * GET /admin/users
 */
export async function adminUsersListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const page = parseAdminUsersPositiveInteger(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER);
    const limit = parseAdminUsersPositiveInteger(c.req.query('limit'), 20, 100);
    if (page === null || limit === null) {
      return c.json(
        {
          error: 'invalid_pagination',
          error_description: 'page and limit must be positive integers within their bounds',
        },
        400
      );
    }
    const search = c.req.query('search') || '';
    const verified = c.req.query('verified');
    const piiStatus = c.req.query('pii_status');
    const lifecycleState = c.req.query('lifecycle_state');
    const cursor = c.req.query('cursor');
    if (usesTenantD1Storage(c)) {
      if (
        !search &&
        (verified !== undefined || piiStatus !== undefined || lifecycleState !== undefined)
      ) {
        return c.json(
          {
            error: 'unsupported_sharded_user_filter',
            error_description: 'Use exact identifier search for sharded user storage',
          },
          400
        );
      }
      return c.json(
        await crossShardAdminUsersList(c, {
          tenantId,
          limit,
          cursor,
          search,
          verified,
          piiStatus,
          lifecycleState,
        })
      );
    }
    const offset = (page - 1) * limit;
    const projectionRepository = createCanonicalRuntimeUserProjectionRepository(
      c,
      authCtx.coreAdapter,
      tenantId
    );
    if (!projectionRepository) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const [accountRows, sessionRows] = await Promise.all([
      authCtx.coreAdapter.query<{ legacy_user_id: string }>(
        `SELECT legacy_user_id
           FROM identity_accounts
          WHERE tenant_id = ?
            AND legacy_user_id IS NOT NULL
            AND lifecycle_state = 'active'
          ORDER BY created_at DESC`,
        [tenantId]
      ),
      authCtx.coreAdapter.query<{ user_id: string; last_login_at: number | null }>(
        `SELECT user_id, MAX(created_at) AS last_login_at
           FROM sessions
          WHERE tenant_id = ?
          GROUP BY user_id`,
        [tenantId]
      ),
    ]);
    const sessionLastLoginByUserId = new Map(
      sessionRows
        .filter(
          (row) =>
            typeof row.user_id === 'string' &&
            row.user_id.length > 0 &&
            typeof row.last_login_at === 'number'
        )
        .map((row) => [row.user_id, row.last_login_at] as const)
    );
    const projections: CanonicalRuntimeUserProjection[] = [];
    for (const row of accountRows) {
      const projection = await projectionRepository.findByLegacyUserId(row.legacy_user_id);
      if (projection) {
        projections.push(projection);
      }
    }

    const escapedSearch = search ? escapeLikePattern(search).toLowerCase() : '';
    const filteredUsers = projections.filter((projection) => {
      if (search) {
        const haystack = [projection.email, projection.name, projection.preferred_username]
          .filter(Boolean)
          .join('\n')
          .toLowerCase();
        if (!haystack.includes(escapedSearch.replace(/\\/g, ''))) {
          return false;
        }
      }
      if (verified !== undefined && Boolean(projection.email_verified) !== (verified === 'true')) {
        return false;
      }
      if (piiStatus !== undefined && piiStatus !== (projection.active ? 'active' : 'deleted')) {
        return false;
      }
      if (
        lifecycleState !== undefined &&
        VALID_USER_LIFECYCLE_STATES.has(lifecycleState) &&
        projection.lifecycle_state !== lifecycleState
      ) {
        return false;
      }
      return true;
    });

    const total = filteredUsers.length;
    const totalPages = Math.ceil(total / limit);
    const formattedUsers = filteredUsers
      .slice(offset, offset + limit)
      .map((projection) =>
        formatCanonicalAdminUser(projection, sessionLastLoginByUserId.get(projection.id) ?? null)
      );

    return c.json({
      users: formattedUsers,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'cursor_stale') {
      return c.json(
        {
          error: 'cursor_stale',
          error_description: 'The account shard set changed; restart pagination',
        },
        409
      );
    }
    if (error instanceof Error && isInvalidCrossShardCursorError(error)) {
      return c.json(
        { error: 'invalid_cursor', error_description: 'The pagination cursor is invalid' },
        400
      );
    }
    if (error instanceof Error && error.message === 'invalid_cross_shard_account_search') {
      return c.json(
        { error: 'invalid_search', error_description: 'The exact identifier search is invalid' },
        400
      );
    }
    logSanitizedError('Admin users list error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Get user details by ID.
 * GET /admin/users/:id
 */
export async function adminUserGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const tenantD1 = usesTenantD1Storage(c);
    if (tenantD1) {
      await resolveAccountDataContextFromHono(c, userId);
    }
    const authCtx = tenantD1
      ? createAccountAuthContextFromHono(c, tenantId)
      : createAuthContextFromHono(c, tenantId);
    const projectionRepository = createCanonicalRuntimeUserProjectionRepository(
      c,
      authCtx.coreAdapter,
      tenantId
    );
    if (!projectionRepository) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    const projection = await projectionRepository.findByLegacyUserId(userId, {
      includeInactive: true,
    });

    if (!projection) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const [passkeys, totpCredentials, latestSession] = await Promise.all([
      authCtx.repositories.passkey.findByUserId(userId),
      authCtx.repositories.totp.findByUserId(userId),
      authCtx.coreAdapter.queryOne<{ last_login_at: number | null }>(
        `SELECT MAX(created_at) AS last_login_at
           FROM sessions
          WHERE tenant_id = ? AND user_id = ?`,
        [tenantId, userId]
      ),
    ]);
    const customClaimSources = tenantD1
      ? await resolveCustomClaimRuntimeSourcesFromHono(c, tenantId)
      : await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
    if (!customClaimSources.nonPiiDb || !customClaimSources.piiDb) {
      throw new Error('admin_user_custom_claim_sources_required');
    }
    const customFields = await ensureDatabaseAdapter(
      customClaimSources.nonPiiDb,
      'admin-user-get-custom-fields'
    ).query<{
      field_name: string;
      field_value: string;
      field_type: string;
    }>(
      'SELECT field_name, field_value, field_type FROM user_custom_fields WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );

    const requiredViolations = await getRequiredCustomClaimViolationStatuses({
      db: customClaimSources.nonPiiDb,
      schemaDb: customClaimSources.schemaDb,
      stateDb: authCtx.coreAdapter,
      dbPii: customClaimSources.piiDb,
      cache: c.env.SETTINGS || null,
      tenantId,
      userIds: [userId],
      syncLifecycleState: false,
    });
    const missingRequiredFields = requiredViolations.users[0]?.missingRequiredFields ?? [];

    const formattedUser = formatCanonicalAdminUser(
      projection,
      latestSession?.last_login_at ?? null
    );

    const formattedPasskeys = passkeys.map((p) => ({
      id: p.id,
      credential_id: p.credential_id,
      device_name: p.device_name,
      aaguid: p.aaguid ?? null,
      provider: resolveAaguidAuthenticator(p.aaguid),
      created_at: toMilliseconds(p.created_at),
      last_used_at: toMilliseconds(p.last_used_at),
    }));
    const formattedTotpCredentials = totpCredentials.map((credential) => ({
      id: credential.id,
      label: credential.label,
      algorithm: credential.algorithm,
      digits: credential.digits,
      period: credential.period,
      window: credential.window,
      status: credential.status,
      created_at: toMilliseconds(credential.created_at),
      activated_at: toMilliseconds(credential.activated_at),
      last_used_at: toMilliseconds(credential.last_used_at),
    }));

    return c.json({
      user: formattedUser,
      passkeys: formattedPasskeys,
      totp_credentials: formattedTotpCredentials,
      missing_required_fields: missingRequiredFields.map((field) => ({
        field_key: field.fieldKey,
        label: field.label,
        field_type: field.fieldType,
      })),
      customFields,
    });
  } catch (error) {
    logSanitizedError('Admin user get error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve user',
      },
      500
    );
  }
}

/**
 * Reset user TOTP credentials.
 * POST /admin/users/:id/totp/reset
 */
export async function adminUserTotpResetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const projectionRepository = createCanonicalRuntimeUserProjectionRepository(
      c,
      authCtx.coreAdapter,
      tenantId
    );
    if (!projectionRepository) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    const projection = await projectionRepository.findByLegacyUserId(userId, {
      includeInactive: true,
    });
    if (!projection) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const deleted = await authCtx.repositories.totp.deleteByUserId(userId);
    await createAuditLogFromContext(
      c,
      'admin.user.totp.reset',
      'user',
      userId,
      { deleted },
      'warning'
    );

    return c.json({ ok: true, deleted });
  } catch (error) {
    logSanitizedError('Admin user TOTP reset error', error);
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Create a new user.
 * POST /admin/users
 */
export async function adminUserCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      email: string;
      name?: string;
      given_name?: string;
      family_name?: string;
      nickname?: string;
      preferred_username?: string;
      picture?: string;
      email_verified?: boolean;
      phone_number?: string;
      phone_number_verified?: boolean;
      user_type?: string;
      [key: string]: string | boolean | number | null | undefined;
    }>();

    const {
      email,
      name,
      given_name,
      family_name,
      nickname,
      preferred_username,
      picture,
      email_verified,
      phone_number,
      phone_number_verified,
      user_type,
    } = body;
    const customFieldInput = extractCustomClaimInput(body, ADMIN_USER_CREATE_RESERVED_FIELDS);

    const emailValidation = normalizeAdminEmailInput(email);
    if (!emailValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: emailValidation.error,
        },
        400
      );
    }
    const normalizedEmail = emailValidation.value;

    const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
    if (
      !idempotencyKey ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128 ||
      // eslint-disable-next-line no-control-regex -- reject header control bytes before persistence
      /[\x00-\x1f\x7f]/u.test(idempotencyKey)
    ) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'A valid Idempotency-Key header is required',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const adminAuth = getAdminAuth(c);
    const actorId = adminAuth?.actorId ?? adminAuth?.userId;
    if (!actorId) {
      return c.json(
        {
          error: 'access_denied',
          error_description: 'Administrator authentication context is required',
        },
        403
      );
    }
    const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const hasInitialPiiTarget = customClaimSources.piiDb !== null || hasPIIDatabase(c);
    if (!hasInitialPiiTarget) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const customFieldValidation = await validateCustomClaimWrite({
      db: customClaimSources.schemaDb,
      dbPii: customClaimSources.schemaDb,
      schemaDb: customClaimSources.schemaDb,
      tenantId,
      submitted: customFieldInput,
      requireCompleteRecord: true,
    });

    if (!customFieldValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: customFieldValidation.error,
          missing_required_fields: customFieldValidation.missingRequiredFields?.map((field) => ({
            field_key: field.fieldKey,
            label: field.label,
            field_type: field.fieldType,
          })),
        },
        400
      );
    }

    const candidateUserId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId, c.env);
    const requestHash = await hashAccountCreationRequest({
      ...body,
      email: normalizedEmail,
    });
    const result = await executeDurableInitialAccountDirectoryWrite(
      c.env,
      {
        tenantId,
        actorId,
        idempotencyKey,
        requestHash,
        candidateOperationId: `account-create-${crypto.randomUUID()}`,
        candidateUserId,
        email: normalizedEmail,
        residencyPolicyId: c.env.DEFAULT_RESIDENCY_PROFILE_ID ?? 'builtin:residency:default',
        residencyPartition: 'default',
      },
      {
        operationRepository: new AccountCreationOperationRepository(authCtx.coreAdapter),
        async writeAuthoritative(context) {
          const { userId } = await writeCanonicalAccountAuthoritative({
            publication: context.publication,
            tenantCoreUsers: context.tenantCoreUsers,
            tenantPii: context.tenantPii,
            runtimeUser: {
              active: true,
              emailVerified: email_verified ?? false,
              phoneNumberVerified: phone_number_verified ?? false,
              userType: typeof user_type === 'string' ? user_type : 'end_user',
              displayName: name ?? preferred_username ?? normalizedEmail,
              sourceRef: 'admin:/users',
              piiFields: ADMIN_RUNTIME_PII_FIELDS,
              sensitiveValues: {
                email: normalizedEmail,
                phone_number: phone_number ?? null,
                name: name ?? null,
                given_name: given_name ?? null,
                family_name: family_name ?? null,
                nickname: nickname ?? null,
                preferred_username: preferred_username ?? null,
                picture: picture ?? null,
              },
            },
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

    if (result.delivery.status === 202) {
      await createAuditLogFromContext(c, 'user.creation.pending', 'user', result.operation.userId, {
        operation_id: result.operation.operationId,
      });
      return c.json(
        {
          status: 'pending',
          state: result.operation.status,
          operation_id: result.operation.operationId,
          status_url: `/api/admin/users/operations/${encodeURIComponent(
            result.operation.operationId
          )}`,
        },
        202
      );
    }

    const targets = await resolveInitialAccountDirectoryWriteTargets(c.env, result.publication);
    const projectionRepository = new CanonicalRuntimeUserProjectionRepository(
      ensureDatabaseAdapter(targets.tenantCoreUsers, 'admin-user-create-result-core'),
      tenantId,
      new CanonicalSensitiveValueResolver(
        ensureDatabaseAdapter(targets.tenantPii, 'admin-user-create-result-pii')
      )
    );
    const createdProjection = await projectionRepository.findByLegacyUserId(
      result.operation.userId
    );
    const createdUser = createdProjection ? formatCanonicalAdminUser(createdProjection) : null;
    if (!createdUser) throw new Error('account_creation_active_projection_missing');

    await createAuditLogFromContext(c, 'user.created', 'user', result.operation.userId, {
      user_type,
    });
    scheduleAdminAuditLog(c, 'user.created', result.operation.userId, 'success', {
      user_type,
    });

    return c.json(
      {
        user: createdUser,
      },
      201
    );
  } catch (error) {
    logSanitizedError('Admin user create error', error);
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    if (
      error instanceof Error &&
      (error.message === 'account_creation_operation_idempotency_conflict' ||
        error.message === 'directory_identifier_reservation_conflict')
    ) {
      return c.json(
        {
          error: 'conflict',
          error_description: 'Unable to create user with the provided information',
        },
        409
      );
    }
    if (
      error instanceof Error &&
      error.message === 'control_account_allocation_capacity_unavailable'
    ) {
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'Account capacity is being provisioned',
        },
        503
      );
    }
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create user',
        ...getErrorDetailsForResponse(error, c.env),
      },
      500
    );
  }
}

export async function adminUserCreationOperationHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const adminAuth = getAdminAuth(c);
    const actorId = adminAuth?.actorId ?? adminAuth?.userId;
    if (!actorId) {
      return c.json(
        { error: 'access_denied', error_description: 'Administrator authentication is required' },
        403
      );
    }
    const operation = await new AccountCreationOperationRepository(
      createAuthContextFromHono(c, tenantId).coreAdapter
    ).findForActor({
      tenantId,
      actorId,
      operationId: c.req.param('operationId')!,
    });
    if (!operation) {
      return c.json(
        { error: 'not_found', error_description: 'Account creation operation was not found' },
        404
      );
    }
    return c.json({
      operation_id: operation.operationId,
      state: operation.status,
      ...(operation.status === 'succeeded' ? { user_id: operation.userId } : {}),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /^(account_creation_(tenant|actor|operation)_id_invalid)$/u.test(error.message)
    ) {
      return c.json(
        { error: 'not_found', error_description: 'Account creation operation was not found' },
        404
      );
    }
    logSanitizedError('Admin account creation operation read error', error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to read account creation operation' },
      500
    );
  }
}

/**
 * Update user.
 * PUT /admin/users/:id
 */
export async function adminUserUpdateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
    if (!customClaimSources.nonPiiDb || !customClaimSources.piiDb) {
      throw new Error('admin_user_custom_claim_sources_required');
    }
    const body = await c.req.json<{
      email?: string;
      name?: string;
      given_name?: string;
      family_name?: string;
      nickname?: string;
      preferred_username?: string;
      email_verified?: boolean;
      phone_number?: string;
      phone_number_verified?: boolean;
      picture?: string;
      user_type?: string;
      [key: string]: string | boolean | number | null | undefined;
    }>();
    const customFieldInput = extractCustomClaimInput(body, ADMIN_USER_UPDATE_RESERVED_FIELDS);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const projectionRepository = createCanonicalRuntimeUserProjectionRepository(
      c,
      authCtx.coreAdapter,
      tenantId
    );
    if (!projectionRepository) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    const existingProjection = await projectionRepository.findByLegacyUserId(userId, {
      includeInactive: true,
    });

    if (!existingProjection) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const customFieldValidation = await validateCustomClaimWrite({
      db: customClaimSources.nonPiiDb,
      dbPii: customClaimSources.piiDb,
      schemaDb: customClaimSources.schemaDb,
      tenantId,
      userId,
      submitted: customFieldInput,
      requireCompleteRecord: true,
    });

    if (!customFieldValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: customFieldValidation.error,
          missing_required_fields: customFieldValidation.missingRequiredFields?.map((field) => ({
            field_key: field.fieldKey,
            label: field.label,
            field_type: field.fieldType,
          })),
        },
        400
      );
    }

    const hasCustomFieldChanges =
      Object.keys(customFieldValidation.nonPiiValues).length > 0 ||
      Object.keys(customFieldValidation.piiValues).length > 0 ||
      customFieldValidation.nonPiiKeysToDelete.length > 0 ||
      customFieldValidation.piiKeysToDelete.length > 0;

    if (
      body.email_verified === undefined &&
      body.phone_number_verified === undefined &&
      body.user_type === undefined &&
      body.name === undefined &&
      body.given_name === undefined &&
      body.family_name === undefined &&
      body.nickname === undefined &&
      body.preferred_username === undefined &&
      body.phone_number === undefined &&
      body.picture === undefined &&
      !hasCustomFieldChanges
    ) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'No fields to update',
        },
        400
      );
    }

    if (hasCustomFieldChanges) {
      await persistCustomClaimWrite({
        db: customClaimSources.nonPiiDb,
        dbPii: customClaimSources.piiDb,
        schemaDb: customClaimSources.schemaDb,
        tenantId,
        userId,
        validation: customFieldValidation,
      });
      await syncUserLifecycleState({
        db: customClaimSources.nonPiiDb,
        dbPii: customClaimSources.piiDb,
        schemaDb: customClaimSources.schemaDb,
        stateDb: authCtx.coreAdapter,
        tenantId,
        userId,
        accountAuthenticationEnv: c.env,
      });
    }

    await maybeSyncCanonicalRuntimeUserForAdmin(
      c,
      authCtx.coreAdapter,
      tenantId,
      userId,
      {
        email_verified: body.email_verified ?? Boolean(existingProjection.email_verified),
        phone_number_verified:
          body.phone_number_verified ?? Boolean(existingProjection.phone_number_verified),
        user_type:
          typeof body.user_type === 'string'
            ? body.user_type
            : userTypeFromAccountType(existingProjection.account_type),
        is_active: Boolean(existingProjection.active),
      },
      {
        email: existingProjection.email ?? '',
        phone_number: body.phone_number ?? existingProjection.phone_number,
        name: body.name ?? existingProjection.name,
        given_name: body.given_name ?? existingProjection.given_name,
        family_name: body.family_name ?? existingProjection.family_name,
        nickname: body.nickname ?? existingProjection.nickname,
        preferred_username: body.preferred_username ?? existingProjection.preferred_username,
        picture: body.picture ?? existingProjection.picture,
      }
    );

    await invalidateUserCache(c.env, tenantId, userId);
    const updatedProjection = await projectionRepository.findByLegacyUserId(userId, {
      includeInactive: true,
    });
    const updatedUser = updatedProjection ? formatCanonicalAdminUser(updatedProjection) : null;

    const log = getLogger(c).module('ADMIN-USER');
    publishEvent(c, {
      type: USER_EVENTS.UPDATED,
      tenantId: getTenantIdFromContext(c),
      data: {
        userId,
      } satisfies UserEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish user.updated event', { action: 'publish_event' }, err as Error);
    });

    await createAuditLogFromContext(c, 'user.updated', 'user', userId, {
      user_type: updatedUser?.user_type,
    });
    scheduleAdminAuditLog(c, 'user.updated', userId, 'success', {
      user_type: updatedUser?.user_type,
    });

    return c.json({
      user: updatedUser,
    });
  } catch (error) {
    logSanitizedError('Admin user update error', error);
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update user',
      },
      500
    );
  }
}

/**
 * Delete user.
 * DELETE /admin/users/:id
 */
export async function adminUserDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    if (usesTenantD1Storage(c)) {
      const routes = await new CrossShardAccountExactSearchService(c.env).find({
        tenantId,
        identifier: userId,
        purpose: 'account_delete_retry',
      });
      if (routes.length === 0) {
        return c.json(
          {
            error: 'not_found',
            error_description: 'The requested resource was not found',
          },
          404
        );
      }
      if (routes.length !== 1 || routes[0].legacyUserId !== userId) {
        throw new Error('admin_user_route_projection_invalid');
      }
      const route = routes[0];
      const core = accountRouteAdapter(c.env, route.coreBindingRef, 'core');
      const pii = accountRouteAdapter(c.env, route.piiBindingRef, 'pii');
      const projection = await new CanonicalRuntimeUserProjectionRepository(
        core,
        tenantId,
        new CanonicalSensitiveValueResolver(pii)
      ).findByAccountId(route.id, { includeInactive: true });
      const retryingAfterProjectionErasure =
        !projection && (route.lifecycleState === 'deleting' || route.lifecycleState === 'deleted');
      if (
        (!projection && !retryingAfterProjectionErasure) ||
        (projection && (projection.id !== userId || projection.tenant_id !== tenantId))
      ) {
        throw new Error('admin_user_route_projection_invalid');
      }
      const deletingVersionMs = Date.now();
      await transitionAccountAuthenticationState(c.env, {
        tenantId,
        userId,
        lifecycle: 'deleting',
        sourceVersionMs: deletingVersionMs,
        operationId: crypto.randomUUID(),
        revokeSessions: true,
      });
      const removals = await prepareAccountDirectoryRemoval(c.env, {
        tenantId,
        userId,
        core,
        pii,
      });
      const tombstones = new TombstoneRepository(pii);
      if (!(await tombstones.findByUserId(tenantId, userId, pii))) {
        await tombstones.createTombstone(
          {
            id: userId,
            tenant_id: tenantId,
            email_blind_index: null,
            deleted_by: 'admin',
            deletion_reason: 'admin_action',
            retention_days: 90,
            metadata: { source: 'admin_api' },
          },
          pii
        );
      }
      await eraseAccountPiiAfterDirectoryRemovalPrepared(pii, { tenantId, userId });
      await new CanonicalRuntimeUserWriter(
        new CanonicalIdentityRepository(core, tenantId),
        pii
      ).deleteRuntimeUser(userId);
      await transitionAccountAuthenticationState(c.env, {
        tenantId,
        userId,
        lifecycle: 'deleted',
        sourceVersionMs: Math.max(Date.now(), deletingVersionMs + 1),
        operationId: crypto.randomUUID(),
        revokeSessions: true,
      });
      await markAccountDirectoryRemovalsReady(core, removals);
      await attemptImmediateAccountDirectoryRemovals(c.env.ACCOUNT_DIRECTORY, removals);
      await invalidateUserCache(c.env, tenantId, userId);
      await createAuditLogFromContext(c, 'user.deleted', 'user', userId, {});
      scheduleAdminAuditLog(c, 'user.deleted', userId, 'success');
      return c.json({
        success: true,
        message: 'User deleted successfully',
      });
    }
    const authCtx = createAuthContextFromHono(c, tenantId);
    const projectionRepository = createCanonicalRuntimeUserProjectionRepository(
      c,
      authCtx.coreAdapter,
      tenantId
    );
    if (!projectionRepository) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    const projection = await projectionRepository.findByLegacyUserId(userId, {
      includeInactive: true,
    });

    if (!projection) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const deletingVersionMs = Date.now();
    await transitionAccountAuthenticationState(c.env, {
      tenantId,
      userId,
      lifecycle: 'deleting',
      sourceVersionMs: deletingVersionMs,
      operationId: crypto.randomUUID(),
      revokeSessions: true,
    });

    const piiAdapter = resolveAdminPiiAdapter(c, tenantId);
    if (piiAdapter) {
      await new TombstoneRepository(piiAdapter).createTombstone(
        {
          id: userId,
          tenant_id: tenantId,
          email_blind_index: null,
          deleted_by: 'admin',
          deletion_reason: 'admin_action',
          retention_days: 90,
          metadata: {
            source: 'admin_api',
            timestamp: new Date().toISOString(),
          },
        },
        piiAdapter
      );
    }

    await maybeDeleteCanonicalRuntimeUserForAdmin(c, authCtx.coreAdapter, tenantId, userId);
    await transitionAccountAuthenticationState(c.env, {
      tenantId,
      userId,
      lifecycle: 'deleted',
      sourceVersionMs: Math.max(Date.now(), deletingVersionMs + 1),
      operationId: crypto.randomUUID(),
      revokeSessions: true,
    });
    await invalidateUserCache(c.env, tenantId, userId);

    const log = getLogger(c).module('ADMIN-USER');
    publishEvent(c, {
      type: USER_EVENTS.DELETED,
      tenantId,
      data: {
        userId,
      } satisfies UserEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish user.deleted event', { action: 'publish_event' }, err as Error);
    });

    await createAuditLogFromContext(c, 'user.deleted', 'user', userId, {});
    scheduleAdminAuditLog(c, 'user.deleted', userId, 'success');

    return c.json({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (error) {
    logSanitizedError('Admin user delete error', error);
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete user',
      },
      500
    );
  }
}

/**
 * Retry PII creation for a user with failed PII status.
 * POST /admin/users/:id/retry-pii
 */
export async function adminUserRetryPiiHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const projectionRepository = createCanonicalRuntimeUserProjectionRepository(
      c,
      authCtx.coreAdapter,
      tenantId
    );
    if (!projectionRepository) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    const projection = await projectionRepository.findByLegacyUserId(userId, {
      includeInactive: true,
    });

    if (!projection) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const body = await c.req.json<{
      email: string;
      name?: string;
      given_name?: string;
      family_name?: string;
      nickname?: string;
      preferred_username?: string;
      phone_number?: string;
      picture?: string;
      website?: string;
      gender?: string;
      birthdate?: string;
      locale?: string;
      zoneinfo?: string;
      address_formatted?: string;
      address_street_address?: string;
      address_locality?: string;
      address_region?: string;
      address_postal_code?: string;
      address_country?: string;
      declared_residence?: string;
    }>();

    if (!body.email) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'email is required',
        },
        400
      );
    }

    const addressJson = buildAddressJsonFromAdminBody(body);
    await createCanonicalRuntimeUserWriter(c, authCtx.coreAdapter, tenantId).syncFromRuntimeUser({
      userId,
      tenantId,
      active: Boolean(projection.active),
      emailVerified: Boolean(projection.email_verified),
      phoneNumberVerified: Boolean(projection.phone_number_verified),
      userType: userTypeFromAccountType(projection.account_type),
      displayName: body.name ?? projection.name ?? body.email,
      sourceRef: 'admin:/users/retry-pii',
      piiFields: {
        email: true,
        phone_number: body.phone_number !== undefined,
        name: body.name !== undefined,
        given_name: body.given_name !== undefined,
        family_name: body.family_name !== undefined,
        nickname: body.nickname !== undefined,
        preferred_username: body.preferred_username !== undefined,
        picture: body.picture !== undefined,
        website: body.website !== undefined,
        gender: body.gender !== undefined,
        birthdate: body.birthdate !== undefined,
        locale: body.locale !== undefined,
        zoneinfo: body.zoneinfo !== undefined,
      },
      sensitiveValues: {
        email: body.email,
        phone_number: body.phone_number,
        name: body.name,
        given_name: body.given_name,
        family_name: body.family_name,
        nickname: body.nickname,
        preferred_username: body.preferred_username,
        picture: body.picture,
        website: body.website,
        gender: body.gender,
        birthdate: body.birthdate,
        locale: body.locale,
        zoneinfo: body.zoneinfo,
      },
      ...(addressJson !== undefined ? { addressJson } : {}),
    });

    await invalidateUserCache(c.env, tenantId, userId);

    return c.json({
      success: true,
      message: 'Canonical PII values updated successfully',
      user_id: userId,
      pii_status: 'active',
    });
  } catch (error) {
    logSanitizedError('Admin user retry PII error', error);
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retry PII creation',
        ...getErrorDetailsForResponse(error, c.env),
      },
      500
    );
  }
}

/**
 * Delete user's PII data only.
 * DELETE /admin/users/:id/pii
 */
export async function adminUserDeletePiiHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const projectionRepository = createCanonicalRuntimeUserProjectionRepository(
      c,
      authCtx.coreAdapter,
      tenantId
    );
    if (!projectionRepository) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    const projection = await projectionRepository.findByLegacyUserId(userId, {
      includeInactive: true,
    });

    if (!projection) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    let body: { reason?: string; retention_days?: number } = {};
    try {
      body = await c.req.json();
    } catch {
      // No body is fine, use defaults.
    }

    const deletionReason = body.reason ?? 'user_request';
    const retentionDays = body.retention_days ?? 90;
    const piiAdapter = resolveAdminPiiAdapter(c, tenantId);
    if (!piiAdapter) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    await new TombstoneRepository(piiAdapter).createTombstone(
      {
        id: userId,
        tenant_id: tenantId,
        email_blind_index: null,
        deleted_by: 'admin',
        deletion_reason: deletionReason,
        retention_days: retentionDays,
        metadata: {
          source: 'admin_api_pii_deletion',
          timestamp: new Date().toISOString(),
          user_active: true,
        },
      },
      piiAdapter
    );

    await createCanonicalRuntimeUserWriter(c, authCtx.coreAdapter, tenantId).syncFromRuntimeUser({
      userId,
      tenantId,
      active: Boolean(projection.active),
      emailVerified: false,
      phoneNumberVerified: false,
      userType: userTypeFromAccountType(projection.account_type),
      displayName: null,
      sourceRef: 'admin:/users/pii',
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
      sensitiveValues: buildCanonicalPiiDeletionPatch(),
      addressJson: null,
      customAttributesJson: null,
    });

    await invalidateUserCache(c.env, tenantId, userId);
    await createAuditLogFromContext(c, 'user.pii_deleted', 'user', userId, {
      reason: deletionReason,
      retention_days: retentionDays,
    });
    scheduleAdminAuditLog(c, 'user.pii_deleted', userId, 'success', {
      reason: deletionReason,
      retention_days: retentionDays,
    });

    return c.json({
      success: true,
      message: 'User PII deleted successfully. User account remains active.',
      user_id: userId,
      pii_status: 'deleted',
      tombstone_created: true,
      retention_days: retentionDays,
    });
  } catch (error) {
    logSanitizedError('Admin user delete PII error', error);
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete user PII',
        ...getErrorDetailsForResponse(error, c.env),
      },
      500
    );
  }
}
