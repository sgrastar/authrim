#!/usr/bin/env node

/**
 * Refresh Token 並列生成スクリプト
 *
 * ローカル署名 + Admin API 並列登録により高速生成
 * 120 tokens を 10秒以内で生成（理論値）
 *
 * 環境変数:
 *   BASE_URL             対象の Authrim Worker URL (default: https://conformance.authrim.com)
 *   CLIENT_ID            クライアント ID (required)
 *   CLIENT_SECRET        クライアントシークレット (required)
 *   ADMIN_API_SECRET     Admin API シークレット (required)
 *   COUNT                生成するトークン数 (default: 120)
 *   CONCURRENCY          並列数 (default: 20)
 *   USER_ID              ユーザー ID (default: user-oidc-conformance-test)
 *   OUTPUT_DIR           出力ディレクトリ (default: ../seeds)
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

const BASE_URL = process.env.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const COUNT = Number.parseInt(process.env.COUNT || '120', 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '20', 10);
const USER_ID = process.env.USER_ID || 'user-oidc-conformance-test';
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
 * Create a signed Refresh Token JWT locally
 */
async function createRefreshToken(privateKey, kid, claims, expiresIn = 2592000) {
  const now = Math.floor(Date.now() / 1000);
  const jti = generateSecureRandomString(96);

  const token = await new SignJWT({
    ...claims,
    iat: now,
    exp: now + expiresIn,
    jti,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
    .sign(privateKey);

  return { token, jti };
}

/**
 * Register token with RefreshTokenRotator via Admin API
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
 * Generate a single token (sign + register)
 */
async function generateSingleToken(privateKey, kid, issuer, scope) {
  const claims = {
    iss: issuer,
    sub: USER_ID,
    aud: CLIENT_ID,
    scope,
    client_id: CLIENT_ID,
  };

  const { token } = await createRefreshToken(privateKey, kid, claims);
  const result = await registerToken(token, USER_ID, CLIENT_ID, scope);

  return {
    token,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    family_id: result.familyId,
  };
}

/**
 * Generate a batch of tokens in parallel
 */
async function generateBatch(privateKey, kid, issuer, scope, batchSize) {
  const promises = [];
  for (let i = 0; i < batchSize; i++) {
    promises.push(
      generateSingleToken(privateKey, kid, issuer, scope).catch((err) => ({
        error: err.message,
      }))
    );
  }
  return Promise.all(promises);
}

async function main() {
  console.log(`🚀 Parallel Refresh Token Generator`);
  console.log(`   BASE_URL    : ${BASE_URL}`);
  console.log(`   CLIENT_ID   : ${CLIENT_ID}`);
  console.log(`   USER_ID     : ${USER_ID}`);
  console.log(`   COUNT       : ${COUNT}`);
  console.log(`   CONCURRENCY : ${CONCURRENCY}`);
  console.log(`   OUTPUT_DIR  : ${OUTPUT_DIR}`);
  console.log('');

  // Step 1: Fetch signing key (once)
  const signingKey = await fetchSigningKey();
  const privateKey = await importPKCS8(signingKey.privatePEM, 'RS256');

  console.log('');
  console.log('📊 Generating refresh tokens in parallel...');

  const refreshTokens = [];
  let errorCount = 0;
  const startTime = Date.now();
  const scope = 'openid profile email';
  const issuer = BASE_URL.replace(/^https?:\/\//, 'https://');

  // Generate in batches
  const totalBatches = Math.ceil(COUNT / CONCURRENCY);

  for (let batch = 0; batch < totalBatches; batch++) {
    const remaining = COUNT - refreshTokens.length;
    const batchSize = Math.min(CONCURRENCY, remaining);

    const results = await generateBatch(privateKey, signingKey.kid, issuer, scope, batchSize);

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
  console.log(`✅ Generated ${refreshTokens.length} refresh tokens in ${totalTime.toFixed(2)}s`);
  console.log(`   Rate: ${(refreshTokens.length / totalTime).toFixed(1)} tokens/sec`);
  console.log(`   Errors: ${errorCount}`);
  console.log(`📁 Saved to: ${outputPath}`);
  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
