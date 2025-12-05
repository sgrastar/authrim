#!/usr/bin/env node

/**
 * マルチユーザー並列シードデータ生成スクリプト
 *
 * ハッシュベースシャーディング対応: 128人のユーザーを作成し、
 * ラウンドロビンでリクエストを分散して全シャードに負荷を分散
 *
 * 使い方:
 *   CLIENT_ID=xxx CLIENT_SECRET=xxx ADMIN_API_SECRET=yyy node scripts/generate-seeds-multiuser.js
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://localhost:3000/callback';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const AUTH_CODE_COUNT = Number.parseInt(process.env.AUTH_CODE_COUNT || '1000', 10);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds');

// 並列数（同時リクエスト数）
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '30', 10);
// ユーザー数（シャード数と同じ128で分散）
const USER_COUNT = Number.parseInt(process.env.USER_COUNT || '128', 10);
// リクエストタイムアウト（ミリ秒）
const REQUEST_TIMEOUT = Number.parseInt(process.env.REQUEST_TIMEOUT || '10000', 10);
// リトライ回数
const MAX_RETRIES = Number.parseInt(process.env.MAX_RETRIES || '3', 10);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('CLIENT_ID と CLIENT_SECRET は必須です。');
  process.exit(1);
}

if (!ADMIN_API_SECRET) {
  console.error('ADMIN_API_SECRET は必須です。');
  process.exit(1);
}

const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

// ユーザーとセッションのプール
const userPool = [];

function randomVerifier() {
  return crypto.randomBytes(48).toString('base64url');
}

function codeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function createOrGetUser(index) {
  const email = `loadtest-${index}@example.com`;

  // 既存ユーザーを検索
  const listRes = await fetch(`${BASE_URL}/api/admin/users?email=${encodeURIComponent(email)}`, {
    headers: adminAuthHeader,
  });

  if (listRes.ok) {
    const data = await listRes.json();
    if (data.users && data.users.length > 0) {
      return data.users[0];
    }
  }

  // 新規作成
  const createRes = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: {
      ...adminAuthHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: email,
      name: `Load Test User ${index}`,
      email_verified: true,
    }),
  });

  if (!createRes.ok) {
    const error = await createRes.text();
    throw new Error(`Failed to create user ${index}: ${createRes.status} - ${error}`);
  }

  const { user } = await createRes.json();
  return user;
}

async function createSession(userId) {
  const res = await fetch(`${BASE_URL}/api/admin/test-sessions`, {
    method: 'POST',
    headers: {
      ...adminAuthHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: userId,
      ttl_seconds: 7200,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to create session for ${userId}: ${res.status} - ${error}`);
  }

  const data = await res.json();
  return `authrim_session=${data.session_id}`;
}

async function setupUserPool() {
  console.log(`📋 Setting up ${USER_COUNT} users for shard distribution...`);

  const batchSize = 10;
  for (let i = 0; i < USER_COUNT; i += batchSize) {
    const batch = [];
    const end = Math.min(i + batchSize, USER_COUNT);

    for (let j = i; j < end; j++) {
      batch.push(
        (async () => {
          const user = await createOrGetUser(j);
          const sessionCookie = await createSession(user.id);
          return { userId: user.id, sessionCookie };
        })()
      );
    }

    const results = await Promise.all(batch);
    userPool.push(...results);

    process.stdout.write(`\r  Created ${userPool.length}/${USER_COUNT} users...`);
  }

  console.log(`\n  ✅ ${userPool.length} users ready`);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      keepalive: false,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchAuthorizationCode(userIndex, retryCount = 0) {
  const { sessionCookie } = userPool[userIndex % userPool.length];

  const verifier = randomVerifier();
  const challenge = codeChallenge(verifier);
  const state = crypto.randomBytes(12).toString('hex');
  const nonce = crypto.randomBytes(12).toString('hex');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/authorize?${params.toString()}`,
      {
        redirect: 'manual',
        headers: {
          Cookie: sessionCookie,
        },
      },
      REQUEST_TIMEOUT
    );

    if (res.status !== 302 && res.status !== 200) {
      const body = await res.text();
      throw new Error(`unexpected authorize status ${res.status}: ${body.substring(0, 200)}`);
    }

    const location = res.headers.get('location') || '';
    const body = await res.text();
    let code = null;

    if (location.includes('code=')) {
      const match = location.match(/code=([^&]+)/);
      if (match) code = decodeURIComponent(match[1]);
    }
    if (!code && body.includes('code=')) {
      const match = body.match(/code=([^&"'>]+)/);
      if (match) code = decodeURIComponent(match[1]);
    }

    if (!code) {
      throw new Error('authorization code not found');
    }

    return {
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      state,
      nonce,
    };
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      // Exponential backoff: 100ms, 200ms, 400ms
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, retryCount)));
      return fetchAuthorizationCode(userIndex, retryCount + 1);
    }
    throw err;
  }
}

async function generateBatch(startIndex, batchSize) {
  const promises = [];
  for (let i = 0; i < batchSize; i++) {
    const userIndex = startIndex + i;
    promises.push(
      fetchAuthorizationCode(userIndex).catch((err) => {
        return { error: err.message };
      })
    );
  }
  return Promise.all(promises);
}

async function main() {
  console.log(`🚀 Multi-user parallel seed generator`);
  console.log(`  BASE_URL        : ${BASE_URL}`);
  console.log(`  AUTH_CODE_COUNT : ${AUTH_CODE_COUNT}`);
  console.log(`  CONCURRENCY     : ${CONCURRENCY}`);
  console.log(`  USER_COUNT      : ${USER_COUNT} (for shard distribution)`);
  console.log(`  OUTPUT_DIR      : ${OUTPUT_DIR}`);
  console.log('');

  // Step 1: Setup user pool
  await setupUserPool();

  console.log('');
  console.log('📊 Generating seeds in parallel (distributed across shards)...');

  const authCodes = [];
  let errorCount = 0;
  let requestIndex = 0;
  const startTime = Date.now();

  const totalBatches = Math.ceil(AUTH_CODE_COUNT / CONCURRENCY);

  for (let batch = 0; batch < totalBatches; batch++) {
    const remaining = AUTH_CODE_COUNT - authCodes.length;
    const batchSize = Math.min(CONCURRENCY, remaining);

    const results = await generateBatch(requestIndex, batchSize);
    requestIndex += batchSize;

    for (const result of results) {
      if (result.error) {
        errorCount++;
      } else {
        authCodes.push(result);
      }
    }

    const progress = authCodes.length;
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = progress / elapsed;

    if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
      console.log(
        `  [${progress}/${AUTH_CODE_COUNT}] ${rate.toFixed(1)}/s, errors: ${errorCount}, elapsed: ${elapsed.toFixed(1)}s`
      );
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;
  console.log('');
  console.log(`✅ Generation complete:`);
  console.log(`   Total: ${authCodes.length} codes`);
  console.log(`   Errors: ${errorCount}`);
  console.log(`   Time: ${totalTime.toFixed(1)}s`);
  console.log(`   Rate: ${(authCodes.length / totalTime).toFixed(1)} codes/sec`);

  if (authCodes.length === 0) {
    throw new Error('No seeds collected. Aborting.');
  }

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Save seeds
  const outputPath = path.join(OUTPUT_DIR, 'authorization_codes.json');
  fs.writeFileSync(outputPath, JSON.stringify(authCodes, null, 2));
  console.log(`\n📁 Saved ${authCodes.length} authorization codes to ${outputPath}`);
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
