/**
 * Admin API Endpoints
 * User management, client management, and statistics for administrative dashboard
 */

import { Context } from 'hono';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  invalidateUserCache,
  invalidateConsentCache,
  revokeToken,
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
  D1Adapter,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  validateAllowedOrigins,
  escapeLikePattern,
  // Event System
  publishEvent,
  USER_EVENTS,
  CLIENT_EVENTS,
  CONSENT_EVENTS,
  type UserEventData,
  type ClientEventData,
  type ExtendedConsentEventData,
} from '@authrim/ar-lib-core';
import type { UserCore, UserPII } from '@authrim/ar-lib-core';

// =============================================================================
// Image Type Detection (Magic Bytes)
// =============================================================================

interface ImageTypeInfo {
  mimeType: string;
  extension: string;
}

/**
 * Detect image type from file content using Magic Bytes
 * Returns null if not a recognized image format
 */
function detectImageType(data: Uint8Array): ImageTypeInfo | null {
  if (data.length < 12) return null;

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return { mimeType: 'image/png', extension: 'png' };
  }

  // GIF: 47 49 46 38 (GIF87a or GIF89a)
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return { mimeType: 'image/gif', extension: 'gif' };
  }

  // WebP: 52 49 46 46 xx xx xx xx 57 45 42 50 (RIFF....WEBP)
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }

  return null;
}

// =============================================================================
// PII Protection: Error Handling Helpers
// =============================================================================

/**
 * Sanitize error for logging (PII Protection)
 * Logs only error type/code, not full message which may contain sensitive data
 */
function logSanitizedError(context: string, error: unknown): void {
  if (error instanceof Error) {
    console.error(`${context}:`, {
      type: error.name,
      // Only log message in development (ENVIRONMENT !== 'production')
      ...(process.env.NODE_ENV === 'development' && { message: error.message }),
    });
  } else {
    console.error(`${context}: Unknown error type`);
  }
}

/**
 * Get error details for response (PII Protection)
 * Only includes details in development environment to prevent information leakage
 */
function getErrorDetailsForResponse(error: unknown, env: Env): { details?: string } {
  // Only include error details in development/staging, not production
  const isDevelopment = env.ENVIRONMENT !== 'production' && env.NODE_ENV !== 'production';
  if (isDevelopment) {
    return {
      details: error instanceof Error ? error.message : String(error),
    };
  }
  return {};
}

