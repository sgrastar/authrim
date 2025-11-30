#!/usr/bin/env node

/**
 * シードデータ生成スクリプト
 *
 * - /authorize を叩いて有効な authorization code + PKCE verifier を収集
 * - /token まで交換して Refresh Token を収集
 *
 * 事前条件:
 * - テスト用クライアントの CLIENT_ID / CLIENT_SECRET
 * - ADMIN_API_SECRET（Admin API認証用）
 *
 * 使い方:
 *   CLIENT_ID=xxx CLIENT_SECRET=xxx ADMIN_API_SECRET=yyy node scripts/generate-seeds.js
 *
 * 環境変数:
 *   BASE_URL             対象の Authrim Worker URL (default: https://conformance.authrim.com)
 *   CLIENT_ID            クライアント ID (required)
 *   CLIENT_SECRET        クライアントシークレット (required)
 *   REDIRECT_URI         redirect_uri (default: https://example.com/callback)
 *   ADMIN_API_SECRET     Admin API シークレット（Bearer トークン認証用）
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
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://example.com/callback';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const AUTH_CODE_COUNT = Number.parseInt(process.env.AUTH_CODE_COUNT || '200', 10);
const REFRESH_COUNT = Number.parseInt(process.env.REFRESH_COUNT || '200', 10);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('CLIENT_ID と CLIENT_SECRET は必須です。環境変数を設定してください。');
  process.exit(1);
}

if (!ADMIN_API_SECRET) {
  console.warn('ADMIN_API_SECRET が設定されていません。認証が必要な場合、コード取得に失敗します。');
}

const basicAuthHeader = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;

function randomVerifier() {
  return crypto.randomBytes(48).toString('base64url');
}

function codeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
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
    headers: ADMIN_API_SECRET ? { Authorization: `Bearer ${ADMIN_API_SECRET}` } : {},
  });

  if (res.status !== 302 && res.status !== 200) {
    throw new Error(`unexpected authorize status ${res.status}`);
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
    throw new Error('authorization code not found (login/consent required?)');
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
  console.log(`  AUTH_CODE_CNT   : ${AUTH_CODE_COUNT}`);
  console.log(`  REFRESH_CNT     : ${REFRESH_COUNT}`);
  console.log(`  OUTPUT_DIR      : ${OUTPUT_DIR}`);
  console.log(`  ADMIN_API_SECRET: ${ADMIN_API_SECRET ? '(set)' : '(not set)'}`);
  console.log('');

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
