/**
 * Admin API Endpoints
 * User management, client management, and statistics for administrative dashboard
 */

import { Context } from 'hono';
import type { Env } from '@enrai/shared';

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
        timestamp: user.created_at,
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

    return c.json({
      users: users.results,
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

    return c.json({
      user,
      passkeys: passkeys.results,
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

    return c.json({
      clients: clients.results,
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

    return c.json({
      client,
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
    const userId = c.req.query('user_id');
    const status = c.req.query('status'); // 'active' or 'expired'

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

    // Status filter
    if (status === 'active') {
      whereClauses.push('s.expires_at > ?');
      bindings.push(now);
    } else if (status === 'expired') {
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

    // Format sessions with metadata
    const formattedSessions = sessions.results.map((session: any) => ({
      id: session.id,
      userId: session.user_id,
      userEmail: session.email,
      userName: session.name,
      expiresAt: session.expires_at * 1000, // Convert to milliseconds
      createdAt: session.created_at * 1000,
      isActive: session.expires_at > now,
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
      sessionData = await sessionStoreResponse.json() as {
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
      const data = await sessionsResponse.json() as {
        sessions: Array<{ id: string }>;
      };

      // Invalidate all sessions in SessionStore
      await Promise.all(
        data.sessions.map(async (session) => {
          const deleteResponse = await sessionStore.fetch(
            new Request(`https://session-store/session/${session.id}`, {
              method: 'DELETE',
            })
          );
          if (deleteResponse.ok) {
            revokedCount++;
          }
        })
      );
    }

    // Delete all sessions from D1
    const deleteResult = await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?')
      .bind(userId)
      .run();

    const dbRevokedCount = deleteResult.meta.changes || 0;

    // TODO: Create Audit Log entry (Phase 6)
    console.log(`Admin revoked all sessions for user: ${userId} (${Math.max(revokedCount, dbRevokedCount)} sessions)`);

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