// =============================================================================
// Policy Configuration
// =============================================================================

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
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
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
    logSanitizedError('Serve avatar error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Get admin statistics
 * GET /admin/stats
 *
 * PII Separation: COUNT queries use users_core (Core DB).
 * Recent users require both Core DB and PII DB queries, merged in application layer.
 *
 * Note: Uses DatabaseAdapter directly for aggregate queries (not Repository pattern)
 * because complex statistics don't fit the entity-centric Repository model.
 */
export async function adminStatsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const todayStart = new Date().setHours(0, 0, 0, 0);

    // Run all COUNT queries in parallel for better performance
    // Using coreAdapter directly for aggregate queries
    const [
      activeUsersResult,
      totalUsersResult,
      totalClientsResult,
      newUsersTodayResult,
      loginsTodayResult,
      recentUsersCoreResult,
    ] = await Promise.all([
      // Count active users (logged in within last 30 days) - Core DB
      authCtx.coreAdapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND last_login_at > ? AND is_active = 1',
        [tenantId, thirtyDaysAgo]
      ),

      // Count total users for this tenant - Core DB
      authCtx.coreAdapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND is_active = 1',
        [tenantId]
      ),

      // Count registered clients for this tenant - Core DB
      authCtx.coreAdapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM oauth_clients WHERE tenant_id = ?',
        [tenantId]
      ),

      // Count users created today - Core DB
      authCtx.coreAdapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND created_at >= ? AND is_active = 1',
        [tenantId, todayStart]
      ),

      // Count logins today - Core DB
      authCtx.coreAdapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND last_login_at >= ? AND is_active = 1',
        [tenantId, todayStart]
      ),

      // Get recent activity (last 10 user registrations) - Core DB (IDs and timestamps only)
      authCtx.coreAdapter.query<{ id: string; created_at: number }>(
        'SELECT id, created_at FROM users_core WHERE tenant_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 10',
        [tenantId]
      ),
    ]);

    // Fetch PII (email, name) for recent users from PII DB
    let recentActivity: {
      type: string;
      userId: string;
      email: string | null;
      name: string | null;
      timestamp: number;
    }[] = [];

    if (c.env.DB_PII && recentUsersCoreResult.length > 0) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const userIds = recentUsersCoreResult.map((u) => u.id);

      // Query PII DB for email and name via adapter
      const placeholders = userIds.map(() => '?').join(',');
      const piiResults = await piiCtx.defaultPiiAdapter.query<{
        id: string;
        email: string | null;
        name: string | null;
      }>(`SELECT id, email, name FROM users_pii WHERE id IN (${placeholders})`, userIds);

      // Create a map for quick lookup
      const piiMap = new Map<string, { email: string | null; name: string | null }>();
      for (const pii of piiResults) {
        piiMap.set(pii.id, { email: pii.email, name: pii.name });
      }

      // Merge Core and PII data
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
      // No PII DB configured - return without email/name
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
      },
      recentActivity,
    });
  } catch (error) {
    logSanitizedError('Admin stats error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Get paginated list of users
 * GET /admin/users
 *
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 20, max: 100)
 * - search: Search by email or name (PII DB)
 * - verified: Filter by email_verified (true/false)
 * - pii_status: Filter by PII status (none/pending/active/failed/deleted)
 *
 * PII Separation: Search (email/name) queries PII DB, filters (email_verified, pii_status) query Core DB.
 * Results are merged in application layer.
 *
 * Note: Uses DatabaseAdapter directly for complex cross-database queries.
 */
export async function adminUsersListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const page = parseInt(c.req.query('page') || '1');
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')));
    const search = c.req.query('search') || '';
    const verified = c.req.query('verified'); // 'true', 'false', or undefined
    const piiStatus = c.req.query('pii_status'); // 'none', 'pending', 'active', 'failed', 'deleted', or undefined

    const offset = (page - 1) * limit;

    // Strategy:
    // 1. If search is provided, query PII DB first to get matching user IDs
    // 2. Query Core DB with optional ID filter, verified filter, and pagination
    // 3. Fetch PII for result set and merge

    let matchingUserIds: string[] | null = null;

    // Step 1: If search is provided, find matching users in PII DB via adapter
    if (search && c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      // Escape special LIKE characters (%, _) to prevent unintended wildcards
      const escapedSearch = escapeLikePattern(search);
      const piiSearchResult = await piiCtx.defaultPiiAdapter.query<{ id: string }>(
        "SELECT id FROM users_pii WHERE tenant_id = ? AND (email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')",
        [tenantId, `%${escapedSearch}%`, `%${escapedSearch}%`]
      );
      matchingUserIds = piiSearchResult.map((r) => r.id);

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
    const coreBindings: unknown[] = [tenantId];
    const countBindings: unknown[] = [tenantId];

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

    // PII status filter (Core DB field)
    // Valid values: none, pending, active, failed, deleted
    if (piiStatus !== undefined) {
      const validStatuses = ['none', 'pending', 'active', 'failed', 'deleted'];
      if (validStatuses.includes(piiStatus)) {
        coreQuery += ' AND pii_status = ?';
        countQuery += ' AND pii_status = ?';
        coreBindings.push(piiStatus);
        countBindings.push(piiStatus);
      }
    }

    // Order and pagination
    coreQuery += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    coreBindings.push(limit, offset);

    // Execute Core DB queries in parallel via adapter
    const [totalResult, coreUsers] = await Promise.all([
      authCtx.coreAdapter.queryOne<{ count: number }>(countQuery, countBindings),
      authCtx.coreAdapter.query<UserCore>(coreQuery, coreBindings),
    ]);

    const total = totalResult?.count || 0;
    const totalPages = Math.ceil(total / limit);

    // Step 3: Fetch PII for the result set
    let formattedUsers: unknown[] = [];

    if (coreUsers.length > 0 && c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const userIds = coreUsers.map((u) => u.id);
      const placeholders = userIds.map(() => '?').join(',');
      const piiResults = await piiCtx.defaultPiiAdapter.query<UserPII>(
        `SELECT * FROM users_pii WHERE id IN (${placeholders})`,
        userIds
      );

      // Create PII lookup map
      const piiMap = new Map<string, UserPII>();
      for (const pii of piiResults) {
        piiMap.set(pii.id, pii);
      }

      // Merge Core and PII data
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
        };
      });
    } else if (coreUsers.length > 0) {
      // No PII DB - return Core data only
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
 * Get user details by ID
 * GET /admin/users/:id
 *
 * PII Separation: Queries both Core DB (users_core) and PII DB (users_pii), then merges.
 * Uses Repository pattern for database access.
 */
export async function adminUserGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');

    // Create AuthContext first, then elevate to PIIContext if PII DB is available
    const authCtx = createAuthContextFromHono(c);

    // Query Core DB for user_core data via Repository
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

    // Query PII DB for user_pii data via Repository (if DB_PII is configured)
    let userPII: UserPII | null = null;
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c);
      const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);
      userPII = await piiCtx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
    }

    // Get user's passkeys via Repository
    const passkeys = await authCtx.repositories.passkey.findByUserId(userId);

    // Get user's custom fields (direct adapter query - no dedicated repository)
    const customFields = await authCtx.coreAdapter.query<{
      field_name: string;
      field_value: string;
      field_type: string;
    }>('SELECT field_name, field_value, field_type FROM user_custom_fields WHERE user_id = ?', [
      userId,
    ]);

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
      // Core fields (Repository already returns proper boolean types)
      email_verified: userCore.email_verified,
      phone_number_verified: userCore.phone_number_verified,
      user_type: userCore.user_type,
      is_active: userCore.is_active,
      pii_partition: userCore.pii_partition,
      pii_status: userCore.pii_status,
      created_at: toMilliseconds(userCore.created_at),
      updated_at: toMilliseconds(userCore.updated_at),
      last_login_at: toMilliseconds(userCore.last_login_at),
    };

    // Format passkeys with millisecond timestamps (Repository returns array directly)
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
      customFields, // adapter.query returns array directly
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
 * Create a new user
 * POST /admin/users
 *
 * PII Separation: Creates user in both Core DB (users_core) and PII DB (users_pii).
 * Uses Repository pattern with pii_status to track distributed write state:
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
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if user already exists - query PII DB for email uniqueness
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const emailExists = await piiCtx.piiRepositories.userPII.emailExists(tenantId, email);

      if (emailExists) {
        // Security: Generic message to prevent email enumeration
        return c.json(
          {
            error: 'conflict',
            error_description: 'Unable to create user with the provided information',
          },
          409
        );
      }
    }

    const userId = generateId();

    // Step 1: Insert into users_core (Core DB) with pii_status='pending'
    await authCtx.repositories.userCore.createUser({
      id: userId,
      tenant_id: tenantId,
      email_verified: email_verified ?? false,
      phone_number_verified: phone_number_verified ?? false,
      user_type: (user_type as 'end_user' | 'admin' | 'm2m') || 'end_user',
      pii_partition: 'default',
      pii_status: 'pending',
    });

    // Step 2: Insert into users_pii (PII DB) if available
    if (c.env.DB_PII) {
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

        // Step 3: Update pii_status to 'active' on success
        await authCtx.repositories.userCore.updatePIIStatus(userId, 'active');
      } catch (piiError) {
        // PII insert failed - mark as 'failed' for retry
        logSanitizedError('PII insert failed', piiError);
        await authCtx.repositories.userCore.updatePIIStatus(userId, 'failed');
        throw piiError;
      }
    } else {
      // No PII DB - mark as 'none' (M2M user or single-DB mode)
      await authCtx.repositories.userCore.updatePIIStatus(userId, 'none');
    }

    // Fetch created user data (merged from both DBs)
    const userCore = await authCtx.repositories.userCore.findById(userId);

    let userPII: UserPII | null = null;
    if (c.env.DB_PII && userCore) {
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

    // Publish user created event (non-blocking)
    publishEvent(c, {
      type: USER_EVENTS.CREATED,
      tenantId,
      data: {
        userId,
      } satisfies UserEventData,
    }).catch((err: unknown) => {
      console.error('[Event] Failed to publish user.created:', err);
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
 * Update user
 * PUT /admin/users/:id
 *
 * PII Separation: Updates split between Core DB (users_core) and PII DB (users_pii).
 * Uses Repository pattern for database access.
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

    const authCtx = createAuthContextFromHono(c);

    // Check if user exists in Core DB via Repository
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

    // Separate Core and PII field updates
    const coreUpdateData: Record<string, unknown> = {};
    const piiUpdateData: Record<string, unknown> = {};

    // Core fields
    if (body.email_verified !== undefined) {
      coreUpdateData.email_verified = body.email_verified;
    }
    if (body.phone_number_verified !== undefined) {
      coreUpdateData.phone_number_verified = body.phone_number_verified;
    }
    if (body.user_type !== undefined) {
      coreUpdateData.user_type = body.user_type;
    }

    // PII fields
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

    // Check if there are any updates
    if (Object.keys(coreUpdateData).length === 0 && Object.keys(piiUpdateData).length === 0) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'No fields to update',
        },
        400
      );
    }

    // Update Core DB if there are core field updates via Repository
    if (Object.keys(coreUpdateData).length > 0) {
      await authCtx.repositories.userCore.update(userId, coreUpdateData);
    }

    // Update PII DB if there are PII field updates and DB_PII is available
    if (Object.keys(piiUpdateData).length > 0 && c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c);
      const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);
      await piiCtx.piiRepositories.userPII.updatePII(userId, piiUpdateData, piiAdapter);
    }

    // Invalidate user cache (cache invalidation hook)
    await invalidateUserCache(c.env, userId);

    // Fetch updated user data via Repository
    const updatedCore = await authCtx.repositories.userCore.findById(userId);

    let updatedPII: UserPII | null = null;
    if (c.env.DB_PII && updatedCore) {
      const piiCtx = createPIIContextFromHono(c);
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

    // Publish user updated event (non-blocking)
    publishEvent(c, {
      type: USER_EVENTS.UPDATED,
      tenantId: getTenantIdFromContext(c),
      data: {
        userId,
      } satisfies UserEventData,
    }).catch((err: unknown) => {
      console.error('[Event] Failed to publish user.updated:', err);
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
 * Delete user
 * DELETE /admin/users/:id
 *
 * PII Separation: Soft delete in Core DB, hard delete in PII DB (GDPR requirement).
 * Uses Repository pattern for database access.
 * - Sets is_active=0 and pii_status='deleted' in users_core
 * - Deletes PII data from users_pii
 * - Creates tombstone record for audit trail
 */
export async function adminUserDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if user exists in Core DB via Repository
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

    // Get PII data for tombstone before deletion
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);

      // Get email_blind_index before deletion
      const userPII = await piiCtx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
      const emailBlindIndex = userPII?.email_blind_index ?? null;

      // Create tombstone record for GDPR audit trail via Repository
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

      // Hard delete PII data (GDPR requirement) via Repository
      await piiCtx.piiRepositories.userPII.deletePII(userId, piiAdapter);
    }

    // Soft delete in Core DB via Repository (update is_active and pii_status)
    await authCtx.repositories.userCore.update(userId, {
      is_active: false,
      pii_status: 'deleted',
    });

    // Invalidate user cache
    await invalidateUserCache(c.env, userId);

    // Publish user deleted event (non-blocking)
    publishEvent(c, {
      type: USER_EVENTS.DELETED,
      tenantId,
      data: {
        userId,
      } satisfies UserEventData,
    }).catch((err: unknown) => {
      console.error('[Event] Failed to publish user.deleted:', err);
    });

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
 * Retry PII creation for a user with failed PII status
 * POST /admin/users/:id/retry-pii
 *
 * When user creation fails to write PII data (e.g., due to DB_PII unavailability),
 * the user's pii_status is set to 'failed'. This endpoint allows admin to retry
 * the PII creation with the data provided in the request body.
 *
 * Request Body:
 * - email: string (required)
 * - name?: string
 * - given_name?: string
 * - family_name?: string
 * - phone_number?: string
 * - ... (other PII fields)
 */
export async function adminUserRetryPiiHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if user exists and has failed PII status
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

    // Check if PII DB is available
    if (!c.env.DB_PII) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'PII database (DB_PII) is not available',
        },
        500
      );
    }

    // Parse request body for PII data
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

    // Check if PII already exists (shouldn't, but check anyway)
    const existingPii = await piiCtx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
    if (existingPii) {
      // PII exists, just update the status
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

    // Create PII record
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

    // Update Core DB status to active
    await authCtx.repositories.userCore.update(userId, {
      pii_status: 'active',
    });

    // Invalidate user cache
    await invalidateUserCache(c.env, userId);

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
 * Delete user's PII data only (GDPR Art.17 Right to be Forgotten)
 * DELETE /admin/users/:id/pii
 *
 * Deletes only the PII data while keeping the Core user record active.
 * This is useful for GDPR deletion requests where you want to:
 * - Delete all personal information
 * - Keep the user account for audit trail
 * - Allow user to continue using the service with re-entered data
 *
 * Creates a tombstone record for audit trail.
 *
 * Request Body (optional):
 * - reason?: string (deletion_reason, default: 'user_request')
 * - retention_days?: number (tombstone retention, default: 90)
 */
export async function adminUserDeletePiiHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if user exists
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

    // Check if PII is already deleted
    if (userCore.pii_status === 'deleted') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User PII is already deleted',
        },
        400
      );
    }

    // Check if user has no PII to delete
    if (userCore.pii_status === 'none') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User has no PII data (pii_status is none)',
        },
        400
      );
    }

    // Check if PII DB is available
    if (!c.env.DB_PII) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'PII database (DB_PII) is not available',
        },
        500
      );
    }

    // Parse optional request body
    let body: { reason?: string; retention_days?: number } = {};
    try {
      body = await c.req.json();
    } catch {
      // No body is fine, use defaults
    }

    const deletionReason = body.reason ?? 'user_request';
    const retentionDays = body.retention_days ?? 90;

    const piiCtx = createPIIContextFromHono(c, tenantId);
    const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);

    // Get email_blind_index before deletion for tombstone
    const userPII = await piiCtx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
    const emailBlindIndex = userPII?.email_blind_index ?? null;

    // Create tombstone record for GDPR audit trail
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
          user_active: true, // User account remains active
        },
      },
      piiAdapter
    );

    // Hard delete PII data (GDPR requirement)
    await piiCtx.piiRepositories.userPII.deletePII(userId, piiAdapter);

    // Delete linked identities (also PII)
    await piiCtx.piiRepositories.linkedIdentity.deleteByUserId(userId, piiAdapter);

    // Delete subject identifiers (pairwise subs)
    await piiCtx.piiRepositories.identifier.deleteByUserId(userId, piiAdapter);

    // Update Core DB status to deleted (but keep is_active=1)
    await authCtx.repositories.userCore.update(userId, {
      pii_status: 'deleted',
    });

    // Invalidate user cache
    await invalidateUserCache(c.env, userId);

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

