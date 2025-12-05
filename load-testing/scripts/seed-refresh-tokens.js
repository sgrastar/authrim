#!/usr/bin/env node

/**
 * Refresh Token 並列生成スクリプト (V3)
 *
 * V3: シャーディング対応
 * - JTI形式: v{generation}_{shardIndex}_{randomPart}
 * - 世代管理方式によるシャード分散
 *
 * V2: rtv (Refresh Token Version) claim 対応
 * ローカル署名 + Admin API 並列登録により高速生成
 *
 * 環境変数:
 *   BASE_URL             対象の Authrim Worker URL (default: https://conformance.authrim.com)
 *   CLIENT_ID            クライアント ID (required)
 *   CLIENT_SECRET        クライアントシークレット (required)
 *   ADMIN_API_SECRET     Admin API シークレット (required)
 *   COUNT                生成するトークン数 (default: 120)
 *   CONCURRENCY          並列数 (default: 20)
 *   USER_ID_PREFIX       ユーザー ID プレフィックス (default: user-loadtest)
 *   OUTPUT_DIR           出力ディレクトリ (default: ../seeds)
 *
 * 注意: V2/V3ではユーザーIDごとに1つのトークンファミリーのみ保持されるため、
 *       各トークンに異なるユーザーID ({USER_ID_PREFIX}-{index}) を割り当てます。
 *
 * 使い方:
 *   CLIENT_ID=xxx CLIENT_SECRET=yyy ADMIN_API_SECRET=zzz node scripts/generate-refresh-tokens-parallel.js
 */

import { SignJWT, importPKCS8 } from 'jose';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// V3: Sharding configuration cache
let shardConfigCache = null;

const BASE_URL = process.env.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const COUNT = Number.parseInt(process.env.COUNT || '120', 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '20', 10);
const USER_ID_PREFIX = process.env.USER_ID_PREFIX || 'user-loadtest';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ CLIENT_ID と CLIENT_SECRET は必須です。環境変数を設定してください。');
  process.exit(1);
}

if (!ADMIN_API_SECRET) {
  console.error('❌ ADMIN_API_SECRET は必須です。環境変数を設定してください。');
  process.exit(1);
}

const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

/**
 * Generate secure random string (base64url)
 */
function generateSecureRandomString(length = 96) {
  return crypto.randomBytes(length).toString('base64url');
}

/**
 * V3: Fetch shard configuration from Admin API
 * Returns { currentGeneration, currentShardCount, previousGenerations }
 */
async function fetchShardConfig(clientId = null) {
  if (shardConfigCache) {
    return shardConfigCache;
  }

  const queryParam = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  const res = await fetch(`${BASE_URL}/api/admin/settings/refresh-token-sharding${queryParam}`, {
    method: 'GET',
    headers: adminAuthHeader,
  });

  if (!res.ok) {
    // Fallback to default config if endpoint not available
    console.warn('⚠️  Shard config endpoint not available, using defaults');
    shardConfigCache = {
      currentGeneration: 1,
      currentShardCount: 8,
      previousGenerations: [],
    };
    return shardConfigCache;
  }

  const data = await res.json();
  shardConfigCache = data.config;
  console.log(`🔧 Shard config: generation=${shardConfigCache.currentGeneration}, shards=${shardConfigCache.currentShardCount}`);
  return shardConfigCache;
}

/**
 * V3: Calculate shard index from userId + clientId using SHA-256 hash
 * This must match the server-side implementation in refresh-token-sharding.ts
 */
