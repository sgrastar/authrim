#!/usr/bin/env node

/**
 * 並列シードデータ生成スクリプト（事前作成ユーザー使用版）
 *
 * V3: 事前作成ユーザー対応
 * - seed-users.js で事前作成したユーザーを使用（test_users.json から読み込み）
 * - ユーザーは何度でも再利用可能（DBを初期化しない限り）
 * - userId:clientIdのハッシュでシャード決定（スティッキールーティング）
 *
 * 前提:
 *   事前に seed-users.js でユーザーを作成しておくこと
 *   例: USER_COUNT=500000 node scripts/seed-users.js
 *
 * 使い方:
 *   # 認可コードを生成（事前作成されたユーザーを使用）
 *   AUTH_CODE_COUNT=50000 node scripts/seed-authcodes.js
 *
 * 環境変数:
 *   BASE_URL          - 対象サーバー (default: https://conformance.authrim.com)
 *   CLIENT_ID         - OAuth クライアントID (必須)
 *   CLIENT_SECRET     - OAuth クライアントシークレット (必須)
 *   ADMIN_API_SECRET  - 管理API シークレット (必須)
 *   AUTH_CODE_COUNT   - 生成する認可コード数 (default: 1000)
 *   USER_COUNT        - 使用するユーザー数 (default: 全ユーザー)
 *   CONCURRENCY       - 並列数 (default: 10)
 *   SAVE_INTERVAL     - 自動保存間隔 (default: 500)
 *   OUTPUT_DIR        - 出力ディレクトリ (default: ./seeds)
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
// USER_COUNT: 使用するユーザー数（0 = 全ユーザー使用）
const USER_COUNT = Number.parseInt(process.env.USER_COUNT || '0', 10);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds');

// 並列数（同時リクエスト数）
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '10', 10);

// 自動保存間隔（この件数ごとにファイルに保存）
const SAVE_INTERVAL = Number.parseInt(process.env.SAVE_INTERVAL || '500', 10);

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

// マルチユーザー対応: ユーザーIDとセッションのマッピング
const userSessions = new Map(); // userId -> sessionCookie

// 事前作成されたユーザーファイル（seed-users.js で生成）
const TEST_USERS_FILE = path.join(OUTPUT_DIR, 'test_users.json');

/**
 * 事前作成されたユーザーリストをロード
 * @returns {{ userId: string, shardIndex: number }[]} ユーザー配列
 */
function loadPreCreatedUsers() {
  if (!fs.existsSync(TEST_USERS_FILE)) {
    console.error(`❌ ユーザーファイルが見つかりません: ${TEST_USERS_FILE}`);
    console.error('   先に seed-users.js でユーザーを作成してください:');
    console.error('   USER_COUNT=1000 node scripts/seed-users.js');
    process.exit(1);
  }

  try {
    const data = JSON.parse(fs.readFileSync(TEST_USERS_FILE, 'utf8'));
    if (Array.isArray(data)) {
      // 新形式: [{ index, userId, shardIndex }, ...]
      return data.map((d) => ({ userId: d.userId, shardIndex: d.shardIndex }));
    } else if (typeof data === 'object') {
      // 旧形式: { "key": userId, ... }
      return Object.values(data).map((userId) => ({
        userId,
        shardIndex: calculateShardIndex(userId, CLIENT_ID, 32),
      }));
    }
  } catch (err) {
    console.error(`❌ ユーザーファイルの読み込みに失敗: ${err.message}`);
    process.exit(1);
  }
  return [];
}

// 事前作成されたユーザーリスト（遅延ロード）
let preCreatedUsers = null;

// グローバル変数（シグナルハンドラからアクセス）
let allCodes = [];
let newCodesCount = 0;
let isShuttingDown = false;
let currentUserIndex = 0; // ラウンドロビン用

function randomVerifier() {
  return crypto.randomBytes(48).toString('base64url');
}

function codeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * FNV-1aハッシュでシャードインデックスを計算
 * サーバー側の getAuthCodeShardIndex と同じアルゴリズム
 */
function calculateShardIndex(userId, clientId, shardCount) {
  const input = `${userId}:${clientId}`;
  const FNV_PRIME = 0x01000193;
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash % shardCount;
}

/**
 * 既存のコードファイルを読み込む
 */
function loadExistingCodes() {
  const authPath = path.join(OUTPUT_DIR, 'authorization_codes.json');
  if (fs.existsSync(authPath)) {
    try {
      const content = fs.readFileSync(authPath, 'utf-8');
      const codes = JSON.parse(content);
      if (Array.isArray(codes)) {
        console.log(`  📂 Found existing file: ${codes.length} codes`);
        return codes;
      }
    } catch (err) {
      console.warn(`  ⚠️  Could not read existing file: ${err.message}`);
    }
  }
  return [];
}