/**
 * Create a new OAuth client
 * POST /admin/clients
 * Uses Repository pattern for database access.
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
      // Custom Redirect URIs (Authrim Extension)
      allowed_redirect_origins?: string[];
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

    // Validate allowed_redirect_origins if provided (Custom Redirect URIs - Authrim Extension)
    let validatedAllowedOrigins: string[] | undefined;
    if (body.allowed_redirect_origins !== undefined) {
      if (!Array.isArray(body.allowed_redirect_origins)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'allowed_redirect_origins must be an array of origin strings',
          },
          400
        );
      }
      const originsValidation = validateAllowedOrigins(body.allowed_redirect_origins);
      if (!originsValidation.valid) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid allowed_redirect_origins: ${originsValidation.errors.join(', ')}`,
          },
          400
        );
      }
      validatedAllowedOrigins = originsValidation.normalizedOrigins;
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Generate client_secret
    const clientSecret =
      crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

    // Create client via Repository
    const client = await authCtx.repositories.client.create({
      client_name: body.client_name,
      client_secret: clientSecret,
      tenant_id: tenantId,
      redirect_uris: body.redirect_uris,
      grant_types: body.grant_types || ['authorization_code'],
      response_types: body.response_types || ['code'],
      scope: body.scope || 'openid profile email',
      logo_uri: body.logo_uri || null,
      client_uri: body.client_uri || null,
      policy_uri: body.policy_uri || null,
      tos_uri: body.tos_uri || null,
      contacts: body.contacts || null,
      token_endpoint_auth_method:
        (body.token_endpoint_auth_method as
          | 'none'
          | 'client_secret_basic'
          | 'client_secret_post'
          | 'client_secret_jwt'
          | 'private_key_jwt') || 'client_secret_basic',
      subject_type: (body.subject_type as 'public' | 'pairwise') || 'public',
      sector_identifier_uri: body.sector_identifier_uri || null,
      is_trusted: body.is_trusted || false,
      skip_consent: body.skip_consent || false,
      allow_claims_without_scope: body.allow_claims_without_scope || false,
      // Custom Redirect URIs (Authrim Extension)
      allowed_redirect_origins: validatedAllowedOrigins,
    });

    // Publish client created event (non-blocking)
    publishEvent(c, {
      type: CLIENT_EVENTS.CREATED,
      tenantId,
      data: {
        clientId: client.client_id,
      } satisfies ClientEventData,
    }).catch((err: unknown) => {
      console.error('[Event] Failed to publish client.created:', err);
    });

    // Return the created client (including client_secret only on creation)
    return c.json(
      {
        client: {
          client_id: client.client_id,
          client_secret: clientSecret, // Return secret only on creation
          client_name: client.client_name,
          redirect_uris: JSON.parse(client.redirect_uris),
          grant_types: JSON.parse(client.grant_types),
          response_types: JSON.parse(client.response_types),
          scope: client.scope,
          logo_uri: client.logo_uri,
          client_uri: client.client_uri,
          policy_uri: client.policy_uri,
          tos_uri: client.tos_uri,
          contacts: client.contacts ? JSON.parse(client.contacts) : [],
          token_endpoint_auth_method: client.token_endpoint_auth_method,
          subject_type: client.subject_type,
          sector_identifier_uri: client.sector_identifier_uri,
          is_trusted: client.is_trusted,
          skip_consent: client.skip_consent,
          allow_claims_without_scope: client.allow_claims_without_scope,
          created_at: client.created_at,
          updated_at: client.updated_at,
        },
      },
      201
    );
  } catch (error) {
    logSanitizedError('Admin client create error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create client',
        ...getErrorDetailsForResponse(error, c.env),
      },
      500
    );
  }
}

/**
 * Get paginated list of OAuth clients
 * GET /admin/clients
 * Uses Repository pattern for database access.
 */
