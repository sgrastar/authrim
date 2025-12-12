#!/usr/bin/env node

/**
 * Access Token シード生成スクリプト
 *
 * UserInfo/Introspectionベンチマークテスト用のアクセストークンを事前生成する。
 *
 * トークン種別（混合比率）:
 *   - Valid:   70% - 正常なトークン（exp=30日後）
 *   - Expired: 10% - 期限切れトークン（exp=過去）
 *   - Invalid: 10% - 不正なJWT（ランダム文字列）
 *   - Revoked: 10% - 正常に発行後、POST /revokeで無効化
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
 *
 * 使い方:
 *   CLIENT_ID=xxx CLIENT_SECRET=yyy ADMIN_API_SECRET=zzz node scripts/seed-access-tokens.js
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
const USER_ID_PREFIX = process.env.USER_ID_PREFIX || 'user-bench';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds');
const TEST_USERS_PATH = process.env.TEST_USERS_PATH || path.join(SCRIPT_DIR, '..', 'seeds', 'test_users.json');

// トークン種別の比率
const TOKEN_MIX = {
  valid: 0.7,
  expired: 0.1,
  invalid: 0.1,
  revoked: 0.1,
};

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
function generateSecureRandomString(length = 32) {
  return crypto.randomBytes(length).toString('base64url');
}

/**
 * Generate JTI (JWT ID)
 */
function generateJti() {
  return `at_${generateSecureRandomString(32)}`;
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
 * @returns {Promise<{token: string, jti: string, exp: number}>}
 */
async function createAccessToken(privateKey, kid, options) {
  const { userId, scope, expiresIn, issuer } = options;
  const now = Math.floor(Date.now() / 1000);
  const jti = generateJti();
  const exp = now + expiresIn;

  const token = await new SignJWT({
    iss: issuer,
    sub: userId,
    aud: issuer, // Access tokenのaudはissuerと同じ
    client_id: CLIENT_ID,
    scope,
    iat: now,
    exp,
    jti,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid })
    .sign(privateKey);

  return { token, jti, exp };
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
 * Revoke a token via /revoke endpoint
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
 * Determine token type based on distribution
 */
function determineTokenType(index, totalCount) {
  const validCount = Math.floor(totalCount * TOKEN_MIX.valid);
  const expiredCount = Math.floor(totalCount * TOKEN_MIX.expired);
  const invalidCount = Math.floor(totalCount * TOKEN_MIX.invalid);
  // Remaining goes to revoked

  if (index < validCount) return 'valid';
  if (index < validCount + expiredCount) return 'expired';
  if (index < validCount + expiredCount + invalidCount) return 'invalid';
  return 'revoked';
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

  if (tokenType === 'invalid') {
    return {
      access_token: createInvalidToken(),
      type: 'invalid',
      user_id: userId,
      jti: null,
      exp: null,
    };
  }

  // For valid, expired, and revoked: create real signed token
  const expiresIn =
    tokenType === 'expired'
      ? -3600 // 1 hour ago (expired)
      : 30 * 24 * 3600; // 30 days (valid/revoked)

  const { token, jti, exp } = await createAccessToken(privateKey, kid, {
    userId,
    scope,
    expiresIn,
    issuer,
  });

  return {
    access_token: token,
    type: tokenType,
    user_id: userId,
    jti,
    exp,
  };
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
 * Revoke tokens that should be revoked (in parallel)
 */
async function revokeTokensBatch(tokens, concurrency) {
  const revokedTokens = tokens.filter((t) => t.type === 'revoked' && t.access_token);
  if (revokedTokens.length === 0) return 0;

  console.log(`\n🔐 Revoking ${revokedTokens.length} tokens...`);

  let revokedCount = 0;
  const totalBatches = Math.ceil(revokedTokens.length / concurrency);

  for (let batch = 0; batch < totalBatches; batch++) {
    const start = batch * concurrency;
    const end = Math.min(start + concurrency, revokedTokens.length);
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

    if ((batch + 1) % 5 === 0 || batch === totalBatches - 1) {
      console.log(`   [${revokedCount}/${revokedTokens.length}] revoked`);
    }
  }

  return revokedCount;
}

async function main() {
  console.log(`🚀 Access Token Seed Generator`);
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
  console.log('');
  console.log(`📊 Token Distribution:`);
  console.log(`   Valid:   ${Math.floor(TOKEN_COUNT * TOKEN_MIX.valid)} (${TOKEN_MIX.valid * 100}%)`);
  console.log(
    `   Expired: ${Math.floor(TOKEN_COUNT * TOKEN_MIX.expired)} (${TOKEN_MIX.expired * 100}%)`
  );
  console.log(
    `   Invalid: ${Math.floor(TOKEN_COUNT * TOKEN_MIX.invalid)} (${TOKEN_MIX.invalid * 100}%)`
  );
  console.log(
    `   Revoked: ${TOKEN_COUNT - Math.floor(TOKEN_COUNT * (TOKEN_MIX.valid + TOKEN_MIX.expired + TOKEN_MIX.invalid))} (${TOKEN_MIX.revoked * 100}%)`
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
  const revokedCount = await revokeTokensBatch(tokens, CONCURRENCY);

  const totalTime = (Date.now() - startTime) / 1000;

  if (tokens.length === 0) {
    throw new Error('No tokens generated. Aborting.');
  }

  // Count by type
  const typeCounts = {
    valid: tokens.filter((t) => t.type === 'valid').length,
    expired: tokens.filter((t) => t.type === 'expired').length,
    invalid: tokens.filter((t) => t.type === 'invalid').length,
    revoked: tokens.filter((t) => t.type === 'revoked').length,
  };

  // Build output
  const output = {
    tokens,
    metadata: {
      generated_at: new Date().toISOString(),
      base_url: BASE_URL,
      client_id: CLIENT_ID,
      scope,
      counts: typeCounts,
      total: tokens.length,
    },
  };

  // Save to file
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, 'access_tokens.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log('');
  console.log(`✅ Generated ${tokens.length} access tokens in ${totalTime.toFixed(2)}s`);
  console.log(`   Valid:   ${typeCounts.valid}`);
  console.log(`   Expired: ${typeCounts.expired}`);
  console.log(`   Invalid: ${typeCounts.invalid}`);
  console.log(`   Revoked: ${typeCounts.revoked} (${revokedCount} actually revoked via API)`);
  console.log(`   Rate: ${(tokens.length / totalTime).toFixed(1)} tokens/sec`);
  console.log(`   Errors: ${errorCount}`);
  console.log(`📁 Saved to: ${outputPath}`);
  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
