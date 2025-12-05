import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import {
  getRefreshTokenShardConfig,
  saveRefreshTokenShardConfig,
  createNewGeneration,
  parseRefreshTokenJti,
  buildRefreshTokenRotatorInstanceName,
  clearShardConfigCache,
  type RefreshTokenShardConfig,
} from '@authrim/shared';

/**
 * GET /api/admin/settings/refresh-token-sharding
 * Get current refresh token sharding configuration
 */
export async function getRefreshTokenShardingConfig(c: Context<{ Bindings: Env }>) {
  const clientId = c.req.query('clientId') || null;

  try {
    // Get from KV (with cache)
    const config = await getRefreshTokenShardConfig(c.env, clientId || '__global__');

    return c.json({
      clientId: clientId || '__global__',
      config,
    });
  } catch (error) {
    console.error('Failed to get refresh token sharding config:', error);
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
 */
export async function updateRefreshTokenShardingConfig(c: Context<{ Bindings: Env }>) {
  try {
    const body = (await c.req.json()) as {
      clientId?: string;
      shardCount: number;
      notes?: string;
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

    // Record in D1 for audit
    if (c.env.DB) {
      await c.env.DB.prepare(
        `INSERT INTO refresh_token_shard_configs
         (id, tenant_id, client_id, generation, shard_count, activated_at, created_by, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          `rtsc_${crypto.randomUUID()}`,
          'default',
          clientId,
          newConfig.currentGeneration,
          newConfig.currentShardCount,
          Date.now(),
          adminUser,
          body.notes || null
        )
        .run();

      // Mark previous generation as deprecated
      if (currentConfig.currentGeneration > 0) {
        await c.env.DB.prepare(
          `UPDATE refresh_token_shard_configs
           SET deprecated_at = ?
           WHERE tenant_id = ? AND client_id = ? AND generation = ? AND deprecated_at IS NULL`
        )
          .bind(Date.now(), 'default', clientId, currentConfig.currentGeneration)
          .run();
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
    console.error('Failed to update refresh token sharding config:', error);
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

    // Get token family distribution by generation
    const statsResult = await c.env.DB.prepare(
      `SELECT
         generation,
         COUNT(*) as total,
         SUM(CASE WHEN is_revoked = 0 AND expires_at > ? THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN is_revoked = 1 THEN 1 ELSE 0 END) as revoked,
         SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) as expired
       FROM user_token_families
       WHERE (? IS NULL OR client_id = ?)
       GROUP BY generation
       ORDER BY generation DESC`
    )
      .bind(Date.now(), Date.now(), clientId, clientId)
      .all();

    // Get shard config
    const config = await getRefreshTokenShardConfig(c.env, clientId || '__global__');

    return c.json({
      clientId: clientId || '__global__',
      config,
      stats: statsResult.results,
    });
  } catch (error) {
    console.error('Failed to get refresh token sharding stats:', error);
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
  try {
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

    // Safety check: ensure no active tokens exist for this generation
    const activeResult = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM user_token_families
       WHERE generation = ? AND is_revoked = 0 AND expires_at > ?
       ${clientId ? 'AND client_id = ?' : ''}`
    )
      .bind(generation, Date.now(), ...(clientId ? [clientId] : []))
      .first<{ count: number }>();

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

    // Delete D1 records
    const deleteResult = await c.env.DB.prepare(
      `DELETE FROM user_token_families
       WHERE generation = ?
       ${clientId ? 'AND client_id = ?' : ''}`
    )
      .bind(generation, ...(clientId ? [clientId] : []))
      .run();

    const deletedCount = deleteResult.meta?.changes || 0;

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
    console.error('Failed to cleanup refresh token generation:', error);
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

    // Get all token families for this user
    const familiesResult = await c.env.DB.prepare(
      `SELECT jti, client_id, generation FROM user_token_families
       WHERE user_id = ? AND is_revoked = 0
       ${clientId ? 'AND client_id = ?' : ''}`
    )
      .bind(userId, ...(clientId ? [clientId] : []))
      .all<{ jti: string; client_id: string; generation: number }>();

    if (!familiesResult.results || familiesResult.results.length === 0) {
      return c.json({
        success: true,
        message: 'No active refresh tokens found for user',
        revoked: 0,
      });
    }

    // Group by shard for parallel revocation
    const shardGroups = new Map<string, { clientId: string; jtis: string[] }>();

    for (const family of familiesResult.results) {
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

    // Update D1
    await c.env.DB.prepare(
      `UPDATE user_token_families
       SET is_revoked = 1
       WHERE user_id = ?
       ${clientId ? 'AND client_id = ?' : ''}`
    )
      .bind(userId, ...(clientId ? [clientId] : []))
      .run();

    return c.json({
      success: true,
      message: `Revoked all refresh tokens for user ${userId}`,
      revoked: familiesResult.results.length,
    });
  } catch (error) {
    console.error('Failed to revoke user refresh tokens:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to revoke tokens',
      },
      500
    );
  }
}
