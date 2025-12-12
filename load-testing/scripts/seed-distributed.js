#!/usr/bin/env node

/**
 * クライアント別分散シード生成スクリプト
 *
 * setup-test-clients.js で作成した複数クライアント用に、それぞれの Refresh Token を生成する。
 * ローカル署名 + Admin API 登録により高速生成（ネットワーク経由の authorize フロー不要）。
 *
 * 環境変数:
 *   BASE_URL             対象の Authrim Worker URL (default: https://conformance.authrim.com)
 *   ADMIN_API_SECRET     Admin API シークレット (required)
 *   TOKENS_PER_CLIENT    各クライアントあたりのトークン数 (default: 50)
 *   TEST_DURATION        テスト時間（秒）- トークン数自動計算用 (default: 300)
 *   INPUT_FILE           クライアント情報ファイル (default: ../seeds/distributed/clients.json)
 *   OUTPUT_DIR           出力ディレクトリ (default: ../seeds/distributed)
 *   USER_ID              ユーザー ID (default: user-oidc-conformance-test)
 *
 * 使い方:
 *   ADMIN_API_SECRET=xxx node scripts/generate-distributed-seeds.js
 *   ADMIN_API_SECRET=xxx TEST_DURATION=600 node scripts/generate-distributed-seeds.js
 */

import { SignJWT, importPKCS8 } from 'jose';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env.BASE_URL || 'https://conformance.authrim.com';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const TOKENS_PER_CLIENT = Number.parseInt(process.env.TOKENS_PER_CLIENT || '50', 10);
const TEST_DURATION = Number.parseInt(process.env.TEST_DURATION || '300', 10);
const USER_ID = process.env.USER_ID || 'user-oidc-conformance-test';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INPUT_FILE =
  process.env.INPUT_FILE || path.join(SCRIPT_DIR, '..', 'seeds', 'distributed', 'clients.json');
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds', 'distributed');

if (!ADMIN_API_SECRET) {
  console.error('❌ ADMIN_API_SECRET は必須です。環境変数を設定してください。');
  process.exit(1);
}

const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

/**
 * Generate secure random string
 */
function generateSecureRandomString(length = 96) {
  return crypto.randomBytes(length).toString('base64url');
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
  const res = await fetch(`${BASE_URL}/api/admin/test/tokens`, {
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
 * 各クライアントに必要なトークン数を計算
 *
 * @param {Object} client クライアント情報
 * @param {number} testDuration テスト時間（秒）
 * @returns {number} 必要なトークン数
 */
function calculateTokensNeeded(client, testDuration) {
  // 各クライアントの target_rps × テスト時間でおおよその必要トークン数を計算
  // バッファとして 1.5 倍確保
  const baseTokens = Math.ceil(client.target_rps * testDuration * 1.5);
  return Math.max(TOKENS_PER_CLIENT, baseTokens);
}

async function main() {
  console.log(`🔨 Authrim Distributed Seed Generator`);
  console.log(`   BASE_URL          : ${BASE_URL}`);
  console.log(`   INPUT_FILE        : ${INPUT_FILE}`);
  console.log(`   OUTPUT_DIR        : ${OUTPUT_DIR}`);
  console.log(`   TEST_DURATION     : ${TEST_DURATION}s`);
  console.log(`   TOKENS_PER_CLIENT : ${TOKENS_PER_CLIENT} (minimum)`);
  console.log(`   USER_ID           : ${USER_ID}`);
  console.log('');

  // クライアント情報を読み込み
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Client file not found: ${INPUT_FILE}`);
    console.error('   Run setup-test-clients.js first to create test clients.');
    process.exit(1);
  }

  const clientData = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf-8'));
  const clients = clientData.clients;

  if (!clients || clients.length === 0) {
    console.error('❌ No clients found in client file.');
    process.exit(1);
  }

  console.log(`📋 Found ${clients.length} clients`);
  console.log('');

  // 署名鍵を取得
  const signingKey = await fetchSigningKey();
  const privateKey = await importPKCS8(signingKey.privatePEM, 'RS256');
  console.log('');

  const startTime = Date.now();
  const scope = 'openid profile email';
  const issuer = BASE_URL.replace(/^https?:\/\//, 'https://');

  // 各クライアント用のシードを生成
  console.log('📊 Generating seeds for each client...');
  console.log('');

  const allClientSeeds = [];
  let totalTokens = 0;

  for (const client of clients) {
    const tokensNeeded = calculateTokensNeeded(client, TEST_DURATION);
    console.log(
      `   Processing ${client.client_name} (${client.load_level}, ${client.target_rps} RPS) - ${tokensNeeded} tokens...`
    );

    const clientSeeds = [];

    for (let i = 0; i < tokensNeeded; i++) {
      try {
        const claims = {
          iss: issuer,
          sub: USER_ID,
          aud: client.client_id,
          scope,
          client_id: client.client_id,
        };

        const { token, jti } = await createRefreshToken(privateKey, signingKey.kid, claims);
        const result = await registerToken(token, USER_ID, client.client_id, scope);

        clientSeeds.push({
          token,
          client_id: client.client_id,
          client_secret: client.client_secret,
          family_id: result.familyId,
        });
      } catch (err) {
        console.error(`      ❌ Token generation failed (#${i + 1}): ${err.message}`);
      }

      // Rate limiting protection
      if ((i + 1) % 10 === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // クライアント別ディレクトリにシードを保存
    const clientDir = path.join(OUTPUT_DIR, client.client_id);
    fs.mkdirSync(clientDir, { recursive: true });
    const seedPath = path.join(clientDir, 'refresh_tokens.json');
    fs.writeFileSync(seedPath, JSON.stringify(clientSeeds, null, 2));

    console.log(`      ✅ Generated ${clientSeeds.length} tokens → ${seedPath}`);

    // 統合データに追加
    allClientSeeds.push({
      client_id: client.client_id,
      client_secret: client.client_secret,
      client_name: client.client_name,
      load_level: client.load_level,
      target_rps: client.target_rps,
      token_count: clientSeeds.length,
      seeds: clientSeeds,
    });

    totalTokens += clientSeeds.length;
  }

  // 統合シードファイルを保存（k6 で読み込み用）
  const combinedPath = path.join(OUTPUT_DIR, 'all_seeds.json');
  const combinedData = {
    metadata: {
      created_at: new Date().toISOString(),
      base_url: BASE_URL,
      total_clients: clients.length,
      total_tokens: totalTokens,
      test_duration: TEST_DURATION,
    },
    clients: allClientSeeds,
  };
  fs.writeFileSync(combinedPath, JSON.stringify(combinedData, null, 2));

  const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('');
  console.log(`✅ Generated ${totalTokens} total tokens in ${elapsedTime}s`);
  console.log(`📁 Combined seeds: ${combinedPath}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Run test4-distributed-load.js to execute distributed load test');
  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
