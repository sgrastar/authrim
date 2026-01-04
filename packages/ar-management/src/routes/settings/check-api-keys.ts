/**
 * Check API Key Management Admin API
 *
 * Phase 8.3: Real-time Check API Model
 *
 * Manage API keys for Check API authentication.
 *
 * Endpoints:
 * - POST   /api/admin/check-api-keys           - Create new API key
 * - GET    /api/admin/check-api-keys           - List API keys
 * - GET    /api/admin/check-api-keys/:id       - Get API key details
 * - DELETE /api/admin/check-api-keys/:id       - Delete (revoke) API key
 * - POST   /api/admin/check-api-keys/:id/rotate - Rotate API key
 */

import type { Context } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import {
  getLogger,
  type CheckApiKey,
  type CheckApiOperation,
  type RateLimitTier,
  type CreateCheckApiKeyRequest,
  type CreateCheckApiKeyResponse,
} from '@authrim/ar-lib-core';

// =============================================================================
// Types
// =============================================================================

interface ListCheckApiKeysResponse {
  keys: Omit<CheckApiKey, 'key_hash'>[];
  total: number;
  page: number;
  limit: number;
}

interface CheckApiKeyDetails extends Omit<CheckApiKey, 'key_hash'> {
  created_by_name?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Generate a cryptographically secure API key
 * Format: chk_<32 random bytes as hex>
 */
async function generateApiKey(): Promise<{ key: string; hash: string; prefix: string }> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);

  const hex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const key = `chk_${hex}`;
  const prefix = key.substring(0, 8); // chk_xxxx

  // Hash the key for storage
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return { key, hash, prefix };
}

/**
 * Get tenant ID from context
 */
function getTenantId(c: Context): string {
  // Try to get from auth context first, then fall back to default
  return (c.get('tenant_id') as string | undefined) ?? 'default';
}

/**
 * Get admin user ID from context
 */
function getAdminUserId(c: Context): string | undefined {
  return c.get('admin_user_id') as string | undefined;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /api/admin/check-api-keys
 * Create a new Check API key
 */
export async function createCheckApiKey(c: Context) {
  const log = getLogger(c).module('CheckAPIKeysAPI');
  const db = c.env?.DB as D1Database | undefined;
  if (!db) {
    return c.json(
      {
        error: 'not_configured',
        error_description: 'Database not configured',
      },
      503
    );
  }

  try {
    const body = await c.req.json<CreateCheckApiKeyRequest>();

    // Validate required fields
    if (!body.client_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'client_id is required',
        },
        400
      );
    }

    if (!body.name || body.name.trim() === '') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'name is required',
        },
        400
      );
    }

    // Validate allowed_operations if provided
    const validOperations: CheckApiOperation[] = ['check', 'batch', 'subscribe'];
    const allowedOperations = body.allowed_operations ?? ['check'];
    for (const op of allowedOperations) {
      if (!validOperations.includes(op)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid operation: ${op}. Valid operations: ${validOperations.join(', ')}`,
          },
          400
        );
      }
    }

    // Validate rate_limit_tier if provided
    const validTiers: RateLimitTier[] = ['strict', 'moderate', 'lenient'];
    const rateLimitTier = body.rate_limit_tier ?? 'moderate';
    if (!validTiers.includes(rateLimitTier)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `Invalid rate_limit_tier: ${rateLimitTier}. Valid tiers: ${validTiers.join(', ')}`,
        },
        400
      );
    }

    // Validate expires_at if provided
    if (body.expires_at !== undefined) {
      if (body.expires_at < Math.floor(Date.now() / 1000)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'expires_at must be in the future',
          },
          400
        );
      }
    }

    // Generate API key
    const { key, hash, prefix } = await generateApiKey();

    const tenantId = getTenantId(c);
    const adminUserId = getAdminUserId(c);
    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();

    // Insert into database
    await db
      .prepare(
        `INSERT INTO check_api_keys (
          id, tenant_id, client_id, name, key_hash, key_prefix,
          allowed_operations, rate_limit_tier, is_active, expires_at,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
      )
      .bind(
        id,
        tenantId,
        body.client_id,
        body.name.trim(),
        hash,
        prefix,
        JSON.stringify(allowedOperations),
        rateLimitTier,
        body.expires_at ?? null,
        adminUserId ?? null,
        now,
        now
      )
      .run();

    // Return response with plaintext key (only returned once)
    const response: CreateCheckApiKeyResponse = {
      id,
      api_key: key, // Only returned once at creation!
      key_prefix: prefix,
      name: body.name.trim(),
      client_id: body.client_id,
      allowed_operations: allowedOperations,
      rate_limit_tier: rateLimitTier,
      expires_at: body.expires_at,
      created_at: now,
    };

    log.info('Created API key', { keyPrefix: prefix, clientId: body.client_id });

    return c.json(response, 201);
  } catch (error) {
    log.error('Create error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create API key',
      },
      500
    );
  }
}

