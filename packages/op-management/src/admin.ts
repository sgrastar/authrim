/**
 * Admin API Endpoints
 * User management, client management, and statistics for administrative dashboard
 */

import { Context } from 'hono';
import type { Env, Session } from '@authrim/shared';
import {
  invalidateUserCache,
  parseRefreshTokenJti,
  buildRefreshTokenRotatorInstanceName,
  getSessionStoreBySessionId,
  getSessionStoreForNewSession,
  isShardedSessionId,
  getChallengeStoreByChallengeId,
  getTenantIdFromContext,
  createPIIContextFromHono,
  createAuthContextFromHono,
  generateId,
} from '@authrim/shared';
import type { UserCore, UserPII } from '@authrim/shared';

/**
 * Policy feature flag names mapped to camelCase property names
 */
const POLICY_FLAG_MAPPING: Record<string, string> = {
  ENABLE_ABAC: 'enableAbac',
  ENABLE_REBAC: 'enableRebac',
  ENABLE_POLICY_LOGGING: 'enablePolicyLogging',
  ENABLE_VERIFIED_ATTRIBUTES: 'enableVerifiedAttributes',
  ENABLE_CUSTOM_RULES: 'enableCustomRules',
  ENABLE_SD_JWT: 'enableSdJwt',
  ENABLE_POLICY_EMBEDDING: 'enablePolicyEmbedding',
};

/**
 * KV key prefix for policy feature flags (matches policy-core/feature-flags.ts)
 */
const POLICY_FLAGS_PREFIX = 'policy:flags:';

/**
 * KV keys for policy claims configuration
 */
const POLICY_CLAIMS_KEYS = {
  ACCESS_TOKEN_CLAIMS: 'policy:claims:access_token',
  ID_TOKEN_CLAIMS: 'policy:claims:id_token',
};

/**
 * Read policy feature flags from KV
 * Returns an object with flag values that have been set in KV
 */
async function readPolicyFlagsFromKV(env: Env): Promise<Record<string, boolean>> {
  const flags: Record<string, boolean> = {};

  if (!env.SETTINGS) {
    return flags;
  }

  for (const [kvKey, camelKey] of Object.entries(POLICY_FLAG_MAPPING)) {
    try {
      const value = await env.SETTINGS.get(`${POLICY_FLAGS_PREFIX}${kvKey}`);
      if (value !== null) {
        flags[camelKey] = value.toLowerCase() === 'true' || value === '1';
      }
    } catch {
      // Skip on error
    }
  }

  return flags;
}

/**
 * Read policy claims configuration from KV
 */
async function readPolicyClaimsFromKV(env: Env): Promise<Record<string, string>> {
  const claims: Record<string, string> = {};

  if (!env.SETTINGS) {
    return claims;
  }

  try {
    const accessTokenClaims = await env.SETTINGS.get(POLICY_CLAIMS_KEYS.ACCESS_TOKEN_CLAIMS);
    if (accessTokenClaims) {
      claims.accessTokenClaims = accessTokenClaims;
    }

    const idTokenClaims = await env.SETTINGS.get(POLICY_CLAIMS_KEYS.ID_TOKEN_CLAIMS);
    if (idTokenClaims) {
      claims.idTokenClaims = idTokenClaims;
    }
  } catch {
    // Skip on error
  }

  return claims;
}

/**
 * Sync policy settings to KV
 * Writes feature flags and claims to individual KV keys for runtime access
 */
async function syncPolicyFlagsToKV(
  env: Env,
  policy: {
    enableAbac?: boolean;
    enableRebac?: boolean;
    enablePolicyLogging?: boolean;
    enableVerifiedAttributes?: boolean;
    enableCustomRules?: boolean;
    enableSdJwt?: boolean;
    enablePolicyEmbedding?: boolean;
    accessTokenClaims?: string;
    idTokenClaims?: string;
  }
): Promise<void> {
  if (!env.SETTINGS) {
    return;
  }

  const writes: Promise<void>[] = [];

  // Sync feature flags to individual KV keys
  for (const [kvKey, camelKey] of Object.entries(POLICY_FLAG_MAPPING)) {
    const value = policy[camelKey as keyof typeof policy];
    if (typeof value === 'boolean') {
      writes.push(env.SETTINGS.put(`${POLICY_FLAGS_PREFIX}${kvKey}`, value.toString()));
    }
  }

  // Sync claims configuration
  if (policy.accessTokenClaims !== undefined) {
    writes.push(env.SETTINGS.put(POLICY_CLAIMS_KEYS.ACCESS_TOKEN_CLAIMS, policy.accessTokenClaims));
  }
  if (policy.idTokenClaims !== undefined) {
    writes.push(env.SETTINGS.put(POLICY_CLAIMS_KEYS.ID_TOKEN_CLAIMS, policy.idTokenClaims));
  }

  await Promise.all(writes);
}

/**
 * Convert timestamp to milliseconds
 * Handles both seconds (10 digits) and milliseconds (13 digits) timestamps
 */
function toMilliseconds(timestamp: number | null | undefined): number | null {
  if (!timestamp) return null;
  // If timestamp is less than 10^12, it's in seconds
  if (timestamp < 1e12) {
    return timestamp * 1000;
  }
  return timestamp;
}

/**
 * Convert timestamp to seconds (for OIDC spec compliance)
 */
function toSeconds(timestamp: number | null | undefined): number | null {
  if (!timestamp) return null;
  // If timestamp is greater than or equal to 10^12, it's in milliseconds
  if (timestamp >= 1e12) {
    return Math.floor(timestamp / 1000);
  }
  return timestamp;
}

/**
 * Serve avatar image from R2
 * GET /avatars/:filename
 */
export async function serveAvatarHandler(c: Context<{ Bindings: Env }>) {
  try {
    const filename = c.req.param('filename');
    const filePath = `avatars/${filename}`;

    // Get file from R2
    const object = await c.env.AVATARS.get(filePath);

    if (!object) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Avatar not found',
        },
        404
      );
    }

    // Return the image with proper headers
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');

    return new Response(object.body, {
      headers,
    });
  } catch (error) {
    console.error('Serve avatar error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to serve avatar',
      },
      500
    );
  }
}

/**
 * Get admin statistics
 * GET /admin/stats
 *
 * PII Separation: COUNT queries use users_core (Core DB).
 * Recent users require both Core DB and PII DB queries, merged in application layer.
 */
