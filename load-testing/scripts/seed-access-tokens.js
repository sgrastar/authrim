#!/usr/bin/env node

/**
 * Token Introspection Control Plane Test - シード生成スクリプト
 *
 * RFC 7662 Token Introspection の負荷テスト用トークンを生成
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ テスト設計根拠 (RFC 7662 + 業界標準ベンチマーク準拠)                        │
 * ├────────────────────┬───────┬────────────────────────────────────────────────┤
 * │ 種別               │ 比率  │ 説明                                           │
 * ├────────────────────┼───────┼────────────────────────────────────────────────┤
 * │ Active (標準)      │ 60%   │ 通常のアクセストークン                         │
 * │ Active (TE)        │ 5%    │ Token Exchange後 (act claim付き, RFC 8693)     │
 * │ Expired            │ 12%   │ 期限切れ (exp=過去)                            │
 * │ Revoked            │ 12%   │ 無効化済み (POST /revoke)                      │
 * │ Wrong audience     │ 6%    │ 署名OK, aud不一致 (strictValidation=true時検出)│
 * │ Wrong client       │ 5%    │ 別client_idで発行 (strictValidation=true時検出)│
 * └────────────────────┴───────┴────────────────────────────────────────────────┘
 *
 * 評価軸:
 * 1. revoked/expired の即時反映 (active=false)
 * 2. active=false の正確性 (False positive/negative = 0)
 * 3. scope/aud/sub の整合性
 * 4. キャッシュと即時性のトレードオフ (RFC 7662: expを超えたキャッシュ禁止)
 * 5. Token Exchange後トークンの整合 (act/resource claim)
 *
 * 参考: Keycloak Benchmark, Auth0 Performance Testing
 *
 * 注意: テスト実行前に strictValidation=true を設定する必要あり
 *   curl -X PUT https://conformance.authrim.com/api/admin/settings/introspection-validation \
 *     -H "Authorization: Bearer $ADMIN_API_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"strictValidation": true}'
 *
 * 環境変数:
 *   BASE_URL             対象の Authrim Worker URL (default: https://conformance.authrim.com)
 *   CLIENT_ID            クライアント ID (required)
 *   CLIENT_SECRET        クライアントシークレット (required)
 *   ADMIN_API_SECRET     Admin API シークレット (required)
 *   TOKEN_COUNT          生成するトークン総数 (default: 1000)
 *   CONCURRENCY          並列数 (default: 20)
 *   USER_ID_PREFIX       ユーザー ID プレフィックス (default: user-bench)
 *   OUTPUT_DIR           出力ディレクトリ (default: ../seeds)
 *   VERIFY_SAMPLE_SIZE   検証時の各カテゴリのサンプル数 (default: 5)
 *
 * 使い方:
 *   CLIENT_ID=xxx CLIENT_SECRET=yyy ADMIN_API_SECRET=zzz node scripts/seed-access-tokens.js
 *
 * ⚠️ 重要: シードデータは負荷テスト実行前に毎回再生成すること
 *   - Revokedトークンのrevocation状態はサーバー側のKV/DOに保存される
 *   - デプロイ、時間経過、TTL等でrevocation状態が失われる可能性がある
 *   - 古いシードを使うとrevokedトークンがactive=trueを返す（False Positive）
 *   - R2にアップロードする場合も、テスト直前に再生成→アップロードを推奨
 */

import { SignJWT, importPKCS8 } from 'jose';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const TOKEN_COUNT = Number.parseInt(process.env.TOKEN_COUNT || '1000', 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '20', 10);
const REVOKE_CONCURRENCY = Number.parseInt(process.env.REVOKE_CONCURRENCY || '2', 10);
const REVOKE_DELAY_MS = Number.parseInt(process.env.REVOKE_DELAY_MS || '500', 10);
const VERIFY_SAMPLE_SIZE = Number.parseInt(process.env.VERIFY_SAMPLE_SIZE || '5', 10);
const USER_ID_PREFIX = process.env.USER_ID_PREFIX || 'user-bench';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds');
const TEST_USERS_PATH =
  process.env.TEST_USERS_PATH || path.join(SCRIPT_DIR, '..', 'seeds', 'test_users.json');