async function calculateShardIndex(userId, clientId, shardCount) {
  const input = `${userId}:${clientId}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  // Use first 4 bytes as 32-bit integer
  const hashInt = (hashArray[0] << 24) | (hashArray[1] << 16) | (hashArray[2] << 8) | hashArray[3];
  return Math.abs(hashInt) % shardCount;
}

/**
 * V3: Create JTI in sharded format: v{generation}_{shardIndex}_{randomPart}
 */
function createShardedJti(generation, shardIndex, randomPart) {
  return `v${generation}_${shardIndex}_${randomPart}`;
}

/**
 * Fetch signing key with private key from Admin API
 */
async function fetchSigningKey() {
  console.log('🔑 Fetching signing key from Admin API...');

  const res = await fetch(`${BASE_URL}/api/admin/signing-key`, {
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
 * Create a signed Refresh Token JWT locally (V3 - with sharding support)
 *
 * @param {CryptoKey} privateKey - Signing key
 * @param {string} kid - Key ID
 * @param {object} claims - Token claims
 * @param {number} generation - Shard generation
 * @param {number} shardIndex - Shard index within generation
 * @param {number} expiresIn - Token expiration in seconds (default: 30 days)
 * @param {number} rtv - Refresh token version (default: 1)
 */
async function createRefreshToken(privateKey, kid, claims, generation, shardIndex, expiresIn = 2592000, rtv = 1) {
  const now = Math.floor(Date.now() / 1000);
  const randomPart = generateSecureRandomString(64);
  // V3: JTI format with generation and shard info
  const jti = createShardedJti(generation, shardIndex, randomPart);

  const token = await new SignJWT({
    ...claims,
    iat: now,
    exp: now + expiresIn,
    jti,
    rtv, // V2+: Refresh Token Version
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
    .sign(privateKey);

  return { token, jti, generation, shardIndex };
}

/**
 * Register token with RefreshTokenRotator via Admin API (V2)
 * Returns { version, jti, expiresIn }
 */
async function registerToken(token, userId, clientId, scope, ttl = 2592000) {
  const res = await fetch(`${BASE_URL}/api/admin/tokens/register`, {
    method: 'POST',
    headers: {
      ...adminAuthHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      token,
      userId,
      clientId,
      scope,
      ttl,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to register token: ${res.status} - ${error}`);
  }

  return await res.json();
}

/**
 * Generate a single token (V3: with sharding support)
 * Step 1: Calculate shard index from userId + clientId
 * Step 2: Generate JWT with V3 JTI format (v{gen}_{shard}_{random})
 * Step 3: Register with Admin API
 *
 * @param {CryptoKey} privateKey - Signing key
 * @param {string} kid - Key ID
 * @param {string} issuer - Token issuer
 * @param {string} scope - Token scope
 * @param {number} index - Token index (for unique user ID generation)
 * @param {object} shardConfig - Shard configuration { currentGeneration, currentShardCount }
 */
async function generateSingleToken(privateKey, kid, issuer, scope, index, shardConfig) {
  // V2+: Each token needs a unique user ID to avoid family conflicts
  const userId = `${USER_ID_PREFIX}-${index}`;

  // V3: Calculate shard index for this user
  const shardIndex = await calculateShardIndex(userId, CLIENT_ID, shardConfig.currentShardCount);

  const claims = {
    iss: issuer,
    sub: userId,
    aud: CLIENT_ID,
    scope,
    client_id: CLIENT_ID,
  };

  // V3: Generate token with sharded JTI
  const { token, jti, generation } = await createRefreshToken(
    privateKey,
    kid,
    claims,
    shardConfig.currentGeneration,
    shardIndex,
    2592000,
    1
  );

  // Register with Admin API - this stores the jti in the DO
  const result = await registerToken(token, userId, CLIENT_ID, scope);

  // V3: Include shard info for reference
  return {
    token,
    jti,
    rtv: result.version || 1,
    generation,
    shard_index: shardIndex,
    user_id: userId,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  };
}

/**
 * Generate a batch of tokens in parallel (V3: with sharding support)
 *
 * @param {CryptoKey} privateKey - Signing key
 * @param {string} kid - Key ID
 * @param {string} issuer - Token issuer
 * @param {string} scope - Token scope
 * @param {number} batchSize - Number of tokens in this batch
 * @param {number} startIndex - Starting index for user ID generation
 * @param {object} shardConfig - Shard configuration
 */