/**
 * コードをファイルに保存
 */
function saveCodes(codes, label = '') {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const authPath = path.join(OUTPUT_DIR, 'authorization_codes.json');
  fs.writeFileSync(authPath, JSON.stringify(codes, null, 2));
  if (label) {
    console.log(`  💾 ${label}: Saved ${codes.length} codes to ${authPath}`);
  }
}

/**
 * グレースフルシャットダウン（Ctrl+C対応）
 */
function setupSignalHandlers() {
  const shutdown = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n\n⚠️  ${signal} received. Saving progress...`);
    if (allCodes.length > 0) {
      saveCodes(allCodes, 'Graceful shutdown');
    }
    console.log(`✅ Saved ${allCodes.length} codes (${newCodesCount} new in this session)`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * 単一ユーザーのテストセッションを作成
 */
async function createTestSession(userId) {
  const res = await fetch(`${BASE_URL}/api/admin/test-sessions`, {
    method: 'POST',
    headers: {
      ...adminAuthHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: userId,
      ttl_seconds: 28800, // 8 hours for load testing
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to create test session for ${userId}: ${res.status} - ${error}`);
  }

  const data = await res.json();
  return `authrim_session=${data.session_id}`;
}

/**
 * 事前作成されたユーザーのセッションを並列で作成
 */
async function setupPreCreatedUsers() {
  // 事前作成されたユーザーをロード
  preCreatedUsers = loadPreCreatedUsers();
  console.log(`  📂 Loaded ${preCreatedUsers.length} pre-created users from ${TEST_USERS_FILE}`);

  // 使用するユーザー数を決定
  const useCount = USER_COUNT > 0 ? Math.min(USER_COUNT, preCreatedUsers.length) : preCreatedUsers.length;
  const usersToUse = preCreatedUsers.slice(0, useCount);
  console.log(`  🔢 Using ${usersToUse.length} users for this run`);

  const shardCoverage = new Set();
  const batchSize = 50;
  let successCount = 0;
  let errorCount = 0;

  // 並列でセッションを作成
  for (let i = 0; i < usersToUse.length; i += batchSize) {
    const batch = usersToUse.slice(i, i + batchSize).map(async (user, idx) => {
      try {
        const sessionCookie = await createTestSession(user.userId);
        const shardIndex = user.shardIndex >= 0 ? user.shardIndex : calculateShardIndex(user.userId, CLIENT_ID, 32);
        shardCoverage.add(shardIndex);
        userSessions.set(user.userId, { sessionCookie, shardIndex, userIndex: i + idx });
        successCount++;
        return { userId: user.userId, shardIndex };
      } catch (err) {
        errorCount++;
        if (errorCount <= 3) {
          console.error(`  ⚠️  Failed to create session: ${err.message}`);
        }
        return null;
      }
    });

    await Promise.all(batch);

    if (i + batchSize < usersToUse.length) {
      process.stdout.write(`\r  [${successCount}/${usersToUse.length}] sessions created...`);
    }
  }

  console.log(`\n  ✅ Created ${successCount} sessions covering ${shardCoverage.size}/32 shards`);
  if (errorCount > 0) {
    console.log(`  ⚠️  ${errorCount} session creation failures`);
  }

  // シャード分布を表示
  const shardDist = {};
  for (const [, { shardIndex }] of userSessions) {
    shardDist[shardIndex] = (shardDist[shardIndex] || 0) + 1;
  }
  console.log(`  📊 Shard distribution: ${JSON.stringify(shardDist)}`);

  return successCount;
}

/**
 * 指定ユーザーのセッションで認可コードを取得
 */
async function fetchAuthorizationCode(userId, sessionCookie, shardIndex) {
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

  const location = res.headers.get('location') || '';
  const body = await res.text();

  // Check for OAuth error in redirect
  if (location.includes('error=')) {
    const errorMatch = location.match(/error=([^&]+)/);
    const descMatch = location.match(/error_description=([^&]+)/);
    const error = errorMatch ? decodeURIComponent(errorMatch[1]) : 'unknown';
    const desc = descMatch ? decodeURIComponent(descMatch[1]) : '';
    throw new Error(`OAuth error: ${error} - ${desc}`);
  }

  if (res.status !== 302 && res.status !== 200) {
    throw new Error(`unexpected authorize status ${res.status}: ${body.substring(0, 200)}`);
  }

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
    throw new Error(`authorization code not found in location=${location.substring(0, 100)}, status=${res.status}`);
  }

  return {
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    state,
    nonce,
    user_id: userId,
    shard_index: shardIndex,
  };
}

