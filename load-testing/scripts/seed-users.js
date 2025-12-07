#!/usr/bin/env node

/**
 * ユーザー事前作成スクリプト
 *
 * 負荷テスト用にユーザーを大量に事前作成し、UIDをキャッシュに保存します。
 * シード生成前に実行することで、ユーザー作成とシード生成を分離できます。
 *
 * 使い方:
 *   # 500,000ユーザーを作成
 *   USER_COUNT=500000 node scripts/seed-users.js
 *
 *   # 続きから作成（既存のキャッシュファイルがあれば追記）
 *   USER_COUNT=100000 node scripts/seed-users.js
 *
 * 環境変数:
 *   BASE_URL          - 対象サーバー (default: https://conformance.authrim.com)
 *   ADMIN_API_SECRET  - 管理API シークレット (必須)
 *   USER_COUNT        - 作成するユーザー数 (default: 10000)
 *   CONCURRENCY       - 並列数 (default: 50)
 *   SAVE_INTERVAL     - 自動保存間隔 (default: 1000)
 *   OUTPUT_DIR        - 出力ディレクトリ (default: ./seeds)
 *   CLIENT_ID         - シャード計算用クライアントID (optional)
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env.BASE_URL || 'https://conformance.authrim.com';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const USER_COUNT = Number.parseInt(process.env.USER_COUNT || '10000', 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '50', 10);
const SAVE_INTERVAL = Number.parseInt(process.env.SAVE_INTERVAL || '1000', 10);
const CLIENT_ID = process.env.CLIENT_ID || '';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds');

// 出力ファイル（永続保存・再利用可能）
const TEST_USERS_FILE = path.join(OUTPUT_DIR, 'test_users.json');
const TEST_USERS_TXT = path.join(OUTPUT_DIR, 'test_users.txt'); // シンプルなテキスト形式（1行1ユーザーID）

if (!ADMIN_API_SECRET) {
  console.error('ADMIN_API_SECRET は必須です。');
  process.exit(1);
}

const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

// グローバル変数
let userMap = new Map(); // index -> userId
let newUsersCount = 0;
let isShuttingDown = false;

/**
 * FNV-1aハッシュでシャードインデックスを計算
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
 * 既存のユーザーキャッシュを読み込む
 */
function loadExistingUsers() {
  if (fs.existsSync(TEST_USERS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TEST_USERS_FILE, 'utf8'));
      // 配列形式とオブジェクト形式の両方に対応
      if (Array.isArray(data)) {
        // 配列形式: [{ index, userId, shardIndex }, ...]
        const map = new Map();
        for (const entry of data) {
          map.set(entry.index, { userId: entry.userId, shardIndex: entry.shardIndex });
        }
        console.log(`  📂 Found existing file: ${map.size} users`);
        return map;
      } else if (typeof data === 'object') {
        // オブジェクト形式: { "prefix:index": userId, ... } (旧形式)
        const map = new Map();
        for (const [key, userId] of Object.entries(data)) {
          const parts = key.split(':');
          const index = Number.parseInt(parts[parts.length - 1], 10);
          if (!Number.isNaN(index)) {
            map.set(index, { userId, shardIndex: -1 });
          }
        }
        console.log(`  📂 Found existing file (legacy format): ${map.size} users`);
        return map;
      }
    } catch (err) {
      console.warn(`  ⚠️  Could not read existing file: ${err.message}`);
    }
  }
  return new Map();
}

/**
 * ユーザーリストを保存（永続ファイル）
 * - JSON形式: 詳細情報（インデックス、シャード）付き
 * - TXT形式: 1行1ユーザーID（シンプルで再利用しやすい）
 */
function saveUsers(map, label = '') {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 配列形式で保存（シャードインデックス付き）
  const data = [];
  for (const [index, entry] of map) {
    data.push({
      index,
      userId: entry.userId,
      shardIndex: entry.shardIndex,
    });
  }

  // インデックス順にソート
  data.sort((a, b) => a.index - b.index);

  // JSON形式で保存
  fs.writeFileSync(TEST_USERS_FILE, JSON.stringify(data, null, 2));

  // TXT形式で保存（1行1ユーザーID）
  const userIds = data.map((d) => d.userId).join('\n');
  fs.writeFileSync(TEST_USERS_TXT, userIds + '\n');

  if (label) {
    console.log(`  💾 ${label}: Saved ${data.length} users`);
    console.log(`     JSON: ${TEST_USERS_FILE}`);
    console.log(`     TXT:  ${TEST_USERS_TXT}`);
  }
}

/**
 * グレースフルシャットダウン
 */
function setupSignalHandlers() {
  const shutdown = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n\n⚠️  ${signal} received. Saving progress...`);
    if (userMap.size > 0) {
      saveUsers(userMap, 'Graceful shutdown');
    }
    console.log(`✅ Saved ${userMap.size} users (${newUsersCount} new in this session)`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * 単一ユーザーを作成
 */
async function createUser(index) {
  // ユニークなメールアドレスを生成（タイムスタンプ + インデックス）
  const timestamp = Date.now();
  const email = `loadtest-${timestamp}-${index}@test.authrim.internal`;

  const res = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: {
      ...adminAuthHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      name: `Load Test User ${index}`,
      email_verified: true, // 検証済みとして作成
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to create user ${index}: ${res.status} - ${error}`);
  }

  const { user } = await res.json();
  return user;
}

