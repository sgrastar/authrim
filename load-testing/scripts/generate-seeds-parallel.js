#!/usr/bin/env node

/**
 * 並列シードデータ生成スクリプト
 *
 * オリジナルのgenerate-seeds.jsを並列化して高速化
 * 10並列で実行し、約10倍の速度向上を目指す
 *
 * 使い方:
 *   CLIENT_ID=xxx CLIENT_SECRET=xxx ADMIN_API_SECRET=yyy node scripts/generate-seeds-parallel.js
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
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL || 'loadtest@example.com';
const AUTH_CODE_COUNT = Number.parseInt(process.env.AUTH_CODE_COUNT || '1000', 10);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds');

// 並列数（同時リクエスト数）
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '10', 10);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('CLIENT_ID と CLIENT_SECRET は必須です。');
  process.exit(1);
}

if (!ADMIN_API_SECRET) {
  console.error('ADMIN_API_SECRET は必須です。');
  process.exit(1);
}

const basicAuthHeader = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

let sessionCookie = '';

function randomVerifier() {
  return crypto.randomBytes(48).toString('base64url');
}

function codeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function ensureTestUser() {
  console.log(`  Finding/creating test user: ${TEST_USER_EMAIL}...`);

  const listRes = await fetch(`${BASE_URL}/api/admin/users?email=${encodeURIComponent(TEST_USER_EMAIL)}`, {
    headers: adminAuthHeader,
  });

  if (listRes.ok) {
    const data = await listRes.json();
    if (data.users && data.users.length > 0) {
      console.log(`  Found existing test user: ${data.users[0].id}`);
      return data.users[0];
    }
  }

  const createRes = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: {
      ...adminAuthHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: TEST_USER_EMAIL,
      name: 'Load Test User',
      email_verified: true,
    }),
  });

  if (!createRes.ok) {
    const error = await createRes.text();
    throw new Error(`Failed to create test user: ${createRes.status} - ${error}`);
  }

  const { user } = await createRes.json();
  console.log(`  Created test user: ${user.id}`);
  return user;
}

async function createTestSession(userId) {
  console.log(`  Creating test session for user: ${userId}...`);

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
    throw new Error(`Failed to create test session: ${res.status} - ${error}`);
  }

  const data = await res.json();
  console.log(`  Created test session: ${data.session_id}`);
  sessionCookie = `authrim_session=${data.session_id}`;
  return data;
}

async function fetchAuthorizationCode() {
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

  const res = await fetch(`${BASE_URL}/authorize?${params.toString()}`, {
    redirect: 'manual',
    headers: {
      Cookie: sessionCookie,
    },
  });

  if (res.status !== 302 && res.status !== 200) {
    const body = await res.text();
    throw new Error(`unexpected authorize status ${res.status}: ${body.substring(0, 200)}`);
  }

  const location = res.headers.get('location') || '';
  const body = await res.text();
  let code = null;

  if (location.includes('code=')) {
    const match = location.match(/code=([^&]+)/);
    if (match) code = match[1];
  }
  if (!code && body.includes('code=')) {
    const match = body.match(/code=([^&"'>]+)/);
    if (match) code = match[1];
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
}

/**
 * バッチで並列生成
 */
async function generateBatch(batchSize) {
  const promises = [];
  for (let i = 0; i < batchSize; i++) {
    promises.push(
      fetchAuthorizationCode().catch((err) => {
        return { error: err.message };
      })
    );
  }
  return Promise.all(promises);
}

async function main() {
  console.log(`🚀 Parallel seed generator (${CONCURRENCY} concurrent requests)`);
  console.log(`  BASE_URL        : ${BASE_URL}`);
  console.log(`  AUTH_CODE_COUNT : ${AUTH_CODE_COUNT}`);
  console.log(`  CONCURRENCY     : ${CONCURRENCY}`);
  console.log(`  OUTPUT_DIR      : ${OUTPUT_DIR}`);
  console.log('');

  // Step 1: Ensure test user exists
  console.log('📋 Step 1: Setting up test user...');
  const user = await ensureTestUser();

  // Step 2: Create test session
  console.log('🔐 Step 2: Creating test session...');
  await createTestSession(user.id);

  console.log('');
  console.log('📊 Step 3: Generating seeds in parallel...');

  const authCodes = [];
  let errorCount = 0;
  const startTime = Date.now();

  // バッチごとに処理
  const totalBatches = Math.ceil(AUTH_CODE_COUNT / CONCURRENCY);

  for (let batch = 0; batch < totalBatches; batch++) {
    const remaining = AUTH_CODE_COUNT - authCodes.length;
    const batchSize = Math.min(CONCURRENCY, remaining);

    const results = await generateBatch(batchSize);

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

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const authPath = path.join(OUTPUT_DIR, 'authorization_codes.json');
  fs.writeFileSync(authPath, JSON.stringify(authCodes, null, 2));
  console.log(`📁 Saved: ${authPath} (${authCodes.length} entries)`);

  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
