#!/usr/bin/env node

/**
 * ローカル Refresh Token 生成スクリプト
 *
 * ネットワーク経由で authorize → token エンドポイントを呼び出す代わりに、
 * 秘密鍵をローカルで取得して JWT を署名し、RefreshTokenRotator に直接登録する。
 *
 * メリット:
 * - 高速 (約 2-3 分 → 約 3-6 秒 for 120 tokens)
 * - ネットワークオーバーヘッドなし
 * - ローカルで署名するため、/authorize フローが不要
 *
 * 環境変数:
 *   BASE_URL             対象の Authrim Worker URL (default: https://conformance.authrim.com)
 *   CLIENT_ID            クライアント ID (required)
 *   CLIENT_SECRET        クライアントシークレット (required)
 *   ADMIN_API_SECRET     Admin API シークレット (required)
 *   COUNT                生成するトークン数 (default: 120)
 *   USER_ID              ユーザー ID (default: user-oidc-conformance-test)
 *   OUTPUT_DIR           出力ディレクトリ (default: ../seeds)
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
const USER_ID = process.env.USER_ID || 'user-oidc-conformance-test';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('CLIENT_ID と CLIENT_SECRET は必須です。環境変数を設定してください。');
  process.exit(1);
}

if (!ADMIN_API_SECRET) {
  console.error('ADMIN_API_SECRET は必須です。環境変数を設定してください。');
  process.exit(1);
}

const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

/**
 * Generate secure random string (base64url, ~128 characters)
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

async function main() {
  console.log(`🔨 Authrim Local Refresh Token Generator`);
  console.log(`   BASE_URL   : ${BASE_URL}`);
  console.log(`   CLIENT_ID  : ${CLIENT_ID}`);
  console.log(`   USER_ID    : ${USER_ID}`);
  console.log(`   COUNT      : ${COUNT}`);
  console.log(`   OUTPUT_DIR : ${OUTPUT_DIR}`);
  console.log('');

  const startTime = Date.now();

  // Step 1: Fetch signing key (once)
  const signingKey = await fetchSigningKey();
  const privateKey = await importPKCS8(signingKey.privatePEM, 'RS256');

  console.log('');
  console.log('📊 Generating refresh tokens locally...');

  const refreshTokens = [];
  const scope = 'openid profile email';
  const issuer = BASE_URL.replace(/^https?:\/\//, 'https://');

  for (let i = 0; i < COUNT; i++) {
    try {
      // Create claims for the refresh token
      const claims = {
        iss: issuer,
        sub: USER_ID,
        aud: CLIENT_ID,
        scope,
        client_id: CLIENT_ID,
      };

      // Sign the token locally
      const { token, jti } = await createRefreshToken(privateKey, signingKey.kid, claims);

      // Register with RefreshTokenRotator
      const result = await registerToken(token, USER_ID, CLIENT_ID, scope);

      refreshTokens.push({
        token,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        family_id: result.familyId,
      });

      if ((i + 1) % 20 === 0) {
        console.log(`   Generated ${i + 1}/${COUNT} tokens`);
      }
    } catch (err) {
      console.error(`❌ Token generation failed (#${i + 1}): ${err.message}`);
    }
  }

  if (!refreshTokens.length) {
    throw new Error('No tokens generated. Aborting.');
  }

  // Save to file
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, 'refresh_tokens.json');
  fs.writeFileSync(outputPath, JSON.stringify(refreshTokens, null, 2));

  const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('');
  console.log(`✅ Generated ${refreshTokens.length} refresh tokens in ${elapsedTime}s`);
  console.log(`   Saved to: ${outputPath}`);
  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