/**
 * バッチでユーザー作成
 */
async function createUserBatch(startIndex, batchSize, existingMap) {
  const promises = [];

  for (let i = 0; i < batchSize; i++) {
    const index = startIndex + i;

    // 既存のユーザーはスキップ
    if (existingMap.has(index)) {
      continue;
    }

    promises.push(
      (async () => {
        try {
          const user = await createUser(index);
          const shardIndex = CLIENT_ID ? calculateShardIndex(user.id, CLIENT_ID, 32) : -1;
          return { index, userId: user.id, shardIndex };
        } catch (err) {
          return { index, error: err.message };
        }
      })()
    );
  }

  return Promise.all(promises);
}

async function main() {
  setupSignalHandlers();

  console.log(`🚀 User pre-creation script`);
  console.log(`  BASE_URL        : ${BASE_URL}`);
  console.log(`  USER_COUNT      : ${USER_COUNT} (target total)`);
  console.log(`  CONCURRENCY     : ${CONCURRENCY}`);
  console.log(`  SAVE_INTERVAL   : ${SAVE_INTERVAL}`);
  console.log(`  OUTPUT_DIR      : ${OUTPUT_DIR}`);
  if (CLIENT_ID) {
    console.log(`  CLIENT_ID       : ${CLIENT_ID} (for shard calculation)`);
  }
  console.log('');

  // Step 1: Load existing users
  console.log('📂 Step 1: Loading existing users...');
  userMap = loadExistingUsers();
  const existingCount = userMap.size;
  console.log(`  Total existing: ${existingCount} users`);

  // 必要な新規作成数を計算
  const neededCount = USER_COUNT - existingCount;
  if (neededCount <= 0) {
    console.log('');
    console.log(`✅ Already have ${existingCount} users (target: ${USER_COUNT})`);
    console.log('💡 Increase USER_COUNT to add more users.');
    return;
  }

  console.log('');
  console.log(`📊 Step 2: Creating ${neededCount} new users...`);

  let errorCount = 0;
  const startTime = Date.now();
  let lastSaveCount = 0;
  let firstError = null;

  // 既存のインデックスの最大値を見つけて、そこから続ける
  let startIndex = 0;
  for (const idx of userMap.keys()) {
    if (idx >= startIndex) {
      startIndex = idx + 1;
    }
  }

  // バッチ処理
  const totalBatches = Math.ceil(neededCount / CONCURRENCY);

  for (let batch = 0; batch < totalBatches && !isShuttingDown; batch++) {
    const remaining = neededCount - newUsersCount;
    const batchSize = Math.min(CONCURRENCY, remaining);
    const batchStartIndex = startIndex + batch * CONCURRENCY;

    const results = await createUserBatch(batchStartIndex, batchSize, userMap);

    for (const result of results) {
      if (result.error) {
        errorCount++;
        if (!firstError) {
          firstError = result.error;
          console.log(`  ⚠️  First error: ${result.error}`);
        }
      } else {
        userMap.set(result.index, { userId: result.userId, shardIndex: result.shardIndex });
        newUsersCount++;
      }
    }

    // インクリメンタル保存
    if (newUsersCount - lastSaveCount >= SAVE_INTERVAL) {
      saveUsers(userMap, `Auto-save at ${newUsersCount} new users`);
      lastSaveCount = newUsersCount;
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = newUsersCount / elapsed;

    if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
      console.log(
        `  [${newUsersCount}/${neededCount}] ${rate.toFixed(1)}/s, errors: ${errorCount}, total: ${userMap.size}`
      );
    }
  }

  // 最終保存
  const totalTime = (Date.now() - startTime) / 1000;
  console.log('');
  console.log(`✅ Creation complete:`);
  console.log(`   New users: ${newUsersCount}`);
  console.log(`   Total users: ${userMap.size}`);
  console.log(`   Errors: ${errorCount}`);
  console.log(`   Time: ${totalTime.toFixed(1)}s`);
  console.log(`   Rate: ${(newUsersCount / totalTime).toFixed(1)} users/sec`);

  saveUsers(userMap, 'Final save');

  // シャード分布を表示（CLIENT_IDが指定されている場合）
  if (CLIENT_ID) {
    const shardDist = {};
    for (const [, entry] of userMap) {
      if (entry.shardIndex >= 0) {
        shardDist[entry.shardIndex] = (shardDist[entry.shardIndex] || 0) + 1;
      }
    }
    const coveredShards = Object.keys(shardDist).length;
    console.log('');
    console.log(`📊 Shard coverage: ${coveredShards}/32 shards`);
    console.log(`   Distribution: ${JSON.stringify(shardDist)}`);
  }

  console.log('');
  console.log(`📁 Users saved to:`);
  console.log(`   JSON: ${TEST_USERS_FILE}`);
  console.log(`   TXT:  ${TEST_USERS_TXT}`);
  console.log('');
  console.log('💡 Next: Run seed-authcodes.js to generate authorization codes.');
  console.log('   ユーザーは再利用可能です（DB初期化しない限り）');
  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  // エラー時も保存を試みる
  if (userMap.size > 0) {
    console.log('⚠️  Error occurred, but saving collected users...');
    saveUsers(userMap, 'Error recovery save');
  }
  process.exit(1);
});
