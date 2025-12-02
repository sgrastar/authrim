#!/usr/bin/env node

/**
 * テストクライアント一括作成スクリプト
 *
 * 複数クライアントに分散負荷をかけるため、Admin API経由でテストクライアントを一括作成する。
 * RefreshTokenRotator DOはclient_id単位でシャーディングされているため、
 * 複数クライアントに負荷を分散することで、より現実的なマルチテナント環境をシミュレートできる。
 *
 * 環境変数:
 *   BASE_URL             対象の Authrim Worker URL (default: https://conformance.authrim.com)
 *   ADMIN_API_SECRET     Admin API シークレット (required)
 *   CLIENT_COUNT         作成するクライアント数 (default: 20)
 *   TARGET_RPS           目標RPS - クライアント構成を自動計算 (default: 100)
 *   OUTPUT_DIR           出力ディレクトリ (default: ../seeds/distributed)
 *   PREFIX               クライアント名のプレフィックス (default: loadtest)
 *
 * 使い方:
 *   ADMIN_API_SECRET=xxx node scripts/setup-test-clients.js
 *   ADMIN_API_SECRET=xxx CLIENT_COUNT=30 TARGET_RPS=200 node scripts/setup-test-clients.js
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env.BASE_URL || 'https://conformance.authrim.com';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const CLIENT_COUNT = Number.parseInt(process.env.CLIENT_COUNT || '20', 10);
const TARGET_RPS = Number.parseInt(process.env.TARGET_RPS || '100', 10);
const PREFIX = process.env.PREFIX || 'loadtest';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds', 'distributed');

if (!ADMIN_API_SECRET) {
  console.error('❌ ADMIN_API_SECRET は必須です。環境変数を設定してください。');
  process.exit(1);
}

const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

/**
 * 負荷レベル別のクライアント構成を計算
 *
 * 本番環境ではクライアント（テナント）ごとに負荷が異なる。
 * - high: 大規模テナント（全体の45%の負荷）
 * - medium: 中規模テナント（全体の35%の負荷）
 * - low: 小規模テナント（全体の20%の負荷）
 *
 * @param {number} targetRPS 目標RPS
 * @param {number} clientCount クライアント数
 * @returns {Object} 構成情報
 */
function calculateClientDistribution(targetRPS, clientCount) {
  // MAU → RPS 対応表に基づくデフォルト配分
  // | MAU    | Peak RPS | Clients |
  // |--------|----------|---------|
  // | 10万   | 20       | 10      |
  // | 50万   | 100      | 20      |
  // | 100万  | 200      | 30      |

  // 負荷配分比率
  const HIGH_SHARE = 0.45; // 45% of total load
  const MEDIUM_SHARE = 0.35; // 35% of total load
  const LOW_SHARE = 0.2; // 20% of total load

  // クライアント数の配分（推奨比率: 15% high, 35% medium, 50% low）
  const highCount = Math.max(1, Math.round(clientCount * 0.15));
  const mediumCount = Math.max(1, Math.round(clientCount * 0.35));
  const lowCount = Math.max(1, clientCount - highCount - mediumCount);

  // 各レベルのRPS計算
  const highRPS = (targetRPS * HIGH_SHARE) / highCount;
  const mediumRPS = (targetRPS * MEDIUM_SHARE) / mediumCount;
  const lowRPS = (targetRPS * LOW_SHARE) / lowCount;

  return {
    high: { count: highCount, rpsPerClient: Math.round(highRPS * 10) / 10 },
    medium: { count: mediumCount, rpsPerClient: Math.round(mediumRPS * 10) / 10 },
    low: { count: lowCount, rpsPerClient: Math.round(lowRPS * 10) / 10 },
    totalRPS: targetRPS,
    totalClients: clientCount,
  };
}

/**
 * Admin APIでクライアントを作成
 * @param {string} clientName クライアント名
 * @param {string} loadLevel 負荷レベル (high/medium/low)
 * @param {number} targetRPS 目標RPS
 * @returns {Promise<Object>} 作成されたクライアント情報
 */
