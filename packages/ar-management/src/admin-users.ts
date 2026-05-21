import { Context } from 'hono';
import type { Env, UserCore, UserPII } from '@authrim/ar-lib-core';
import {
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

/**
 * Get admin statistics.
 * GET /admin/stats
 */
export async function adminStatsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
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
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND last_login_at > ? AND is_active = 1',
        [tenantId, thirtyDaysAgo]
      ),
      authCtx.coreAdapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND is_active = 1',
        [tenantId]
      ),
      authCtx.coreAdapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM oauth_clients WHERE tenant_id = ?',
        [tenantId]
      ),
      authCtx.coreAdapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND created_at >= ? AND is_active = 1',
        [tenantId, todayStart]
      ),
      authCtx.coreAdapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND last_login_at >= ? AND is_active = 1',
        [tenantId, todayStart]
      ),
      authCtx.coreAdapter.query<{ pii_status: string; count: number }>(
        'SELECT pii_status, COUNT(*) as count FROM users_core WHERE tenant_id = ? AND is_active = 1 GROUP BY pii_status',
        [tenantId]
      ),
      authCtx.coreAdapter.query<{ id: string; created_at: number }>(
        'SELECT id, created_at FROM users_core WHERE tenant_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 10',
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

    if (hasPIIDatabase(c) && recentUsersCoreResult.length > 0) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const userIds = recentUsersCoreResult.map((u) => u.id);
      const placeholders = userIds.map(() => '?').join(',');
      const piiResults = await piiCtx.defaultPiiAdapter.query<{
        id: string;
        email: string | null;
        name: string | null;
      }>(`SELECT id, email, name FROM users_pii WHERE tenant_id = ? AND id IN (${placeholders})`, [
        tenantId,
        ...userIds,
      ]);

      const piiMap = new Map<string, { email: string | null; name: string | null }>();
      for (const pii of piiResults) {
        piiMap.set(pii.id, { email: pii.email, name: pii.name });
      }

      recentActivity = recentUsersCoreResult.map((user) => {
        const pii = piiMap.get(user.id);
        return {
          type: 'user_registration',
          userId: user.id,
          email: pii?.email ?? null,
          name: pii?.name ?? null,
          timestamp: toMilliseconds(user.created_at) ?? 0,
        };
      });
    } else {
      recentActivity = recentUsersCoreResult.map((user) => ({
        type: 'user_registration',
        userId: user.id,
        email: null,
        name: null,
        timestamp: toMilliseconds(user.created_at) ?? 0,
      }));
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

    let matchingUserIds: string[] | null = null;

    if (search && hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const escapedSearch = escapeLikePattern(search);
      const piiSearchResult = await piiCtx.defaultPiiAdapter.query<{ id: string }>(
        "SELECT id FROM users_pii WHERE tenant_id = ? AND (email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')",
        [tenantId, `%${escapedSearch}%`, `%${escapedSearch}%`]
      );
      matchingUserIds = piiSearchResult.map((r) => r.id);

      if (matchingUserIds.length === 0) {
        return c.json({
          users: [],
          pagination: {
            page,
            limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        });
      }
    }

    let coreQuery = 'SELECT * FROM users_core WHERE tenant_id = ? AND is_active = 1';
    let countQuery =
      'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND is_active = 1';
    const coreBindings: unknown[] = [tenantId];
    const countBindings: unknown[] = [tenantId];

    if (matchingUserIds !== null) {
      const placeholders = matchingUserIds.map(() => '?').join(',');
      coreQuery += ` AND id IN (${placeholders})`;
      countQuery += ` AND id IN (${placeholders})`;
      coreBindings.push(...matchingUserIds);
      countBindings.push(...matchingUserIds);
    }

    if (verified !== undefined) {
      coreQuery += ' AND email_verified = ?';
      countQuery += ' AND email_verified = ?';
      const verifiedValue = verified === 'true' ? 1 : 0;
      coreBindings.push(verifiedValue);
      countBindings.push(verifiedValue);
    }

    if (piiStatus !== undefined) {
      const validStatuses = ['none', 'pending', 'active', 'failed', 'deleted'];
      if (validStatuses.includes(piiStatus)) {
        coreQuery += ' AND pii_status = ?';
        countQuery += ' AND pii_status = ?';
        coreBindings.push(piiStatus);
        countBindings.push(piiStatus);
      }
    }

    if (lifecycleState !== undefined && VALID_USER_LIFECYCLE_STATES.has(lifecycleState)) {
      coreQuery += ' AND lifecycle_state = ?';
      countQuery += ' AND lifecycle_state = ?';
      coreBindings.push(lifecycleState);
      countBindings.push(lifecycleState);
    }

    coreQuery += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    coreBindings.push(limit, offset);

    const [totalResult, coreUsers] = await Promise.all([
      authCtx.coreAdapter.queryOne<{ count: number }>(countQuery, countBindings),
      authCtx.coreAdapter.query<UserCore>(coreQuery, coreBindings),
    ]);

    const total = totalResult?.count || 0;
    const totalPages = Math.ceil(total / limit);
    let formattedUsers: unknown[] = [];

    if (coreUsers.length > 0 && hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const userIds = coreUsers.map((u) => u.id);
      const placeholders = userIds.map(() => '?').join(',');
      const piiResults = await piiCtx.defaultPiiAdapter.query<UserPII>(
        `SELECT * FROM users_pii WHERE tenant_id = ? AND id IN (${placeholders})`,
        [tenantId, ...userIds]
      );

      const piiMap = new Map<string, UserPII>();
      for (const pii of piiResults) {
        piiMap.set(pii.id, pii);
      }

      formattedUsers = coreUsers.map((core) => {
        const pii = piiMap.get(core.id);
        return {
          id: core.id,
          tenant_id: core.tenant_id,
          email: pii?.email ?? null,
          name: pii?.name ?? null,
          given_name: pii?.given_name ?? null,
          family_name: pii?.family_name ?? null,
          nickname: pii?.nickname ?? null,
          preferred_username: pii?.preferred_username ?? null,
          picture: pii?.picture ?? null,
          phone_number: pii?.phone_number ?? null,
          email_verified: Boolean(core.email_verified),
          phone_number_verified: Boolean(core.phone_number_verified),
          user_type: core.user_type,
          is_active: Boolean(core.is_active),
          pii_partition: core.pii_partition,
          pii_status: core.pii_status,
          created_at: toMilliseconds(core.created_at),
          updated_at: toMilliseconds(core.updated_at),
          last_login_at: toMilliseconds(core.last_login_at),
          status: core.status ?? 'active',
          suspended_at: toMilliseconds(core.suspended_at),
          suspended_until: toMilliseconds(core.suspended_until),
          locked_at: toMilliseconds(core.locked_at),
          locked_until: toMilliseconds(core.locked_until),
          lifecycle_state: core.lifecycle_state ?? 'active',
        };
      });
    } else if (coreUsers.length > 0) {
      formattedUsers = coreUsers.map((core) => ({
        id: core.id,
        tenant_id: core.tenant_id,
        email: null,
        name: null,
        email_verified: Boolean(core.email_verified),
        phone_number_verified: Boolean(core.phone_number_verified),
        user_type: core.user_type,
        is_active: Boolean(core.is_active),
        pii_partition: core.pii_partition,
        pii_status: core.pii_status,
        created_at: toMilliseconds(core.created_at),
        updated_at: toMilliseconds(core.updated_at),
        last_login_at: toMilliseconds(core.last_login_at),
        status: core.status ?? 'active',
        suspended_at: toMilliseconds(core.suspended_at),
        suspended_until: toMilliseconds(core.suspended_until),
        locked_at: toMilliseconds(core.locked_at),
        locked_until: toMilliseconds(core.locked_until),
        lifecycle_state: core.lifecycle_state ?? 'active',
      }));
    }

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
    const userCore = await authCtx.repositories.userCore.findById(userId);

    if (!userCore) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    let userPII: UserPII | null = null;
    if (hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);
      userPII = await piiCtx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
    }

    const passkeys = await authCtx.repositories.passkey.findByUserId(userId);
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

    const formattedUser = {
      id: userCore.id,
      tenant_id: userCore.tenant_id,
      email: userPII?.email ?? null,
      name: userPII?.name ?? null,
      given_name: userPII?.given_name ?? null,
      family_name: userPII?.family_name ?? null,
      nickname: userPII?.nickname ?? null,
      preferred_username: userPII?.preferred_username ?? null,
      picture: userPII?.picture ?? null,
      phone_number: userPII?.phone_number ?? null,
      website: userPII?.website ?? null,
      gender: userPII?.gender ?? null,
      birthdate: userPII?.birthdate ?? null,
      locale: userPII?.locale ?? null,
      zoneinfo: userPII?.zoneinfo ?? null,
      address_formatted: userPII?.address_formatted ?? null,
      address_street_address: userPII?.address_street_address ?? null,
      address_locality: userPII?.address_locality ?? null,
      address_region: userPII?.address_region ?? null,
      address_postal_code: userPII?.address_postal_code ?? null,
      address_country: userPII?.address_country ?? null,
      declared_residence: userPII?.declared_residence ?? null,
      pii_class: userPII?.pii_class ?? null,
      email_verified: userCore.email_verified,
      phone_number_verified: userCore.phone_number_verified,
      user_type: userCore.user_type,
      is_active: userCore.is_active,
      pii_partition: userCore.pii_partition,
      pii_status: userCore.pii_status,
      created_at: toMilliseconds(userCore.created_at),
      updated_at: toMilliseconds(userCore.updated_at),
      last_login_at: toMilliseconds(userCore.last_login_at),
      status: userCore.status,
      suspended_at: toMilliseconds(userCore.suspended_at),
      suspended_until: toMilliseconds(userCore.suspended_until),
      locked_at: toMilliseconds(userCore.locked_at),
      locked_until: toMilliseconds(userCore.locked_until),
      lifecycle_state: userCore.lifecycle_state ?? 'active',
    };

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

    if (hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const emailExists = await piiCtx.piiRepositories.userPII.emailExists(tenantId, email);

      if (emailExists) {
        return c.json(
          {
            error: 'conflict',
            error_description: 'Unable to create user with the provided information',
          },
          409
        );
      }
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

    const userId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId);

    await authCtx.repositories.userCore.createUser({
      id: userId,
      tenant_id: tenantId,
      email_verified: email_verified ?? false,
      phone_number_verified: phone_number_verified ?? false,
      user_type: (user_type as 'end_user' | 'admin' | 'm2m') || 'end_user',
      pii_partition: 'default',
      pii_status: 'pending',
    });

    if (hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      try {
        await piiCtx.piiRepositories.userPII.createPII({
          id: userId,
          tenant_id: tenantId,
          pii_class: 'PROFILE',
          email,
          phone_number: phone_number ?? null,
          name: name ?? null,
          given_name: given_name ?? null,
          family_name: family_name ?? null,
          nickname: nickname ?? null,
          preferred_username: preferred_username ?? null,
          picture: picture ?? null,
        });

        await authCtx.repositories.userCore.updatePIIStatus(userId, 'active');
      } catch (piiError) {
        logSanitizedError('PII insert failed', piiError);
        await authCtx.repositories.userCore.updatePIIStatus(userId, 'failed');
        throw piiError;
      }
    } else {
      await authCtx.repositories.userCore.updatePIIStatus(userId, 'none');
    }

    try {
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
        'Custom claim persistence failed during admin user create',
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

        if (customClaimSources.piiDb) {
          await ensureDatabaseAdapter(
            customClaimSources.piiDb,
            'admin-user-create-rollback-pii'
          ).execute('DELETE FROM users_pii WHERE id = ? AND tenant_id = ?', [userId, tenantId]);
        }

        await authCtx.coreAdapter.execute('DELETE FROM users_core WHERE id = ? AND tenant_id = ?', [
          userId,
          tenantId,
        ]);
      } catch (cleanupError) {
        logSanitizedError(
          'Failed to rollback admin user create after custom claim persistence failure',
          cleanupError
        );
      }

      throw customFieldError;
    }

    const userCore = await authCtx.repositories.userCore.findById(userId);

    let userPII: UserPII | null = null;
    if (hasPIIDatabase(c) && userCore) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);
      userPII = await piiCtx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
    }

    const createdUser = {
      id: userCore?.id,
      tenant_id: userCore?.tenant_id,
      email: userPII?.email ?? null,
      name: userPII?.name ?? null,
      given_name: userPII?.given_name ?? null,
      family_name: userPII?.family_name ?? null,
      nickname: userPII?.nickname ?? null,
      preferred_username: userPII?.preferred_username ?? null,
      picture: userPII?.picture ?? null,
      phone_number: userPII?.phone_number ?? null,
      email_verified: userCore?.email_verified ?? false,
      phone_number_verified: userCore?.phone_number_verified ?? false,
      user_type: userCore?.user_type,
      is_active: userCore?.is_active ?? false,
      pii_partition: userCore?.pii_partition,
      pii_status: userCore?.pii_status,
      created_at: toMilliseconds(userCore?.created_at),
      updated_at: toMilliseconds(userCore?.updated_at),
    };

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
      user_type: userCore?.user_type,
    });
    scheduleAdminAuditLog(c, 'user.created', userId, 'success', {
      user_type: userCore?.user_type,
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
    const userCore = await authCtx.repositories.userCore.findById(userId);

    if (!userCore) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const coreUpdateData: Record<string, unknown> = {};
    const piiUpdateData: Record<string, unknown> = {};

    if (body.email_verified !== undefined) {
      coreUpdateData.email_verified = body.email_verified;
    }
    if (body.phone_number_verified !== undefined) {
      coreUpdateData.phone_number_verified = body.phone_number_verified;
    }
    if (body.user_type !== undefined) {
      coreUpdateData.user_type = body.user_type;
    }

    if (body.name !== undefined) {
      piiUpdateData.name = body.name;
    }
    if (body.given_name !== undefined) {
      piiUpdateData.given_name = body.given_name;
    }
    if (body.family_name !== undefined) {
      piiUpdateData.family_name = body.family_name;
    }
    if (body.nickname !== undefined) {
      piiUpdateData.nickname = body.nickname;
    }
    if (body.preferred_username !== undefined) {
      piiUpdateData.preferred_username = body.preferred_username;
    }
    if (body.phone_number !== undefined) {
      piiUpdateData.phone_number = body.phone_number;
    }
    if (body.picture !== undefined) {
      piiUpdateData.picture = body.picture;
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
      Object.keys(coreUpdateData).length === 0 &&
      Object.keys(piiUpdateData).length === 0 &&
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

    const hasPiiFieldChanges = Object.keys(piiUpdateData).length > 0;
    const hasPiiCustomFieldChanges =
      Object.keys(customFieldValidation.piiValues).length > 0 ||
      customFieldValidation.piiKeysToDelete.length > 0;
    const requiresPiiCompensation =
      hasPIIDatabase(c) && (hasPiiFieldChanges || hasPiiCustomFieldChanges);

    await runPIIWriteWithCompensation({
      userId,
      userCore: authCtx.repositories.userCore,
      requiresPIIWrite: requiresPiiCompensation,
      write: async () => {
        if (Object.keys(coreUpdateData).length > 0) {
          await authCtx.repositories.userCore.update(userId, coreUpdateData);
        }

        if (hasPiiFieldChanges && hasPIIDatabase(c)) {
          const piiCtx = createPIIContextFromHono(c, tenantId);
          const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);
          await piiCtx.piiRepositories.userPII.updatePII(userId, piiUpdateData, piiAdapter);
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
      },
    });

    await invalidateUserCache(c.env, tenantId, userId);
    const updatedCore = await authCtx.repositories.userCore.findById(userId);

    let updatedPII: UserPII | null = null;
    if (hasPIIDatabase(c) && updatedCore) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiAdapter = piiCtx.getPiiAdapter(updatedCore.pii_partition);
      updatedPII = await piiCtx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
    }

    const updatedUser = {
      id: updatedCore?.id,
      tenant_id: updatedCore?.tenant_id,
      email: updatedPII?.email ?? null,
      name: updatedPII?.name ?? null,
      given_name: updatedPII?.given_name ?? null,
      family_name: updatedPII?.family_name ?? null,
      nickname: updatedPII?.nickname ?? null,
      preferred_username: updatedPII?.preferred_username ?? null,
      picture: updatedPII?.picture ?? null,
      phone_number: updatedPII?.phone_number ?? null,
      email_verified: updatedCore?.email_verified ?? false,
      phone_number_verified: updatedCore?.phone_number_verified ?? false,
      user_type: updatedCore?.user_type,
      is_active: updatedCore?.is_active ?? false,
      pii_partition: updatedCore?.pii_partition,
      pii_status: updatedCore?.pii_status,
      created_at: toMilliseconds(updatedCore?.created_at),
      updated_at: toMilliseconds(updatedCore?.updated_at),
      last_login_at: toMilliseconds(updatedCore?.last_login_at),
    };

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
      user_type: updatedCore?.user_type,
    });
    scheduleAdminAuditLog(c, 'user.updated', userId, 'success', {
      user_type: updatedCore?.user_type,
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
    const userCore = await authCtx.repositories.userCore.findById(userId);

    if (!userCore) {
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
      const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);
      const userPII = await piiCtx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
      const emailBlindIndex = userPII?.email_blind_index ?? null;

      await piiCtx.piiRepositories.tombstone.createTombstone(
        {
          id: userId,
          tenant_id: tenantId,
          email_blind_index: emailBlindIndex,
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

      await piiCtx.piiRepositories.userPII.deletePII(userId, piiAdapter);
    }

    await authCtx.repositories.userCore.update(userId, {
      is_active: false,
      pii_status: 'deleted',
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
    const userCore = await authCtx.repositories.userCore.findById(userId);

    if (!userCore) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    if (userCore.pii_status !== 'failed') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `User PII status is '${userCore.pii_status}', not 'failed'. Retry is only available for users with failed PII status.`,
        },
        400
      );
    }

    if (!hasPIIDatabase(c)) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Configured PII store is not available',
        },
        500
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

    const piiCtx = createPIIContextFromHono(c, tenantId);
    const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);
    const existingPii = await piiCtx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
    if (existingPii) {
      await authCtx.repositories.userCore.update(userId, {
        pii_status: 'active',
      });

      return c.json({
        success: true,
        message: 'PII already exists. Status updated to active.',
        user_id: userId,
        pii_status: 'active',
      });
    }

    await piiCtx.piiRepositories.userPII.createPII(
      {
        id: userId,
        tenant_id: tenantId,
        email: body.email,
        name: body.name,
        given_name: body.given_name,
        family_name: body.family_name,
        nickname: body.nickname,
        preferred_username: body.preferred_username,
        phone_number: body.phone_number,
        picture: body.picture,
        website: body.website,
        gender: body.gender,
        birthdate: body.birthdate,
        locale: body.locale,
        zoneinfo: body.zoneinfo,
        address_formatted: body.address_formatted,
        address_street_address: body.address_street_address,
        address_locality: body.address_locality,
        address_region: body.address_region,
        address_postal_code: body.address_postal_code,
        address_country: body.address_country,
        declared_residence: body.declared_residence,
      },
      piiAdapter
    );

    await authCtx.repositories.userCore.update(userId, {
      pii_status: 'active',
    });

    await invalidateUserCache(c.env, tenantId, userId);

    return c.json({
      success: true,
      message: 'PII created successfully',
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
    const userCore = await authCtx.repositories.userCore.findById(userId);

    if (!userCore) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    if (userCore.pii_status === 'deleted') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User PII is already deleted',
        },
        400
      );
    }

    if (userCore.pii_status === 'none') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User has no PII data (pii_status is none)',
        },
        400
      );
    }

    if (!hasPIIDatabase(c)) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Configured PII store is not available',
        },
        500
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
    const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);
    const userPII = await piiCtx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
    const emailBlindIndex = userPII?.email_blind_index ?? null;

    await piiCtx.piiRepositories.tombstone.createTombstone(
      {
        id: userId,
        tenant_id: tenantId,
        email_blind_index: emailBlindIndex,
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

    await piiCtx.piiRepositories.userPII.deletePII(userId, piiAdapter);
    await piiCtx.piiRepositories.linkedIdentity.deleteByUserId(piiCtx.tenantId, userId, piiAdapter);
    await piiCtx.piiRepositories.identifier.deleteByUserId(piiCtx.tenantId, userId, piiAdapter);

    await authCtx.repositories.userCore.update(userId, {
      pii_status: 'deleted',
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