/**
 * 次のユーザーをラウンドロビンで選択
 */
function getNextUser() {
  const userIds = Array.from(userSessions.keys());
  const userId = userIds[currentUserIndex % userIds.length];
  currentUserIndex++;
  return { userId, ...userSessions.get(userId) };
}

/**
 * バッチで並列生成（ラウンドロビンでユーザー分散）
 */
async function generateBatch(batchSize) {
  const promises = [];
  for (let i = 0; i < batchSize; i++) {
    const { userId, sessionCookie, shardIndex } = getNextUser();
    promises.push(
      fetchAuthorizationCode(userId, sessionCookie, shardIndex).catch((err) => {
        return { error: err.message };
      })
    );
  }
  return Promise.all(promises);
}

async function main() {
  setupSignalHandlers();

  console.log(`🚀 Parallel seed generator (pre-created users)`);
  console.log(`  BASE_URL        : ${BASE_URL}`);
  console.log(`  AUTH_CODE_COUNT : ${AUTH_CODE_COUNT} (new codes to generate)`);
  console.log(`  USER_COUNT      : ${USER_COUNT === 0 ? 'all' : USER_COUNT} (users to use)`);
  console.log(`  CONCURRENCY     : ${CONCURRENCY}`);
  console.log(`  SAVE_INTERVAL   : ${SAVE_INTERVAL}`);
  console.log(`  OUTPUT_DIR      : ${OUTPUT_DIR}`);
  console.log('');

  // Step 0: Load existing codes
  console.log('📂 Step 0: Loading existing codes...');
  allCodes = loadExistingCodes();
  const existingCount = allCodes.length;
  console.log(`  Total existing: ${existingCount} codes`);
  console.log('');

  // Step 1: Load pre-created users and create sessions
  console.log('📋 Step 1: Setting up pre-created users...');
  const userCount = await setupPreCreatedUsers();
  if (userCount === 0) {
    console.error('❌ No users available. Please run seed-users.js first.');
    process.exit(1);
  }

  console.log('');
  console.log(`📊 Step 2: Generating ${AUTH_CODE_COUNT} new codes with shard distribution...`);

  let errorCount = 0;
  const startTime = Date.now();
  let lastSaveCount = 0;

  // バッチごとに処理
  const totalBatches = Math.ceil(AUTH_CODE_COUNT / CONCURRENCY);

  for (let batch = 0; batch < totalBatches && !isShuttingDown; batch++) {
    const remaining = AUTH_CODE_COUNT - newCodesCount;
    const batchSize = Math.min(CONCURRENCY, remaining);

    const results = await generateBatch(batchSize);

    for (const result of results) {
      if (result.error) {
        errorCount++;
        // Log first error for debugging
        if (errorCount === 1) {
          console.log(`  ⚠️  First error: ${result.error}`);
        }
      } else {
        allCodes.push(result);
        newCodesCount++;
      }
    }

    // インクリメンタル保存
    if (newCodesCount - lastSaveCount >= SAVE_INTERVAL) {
      saveCodes(allCodes, `Auto-save at ${newCodesCount} new codes`);
      lastSaveCount = newCodesCount;
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = newCodesCount / elapsed;

    if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
      console.log(
        `  [${newCodesCount}/${AUTH_CODE_COUNT}] ${rate.toFixed(1)}/s, errors: ${errorCount}, total: ${allCodes.length}`
      );
    }
  }

  // 最終保存
  const totalTime = (Date.now() - startTime) / 1000;
  console.log('');
  console.log(`✅ Generation complete:`);
  console.log(`   New codes: ${newCodesCount}`);
  console.log(`   Total codes: ${allCodes.length}`);
  console.log(`   Errors: ${errorCount}`);
  console.log(`   Time: ${totalTime.toFixed(1)}s`);
  console.log(`   Rate: ${(newCodesCount / totalTime).toFixed(1)} codes/sec`);

  if (allCodes.length === 0) {
    throw new Error('No seeds collected. Aborting.');
  }

  saveCodes(allCodes, 'Final save');
  console.log('');
  console.log(`📁 Total: ${allCodes.length} codes in ${path.join(OUTPUT_DIR, 'authorization_codes.json')}`);
  console.log('');
  console.log('💡 Tip: Run again to add more codes. Use AUTH_CODE_COUNT=2000 for batches.');
  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  // エラー時も保存を試みる
  if (allCodes.length > 0) {
    console.log('⚠️  Error occurred, but saving collected codes...');
    saveCodes(allCodes, 'Error recovery save');
  }
  process.exit(1);
});
