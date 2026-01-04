/**
 * AI Grants Admin API Endpoints
 *
 * Human Auth / AI Ephemeral Auth Two-Layer Model Implementation
 * Manages grants that authorize AI principals (agents, tools, services) to act
 * on behalf of users or systems.
 *
 * All endpoints require admin authentication with system_admin or distributor_admin role.
 * Rate limited with RateLimitProfiles.moderate.
 */

import { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  getTenantIdFromContext,
  D1Adapter,
  type DatabaseAdapter,
  escapeLikePattern,
  createAuditLog,
  createLogger,
} from '@authrim/ar-lib-core';

/**
 * Hono context type with admin auth variable
 */
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

// =============================================================================
// Types
// =============================================================================

interface AIGrant {
  id: string;
  tenant_id: string;
  client_id: string;
  ai_principal: string;
  scopes: string;
  scope_targets: string | null;
  is_active: number;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}

interface AIGrantCreateRequest {
  client_id: string;
  ai_principal: string;
  scopes: string;
  scope_targets?: Record<string, unknown>;
  expires_at?: number;
}

interface AIGrantUpdateRequest {
  scopes?: string;
  scope_targets?: Record<string, unknown> | null;
  expires_at?: number | null;
  is_active?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Security limits for AI Grant fields
 */
const AI_GRANT_LIMITS = {
  /** Maximum length for client_id field */
  MAX_CLIENT_ID_LENGTH: 256,
  /** Maximum length for ai_principal field */
  MAX_PRINCIPAL_LENGTH: 512,
  /** Maximum grant lifetime in seconds (1 year) */
  MAX_GRANT_LIFETIME_SECONDS: 365 * 24 * 60 * 60,
} as const;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get admin auth context from request
 */
function getAdminAuth(c: AdminContext): AdminAuthContext | null {
  return c.get('adminAuth') ?? null;
}

/**
 * Get tenant ID from admin context
 * Wrapper around getTenantIdFromContext to handle type compatibility
 */
function getAdminTenantId(c: AdminContext): string {
  // AdminContext is structurally compatible with Context<{ Bindings: Env }>
  return getTenantIdFromContext(c as unknown as Context<{ Bindings: Env }>);
}

/**
 * Create database adapter from context
 */
function createAdapterFromContext(c: Context<{ Bindings: Env }>): DatabaseAdapter {
  return new D1Adapter({ db: c.env.DB });
}

/**
 * Generate UUID v4
 */
function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Safely parse JSON with fallback
 * Prevents server errors from corrupted data in the database
 */
function safeJsonParse(jsonString: string | null, fallback: unknown = null): unknown {
  if (!jsonString) return fallback;
  try {
    return JSON.parse(jsonString);
  } catch {
    // JSON parsing failed, return fallback value
    return fallback;
  }
}

/**
 * Convert AI Grant row to API response format
 */
function formatGrant(grant: AIGrant) {
  return {
    id: grant.id,
    tenant_id: grant.tenant_id,
    client_id: grant.client_id,
    ai_principal: grant.ai_principal,
    scopes: grant.scopes,
    // Use safe JSON parsing to prevent crashes from corrupted data
    scope_targets: safeJsonParse(grant.scope_targets),
    is_active: grant.is_active === 1,
    expires_at: grant.expires_at,
    created_by: grant.created_by,
    created_at: grant.created_at,
    updated_at: grant.updated_at,
    revoked_at: grant.revoked_at,
    revoked_by: grant.revoked_by,
  };
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/ai-grants
 * List AI grants with pagination and filtering
 */
export async function adminAIGrantsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const page = parseInt(c.req.query('page') || '1');
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
    const clientId = c.req.query('client_id');
    const aiPrincipal = c.req.query('ai_principal');
    const isActive = c.req.query('is_active');

    const offset = (page - 1) * limit;

    // Build query
    const whereClauses: string[] = ['tenant_id = ?'];
    const bindings: unknown[] = [tenantId];

    if (clientId) {
      whereClauses.push('client_id = ?');
      bindings.push(clientId);
    }

    if (aiPrincipal) {
      const escapedPrincipal = escapeLikePattern(aiPrincipal);
      whereClauses.push("ai_principal LIKE ? ESCAPE '\\'");
      bindings.push(`%${escapedPrincipal}%`);
    }

    if (isActive !== undefined) {
      whereClauses.push('is_active = ?');
      bindings.push(isActive === 'true' ? 1 : 0);
    }

    const whereClause = whereClauses.join(' AND ');

    // Get total count
    const countResult = await adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM ai_grants WHERE ${whereClause}`,
      bindings
    );
    const total = countResult?.count || 0;

    // Get grants
    const grants = await adapter.query<AIGrant>(
      `SELECT * FROM ai_grants WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...bindings, limit, offset]
    );

    return c.json({
      grants: grants.map(formatGrant),
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    const log = createLogger().module('AI-GRANTS');
    log.error('Failed to list AI grants', {}, error as Error);
    return c.json({ error: 'Failed to list AI grants' }, 500);
  }
}

/**
 * GET /api/admin/ai-grants/:id
 * Get AI grant by ID
 */
