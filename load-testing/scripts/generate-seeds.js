#!/usr/bin/env node

/**
 * シードデータ生成スクリプト
 *
 * - テストユーザーを作成（または既存を使用）
 * - テストセッションを作成
 * - /authorize を叩いて有効な authorization code + PKCE verifier を収集
 * - /token まで交換して Refresh Token を収集
 *
 * 事前条件:
 * - テスト用クライアントの CLIENT_ID / CLIENT_SECRET
 * - ADMIN_API_SECRET（Admin API認証用 - 必須）
 *
 * 使い方:
 *   CLIENT_ID=xxx CLIENT_SECRET=xxx ADMIN_API_SECRET=yyy node scripts/generate-seeds.js
 *
 * 環境変数:
 *   BASE_URL             対象の Authrim Worker URL (default: https://conformance.authrim.com)
 *   CLIENT_ID            クライアント ID (required)
 *   CLIENT_SECRET        クライアントシークレット (required)
 *   REDIRECT_URI         redirect_uri (default: https://localhost:3000/callback)
 *   ADMIN_API_SECRET     Admin API シークレット（Bearer トークン認証用 - required）
 *   TEST_USER_EMAIL      テストユーザーのメールアドレス (default: loadtest@example.com)
 *   AUTH_CODE_COUNT      生成する authorization code 数 (default: 200)
 *   REFRESH_COUNT        生成する refresh token 数 (default: 200)
 *   OUTPUT_DIR           出力ディレクトリ (default: ../seeds)
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
const AUTH_CODE_COUNT = Number.parseInt(process.env.AUTH_CODE_COUNT || '200', 10);
const REFRESH_COUNT = Number.parseInt(process.env.REFRESH_COUNT || '200', 10);
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

const basicAuthHeader = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

// Session cookie for authorization requests
let sessionCookie = '';

function randomVerifier() {
  return crypto.randomBytes(48).toString('base64url');
}

function codeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Create or find a test user
 */
async function ensureTestUser() {
  console.log(`  Creating/finding test user: ${TEST_USER_EMAIL}...`);

  // Try to find existing user
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

  // Create new user
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

/**
 * Create a test session for the user
 */
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
      ttl_seconds: 7200, // 2 hours - enough for seed generation
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to create test session: ${res.status} - ${error}`);
  }

  const data = await res.json();
  console.log(`  Created test session: ${data.session_id}`);

  // Extract the cookie value
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
    // Debug: show first part of response
    console.error(`  Debug - Location: ${location.substring(0, 100)}`);
    console.error(`  Debug - Body preview: ${body.substring(0, 200)}`);
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

async function exchangeForRefreshToken(authz) {
  const payload = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authz.code,
    redirect_uri: authz.redirect_uri,
    code_verifier: authz.code_verifier,
  }).toString();

  const res = await fetch(`${BASE_URL}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader,
    },
    body: payload,
  });

  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch (_) {
    // ignore
  }

  if (res.status !== 200 || !json.refresh_token) {
    throw new Error(`token exchange failed (status ${res.status}): ${text}`);
  }

  return json.refresh_token;
}

async function main() {
  console.log(`🔨 Authrim seed generator`);
  console.log(`  BASE_URL        : ${BASE_URL}`);
  console.log(`  REDIRECT_URI    : ${REDIRECT_URI}`);
  console.log(`  TEST_USER_EMAIL : ${TEST_USER_EMAIL}`);
  console.log(`  AUTH_CODE_CNT   : ${AUTH_CODE_COUNT}`);
  console.log(`  REFRESH_CNT     : ${REFRESH_COUNT}`);
  console.log(`  OUTPUT_DIR      : ${OUTPUT_DIR}`);
  console.log(`  ADMIN_API_SECRET: ${ADMIN_API_SECRET ? '(set)' : '(not set)'}`);
  console.log('');

  // Step 1: Ensure test user exists
  console.log('📋 Step 1: Setting up test user...');
  const user = await ensureTestUser();

  // Step 2: Create test session
  console.log('🔐 Step 2: Creating test session...');
  await createTestSession(user.id);

  console.log('');
  console.log('📊 Step 3: Generating seeds...');

  const authCodes = [];
  const refreshTokens = [];

  for (let i = 0; i < AUTH_CODE_COUNT; i++) {
    try {
      const authz = await fetchAuthorizationCode();
      authCodes.push(authz);
      if ((i + 1) % 20 === 0)
        console.log(`  collected ${i + 1}/${AUTH_CODE_COUNT} authorization codes`);
      await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      console.error(`❌ authorize failed (#${i + 1}): ${err.message}`);
    }
  }

  for (let i = 0; i < REFRESH_COUNT; i++) {
    try {
      const authz = await fetchAuthorizationCode();
      const refresh = await exchangeForRefreshToken(authz);
      refreshTokens.push({ refresh_token: refresh });
      if ((i + 1) % 20 === 0) console.log(`  collected ${i + 1}/${REFRESH_COUNT} refresh tokens`);
      await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      console.error(`❌ refresh generation failed (#${i + 1}): ${err.message}`);
    }
  }

  if (!authCodes.length && !refreshTokens.length) {
    throw new Error('no seeds collected. Aborting.');
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (authCodes.length) {
    const authPath = path.join(OUTPUT_DIR, 'authorization_codes.json');
    fs.writeFileSync(authPath, JSON.stringify(authCodes, null, 2));
    console.log(`✅ authorization codes saved: ${authPath} (${authCodes.length} entries)`);
  }

  if (refreshTokens.length) {
    const refreshPath = path.join(OUTPUT_DIR, 'refresh_tokens.json');
    fs.writeFileSync(refreshPath, JSON.stringify(refreshTokens, null, 2));
    console.log(`✅ refresh tokens saved: ${refreshPath} (${refreshTokens.length} entries)`);
  }

  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