async function generateBatch(privateKey, kid, issuer, scope, batchSize, startIndex, shardConfig) {
  const promises = [];
  for (let i = 0; i < batchSize; i++) {
    const tokenIndex = startIndex + i;
    promises.push(
      generateSingleToken(privateKey, kid, issuer, scope, tokenIndex, shardConfig).catch((err) => ({
        error: err.message,
      }))
    );
  }
  return Promise.all(promises);
}

async function main() {
  console.log(`🚀 Parallel Refresh Token Generator (V3 - Sharding)`);
  console.log(`   BASE_URL       : ${BASE_URL}`);
  console.log(`   CLIENT_ID      : ${CLIENT_ID}`);
  console.log(`   USER_ID_PREFIX : ${USER_ID_PREFIX}`);
  console.log(`   COUNT          : ${COUNT}`);
  console.log(`   CONCURRENCY    : ${CONCURRENCY}`);
  console.log(`   OUTPUT_DIR     : ${OUTPUT_DIR}`);
  console.log(`   User IDs       : ${USER_ID_PREFIX}-0 ~ ${USER_ID_PREFIX}-${COUNT - 1}`);
  console.log('');

  // Step 1: Fetch signing key (once)
  const signingKey = await fetchSigningKey();
  const privateKey = await importPKCS8(signingKey.privatePEM, 'RS256');

  // Step 2: Fetch shard configuration (V3)
  const shardConfig = await fetchShardConfig(CLIENT_ID);
  console.log(`   Generation     : ${shardConfig.currentGeneration}`);
  console.log(`   Shard Count    : ${shardConfig.currentShardCount}`);

  console.log('');
  console.log('📊 Generating refresh tokens with V3 sharding...');

  const refreshTokens = [];
  let errorCount = 0;
  const startTime = Date.now();
  const scope = 'openid profile email';
  const issuer = BASE_URL.replace(/^https?:\/\//, 'https://');

  // Generate in batches
  const totalBatches = Math.ceil(COUNT / CONCURRENCY);
  let currentIndex = 0;

  for (let batch = 0; batch < totalBatches; batch++) {
    const remaining = COUNT - currentIndex;
    const batchSize = Math.min(CONCURRENCY, remaining);

    const results = await generateBatch(privateKey, signingKey.kid, issuer, scope, batchSize, currentIndex, shardConfig);
    currentIndex += batchSize;

    for (const result of results) {
      if (result.error) {
        errorCount++;
        console.error(`   ❌ ${result.error}`);
      } else {
        refreshTokens.push(result);
      }
    }

    const progress = refreshTokens.length;
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = progress / elapsed;

    // Progress log every batch or at the end
    if ((batch + 1) % 2 === 0 || batch === totalBatches - 1) {
      console.log(
        `   [${progress}/${COUNT}] ${rate.toFixed(1)}/s, errors: ${errorCount}, elapsed: ${elapsed.toFixed(1)}s`
      );
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;

  if (refreshTokens.length === 0) {
    throw new Error('No tokens generated. Aborting.');
  }

  // Save to file
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, 'refresh_tokens.json');
  fs.writeFileSync(outputPath, JSON.stringify(refreshTokens, null, 2));

  console.log('');
  console.log(`✅ Generated ${refreshTokens.length} refresh tokens (V3 with sharding) in ${totalTime.toFixed(2)}s`);
  console.log(`   Generation: ${shardConfig.currentGeneration}, Shards: ${shardConfig.currentShardCount}`);
  console.log(`   Rate: ${(refreshTokens.length / totalTime).toFixed(1)} tokens/sec`);
  console.log(`   Errors: ${errorCount}`);
  console.log(`📁 Saved to: ${outputPath}`);
  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