/**
 * GET /api/admin/check-api-keys
 * List Check API keys
 */
export async function listCheckApiKeys(c: Context) {
  const log = getLogger(c).module('CheckAPIKeysAPI');
  const db = c.env?.DB as D1Database | undefined;
  if (!db) {
    return c.json(
      {
        error: 'not_configured',
        error_description: 'Database not configured',
      },
      503
    );
  }

  try {
    const tenantId = getTenantId(c);

    // Parse pagination params
    const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)));
    const offset = (page - 1) * limit;

    // Optional filters
    const clientId = c.req.query('client_id');
    const isActive = c.req.query('is_active');

    // Build query
    let whereClause = 'WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (clientId) {
      whereClause += ' AND client_id = ?';
      params.push(clientId);
    }

    if (isActive !== undefined) {
      whereClause += ' AND is_active = ?';
      params.push(isActive === 'true' ? 1 : 0);
    }

    // Get total count
    const countResult = await db
      .prepare(`SELECT COUNT(*) as total FROM check_api_keys ${whereClause}`)
      .bind(...params)
      .first<{ total: number }>();

    const total = countResult?.total ?? 0;

    // Get keys (excluding key_hash for security)
    const keysResult = await db
      .prepare(
        `SELECT id, tenant_id, client_id, name, key_prefix,
                allowed_operations, rate_limit_tier, is_active, expires_at,
                created_by, created_at, updated_at
         FROM check_api_keys
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all<{
        id: string;
        tenant_id: string;
        client_id: string;
        name: string;
        key_prefix: string;
        allowed_operations: string;
        rate_limit_tier: string;
        is_active: number;
        expires_at: number | null;
        created_by: string | null;
        created_at: number;
        updated_at: number;
      }>();

    const keys = keysResult.results.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      client_id: row.client_id,
      name: row.name,
      key_prefix: row.key_prefix,
      allowed_operations: JSON.parse(row.allowed_operations) as CheckApiOperation[],
      rate_limit_tier: row.rate_limit_tier as RateLimitTier,
      is_active: row.is_active === 1,
      expires_at: row.expires_at ?? undefined,
      created_by: row.created_by ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    const response: ListCheckApiKeysResponse = {
      keys,
      total,
      page,
      limit,
    };

    return c.json(response);
  } catch (error) {
    log.error('List error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list API keys',
      },
      500
    );
  }
}

/**
 * GET /api/admin/check-api-keys/:id
 * Get Check API key details
 */
export async function getCheckApiKey(c: Context) {
  const log = getLogger(c).module('CheckAPIKeysAPI');
  const db = c.env?.DB as D1Database | undefined;
  if (!db) {
    return c.json(
      {
        error: 'not_configured',
        error_description: 'Database not configured',
      },
      503
    );
  }

  try {
    const id = c.req.param('id');
    const tenantId = getTenantId(c);

    const result = await db
      .prepare(
        `SELECT id, tenant_id, client_id, name, key_prefix,
                allowed_operations, rate_limit_tier, is_active, expires_at,
                created_by, created_at, updated_at
         FROM check_api_keys
         WHERE id = ? AND tenant_id = ?`
      )
      .bind(id, tenantId)
      .first<{
        id: string;
        tenant_id: string;
        client_id: string;
        name: string;
        key_prefix: string;
        allowed_operations: string;
        rate_limit_tier: string;
        is_active: number;
        expires_at: number | null;
        created_by: string | null;
        created_at: number;
        updated_at: number;
      }>();

    if (!result) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'API key not found',
        },
        404
      );
    }

    const keyDetails: CheckApiKeyDetails = {
      id: result.id,
      tenant_id: result.tenant_id,
      client_id: result.client_id,
      name: result.name,
      key_prefix: result.key_prefix,
      allowed_operations: JSON.parse(result.allowed_operations) as CheckApiOperation[],
      rate_limit_tier: result.rate_limit_tier as RateLimitTier,
      is_active: result.is_active === 1,
      expires_at: result.expires_at ?? undefined,
      created_by: result.created_by ?? undefined,
      created_at: result.created_at,
      updated_at: result.updated_at,
    };

    return c.json(keyDetails);
  } catch (error) {
    log.error('Get error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get API key',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/check-api-keys/:id
 * Delete (revoke) Check API key
 */
export async function deleteCheckApiKey(c: Context) {
  const log = getLogger(c).module('CheckAPIKeysAPI');
  const db = c.env?.DB as D1Database | undefined;
  if (!db) {
    return c.json(
      {
        error: 'not_configured',
        error_description: 'Database not configured',
      },
      503
    );
  }

  try {
    const id = c.req.param('id');
    const tenantId = getTenantId(c);

    // Soft delete by setting is_active = 0
    const result = await db
      .prepare(
        `UPDATE check_api_keys
         SET is_active = 0, updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      )
      .bind(Math.floor(Date.now() / 1000), id, tenantId)
      .run();

    if (result.meta?.changes === 0) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'API key not found',
        },
        404
      );
    }

    log.info('Revoked API key', { keyId: id });

    return c.json({ success: true, id });
  } catch (error) {
    log.error('Delete error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete API key',
      },
      500
    );
  }
}

