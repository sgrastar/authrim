import { Context } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  CanonicalIdentityRepository,
  CanonicalRuntimeUserProjectionRepository,
  CanonicalRuntimeUserWriter,
  CanonicalSensitiveValueResolver,
  invalidateUserCache,
  getTenantIdFromContext,
  createPIIContextFromHono,
  createAuthContextFromHono,
  hasPIIDatabase,
  generateUserIdFromSettings,
  ensureDatabaseAdapter,
  createErrorResponse,
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
  runPIIWriteWithCompensation,
  type CanonicalRuntimeUserProjection,
} from '@authrim/ar-lib-core';
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

function createCanonicalRuntimeUserWriter(
  c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  tenantId: string
): CanonicalRuntimeUserWriter {
  const piiCtx = createPIIContextFromHono(c, tenantId);
  return new CanonicalRuntimeUserWriter(
    new CanonicalIdentityRepository(coreAdapter, tenantId),
    piiCtx.defaultPiiAdapter
  );
}

function createCanonicalRuntimeUserProjectionRepository(
  c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  tenantId: string
): CanonicalRuntimeUserProjectionRepository | null {
  if (!hasPIIDatabase(c)) {
    return null;
  }
  const piiCtx = createPIIContextFromHono(c, tenantId);
  return new CanonicalRuntimeUserProjectionRepository(
    coreAdapter,
    tenantId,
    new CanonicalSensitiveValueResolver(piiCtx.defaultPiiAdapter)
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

function formatCanonicalAdminUser(projection: CanonicalRuntimeUserProjection) {
  const address = addressPartsFromProjection(projection);
  const createdAt = Date.parse(projection.created_at);
  const updatedAt = Date.parse(projection.updated_at);
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
    pii_status: projection.active ? 'active' : 'deleted',
    created_at: Number.isFinite(createdAt) ? createdAt : null,
    updated_at: Number.isFinite(updatedAt) ? updatedAt : null,
    last_login_at: null,
    status: projection.active ? 'active' : 'inactive',
    suspended_at: null,
    suspended_until: null,
    locked_at: null,
    locked_until: null,
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

async function maybeCreateCanonicalRuntimeUserForAdmin(
  c: Context<{ Bindings: Env }>,
  coreAdapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  userCore: Pick<AdminRuntimeUserCore, 'email_verified' | 'phone_number_verified' | 'user_type'>,
  userPII: AdminRuntimeUserPII | null
): Promise<void> {
  await createCanonicalRuntimeUserWriter(c, coreAdapter, tenantId).createFromRuntimeUser({
    userId,
    tenantId,
    active: true,
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
    const page = parseInt(c.req.query('page') || '1');
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')));
    const search = c.req.query('search') || '';
    const verified = c.req.query('verified');
    const piiStatus = c.req.query('pii_status');
    const lifecycleState = c.req.query('lifecycle_state');
    const offset = (page - 1) * limit;
    const projectionRepository = createCanonicalRuntimeUserProjectionRepository(
      c,
      authCtx.coreAdapter,
      tenantId
    );
    if (!projectionRepository) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const accountRows = await authCtx.coreAdapter.query<{ legacy_user_id: string }>(
      `SELECT legacy_user_id
         FROM identity_accounts
        WHERE tenant_id = ?
          AND legacy_user_id IS NOT NULL
          AND lifecycle_state = 'active'
        ORDER BY created_at DESC`,
      [tenantId]
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
      .map(formatCanonicalAdminUser);

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

    const runtimeUserId = projection.id;
    const passkeys = await authCtx.repositories.passkey.findByUserId(runtimeUserId);
    const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
    const customFields = await ensureDatabaseAdapter(
      customClaimSources.nonPiiDb,
      'admin-user-get-custom-fields'
    ).query<{
      field_name: string;
      field_value: string;
      field_type: string;
    }>(
      'SELECT field_name, field_value, field_type FROM user_custom_fields WHERE tenant_id = ? AND user_id = ?',
      [tenantId, runtimeUserId]
    );

    const requiredViolations = await getRequiredCustomClaimViolationStatuses({
      db: customClaimSources.nonPiiDb,
      schemaDb: customClaimSources.schemaDb,
      stateDb: authCtx.coreAdapter,
      dbPii: customClaimSources.piiDb,
      cache: c.env.SETTINGS || null,
      tenantId,
      userIds: [runtimeUserId],
      syncLifecycleState: false,
    });
    const missingRequiredFields = requiredViolations.users[0]?.missingRequiredFields ?? [];

    const formattedUser = formatCanonicalAdminUser(projection);

    const formattedPasskeys = passkeys.map((p) => ({
      id: p.id,
      credential_id: p.credential_id,
      device_name: p.device_name,
      created_at: toMilliseconds(p.created_at),
      last_used_at: toMilliseconds(p.last_used_at),
    }));

    return c.json({
      user: formattedUser,
      passkeys: formattedPasskeys,
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

    if (!email) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Email is required',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
    const authCtx = createAuthContextFromHono(c, tenantId);

    if (!hasPIIDatabase(c)) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    const piiCtx = createPIIContextFromHono(c, tenantId);
    const emailExists = await piiCtx.defaultPiiAdapter.queryOne<{ id: string }>(
      `SELECT owner_id as id
         FROM identity_sensitive_values
        WHERE tenant_id = ?
          AND owner_type = 'runtime_user'
          AND value_key = 'email'
          AND value_json = ?
          AND lifecycle_state = 'active'
        LIMIT 1`,
      [tenantId, JSON.stringify(email)]
    );

    if (emailExists) {
      return c.json(
        {
          error: 'conflict',
          error_description: 'Unable to create user with the provided information',
        },
        409
      );
    }

    const customFieldValidation = await validateCustomClaimWrite({
      db: customClaimSources.nonPiiDb,
      dbPii: customClaimSources.piiDb,
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

    const userId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId, c.env);

    try {
      await maybeCreateCanonicalRuntimeUserForAdmin(
        c,
        authCtx.coreAdapter,
        tenantId,
        userId,
        {
          email_verified: email_verified ?? false,
          phone_number_verified: phone_number_verified ?? false,
          user_type: typeof user_type === 'string' ? user_type : 'end_user',
        },
        {
          email,
          phone_number: phone_number ?? null,
          name: name ?? null,
          given_name: given_name ?? null,
          family_name: family_name ?? null,
          nickname: nickname ?? null,
          preferred_username: preferred_username ?? null,
          picture: picture ?? null,
        }
      );
      await persistCustomClaimWrite({
        db: customClaimSources.nonPiiDb,
        dbPii: customClaimSources.piiDb,
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
      });
    } catch (customFieldError) {
      logSanitizedError(
        'Custom claim or canonical runtime persistence failed during admin user create',
        customFieldError
      );

      try {
        await ensureDatabaseAdapter(
          customClaimSources.nonPiiDb,
          'admin-user-create-rollback-custom-fields'
        ).execute('DELETE FROM user_custom_fields WHERE tenant_id = ? AND user_id = ?', [
          tenantId,
          userId,
        ]);

        await maybeDeleteCanonicalRuntimeUserForAdmin(c, authCtx.coreAdapter, tenantId, userId);
      } catch (cleanupError) {
        logSanitizedError(
          'Failed to rollback admin user create after custom claim persistence failure',
          cleanupError
        );
      }

      throw customFieldError;
    }

    const projectionRepository = createCanonicalRuntimeUserProjectionRepository(
      c,
      authCtx.coreAdapter,
      tenantId
    );
    const createdProjection = await projectionRepository?.findByLegacyUserId(userId);
    const createdUser = createdProjection ? formatCanonicalAdminUser(createdProjection) : null;

    const log = getLogger(c).module('ADMIN-USER');
    publishEvent(c, {
      type: USER_EVENTS.CREATED,
      tenantId,
      data: {
        userId,
      } satisfies UserEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish user.created event', { action: 'publish_event' }, err as Error);
    });

    await createAuditLogFromContext(c, 'user.created', 'user', userId, {
      user_type,
    });
    scheduleAdminAuditLog(c, 'user.created', userId, 'success', {
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

/**
 * Update user.
 * PUT /admin/users/:id
 */
export async function adminUserUpdateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
    const body = await c.req.json<{
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

    if (hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, tenantId);

      await piiCtx.piiRepositories.tombstone.createTombstone(
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
        piiCtx.defaultPiiAdapter
      );
    }

    await maybeDeleteCanonicalRuntimeUserForAdmin(c, authCtx.coreAdapter, tenantId, userId);
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
    const piiCtx = createPIIContextFromHono(c, tenantId);

    await piiCtx.piiRepositories.tombstone.createTombstone(
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
      piiCtx.defaultPiiAdapter
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