export async function adminClientsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const search = c.req.query('search') || '';

    const authCtx = createAuthContextFromHono(c, tenantId);

    // Get clients via Repository with pagination and search
    const result = await authCtx.repositories.client.listByTenant(tenantId, {
      page,
      limit,
      search: search || undefined,
    });

    // Format clients with millisecond timestamps and parse JSON fields
    const formattedClients = result.items.map((client) => ({
      ...client,
      redirect_uris: JSON.parse(client.redirect_uris),
      grant_types: JSON.parse(client.grant_types),
      response_types: JSON.parse(client.response_types),
      contacts: client.contacts ? JSON.parse(client.contacts) : [],
      created_at: toMilliseconds(client.created_at),
      updated_at: toMilliseconds(client.updated_at),
    }));

    return c.json({
      clients: formattedClients,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
        hasNext: result.hasNext,
        hasPrev: result.hasPrev,
      },
    });
  } catch (error) {
    logSanitizedError('Admin clients list error', error);
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
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const client = await authCtx.repositories.client.findByClientId(clientId);

    if (!client) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Parse JSON fields for response
    // Note: Repository handles boolean conversion, but JSON fields are stored as strings
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
    logSanitizedError('Admin client get error', error);
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
 *
 * Repository pattern migration: Uses ClientRepository.update() which handles:
 * - Dynamic update query building
 * - Boolean to integer conversion for SQLite
 * - JSON stringification for array fields
 * - Automatic updated_at timestamp
 */
export async function adminClientUpdateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const clientId = c.req.param('id');
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if client exists
    const existingClient = await authCtx.repositories.client.findByClientId(clientId);

    if (!existingClient) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Parse request body and extract updatable fields
    const body = await c.req.json();
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
      allowed_redirect_origins,
    } = body;

    // Validate allowed_redirect_origins if provided (Custom Redirect URIs - Authrim Extension)
    let validatedAllowedOrigins: string[] | undefined;
    if (allowed_redirect_origins !== undefined) {
      if (allowed_redirect_origins === null) {
        // Allow null to clear the field
        validatedAllowedOrigins = [];
      } else if (!Array.isArray(allowed_redirect_origins)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'allowed_redirect_origins must be an array of origin strings',
          },
          400
        );
      } else {
        const originsValidation = validateAllowedOrigins(allowed_redirect_origins);
        if (!originsValidation.valid) {
          return c.json(
            {
              error: 'invalid_request',
              error_description: `Invalid allowed_redirect_origins: ${originsValidation.errors.join(', ')}`,
            },
            400
          );
        }
        validatedAllowedOrigins = originsValidation.normalizedOrigins;
      }
    }

    // Check if there are any actual updates
    const hasUpdates = [
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
      allowed_redirect_origins,
    ].some((v) => v !== undefined);

    if (!hasUpdates) {
      return c.json({
        success: true,
        message: 'No changes to update',
      });
    }

    // Update via Repository (handles dynamic SQL, boolean conversion, JSON stringify)
    const updatedClient = await authCtx.repositories.client.update(clientId, {
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
      allowed_redirect_origins: validatedAllowedOrigins,
    });

    // Invalidate CLIENTS_CACHE (explicit invalidation after D1 update)
    // D1 is source of truth - cache will be repopulated on next getClient() call
    try {
      await c.env.CLIENTS_CACHE.delete(clientId);
    } catch (error) {
      console.warn(`Failed to invalidate cache for ${clientId}:`, error);
      // Cache invalidation failure should not block the response
      // Worst case: stale cache for up to 5 minutes (TTL)
    }

    // Publish client updated event (non-blocking)
    publishEvent(c, {
      type: CLIENT_EVENTS.UPDATED,
      tenantId,
      data: {
        clientId,
      } satisfies ClientEventData,
    }).catch((err: unknown) => {
      console.error('[Event] Failed to publish client.updated:', err);
    });

    return c.json({
      success: true,
      client: updatedClient,
    });
  } catch (error) {
    logSanitizedError('Admin client update error', error);
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
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if client exists using Repository
    const exists = await authCtx.repositories.client.exists(clientId);

    if (!exists) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Delete from D1 database via Repository
    await authCtx.repositories.client.delete(clientId);

    // Invalidate CLIENTS_CACHE (explicit invalidation after D1 delete)
    try {
      await c.env.CLIENTS_CACHE.delete(clientId);
    } catch (error) {
      console.warn(`Failed to invalidate cache for ${clientId}:`, error);
      // Cache invalidation failure should not block the response
    }

    // Publish client deleted event (non-blocking)
    publishEvent(c, {
      type: CLIENT_EVENTS.DELETED,
      tenantId,
      data: {
        clientId,
      } satisfies ClientEventData,
    }).catch((err: unknown) => {
      console.error('[Event] Failed to publish client.deleted:', err);
    });

    return c.json({
      success: true,
      message: 'Client deleted successfully',
    });
  } catch (error) {
    logSanitizedError('Admin client delete error', error);
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

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Bulk delete via Repository (returns deleted count and failed IDs)
    const result = await authCtx.repositories.client.bulkDelete(client_ids);

    // Invalidate cache for successfully deleted clients
    // Calculate successfully deleted IDs = requested - failed
    const successfullyDeletedIds = client_ids.filter((id) => !result.failed.includes(id));
    for (const clientId of successfullyDeletedIds) {
      try {
        await c.env.CLIENTS_CACHE.delete(clientId);
      } catch (error) {
        console.warn(`Failed to invalidate cache for ${clientId}:`, error);
        // Cache invalidation failure should not block the bulk delete
      }
    }

    // Convert failed IDs to error messages for backward compatibility
    const errors =
      result.failed.length > 0
        ? result.failed.map((id) => `Failed to delete ${id}: client not found or delete failed`)
        : undefined;

    return c.json({
      success: true,
      deleted: result.deleted,
      requested: client_ids.length,
      errors,
    });
  } catch (error) {
    logSanitizedError('Admin clients bulk delete error', error);
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
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if user exists in Core DB via Repository
    const userCore = await authCtx.repositories.userCore.findById(userId);

    if (!userCore || !userCore.is_active) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
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

    // Sanitize and validate file extension (prevent path traversal)
    const sanitizedName = file.name.replace(/\.\./g, '').replace(/[/\\]/g, '');
    const rawExtension = sanitizedName.split('.').pop()?.toLowerCase() || '';
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    if (!allowedExtensions.includes(rawExtension)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid file extension. Allowed: jpg, jpeg, png, gif, webp',
        },
        400
      );
    }

    // Read file content for Magic Bytes validation
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // Validate file content matches declared type (Magic Bytes check)
    const detectedType = detectImageType(uint8Array);
    if (!detectedType) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'File content does not appear to be a valid image',
        },
        400
      );
    }

    // Use detected extension for consistency
    const fileExtension = detectedType.extension;
    const fileName = `${userId}.${fileExtension}`;
    const filePath = `avatars/${fileName}`;

    // Upload to R2 with detected content type
    await c.env.AVATARS.put(filePath, arrayBuffer, {
      httpMetadata: {
        contentType: file.type,
      },
    });

    // Construct avatar URL (will use Cloudflare Image Resizing)
    const avatarUrl = `${c.env.ISSUER_URL}/${filePath}`;

    // Update user's picture field in PII DB via Repository
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);
      await piiCtx.piiRepositories.userPII.updatePII(userId, { picture: avatarUrl }, piiAdapter);
    }

    // Invalidate user cache (cache invalidation hook)
    await invalidateUserCache(c.env, userId);

    return c.json({
      success: true,
      avatarUrl,
      message: 'Avatar uploaded successfully',
    });
  } catch (error) {
    logSanitizedError('Admin avatar upload error', error);
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
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if user exists in Core DB via Repository
    const userCore = await authCtx.repositories.userCore.findById(userId);

    if (!userCore || !userCore.is_active) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Get picture URL from PII DB via Repository
    let pictureUrl: string | null = null;
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);
      const userPII = await piiCtx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
      pictureUrl = userPII?.picture ?? null;
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
      logSanitizedError('R2 delete error', error);
      // Continue even if R2 delete fails
    }

    // Update user's picture field to null in PII DB via Repository
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);
      await piiCtx.piiRepositories.userPII.updatePII(userId, { picture: null }, piiAdapter);
    }

    // Invalidate user cache (cache invalidation hook)
    await invalidateUserCache(c.env, userId);

    return c.json({
      success: true,
      message: 'Avatar deleted successfully',
    });
  } catch (error) {
    logSanitizedError('Admin avatar delete error', error);
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
    const authCtx = createAuthContextFromHono(c, tenantId);
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
    const bindings: unknown[] = [tenantId];
    const countBindings: unknown[] = [tenantId];

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

    // Execute session queries in parallel via adapter
    interface SessionRow {
      id: string;
      user_id: string;
      created_at: number;
      last_accessed_at: number | null;
      expires_at: number;
      ip_address: string | null;
      user_agent: string | null;
    }

    const [totalResult, sessions] = await Promise.all([
      authCtx.coreAdapter.queryOne<{ count: number }>(countQuery, countBindings),
      authCtx.coreAdapter.query<SessionRow>(query, bindings),
    ]);

    const total = totalResult?.count || 0;
    const totalPages = Math.ceil(total / limit);

    // Fetch PII for users (email, name) from PII DB via adapter
    const userPIIMap = new Map<string, { email: string | null; name: string | null }>();
    if (c.env.DB_PII && sessions.length > 0) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const userIds = [...new Set(sessions.map((s) => s.user_id).filter(Boolean))];
      if (userIds.length > 0) {
        const placeholders = userIds.map(() => '?').join(',');
        const piiResults = await piiCtx.defaultPiiAdapter.query<{
          id: string;
          email: string | null;
          name: string | null;
        }>(`SELECT id, email, name FROM users_pii WHERE id IN (${placeholders})`, userIds);

        for (const pii of piiResults) {
          userPIIMap.set(pii.id, { email: pii.email, name: pii.name });
        }
      }
    }

    // Format sessions with metadata (snake_case for UI compatibility)
    const formattedSessions = sessions.map((session) => {
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
    logSanitizedError('Admin sessions list error', error);
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
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

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

    // Get from D1 for additional metadata via adapter
    interface SessionRow {
      id: string;
      user_id: string;
      created_at: number;
      expires_at: number;
    }
    const session = await authCtx.coreAdapter.queryOne<SessionRow>(
      'SELECT * FROM sessions WHERE id = ?',
      [sessionId]
    );

    if (!session && !sessionData) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Session not found',
        },
        404
      );
    }

    // Fetch user PII separately from PII DB via adapter
    let userEmail: string | null = null;
    let userName: string | null = null;
    const userId = sessionData?.userId || session?.user_id;
    if (userId && c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const userPII = await piiCtx.defaultPiiAdapter.queryOne<{
        email: string | null;
        name: string | null;
      }>('SELECT email, name FROM users_pii WHERE id = ?', [userId]);
      userEmail = userPII?.email || null;
      userName = userPII?.name || null;
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
    logSanitizedError('Admin session get error', error);
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
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if session exists in D1 via adapter
    const session = await authCtx.coreAdapter.queryOne<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM sessions WHERE id = ?',
      [sessionId]
    );

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

    // Delete from D1 via adapter
    await authCtx.coreAdapter.execute('DELETE FROM sessions WHERE id = ?', [sessionId]);

    // TODO: Create Audit Log entry (Phase 6)
    console.log(`Admin revoked session: ${sessionId} for user ${session.user_id}`);

    return c.json({
      success: true,
      message: 'Session revoked successfully',
      sessionId: sessionId,
    });
  } catch (error) {
    logSanitizedError('Admin session revoke error', error);
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
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if user exists in Core DB via Repository
    const userCore = await authCtx.repositories.userCore.findById(userId);

    if (!userCore || !userCore.is_active) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
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

    // Delete all sessions from D1 via adapter
    const deleteResult = await authCtx.coreAdapter.execute(
      'DELETE FROM sessions WHERE user_id = ?',
      [userId]
    );

    const dbRevokedCount = deleteResult.rowsAffected || 0;

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
    logSanitizedError('Admin revoke all sessions error', error);
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
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
    const countQuery = `SELECT COUNT(*) as total FROM audit_log ${whereClause}`;
    const countResult = await coreAdapter.queryOne<{ total: number }>(countQuery, params);

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

    const result = await coreAdapter.query<{
      id: string;
      user_id: string | null;
      action: string;
      resource_type: string | null;
      resource_id: string | null;
      ip_address: string | null;
      user_agent: string | null;
      metadata_json: string | null;
      created_at: number;
    }>(query, [...params, limit, offset]);

    // Format entries
    const entries = result.map((row) => ({
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
    logSanitizedError('Admin audit log list error', error);
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
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
    const entry = await coreAdapter.queryOne<{
      id: string;
      user_id: string | null;
      action: string;
      resource_type: string | null;
      resource_id: string | null;
      ip_address: string | null;
      user_agent: string | null;
      metadata_json: string | null;
      created_at: number;
    }>(
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
      `,
      [id]
    );

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
      const userCore = await coreAdapter.queryOne<{ id: string }>(
        'SELECT id FROM users_core WHERE id = ? AND is_active = 1',
        [entry.user_id]
      );

      if (userCore && env.DB_PII) {
        const piiAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB_PII });
        const userPII = await piiAdapter.queryOne<{
          email: string | null;
          name: string | null;
          picture: string | null;
        }>('SELECT email, name, picture FROM users_pii WHERE id = ?', [entry.user_id]);

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
    logSanitizedError('Admin audit log get error', error);
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
    logSanitizedError('Admin settings get error', error);
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
    logSanitizedError('Admin settings update error', error);
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
    logSanitizedError('Admin list profiles error', error);
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
    logSanitizedError('Admin apply profile error', error);
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
    logSanitizedError('Admin signing key get error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get signing key',
        ...getErrorDetailsForResponse(error, c.env),
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
      logSanitizedError('Failed to parse JWT', parseError);
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
      logSanitizedError('Failed to register token', error);
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
    logSanitizedError('Admin token register error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to register token',
        ...getErrorDetailsForResponse(error, c.env),
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
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

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

    // Verify user exists in Core DB via Repository
    const userCore = await authCtx.repositories.userCore.findById(user_id);

    if (!userCore || !userCore.is_active) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Get user PII for session metadata via adapter
    let userEmail: string | null = null;
    let userName: string | null = null;
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiAdapter = piiCtx.getPiiAdapter(userCore.pii_partition);
      const userPII = await piiAdapter.queryOne<{ email: string | null; name: string | null }>(
        'SELECT email, name FROM users_pii WHERE id = ?',
        [user_id]
      );
      userEmail = userPII?.email ?? null;
      userName = userPII?.name ?? null;
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
      logSanitizedError('Failed to create session', error);
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
    logSanitizedError('Admin test session create error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create test session',
        ...getErrorDetailsForResponse(error, c.env),
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
    const piiCtx = createPIIContextFromHono(c, tenantId);
    let userId: string | null = null;
    let userEmail: string | null = null;
    let userName: string | null = null;

    if (c.env.DB_PII) {
      const userPII = await piiCtx.piiRepositories.userPII.findByTenantAndEmail(
        tenantId,
        email.toLowerCase()
      );

      if (userPII) {
        userId = userPII.id;
        userEmail = userPII.email;
        userName = userPII.name;
      }
    }

    // create_user option: if false, don't create new user (for benchmarks with pre-seeded users)
    const createUser = body.create_user !== false;

    if (!userId) {
      if (!createUser) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'User does not exist and create_user is false',
          },
          404
        );
      }

      const authCtx = createAuthContextFromHono(c, tenantId);
      const preferredUsername = email.split('@')[0];

      // Create user in Core DB with pii_status='pending'
      const newUser = await authCtx.repositories.userCore.createUser({
        tenant_id: tenantId,
        email_verified: false,
        phone_number_verified: false,
        password_hash: null,
        is_active: true,
        user_type: 'end_user',
        pii_partition: 'default',
        pii_status: 'pending',
      });
      userId = newUser.id;

      // Create PII record if available
      if (c.env.DB_PII) {
        await piiCtx.piiRepositories.userPII.createPII({
          id: userId,
          tenant_id: tenantId,
          pii_class: 'PROFILE',
          email: email.toLowerCase(),
          preferred_username: preferredUsername,
        });

        // Update pii_status to 'active'
        await authCtx.repositories.userCore.updatePIIStatus(userId, 'active');
      } else {
        // No PII DB - mark as 'none'
        await authCtx.repositories.userCore.updatePIIStatus(userId, 'none');
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
    logSanitizedError('Admin test email code error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create test email code',
        ...getErrorDetailsForResponse(error, c.env),
      },
      500
    );
  }
}

// =============================================================================
// Admin Consent Management
// =============================================================================

/**
 * GET /api/admin/users/:userId/consents
 * List consents for a specific user
 */
export async function adminUserConsentsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('userId');
    if (!userId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User ID is required',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if user exists
    const userCore = await authCtx.repositories.userCore.findById(userId);
    if (!userCore) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // Query consents with client info
    const consentsResult = await authCtx.coreAdapter.query<{
      id: string;
      client_id: string;
      scope: string;
      selected_scopes: string | null;
      granted_at: number;
      expires_at: number | null;
      privacy_policy_version: string | null;
      tos_version: string | null;
      consent_version: number | null;
      client_name: string | null;
      logo_uri: string | null;
    }>(
      `SELECT c.id, c.client_id, c.scope, c.selected_scopes, c.granted_at, c.expires_at,
              c.privacy_policy_version, c.tos_version, c.consent_version,
              oc.client_name, oc.logo_uri
       FROM oauth_client_consents c
       LEFT JOIN oauth_clients oc ON c.client_id = oc.client_id
       WHERE c.user_id = ? AND c.tenant_id = ?
       ORDER BY c.granted_at DESC`,
      [userId, tenantId]
    );

    const consents = consentsResult.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      clientName: row.client_name ?? undefined,
      clientLogoUri: row.logo_uri ?? undefined,
      scopes: row.scope.split(' '),
      selectedScopes: row.selected_scopes ? JSON.parse(row.selected_scopes) : undefined,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at ?? undefined,
      policyVersions:
        row.privacy_policy_version || row.tos_version
          ? {
              privacyPolicyVersion: row.privacy_policy_version ?? undefined,
              tosVersion: row.tos_version ?? undefined,
              consentVersion: row.consent_version ?? 1,
            }
          : undefined,
    }));

    return c.json({
      userId,
      consents,
      total: consents.length,
    });
  } catch (error) {
    logSanitizedError('Admin user consents list error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list user consents',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/users/:userId/consents/:clientId
 * Revoke consent for a specific user and client (admin action)
 */
export async function adminUserConsentRevokeHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('userId');
    const clientId = c.req.param('clientId');

    if (!userId || !clientId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User ID and Client ID are required',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if consent exists
    const existingConsent = await authCtx.coreAdapter.query<{
      id: string;
      scope: string;
    }>(
      `SELECT id, scope FROM oauth_client_consents
       WHERE user_id = ? AND client_id = ? AND tenant_id = ?`,
      [userId, clientId, tenantId]
    );

    if (existingConsent.length === 0) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Consent not found',
        },
        404
      );
    }

    const consent = existingConsent[0];
    const previousScopes = consent.scope.split(' ');
    const now = Date.now();

    // Delete consent
    await authCtx.coreAdapter.execute(
      `DELETE FROM oauth_client_consents WHERE user_id = ? AND client_id = ? AND tenant_id = ?`,
      [userId, clientId, tenantId]
    );

    // Record in consent history
    const historyId = crypto.randomUUID();
    await authCtx.coreAdapter.execute(
      `INSERT INTO consent_history (id, tenant_id, user_id, client_id, action, scopes_before, scopes_after, created_at)
       VALUES (?, ?, ?, ?, 'revoked', ?, NULL, ?)`,
      [historyId, tenantId, userId, clientId, JSON.stringify(previousScopes), now]
    );

    // Invalidate consent cache
    await invalidateConsentCache(c.env, userId, clientId);

    // Add to revocation list
    try {
      const revocationKey = `consent_revoked:${userId}:${clientId}`;
      const revocationTTL = 86400 * 90;
      await revokeToken(c.env, revocationKey, revocationTTL);
    } catch (error) {
      console.warn('[Admin] Token revocation warning:', error);
    }

    // Publish consent.revoked event
    publishEvent(c, {
      type: CONSENT_EVENTS.REVOKED,
      tenantId,
      data: {
        userId,
        clientId,
        scopes: previousScopes,
        previousScopes,
        revocationReason: 'admin_action',
        initiatedBy: 'admin',
      } satisfies ExtendedConsentEventData,
    }).catch((err) => {
      console.error('[Event] Failed to publish consent.revoked:', err);
    });

    console.log(`[ADMIN] Revoked consent: user=${userId}, client=${clientId}`);

    return c.json({
      success: true,
      userId,
      clientId,
      revokedAt: now,
    });
  } catch (error) {
    logSanitizedError('Admin user consent revoke error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to revoke consent',
      },
      500
    );
  }
}
