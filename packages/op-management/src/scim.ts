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

import { Hono } from 'hono';
import type { Env } from '@authrim/shared/types/env';
import {
  SCIM_SCHEMAS,
  type ScimUser,
  type ScimGroup,
  type ScimListResponse,
  type ScimError,
  type ScimPatchOp,
  type ScimQueryParams,
} from '@authrim/shared/types/scim';
import {
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
} from '@authrim/shared/utils/scim-mapper';
import { parseScimFilter, filterToSql } from '@authrim/shared/utils/scim-filter';
import { scimAuthMiddleware } from '@authrim/shared/middleware/scim-auth';
import { generateId } from '@authrim/shared/utils/id';
import { hashPassword } from '@authrim/shared/utils/crypto';

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
function scimError(
  c: any,
  status: number,
  detail: string,
  scimType?: string
): Response {
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
 */
app.get('/Users', async (c) => {
  try {
    const params = parseQueryParams(c);
    const baseUrl = getBaseUrl(c);

    // Pagination defaults
    const startIndex = params.startIndex || 1; // SCIM uses 1-based indexing
    const count = Math.min(params.count || 100, 1000); // Max 1000 per page
    const offset = startIndex - 1;

    // Build SQL query
    let sql = 'SELECT * FROM users';
    const sqlParams: any[] = [];

    // Apply filter if present
    if (params.filter) {
      try {
        const filterAst = parseScimFilter(params.filter);

        // Map SCIM attributes to database columns
        const attributeMap: Record<string, string> = {
          userName: 'preferred_username',
          'name.givenName': 'given_name',
          'name.familyName': 'family_name',
          'emails.value': 'email',
          active: 'active',
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
    const totalResult = await c.env.DB.prepare(countQuery)
      .bind(...sqlParams)
      .first<{ total: number }>();
    const totalResults = totalResult?.total || 0;

    // Apply sorting
    if (params.sortBy) {
      const sortColumn = params.sortBy === 'userName' ? 'preferred_username' : params.sortBy;
      const sortDirection = params.sortOrder === 'descending' ? 'DESC' : 'ASC';
      sql += ` ORDER BY ${sortColumn} ${sortDirection}`;
    } else {
      sql += ' ORDER BY created_at DESC';
    }

    // Apply pagination
    sql += ` LIMIT ? OFFSET ?`;
    sqlParams.push(count, offset);

    // Execute query
    const result = await c.env.DB.prepare(sql).bind(...sqlParams).all<InternalUser>();

    // Convert to SCIM format
    const scimUsers = result.results.map((user) =>
      userToScim(user, { baseUrl, includeGroups: false })
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
    console.error('SCIM list users error:', error);
    return scimError(c, 500, 'Internal server error');
  }
});

/**
 * GET /scim/v2/Users/{id} - Get user by ID
 */
app.get('/Users/:id', async (c) => {
  try {
    const userId = c.req.param('id');
    const baseUrl = getBaseUrl(c);

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<InternalUser>();

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
 */
app.post('/Users', async (c) => {
  try {
    const scimUser = await c.req.json<Partial<ScimUser>>();
    const baseUrl = getBaseUrl(c);

    // Validate required fields
    const validation = validateScimUser(scimUser);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Check for duplicate userName or email
    const primaryEmail =
      scimUser.emails?.find((e) => e.primary)?.value || scimUser.emails?.[0]?.value;

    if (primaryEmail) {
      const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
        .bind(primaryEmail)
        .first();

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
    internalUser.created_at = now;
    internalUser.updated_at = now;

    // Set defaults
    if (!internalUser.email_verified) internalUser.email_verified = 0;
    if (internalUser.active === undefined) internalUser.active = 1;

    // Insert user
    await c.env.DB.prepare(
      `INSERT INTO users (
        id, email, email_verified, name, given_name, family_name, middle_name,
        nickname, preferred_username, profile, picture, website, gender,
        birthdate, zoneinfo, locale, phone_number, phone_number_verified,
        address_json, password_hash, external_id, active, custom_attributes_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        userId,
        internalUser.email,
        internalUser.email_verified,
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
        null, // phone_number_verified
        internalUser.address_json,
        internalUser.password_hash,
        internalUser.external_id,
        internalUser.active,
        internalUser.custom_attributes_json,
        now,
        now
      )
      .run();

    // Fetch created user
    const createdUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<InternalUser>();

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
 */
app.put('/Users/:id', async (c) => {
  try {
    const userId = c.req.param('id');
    const scimUser = await c.req.json<Partial<ScimUser>>();
    const baseUrl = getBaseUrl(c);

    // Validate required fields
    const validation = validateScimUser(scimUser);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Check if user exists
    const existingUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<InternalUser>();

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

    // Update timestamp
    internalUser.updated_at = new Date().toISOString();

    // Hash password if changed
    if (scimUser.password) {
      internalUser.password_hash = await hashPassword(scimUser.password);
    }

    // Update user
    await c.env.DB.prepare(
      `UPDATE users SET
        email = ?, name = ?, given_name = ?, family_name = ?, middle_name = ?,
        nickname = ?, preferred_username = ?, profile = ?, zoneinfo = ?, locale = ?,
        phone_number = ?, address_json = ?, external_id = ?, active = ?,
        custom_attributes_json = ?, updated_at = ?, password_hash = COALESCE(?, password_hash)
       WHERE id = ?`
    )
      .bind(
        internalUser.email,
        internalUser.name,
        internalUser.given_name,
        internalUser.family_name,
        internalUser.middle_name,
        internalUser.nickname,
        internalUser.preferred_username,
        internalUser.profile,
        internalUser.zoneinfo,
        internalUser.locale,
        internalUser.phone_number,
        internalUser.address_json,
        internalUser.external_id,
        internalUser.active,
        internalUser.custom_attributes_json,
        internalUser.updated_at,
        internalUser.password_hash,
        userId
      )
      .run();

    // Fetch updated user
    const updatedUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<InternalUser>();

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
 */
app.patch('/Users/:id', async (c) => {
  try {
    const userId = c.req.param('id');
    const patchOp = await c.req.json<ScimPatchOp>();
    const baseUrl = getBaseUrl(c);

    // Check if user exists
    const existingUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<InternalUser>();

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

    // Update user
    await c.env.DB.prepare(
      `UPDATE users SET
        email = ?, name = ?, given_name = ?, family_name = ?, middle_name = ?,
        nickname = ?, preferred_username = ?, profile = ?, zoneinfo = ?, locale = ?,
        phone_number = ?, address_json = ?, external_id = ?, active = ?,
        custom_attributes_json = ?, updated_at = ?, password_hash = COALESCE(?, password_hash)
       WHERE id = ?`
    )
      .bind(
        internalUser.email,
        internalUser.name,
        internalUser.given_name,
        internalUser.family_name,
        internalUser.middle_name,
        internalUser.nickname,
        internalUser.preferred_username,
        internalUser.profile,
        internalUser.zoneinfo,
        internalUser.locale,
        internalUser.phone_number,
        internalUser.address_json,
        internalUser.external_id,
        internalUser.active,
        internalUser.custom_attributes_json,
        internalUser.updated_at,
        internalUser.password_hash,
        userId
      )
      .run();

    // Fetch updated user
    const updatedUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<InternalUser>();

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
 */
app.delete('/Users/:id', async (c) => {
  try {
    const userId = c.req.param('id');

    // Check if user exists
    const existingUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<InternalUser>();

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

    // Delete user (cascade will handle related records)
    await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

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
    const totalResult = await c.env.DB.prepare(countQuery)
      .bind(...sqlParams)
      .first<{ total: number }>();
    const totalResults = totalResult?.total || 0;

    // Apply sorting
    if (params.sortBy) {
      const sortColumn = params.sortBy === 'displayName' ? 'name' : params.sortBy;
      const sortDirection = params.sortOrder === 'descending' ? 'DESC' : 'ASC';
      sql += ` ORDER BY ${sortColumn} ${sortDirection}`;
    } else {
      sql += ' ORDER BY created_at DESC';
    }

    // Apply pagination
    sql += ` LIMIT ? OFFSET ?`;
    sqlParams.push(count, offset);

    // Execute query
    const result = await c.env.DB.prepare(sql).bind(...sqlParams).all<InternalGroup>();

    // Convert to SCIM format
    const scimGroups: ScimGroup[] = [];
    for (const group of result.results) {
      // Fetch members if needed
      const members = await c.env.DB.prepare(
        `SELECT ur.user_id, u.email
         FROM user_roles ur
         JOIN users u ON ur.user_id = u.id
         WHERE ur.role_id = ?`
      )
        .bind(group.id)
        .all<{ user_id: string; email: string }>();

      scimGroups.push(groupToScim(group, { baseUrl, includeMembers: true }, members.results));
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

    const group = await c.env.DB.prepare('SELECT * FROM roles WHERE id = ?')
      .bind(groupId)
      .first<InternalGroup>();

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

    // Fetch members
    const members = await c.env.DB.prepare(
      `SELECT ur.user_id, u.email
       FROM user_roles ur
       JOIN users u ON ur.user_id = u.id
       WHERE ur.role_id = ?`
    )
      .bind(groupId)
      .all<{ user_id: string; email: string }>();

    const scimGroup = groupToScim(group, { baseUrl, includeMembers: true }, members.results);

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

    // Validate required fields
    const validation = validateScimGroup(scimGroup);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Check for duplicate displayName
    const existing = await c.env.DB.prepare('SELECT id FROM roles WHERE name = ?')
      .bind(scimGroup.displayName)
      .first();

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
    await c.env.DB.prepare(
      `INSERT INTO roles (id, name, description, permissions_json, external_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        groupId,
        internalGroup.name,
        internalGroup.description || null,
        JSON.stringify([]), // Empty permissions by default
        internalGroup.external_id,
        now
      )
      .run();

    // Add members if specified
    if (scimGroup.members && scimGroup.members.length > 0) {
      for (const member of scimGroup.members) {
        await c.env.DB.prepare(
          `INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)`
        )
          .bind(member.value, groupId, now)
          .run();
      }
    }

    // Fetch created group
    const createdGroup = await c.env.DB.prepare('SELECT * FROM roles WHERE id = ?')
      .bind(groupId)
      .first<InternalGroup>();

    if (!createdGroup) {
      return scimError(c, 500, 'Failed to create group');
    }

    // Fetch members
    const members = await c.env.DB.prepare(
      `SELECT ur.user_id, u.email
       FROM user_roles ur
       JOIN users u ON ur.user_id = u.id
       WHERE ur.role_id = ?`
    )
      .bind(groupId)
      .all<{ user_id: string; email: string }>();

    const responseGroup = groupToScim(
      createdGroup,
      { baseUrl, includeMembers: true },
      members.results
    );

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

    // Validate required fields
    const validation = validateScimGroup(scimGroup);
    if (!validation.valid) {
      return scimError(c, 400, validation.errors.join(', '), 'invalidValue');
    }

    // Check if group exists
    const existingGroup = await c.env.DB.prepare('SELECT * FROM roles WHERE id = ?')
      .bind(groupId)
      .first<InternalGroup>();

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
    await c.env.DB.prepare(
      `UPDATE roles SET name = ?, description = ?, external_id = ? WHERE id = ?`
    )
      .bind(internalGroup.name, internalGroup.description, internalGroup.external_id, groupId)
      .run();

    // Update members (replace all)
    await c.env.DB.prepare('DELETE FROM user_roles WHERE role_id = ?').bind(groupId).run();

    if (scimGroup.members && scimGroup.members.length > 0) {
      const now = new Date().toISOString();
      for (const member of scimGroup.members) {
        await c.env.DB.prepare(
          `INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)`
        )
          .bind(member.value, groupId, now)
          .run();
      }
    }

    // Fetch updated group
    const updatedGroup = await c.env.DB.prepare('SELECT * FROM roles WHERE id = ?')
      .bind(groupId)
      .first<InternalGroup>();

    if (!updatedGroup) {
      return scimError(c, 500, 'Failed to fetch updated group');
    }

    // Fetch members
    const members = await c.env.DB.prepare(
      `SELECT ur.user_id, u.email
       FROM user_roles ur
       JOIN users u ON ur.user_id = u.id
       WHERE ur.role_id = ?`
    )
      .bind(groupId)
      .all<{ user_id: string; email: string }>();

    const responseGroup = groupToScim(
      updatedGroup,
      { baseUrl, includeMembers: true },
      members.results
    );

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

    // Check if group exists
    const existingGroup = await c.env.DB.prepare('SELECT * FROM roles WHERE id = ?')
      .bind(groupId)
      .first<InternalGroup>();

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

    // Fetch current members
    const currentMembers = await c.env.DB.prepare(
      `SELECT ur.user_id, u.email
       FROM user_roles ur
       JOIN users u ON ur.user_id = u.id
       WHERE ur.role_id = ?`
    )
      .bind(groupId)
      .all<{ user_id: string; email: string }>();

    // Convert to SCIM format
    let scimGroup = groupToScim(
      existingGroup,
      { baseUrl, includeMembers: true },
      currentMembers.results
    );

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
    await c.env.DB.prepare(
      `UPDATE roles SET name = ?, description = ?, external_id = ? WHERE id = ?`
    )
      .bind(internalGroup.name, internalGroup.description, internalGroup.external_id, groupId)
      .run();

    // Update members if changed
    if (scimGroup.members !== undefined) {
      await c.env.DB.prepare('DELETE FROM user_roles WHERE role_id = ?').bind(groupId).run();

      if (scimGroup.members.length > 0) {
        const now = new Date().toISOString();
        for (const member of scimGroup.members) {
          await c.env.DB.prepare(
            `INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)`
          )
            .bind(member.value, groupId, now)
            .run();
        }
      }
    }

    // Fetch updated group
    const updatedGroup = await c.env.DB.prepare('SELECT * FROM roles WHERE id = ?')
      .bind(groupId)
      .first<InternalGroup>();

    if (!updatedGroup) {
      return scimError(c, 500, 'Failed to fetch updated group');
    }

    // Fetch updated members
    const updatedMembers = await c.env.DB.prepare(
      `SELECT ur.user_id, u.email
       FROM user_roles ur
       JOIN users u ON ur.user_id = u.id
       WHERE ur.role_id = ?`
    )
      .bind(groupId)
      .all<{ user_id: string; email: string }>();

    const responseGroup = groupToScim(
      updatedGroup,
      { baseUrl, includeMembers: true },
      updatedMembers.results
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

    // Check if group exists
    const existingGroup = await c.env.DB.prepare('SELECT * FROM roles WHERE id = ?')
      .bind(groupId)
      .first<InternalGroup>();

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
    await c.env.DB.prepare('DELETE FROM roles WHERE id = ?').bind(groupId).run();

    return c.body(null, 204); // No Content
  } catch (error) {
    console.error('SCIM delete group error:', error);
    return scimError(c, 500, 'Internal server error');
  }
});

export default app;