/**
 * トークン種別の比率 (RFC 7662 + 業界標準ベンチマーク準拠)
 *
 * - Active tokens (65%): 実運用では70-80%が有効トークンへの検証
 * - Expired (12%): クライアントのクロック差異、キャッシュによる期限切れ
 * - Revoked (12%): 無効化済みトークンの検出テスト
 * - Wrong audience (6%): aud検証テスト (strictValidation有効時)
 * - Wrong client (5%): client_id検証テスト (strictValidation有効時)
 */
const TOKEN_MIX = {
  valid: 0.6, // 60% - 通常のアクセストークン
  valid_exchanged: 0.05, // 5%  - Token Exchange (act claim付き)
  expired: 0.12, // 12% - 期限切れ
  revoked: 0.12, // 12% - 無効化済み
  wrong_audience: 0.06, // 6%  - 署名OK, aud不一致
  wrong_client: 0.05, // 5%  - 別client_idで発行
};

// サービスクライアント (actor_token用)
const SERVICE_CLIENTS = [
  { id: 'service-gateway', name: 'API Gateway Service' },
  { id: 'service-bff', name: 'Backend for Frontend' },
  { id: 'service-worker', name: 'Background Worker' },
];

// リソースURI (Token Exchange用)
const RESOURCE_URIS = [
  'https://api.example.com/gateway',
  'https://api.example.com/users',
  'https://api.example.com/payments',
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ CLIENT_ID と CLIENT_SECRET は必須です。環境変数を設定してください。');
  process.exit(1);
}

if (!ADMIN_API_SECRET) {
  console.error('❌ ADMIN_API_SECRET は必須です。環境変数を設定してください。');
  process.exit(1);
}

const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

// =============================================================================
// Region Sharding Configuration (matches region-sharding.ts)
// =============================================================================

/**
 * Default total shard count (matches region-sharding.ts)
 */
const DEFAULT_TOTAL_SHARDS = 20;

/**
 * Default region distribution (APAC 20%, ENAM 40%, WEUR 40%)
 * Calculated region ranges for 20 shards:
 *   enam: 0-7 (8 shards, 40%)
 *   weur: 8-15 (8 shards, 40%)
 *   apac: 16-19 (4 shards, 20%)
 *   wnam: 0-15 (16 shards, 100%) - Western North America (conformance env)
 */
const REGION_RANGES = {
  enam: { start: 0, end: 7 },
  weur: { start: 8, end: 15 },
  apac: { start: 16, end: 19 },
  wnam: { start: 0, end: 15 },
};

/**
 * Target region for shard selection.
 * If set, only shards in this region will be used.
 * Valid values: 'enam', 'weur', 'apac', or empty for all regions.
 */
const TARGET_REGION = process.env.TARGET_REGION || '';

/**
 * Get region key from shard index
 */
function getRegionForShard(shardIndex) {
  for (const [region, range] of Object.entries(REGION_RANGES)) {
    if (shardIndex >= range.start && shardIndex <= range.end) {
      return region;
    }
  }
  return 'enam'; // default fallback
}

/**
 * Generate secure random string (base64url)
 */
function generateSecureRandomString(length = 32) {
  return crypto.randomBytes(length).toString('base64url');
}

/**
 * Generate region-aware JTI (JWT ID) for new generation-based sharding
 * Format: g{gen}:{region}:{shard}:{randomPart}
 * Example: g1:enam:7:at_abc123
 *
 * If TARGET_REGION is set, only shards in that region are used.
 * Otherwise, all shards (0-19) are used.
 *
 * @returns {{jti: string, generation: number, shardIndex: number, regionKey: string}}
 */