export async function adminAIGrantGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const grantId = c.req.param('id');

    const grant = await adapter.queryOne<AIGrant>(
      'SELECT * FROM ai_grants WHERE id = ? AND tenant_id = ?',
      [grantId, tenantId]
    );

    if (!grant) {
      return c.json({ error: 'AI grant not found' }, 404);
    }

    return c.json({ grant: formatGrant(grant) });
  } catch (error) {
    const log = createLogger().module('AI-GRANTS');
    log.error('Failed to get AI grant', {}, error as Error);
    return c.json({ error: 'Failed to get AI grant' }, 500);
  }
}

/**
 * POST /api/admin/ai-grants
 * Create new AI grant
 *
 * Security features:
 * - Input length validation (prevents DoS via oversized strings)
 * - expires_at range validation (prevents infinite grants)
 * - INSERT ON CONFLICT for race condition protection (TOCTOU)
 */
export async function adminAIGrantCreateHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c as unknown as Context<{ Bindings: Env }>);
    const tenantId = getAdminTenantId(c);
    const adminAuth = getAdminAuth(c);
    const body = await c.req.json<AIGrantCreateRequest>();

    // Validate required fields
    if (!body.client_id || !body.ai_principal || !body.scopes) {
      return c.json({ error: 'Missing required fields: client_id, ai_principal, scopes' }, 400);
    }

    // Security: Validate field lengths to prevent DoS via oversized strings
    if (body.client_id.length > AI_GRANT_LIMITS.MAX_CLIENT_ID_LENGTH) {
      return c.json(
        {
          error: `client_id exceeds maximum length of ${AI_GRANT_LIMITS.MAX_CLIENT_ID_LENGTH} characters`,
        },
        400
      );
    }
    if (body.ai_principal.length > AI_GRANT_LIMITS.MAX_PRINCIPAL_LENGTH) {
      return c.json(
        {
          error: `ai_principal exceeds maximum length of ${AI_GRANT_LIMITS.MAX_PRINCIPAL_LENGTH} characters`,
        },
        400
      );
    }

    // Security: Validate expires_at range
    const now = Math.floor(Date.now() / 1000);
    if (body.expires_at !== undefined && body.expires_at !== null) {
      if (body.expires_at <= now) {
        return c.json({ error: 'expires_at must be in the future' }, 400);
      }
      if (body.expires_at > now + AI_GRANT_LIMITS.MAX_GRANT_LIFETIME_SECONDS) {
        return c.json({ error: 'expires_at exceeds maximum grant lifetime (1 year)' }, 400);
      }
    }

    // Validate scopes format (space-separated)
    const scopeList = body.scopes.split(' ').filter(Boolean);
    if (scopeList.length === 0) {
      return c.json({ error: 'At least one scope is required' }, 400);
    }

    // Validate AI scopes
    const validAIScopes = ['ai:read', 'ai:write', 'ai:execute', 'ai:admin'];
    const invalidScopes = scopeList.filter((s) => !validAIScopes.includes(s));
    if (invalidScopes.length > 0) {
      return c.json(
        {
          error: `Invalid scopes: ${invalidScopes.join(', ')}. Valid scopes: ${validAIScopes.join(', ')}`,
        },
        400
      );
    }

    const grantId = generateId();

    // Security: Use INSERT ON CONFLICT DO NOTHING to prevent TOCTOU race condition
    // This eliminates the gap between checking for existing grant and inserting
    // If a concurrent request inserts first, this will silently do nothing
    const insertResult = await adapter.execute(
      `INSERT INTO ai_grants (
        id, tenant_id, client_id, ai_principal, scopes, scope_targets,
        is_active, expires_at, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, client_id, ai_principal) DO NOTHING`,
      [
        grantId,
        tenantId,
        body.client_id,
        body.ai_principal,
        body.scopes,
        body.scope_targets ? JSON.stringify(body.scope_targets) : null,
        body.expires_at || null,
        adminAuth?.userId || null,
        now,
        now,
      ]
    );

    // Check if insert was successful (rowsAffected = 0 means conflict occurred)
    if (insertResult.rowsAffected === 0) {
      return c.json({ error: 'AI grant already exists for this client and principal' }, 409);
    }

    // Audit log
    await createAuditLog(c.env, {
      userId: adminAuth?.userId || 'unknown',
      action: 'ai_grant.create',
      resource: 'ai_grant',
      resourceId: grantId,
      ipAddress: c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '',
      userAgent: c.req.header('User-Agent') || '',
      metadata: JSON.stringify({
        client_id: body.client_id,
        ai_principal: body.ai_principal,
        scopes: body.scopes,
      }),
      severity: 'info',
    });

    // Fetch the created grant
    const grant = await adapter.queryOne<AIGrant>('SELECT * FROM ai_grants WHERE id = ?', [
      grantId,
    ]);

    return c.json({ grant: formatGrant(grant!) }, 201);
  } catch (error) {
    const log = createLogger().module('AI-GRANTS');
    log.error('Failed to create AI grant', {}, error as Error);
    return c.json({ error: 'Failed to create AI grant' }, 500);
  }
}