export async function adminStatsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const todayStart = new Date().setHours(0, 0, 0, 0);

    // Run all COUNT queries in parallel for better performance
    // COUNT queries use users_core (Core DB) - no PII needed for counts
    const [
      activeUsersResult,
      totalUsersResult,
      totalClientsResult,
      newUsersTodayResult,
      loginsTodayResult,
      recentUsersCoreResult,
    ] = await Promise.all([
      // Count active users (logged in within last 30 days) - Core DB
      c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND last_login_at > ? AND is_active = 1'
      )
        .bind(tenantId, thirtyDaysAgo)
        .first(),

      // Count total users for this tenant - Core DB
      c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND is_active = 1'
      )
        .bind(tenantId)
        .first(),

      // Count registered clients for this tenant - Core DB
      c.env.DB.prepare('SELECT COUNT(*) as count FROM oauth_clients WHERE tenant_id = ?')
        .bind(tenantId)
        .first(),

      // Count users created today - Core DB
      c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND created_at >= ? AND is_active = 1'
      )
        .bind(tenantId, todayStart)
        .first(),

      // Count logins today - Core DB
      c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND last_login_at >= ? AND is_active = 1'
      )
        .bind(tenantId, todayStart)
        .first(),

      // Get recent activity (last 10 user registrations) - Core DB (IDs and timestamps only)
      c.env.DB.prepare(
        'SELECT id, created_at FROM users_core WHERE tenant_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 10'
      )
        .bind(tenantId)
        .all(),
    ]);

    // Fetch PII (email, name) for recent users from PII DB
    let recentActivity: {
      type: string;
      userId: string;
      email: string | null;
      name: string | null;
      timestamp: number;
    }[] = [];

    if (c.env.DB_PII && recentUsersCoreResult.results.length > 0) {
      const userIds = recentUsersCoreResult.results.map((u: any) => u.id);
      // Query PII DB for email and name
      const placeholders = userIds.map(() => '?').join(',');
      const piiResults = await c.env.DB_PII.prepare(
        `SELECT id, email, name FROM users_pii WHERE id IN (${placeholders})`
      )
        .bind(...userIds)
        .all();

      // Create a map for quick lookup
      const piiMap = new Map<string, { email: string | null; name: string | null }>();
      for (const pii of piiResults.results as any[]) {
        piiMap.set(pii.id, { email: pii.email, name: pii.name });
      }

      // Merge Core and PII data
      recentActivity = recentUsersCoreResult.results.map((user: any) => {
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
      // No PII DB configured - return without email/name
      recentActivity = recentUsersCoreResult.results.map((user: any) => ({
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
      },
      recentActivity,
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve statistics',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}

/**
 * Get paginated list of users
 * GET /admin/users
 *
 * PII Separation: Search (email/name) queries PII DB, filters (email_verified) query Core DB.
 * Results are merged in application layer.
 */
export async function adminUsersListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const page = parseInt(c.req.query('page') || '1');
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')));
    const search = c.req.query('search') || '';
    const verified = c.req.query('verified'); // 'true', 'false', or undefined

    const offset = (page - 1) * limit;

    // Strategy:
    // 1. If search is provided, query PII DB first to get matching user IDs
    // 2. Query Core DB with optional ID filter, verified filter, and pagination
    // 3. Fetch PII for result set and merge

    let matchingUserIds: string[] | null = null;

    // Step 1: If search is provided, find matching users in PII DB
    if (search && c.env.DB_PII) {
      const piiSearchResult = await c.env.DB_PII.prepare(
        'SELECT id FROM users_pii WHERE tenant_id = ? AND (email LIKE ? OR name LIKE ?)'
      )
        .bind(tenantId, `%${search}%`, `%${search}%`)
        .all();
      matchingUserIds = piiSearchResult.results.map((r: any) => r.id);

      // If no PII matches, return empty result
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

    // Step 2: Build Core DB query
    let coreQuery = 'SELECT * FROM users_core WHERE tenant_id = ? AND is_active = 1';
    let countQuery =
      'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND is_active = 1';
    const coreBindings: any[] = [tenantId];
    const countBindings: any[] = [tenantId];

    // Add ID filter if search was performed
    if (matchingUserIds !== null) {
      const placeholders = matchingUserIds.map(() => '?').join(',');
      coreQuery += ` AND id IN (${placeholders})`;
      countQuery += ` AND id IN (${placeholders})`;
      coreBindings.push(...matchingUserIds);
      countBindings.push(...matchingUserIds);
    }

    // Verified filter (Core DB field)
    if (verified !== undefined) {
      coreQuery += ' AND email_verified = ?';
      countQuery += ' AND email_verified = ?';
      const verifiedValue = verified === 'true' ? 1 : 0;
      coreBindings.push(verifiedValue);
      countBindings.push(verifiedValue);
    }

    // Order and pagination
    coreQuery += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    coreBindings.push(limit, offset);

    // Execute Core DB queries in parallel
    const [totalResult, coreUsers] = await Promise.all([
      c.env.DB.prepare(countQuery)
        .bind(...countBindings)
        .first(),
      c.env.DB.prepare(coreQuery)
        .bind(...coreBindings)
        .all(),
    ]);

    const total = (totalResult?.count as number) || 0;
    const totalPages = Math.ceil(total / limit);

    // Step 3: Fetch PII for the result set
    let formattedUsers: any[] = [];

    if (coreUsers.results.length > 0 && c.env.DB_PII) {
      const userIds = coreUsers.results.map((u: any) => u.id);
      const placeholders = userIds.map(() => '?').join(',');
      const piiResults = await c.env.DB_PII.prepare(
        `SELECT * FROM users_pii WHERE id IN (${placeholders})`
      )
        .bind(...userIds)
        .all();

      // Create PII lookup map
      const piiMap = new Map<string, any>();
      for (const pii of piiResults.results as any[]) {
        piiMap.set(pii.id, pii);
      }

      // Merge Core and PII data
      formattedUsers = coreUsers.results.map((core: any) => {
        const pii = piiMap.get(core.id) || {};
        return {
          id: core.id,
          tenant_id: core.tenant_id,
          email: pii.email ?? null,
          name: pii.name ?? null,
          given_name: pii.given_name ?? null,
          family_name: pii.family_name ?? null,
          nickname: pii.nickname ?? null,
          preferred_username: pii.preferred_username ?? null,
          picture: pii.picture ?? null,
          phone_number: pii.phone_number ?? null,
          email_verified: Boolean(core.email_verified),
          phone_number_verified: Boolean(core.phone_number_verified),
          user_type: core.user_type,
          is_active: Boolean(core.is_active),
          pii_partition: core.pii_partition,
          pii_status: core.pii_status,
          created_at: toMilliseconds(core.created_at),
          updated_at: toMilliseconds(core.updated_at),
          last_login_at: toMilliseconds(core.last_login_at),
        };
      });
    } else if (coreUsers.results.length > 0) {
      // No PII DB - return Core data only
      formattedUsers = coreUsers.results.map((core: any) => ({
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
    console.error('Admin users list error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve users',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}

/**
 * Get user details by ID
 * GET /admin/users/:id
 *
 * PII Separation: Queries both Core DB (users_core) and PII DB (users_pii), then merges.
 */
export async function adminUserGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');

    // Query Core DB for user_core data
    const userCore = await c.env.DB.prepare(
      'SELECT * FROM users_core WHERE id = ? AND is_active = 1'
    )
      .bind(userId)
      .first();

    if (!userCore) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // Query PII DB for user_pii data (if available)
    let userPII: any = null;
    if (c.env.DB_PII) {
      userPII = await c.env.DB_PII.prepare('SELECT * FROM users_pii WHERE id = ?')
        .bind(userId)
        .first();
    }

    // Get user's passkeys from Core DB
    const passkeys = await c.env.DB.prepare(
      'SELECT id, credential_id, device_name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at DESC'
    )
      .bind(userId)
      .all();

    // Get user's custom fields from Core DB
    const customFields = await c.env.DB.prepare(
      'SELECT field_name, field_value, field_type FROM user_custom_fields WHERE user_id = ?'
    )
      .bind(userId)
      .all();

    // Merge Core and PII data
    const formattedUser = {
      id: userCore.id,
      tenant_id: userCore.tenant_id,
      // PII fields
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
      // Core fields
      email_verified: Boolean(userCore.email_verified),
      phone_number_verified: Boolean(userCore.phone_number_verified),
      user_type: userCore.user_type,
      is_active: Boolean(userCore.is_active),
      pii_partition: userCore.pii_partition,
      pii_status: userCore.pii_status,
      created_at: toMilliseconds(userCore.created_at as number),
      updated_at: toMilliseconds(userCore.updated_at as number),
      last_login_at: toMilliseconds(userCore.last_login_at as number | null),
    };

    // Format passkeys with millisecond timestamps
    const formattedPasskeys = passkeys.results.map((p: any) => ({
      ...p,
      created_at: toMilliseconds(p.created_at),
      last_used_at: toMilliseconds(p.last_used_at),
    }));

    return c.json({
      user: formattedUser,
      passkeys: formattedPasskeys,
      customFields: customFields.results,
    });
  } catch (error) {
    console.error('Admin user get error:', error);
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
 * Create a new user
 * POST /admin/users
 *
 * PII Separation: Creates user in both Core DB (users_core) and PII DB (users_pii).
 * Uses pii_status to track distributed write state:
 * 1. Insert into users_core with pii_status='pending'
 * 2. Insert into users_pii
 * 3. Update users_core.pii_status to 'active'
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
      [key: string]: any;
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
      ...otherFields
    } = body;

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

    // Check if user already exists - query PII DB for email uniqueness
    if (c.env.DB_PII) {
      const existingUser = await c.env.DB_PII.prepare(
        'SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?'
      )
        .bind(tenantId, email)
        .first();

      if (existingUser) {
        return c.json(
          {
            error: 'conflict',
            error_description: 'User with this email already exists',
          },
          409
        );
      }
    }

    const userId = generateId();
    const now = Date.now();

    // Step 1: Insert into users_core (Core DB) with pii_status='pending'
    await c.env.DB.prepare(
      `INSERT INTO users_core (
        id, tenant_id, email_verified, phone_number_verified, password_hash,
        is_active, user_type, pii_partition, pii_status, created_at, updated_at, last_login_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        userId,
        tenantId,
        email_verified ? 1 : 0,
        phone_number_verified ? 1 : 0,
        null, // password_hash
        1, // is_active
        user_type || 'end_user',
        'default', // pii_partition
        'pending', // pii_status - will be updated after PII insert
        now,
        now,
        null // last_login_at
      )
      .run();

    // Step 2: Insert into users_pii (PII DB) if available
    if (c.env.DB_PII) {
      try {
        await c.env.DB_PII.prepare(
          `INSERT INTO users_pii (
            id, tenant_id, pii_class, email, email_blind_index, phone_number,
            name, given_name, family_name, nickname, preferred_username,
            picture, website, gender, birthdate, locale, zoneinfo,
            address_formatted, address_street_address, address_locality,
            address_region, address_postal_code, address_country,
            declared_residence, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            userId,
            tenantId,
            'PROFILE', // pii_class
            email,
            null, // email_blind_index (TODO: compute blind index)
            phone_number || null,
            name || null,
            given_name || null,
            family_name || null,
            nickname || null,
            preferred_username || null,
            picture || null,
            null, // website
            null, // gender
            null, // birthdate
            null, // locale
            null, // zoneinfo
            null, // address_formatted
            null, // address_street_address
            null, // address_locality
            null, // address_region
            null, // address_postal_code
            null, // address_country
            null, // declared_residence
            now,
            now
          )
          .run();

        // Step 3: Update pii_status to 'active' on success
        await c.env.DB.prepare('UPDATE users_core SET pii_status = ?, updated_at = ? WHERE id = ?')
          .bind('active', now, userId)
          .run();
      } catch (piiError) {
        // PII insert failed - mark as 'failed' for retry
        console.error('PII insert failed:', piiError);
        await c.env.DB.prepare('UPDATE users_core SET pii_status = ?, updated_at = ? WHERE id = ?')
          .bind('failed', now, userId)
          .run();
        throw piiError;
      }
    } else {
      // No PII DB - mark as 'none' (M2M user or single-DB mode)
      await c.env.DB.prepare('UPDATE users_core SET pii_status = ?, updated_at = ? WHERE id = ?')
        .bind('none', now, userId)
        .run();
    }

    // Fetch created user data (merged from both DBs)
    const userCore = await c.env.DB.prepare('SELECT * FROM users_core WHERE id = ?')
      .bind(userId)
      .first();

    let userPII: any = null;
    if (c.env.DB_PII) {
      userPII = await c.env.DB_PII.prepare('SELECT * FROM users_pii WHERE id = ?')
        .bind(userId)
        .first();
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
      email_verified: Boolean(userCore?.email_verified),
      phone_number_verified: Boolean(userCore?.phone_number_verified),
      user_type: userCore?.user_type,
      is_active: Boolean(userCore?.is_active),
      pii_partition: userCore?.pii_partition,
      pii_status: userCore?.pii_status,
      created_at: toMilliseconds(userCore?.created_at as number),
      updated_at: toMilliseconds(userCore?.updated_at as number),
    };

    return c.json(
      {
        user: createdUser,
      },
      201
    );
  } catch (error) {
    console.error('Admin user create error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create user',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}

/**
 * Update user
 * PUT /admin/users/:id
 *
 * PII Separation: Updates split between Core DB (users_core) and PII DB (users_pii).
 * Core fields: email_verified, phone_number_verified, user_type
 * PII fields: name, phone_number, picture, given_name, family_name, etc.
 */
export async function adminUserUpdateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');
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
      [key: string]: any;
    }>();

    // Check if user exists in Core DB
    const userCore = await c.env.DB.prepare(
      'SELECT * FROM users_core WHERE id = ? AND is_active = 1'
    )
      .bind(userId)
      .first();

    if (!userCore) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    const now = Date.now();

    // Separate Core and PII fields
    const coreUpdates: string[] = [];
    const coreBindings: any[] = [];
    const piiUpdates: string[] = [];
    const piiBindings: any[] = [];

    // Core fields
    if (body.email_verified !== undefined) {
      coreUpdates.push('email_verified = ?');
      coreBindings.push(body.email_verified ? 1 : 0);
    }
    if (body.phone_number_verified !== undefined) {
      coreUpdates.push('phone_number_verified = ?');
      coreBindings.push(body.phone_number_verified ? 1 : 0);
    }
    if (body.user_type !== undefined) {
      coreUpdates.push('user_type = ?');
      coreBindings.push(body.user_type);
    }

    // PII fields
    if (body.name !== undefined) {
      piiUpdates.push('name = ?');
      piiBindings.push(body.name);
    }
    if (body.given_name !== undefined) {
      piiUpdates.push('given_name = ?');
      piiBindings.push(body.given_name);
    }
    if (body.family_name !== undefined) {
      piiUpdates.push('family_name = ?');
      piiBindings.push(body.family_name);
    }
    if (body.nickname !== undefined) {
      piiUpdates.push('nickname = ?');
      piiBindings.push(body.nickname);
    }
    if (body.preferred_username !== undefined) {
      piiUpdates.push('preferred_username = ?');
      piiBindings.push(body.preferred_username);
    }
    if (body.phone_number !== undefined) {
      piiUpdates.push('phone_number = ?');
      piiBindings.push(body.phone_number);
    }
    if (body.picture !== undefined) {
      piiUpdates.push('picture = ?');
      piiBindings.push(body.picture);
    }

    // Check if there are any updates
    if (coreUpdates.length === 0 && piiUpdates.length === 0) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'No fields to update',
        },
        400
      );
    }

    // Update Core DB if there are core field updates
    if (coreUpdates.length > 0) {
      coreUpdates.push('updated_at = ?');
      coreBindings.push(now, userId);
      await c.env.DB.prepare(`UPDATE users_core SET ${coreUpdates.join(', ')} WHERE id = ?`)
        .bind(...coreBindings)
        .run();
    }

    // Update PII DB if there are PII field updates and DB_PII is available
    if (piiUpdates.length > 0 && c.env.DB_PII) {
      piiUpdates.push('updated_at = ?');
      piiBindings.push(now, userId);
      await c.env.DB_PII.prepare(`UPDATE users_pii SET ${piiUpdates.join(', ')} WHERE id = ?`)
        .bind(...piiBindings)
        .run();
    }

    // Invalidate user cache (cache invalidation hook)
    await invalidateUserCache(c.env, userId);

    // Fetch updated user data (merged from both DBs)
    const updatedCore = await c.env.DB.prepare('SELECT * FROM users_core WHERE id = ?')
      .bind(userId)
      .first();

    let updatedPII: any = null;
    if (c.env.DB_PII) {
      updatedPII = await c.env.DB_PII.prepare('SELECT * FROM users_pii WHERE id = ?')
        .bind(userId)
        .first();
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
      email_verified: Boolean(updatedCore?.email_verified),
      phone_number_verified: Boolean(updatedCore?.phone_number_verified),
      user_type: updatedCore?.user_type,
      is_active: Boolean(updatedCore?.is_active),
      pii_partition: updatedCore?.pii_partition,
      pii_status: updatedCore?.pii_status,
      created_at: toMilliseconds(updatedCore?.created_at as number),
      updated_at: toMilliseconds(updatedCore?.updated_at as number),
      last_login_at: toMilliseconds(updatedCore?.last_login_at as number | null),
    };

    return c.json({
      user: updatedUser,
    });
  } catch (error) {
    console.error('Admin user update error:', error);
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
 * Delete user
 * DELETE /admin/users/:id
 *
 * PII Separation: Soft delete in Core DB, hard delete in PII DB (GDPR requirement).
 * - Sets is_active=0 and pii_status='deleted' in users_core
 * - Deletes PII data from users_pii
 * - Creates tombstone record for audit trail
 */
export async function adminUserDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');
    const now = Date.now();
    const tenantId = getTenantIdFromContext(c);

    // Check if user exists in Core DB
    const userCore = await c.env.DB.prepare(
      'SELECT * FROM users_core WHERE id = ? AND is_active = 1'
    )
      .bind(userId)
      .first();

    if (!userCore) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // Get PII data for tombstone before deletion
    let emailBlindIndex: string | null = null;
    if (c.env.DB_PII) {
      const userPII = await c.env.DB_PII.prepare(
        'SELECT email_blind_index FROM users_pii WHERE id = ?'
      )
        .bind(userId)
        .first();
      emailBlindIndex = (userPII?.email_blind_index as string) ?? null;

      // Create tombstone record for GDPR audit trail
      const retentionDays = 90; // Default retention period
      const retentionUntil = now + retentionDays * 24 * 60 * 60 * 1000;

      await c.env.DB_PII.prepare(
        `INSERT INTO users_pii_tombstone (
          id, tenant_id, email_blind_index, deleted_at, deleted_by,
          deletion_reason, retention_until, deletion_metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          userId,
          tenantId,
          emailBlindIndex,
          now,
          'admin', // deleted_by
          'admin_action', // deletion_reason
          retentionUntil,
          JSON.stringify({ source: 'admin_api', timestamp: new Date(now).toISOString() })
        )
        .run();

      // Hard delete PII data (GDPR requirement)
      await c.env.DB_PII.prepare('DELETE FROM users_pii WHERE id = ?').bind(userId).run();
    }

    // Soft delete in Core DB
    await c.env.DB.prepare(
      'UPDATE users_core SET is_active = 0, pii_status = ?, updated_at = ? WHERE id = ?'
    )
      .bind('deleted', now, userId)
      .run();

    // Invalidate user cache
    await invalidateUserCache(c.env, userId);

    return c.json({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (error) {
    console.error('Admin user delete error:', error);
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
 * Create a new OAuth client
 * POST /admin/clients
 */
export async function adminClientCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      client_name: string;
      redirect_uris: string[];
      grant_types?: string[];
      response_types?: string[];
      scope?: string;
      logo_uri?: string;
      client_uri?: string;
      policy_uri?: string;
      tos_uri?: string;
      contacts?: string[];
      token_endpoint_auth_method?: string;
      subject_type?: string;
      sector_identifier_uri?: string;
      is_trusted?: boolean;
      skip_consent?: boolean;
      allow_claims_without_scope?: boolean;
    }>();

    // Validate required fields
    if (!body.client_name) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'client_name is required',
        },
        400
      );
    }

    if (
      !body.redirect_uris ||
      !Array.isArray(body.redirect_uris) ||
      body.redirect_uris.length === 0
    ) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'redirect_uris is required and must be a non-empty array',
        },
        400
      );
    }

    // Validate redirect_uris
    for (const uri of body.redirect_uris) {
      try {
        new URL(uri);
      } catch {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid redirect_uri: ${uri}`,
          },
          400
        );
      }
    }

    // Generate client_id and client_secret
    const clientId = crypto.randomUUID();
    const clientSecret =
      crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

    const now = Date.now();

    // Default values
    const grantTypes = body.grant_types || ['authorization_code'];
    const responseTypes = body.response_types || ['code'];
    const scope = body.scope || 'openid profile email';
    const tokenEndpointAuthMethod = body.token_endpoint_auth_method || 'client_secret_basic';
    const subjectType = body.subject_type || 'public';

    // Insert into database
    await c.env.DB.prepare(
      `INSERT INTO oauth_clients (
        client_id, client_secret, client_name, redirect_uris, grant_types,
        response_types, scope, logo_uri, client_uri, policy_uri, tos_uri,
        contacts, token_endpoint_auth_method, subject_type, sector_identifier_uri,
        is_trusted, skip_consent, allow_claims_without_scope, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        clientId,
        clientSecret,
        body.client_name,
        JSON.stringify(body.redirect_uris),
        JSON.stringify(grantTypes),
        JSON.stringify(responseTypes),
        scope,
        body.logo_uri || null,
        body.client_uri || null,
        body.policy_uri || null,
        body.tos_uri || null,
        body.contacts ? JSON.stringify(body.contacts) : null,
        tokenEndpointAuthMethod,
        subjectType,
        body.sector_identifier_uri || null,
        body.is_trusted ? 1 : 0,
        body.skip_consent ? 1 : 0,
        body.allow_claims_without_scope ? 1 : 0,
        now,
        now
      )
      .run();

    // Return the created client (including client_secret only on creation)
    return c.json(
      {
        client: {
          client_id: clientId,
          client_secret: clientSecret,
          client_name: body.client_name,
          redirect_uris: body.redirect_uris,
          grant_types: grantTypes,
          response_types: responseTypes,
          scope,
          logo_uri: body.logo_uri || null,
          client_uri: body.client_uri || null,
          policy_uri: body.policy_uri || null,
          tos_uri: body.tos_uri || null,
          contacts: body.contacts || [],
          token_endpoint_auth_method: tokenEndpointAuthMethod,
          subject_type: subjectType,
          sector_identifier_uri: body.sector_identifier_uri || null,
          is_trusted: body.is_trusted || false,
          skip_consent: body.skip_consent || false,
          allow_claims_without_scope: body.allow_claims_without_scope || false,
          created_at: now,
          updated_at: now,
        },
      },
      201
    );
  } catch (error) {
    console.error('Admin client create error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create client',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}

/**
 * Get paginated list of OAuth clients
 * GET /admin/clients
 */
export async function adminClientsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const search = c.req.query('search') || '';

    const offset = (page - 1) * limit;

    // Build query with tenant_id filter for index optimization
    let query = 'SELECT * FROM oauth_clients WHERE tenant_id = ?';
    let countQuery = 'SELECT COUNT(*) as count FROM oauth_clients WHERE tenant_id = ?';
    const bindings: any[] = [tenantId];
    const countBindings: any[] = [tenantId];

    // Search filter
    if (search) {
      query += ' AND (client_name LIKE ? OR client_id LIKE ?)';
      countQuery += ' AND (client_name LIKE ? OR client_id LIKE ?)';
      bindings.push(`%${search}%`, `%${search}%`);
      countBindings.push(`%${search}%`, `%${search}%`);
    }

    // Order and pagination
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    bindings.push(limit, offset);

    // Execute queries in parallel
    const [totalResult, clients] = await Promise.all([
      c.env.DB.prepare(countQuery)
        .bind(...countBindings)
        .first(),
      c.env.DB.prepare(query)
        .bind(...bindings)
        .all(),
    ]);

    const total = (totalResult?.count as number) || 0;
    const totalPages = Math.ceil(total / limit);

    // Format clients with millisecond timestamps and parse JSON fields
    const formattedClients = clients.results.map((client: any) => ({
      ...client,
      grant_types: client.grant_types ? JSON.parse(client.grant_types) : [],
      created_at: toMilliseconds(client.created_at),
      updated_at: toMilliseconds(client.updated_at),
    }));

    return c.json({
      clients: formattedClients,
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
    console.error('Admin clients list error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve clients',
      },
      500
    );
  }
}

/**
 * Get client details by ID
 * GET /admin/clients/:id
 */
export async function adminClientGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const clientId = c.req.param('id');

    const client = await c.env.DB.prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
      .bind(clientId)
      .first();

    if (!client) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Client not found',
        },
        404
      );
    }

    // Parse JSON fields and convert timestamps to milliseconds
    const formattedClient = {
      ...client,
      redirect_uris: client.redirect_uris ? JSON.parse(client.redirect_uris as string) : [],
      grant_types: client.grant_types ? JSON.parse(client.grant_types as string) : [],
      response_types: client.response_types ? JSON.parse(client.response_types as string) : [],
      contacts: client.contacts ? JSON.parse(client.contacts as string) : [],
      created_at: toMilliseconds(client.created_at as number),
      updated_at: toMilliseconds(client.updated_at as number),
    };

    return c.json({
      client: formattedClient,
    });
  } catch (error) {
    console.error('Admin client get error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve client',
      },
      500
    );
  }
}

/**
 * Update client settings
 * PUT /admin/clients/:id
 */
export async function adminClientUpdateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const clientId = c.req.param('id');

    // Check if client exists
    const existingClient = await c.env.DB.prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
      .bind(clientId)
      .first();

    if (!existingClient) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Client not found',
        },
        404
      );
    }

    // Parse request body
    const body = await c.req.json();

    // Extract updatable fields
    const {
      client_name,
      redirect_uris,
      grant_types,
      scope,
      logo_uri,
      client_uri,
      policy_uri,
      tos_uri,
      is_trusted,
      skip_consent,
      allow_claims_without_scope,
    } = body;

    // Build update query dynamically
    const updates: string[] = [];
    const values: unknown[] = [];

    if (client_name !== undefined) {
      updates.push('client_name = ?');
      values.push(client_name);
    }
    if (redirect_uris !== undefined) {
      updates.push('redirect_uris = ?');
      values.push(JSON.stringify(redirect_uris));
    }
    if (grant_types !== undefined) {
      updates.push('grant_types = ?');
      values.push(JSON.stringify(grant_types));
    }
    if (scope !== undefined) {
      updates.push('scope = ?');
      values.push(scope);
    }
    if (logo_uri !== undefined) {
      updates.push('logo_uri = ?');
      values.push(logo_uri);
    }
    if (client_uri !== undefined) {
      updates.push('client_uri = ?');
      values.push(client_uri);
    }
    if (policy_uri !== undefined) {
      updates.push('policy_uri = ?');
      values.push(policy_uri);
    }
    if (tos_uri !== undefined) {
      updates.push('tos_uri = ?');
      values.push(tos_uri);
    }
    if (is_trusted !== undefined) {
      updates.push('is_trusted = ?');
      values.push(is_trusted ? 1 : 0);
    }
    if (skip_consent !== undefined) {
      updates.push('skip_consent = ?');
      values.push(skip_consent ? 1 : 0);
    }
    if (allow_claims_without_scope !== undefined) {
      updates.push('allow_claims_without_scope = ?');
      values.push(allow_claims_without_scope ? 1 : 0);
    }

    // Always update updated_at timestamp (in milliseconds)
    updates.push('updated_at = ?');
    values.push(Date.now());

    if (updates.length === 1) {
      // Only updated_at, no actual changes
      return c.json({
        success: true,
        message: 'No changes to update',
      });
    }

    // Execute update query
    await c.env.DB.prepare(
      `
      UPDATE oauth_clients
      SET ${updates.join(', ')}
      WHERE client_id = ?
    `
    )
      .bind(...values, clientId)
      .run();

    // Update KV cache
    const updatedClient = await c.env.DB.prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
      .bind(clientId)
      .first();

    if (updatedClient) {
      // Parse JSON fields for KV storage
      const clientMetadata = {
        client_id: updatedClient.client_id,
        client_secret: updatedClient.client_secret,
        client_name: updatedClient.client_name,
        redirect_uris: JSON.parse(updatedClient.redirect_uris as string),
        grant_types: JSON.parse(updatedClient.grant_types as string),
        response_types: updatedClient.response_types
          ? JSON.parse(updatedClient.response_types as string)
          : ['code'],
        scope: updatedClient.scope,
        logo_uri: updatedClient.logo_uri,
        client_uri: updatedClient.client_uri,
        policy_uri: updatedClient.policy_uri,
        tos_uri: updatedClient.tos_uri,
        contacts: updatedClient.contacts ? JSON.parse(updatedClient.contacts as string) : undefined,
        subject_type: updatedClient.subject_type || 'public',
        sector_identifier_uri: updatedClient.sector_identifier_uri,
        token_endpoint_auth_method:
          updatedClient.token_endpoint_auth_method || 'client_secret_basic',
        created_at: updatedClient.created_at,
        updated_at: updatedClient.updated_at,
        is_trusted: updatedClient.is_trusted === 1,
        skip_consent: updatedClient.skip_consent === 1,
        allow_claims_without_scope: updatedClient.allow_claims_without_scope === 1,
      };

      // Invalidate CLIENTS_CACHE (explicit invalidation after D1 update)
      // D1 is source of truth - cache will be repopulated on next getClient() call
      try {
        await c.env.CLIENTS_CACHE.delete(clientId);
      } catch (error) {
        console.warn(`Failed to invalidate cache for ${clientId}:`, error);
        // Cache invalidation failure should not block the response
        // Worst case: stale cache for up to 5 minutes (TTL)
      }
    }

    return c.json({
      success: true,
      client: updatedClient,
    });
  } catch (error) {
    console.error('Admin client update error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update client',
      },
      500
    );
  }
}

/**
 * Delete client
 * DELETE /admin/clients/:id
 */
export async function adminClientDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const clientId = c.req.param('id');

    // Check if client exists
    const existingClient = await c.env.DB.prepare(
      'SELECT client_id FROM oauth_clients WHERE client_id = ?'
    )
      .bind(clientId)
      .first();

    if (!existingClient) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Client not found',
        },
        404
      );
    }

    // Delete from D1 database
    await c.env.DB.prepare('DELETE FROM oauth_clients WHERE client_id = ?').bind(clientId).run();

    // Invalidate CLIENTS_CACHE (explicit invalidation after D1 delete)
    try {
      await c.env.CLIENTS_CACHE.delete(clientId);
    } catch (error) {
      console.warn(`Failed to invalidate cache for ${clientId}:`, error);
      // Cache invalidation failure should not block the response
    }

    return c.json({
      success: true,
      message: 'Client deleted successfully',
    });
  } catch (error) {
    console.error('Admin client delete error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete client',
      },
      500
    );
  }
}

/**
 * Bulk delete clients
 * DELETE /admin/clients/bulk
 */
export async function adminClientsBulkDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{ client_ids: string[] }>();
    const { client_ids } = body;

    if (!client_ids || !Array.isArray(client_ids) || client_ids.length === 0) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'client_ids array is required',
        },
        400
      );
    }

    // Limit bulk delete to 100 items at a time
    if (client_ids.length > 100) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Cannot delete more than 100 clients at once',
        },
        400
      );
    }

    let deletedCount = 0;
    const errors: string[] = [];

    for (const clientId of client_ids) {
      try {
        // Delete from D1 database
        const result = await c.env.DB.prepare('DELETE FROM oauth_clients WHERE client_id = ?')
          .bind(clientId)
          .run();

        if (result.meta?.changes && result.meta.changes > 0) {
          // Invalidate CLIENTS_CACHE (explicit invalidation after D1 delete)
          try {
            await c.env.CLIENTS_CACHE.delete(clientId);
          } catch (error) {
            console.warn(`Failed to invalidate cache for ${clientId}:`, error);
            // Cache invalidation failure should not block the bulk delete
          }
          deletedCount++;
        }
      } catch (err) {
        errors.push(
          `Failed to delete ${clientId}: ${err instanceof Error ? err.message : 'Unknown error'}`
        );
      }
    }

    return c.json({
      success: true,
      deleted: deletedCount,
      requested: client_ids.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Admin clients bulk delete error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete clients',
      },
      500
    );
  }
}

/**
 * Upload user avatar
 * POST /admin/users/:id/avatar
 *
 * PII Separation: picture field is stored in PII DB (users_pii).
 */
export async function adminUserAvatarUploadHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');

    // Check if user exists in Core DB
    const userCore = await c.env.DB.prepare(
      'SELECT id FROM users_core WHERE id = ? AND is_active = 1'
    )
      .bind(userId)
      .first();

    if (!userCore) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // Parse multipart form data
    const body = await c.req.parseBody();
    const file = body['avatar'];

    if (!file || !(file instanceof File)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Avatar file is required',
        },
        400
      );
    }

    // Validate file type
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimeTypes.includes(file.type)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid file type. Allowed types: JPEG, PNG, GIF, WebP',
        },
        400
      );
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'File size exceeds 5MB limit',
        },
        400
      );
    }

    // Generate file name and path
    const fileExtension = file.name.split('.').pop() || 'jpg';
    const fileName = `${userId}.${fileExtension}`;
    const filePath = `avatars/${fileName}`;

    // Upload to R2
    const arrayBuffer = await file.arrayBuffer();
    await c.env.AVATARS.put(filePath, arrayBuffer, {
      httpMetadata: {
        contentType: file.type,
      },
    });

    // Construct avatar URL (will use Cloudflare Image Resizing)
    const avatarUrl = `${c.env.ISSUER_URL}/${filePath}`;

    // Update user's picture field in PII DB
    const now = Date.now();
    if (c.env.DB_PII) {
      await c.env.DB_PII.prepare('UPDATE users_pii SET picture = ?, updated_at = ? WHERE id = ?')
        .bind(avatarUrl, now, userId)
        .run();
    }

    // Invalidate user cache (cache invalidation hook)
    await invalidateUserCache(c.env, userId);

    return c.json({
      success: true,
      avatarUrl,
      message: 'Avatar uploaded successfully',
    });
  } catch (error) {
    console.error('Admin avatar upload error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to upload avatar',
      },
      500
    );
  }
}

/**
 * Delete user avatar
 * DELETE /admin/users/:id/avatar
 *
 * PII Separation: picture field is stored in PII DB (users_pii).
 */
export async function adminUserAvatarDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');

    // Check if user exists in Core DB
    const userCore = await c.env.DB.prepare(
      'SELECT id FROM users_core WHERE id = ? AND is_active = 1'
    )
      .bind(userId)
      .first();

    if (!userCore) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // Get picture URL from PII DB
    let pictureUrl: string | null = null;
    if (c.env.DB_PII) {
      const userPII = await c.env.DB_PII.prepare('SELECT picture FROM users_pii WHERE id = ?')
        .bind(userId)
        .first();
      pictureUrl = (userPII?.picture as string) ?? null;
    }

    // Check if user has an avatar
    if (!pictureUrl) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User does not have an avatar',
        },
        404
      );
    }

    // Extract file path from URL
    const urlParts = pictureUrl.split('/');
    const filePath = urlParts.slice(-2).join('/'); // Get "avatars/filename.ext"

    // Delete from R2
    try {
      await c.env.AVATARS.delete(filePath);
    } catch (error) {
      console.error('R2 delete error:', error);
      // Continue even if R2 delete fails
    }

    // Update user's picture field to null in PII DB
    const now = Date.now();
    if (c.env.DB_PII) {
      await c.env.DB_PII.prepare('UPDATE users_pii SET picture = NULL, updated_at = ? WHERE id = ?')
        .bind(now, userId)
        .run();
    }

    // Invalidate user cache (cache invalidation hook)
    await invalidateUserCache(c.env, userId);

    return c.json({
      success: true,
      message: 'Avatar deleted successfully',
    });
  } catch (error) {
    console.error('Admin avatar delete error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete avatar',
      },
      500
    );
  }
}

/**
 * List sessions with filtering
 * GET /admin/sessions
 *
 * PII Separation: Sessions are in Core DB. User email/name must be fetched from PII DB separately.
 * Cannot use JOIN across databases.
 */
export async function adminSessionsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const userId = c.req.query('user_id') || c.req.query('userId');
    const status = c.req.query('status'); // 'active' or 'expired'
    const active = c.req.query('active'); // 'true' or 'false' (alternative to status)

    const offset = (page - 1) * limit;
    const now = Math.floor(Date.now() / 1000);

    // Build query - sessions are in Core DB (no JOIN with users needed at query time)
    let query = 'SELECT * FROM sessions WHERE tenant_id = ?';
    let countQuery = 'SELECT COUNT(*) as count FROM sessions WHERE tenant_id = ?';
    const bindings: any[] = [tenantId];
    const countBindings: any[] = [tenantId];

    // User filter
    if (userId) {
      query += ' AND user_id = ?';
      countQuery += ' AND user_id = ?';
      bindings.push(userId);
      countBindings.push(userId);
    }

    // Status filter (support both 'status' and 'active' params)
    if (status === 'active' || active === 'true') {
      query += ' AND expires_at > ?';
      countQuery += ' AND expires_at > ?';
      bindings.push(now);
      countBindings.push(now);
    } else if (status === 'expired' || active === 'false') {
      query += ' AND expires_at <= ?';
      countQuery += ' AND expires_at <= ?';
      bindings.push(now);
      countBindings.push(now);
    }

    // Order and pagination
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    bindings.push(limit, offset);

    // Execute session queries in parallel
    const [totalResult, sessions] = await Promise.all([
      c.env.DB.prepare(countQuery)
        .bind(...countBindings)
        .first(),
      c.env.DB.prepare(query)
        .bind(...bindings)
        .all(),
    ]);

    const total = (totalResult?.count as number) || 0;
    const totalPages = Math.ceil(total / limit);

    // Fetch PII for users (email, name) from PII DB
    const userPIIMap = new Map<string, { email: string | null; name: string | null }>();
    if (c.env.DB_PII && sessions.results.length > 0) {
      const userIds = [...new Set(sessions.results.map((s: any) => s.user_id).filter(Boolean))];
      if (userIds.length > 0) {
        const placeholders = userIds.map(() => '?').join(',');
        const piiResults = await c.env.DB_PII.prepare(
          `SELECT id, email, name FROM users_pii WHERE id IN (${placeholders})`
        )
          .bind(...userIds)
          .all();

        for (const pii of piiResults.results as any[]) {
          userPIIMap.set(pii.id, { email: pii.email, name: pii.name });
        }
      }
    }

    // Format sessions with metadata (snake_case for UI compatibility)
    const formattedSessions = sessions.results.map((session: any) => {
      const userPII = userPIIMap.get(session.user_id);
      return {
        id: session.id,
        user_id: session.user_id,
        user_email: userPII?.email ?? null,
        user_name: userPII?.name ?? null,
        created_at: new Date(session.created_at * 1000).toISOString(),
        last_accessed_at: session.last_accessed_at
          ? new Date(session.last_accessed_at * 1000).toISOString()
          : new Date(session.created_at * 1000).toISOString(),
        expires_at: new Date(session.expires_at * 1000).toISOString(),
        ip_address: session.ip_address || null,
        user_agent: session.user_agent || null,
        is_active: session.expires_at > now,
      };
    });

    return c.json({
      sessions: formattedSessions,
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
    console.error('Admin sessions list error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve sessions',
      },
      500
    );
  }
}

/**
 * Get session details by ID
 * GET /admin/sessions/:id
 */
export async function adminSessionGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const sessionId = c.req.param('id');

    // Try to get from SessionStore first (hot data) - sharded
    let sessionData: Session | null = null;
    let isActive = false;
    let sessionStoreOk = false;

    if (isShardedSessionId(sessionId)) {
      try {
        const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
        sessionData = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

        if (sessionData) {
          isActive = sessionData.expiresAt > Date.now();
          sessionStoreOk = true;
        }
      } catch (error) {
        console.warn('Failed to get session from SessionStore:', error);
      }
    }

    // Get from D1 for additional metadata (PII/Non-PII DB分離対応)
    const session = await c.env.DB.prepare('SELECT * FROM sessions WHERE id = ?')
      .bind(sessionId)
      .first();

    if (!session && !sessionData) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Session not found',
        },
        404
      );
    }

    // Fetch user PII separately from PII DB
    let userEmail: string | null = null;
    let userName: string | null = null;
    const userId = sessionData?.userId || session?.user_id;
    if (userId && c.env.DB_PII) {
      const userPII = await c.env.DB_PII.prepare('SELECT email, name FROM users_pii WHERE id = ?')
        .bind(userId)
        .first();
      userEmail = (userPII?.email as string) || null;
      userName = (userPII?.name as string) || null;
    }

    // Merge data from both sources
    const result = {
      id: sessionId,
      userId,
      userEmail,
      userName,
      expiresAt: sessionData?.expiresAt || (session?.expires_at as number) * 1000,
      createdAt: sessionData?.createdAt || (session?.created_at as number) * 1000,
      isActive: isActive || (session?.expires_at as number) > Math.floor(Date.now() / 1000),
      source: sessionStoreOk ? 'memory' : 'database',
    };

    return c.json({
      session: result,
    });
  } catch (error) {
    console.error('Admin session get error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve session',
      },
      500
    );
  }
}

/**
 * Force logout individual session
 * POST /admin/sessions/:id/revoke
 */
export async function adminSessionRevokeHandler(c: Context<{ Bindings: Env }>) {
  try {
    const sessionId = c.req.param('id');

    // Check if session exists in D1
    const session = await c.env.DB.prepare('SELECT id, user_id FROM sessions WHERE id = ?')
      .bind(sessionId)
      .first();

    if (!session) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Session not found',
        },
        404
      );
    }

    // Invalidate session in SessionStore DO (sharded) via RPC
    if (isShardedSessionId(sessionId)) {
      try {
        const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
        const deleted = await sessionStore.invalidateSessionRpc(sessionId);

        if (!deleted) {
          console.warn(`Failed to delete session ${sessionId} from SessionStore`);
        }
      } catch (error) {
        console.warn(`Failed to route to session store for session ${sessionId}:`, error);
      }
    } else {
      console.warn(`Session ${sessionId} is not in sharded format, skipping DO deletion`);
    }

    // Delete from D1
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();

    // TODO: Create Audit Log entry (Phase 6)
    console.log(`Admin revoked session: ${sessionId} for user ${session.user_id}`);

    return c.json({
      success: true,
      message: 'Session revoked successfully',
      sessionId: sessionId,
    });
  } catch (error) {
    console.error('Admin session revoke error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to revoke session',
      },
      500
    );
  }
}

/**
 * Revoke all sessions for a user
 * POST /admin/users/:id/revoke-all-sessions
 *
 * Note: With sharded SessionStore, we can only delete sessions from D1.
 * Sessions in SessionStore will expire naturally. For immediate invalidation,
 * consider implementing a userId -> sessionIds index in a future phase.
 */
export async function adminUserRevokeAllSessionsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');

    // Check if user exists in Core DB
    const userCore = await c.env.DB.prepare(
      'SELECT id FROM users_core WHERE id = ? AND is_active = 1'
    )
      .bind(userId)
      .first();

    if (!userCore) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // With sharded SessionStore, we cannot efficiently query sessions by userId
    // Sessions are sharded by sessionId, not userId
    // We can only delete from D1 and let DO sessions expire naturally
    console.warn(
      `[ADMIN] Revoking all sessions for user ${userId}: ` +
        'Cannot delete from sharded SessionStore (sessions will expire naturally). ' +
        'Deleting from D1 only.'
    );

    // Delete all sessions from D1
    const deleteResult = await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?')
      .bind(userId)
      .run();

    const dbRevokedCount = deleteResult.meta.changes || 0;

    // TODO: Create Audit Log entry (Phase 6)
    console.log(
      `Admin revoked all sessions for user: ${userId} (${dbRevokedCount} sessions from D1)`
    );

    return c.json({
      success: true,
      message:
        'All user sessions revoked from D1. Active sessions in memory will expire naturally.',
      userId: userId,
      revokedCount: dbRevokedCount,
      note: 'Sessions in sharded SessionStore cannot be bulk-deleted by userId',
    });
  } catch (error) {
    console.error('Admin revoke all sessions error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to revoke user sessions',
      },
      500
    );
  }
}

/**
 * GET /api/admin/audit-log
 * List audit log entries with filtering and pagination
 */
export async function adminAuditLogListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env as Env;
    const tenantId = getTenantIdFromContext(c);

    // Get query parameters
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
    const offset = (page - 1) * limit;

    // Filters
    const userId = c.req.query('user_id');
    const action = c.req.query('action');
    const resourceType = c.req.query('resource_type');
    const resourceId = c.req.query('resource_id');
    const startDate = c.req.query('start_date'); // ISO 8601 format
    const endDate = c.req.query('end_date'); // ISO 8601 format

    // Build WHERE clause - tenant_id is always first for index usage
    const conditions: string[] = ['tenant_id = ?'];
    const params: any[] = [tenantId];

    if (userId) {
      conditions.push('user_id = ?');
      params.push(userId);
    }

    if (action) {
      conditions.push('action = ?');
      params.push(action);
    }

    if (resourceType) {
      conditions.push('resource_type = ?');
      params.push(resourceType);
    }

    if (resourceId) {
      conditions.push('resource_id = ?');
      params.push(resourceId);
    }

    if (startDate) {
      const startTimestamp = Math.floor(new Date(startDate).getTime() / 1000);
      conditions.push('created_at >= ?');
      params.push(startTimestamp);
    }

    if (endDate) {
      const endTimestamp = Math.floor(new Date(endDate).getTime() / 1000);
      conditions.push('created_at <= ?');
      params.push(endTimestamp);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM audit_log ${whereClause}`;
    const countResult = await env.DB.prepare(countQuery)
      .bind(...params)
      .first<{ total: number }>();

    const total = countResult?.total || 0;
    const totalPages = Math.ceil(total / limit);

    // Get audit log entries
    const query = `
      SELECT
        id,
        user_id,
        action,
        resource_type,
        resource_id,
        ip_address,
        user_agent,
        metadata_json,
        created_at
      FROM audit_log
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const result = await env.DB.prepare(query)
      .bind(...params, limit, offset)
      .all();

    // Format entries
    const entries = (result.results || []).map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      createdAt: new Date(row.created_at * 1000).toISOString(),
    }));

    return c.json({
      entries,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error('Admin audit log list error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to fetch audit log',
      },
      500
    );
  }
}

/**
 * GET /api/admin/audit-log/:id
 * Get a specific audit log entry by ID
 */
export async function adminAuditLogGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env as Env;
    const id = c.req.param('id');

    if (!id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Audit log entry ID is required',
        },
        400
      );
    }

    // Get audit log entry
    const entry = await env.DB.prepare(
      `
      SELECT
        id,
        user_id,
        action,
        resource_type,
        resource_id,
        ip_address,
        user_agent,
        metadata_json,
        created_at
      FROM audit_log
      WHERE id = ?
      `
    )
      .bind(id)
      .first();

    if (!entry) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Audit log entry not found',
        },
        404
      );
    }

    // Get user information if user_id exists (from both Core and PII DBs)
    let user = null;
    if (entry.user_id) {
      const userCore = await env.DB.prepare(
        'SELECT id FROM users_core WHERE id = ? AND is_active = 1'
      )
        .bind(entry.user_id)
        .first();

      if (userCore && env.DB_PII) {
        const userPII = await env.DB_PII.prepare(
          'SELECT email, name, picture FROM users_pii WHERE id = ?'
        )
          .bind(entry.user_id)
          .first();

        user = {
          id: userCore.id,
          email: userPII?.email ?? null,
          name: userPII?.name ?? null,
          picture: userPII?.picture ?? null,
        };
      } else if (userCore) {
        user = {
          id: userCore.id,
          email: null,
          name: null,
          picture: null,
        };
      }
    }

    return c.json({
      id: entry.id,
      userId: entry.user_id,
      user,
      action: entry.action,
      resourceType: entry.resource_type,
      resourceId: entry.resource_id,
      ipAddress: entry.ip_address,
      userAgent: entry.user_agent,
      metadata: entry.metadata_json ? JSON.parse(entry.metadata_json as string) : null,
      createdAt: new Date((entry.created_at as number) * 1000).toISOString(),
    });
  } catch (error) {
    console.error('Admin audit log get error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to fetch audit log entry',
      },
      500
    );
  }
}

/**
 * GET /api/admin/settings
 * Get system settings
 */
export async function adminSettingsGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env as Env;

    // Get settings from KV
    const settingsJson = await env.SETTINGS?.get('system_settings');

    // Default settings
    const defaultSettings = {
      general: {
        siteName: 'Authrim',
        logoUrl: '',
        language: 'en',
        timezone: 'UTC',
      },
      appearance: {
        primaryColor: '#3B82F6',
        secondaryColor: '#10B981',
        fontFamily: 'Inter',
      },
      security: {
        sessionTimeout: 86400, // 24 hours
        mfaEnforced: false,
        passwordMinLength: 8,
        passwordRequireSpecialChar: true,
      },
      email: {
        emailProvider: 'resend',
        smtpHost: '',
        smtpPort: 587,
        smtpUsername: '',
        smtpPassword: '',
      },
      advanced: {
        accessTokenTtl: 3600, // 1 hour
        idTokenTtl: 3600, // 1 hour
        refreshTokenTtl: 2592000, // 30 days
        passkeyEnabled: true,
        magicLinkEnabled: true,
      },
      ciba: {
        enabled: true,
        defaultExpiresIn: 300, // 5 minutes
        minExpiresIn: 60, // 1 minute
        maxExpiresIn: 600, // 10 minutes
        defaultInterval: 5, // 5 seconds
        minInterval: 2, // 2 seconds
        maxInterval: 60, // 60 seconds
        supportedDeliveryModes: ['poll', 'ping', 'push'],
        userCodeEnabled: true,
        bindingMessageMaxLength: 140,
        notificationsEnabled: false,
        notificationProviders: {
          email: false,
          sms: false,
          push: false,
        },
      },
      oidc: {
        // Discovery metadata configuration
        requirePar: false, // Require Pushed Authorization Requests
        claimsSupported: [
          'sub',
          'iss',
          'aud',
          'exp',
          'iat',
          'auth_time',
          'nonce',
          'acr',
          'amr',
          'azp',
          'at_hash',
          'c_hash',
          'name',
          'given_name',
          'family_name',
          'middle_name',
          'nickname',
          'preferred_username',
          'profile',
          'picture',
          'website',
          'email',
          'email_verified',
          'gender',
          'birthdate',
          'zoneinfo',
          'locale',
          'phone_number',
          'phone_number_verified',
          'address',
          'updated_at',
        ],
        responseTypesSupported: ['code'], // Authorization code flow only by default
        tokenEndpointAuthMethodsSupported: [
          'client_secret_basic',
          'client_secret_post',
          'client_secret_jwt',
          'private_key_jwt',
          'none',
        ],
      },
      fapi: {
        // FAPI 2.0 Security Profile configuration
        enabled: false, // FAPI 2.0 mode disabled by default
        requireDpop: false, // Require DPoP (or MTLS) for sender-constrained tokens
        allowPublicClients: true, // Allow public clients (disable for strict FAPI 2.0)
      },
      policy: {
        // Policy system feature flags
        enableAbac: false, // ABAC (Attribute-Based Access Control)
        enableRebac: false, // ReBAC (Relationship-Based Access Control)
        enablePolicyLogging: false, // Detailed policy evaluation logging
        enableVerifiedAttributes: false, // Verified attributes checking
        enableCustomRules: true, // Custom policy rules
        enableSdJwt: false, // SD-JWT (Selective Disclosure JWT)
        enablePolicyEmbedding: false, // Permission embedding in Access Token
        // Token claims configuration
        accessTokenClaims: 'roles,org_id,org_type', // Default claims for Access Token
        idTokenClaims: 'roles,user_type,org_id,plan,org_type', // Default claims for ID Token
      },
    };

    // Read policy feature flags from KV (dynamic overrides)
    const policyFlags = await readPolicyFlagsFromKV(env);
    const policyClaimsSettings = await readPolicyClaimsFromKV(env);

    // Merge with stored settings if they exist
    const settings = settingsJson
      ? { ...defaultSettings, ...JSON.parse(settingsJson) }
      : defaultSettings;

    // Apply policy feature flags from KV (priority: KV > stored settings > defaults)
    if (Object.keys(policyFlags).length > 0) {
      settings.policy = {
        ...settings.policy,
        ...policyFlags,
      };
    }

    // Apply policy claims settings from KV
    if (Object.keys(policyClaimsSettings).length > 0) {
      settings.policy = {
        ...settings.policy,
        ...policyClaimsSettings,
      };
    }

    return c.json({ settings });
  } catch (error) {
    console.error('Admin settings get error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to fetch settings',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings
 * Update system settings
 */
export async function adminSettingsUpdateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env as Env;
    const body = await c.req.json();

    if (!body.settings) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Settings object is required',
        },
        400
      );
    }

    // Validate settings structure
    const allowedSections = [
      'general',
      'appearance',
      'security',
      'email',
      'advanced',
      'ciba',
      'oidc',
      'fapi',
      'policy',
    ];
    const settings = body.settings;

    for (const section of Object.keys(settings)) {
      if (!allowedSections.includes(section)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid settings section: ${section}`,
          },
          400
        );
      }
    }

    // Store settings in KV
    if (env.SETTINGS) {
      await env.SETTINGS.put('system_settings', JSON.stringify(settings));

      // Sync policy feature flags to individual KV keys
      if (settings.policy) {
        await syncPolicyFlagsToKV(env, settings.policy);
      }
    } else {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Settings storage is not configured',
        },
        500
      );
    }

    return c.json({
      success: true,
      message: 'Settings updated successfully',
      settings,
    });
  } catch (error) {
    console.error('Admin settings update error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update settings',
      },
      500
    );
  }
}

