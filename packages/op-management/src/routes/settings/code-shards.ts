import type { Context } from 'hono';

/**
 * GET /api/admin/settings/code-shards
 * 現在のシャード数設定を取得
 */
export async function getCodeShards(c: Context) {
  const kvValue = await c.env.AUTHRIM_CONFIG?.get('code_shards');
  const envValue = c.env.AUTHRIM_CODE_SHARDS;
  const current = kvValue || envValue || '64';

  return c.json({
    current: parseInt(current, 10),
    source: kvValue ? 'kv' : envValue ? 'env' : 'default',
    kv_value: kvValue || null,
    env_value: envValue || null,
  });
}

/**
 * PUT /api/admin/settings/code-shards
 * シャード数を動的に変更（KVに保存）
 */
export async function updateCodeShards(c: Context) {
  const { shards } = await c.req.json();

  // バリデーション
  if (typeof shards !== 'number' || shards <= 0 || shards > 256) {
    return c.json({ error: 'Invalid shard count: must be between 1 and 256' }, 400);
  }

  // KVに保存
  await c.env.AUTHRIM_CONFIG.put('code_shards', shards.toString());

  // キャッシュクリア（10秒待てば自動的にリフレッシュされる）
  return c.json({
    success: true,
    shards,
    note: 'Cache will refresh within 10 seconds',
  });
}
