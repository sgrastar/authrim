/**
 * K6 Cloud 動作確認用スモークテスト
 *
 * 目的:
 * - K6 Cloudとの接続確認
 * - 基本的なリクエストの動作確認
 * - シードデータ不要の軽量テスト
 *
 * 使い方:
 * k6 cloud scripts/cloud-smoke-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// カスタムメトリクス
const responseTime = new Trend('response_time');
const successRate = new Rate('success_rate');

// 環境変数
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';

// K6 Cloud + テストオプション
export const options = {
  // K6 Cloud 設定
  cloud: {
    projectID: 5942435,
    name: 'Authrim - Smoke Test',
    distribution: {
      // 東京リージョンから100%の負荷
      'amazon:jp:tokyo': { loadZone: 'amazon:jp:tokyo', percent: 100 },
    },
  },

  // 軽量テスト設定: 10 VU × 30秒
  stages: [
    { duration: '10s', target: 5 },   // Ramp up
    { duration: '20s', target: 10 },  // Sustained
    { duration: '10s', target: 0 },   // Ramp down
  ],

  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    success_rate: ['rate>0.99'],
  },
};

// セットアップ
export function setup() {
  console.log(`🚀 K6 Cloud スモークテスト`);
  console.log(`🎯 ターゲット: ${BASE_URL}`);
  console.log(`📍 Load Zone: Tokyo (amazon:jp:tokyo)`);

  // 接続確認
  const res = http.get(`${BASE_URL}/.well-known/openid-configuration`);
  if (res.status !== 200) {
    throw new Error(`Setup failed: ${res.status} - ${res.body}`);
  }

  console.log(`✅ 接続確認OK`);
  return { baseUrl: BASE_URL };
}

// メインテスト
export default function (data) {
  // /.well-known/openid-configuration をテスト
  const res = http.get(`${data.baseUrl}/.well-known/openid-configuration`, {
    headers: {
      Accept: 'application/json',
      Connection: 'keep-alive',
    },
    tags: { name: 'openid-configuration' },
  });

  // メトリクス記録
  responseTime.add(res.timings.duration);

  // チェック
  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'has issuer': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.issuer !== undefined;
      } catch {
        return false;
      }
    },
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  successRate.add(success);

  // Think time
  sleep(0.5);
}

// ティアダウン
export function teardown(data) {
  console.log(`✅ スモークテスト完了`);
  console.log(`🎯 ターゲット: ${data.baseUrl}`);
}