/**
 * GET /api/admin/settings/profiles
 * List available certification profiles
 */
export async function adminListCertificationProfilesHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { listCertificationProfiles } = await import('./certification-profiles');
    const profiles = listCertificationProfiles();
    return c.json({ profiles });
  } catch (error) {
    console.error('Admin list profiles error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list certification profiles',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/profile/:profileName
 * Apply a certification profile
 */
export async function adminApplyCertificationProfileHandler(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env as Env;
    const profileName = c.req.param('profileName');

    if (!profileName) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Profile name is required',
        },
        400
      );
    }

    const { getCertificationProfile } = await import('./certification-profiles');
    const profile = getCertificationProfile(profileName);

    if (!profile) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Certification profile '${profileName}' not found`,
        },
        404
      );
    }

    // Get current settings
    const settingsJson = await env.SETTINGS?.get('system_settings');
    const currentSettings = settingsJson ? JSON.parse(settingsJson) : {};

    // Merge profile settings with current settings
    const updatedSettings = {
      ...currentSettings,
      ...profile.settings,
    };

    // Store updated settings
    if (env.SETTINGS) {
      await env.SETTINGS.put('system_settings', JSON.stringify(updatedSettings));
    } else {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Settings storage is not configured',
        },
        500
      );
    }

    return c.json({
      success: true,
      message: `Applied certification profile: ${profile.name}`,
      profile: {
        name: profile.name,
        description: profile.description,
      },
      settings: updatedSettings,
    });
  } catch (error) {
    console.error('Admin apply profile error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to apply certification profile',
      },
      500
    );
  }
}

/**
 * Get signing key with private key for local token generation
 * GET /api/admin/signing-key
 *
 * Returns the active signing key including the private key (PEM format).
 * This is intended for load testing scripts that need to generate tokens locally.
 *
 * WARNING: This endpoint exposes the private key. Only use in controlled environments.
 */
export async function adminSigningKeyGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Get the active key from KeyManager DO via RPC
    // Use 'default-v3' to match the existing KeyManager instance used throughout the system
    const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
    const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

    const keyData = await keyManager.getActiveKeyWithPrivateRpc();

    if (!keyData || !keyData.privatePEM) {
      console.error('Failed to get signing key: no key data');
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to get signing key',
        },
        500
      );
    }

    return c.json({
      kid: keyData.kid,
      privatePEM: keyData.privatePEM,
      publicJWK: keyData.publicJWK,
    });
  } catch (error) {
    console.error('Admin signing key get error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get signing key',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}

/**
 * Register a refresh token family for load testing (V2)
 * POST /api/admin/tokens/register
 *
 * Registers a pre-generated refresh token with the RefreshTokenRotator DO.
 * This allows load testing scripts to generate tokens locally and register
 * them with the token rotation system.
 *
 * V2: Uses version-based theft detection. The token's jti is stored,
 * and the initial version is returned for inclusion in the rtv claim.
 *
 * Request body:
 * {
 *   "token": "eyJ...", // JWT refresh token (must contain jti claim)
 *   "userId": "user-123",
 *   "clientId": "client-456",
 *   "scope": "openid profile email",
 *   "ttl": 2592000 // optional, seconds (default: 30 days)
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "version": 1,        // Initial version for rtv claim
 *   "jti": "...",        // JTI stored in DO
 *   "expiresIn": 2592000
 * }
 */
export async function adminTokenRegisterHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      token: string;
      userId: string;
      clientId: string;
      scope: string;
      ttl?: number;
    }>();

    const { token, userId, clientId, scope, ttl = 30 * 24 * 60 * 60 } = body;

    if (!token || !userId || !clientId || !scope) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'token, userId, clientId, and scope are required',
        },
        400
      );
    }

    // Extract jti from JWT token
    // JWT format: header.payload.signature
    // We need to decode the payload to get the jti
    let jti: string;
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Invalid JWT format',
          },
          400
        );
      }

      // Decode base64url payload
      const payloadBase64 = parts[1];
      const payloadJson = atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/'));
      const payload = JSON.parse(payloadJson) as { jti?: string };

      if (!payload.jti) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'JWT must contain a jti claim',
          },
          400
        );
      }

      jti = payload.jti;
    } catch (parseError) {
      console.error('Failed to parse JWT:', parseError);
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Failed to parse JWT token',
        },
        400
      );
    }

    // V3: Parse JTI to extract generation and shard info for proper routing
    const parsedJti = parseRefreshTokenJti(jti);
    const instanceName = buildRefreshTokenRotatorInstanceName(
      clientId,
      parsedJti.generation,
      parsedJti.shardIndex
    );

    // Get RefreshTokenRotator DO with proper sharding
    const rotatorId = c.env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
    const rotator = c.env.REFRESH_TOKEN_ROTATOR.get(rotatorId);

    // Create token family using V3 API (with generation and shard info)
    // V3 stores generation/shardIndex for proper JTI generation during rotation
    const response = await rotator.fetch(
      new Request('https://refresh-token-rotator/family', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jti, // Full JTI with v{gen}_{shard}_ prefix
          userId,
          clientId,
          scope,
          ttl,
          // V3: Include generation and shard for DO to store
          ...(parsedJti.generation > 0 &&
            parsedJti.shardIndex !== null && {
              generation: parsedJti.generation,
              shardIndex: parsedJti.shardIndex,
            }),
        }),
      })
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Failed to register token:', error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to register token',
        },
        500
      );
    }

    // V2 response format
    const result = (await response.json()) as {
      version: number;
      newJti: string;
      expiresIn: number;
      allowedScope: string;
    };

    return c.json(
      {
        success: true,
        version: result.version, // V2: Return version for rtv claim
        jti: result.newJti,
        expiresIn: result.expiresIn,
      },
      201
    );
  } catch (error) {
    console.error('Admin token register error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to register token',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}

/**
 * Create test session for load testing
 * POST /api/admin/test-sessions
 *
 * Creates a session for a specified user without requiring login.
 * This is intended for load testing and conformance testing only.
 */
export async function adminTestSessionCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      user_id: string;
      ttl_seconds?: number;
    }>();

    const { user_id, ttl_seconds = 3600 } = body;

    if (!user_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'user_id is required',
        },
        400
      );
    }

    // Verify user exists in Core DB
    const userCore = await c.env.DB.prepare(
      'SELECT id FROM users_core WHERE id = ? AND is_active = 1'
    )
      .bind(user_id)
      .first();

    if (!userCore) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // Get user PII for session metadata
    let userEmail: string | null = null;
    let userName: string | null = null;
    if (c.env.DB_PII) {
      const userPII = await c.env.DB_PII.prepare('SELECT email, name FROM users_pii WHERE id = ?')
        .bind(user_id)
        .first();
      userEmail = (userPII?.email as string) ?? null;
      userName = (userPII?.name as string) ?? null;
    }

    // Create session in SessionStore DO (sharded) via RPC
    const now = Date.now();
    const expiresAt = now + ttl_seconds * 1000;

    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(c.env);

    try {
      await sessionStore.createSessionRpc(sessionId, user_id, ttl_seconds, {
        amr: ['admin_api'],
        email: userEmail,
        name: userName,
      });
    } catch (error) {
      console.error('Failed to create session:', error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to create session',
        },
        500
      );
    }

    // D1 insert is handled by SessionStore.saveToD1() asynchronously
    // (removed duplicate blocking D1 INSERT for performance optimization)

    console.log(`[ADMIN] Created test session for user: ${user_id}, session: ${sessionId}`);

    return c.json(
      {
        session_id: sessionId,
        user_id: user_id,
        expires_at: expiresAt,
        cookie_value: `authrim_session=${sessionId}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${ttl_seconds}`,
      },
      201
    );
  } catch (error) {
    console.error('Admin test session create error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create test session',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}

// =============================================================================
// Test Email Code Handler - For Load Testing
// =============================================================================

const EMAIL_CODE_TTL = 5 * 60; // 5 minutes in seconds

/**
 * Generate a cryptographically secure 6-digit OTP code
 */
function generateEmailCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return (array[0] % 1000000).toString().padStart(6, '0');
}

/**
 * Hash an email code using HMAC-SHA256
 */
async function hashEmailCode(
  code: string,
  email: string,
  sessionId: string,
  issuedAt: number,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${code}:${email.toLowerCase()}:${sessionId}:${issuedAt}`);
  const keyData = encoder.encode(secret);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, data);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash an email address using SHA-256
 */
