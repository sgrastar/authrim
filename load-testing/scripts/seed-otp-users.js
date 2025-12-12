#!/usr/bin/env node

/**
 * OTP ユーザーシード生成スクリプト
 *
 * Mail OTP ログインベンチマーク用のユーザーを事前作成する。
 * D1にユーザーを登録し、メールアドレス一覧をファイルに出力する。
 *
 * 環境変数:
 *   BASE_URL           対象の Authrim Worker URL (default: https://conformance.authrim.com)
 *   ADMIN_API_SECRET   Admin API シークレット (required)
 *   OTP_USER_COUNT     生成するユーザー数 (default: 500)
 *   CONCURRENCY        並列数 (default: 20)
 *   OUTPUT_DIR         出力ディレクトリ (default: ../seeds)
 *   USER_PREFIX        ユーザーメールプレフィックス (default: otp-bench)
 *
 * 使い方:
 *   BASE_URL=https://conformance.authrim.com \
 *   ADMIN_API_SECRET=xxx \
 *   OTP_USER_COUNT=1000 \
 *   node scripts/seed-otp-users.js
 *
 * 出力ファイル:
 *   seeds/otp_users.json    - ユーザー情報（email, userId）のJSON配列
 *   seeds/otp_user_list.txt - メールアドレス一覧（1行1メール）
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// 環境変数
const BASE_URL = process.env.BASE_URL || 'https://conformance.authrim.com';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const OTP_USER_COUNT = Number.parseInt(process.env.OTP_USER_COUNT || '500', 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '20', 10);
const USER_PREFIX = process.env.USER_PREFIX || 'otp-bench';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds');

// リクエスト設定
const REQUEST_TIMEOUT = 15000;
const MAX_RETRIES = 3;

if (!ADMIN_API_SECRET) {
  console.error('❌ ADMIN_API_SECRET は必須です。環境変数を設定してください。');
  process.exit(1);
}

const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

/**
 * タイムアウト付きfetch
 */
async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * リトライ付きユーザー作成
 */
async function createUserWithRetry(index, retryCount = 0) {
  const email = `${USER_PREFIX}-${String(index).padStart(5, '0')}@test.authrim.internal`;

  try {
    // まず既存ユーザーを検索
    // Note: Admin API の検索は部分一致のため、結果からメールアドレスが完全一致するものをフィルタ
    const listRes = await fetchWithTimeout(
      `${BASE_URL}/api/admin/users?email=${encodeURIComponent(email)}`,
      { headers: adminAuthHeader }
    );

    if (listRes.ok) {
      const data = await listRes.json();
      if (data.users && data.users.length > 0) {
        // メールアドレスが完全一致するユーザーを探す
        const exactMatch = data.users.find(
          (u) => u.email.toLowerCase() === email.toLowerCase()
        );
        if (exactMatch) {
          return { email, userId: exactMatch.id, created: false };
        }
      }
    }

    // 新規作成
    const createRes = await fetchWithTimeout(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: {
        ...adminAuthHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email,
        name: `OTP Benchmark User ${index}`,
        email_verified: true,
      }),
    });

    if (!createRes.ok) {
      // 409 Conflict = ユーザーが既に存在（検索で見つからなかったが実際は存在）
      if (createRes.status === 409) {
        return { email, userId: 'existing-conflict', created: false };
      }
      const error = await createRes.text();
      throw new Error(`HTTP ${createRes.status}: ${error}`);
    }

    const { user } = await createRes.json();
    return { email, userId: user.id, created: true };
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      // Exponential backoff
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, retryCount)));
      return createUserWithRetry(index, retryCount + 1);
    }
    throw err;
  }
}

/**
 * バッチ処理でユーザー作成
 */
async function createUsersBatch(startIndex, batchSize) {
  const promises = [];
  for (let i = 0; i < batchSize; i++) {
    const index = startIndex + i;
    promises.push(
      createUserWithRetry(index).catch((err) => ({
        error: err.message,
        index,
      }))
    );
  }
  return Promise.all(promises);
}

/**
 * メイン処理
 */
async function main() {
  console.log(`🚀 OTP User Seed Generator`);
  console.log(`   BASE_URL       : ${BASE_URL}`);
  console.log(`   OTP_USER_COUNT : ${OTP_USER_COUNT}`);
  console.log(`   CONCURRENCY    : ${CONCURRENCY}`);
  console.log(`   USER_PREFIX    : ${USER_PREFIX}`);
  console.log(`   OUTPUT_DIR     : ${OUTPUT_DIR}`);
  console.log(``);

  const users = [];
  let createdCount = 0;
  let existingCount = 0;
  let errorCount = 0;
  const startTime = Date.now();

  const totalBatches = Math.ceil(OTP_USER_COUNT / CONCURRENCY);

  console.log(`📋 Creating ${OTP_USER_COUNT} users in ${totalBatches} batches...`);
  console.log(``);

  for (let batch = 0; batch < totalBatches; batch++) {
    const startIndex = batch * CONCURRENCY;
    const remaining = OTP_USER_COUNT - users.length - errorCount;
    const batchSize = Math.min(CONCURRENCY, remaining);

    const results = await createUsersBatch(startIndex, batchSize);

    for (const result of results) {
      if (result.error) {
        errorCount++;
        console.error(`   ❌ User ${result.index}: ${result.error}`);
      } else {
        users.push({ email: result.email, userId: result.userId });
        if (result.created) {
          createdCount++;
        } else {
          existingCount++;
        }
      }
    }

    // 進捗表示（10バッチごと、または最後）
    if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = users.length / elapsed;
      console.log(
        `   [${users.length}/${OTP_USER_COUNT}] ${rate.toFixed(1)}/s, ` +
          `created: ${createdCount}, existing: ${existingCount}, errors: ${errorCount}`
      );
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;
  console.log(``);
  console.log(`✅ Seed generation complete:`);
  console.log(`   Total users: ${users.length}`);
  console.log(`   New created: ${createdCount}`);
  console.log(`   Already existing: ${existingCount}`);
  console.log(`   Errors: ${errorCount}`);
  console.log(`   Time: ${totalTime.toFixed(1)}s`);
  console.log(`   Rate: ${(users.length / totalTime).toFixed(1)} users/sec`);

  if (users.length === 0) {
    console.error(`❌ No users created. Aborting.`);
    process.exit(1);
  }

  // 出力ディレクトリ作成
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // JSONファイル出力（詳細情報）
  const jsonPath = path.join(OUTPUT_DIR, 'otp_users.json');
  fs.writeFileSync(jsonPath, JSON.stringify(users, null, 2));
  console.log(`\n📁 Saved ${users.length} users to ${jsonPath}`);

  // テキストファイル出力（メールアドレスのみ、k6で使用）
  const txtPath = path.join(OUTPUT_DIR, 'otp_user_list.txt');
  fs.writeFileSync(txtPath, users.map((u) => u.email).join('\n') + '\n');
  console.log(`📁 Saved email list to ${txtPath}`);

  console.log(``);
  console.log(`💡 Usage with k6 benchmark:`);
  console.log(`   k6 run -e USER_LIST_PATH=../seeds/otp_user_list.txt \\`);
  console.log(`     -e PRESET=rps30 \\`);
  console.log(`     scripts/test-mail-otp-full-login-benchmark.js`);
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
