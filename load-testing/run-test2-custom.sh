#!/bin/bash
#
# TEST 2: Refresh Token Storm (Custom - 高負荷テスト)
#
# 設定:
#   VU = 100
#   Refresh Token = 100件
#   RPS = 100〜600
#
# 使い方:
#   chmod +x run-test2-custom.sh
#   ./run-test2-custom.sh
#

set -e

# ============================================
# 設定
# ============================================
export BASE_URL="https://conformance.authrim.com"
export ADMIN_API_SECRET="${ADMIN_API_SECRET:-production-secret-change-me}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🔧 Configuration:"
echo "   BASE_URL: $BASE_URL"
echo "   VU: 100"
echo "   RPS: 100 → 600"
echo "   Refresh Tokens: 100"
echo ""

# ============================================
# Step 1: テスト用クライアント作成
# ============================================
echo "🔧 Step 1: テスト用クライアントを作成..."

RESPONSE=$(curl -s -X POST "${BASE_URL}/api/admin/clients" \
  -H "Authorization: Bearer ${ADMIN_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"Refresh Storm High Load","redirect_uris":["https://localhost:3000/callback"],"grant_types":["authorization_code","refresh_token"],"scope":"openid profile email","is_trusted":true,"skip_consent":true}')

export CLIENT_ID=$(echo $RESPONSE | jq -r '.client.client_id')
export CLIENT_SECRET=$(echo $RESPONSE | jq -r '.client.client_secret')

if [ "$CLIENT_ID" == "null" ] || [ -z "$CLIENT_ID" ]; then
  echo "❌ クライアント作成に失敗しました"
  echo "Response: $RESPONSE"
  exit 1
fi

echo "✅ クライアント作成成功"
echo "   CLIENT_ID: $CLIENT_ID"
echo ""

# ============================================
# Step 2: シードデータ生成
# ============================================
echo "🌱 Step 2: シードデータを生成（Refresh Token 100件）..."

cd "$SCRIPT_DIR/scripts"

AUTH_CODE_COUNT=5 REFRESH_COUNT=100 node generate-seeds.js

if [ $? -ne 0 ]; then
  echo "❌ シード生成に失敗しました"
  curl -s -X DELETE "${BASE_URL}/api/admin/clients/${CLIENT_ID}" \
    -H "Authorization: Bearer ${ADMIN_API_SECRET}" > /dev/null
  exit 1
fi

echo ""
echo "✅ シード生成成功"
echo ""

# ============================================
# Step 3: k6 テスト実行
# ============================================
echo "🚀 Step 3: TEST 2 - Refresh Token Storm (高負荷)を実行..."
echo "📊 カスタム設定: VU=100, RPS=100→600"
echo ""

cd "$SCRIPT_DIR"

# テスト開始時刻を記録
TEST_START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# resultsディレクトリを作成
mkdir -p results

# k6 実行 (custom preset)
k6 run \
  --env BASE_URL="$BASE_URL" \
  --env CLIENT_ID="$CLIENT_ID" \
  --env CLIENT_SECRET="$CLIENT_SECRET" \
  --env PRESET=custom \
  --env REFRESH_TOKEN_PATH="${SCRIPT_DIR}/seeds/refresh_tokens.json" \
  --env RESULTS_DIR="${SCRIPT_DIR}/results" \
  scripts/test2-refresh-storm.js

# テスト終了時刻を記録
TEST_END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ============================================
# Step 4: Cloudflare Analytics 取得
# ============================================
echo ""
echo "📊 Step 4: Cloudflare Workers Analytics を取得..."

if [ -n "$CF_API_TOKEN" ]; then
  # 少し待ってからAnalyticsを取得（データ反映待ち）
  sleep 5

  node "${SCRIPT_DIR}/scripts/fetch-cf-analytics.js" \
    --start "$TEST_START_TIME" \
    --end "$TEST_END_TIME"
else
  echo "⚠️  CF_API_TOKEN が設定されていないため、Analytics取得をスキップしました"
  echo "   設定方法: export CF_API_TOKEN=\"your_cloudflare_api_token\""
fi

# ============================================
# Step 5: クリーンアップ
# ============================================
echo ""
echo "🧹 クリーンアップ..."

curl -s -X DELETE "${BASE_URL}/api/admin/clients/${CLIENT_ID}" \
  -H "Authorization: Bearer ${ADMIN_API_SECRET}" > /dev/null

echo "✅ テスト用クライアントを削除しました"
echo ""
echo "📊 テスト完了！結果は results/ ディレクトリを確認してください"
