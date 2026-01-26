import type { Context } from 'hono';
import {
  getRefreshTokenShardConfig,
  saveRefreshTokenShardConfig,
  createNewGeneration,
  parseRefreshTokenJti,
  buildRefreshTokenRotatorInstanceName,
  clearShardConfigCache,
  getTenantIdFromContext,
  createAuthContextFromHono,
  getLogger,
  type RefreshTokenShardConfig,
  type Env,
} from '@authrim/ar-lib-core';

/**
 * GET /api/admin/settings/refresh-token-sharding
 * Get current refresh token sharding configuration
 */
export async function getRefreshTokenShardingConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('RefreshTokenShardingAPI');
  const clientId = c.req.query('clientId') || null;

  try {
    // Get from KV (with cache)
    const config = await getRefreshTokenShardConfig(c.env, clientId || '__global__');

    return c.json({
      clientId: clientId || '__global__',
      config,
    });
  } catch (error) {
    log.error('Failed to get refresh token sharding config', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get configuration',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/refresh-token-sharding
 * Update refresh token sharding configuration (creates new generation)
 *
 * IMPORTANT: AuthCode and RefreshToken MUST have identical shard counts.
 * This is enforced at the API level to prevent data inconsistency.
 *
 * @param skip_sync_check - Set to true when updating both values together (e.g., from Scale UI)
 */
export async function updateRefreshTokenShardingConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('RefreshTokenShardingAPI');
  try {
    const body = (await c.req.json()) as {
      clientId?: string;
      shardCount: number;
      notes?: string;
      skip_sync_check?: boolean;
    };

    // Validation
    if (typeof body.shardCount !== 'number' || body.shardCount <= 0 || body.shardCount > 256) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid shard count: must be between 1 and 256',
        },
        400
      );
    }

    const clientId = body.clientId || null;

    // AuthCode/RefreshToken sync validation (only for global config)
    // Skip if explicitly requested (used when updating both values together from Scale UI)
    if (!body.skip_sync_check && !clientId) {
      const kvValue = await c.env.AUTHRIM_CONFIG?.get('code_shards');
      const envValue = c.env.AUTHRIM_CODE_SHARDS;
      const codeShards = parseInt(kvValue || envValue || '4', 10);

      if (codeShards !== body.shardCount) {
        return c.json(
          {
            error: 'validation_failed',
            error_description:
              `AuthCode and RefreshToken must have identical shard counts. ` +
              `Current AuthCode: ${codeShards}, Requested RefreshToken: ${body.shardCount}`,
            hint: 'Update both values together or use the Scale sliders',
            current_code_shards: codeShards,
            requested_refresh_token_shards: body.shardCount,
          },
          400
        );
      }
    }

    // Get current config
    const currentConfig = await getRefreshTokenShardConfig(c.env, clientId || '__global__');

    // Check if shard count is actually changing
    if (currentConfig.currentShardCount === body.shardCount) {
      return c.json({
        success: true,
        message: 'No change: shard count is already set to this value',
        config: currentConfig,
      });
    }

    // Get admin user info from context (if available)
    const adminUser = (c as any).get?.('adminUser') || 'admin';

    // Create new generation
    const newConfig = createNewGeneration(currentConfig, body.shardCount, adminUser);

    // Save to KV
    await saveRefreshTokenShardConfig(c.env, clientId, newConfig);

    // Record in D1 for audit via Adapter
    if (c.env.DB) {
      const tenantId = getTenantIdFromContext(c);
      const authCtx = createAuthContextFromHono(c, tenantId);

      await authCtx.coreAdapter.execute(
        `INSERT INTO refresh_token_shard_configs
         (id, tenant_id, client_id, generation, shard_count, activated_at, created_by, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `rtsc_${crypto.randomUUID()}`,
          'default',
          clientId,
          newConfig.currentGeneration,
          newConfig.currentShardCount,
          Date.now(),
          adminUser,
          body.notes || null,
        ]
      );

      // Mark previous generation as deprecated
      if (currentConfig.currentGeneration > 0) {
        await authCtx.coreAdapter.execute(
          `UPDATE refresh_token_shard_configs
           SET deprecated_at = ?
           WHERE tenant_id = ? AND client_id = ? AND generation = ? AND deprecated_at IS NULL`,
          [Date.now(), 'default', clientId, currentConfig.currentGeneration]
        );
      }
    }

    // Clear local cache
    clearShardConfigCache();

    return c.json({
      success: true,
      message: `Shard count updated from ${currentConfig.currentShardCount} to ${body.shardCount}. New generation: ${newConfig.currentGeneration}`,
      config: newConfig,
    });
  } catch (error) {
    log.error('Failed to update refresh token sharding config', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update configuration',
      },
      500
    );
  }
}

/**
 * GET /api/admin/settings/refresh-token-sharding/stats
 * Get shard distribution statistics
 */
export async function getRefreshTokenShardingStats(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('RefreshTokenShardingAPI');
  const clientId = c.req.query('clientId') || null;

  try {
    if (!c.env.DB) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Database not available',
        },
        500
      );
    }

    // Get token family distribution by generation via Adapter
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const now = Date.now();

    const stats = await authCtx.coreAdapter.query<{
      generation: number;
      total: number;
      active: number;
      revoked: number;
      expired: number;
    }>(
      `SELECT
         generation,
         COUNT(*) as total,
         SUM(CASE WHEN is_revoked = 0 AND expires_at > ? THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN is_revoked = 1 THEN 1 ELSE 0 END) as revoked,
         SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) as expired
       FROM user_token_families
       WHERE (? IS NULL OR client_id = ?)
       GROUP BY generation
       ORDER BY generation DESC`,
      [now, now, clientId, clientId]
    );

    // Get shard config
    const config = await getRefreshTokenShardConfig(c.env, clientId || '__global__');

    return c.json({
      clientId: clientId || '__global__',
      config,
      stats,
    });
  } catch (error) {
    log.error('Failed to get refresh token sharding stats', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get statistics',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/refresh-token-sharding/cleanup
 * Cleanup a deprecated generation (delete D1 records)
 */
export async function cleanupRefreshTokenGeneration(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('RefreshTokenShardingAPI');
  try {
    const tenantId = getTenantIdFromContext(c);
    const generation = parseInt(c.req.query('generation') || '', 10);
    const clientId = c.req.query('clientId') || null;

    if (isNaN(generation) || generation < 0) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid generation number',
        },
        400
      );
    }

    if (!c.env.DB) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Database not available',
        },
        500
      );
    }

    // Create AuthContext for database operations
    const authCtx = createAuthContextFromHono(c, tenantId);
    const now = Date.now();

    // Safety check: ensure no active tokens exist for this generation via Adapter
    const params = clientId ? [tenantId, generation, now, clientId] : [tenantId, generation, now];
    const activeResult = await authCtx.coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM user_token_families
       WHERE tenant_id = ? AND generation = ? AND is_revoked = 0 AND expires_at > ?
       ${clientId ? 'AND client_id = ?' : ''}`,
      params
    );

    if (activeResult && activeResult.count > 0) {
      return c.json(
        {
          error: 'cleanup_blocked',
          error_description: `Cannot cleanup generation ${generation}: ${activeResult.count} active tokens exist`,
          active_count: activeResult.count,
        },
        400
      );
    }

    // Get current config to prevent cleanup of current generation
    const config = await getRefreshTokenShardConfig(c.env, clientId || '__global__');
    if (generation === config.currentGeneration) {
      return c.json(
        {
          error: 'cleanup_blocked',
          error_description: 'Cannot cleanup current generation',
        },
        400
      );
    }

    // Delete D1 records via Adapter
    const deleteParams = clientId ? [generation, clientId] : [generation];
    const deleteResult = await authCtx.coreAdapter.execute(
      `DELETE FROM user_token_families
       WHERE generation = ?
       ${clientId ? 'AND client_id = ?' : ''}`,
      deleteParams
    );

    const deletedCount = deleteResult.rowsAffected || 0;

    // Remove from shard config's previousGenerations
    const updatedConfig: RefreshTokenShardConfig = {
      ...config,
      previousGenerations: config.previousGenerations.filter((g) => g.generation !== generation),
      updatedAt: Date.now(),
    };
    await saveRefreshTokenShardConfig(c.env, clientId, updatedConfig);

    // Clear cache
    clearShardConfigCache();

    return c.json({
      success: true,
      message: `Generation ${generation} cleaned up`,
      deleted_records: deletedCount,
      note: 'DO storage will be garbage collected by Cloudflare automatically',
    });
  } catch (error) {
    log.error('Failed to cleanup refresh token generation', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to cleanup generation',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/users/:userId/refresh-tokens
 * Revoke all refresh tokens for a user
 */
export async function revokeAllUserRefreshTokens(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('RefreshTokenShardingAPI');
  try {
    const userId = c.req.param('userId');
    const clientId = c.req.query('clientId') || null;

    if (!userId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing userId',
        },
        400
      );
    }

    if (!c.env.DB) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Database not available',
        },
        500
      );
    }

    // Get all token families for this user via Adapter
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const params = clientId ? [userId, clientId] : [userId];
    const families = await authCtx.coreAdapter.query<{
      jti: string;
      client_id: string;
      generation: number;
    }>(
      `SELECT jti, client_id, generation FROM user_token_families
       WHERE user_id = ? AND is_revoked = 0
       ${clientId ? 'AND client_id = ?' : ''}`,
      params
    );

    if (families.length === 0) {
      return c.json({
        success: true,
        message: 'No active refresh tokens found for user',
        revoked: 0,
      });
    }

    // Group by shard for parallel revocation
    const shardGroups = new Map<string, { clientId: string; jtis: string[] }>();

    for (const family of families) {
      const parsed = parseRefreshTokenJti(family.jti);
      const instanceName = buildRefreshTokenRotatorInstanceName(
        family.client_id,
        parsed.generation,
        parsed.shardIndex
      );

      if (!shardGroups.has(instanceName)) {
        shardGroups.set(instanceName, { clientId: family.client_id, jtis: [] });
      }
      shardGroups.get(instanceName)!.jtis.push(family.jti);
    }

    // Revoke in parallel
    const revokePromises = Array.from(shardGroups.entries()).map(
      async ([instanceName, { jtis }]) => {
        const rotatorId = c.env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
        const rotator = c.env.REFRESH_TOKEN_ROTATOR.get(rotatorId);

        const response = await rotator.fetch(
          new Request('http://internal/batch-revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jtis, reason: 'user_wide_revocation' }),
          })
        );

        return response.ok;
      }
    );

    await Promise.all(revokePromises);

    // Update D1 via Adapter
    const updateParams = clientId ? [userId, clientId] : [userId];
    await authCtx.coreAdapter.execute(
      `UPDATE user_token_families
       SET is_revoked = 1
       WHERE user_id = ?
       ${clientId ? 'AND client_id = ?' : ''}`,
      updateParams
    );

    return c.json({
      success: true,
      message: `Revoked all refresh tokens for user ${userId}`,
      revoked: families.length,
    });
  } catch (error) {
    log.error('Failed to revoke user refresh tokens', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to revoke tokens',
      },
      500
    );
  }
}