async function createClient(clientName, loadLevel, targetRPS) {
  const res = await fetch(`${BASE_URL}/api/admin/clients`, {
    method: 'POST',
    headers: {
      ...adminAuthHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: ['https://localhost:3000/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid profile email',
      token_endpoint_auth_method: 'client_secret_basic',
      is_trusted: true, // Skip consent for load testing
      skip_consent: true,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to create client: ${res.status} - ${error}`);
  }

  const { client } = await res.json();

  return {
    client_id: client.client_id,
    client_secret: client.client_secret,
    client_name: client.client_name,
    load_level: loadLevel,
    target_rps: targetRPS,
    created_at: new Date().toISOString(),
  };
}

/**
 * 既存のテストクライアントを取得
 * @returns {Promise<Array>} 既存のテストクライアントリスト
 */
async function getExistingTestClients() {
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

async function main() {
  console.log(`🔨 Authrim Test Client Setup`);
  console.log(`   BASE_URL     : ${BASE_URL}`);
  console.log(`   CLIENT_COUNT : ${CLIENT_COUNT}`);
  console.log(`   TARGET_RPS   : ${TARGET_RPS}`);
  console.log(`   PREFIX       : ${PREFIX}`);
  console.log(`   OUTPUT_DIR   : ${OUTPUT_DIR}`);
  console.log('');

  // 負荷配分を計算
  const distribution = calculateClientDistribution(TARGET_RPS, CLIENT_COUNT);

  console.log(`📊 Client Distribution:`);
  console.log(
    `   High   : ${distribution.high.count} clients × ${distribution.high.rpsPerClient} RPS = ${Math.round(distribution.high.count * distribution.high.rpsPerClient)} RPS (45%)`
  );
  console.log(
    `   Medium : ${distribution.medium.count} clients × ${distribution.medium.rpsPerClient} RPS = ${Math.round(distribution.medium.count * distribution.medium.rpsPerClient)} RPS (35%)`
  );
  console.log(
    `   Low    : ${distribution.low.count} clients × ${distribution.low.rpsPerClient} RPS = ${Math.round(distribution.low.count * distribution.low.rpsPerClient)} RPS (20%)`
  );
  console.log(`   Total  : ${distribution.totalClients} clients, ${distribution.totalRPS} RPS`);
  console.log('');

  // 既存のテストクライアントを確認
  console.log('🔍 Checking existing test clients...');
  const existingClients = await getExistingTestClients();
  console.log(`   Found ${existingClients.length} existing test clients with prefix "${PREFIX}"`);

  if (existingClients.length > 0) {
    console.log(
      `   ⚠️  Existing clients will be kept. Run cleanup-test-clients.js to remove them first.`
    );
  }
  console.log('');

  // クライアント作成
  console.log('🚀 Creating test clients...');
  const createdClients = [];
  let clientIndex = existingClients.length; // Start from next index

  // High load clients
  for (let i = 0; i < distribution.high.count; i++) {
    const name = `${PREFIX}-high-${String(clientIndex).padStart(3, '0')}`;
    try {
      const client = await createClient(name, 'high', distribution.high.rpsPerClient);
      createdClients.push(client);
      console.log(`   ✅ Created: ${name} (high, ${distribution.high.rpsPerClient} RPS)`);
      clientIndex++;
    } catch (err) {
      console.error(`   ❌ Failed to create ${name}: ${err.message}`);
    }
    // Rate limiting protection
    await new Promise((r) => setTimeout(r, 100));
  }

  // Medium load clients
  for (let i = 0; i < distribution.medium.count; i++) {
    const name = `${PREFIX}-medium-${String(clientIndex).padStart(3, '0')}`;
    try {
      const client = await createClient(name, 'medium', distribution.medium.rpsPerClient);
      createdClients.push(client);
      console.log(`   ✅ Created: ${name} (medium, ${distribution.medium.rpsPerClient} RPS)`);
      clientIndex++;
    } catch (err) {
      console.error(`   ❌ Failed to create ${name}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Low load clients
  for (let i = 0; i < distribution.low.count; i++) {
    const name = `${PREFIX}-low-${String(clientIndex).padStart(3, '0')}`;
    try {
      const client = await createClient(name, 'low', distribution.low.rpsPerClient);
      createdClients.push(client);
      console.log(`   ✅ Created: ${name} (low, ${distribution.low.rpsPerClient} RPS)`);
      clientIndex++;
    } catch (err) {
      console.error(`   ❌ Failed to create ${name}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (createdClients.length === 0) {
    console.error('❌ No clients were created. Aborting.');
    process.exit(1);
  }

  // 出力ディレクトリ作成
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // クライアント情報を保存
  const outputPath = path.join(OUTPUT_DIR, 'clients.json');
  const output = {
    metadata: {
      created_at: new Date().toISOString(),
      base_url: BASE_URL,
      target_rps: TARGET_RPS,
      distribution: distribution,
    },
    clients: createdClients,
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log('');
  console.log(`✅ Created ${createdClients.length} test clients`);
  console.log(`📁 Saved to: ${outputPath}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Run generate-distributed-seeds.js to create seeds for each client');
  console.log('  2. Run test4-distributed-load.js to execute distributed load test');
  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
