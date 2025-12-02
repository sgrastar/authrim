#!/usr/bin/env node

/**
 * テストクライアント一括削除スクリプト
 *
 * setup-test-clients.js で作成したテストクライアントを一括削除する。
 * 負荷テスト完了後のクリーンアップに使用する。
 *
 * 環境変数:
 *   BASE_URL             対象の Authrim Worker URL (default: https://conformance.authrim.com)
 *   ADMIN_API_SECRET     Admin API シークレット (required)
 *   PREFIX               削除するクライアント名のプレフィックス (default: loadtest)
 *   DRY_RUN              true の場合、削除せずに対象を表示のみ (default: false)
 *   SEEDS_DIR            シードファイルディレクトリ (default: ../seeds/distributed)
 *
 * 使い方:
 *   ADMIN_API_SECRET=xxx node scripts/cleanup-test-clients.js
 *   ADMIN_API_SECRET=xxx DRY_RUN=true node scripts/cleanup-test-clients.js
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env.BASE_URL || 'https://conformance.authrim.com';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const PREFIX = process.env.PREFIX || 'loadtest';
const DRY_RUN = process.env.DRY_RUN === 'true';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SEEDS_DIR = process.env.SEEDS_DIR || path.join(SCRIPT_DIR, '..', 'seeds', 'distributed');

if (!ADMIN_API_SECRET) {
  console.error('❌ ADMIN_API_SECRET は必須です。環境変数を設定してください。');
  process.exit(1);
}

const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

/**
 * プレフィックスにマッチするテストクライアントを取得
 * @returns {Promise<Array>} テストクライアントリスト
 */
async function getTestClients() {
  const clients = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const res = await fetch(
      `${BASE_URL}/api/admin/clients?search=${encodeURIComponent(PREFIX)}&page=${page}&limit=${limit}`,
      {
        headers: adminAuthHeader,
      }
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to list clients: ${res.status} - ${error}`);
    }

    const data = await res.json();

    // フィルタリング: プレフィックスで始まるクライアントのみ
    const matchingClients = data.clients.filter((c) => c.client_name.startsWith(`${PREFIX}-`));
    clients.push(...matchingClients);

    if (!data.pagination.hasNext) break;
    page++;
  }

  return clients;
}

/**
 * クライアントを削除
 * @param {string} clientId クライアントID
 * @returns {Promise<boolean>} 成功時 true
 */
async function deleteClient(clientId) {
  const res = await fetch(`${BASE_URL}/api/admin/clients/${clientId}`, {
    method: 'DELETE',
    headers: adminAuthHeader,
  });

  return res.ok;
}

/**
 * クライアントを一括削除（Bulk Delete API使用）
 * @param {string[]} clientIds クライアントIDリスト
 * @returns {Promise<{deleted: number, errors: string[]}>}
 */
async function bulkDeleteClients(clientIds) {
  // 100件ずつバッチ処理（API制限）
  const batchSize = 100;
  let totalDeleted = 0;
  const allErrors = [];

  for (let i = 0; i < clientIds.length; i += batchSize) {
    const batch = clientIds.slice(i, i + batchSize);

    const res = await fetch(`${BASE_URL}/api/admin/clients/bulk`, {
      method: 'DELETE',
      headers: {
        ...adminAuthHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ client_ids: batch }),
    });

    if (!res.ok) {
      const error = await res.text();
      allErrors.push(`Batch ${Math.floor(i / batchSize) + 1} failed: ${error}`);
      continue;
    }

    const result = await res.json();
    totalDeleted += result.deleted || 0;
    if (result.errors) {
      allErrors.push(...result.errors);
    }

    // Rate limiting protection
    if (i + batchSize < clientIds.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return { deleted: totalDeleted, errors: allErrors };
}

/**
 * シードファイルを削除
 */
function cleanupSeedFiles() {
  if (!fs.existsSync(SEEDS_DIR)) {
    return { deleted: 0, files: [] };
  }

  const deletedFiles = [];

  // clients.json を削除
  const clientsFile = path.join(SEEDS_DIR, 'clients.json');
  if (fs.existsSync(clientsFile)) {
    fs.unlinkSync(clientsFile);
    deletedFiles.push(clientsFile);
  }

  // 各クライアントのシードディレクトリを削除
  const entries = fs.readdirSync(SEEDS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const dirPath = path.join(SEEDS_DIR, entry.name);
      fs.rmSync(dirPath, { recursive: true, force: true });
      deletedFiles.push(dirPath);
    }
  }

  // distributed ディレクトリが空なら削除
  const remainingEntries = fs.readdirSync(SEEDS_DIR);
  if (remainingEntries.length === 0) {
    fs.rmdirSync(SEEDS_DIR);
    deletedFiles.push(SEEDS_DIR);
  }

  return { deleted: deletedFiles.length, files: deletedFiles };
}

async function main() {
  console.log(`🧹 Authrim Test Client Cleanup`);
  console.log(`   BASE_URL  : ${BASE_URL}`);
  console.log(`   PREFIX    : ${PREFIX}`);
  console.log(`   DRY_RUN   : ${DRY_RUN}`);
  console.log(`   SEEDS_DIR : ${SEEDS_DIR}`);
  console.log('');

  // テストクライアントを取得
  console.log('🔍 Finding test clients...');
  const clients = await getTestClients();

  if (clients.length === 0) {
    console.log(`   No test clients found with prefix "${PREFIX}"`);
    console.log('');
    console.log('✅ Nothing to clean up');
    return;
  }

  console.log(`   Found ${clients.length} test clients:`);
  for (const client of clients) {
    console.log(`     - ${client.client_name} (${client.client_id})`);
  }
  console.log('');

  if (DRY_RUN) {
    console.log('🔍 DRY RUN MODE - No changes will be made');
    console.log(`   Would delete ${clients.length} clients`);

    // シードファイルの確認
    if (fs.existsSync(SEEDS_DIR)) {
      const entries = fs.readdirSync(SEEDS_DIR);
      console.log(`   Would delete ${entries.length} seed files/directories in ${SEEDS_DIR}`);
    }

    console.log('');
    console.log('💡 Run without DRY_RUN=true to actually delete');
    return;
  }

  // 一括削除
  console.log('🗑️  Deleting test clients...');
  const clientIds = clients.map((c) => c.client_id);
  const { deleted, errors } = await bulkDeleteClients(clientIds);

  console.log(`   Deleted ${deleted}/${clients.length} clients`);
  if (errors.length > 0) {
    console.log(`   Errors:`);
    for (const error of errors) {
      console.log(`     - ${error}`);
    }
  }
  console.log('');

  // シードファイルの削除
  console.log('🗂️  Cleaning up seed files...');
  const seedCleanup = cleanupSeedFiles();
  if (seedCleanup.deleted > 0) {
    console.log(`   Deleted ${seedCleanup.deleted} files/directories:`);
    for (const file of seedCleanup.files) {
      console.log(`     - ${file}`);
    }
  } else {
    console.log('   No seed files to clean up');
  }
  console.log('');

  console.log('✅ Cleanup complete');
  console.log(`   Clients deleted: ${deleted}`);
  console.log(`   Seed files deleted: ${seedCleanup.deleted}`);
  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