async function hashEmail(email: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(email.toLowerCase());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate test email code for load testing
 * POST /api/admin/test/email-codes
 *
 * Creates an OTP challenge without sending an email.
 * Returns the plaintext code for use in load testing.
 *
 * Request body:
 * {
 *   "email": "user@example.com"
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "code": "123456",
 *   "otpSessionId": "uuid-v4",
 *   "expiresAt": 1702345678
 * }
 */
export async function adminTestEmailCodeHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      email: string;
      create_user?: boolean;
    }>();

    const { email } = body;

    if (!email) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'email is required',
        },
        400
      );
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid email format',
        },
        400
      );
    }

    // Check if user exists by searching PII DB for email
    const tenantId = getTenantIdFromContext(c);
    let userId: string | null = null;
    let userEmail: string | null = null;
    let userName: string | null = null;

    if (c.env.DB_PII) {
      const userPII = await c.env.DB_PII.prepare(
        'SELECT id, email, name FROM users_pii WHERE tenant_id = ? AND email = ?'
      )
        .bind(tenantId, email.toLowerCase())
        .first();

      if (userPII) {
        userId = userPII.id as string;
        userEmail = userPII.email as string;
        userName = userPII.name as string | null;
      }
    }

    // create_user option: if false, don't create new user (for benchmarks with pre-seeded users)
    const createUser = body.create_user !== false;

    if (!userId) {
      if (!createUser) {
        return c.json(
          {
            error: 'user_not_found',
            error_description: 'User does not exist and create_user is false',
          },
          404
        );
      }

      userId = generateId();
      const now = Date.now();
      const preferredUsername = email.split('@')[0];

      // Insert into Core DB first with pii_status='pending'
      await c.env.DB.prepare(
        `INSERT INTO users_core (
          id, tenant_id, email_verified, phone_number_verified, password_hash,
          is_active, user_type, pii_partition, pii_status, created_at, updated_at, last_login_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          userId,
          tenantId,
          0, // email_verified
          0, // phone_number_verified
          null, // password_hash
          1, // is_active
          'end_user',
          'default', // pii_partition
          'pending', // pii_status
          now,
          now,
          null // last_login_at
        )
        .run();

      // Insert into PII DB if available
      if (c.env.DB_PII) {
        await c.env.DB_PII.prepare(
          `INSERT INTO users_pii (
            id, tenant_id, pii_class, email, email_blind_index, phone_number,
            name, given_name, family_name, nickname, preferred_username,
            picture, website, gender, birthdate, locale, zoneinfo,
            address_formatted, address_street_address, address_locality,
            address_region, address_postal_code, address_country,
            declared_residence, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            userId,
            tenantId,
            'PROFILE',
            email.toLowerCase(),
            null, // email_blind_index
            null, // phone_number
            null, // name
            null, // given_name
            null, // family_name
            null, // nickname
            preferredUsername,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            now,
            now
          )
          .run();

        // Update pii_status to 'active'
        await c.env.DB.prepare('UPDATE users_core SET pii_status = ?, updated_at = ? WHERE id = ?')
          .bind('active', now, userId)
          .run();
      } else {
        // No PII DB - mark as 'none'
        await c.env.DB.prepare('UPDATE users_core SET pii_status = ?, updated_at = ? WHERE id = ?')
          .bind('none', now, userId)
          .run();
      }

      userEmail = email.toLowerCase();
      userName = preferredUsername;
    }

    // Generate OTP session ID for session binding
    const otpSessionId = crypto.randomUUID();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + EMAIL_CODE_TTL * 1000;

    // Generate 6-digit OTP code
    const code = generateEmailCode();

    // Get HMAC secret from environment
    const hmacSecret = c.env.OTP_HMAC_SECRET || c.env.ISSUER_URL;

    // Parallelize independent operations: hash computations + DO stub retrieval
    const [codeHash, emailHash, challengeStore] = await Promise.all([
      hashEmailCode(code, email.toLowerCase(), otpSessionId, issuedAt, hmacSecret),
      hashEmail(email.toLowerCase()),
      getChallengeStoreByChallengeId(c.env, otpSessionId),
    ]);

    await challengeStore.storeChallengeRpc({
      id: `email_code:${otpSessionId}`,
      type: 'email_code',
      userId: userId as string,
      challenge: codeHash,
      ttl: EMAIL_CODE_TTL,
      email: email.toLowerCase(),
      metadata: {
        email_hash: emailHash,
        otp_session_id: otpSessionId,
        issued_at: issuedAt,
        purpose: 'login',
      },
    });

    console.log(`[ADMIN] Created test email code for user: ${userId}, session: ${otpSessionId}`);

    return c.json(
      {
        success: true,
        code,
        otpSessionId,
        expiresAt: Math.floor(expiresAt / 1000),
        userId: userId,
      },
      201
    );
  } catch (error) {
    console.error('Admin test email code error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create test email code',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}
