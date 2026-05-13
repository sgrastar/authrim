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
  ensureOptionalDatabaseAdapter,
  type DatabaseSource,
  countActiveRefreshTokenFamiliesByGeneration,
  deleteRefreshTokenFamiliesByGeneration,
  getLogger,
  getRefreshTokenFamilyGenerationStats,
  listRefreshTokenFamiliesByUser,
  revokeRefreshTokenFamiliesByUser,
  type RefreshTokenShardConfig,
  type Env,
} from '@authrim/ar-lib-core';

function resolveOptionalCoreAdapter(c: Context<{ Bindings: Env }>) {
  const runtimeSources = (c as any).get?.('runtimeUserStoreSources') as
    | { coreDb?: DatabaseSource | null }
    | undefined;
  return ensureOptionalDatabaseAdapter(
    runtimeSources?.coreDb ?? c.env.DB ?? null,
    'refresh-token-sharding-config'
  );
}

/**
 * GET /api/admin/settings/refresh-token-sharding
 * Get current refresh token sharding configuration
 */
export async function getRefreshTokenShardingConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('RefreshTokenShardingAPI');
  const clientId = c.req.query('clientId') || null;
  const tenantId = getTenantIdFromContext(c);

  try {
    // Get from KV (with cache)
    const config = await getRefreshTokenShardConfig(c.env, clientId || '__global__', tenantId);

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
    const currentConfig = await getRefreshTokenShardConfig(
      c.env,
      clientId || '__global__',
      getTenantIdFromContext(c)
    );

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
    await saveRefreshTokenShardConfig(c.env, clientId, newConfig, getTenantIdFromContext(c));

    // Record in the resolved core adapter when relational bookkeeping is available.
    const coreAdapter = resolveOptionalCoreAdapter(c);
    if (coreAdapter) {
      const tenantId = getTenantIdFromContext(c);

      await coreAdapter.execute(
        `INSERT INTO refresh_token_shard_configs
         (id, tenant_id, client_id, generation, shard_count, activated_at, created_by, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `rtsc_${crypto.randomUUID()}`,
          tenantId,
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
        await coreAdapter.execute(
          `UPDATE refresh_token_shard_configs
           SET deprecated_at = ?
           WHERE tenant_id = ? AND client_id = ? AND generation = ? AND deprecated_at IS NULL`,
          [Date.now(), tenantId, clientId, currentConfig.currentGeneration]
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
    // Get token family distribution by generation via Adapter
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const now = Date.now();

    const stats = await getRefreshTokenFamilyGenerationStats(authCtx.coreAdapter, {
      tenantId,
      clientId,
      nowMs: now,
    });

    // Get shard config
    const config = await getRefreshTokenShardConfig(c.env, clientId || '__global__', tenantId);

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

    // Create AuthContext for database operations
    const authCtx = createAuthContextFromHono(c, tenantId);
    const now = Date.now();

    // Safety check: ensure no active tokens exist for this generation via Adapter
    const activeCount = await countActiveRefreshTokenFamiliesByGeneration(authCtx.coreAdapter, {
      tenantId,
      generation,
      nowMs: now,
      clientId,
    });

    if (activeCount > 0) {
      return c.json(
        {
          error: 'cleanup_blocked',
          error_description: `Cannot cleanup generation ${generation}: ${activeCount} active tokens exist`,
          active_count: activeCount,
        },
        400
      );
    }

    // Get current config to prevent cleanup of current generation
    const config = await getRefreshTokenShardConfig(c.env, clientId || '__global__', tenantId);
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
    const deletedCount = await deleteRefreshTokenFamiliesByGeneration(authCtx.coreAdapter, {
      tenantId,
      generation,
      clientId,
    });

    // Remove from shard config's previousGenerations
    const updatedConfig: RefreshTokenShardConfig = {
      ...config,
      previousGenerations: config.previousGenerations.filter((g) => g.generation !== generation),
      updatedAt: Date.now(),
    };
    await saveRefreshTokenShardConfig(c.env, clientId, updatedConfig, tenantId);

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
    const userId = c.req.param('userId')!;
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

    // Get all token families for this user via Adapter
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const families = await listRefreshTokenFamiliesByUser(authCtx.coreAdapter, {
      tenantId,
      userId,
      clientId,
      activeOnly: true,
      nowMs: Date.now(),
    });

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
        parsed.shardIndex,
        tenantId
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
    await revokeRefreshTokenFamiliesByUser(authCtx.coreAdapter, {
      tenantId,
      userId,
      clientId,
    });

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