/**
 * PUT /api/admin/ai-grants/:id
 * Update AI grant
 *
 * Security features:
 * - expires_at range validation (prevents infinite grants)
 */
export async function adminAIGrantUpdateHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c as unknown as Context<{ Bindings: Env }>);
    const tenantId = getAdminTenantId(c);
    const adminAuth = getAdminAuth(c);
    const grantId = c.req.param('id');
    const body = await c.req.json<AIGrantUpdateRequest>();

    // Check if grant exists
    const existing = await adapter.queryOne<AIGrant>(
      'SELECT * FROM ai_grants WHERE id = ? AND tenant_id = ?',
      [grantId, tenantId]
    );

    if (!existing) {
      return c.json({ error: 'AI grant not found' }, 404);
    }

    // Build update query
    const updates: string[] = ['updated_at = ?'];
    const now = Math.floor(Date.now() / 1000);
    const bindings: unknown[] = [now];

    if (body.scopes !== undefined) {
      // Validate scopes
      const scopeList = body.scopes.split(' ').filter(Boolean);
      const validAIScopes = ['ai:read', 'ai:write', 'ai:execute', 'ai:admin'];
      const invalidScopes = scopeList.filter((s) => !validAIScopes.includes(s));
      if (invalidScopes.length > 0) {
        return c.json({ error: `Invalid scopes: ${invalidScopes.join(', ')}` }, 400);
      }
      updates.push('scopes = ?');
      bindings.push(body.scopes);
    }

    if (body.scope_targets !== undefined) {
      updates.push('scope_targets = ?');
      bindings.push(body.scope_targets ? JSON.stringify(body.scope_targets) : null);
    }

    if (body.expires_at !== undefined) {
      // Security: Validate expires_at range (null is allowed to remove expiration)
      if (body.expires_at !== null) {
        if (body.expires_at <= now) {
          return c.json({ error: 'expires_at must be in the future' }, 400);
        }
        if (body.expires_at > now + AI_GRANT_LIMITS.MAX_GRANT_LIFETIME_SECONDS) {
          return c.json({ error: 'expires_at exceeds maximum grant lifetime (1 year)' }, 400);
        }
      }
      updates.push('expires_at = ?');
      bindings.push(body.expires_at);
    }

    if (body.is_active !== undefined) {
      updates.push('is_active = ?');
      bindings.push(body.is_active ? 1 : 0);
    }

    bindings.push(grantId, tenantId);

    await adapter.execute(
      `UPDATE ai_grants SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`,
      bindings
    );

    // Audit log
    await createAuditLog(c.env, {
      userId: adminAuth?.userId || 'unknown',
      action: 'ai_grant.update',
      resource: 'ai_grant',
      resourceId: grantId,
      ipAddress: c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '',
      userAgent: c.req.header('User-Agent') || '',
      metadata: JSON.stringify(body),
      severity: 'info',
    });

    // Fetch updated grant
    const grant = await adapter.queryOne<AIGrant>('SELECT * FROM ai_grants WHERE id = ?', [
      grantId,
    ]);

    return c.json({ grant: formatGrant(grant!) });
  } catch (error) {
    const log = createLogger().module('AI-GRANTS');
    log.error('Failed to update AI grant', {}, error as Error);
    return c.json({ error: 'Failed to update AI grant' }, 500);
  }
}

/**
 * DELETE /api/admin/ai-grants/:id
 * Revoke AI grant (soft delete)
 */
export async function adminAIGrantRevokeHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c as unknown as Context<{ Bindings: Env }>);
    const tenantId = getAdminTenantId(c);
    const adminAuth = getAdminAuth(c);
    const grantId = c.req.param('id');

    // Check if grant exists
    const existing = await adapter.queryOne<AIGrant>(
      'SELECT * FROM ai_grants WHERE id = ? AND tenant_id = ?',
      [grantId, tenantId]
    );

    if (!existing) {
      return c.json({ error: 'AI grant not found' }, 404);
    }

    if (existing.revoked_at) {
      return c.json({ error: 'AI grant already revoked' }, 400);
    }

    const now = Math.floor(Date.now() / 1000);

    await adapter.execute(
      'UPDATE ai_grants SET is_active = 0, revoked_at = ?, revoked_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [now, adminAuth?.userId || null, now, grantId, tenantId]
    );

    // Audit log
    await createAuditLog(c.env, {
      userId: adminAuth?.userId || 'unknown',
      action: 'ai_grant.revoke',
      resource: 'ai_grant',
      resourceId: grantId,
      ipAddress: c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '',
      userAgent: c.req.header('User-Agent') || '',
      metadata: JSON.stringify({
        client_id: existing.client_id,
        ai_principal: existing.ai_principal,
      }),
      severity: 'warning',
    });

    return c.json({ message: 'AI grant revoked successfully' });
  } catch (error) {
    const log = createLogger().module('AI-GRANTS');
    log.error('Failed to revoke AI grant', {}, error as Error);
    return c.json({ error: 'Failed to revoke AI grant' }, 500);
  }
}