/**
 * POST /api/admin/check-api-keys/:id/rotate
 * Rotate Check API key (generate new key, invalidate old one)
 */
export async function rotateCheckApiKey(c: Context) {
  const log = getLogger(c).module('CheckAPIKeysAPI');
  const db = c.env?.DB as D1Database | undefined;
  if (!db) {
    return c.json(
      {
        error: 'not_configured',
        error_description: 'Database not configured',
      },
      503
    );
  }

  try {
    const id = c.req.param('id');
    const tenantId = getTenantId(c);

    // First, get the existing key details
    const existing = await db
      .prepare(
        `SELECT id, client_id, name, allowed_operations, rate_limit_tier, expires_at
         FROM check_api_keys
         WHERE id = ? AND tenant_id = ? AND is_active = 1`
      )
      .bind(id, tenantId)
      .first<{
        id: string;
        client_id: string;
        name: string;
        allowed_operations: string;
        rate_limit_tier: string;
        expires_at: number | null;
      }>();

    if (!existing) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'API key not found or already inactive',
        },
        404
      );
    }

    // Generate new API key
    const { key, hash, prefix } = await generateApiKey();
    const now = Math.floor(Date.now() / 1000);
    const newId = crypto.randomUUID();

    // Create new key with same settings
    await db
      .prepare(
        `INSERT INTO check_api_keys (
          id, tenant_id, client_id, name, key_hash, key_prefix,
          allowed_operations, rate_limit_tier, is_active, expires_at,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
      )
      .bind(
        newId,
        tenantId,
        existing.client_id,
        `${existing.name} (rotated)`,
        hash,
        prefix,
        existing.allowed_operations,
        existing.rate_limit_tier,
        existing.expires_at,
        getAdminUserId(c) ?? null,
        now,
        now
      )
      .run();

    // Deactivate old key
    await db
      .prepare(
        `UPDATE check_api_keys
         SET is_active = 0, updated_at = ?
         WHERE id = ?`
      )
      .bind(now, id)
      .run();

    log.info('Rotated API key', { oldKeyId: id, newKeyId: newId });

    // Return new key (only returned once)
    const response: CreateCheckApiKeyResponse = {
      id: newId,
      api_key: key,
      key_prefix: prefix,
      name: `${existing.name} (rotated)`,
      client_id: existing.client_id,
      allowed_operations: JSON.parse(existing.allowed_operations) as CheckApiOperation[],
      rate_limit_tier: existing.rate_limit_tier as RateLimitTier,
      expires_at: existing.expires_at ?? undefined,
      created_at: now,
    };

    return c.json(response, 201);
  } catch (error) {
    log.error('Rotate error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to rotate API key',
      },
      500
    );
  }
}
