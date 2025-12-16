import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import {
  DEFAULT_REVOCATION_SHARD_COUNT,
  LEGACY_SHARD_COUNT,
  resetRevocationShardCountCache,
  getRevocationShardConfig,
  saveRevocationShardConfig,
  createNewRevocationGeneration,
  REVOCATION_SHARD_CONFIG_KEY,
  type RevocationShardConfig,
} from '@authrim/shared';

/**
 * GET /api/admin/settings/revocation-shards
 * 現在のToken Revocationシャード設定を取得（Generation-based対応）
 */
export async function getRevocationShards(c: Context<{ Bindings: Env }>) {
  const config = await getRevocationShardConfig(c.env);

  // Also get legacy simple value for backward compat display
  const simpleKvValue = await c.env.AUTHRIM_CONFIG?.get('revocation_shards');
  const envValue = c.env.AUTHRIM_REVOCATION_SHARDS;

  return c.json({
    // Generation-based config
    currentGeneration: config.currentGeneration,
    currentShardCount: config.currentShardCount,
    previousGenerations: config.previousGenerations,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,

    // Convenience fields
    current: config.currentShardCount,
    default: DEFAULT_REVOCATION_SHARD_COUNT,
    legacyShardCount: LEGACY_SHARD_COUNT,

    // Source info
    kv_config_key: REVOCATION_SHARD_CONFIG_KEY,
    legacy_kv_value: simpleKvValue || null,
    env_value: envValue || null,

    note: 'Generation-based sharding. New tokens use embedded shard info (rv{gen}_{shard}_{random}). Legacy tokens use hash-based routing with LEGACY_SHARD_COUNT.',
  });
}

/**
 * PUT /api/admin/settings/revocation-shards
 * Token Revocationシャード数を動的に変更（新世代を作成）
 */
export async function updateRevocationShards(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  const body = await c.req.json<{ shards?: number; updatedBy?: string }>();
  const { shards, updatedBy } = body;

  // バリデーション
  if (typeof shards !== 'number' || shards <= 0 || shards > 256) {
    return c.json(
      {
        error: 'invalid_shard_count',
        error_description: 'Shard count must be a number between 1 and 256',
      },
      400
    );
  }

  // Get current config
  const currentConfig = await getRevocationShardConfig(c.env);

  // Check if shard count is actually changing
  if (currentConfig.currentShardCount === shards) {
    return c.json({
      success: true,
      message: 'Shard count unchanged',
      currentGeneration: currentConfig.currentGeneration,
      currentShardCount: currentConfig.currentShardCount,
    });
  }

  // Create new generation
  const newConfig = createNewRevocationGeneration(currentConfig, shards, updatedBy || 'admin-api');

  // Save to KV
  await saveRevocationShardConfig(c.env, newConfig);

  // Also update simple key for backward compat
  await c.env.AUTHRIM_CONFIG.put('revocation_shards', shards.toString());

  return c.json({
    success: true,
    previousGeneration: currentConfig.currentGeneration,
    previousShardCount: currentConfig.currentShardCount,
    newGeneration: newConfig.currentGeneration,
    newShardCount: newConfig.currentShardCount,
    note: 'New generation created. New tokens will use embedded shard info. Existing tokens will continue to route correctly via previousGenerations lookup.',
    warning:
      shards < 4 ? 'Low shard count may cause performance issues under high load' : undefined,
  });
}

/**
 * DELETE /api/admin/settings/revocation-shards
 * Token Revocationシャード設定をリセット（KVから削除、デフォルトに戻す）
 */
export async function resetRevocationShards(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  // KVから両方のキーを削除
  await c.env.AUTHRIM_CONFIG.delete(REVOCATION_SHARD_CONFIG_KEY);
  await c.env.AUTHRIM_CONFIG.delete('revocation_shards');

  // キャッシュクリア
  resetRevocationShardCountCache();

  return c.json({
    success: true,
    reset_to_default: DEFAULT_REVOCATION_SHARD_COUNT,
    note: 'Revocation shard config reset to default. Cache cleared. WARNING: Existing tokens with embedded shard info may fail revocation checks until they expire.',
    warning:
      'Resetting config may break revocation lookups for tokens created with non-default shard counts.',
  });
}

/**
 * GET /api/admin/settings/revocation-shards/config
 * 詳細な設定情報を取得（デバッグ用）
 */
export async function getRevocationShardsConfig(c: Context<{ Bindings: Env }>) {
  const config = await getRevocationShardConfig(c.env);

  // Get raw KV values
  const fullConfigRaw = await c.env.AUTHRIM_CONFIG?.get(REVOCATION_SHARD_CONFIG_KEY);
  const simpleValueRaw = await c.env.AUTHRIM_CONFIG?.get('revocation_shards');

  return c.json({
    resolved: config,
    raw: {
      fullConfig: fullConfigRaw ? JSON.parse(fullConfigRaw) : null,
      simpleValue: simpleValueRaw,
      envValue: c.env.AUTHRIM_REVOCATION_SHARDS || null,
    },
    constants: {
      DEFAULT_REVOCATION_SHARD_COUNT,
      LEGACY_SHARD_COUNT,
      REVOCATION_SHARD_CONFIG_KEY,
    },
  });
}