function generateRegionAwareJti() {
  const generation = 1; // Current generation
  let shardIndex;
  let regionKey;

  if (TARGET_REGION && REGION_RANGES[TARGET_REGION]) {
    // Use only shards in the target region
    const range = REGION_RANGES[TARGET_REGION];
    const shardCount = range.end - range.start + 1;
    shardIndex = range.start + Math.floor(Math.random() * shardCount);
    regionKey = TARGET_REGION;
  } else {
    // Use all shards
    shardIndex = Math.floor(Math.random() * DEFAULT_TOTAL_SHARDS);
    regionKey = getRegionForShard(shardIndex);
  }

  const randomPart = `at_${generateSecureRandomString(32)}`;
  const jti = `g${generation}:${regionKey}:${shardIndex}:${randomPart}`;

  return { jti, generation, shardIndex, regionKey };
}

/**
 * Generate JTI (JWT ID) - Region-aware format
 * @deprecated Use generateRegionAwareJti for full info
 */
function generateJti() {
  return generateRegionAwareJti().jti;
}

/**
 * Pick random item from array
 */
function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Fetch signing key with private key from Admin API
 */
async function fetchSigningKey() {
  console.log('🔑 Fetching signing key from Admin API...');

  const res = await fetch(`${BASE_URL}/api/admin/test/signing-key`, {
    method: 'GET',
    headers: adminAuthHeader,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to fetch signing key: ${res.status} - ${error}`);
  }

  const data = await res.json();
  console.log(`   kid: ${data.kid}`);
  return data;
}

/**
 * Create a signed Access Token JWT locally
 *
 * @param {CryptoKey} privateKey - Signing key
 * @param {string} kid - Key ID
 * @param {object} options - Token options
 * @returns {Promise<{token: string, jti: string, exp: number, shardIndex: number, regionKey: string}>}
 */
async function createAccessToken(privateKey, kid, options) {
  const { userId, scope, expiresIn, issuer, audience, clientId } = options;
  const now = Math.floor(Date.now() / 1000);
  const { jti, shardIndex, regionKey } = generateRegionAwareJti();
  const exp = now + expiresIn;

  const token = await new SignJWT({
    iss: issuer,
    sub: userId,
    aud: audience || issuer, // Access tokenのaudはissuerと同じ（デフォルト）
    client_id: clientId || CLIENT_ID,
    scope,
    iat: now,
    exp,
    jti,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid })
    .sign(privateKey);

  return { token, jti, exp, shardIndex, regionKey };
}

/**
 * Create a Token Exchange token with act claim (RFC 8693)
 */
async function createExchangedToken(privateKey, kid, options) {
  const { userId, scope, expiresIn, issuer } = options;
  const now = Math.floor(Date.now() / 1000);
  const { jti, shardIndex, regionKey } = generateRegionAwareJti();
  const exp = now + expiresIn;
  const serviceClient = randomPick(SERVICE_CLIENTS);
  const resource = randomPick(RESOURCE_URIS);

  // Token Exchange後のトークン (RFC 8693)
  const token = await new SignJWT({
    iss: issuer,
    sub: userId,
    aud: issuer,
    client_id: CLIENT_ID,
    scope,
    iat: now,
    exp,
    jti,
    // RFC 8693: Actor claim for delegation
    act: {
      sub: `client:${serviceClient.id}`,
      client_id: serviceClient.id,
    },
    // RFC 8693: Resource server URI
    resource,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid })
    .sign(privateKey);

  return { token, jti, exp, actorClientId: serviceClient.id, resource, shardIndex, regionKey };
}

/**
 * Create a Wrong Audience token (valid signature but wrong aud)
 */
async function createWrongAudienceToken(privateKey, kid, options) {
  const { userId, scope, expiresIn, issuer } = options;
  const now = Math.floor(Date.now() / 1000);
  const { jti, shardIndex, regionKey } = generateRegionAwareJti();
  const exp = now + expiresIn;

  // 署名は正しいが、audienceが別のサービス
  const token = await new SignJWT({
    iss: issuer,
    sub: userId,
    aud: 'https://other-service.example.com', // 不正なaudience
    client_id: CLIENT_ID,
    scope,
    iat: now,
    exp,
    jti,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid })
    .sign(privateKey);

  return { token, jti, exp, shardIndex, regionKey };
}

/**
 * Create a Wrong Client token (valid signature but unknown client_id)
 */
async function createWrongClientToken(privateKey, kid, options) {
  const { userId, scope, expiresIn, issuer } = options;
  const now = Math.floor(Date.now() / 1000);
  const { jti, shardIndex, regionKey } = generateRegionAwareJti();
  const exp = now + expiresIn;

  // 署名は正しいが、client_idが別のクライアント（存在しない）
  const token = await new SignJWT({
    iss: issuer,
    sub: userId,
    aud: issuer,
    client_id: 'non-existent-client-id', // 不正なclient_id
    scope,
    iat: now,
    exp,
    jti,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid })
    .sign(privateKey);

  return { token, jti, exp, shardIndex, regionKey };
}

/**
 * Create an invalid token (random string that looks like JWT)
 */
function createInvalidToken() {
  // Base64url-like random strings for header.payload.signature
  const header = generateSecureRandomString(20);
  const payload = generateSecureRandomString(100);
  const signature = generateSecureRandomString(43);
  return `${header}.${payload}.${signature}`;
}

/**
 * Revoke a token via /revoke endpoint (RFC 7009)
 *
 * Note: RFC 7009 specifies that the revoke endpoint always returns 200 OK,
 * even if the token was not found or already revoked. We verify the actual
 * revocation status via the introspect endpoint.
 */
async function revokeAccessToken(token) {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const res = await fetch(`${BASE_URL}/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: `token=${encodeURIComponent(token)}&token_type_hint=access_token`,
  });

  // RFC 7009: Always returns 200 OK
  if (!res.ok) {
    throw new Error(`Failed to revoke token: ${res.status}`);
  }
}

