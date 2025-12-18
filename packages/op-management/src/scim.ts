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
import type { Env } from '@authrim/shared/types/env';
import {
  invalidateUserCache,
  getTenantIdFromContext,
  createAuthContextFromHono,
  createPIIContextFromHono,
} from '@authrim/shared';
import { D1Adapter, type DatabaseAdapter, generateId, hashPassword } from '@authrim/shared';

/**
 * Create database adapters from Hono context
 */
function createAdaptersFromContext(c: Context<{ Bindings: Env }>): {
  coreAdapter: DatabaseAdapter;
  piiAdapter: DatabaseAdapter | null;
} {
  const coreAdapter = new D1Adapter({ db: c.env.DB });
  const piiAdapter = c.env.DB_PII ? new D1Adapter({ db: c.env.DB_PII }) : null;
  return { coreAdapter, piiAdapter };
}

/**
 * Fetch user from both Core and PII databases and merge into InternalUser
 */
async function fetchUserWithPII(
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter | null,
  userId: string
): Promise<InternalUser | null> {
  // Query Core DB via Adapter
  const userCore = await coreAdapter.queryOne<{
    id: string;
    tenant_id: string;
    email_verified: number;
    phone_number_verified: number;
    password_hash: string | null;
    is_active: number;
    user_type: string;
    external_id: string | null;
    pii_partition: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, tenant_id, email_verified, phone_number_verified, password_hash,
            is_active, user_type, external_id, pii_partition, created_at, updated_at
     FROM users_core WHERE id = ?`,
    [userId]
  );

  if (!userCore) return null;

  // Query PII DB (if configured) via Adapter
  let userPII: {
    email: string;
    name: string | null;
    given_name: string | null;
    family_name: string | null;
    middle_name: string | null;
    nickname: string | null;
    preferred_username: string | null;
    profile: string | null;
    picture: string | null;
    website: string | null;
    gender: string | null;
    birthdate: string | null;
    zoneinfo: string | null;
    locale: string | null;
    phone_number: string | null;
    address_formatted: string | null;
    address_street_address: string | null;
    address_locality: string | null;
    address_region: string | null;
    address_postal_code: string | null;
    address_country: string | null;
  } | null = null;

  if (piiAdapter) {
    userPII = await piiAdapter.queryOne(
      `SELECT email, name, given_name, family_name, middle_name, nickname,
              preferred_username, profile, picture, website, gender, birthdate,
              zoneinfo, locale, phone_number, address_formatted, address_street_address,
              address_locality, address_region, address_postal_code, address_country
       FROM users_pii WHERE id = ?`,
      [userId]
    );
  }

  // Merge into InternalUser format
  return {
    id: userCore.id as string,
    tenant_id: userCore.tenant_id as string,
    email: userPII?.email ?? null,
    email_verified: userCore.email_verified as number,
    name: userPII?.name ?? null,
    given_name: userPII?.given_name ?? null,
    family_name: userPII?.family_name ?? null,
    middle_name: userPII?.middle_name ?? null,
    nickname: userPII?.nickname ?? null,
    preferred_username: userPII?.preferred_username ?? null,
    profile: userPII?.profile ?? null,
    picture: userPII?.picture ?? null,
    website: userPII?.website ?? null,
    gender: userPII?.gender ?? null,
    birthdate: userPII?.birthdate ?? null,
    zoneinfo: userPII?.zoneinfo ?? null,
    locale: userPII?.locale ?? null,
    phone_number: userPII?.phone_number ?? null,
    phone_number_verified: userCore.phone_number_verified as number,
    address_json: userPII
      ? JSON.stringify({
          formatted: userPII.address_formatted,
          street_address: userPII.address_street_address,
          locality: userPII.address_locality,
          region: userPII.address_region,
          postal_code: userPII.address_postal_code,
          country: userPII.address_country,
        })
      : null,
    password_hash: userCore.password_hash as string | null,
    external_id: userCore.external_id as string | null,
    active: userCore.is_active as number,
    custom_attributes_json: null,
    created_at: userCore.created_at as string,
    updated_at: userCore.updated_at as string,
  } as InternalUser;
}

/**
 * Fetch multiple users with PII for list operations
 */
async function fetchUsersWithPII(
  piiAdapter: DatabaseAdapter | null,
  coreUsers: any[]
): Promise<InternalUser[]> {
  if (coreUsers.length === 0) return [];

  // Query PII for all users via Adapter
  const userIds = coreUsers.map((u) => u.id);
  const piiMap = new Map<string, any>();

  if (piiAdapter && userIds.length > 0) {
    const placeholders = userIds.map(() => '?').join(',');
    const piiResults = await piiAdapter.query<{ id: string; [key: string]: any }>(
      `SELECT id, email, name, given_name, family_name, middle_name, nickname,
              preferred_username, profile, picture, website, gender, birthdate,
              zoneinfo, locale, phone_number, address_formatted, address_street_address,
              address_locality, address_region, address_postal_code, address_country
       FROM users_pii WHERE id IN (${placeholders})`,
      userIds
    );

    for (const pii of piiResults) {
      piiMap.set(pii.id, pii);
    }
  }

  // Merge Core and PII
  return coreUsers.map((core) => {
    const pii = piiMap.get(core.id);
    return {
      id: core.id,
      tenant_id: core.tenant_id,
      email: pii?.email ?? null,
      email_verified: core.email_verified,
      name: pii?.name ?? null,
      given_name: pii?.given_name ?? null,
      family_name: pii?.family_name ?? null,
      middle_name: pii?.middle_name ?? null,
      nickname: pii?.nickname ?? null,
      preferred_username: pii?.preferred_username ?? null,
      profile: pii?.profile ?? null,
      picture: pii?.picture ?? null,
      website: pii?.website ?? null,
      gender: pii?.gender ?? null,
      birthdate: pii?.birthdate ?? null,
      zoneinfo: pii?.zoneinfo ?? null,
      locale: pii?.locale ?? null,
      phone_number: pii?.phone_number ?? null,
      phone_number_verified: core.phone_number_verified,
      address_json: pii
        ? JSON.stringify({
            formatted: pii.address_formatted,
            street_address: pii.address_street_address,
            locality: pii.address_locality,
            region: pii.address_region,
            postal_code: pii.address_postal_code,
            country: pii.address_country,
          })
        : null,
      password_hash: core.password_hash,
      external_id: core.external_id,
      active: core.is_active,
      custom_attributes_json: null,
      created_at: core.created_at,
      updated_at: core.updated_at,
    } as InternalUser;
  });
}

/**
 * Fetch group members with PII from both Core and PII databases
 * PII/Non-PII DB分離: JOINできないため、user_rolesとPII DBを別々にクエリ
 */
async function fetchGroupMembersWithPII(
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter | null,
  roleId: string
): Promise<{ user_id: string; email: string }[]> {
  // Get user_ids from user_roles (Core DB) via Adapter
  const roleMembers = await coreAdapter.query<{ user_id: string }>(
    'SELECT user_id FROM user_roles WHERE role_id = ?',
    [roleId]
  );

  if (roleMembers.length === 0) {
    return [];
  }

  const userIds = roleMembers.map((r) => r.user_id);
  const emailMap = new Map<string, string>();

  // Fetch emails from PII DB via Adapter
  if (piiAdapter && userIds.length > 0) {
    const placeholders = userIds.map(() => '?').join(',');
    const piiResults = await piiAdapter.query<{ id: string; email: string }>(
      `SELECT id, email FROM users_pii WHERE id IN (${placeholders})`,
      userIds
    );

    for (const pii of piiResults) {
      emailMap.set(pii.id, pii.email);
    }
  }

  // Merge results
  return roleMembers.map((r) => ({
    user_id: r.user_id,
    email: emailMap.get(r.user_id) || '',
  }));
}
import {
  // Types
  SCIM_SCHEMAS,
  type ScimUser,
  type ScimGroup,
  type ScimListResponse,
  type ScimError,
  type ScimPatchOp,
  type ScimQueryParams,
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
} from '@authrim/scim';

const app = new Hono<{ Bindings: Env }>();

// Apply SCIM authentication to all routes
app.use('*', scimAuthMiddleware);

/**
 * Helper: Get base URL from request
 */
function getBaseUrl(c: any): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * Helper: Return SCIM error response
 */
function scimError(c: any, status: number, detail: string, scimType?: string): Response {
  const error: ScimError = {
    schemas: [SCIM_SCHEMAS.ERROR],
    status: status.toString(),
    detail,
  };

  if (scimType) {
    error.scimType = scimType as any;
  }

  return c.json(error, status);
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
function parseQueryParams(c: any): ScimQueryParams {
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
// SCIM User Endpoints
// ============================================================================

/**
 * GET /scim/v2/Users - List users with filtering and pagination
 * PII/Non-PII DB分離: Core DBでフィルタ、結果セットのPIIは別途取得
 */
app.get('/Users', async (c) => {
  try {
    const tenantId = getTenantIdFromContext(c);
    const params = parseQueryParams(c);
    const baseUrl = getBaseUrl(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Pagination defaults
    const startIndex = params.startIndex || 1; // SCIM uses 1-based indexing
    const count = Math.min(params.count || 100, 1000); // Max 1000 per page
    const offset = startIndex - 1;

    // Build SQL query for Core DB - tenant_id is always first for index usage
    // Note: For PII filters (email, name, etc.), we query PII DB first to get matching IDs
    let sql = `SELECT id, tenant_id, email_verified, phone_number_verified, password_hash,
               is_active, user_type, external_id, pii_partition, created_at, updated_at
               FROM users_core WHERE tenant_id = ?`;
    const sqlParams: any[] = [tenantId];

    // Apply filter if present
    // For SCIM filters referencing PII fields, we need to query PII DB first
    if (params.filter) {
      try {
        const filterAst = parseScimFilter(params.filter);

        // Check if filter references PII fields
        const piiFields = [
          'email',
          'name',
          'given_name',
          'family_name',
          'nickname',
          'preferred_username',
        ];
        const filterStr = params.filter.toLowerCase();
        const hasPiiFilter = piiFields.some((f) => filterStr.includes(f.toLowerCase()));

        if (hasPiiFilter && piiAdapter) {
          // Query PII DB first to get matching user IDs via Adapter
          const piiAttributeMap: Record<string, string> = {
            userName: 'preferred_username',
            'name.givenName': 'given_name',
            'name.familyName': 'family_name',
            'emails.value': 'email',
          };
          const { sql: whereSql, params: whereParams } = filterToSql(filterAst, piiAttributeMap);
          const piiSql = `SELECT id FROM users_pii WHERE tenant_id = ? AND ${whereSql}`;
          const piiResults = await piiAdapter.query<{ id: string }>(piiSql, [
            tenantId,
            ...whereParams,
          ]);
          const matchingIds = piiResults.map((r) => r.id);

          if (matchingIds.length === 0) {
            // No matches found - return empty result
            const response: ScimListResponse<ScimUser> = {
              schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
              totalResults: 0,
              startIndex,
              itemsPerPage: 0,
              Resources: [],
            };
            return c.json(response);
          }

          // Filter Core DB by matching IDs
          const placeholders = matchingIds.map(() => '?').join(',');
          sql += ` AND id IN (${placeholders})`;
          sqlParams.push(...matchingIds);
        } else {
          // Non-PII filter - apply directly to Core DB
          const coreAttributeMap: Record<string, string> = {
            active: 'is_active',
            externalId: 'external_id',
          };
          const { sql: whereSql, params: whereParams } = filterToSql(filterAst, coreAttributeMap);
          sql += ` AND ${whereSql}`;
          sqlParams.push(...whereParams);
        }
      } catch (error) {
        return scimError(
          c,
          400,
          `Invalid filter: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'invalidFilter'
        );
      }
    }

    // Get total count via Adapter
    const countQuery = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*) as total FROM');
    const totalResult = await coreAdapter.queryOne<{ total: number }>(countQuery, sqlParams);
    const totalResults = totalResult?.total || 0;

    // Apply sorting with whitelist validation (prevents SQL injection)
    // Note: Sorting by PII fields requires fetching PII first - not supported in DB-separated mode
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
      // Map Core columns (some may need adjustment for users_core schema)
      const coreSortColumn = sortColumn === 'active' ? 'is_active' : sortColumn;
      const sortDirection = params.sortOrder === 'descending' ? 'DESC' : 'ASC';
      sql += ` ORDER BY ${coreSortColumn} ${sortDirection}`;
    } else {
      sql += ' ORDER BY created_at DESC';
    }

    // Apply pagination
    sql += ` LIMIT ? OFFSET ?`;
    sqlParams.push(count, offset);

    // Execute query against Core DB via Adapter
    const coreResults = await coreAdapter.query(sql, sqlParams);

    // Fetch PII data and merge into InternalUser format
    const users = await fetchUsersWithPII(piiAdapter, coreResults);

    // Convert to SCIM format
    const scimUsers = users.map((user) => userToScim(user, { baseUrl, includeGroups: false }));

    const response: ScimListResponse<ScimUser> = {
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults,
      startIndex,
      itemsPerPage: scimUsers.length,
      Resources: scimUsers,
    };

    return c.json(response);
  } catch (error) {
    console.error('SCIM list users error:', error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * GET /scim/v2/Users/{id} - Get user by ID
 * PII/Non-PII DB分離: 両DBから取得してマージ
 */
app.get('/Users/:id', async (c) => {
  try {
    const userId = c.req.param('id');
    const baseUrl = getBaseUrl(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Fetch user from both Core and PII DBs via Adapter
    const user = await fetchUserWithPII(coreAdapter, piiAdapter, userId);

    if (!user) {
      return scimError(c, 404, `User ${userId} not found`);
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
    console.error('SCIM get user error:', error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * POST /scim/v2/Users - Create new user
 * PII/Non-PII DB分離: CoreとPII両方に挿入
 */
app.post('/Users', async (c) => {
  try {
    const scimUser = await c.req.json<Partial<ScimUser>>();
    const baseUrl = getBaseUrl(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Validate required fields
    const validation = validateScimUser(scimUser);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Check for duplicate userName or email in PII DB via Adapter
    const tenantId = getTenantIdFromContext(c);
    const primaryEmail =
      scimUser.emails?.find((e) => e.primary)?.value || scimUser.emails?.[0]?.value;

    if (primaryEmail && piiAdapter) {
      const existing = await piiAdapter.queryOne<{ id: string }>(
        'SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?',
        [tenantId, primaryEmail]
      );

      if (existing) {
        return scimError(c, 409, 'User with this email already exists', 'uniqueness');
      }
    }

    // Convert SCIM user to internal format
    const internalUser = scimToUser(scimUser);

    // Generate ID
    const userId = generateId();

    // Hash password if provided
    if (scimUser.password) {
      internalUser.password_hash = await hashPassword(scimUser.password);
    }

    // Set timestamps
    const now = new Date().toISOString();
    const nowUnix = Math.floor(Date.now() / 1000);
    internalUser.created_at = now;
    internalUser.updated_at = now;

    // Set defaults
    if (!internalUser.email_verified) internalUser.email_verified = 0;
    if (internalUser.active === undefined) internalUser.active = 1;

    // Parse address JSON if provided
    let addressParts: any = {};
    if (internalUser.address_json) {
      try {
        addressParts = JSON.parse(internalUser.address_json);
      } catch {
        // Ignore parse errors
      }
    }

    // Step 1: Insert into users_core with pii_status='pending' via Adapter
    await coreAdapter.execute(
      `INSERT INTO users_core (
        id, tenant_id, email_verified, phone_number_verified, password_hash,
        is_active, user_type, external_id, pii_partition, pii_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'end_user', ?, 'default', 'pending', ?, ?)`,
      [
        userId,
        tenantId,
        internalUser.email_verified,
        0, // phone_number_verified
        internalUser.password_hash,
        internalUser.active,
        internalUser.external_id,
        nowUnix,
        nowUnix,
      ]
    );

    // Step 2: Insert into users_pii (if PII adapter is configured) via Adapter
    if (piiAdapter) {
      await piiAdapter.execute(
        `INSERT INTO users_pii (
          id, tenant_id, email, name, given_name, family_name, middle_name,
          nickname, preferred_username, profile, picture, website, gender,
          birthdate, zoneinfo, locale, phone_number,
          address_formatted, address_street_address, address_locality,
          address_region, address_postal_code, address_country,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          tenantId,
          internalUser.email,
          internalUser.name,
          internalUser.given_name,
          internalUser.family_name,
          internalUser.middle_name,
          internalUser.nickname,
          internalUser.preferred_username,
          internalUser.profile,
          internalUser.picture,
          internalUser.website,
          null, // gender
          null, // birthdate
          internalUser.zoneinfo,
          internalUser.locale,
          internalUser.phone_number,
          addressParts.formatted || null,
          addressParts.street_address || null,
          addressParts.locality || null,
          addressParts.region || null,
          addressParts.postal_code || null,
          addressParts.country || null,
          nowUnix,
          nowUnix,
        ]
      );

      // Step 3: Update pii_status to 'active' via Adapter
      await coreAdapter.execute('UPDATE users_core SET pii_status = ? WHERE id = ?', [
        'active',
        userId,
      ]);
    }

    // Fetch created user from both DBs via Adapter
    const createdUser = await fetchUserWithPII(coreAdapter, piiAdapter, userId);

    if (!createdUser) {
      return scimError(c, 500, 'Failed to create user');
    }

    const responseUser = userToScim(createdUser, { baseUrl, includeGroups: false });

    // Set Location header
    c.header('Location', responseUser.meta.location);

    return c.json(responseUser, 201);
  } catch (error) {
    console.error('SCIM create user error:', error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * PUT /scim/v2/Users/{id} - Replace user (full update)
 * PII/Non-PII DB分離: CoreとPII両方を更新
 */
app.put('/Users/:id', async (c) => {
  try {
    const userId = c.req.param('id');
    const scimUser = await c.req.json<Partial<ScimUser>>();
    const baseUrl = getBaseUrl(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Validate required fields
    const validation = validateScimUser(scimUser);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Check if user exists - fetch from both DBs
    const existingUser = await fetchUserWithPII(coreAdapter, piiAdapter, userId);

    if (!existingUser) {
      return scimError(c, 404, `User ${userId} not found`);
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
    const nowUnix = Math.floor(Date.now() / 1000);
    internalUser.updated_at = new Date().toISOString();

    // Hash password if changed
    if (scimUser.password) {
      internalUser.password_hash = await hashPassword(scimUser.password);
    }

    // Parse address JSON if provided
    let addressParts: any = {};
    if (internalUser.address_json) {
      try {
        addressParts = JSON.parse(internalUser.address_json);
      } catch {
        // Ignore parse errors
      }
    }

    // Update Core DB (non-PII fields)
    await coreAdapter.execute(
      `UPDATE users_core SET
        is_active = ?, external_id = ?, updated_at = ?,
        password_hash = COALESCE(?, password_hash)
       WHERE id = ?`,
      [internalUser.active, internalUser.external_id, nowUnix, internalUser.password_hash, userId]
    );

    // Update PII DB (PII fields)
    if (piiAdapter) {
      await piiAdapter.execute(
        `UPDATE users_pii SET
          email = ?, name = ?, given_name = ?, family_name = ?, middle_name = ?,
          nickname = ?, preferred_username = ?, profile = ?, picture = ?, website = ?,
          zoneinfo = ?, locale = ?, phone_number = ?,
          address_formatted = ?, address_street_address = ?, address_locality = ?,
          address_region = ?, address_postal_code = ?, address_country = ?,
          updated_at = ?
         WHERE id = ?`,
        [
          internalUser.email,
          internalUser.name,
          internalUser.given_name,
          internalUser.family_name,
          internalUser.middle_name,
          internalUser.nickname,
          internalUser.preferred_username,
          internalUser.profile,
          internalUser.picture,
          internalUser.website,
          internalUser.zoneinfo,
          internalUser.locale,
          internalUser.phone_number,
          addressParts.formatted || null,
          addressParts.street_address || null,
          addressParts.locality || null,
          addressParts.region || null,
          addressParts.postal_code || null,
          addressParts.country || null,
          nowUnix,
          userId,
        ]
      );
    }

    // Invalidate user cache (cache invalidation hook)
    await invalidateUserCache(c.env, userId);

    // Fetch updated user from both DBs
    const updatedUser = await fetchUserWithPII(coreAdapter, piiAdapter, userId);

    if (!updatedUser) {
      return scimError(c, 500, 'Failed to fetch updated user');
    }

    const responseUser = userToScim(updatedUser, { baseUrl, includeGroups: false });

    // Set ETag header
    c.header('ETag', responseUser.meta.version || '');

    return c.json(responseUser);
  } catch (error) {
    console.error('SCIM replace user error:', error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * PATCH /scim/v2/Users/{id} - Update user (partial update)
 * PII/Non-PII DB分離: CoreとPII両方を更新
 */
app.patch('/Users/:id', async (c) => {
  try {
    const userId = c.req.param('id');
    const patchOp = await c.req.json<ScimPatchOp>();
    const baseUrl = getBaseUrl(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Check if user exists - fetch from both DBs
    const existingUser = await fetchUserWithPII(coreAdapter, piiAdapter, userId);

    if (!existingUser) {
      return scimError(c, 404, `User ${userId} not found`);
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

    // Apply patch operations
    scimUser = applyPatchOperations(scimUser, patchOp.Operations);

    // Validate after patching
    const validation = validateScimUser(scimUser);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Convert back to internal format
    const internalUser = scimToUser(scimUser);
    internalUser.updated_at = new Date().toISOString();

    // Hash password if changed
    if (scimUser.password) {
      internalUser.password_hash = await hashPassword(scimUser.password);
    }

    const nowUnix = Math.floor(Date.now() / 1000);

    // Parse address JSON if provided
    let addressParts: any = {};
    if (internalUser.address_json) {
      try {
        addressParts = JSON.parse(internalUser.address_json);
      } catch {
        // Ignore parse errors
      }
    }

    // Update Core DB (non-PII fields)
    await coreAdapter.execute(
      `UPDATE users_core SET
        is_active = ?, external_id = ?, updated_at = ?,
        password_hash = COALESCE(?, password_hash)
       WHERE id = ?`,
      [internalUser.active, internalUser.external_id, nowUnix, internalUser.password_hash, userId]
    );

    // Update PII DB (PII fields)
    if (piiAdapter) {
      await piiAdapter.execute(
        `UPDATE users_pii SET
          email = ?, name = ?, given_name = ?, family_name = ?, middle_name = ?,
          nickname = ?, preferred_username = ?, profile = ?, picture = ?, website = ?,
          zoneinfo = ?, locale = ?, phone_number = ?,
          address_formatted = ?, address_street_address = ?, address_locality = ?,
          address_region = ?, address_postal_code = ?, address_country = ?,
          updated_at = ?
         WHERE id = ?`,
        [
          internalUser.email,
          internalUser.name,
          internalUser.given_name,
          internalUser.family_name,
          internalUser.middle_name,
          internalUser.nickname,
          internalUser.preferred_username,
          internalUser.profile,
          internalUser.picture,
          internalUser.website,
          internalUser.zoneinfo,
          internalUser.locale,
          internalUser.phone_number,
          addressParts.formatted || null,
          addressParts.street_address || null,
          addressParts.locality || null,
          addressParts.region || null,
          addressParts.postal_code || null,
          addressParts.country || null,
          nowUnix,
          userId,
        ]
      );
    }

    // Invalidate user cache (cache invalidation hook)
    await invalidateUserCache(c.env, userId);

    // Fetch updated user from both DBs
    const updatedUser = await fetchUserWithPII(coreAdapter, piiAdapter, userId);

    if (!updatedUser) {
      return scimError(c, 500, 'Failed to fetch updated user');
    }

    const responseUser = userToScim(updatedUser, { baseUrl, includeGroups: false });

    // Set ETag header
    c.header('ETag', responseUser.meta.version || '');

    return c.json(responseUser);
  } catch (error) {
    console.error('SCIM patch user error:', error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * DELETE /scim/v2/Users/{id} - Delete user
 * PII/Non-PII DB分離: Soft delete in Core, hard delete in PII
 */
app.delete('/Users/:id', async (c) => {
  try {
    const userId = c.req.param('id');
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Check if user exists - fetch from both DBs
    const existingUser = await fetchUserWithPII(coreAdapter, piiAdapter, userId);

    if (!existingUser) {
      return scimError(c, 404, `User ${userId} not found`);
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
            (existingUser as any).tenant_id || 'default',
            now,
            now + retentionDays * 24 * 60 * 60 * 1000,
          ]
        )
        .catch(() => {
          // Ignore tombstone creation errors - not critical
        });

      // Step 2: Hard delete from PII DB
      await piiAdapter.execute('DELETE FROM users_pii WHERE id = ?', [userId]);
    }

    // Step 3: Soft delete in Core DB (set is_active = 0 and pii_status = 'deleted')
    await coreAdapter.execute(
      `UPDATE users_core SET is_active = 0, pii_status = 'deleted', updated_at = ? WHERE id = ?`,
      [Math.floor(now / 1000), userId]
    );

    return c.body(null, 204); // No Content
  } catch (error) {
    console.error('SCIM delete user error:', error);
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
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    const startIndex = params.startIndex || 1;
    const count = Math.min(params.count || 100, 1000);
    const offset = startIndex - 1;

    let sql = 'SELECT * FROM roles';
    const sqlParams: any[] = [];

    // Apply filter if present
    if (params.filter) {
      try {
        const filterAst = parseScimFilter(params.filter);
        const attributeMap: Record<string, string> = {
          displayName: 'name',
          externalId: 'external_id',
        };
        const { sql: whereSql, params: whereParams } = filterToSql(filterAst, attributeMap);
        sql += ` WHERE ${whereSql}`;
        sqlParams.push(...whereParams);
      } catch (error) {
        return scimError(
          c,
          400,
          `Invalid filter: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'invalidFilter'
        );
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
      // Fetch members if needed (PII/Non-PII DB分離対応)
      const members = await fetchGroupMembersWithPII(coreAdapter, piiAdapter, group.id as string);

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
    console.error('SCIM list groups error:', error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * GET /scim/v2/Groups/{id} - Get group by ID
 */
app.get('/Groups/:id', async (c) => {
  try {
    const groupId = c.req.param('id');
    const baseUrl = getBaseUrl(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    const group = await coreAdapter.queryOne<InternalGroup>('SELECT * FROM roles WHERE id = ?', [
      groupId,
    ]);

    if (!group) {
      return scimError(c, 404, `Group ${groupId} not found`);
    }

    // Check ETag
    const ifNoneMatch = c.req.header('If-None-Match');
    if (ifNoneMatch) {
      const currentEtag = generateEtag(group);
      if (ifNoneMatch === currentEtag) {
        return c.body(null, 304);
      }
    }

    // Fetch members (PII/Non-PII DB分離対応)
    const members = await fetchGroupMembersWithPII(coreAdapter, piiAdapter, groupId);

    const scimGroup = groupToScim(group, { baseUrl, includeMembers: true }, members);

    // Set ETag header
    c.header('ETag', scimGroup.meta.version || '');

    return c.json(scimGroup);
  } catch (error) {
    console.error('SCIM get group error:', error);
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
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Validate required fields
    const validation = validateScimGroup(scimGroup);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Check for duplicate displayName
    const existing = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM roles WHERE name = ?',
      [scimGroup.displayName]
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

    // Insert group
    await coreAdapter.execute(
      `INSERT INTO roles (id, name, description, permissions_json, external_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        groupId,
        internalGroup.name,
        internalGroup.description || null,
        JSON.stringify([]), // Empty permissions by default
        internalGroup.external_id,
        now,
      ]
    );

    // Add members if specified
    if (scimGroup.members && scimGroup.members.length > 0) {
      for (const member of scimGroup.members) {
        await coreAdapter.execute(
          `INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)`,
          [member.value, groupId, now]
        );
      }
    }

    // Fetch created group
    const createdGroup = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ?',
      [groupId]
    );

    if (!createdGroup) {
      return scimError(c, 500, 'Failed to create group');
    }

    // Fetch members (PII/Non-PII DB分離対応)
    const members = await fetchGroupMembersWithPII(coreAdapter, piiAdapter, groupId);

    const responseGroup = groupToScim(createdGroup, { baseUrl, includeMembers: true }, members);

    // Set Location header
    c.header('Location', responseGroup.meta.location);

    return c.json(responseGroup, 201);
  } catch (error) {
    console.error('SCIM create group error:', error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * PUT /scim/v2/Groups/{id} - Replace group
 */
app.put('/Groups/:id', async (c) => {
  try {
    const groupId = c.req.param('id');
    const scimGroup = await c.req.json<Partial<ScimGroup>>();
    const baseUrl = getBaseUrl(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Validate required fields
    const validation = validateScimGroup(scimGroup);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Check if group exists
    const existingGroup = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ?',
      [groupId]
    );

    if (!existingGroup) {
      return scimError(c, 404, `Group ${groupId} not found`);
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
      `UPDATE roles SET name = ?, description = ?, external_id = ? WHERE id = ?`,
      [internalGroup.name, internalGroup.description, internalGroup.external_id, groupId]
    );

    // Update members (replace all)
    await coreAdapter.execute('DELETE FROM user_roles WHERE role_id = ?', [groupId]);

    if (scimGroup.members && scimGroup.members.length > 0) {
      const now = new Date().toISOString();
      for (const member of scimGroup.members) {
        await coreAdapter.execute(
          `INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)`,
          [member.value, groupId, now]
        );
      }
    }

    // Fetch updated group
    const updatedGroup = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ?',
      [groupId]
    );

    if (!updatedGroup) {
      return scimError(c, 500, 'Failed to fetch updated group');
    }

    // Fetch members (PII/Non-PII DB分離対応)
    const members = await fetchGroupMembersWithPII(coreAdapter, piiAdapter, groupId);

    const responseGroup = groupToScim(updatedGroup, { baseUrl, includeMembers: true }, members);

    // Set ETag header
    c.header('ETag', responseGroup.meta.version || '');

    return c.json(responseGroup);
  } catch (error) {
    console.error('SCIM replace group error:', error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * PATCH /scim/v2/Groups/{id} - Update group (partial update)
 */
app.patch('/Groups/:id', async (c) => {
  try {
    const groupId = c.req.param('id');
    const patchOp = await c.req.json<ScimPatchOp>();
    const baseUrl = getBaseUrl(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Check if group exists
    const existingGroup = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ?',
      [groupId]
    );

    if (!existingGroup) {
      return scimError(c, 404, `Group ${groupId} not found`);
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

    // Fetch current members (PII/Non-PII DB分離対応)
    const currentMembers = await fetchGroupMembersWithPII(coreAdapter, piiAdapter, groupId);

    // Convert to SCIM format
    let scimGroup = groupToScim(existingGroup, { baseUrl, includeMembers: true }, currentMembers);

    // Apply patch operations
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
      `UPDATE roles SET name = ?, description = ?, external_id = ? WHERE id = ?`,
      [internalGroup.name, internalGroup.description, internalGroup.external_id, groupId]
    );

    // Update members if changed
    if (scimGroup.members !== undefined) {
      await coreAdapter.execute('DELETE FROM user_roles WHERE role_id = ?', [groupId]);

      if (scimGroup.members.length > 0) {
        const now = new Date().toISOString();
        for (const member of scimGroup.members) {
          await coreAdapter.execute(
            `INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)`,
            [member.value, groupId, now]
          );
        }
      }
    }

    // Fetch updated group
    const updatedGroup = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ?',
      [groupId]
    );

    if (!updatedGroup) {
      return scimError(c, 500, 'Failed to fetch updated group');
    }

    // Fetch updated members (PII/Non-PII DB分離対応)
    const updatedMembers = await fetchGroupMembersWithPII(coreAdapter, piiAdapter, groupId);

    const responseGroup = groupToScim(
      updatedGroup,
      { baseUrl, includeMembers: true },
      updatedMembers
    );

    // Set ETag header
    c.header('ETag', responseGroup.meta.version || '');

    return c.json(responseGroup);
  } catch (error) {
    console.error('SCIM patch group error:', error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * DELETE /scim/v2/Groups/{id} - Delete group
 */
app.delete('/Groups/:id', async (c) => {
  try {
    const groupId = c.req.param('id');
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    // Check if group exists
    const existingGroup = await coreAdapter.queryOne<InternalGroup>(
      'SELECT * FROM roles WHERE id = ?',
      [groupId]
    );

    if (!existingGroup) {
      return scimError(c, 404, `Group ${groupId} not found`);
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
    await coreAdapter.execute('DELETE FROM roles WHERE id = ?', [groupId]);

    return c.body(null, 204); // No Content
  } catch (error) {
    console.error('SCIM delete group error:', error);
    return scimError(c, 500, 'Internal server error');
  }
});

export default app;
