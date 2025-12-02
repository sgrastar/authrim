/**
 * Admin API Endpoints
 * User management, client management, and statistics for administrative dashboard
 */

import { Context } from 'hono';
import type { Env } from '@authrim/shared';
import { invalidateUserCache } from '@authrim/shared';

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
 */
export async function adminStatsHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Count active users (logged in within last 30 days)
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const activeUsersResult = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM users WHERE last_login_at > ?'
    )
      .bind(thirtyDaysAgo)
      .first();

    // Count total users
    const totalUsersResult = await c.env.DB.prepare('SELECT COUNT(*) as count FROM users').first();

    // Count registered clients
    const totalClientsResult = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM oauth_clients'
    ).first();

    // Count users created today
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const newUsersTodayResult = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM users WHERE created_at >= ?'
    )
      .bind(todayStart)
      .first();

    // Count logins today
    const loginsTodayResult = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM users WHERE last_login_at >= ?'
    )
      .bind(todayStart)
      .first();

    // Get recent activity (last 10 user registrations)
    const recentUsers = await c.env.DB.prepare(
      'SELECT id, email, name, created_at FROM users ORDER BY created_at DESC LIMIT 10'
    ).all();

    return c.json({
      stats: {
        activeUsers: activeUsersResult?.count || 0,
        totalUsers: totalUsersResult?.count || 0,
        registeredClients: totalClientsResult?.count || 0,
        newUsersToday: newUsersTodayResult?.count || 0,
        loginsToday: loginsTodayResult?.count || 0,
      },
      recentActivity: recentUsers.results.map((user: any) => ({
        type: 'user_registration',
        userId: user.id,
        email: user.email,
        name: user.name,
        timestamp: toMilliseconds(user.created_at),
      })),
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
 */
export async function adminUsersListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const search = c.req.query('search') || '';
    const verified = c.req.query('verified'); // 'true', 'false', or undefined

    const offset = (page - 1) * limit;

    // Build query
    let query = 'SELECT * FROM users';
    let countQuery = 'SELECT COUNT(*) as count FROM users';
    const bindings: any[] = [];
    const whereClauses: string[] = [];

    // Search filter
    if (search) {
      whereClauses.push('(email LIKE ? OR name LIKE ?)');
      bindings.push(`%${search}%`, `%${search}%`);
    }

    // Verified filter
    if (verified !== undefined) {
      whereClauses.push('email_verified = ?');
      bindings.push(verified === 'true' ? 1 : 0);
    }

    // Apply WHERE clauses
    if (whereClauses.length > 0) {
      const whereClause = ' WHERE ' + whereClauses.join(' AND ');
      query += whereClause;
      countQuery += whereClause;
    }

    // Order and pagination
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    bindings.push(limit, offset);

    // Execute queries
    const countBindings = bindings.slice(0, bindings.length - 2);
    const totalResult = await c.env.DB.prepare(countQuery)
      .bind(...countBindings)
      .first();

    const users = await c.env.DB.prepare(query)
      .bind(...bindings)
      .all();

    const total = (totalResult?.count as number) || 0;
    const totalPages = Math.ceil(total / limit);

    // Format users with millisecond timestamps and boolean conversions
    const formattedUsers = users.results.map((user: any) => ({
      ...user,
      email_verified: Boolean(user.email_verified),
      phone_number_verified: Boolean(user.phone_number_verified),
      created_at: toMilliseconds(user.created_at),
      updated_at: toMilliseconds(user.updated_at),
      last_login_at: toMilliseconds(user.last_login_at),
    }));

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
 */
export async function adminUserGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // Get user's passkeys
    const passkeys = await c.env.DB.prepare(
      'SELECT id, credential_id, device_name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at DESC'
    )
      .bind(userId)
      .all();

    // Get user's custom fields
    const customFields = await c.env.DB.prepare(
      'SELECT field_name, field_value, field_type FROM user_custom_fields WHERE user_id = ?'
    )
      .bind(userId)
      .all();

    // Format user with explicit boolean conversions and millisecond timestamps
    const formattedUser = {
      ...user,
      email_verified: Boolean(user.email_verified),
      phone_number_verified: Boolean(user.phone_number_verified),
      created_at: toMilliseconds(user.created_at as number),
      updated_at: toMilliseconds(user.updated_at as number),
      last_login_at: toMilliseconds(user.last_login_at as number | null),
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
 */
export async function adminUserCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      email: string;
      name?: string;
      email_verified?: boolean;
      phone_number?: string;
      phone_number_verified?: boolean;
      [key: string]: any;
    }>();

    const { email, name, email_verified, phone_number, phone_number_verified, ...otherFields } =
      body;

    if (!email) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Email is required',
        },
        400
      );
    }

    // Check if user already exists
    const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
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

    const userId = crypto.randomUUID();
    const now = Date.now();

    // Insert user
    await c.env.DB.prepare(
      `INSERT INTO users (
        id, email, name, email_verified, phone_number, phone_number_verified,
        created_at, updated_at, custom_attributes_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        userId,
        email,
        name || null,
        email_verified ? 1 : 0,
        phone_number || null,
        phone_number_verified ? 1 : 0,
        now,
        now,
        Object.keys(otherFields).length > 0 ? JSON.stringify(otherFields) : null
      )
      .run();

    // Get created user
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();

    return c.json(
      {
        user,
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
 */
export async function adminUserUpdateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');
    const body = await c.req.json<{
      name?: string;
      email_verified?: boolean;
      phone_number?: string;
      phone_number_verified?: boolean;
      picture?: string;
      [key: string]: any;
    }>();

    // Check if user exists
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    const now = Date.now();
    const updates: string[] = [];
    const bindings: any[] = [];

    // Build update query
    if (body.name !== undefined) {
      updates.push('name = ?');
      bindings.push(body.name);
    }
    if (body.email_verified !== undefined) {
      updates.push('email_verified = ?');
      bindings.push(body.email_verified ? 1 : 0);
    }
    if (body.phone_number !== undefined) {
      updates.push('phone_number = ?');
      bindings.push(body.phone_number);
    }
    if (body.phone_number_verified !== undefined) {
      updates.push('phone_number_verified = ?');
      bindings.push(body.phone_number_verified ? 1 : 0);
    }
    if (body.picture !== undefined) {
      updates.push('picture = ?');
      bindings.push(body.picture);
    }

    // Always update updated_at
    updates.push('updated_at = ?');
    bindings.push(now);

    if (updates.length === 1) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'No fields to update',
        },
        400
      );
    }

    // Execute update
    bindings.push(userId);
    await c.env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...bindings)
      .run();

    // Invalidate user cache (cache invalidation hook)
    await invalidateUserCache(c.env, userId);

    // Get updated user
    const updatedUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first();

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
 */
export async function adminUserDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');

    // Check if user exists
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // Delete user (cascades to passkeys and custom_fields due to foreign key constraints)
    await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

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
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const search = c.req.query('search') || '';

    const offset = (page - 1) * limit;

    // Build query
    let query = 'SELECT * FROM oauth_clients';
    let countQuery = 'SELECT COUNT(*) as count FROM oauth_clients';
    const bindings: any[] = [];

    // Search filter
    if (search) {
      const whereClause = ' WHERE client_name LIKE ? OR client_id LIKE ?';
      query += whereClause;
      countQuery += whereClause;
      bindings.push(`%${search}%`, `%${search}%`);
    }

    // Order and pagination
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    bindings.push(limit, offset);

    // Execute queries
    const countBindings = bindings.slice(0, search ? 2 : 0);
    const totalResult = await c.env.DB.prepare(countQuery)
      .bind(...countBindings)
      .first();

    const clients = await c.env.DB.prepare(query)
      .bind(...bindings)
      .all();

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
 */
export async function adminUserAvatarUploadHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');

    // Check if user exists
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
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

    // Update user's picture field
    const now = Date.now();
    await c.env.DB.prepare('UPDATE users SET picture = ?, updated_at = ? WHERE id = ?')
      .bind(avatarUrl, now, userId)
      .run();

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
 */
export async function adminUserAvatarDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');

    // Check if user exists
    const user = await c.env.DB.prepare('SELECT id, picture FROM users WHERE id = ?')
      .bind(userId)
      .first();

    if (!user) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // Check if user has an avatar
    if (!user.picture) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User does not have an avatar',
        },
        404
      );
    }

    // Extract file path from URL
    const pictureUrl = user.picture as string;
    const urlParts = pictureUrl.split('/');
    const filePath = urlParts.slice(-2).join('/'); // Get "avatars/filename.ext"

    // Delete from R2
    try {
      await c.env.AVATARS.delete(filePath);
    } catch (error) {
      console.error('R2 delete error:', error);
      // Continue even if R2 delete fails
    }

    // Update user's picture field to null
    const now = Date.now();
    await c.env.DB.prepare('UPDATE users SET picture = NULL, updated_at = ? WHERE id = ?')
      .bind(now, userId)
      .run();

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
 */
export async function adminSessionsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const userId = c.req.query('user_id') || c.req.query('userId');
    const status = c.req.query('status'); // 'active' or 'expired'
    const active = c.req.query('active'); // 'true' or 'false' (alternative to status)

    const offset = (page - 1) * limit;
    const now = Math.floor(Date.now() / 1000);

    // Build query
    let query = 'SELECT s.*, u.email, u.name FROM sessions s LEFT JOIN users u ON s.user_id = u.id';
    let countQuery = 'SELECT COUNT(*) as count FROM sessions s';
    const bindings: any[] = [];
    const whereClauses: string[] = [];

    // User filter
    if (userId) {
      whereClauses.push('s.user_id = ?');
      bindings.push(userId);
    }

    // Status filter (support both 'status' and 'active' params)
    if (status === 'active' || active === 'true') {
      whereClauses.push('s.expires_at > ?');
      bindings.push(now);
    } else if (status === 'expired' || active === 'false') {
      whereClauses.push('s.expires_at <= ?');
      bindings.push(now);
    }

    // Apply WHERE clauses
    if (whereClauses.length > 0) {
      const whereClause = ' WHERE ' + whereClauses.join(' AND ');
      query += whereClause;
      countQuery += whereClause;
    }

    // Order and pagination
    query += ' ORDER BY s.created_at DESC LIMIT ? OFFSET ?';
    bindings.push(limit, offset);

    // Execute queries
    const countBindings = bindings.slice(0, bindings.length - 2);
    const totalResult = await c.env.DB.prepare(countQuery)
      .bind(...countBindings)
      .first();

    const sessions = await c.env.DB.prepare(query)
      .bind(...bindings)
      .all();

    const total = (totalResult?.count as number) || 0;
    const totalPages = Math.ceil(total / limit);

    // Format sessions with metadata (snake_case for UI compatibility)
    const formattedSessions = sessions.results.map((session: any) => ({
      id: session.id,
      user_id: session.user_id,
      user_email: session.email,
      user_name: session.name,
      created_at: new Date(session.created_at * 1000).toISOString(),
      last_accessed_at: session.last_accessed_at
        ? new Date(session.last_accessed_at * 1000).toISOString()
        : new Date(session.created_at * 1000).toISOString(),
      expires_at: new Date(session.expires_at * 1000).toISOString(),
      ip_address: session.ip_address || null,
      user_agent: session.user_agent || null,
      is_active: session.expires_at > now,
    }));

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

    // Try to get from SessionStore first (hot data)
    const sessionStoreId = c.env.SESSION_STORE.idFromName('global');
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    const sessionStoreResponse = await sessionStore.fetch(
      new Request(`https://session-store/session/${sessionId}`, {
        method: 'GET',
      })
    );

    let sessionData;
    let isActive = false;

    if (sessionStoreResponse.ok) {
      sessionData = (await sessionStoreResponse.json()) as {
        id: string;
        userId: string;
        expiresAt: number;
        createdAt: number;
      };
      isActive = sessionData.expiresAt > Date.now();
    }

    // Get from D1 for additional metadata
    const session = await c.env.DB.prepare(
      'SELECT s.*, u.email, u.name FROM sessions s LEFT JOIN users u ON s.user_id = u.id WHERE s.id = ?'
    )
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

    // Merge data from both sources
    const result = {
      id: sessionId,
      userId: sessionData?.userId || session?.user_id,
      userEmail: session?.email,
      userName: session?.name,
      expiresAt: sessionData?.expiresAt || (session?.expires_at as number) * 1000,
      createdAt: sessionData?.createdAt || (session?.created_at as number) * 1000,
      isActive: isActive || (session?.expires_at as number) > Math.floor(Date.now() / 1000),
      source: sessionStoreResponse.ok ? 'memory' : 'database',
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

    // Invalidate session in SessionStore DO
    const sessionStoreId = c.env.SESSION_STORE.idFromName('global');
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    const deleteResponse = await sessionStore.fetch(
      new Request(`https://session-store/session/${sessionId}`, {
        method: 'DELETE',
      })
    );

    if (!deleteResponse.ok) {
      console.warn(`Failed to delete session ${sessionId} from SessionStore`);
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
 */
export async function adminUserRevokeAllSessionsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id');

    // Check if user exists
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!user) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // Get all sessions for user from SessionStore DO
    const sessionStoreId = c.env.SESSION_STORE.idFromName('global');
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    const sessionsResponse = await sessionStore.fetch(
      new Request(`https://session-store/sessions/user/${userId}`, {
        method: 'GET',
      })
    );

    let revokedCount = 0;

    if (sessionsResponse.ok) {
      const data = (await sessionsResponse.json()) as {
        sessions: Array<{ id: string }>;
      };

      // Invalidate all sessions in SessionStore using batch API
      // This avoids N+1 DO calls and improves performance
      if (data.sessions.length > 0) {
        const sessionIds = data.sessions.map((s) => s.id);
        const batchDeleteResponse = await sessionStore.fetch(
          new Request('https://session-store/sessions/batch-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionIds }),
          })
        );

        if (batchDeleteResponse.ok) {
          const result = (await batchDeleteResponse.json()) as { deleted: number };
          revokedCount = result.deleted;
        }
      }
    }

    // Delete all sessions from D1
    const deleteResult = await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?')
      .bind(userId)
      .run();

    const dbRevokedCount = deleteResult.meta.changes || 0;

    // TODO: Create Audit Log entry (Phase 6)
    console.log(
      `Admin revoked all sessions for user: ${userId} (${Math.max(revokedCount, dbRevokedCount)} sessions)`
    );

    return c.json({
      success: true,
      message: 'All user sessions revoked successfully',
      userId: userId,
      revokedCount: Math.max(revokedCount, dbRevokedCount),
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

    // Build WHERE clause
    const conditions: string[] = [];
    const params: any[] = [];

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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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

    // Get user information if user_id exists
    let user = null;
    if (entry.user_id) {
      const userResult = await env.DB.prepare(
        'SELECT id, email, name, picture FROM users WHERE id = ?'
      )
        .bind(entry.user_id)
        .first();

      if (userResult) {
        user = {
          id: userResult.id,
          email: userResult.email,
          name: userResult.name,
          picture: userResult.picture,
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
    };

    // Merge with stored settings if they exist
    const settings = settingsJson
      ? { ...defaultSettings, ...JSON.parse(settingsJson) }
      : defaultSettings;

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
    // Get the active key from KeyManager DO
    // Use 'default-v3' to match the existing KeyManager instance used throughout the system
    const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
    const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

    const response = await keyManager.fetch(
      new Request('https://key-manager/internal/active-with-private', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${c.env.KEY_MANAGER_SECRET}`,
        },
      })
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Failed to get signing key:', error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to get signing key',
        },
        500
      );
    }

    const keyData = (await response.json()) as {
      kid: string;
      privatePEM: string;
      publicJWK: object;
    };

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
 * Register a refresh token family for load testing
 * POST /api/admin/tokens/register
 *
 * Registers a pre-generated refresh token with the RefreshTokenRotator DO.
 * This allows load testing scripts to generate tokens locally and register
 * them with the token rotation system.
 *
 * IMPORTANT: The token's jti (JWT ID) is extracted and used as the currentToken
 * in RefreshTokenRotator, matching how op-token handles tokens. This ensures
 * that token rotation works correctly when the token is later refreshed.
 *
 * Request body:
 * {
 *   "token": "eyJ...", // JWT refresh token
 *   "userId": "user-123",
 *   "clientId": "client-456",
 *   "scope": "openid profile email",
 *   "ttl": 2592000 // optional, seconds (default: 30 days)
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

    // Get RefreshTokenRotator DO (uses clientId, matching op-token pattern)
    const rotatorId = c.env.REFRESH_TOKEN_ROTATOR.idFromName(clientId);
    const rotator = c.env.REFRESH_TOKEN_ROTATOR.get(rotatorId);

    // Create token family using jti as the currentToken
    // This matches how op-token registers tokens: it uses jti for lookup
    const response = await rotator.fetch(
      new Request('https://refresh-token-rotator/family', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: jti, // Use jti instead of full JWT
          userId,
          clientId,
          scope,
          ttl,
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

    const result = (await response.json()) as {
      familyId: string;
      expiresAt: number;
    };

    return c.json(
      {
        success: true,
        familyId: result.familyId,
        expiresAt: result.expiresAt,
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

    // Verify user exists
    const user = await c.env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?')
      .bind(user_id)
      .first();

    if (!user) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User not found',
        },
        404
      );
    }

    // Create session in SessionStore DO
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + ttl_seconds * 1000;

    const sessionStoreId = c.env.SESSION_STORE.idFromName('global');
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    const sessionResponse = await sessionStore.fetch(
      new Request('https://session-store/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user_id,
          ttl: ttl_seconds * 1000,
          data: {
            amr: ['admin_api'],
            email: user.email,
            name: user.name,
          },
        }),
      })
    );

    if (!sessionResponse.ok) {
      const errorText = await sessionResponse.text();
      console.error('Failed to create session:', errorText);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to create session',
        },
        500
      );
    }

    const session = (await sessionResponse.json()) as { id: string; expiresAt: number };

    // Also insert into D1 sessions table for consistency
    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
    )
      .bind(session.id, user_id, Math.floor(expiresAt / 1000), Math.floor(now / 1000))
      .run();

    console.log(`[ADMIN] Created test session for user: ${user_id}, session: ${session.id}`);

    return c.json(
      {
        session_id: session.id,
        user_id: user_id,
        expires_at: expiresAt,
        cookie_value: `authrim_session=${session.id}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${ttl_seconds}`,
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