/**
 * Introspect a token to verify its status (RFC 7662)
 *
 * @param {string} token - The token to introspect
 * @returns {Promise<{active: boolean}>} - The introspection response
 */
async function introspectToken(token) {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const res = await fetch(`${BASE_URL}/introspect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: `token=${encodeURIComponent(token)}`,
  });

  if (!res.ok) {
    throw new Error(`Introspect failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Determine token type based on distribution
 */
function determineTokenType(index, totalCount) {
  const validCount = Math.floor(totalCount * TOKEN_MIX.valid);
  const validExchangedCount = Math.floor(totalCount * TOKEN_MIX.valid_exchanged);
  const expiredCount = Math.floor(totalCount * TOKEN_MIX.expired);
  const revokedCount = Math.floor(totalCount * TOKEN_MIX.revoked);
  const wrongAudienceCount = Math.floor(totalCount * TOKEN_MIX.wrong_audience);
  // Remaining goes to wrong_client

  let cumulative = 0;

  cumulative += validCount;
  if (index < cumulative) return 'valid';

  cumulative += validExchangedCount;
  if (index < cumulative) return 'valid_exchanged';

  cumulative += expiredCount;
  if (index < cumulative) return 'expired';

  cumulative += revokedCount;
  if (index < cumulative) return 'revoked';

  cumulative += wrongAudienceCount;
  if (index < cumulative) return 'wrong_audience';

  return 'wrong_client';
}

/**
 * Load test users from file
 * @returns {Array<{userId: string}>} Array of test users
 */
function loadTestUsers() {
  try {
    const data = fs.readFileSync(TEST_USERS_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.warn(`⚠️  Could not load test_users.json: ${e.message}`);
    console.warn('   Falling back to generated user IDs');
    return null;
  }
}

// Load test users at startup
const testUsers = loadTestUsers();

/**
 * Get user ID for a given index
 * Uses real user IDs from test_users.json if available
 */
function getUserId(index) {
  if (testUsers && testUsers.length > 0) {
    // Cycle through test users if index exceeds count
    const user = testUsers[index % testUsers.length];
    return user.userId;
  }
  return `${USER_ID_PREFIX}-${index}`;
}

/**
 * Generate a single token based on type
 */
async function generateSingleToken(privateKey, kid, issuer, scope, index, tokenType) {
  const userId = getUserId(index);
  const baseOptions = { userId, scope, issuer };

  switch (tokenType) {
    case 'valid': {
      const { token, jti, exp, shardIndex, regionKey } = await createAccessToken(privateKey, kid, {
        ...baseOptions,
        expiresIn: 30 * 24 * 3600, // 30 days
      });
      return {
        access_token: token,
        type: 'valid',
        user_id: userId,
        jti,
        exp,
        shard_index: shardIndex,
        region_key: regionKey,
      };
    }

    case 'valid_exchanged': {
      const { token, jti, exp, actorClientId, resource, shardIndex, regionKey } =
        await createExchangedToken(privateKey, kid, {
          ...baseOptions,
          expiresIn: 30 * 24 * 3600, // 30 days
        });
      return {
        access_token: token,
        type: 'valid_exchanged',
        user_id: userId,
        jti,
        exp,
        actor_client_id: actorClientId,
        resource,
        shard_index: shardIndex,
        region_key: regionKey,
      };
    }

    case 'expired': {
      const { token, jti, exp, shardIndex, regionKey } = await createAccessToken(privateKey, kid, {
        ...baseOptions,
        expiresIn: -3600, // 1 hour ago (expired)
      });
      return {
        access_token: token,
        type: 'expired',
        user_id: userId,
        jti,
        exp,
        shard_index: shardIndex,
        region_key: regionKey,
      };
    }

    case 'revoked': {
      const { token, jti, exp, shardIndex, regionKey } = await createAccessToken(privateKey, kid, {
        ...baseOptions,
        expiresIn: 30 * 24 * 3600, // 30 days
      });
      return {
        access_token: token,
        type: 'revoked',
        user_id: userId,
        jti,
        exp,
        shard_index: shardIndex,
        region_key: regionKey,
      };
    }

    case 'wrong_audience': {
      const { token, jti, exp, shardIndex, regionKey } = await createWrongAudienceToken(
        privateKey,
        kid,
        {
          ...baseOptions,
          expiresIn: 30 * 24 * 3600, // 30 days
        }
      );
      return {
        access_token: token,
        type: 'wrong_audience',
        user_id: userId,
        jti,
        exp,
        shard_index: shardIndex,
        region_key: regionKey,
      };
    }

    case 'wrong_client': {
      const { token, jti, exp, shardIndex, regionKey } = await createWrongClientToken(
        privateKey,
        kid,
        {
          ...baseOptions,
          expiresIn: 30 * 24 * 3600, // 30 days
        }
      );
      return {
        access_token: token,
        type: 'wrong_client',
        user_id: userId,
        jti,
        exp,
        shard_index: shardIndex,
        region_key: regionKey,
      };
    }

    default:
      // Fallback: create invalid token
      return {
        access_token: createInvalidToken(),
        type: 'invalid',
        user_id: userId,
        jti: null,
        exp: null,
        shard_index: null,
        region_key: null,
      };
  }
}

/**
 * Generate a batch of tokens in parallel
 */
async function generateBatch(privateKey, kid, issuer, scope, batchSize, startIndex, totalCount) {
  const promises = [];
  for (let i = 0; i < batchSize; i++) {
    const tokenIndex = startIndex + i;
    const tokenType = determineTokenType(tokenIndex, totalCount);

    promises.push(
      generateSingleToken(privateKey, kid, issuer, scope, tokenIndex, tokenType).catch((err) => ({
        error: err.message,
        type: tokenType,
      }))
    );
  }
  return Promise.all(promises);
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify token statuses via introspection
 *
 * This function samples tokens from each category and verifies that the
 * introspection endpoint returns the expected active status.
 *
 * @param {Array} tokens - Array of generated tokens
 * @param {number} sampleSize - Number of tokens to sample from each category
 * @returns {Promise<object>} - Verification results
 */
async function verifyTokenStatuses(tokens, sampleSize = 5) {
  console.log(`\n🔍 Verifying token statuses (${sampleSize} samples per category)...`);

  const results = {
    valid: { expected: true, correct: 0, incorrect: 0, errors: 0 },
    valid_exchanged: { expected: true, correct: 0, incorrect: 0, errors: 0 },
    expired: { expected: false, correct: 0, incorrect: 0, errors: 0 },
    revoked: { expected: false, correct: 0, incorrect: 0, errors: 0 },
    wrong_audience: { expected: false, correct: 0, incorrect: 0, errors: 0 },
    wrong_client: { expected: false, correct: 0, incorrect: 0, errors: 0 },
  };

  for (const [type, config] of Object.entries(results)) {
    const typeTokens = tokens.filter((t) => t.type === type);
    const sampled = typeTokens.slice(0, Math.min(sampleSize, typeTokens.length));

    for (const tokenData of sampled) {
      try {
        const introspection = await introspectToken(tokenData.access_token);
        const isCorrect = introspection.active === config.expected;

        if (isCorrect) {
          config.correct++;
        } else {
          config.incorrect++;
          console.warn(
            `   ⚠️  ${type}: expected active=${config.expected}, got active=${introspection.active}`
          );
        }
      } catch (err) {
        config.errors++;
        console.error(`   ❌ ${type}: verification failed - ${err.message}`);
      }

      // Small delay to avoid rate limiting
      await sleep(100);
    }

    const total = config.correct + config.incorrect + config.errors;
    const status = config.incorrect === 0 && config.errors === 0 ? '✅' : '❌';
    console.log(`   ${status} ${type}: ${config.correct}/${total} correct`);
  }

  return results;
}

/**
 * Revoke tokens that should be revoked (with rate limit handling)
 */
async function revokeTokensBatch(tokens) {
  const revokedTokens = tokens.filter((t) => t.type === 'revoked' && t.access_token);
  if (revokedTokens.length === 0) return 0;

  console.log(
    `\n🔐 Revoking ${revokedTokens.length} tokens (concurrency: ${REVOKE_CONCURRENCY}, delay: ${REVOKE_DELAY_MS}ms)...`
  );

  let revokedCount = 0;
  const totalBatches = Math.ceil(revokedTokens.length / REVOKE_CONCURRENCY);

  for (let batch = 0; batch < totalBatches; batch++) {
    const start = batch * REVOKE_CONCURRENCY;
    const end = Math.min(start + REVOKE_CONCURRENCY, revokedTokens.length);
    const batchTokens = revokedTokens.slice(start, end);

    const promises = batchTokens.map((t) =>
      revokeAccessToken(t.access_token)
        .then(() => {
          revokedCount++;
          return true;
        })
        .catch((err) => {
          console.error(`   ❌ Failed to revoke token: ${err.message}`);
          return false;
        })
    );

    await Promise.all(promises);

    if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
      console.log(`   [${revokedCount}/${revokedTokens.length}] revoked`);
    }

    // Add delay between batches to avoid rate limiting
    if (batch < totalBatches - 1) {
      await sleep(REVOKE_DELAY_MS);
    }
  }

  return revokedCount;
}

async function main() {
  console.log(`🚀 Token Introspection Control Plane Test - Seed Generator`);
  console.log(`   BASE_URL       : ${BASE_URL}`);
  console.log(`   CLIENT_ID      : ${CLIENT_ID}`);
  if (testUsers) {
    console.log(`   TEST_USERS     : ${testUsers.length} users from test_users.json`);
  } else {
    console.log(`   USER_ID_PREFIX : ${USER_ID_PREFIX}`);
  }
  console.log(`   TOKEN_COUNT    : ${TOKEN_COUNT}`);
  console.log(`   CONCURRENCY    : ${CONCURRENCY}`);
  console.log(`   OUTPUT_DIR     : ${OUTPUT_DIR}`);
  if (TARGET_REGION) {
    const range = REGION_RANGES[TARGET_REGION];
    console.log(
      `   TARGET_REGION  : ${TARGET_REGION} (shards ${range.start}-${range.end}, ${range.end - range.start + 1} shards)`
    );
  } else {
    console.log(`   TARGET_REGION  : all (shards 0-19, 20 shards)`);
  }
  console.log('');
  console.log(`📊 Token Distribution (RFC 7662 + Keycloak/Auth0 benchmark):`);
  console.log(
    `   Valid (標準):     ${Math.floor(TOKEN_COUNT * TOKEN_MIX.valid)} (${TOKEN_MIX.valid * 100}%)`
  );
  console.log(
    `   Valid (TE/act):   ${Math.floor(TOKEN_COUNT * TOKEN_MIX.valid_exchanged)} (${TOKEN_MIX.valid_exchanged * 100}%)`
  );
  console.log(
    `   Expired:          ${Math.floor(TOKEN_COUNT * TOKEN_MIX.expired)} (${TOKEN_MIX.expired * 100}%)`
  );
  console.log(
    `   Revoked:          ${Math.floor(TOKEN_COUNT * TOKEN_MIX.revoked)} (${TOKEN_MIX.revoked * 100}%)`
  );
  console.log(
    `   Wrong audience:   ${Math.floor(TOKEN_COUNT * TOKEN_MIX.wrong_audience)} (${TOKEN_MIX.wrong_audience * 100}%)`
  );
  console.log(
    `   Wrong client:     ${Math.floor(TOKEN_COUNT * TOKEN_MIX.wrong_client)} (${TOKEN_MIX.wrong_client * 100}%)`
  );
  console.log('');

  // Step 1: Fetch signing key
  const signingKey = await fetchSigningKey();
  const privateKey = await importPKCS8(signingKey.privatePEM, 'RS256');

  console.log('');
  console.log('📦 Generating access tokens...');

  const tokens = [];
  let errorCount = 0;
  const startTime = Date.now();
  const scope = 'openid profile email';
  const issuer = BASE_URL.replace(/^http:/, 'https:');

  // Generate in batches
  const totalBatches = Math.ceil(TOKEN_COUNT / CONCURRENCY);
  let currentIndex = 0;

  for (let batch = 0; batch < totalBatches; batch++) {
    const remaining = TOKEN_COUNT - currentIndex;
    const batchSize = Math.min(CONCURRENCY, remaining);

    const results = await generateBatch(
      privateKey,
      signingKey.kid,
      issuer,
      scope,
      batchSize,
      currentIndex,
      TOKEN_COUNT
    );
    currentIndex += batchSize;

    for (const result of results) {
      if (result.error) {
        errorCount++;
        console.error(`   ❌ ${result.error}`);
      } else {
        tokens.push(result);
      }
    }

    const progress = tokens.length;
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = progress / elapsed;

    if ((batch + 1) % 5 === 0 || batch === totalBatches - 1) {
      console.log(
        `   [${progress}/${TOKEN_COUNT}] ${rate.toFixed(1)}/s, errors: ${errorCount}, elapsed: ${elapsed.toFixed(1)}s`
      );
    }
  }

  // Step 2: Revoke tokens marked as 'revoked'
  const revokedCount = await revokeTokensBatch(tokens);

  // Step 3: Wait for revocation to propagate (Durable Objects may have slight delay)
  console.log('\n⏳ Waiting for revocation to propagate (2s)...');
  await sleep(2000);

  // Step 4: Verify token statuses via introspection
  const verificationResults = await verifyTokenStatuses(tokens, VERIFY_SAMPLE_SIZE);

  // Calculate verification summary
  const allCorrect = Object.values(verificationResults).every(
    (r) => r.incorrect === 0 && r.errors === 0
  );
  const totalVerified = Object.values(verificationResults).reduce(
    (sum, r) => sum + r.correct + r.incorrect + r.errors,
    0
  );
  const totalIncorrect = Object.values(verificationResults).reduce(
    (sum, r) => sum + r.incorrect,
    0
  );

  const totalTime = (Date.now() - startTime) / 1000;

  if (tokens.length === 0) {
    throw new Error('No tokens generated. Aborting.');
  }

  // Count by type
  const typeCounts = {
    valid: tokens.filter((t) => t.type === 'valid').length,
    valid_exchanged: tokens.filter((t) => t.type === 'valid_exchanged').length,
    expired: tokens.filter((t) => t.type === 'expired').length,
    revoked: tokens.filter((t) => t.type === 'revoked').length,
    wrong_audience: tokens.filter((t) => t.type === 'wrong_audience').length,
    wrong_client: tokens.filter((t) => t.type === 'wrong_client').length,
  };

  // Build output
  const output = {
    tokens,
    metadata: {
      version: 3,
      test_name: 'Token Introspection Control Plane Test',
      generated_at: new Date().toISOString(),
      base_url: BASE_URL,
      client_id: CLIENT_ID,
      scope,
      counts: typeCounts,
      total: tokens.length,
      token_mix: TOKEN_MIX,
      verification: {
        verified: totalVerified,
        incorrect: totalIncorrect,
        all_correct: allCorrect,
        results: verificationResults,
      },
      note: 'Run test with strictValidation=true for wrong_audience/wrong_client checks',
    },
  };

  // Save to file
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, 'access_tokens.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log('');
  console.log(`✅ Generated ${tokens.length} access tokens in ${totalTime.toFixed(2)}s`);
  console.log(`   Valid (標準):     ${typeCounts.valid}`);
  console.log(`   Valid (TE/act):   ${typeCounts.valid_exchanged}`);
  console.log(`   Expired:          ${typeCounts.expired}`);
  console.log(
    `   Revoked:          ${typeCounts.revoked} (${revokedCount} actually revoked via API)`
  );
  console.log(`   Wrong audience:   ${typeCounts.wrong_audience}`);
  console.log(`   Wrong client:     ${typeCounts.wrong_client}`);
  console.log(`   Rate:             ${(tokens.length / totalTime).toFixed(1)} tokens/sec`);
  console.log(`   Errors:           ${errorCount}`);
  console.log('');
  console.log(`🔍 Verification Summary:`);
  console.log(`   Total verified:   ${totalVerified} samples`);
  console.log(`   Incorrect:        ${totalIncorrect}`);
  console.log(`   Status:           ${allCorrect ? '✅ All correct' : '❌ Some incorrect'}`);

  if (!allCorrect) {
    console.log('');
    console.log('⚠️  Some tokens did not verify correctly. This may indicate:');
    console.log('   - strictValidation is not enabled (for wrong_audience/wrong_client)');
    console.log('   - Revocation propagation delay');
    console.log('   - Server configuration issue');
  }

  console.log('');
  console.log(`📁 Saved to: ${outputPath}`);
  console.log('');
  console.log('⚠️  Remember to enable strictValidation before running the benchmark:');
  console.log(`   curl -X PUT ${BASE_URL}/api/admin/settings/introspection-validation \\`);
  console.log(`     -H "Authorization: Bearer \\$ADMIN_API_SECRET" \\`);
  console.log(`     -H "Content-Type: application/json" \\`);
  console.log(`     -d '{"strictValidation": true}'`);
  console.log('');
  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
