#!/bin/bash
#
# TEST 1: /token 単体負荷テスト (300 RPS)
#
# 使い方:
#   chmod +x run-test1-300rps.sh
#   ./run-test1-300rps.sh
#
# 必要な認可コード数: 約30,000件（余裕を持って50,000件推奨）
# テスト時間: 約2分10秒 (15+15+15+60+15+10秒)
#

set -e

# ============================================
# 設定
# ============================================
export BASE_URL="https://conformance.authrim.com"
export ADMIN_API_SECRET="${ADMIN_API_SECRET:-production-secret-change-me}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 必要な認可コード数（300RPS × 130秒 ≒ 39,000件 + 余裕）
REQUIRED_AUTH_CODES=50000

echo "═══════════════════════════════════════════════════════════════════════════════"
echo "  🚀 TEST 1: /token 単体負荷テスト (300 RPS)"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""
echo "🔧 Configuration:"
echo "   BASE_URL: $BASE_URL"
echo "   Required auth codes: $REQUIRED_AUTH_CODES"
echo ""

# ============================================
# Step 1: テスト用クライアント作成
# ============================================
echo "🔧 Step 1: テスト用クライアントを作成..."

RESPONSE=$(curl -s -X POST "${BASE_URL}/api/admin/clients" \
  -H "Authorization: Bearer ${ADMIN_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"TEST1 300RPS Load Test","redirect_uris":["https://localhost:3000/callback"],"grant_types":["authorization_code","refresh_token"],"scope":"openid profile email","is_trusted":true,"skip_consent":true}')

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
# Step 2: 大量シードデータ生成
# ============================================
echo "🌱 Step 2: シードデータを生成（$REQUIRED_AUTH_CODES 件）..."
echo "   ⏳ これには数分かかります..."
echo ""

cd "$SCRIPT_DIR/scripts"

# 大量の認可コードを生成（refresh tokenは少なめ）
AUTH_CODE_COUNT=$REQUIRED_AUTH_CODES REFRESH_COUNT=100 node generate-seeds.js

if [ $? -ne 0 ]; then
  echo "❌ シード生成に失敗しました"
  curl -s -X DELETE "${BASE_URL}/api/admin/clients/${CLIENT_ID}" \
    -H "Authorization: Bearer ${ADMIN_API_SECRET}" > /dev/null
  exit 1
fi

# 生成された認可コード数を確認
ACTUAL_CODES=$(jq length "$SCRIPT_DIR/seeds/authorization_codes.json" 2>/dev/null || echo "0")
echo ""
echo "✅ シード生成成功: $ACTUAL_CODES 件の認可コード"
echo ""

if [ "$ACTUAL_CODES" -lt 20000 ]; then
  echo "⚠️  警告: 認可コードが少なすぎます（$ACTUAL_CODES 件）"
  echo "   300RPSテストには最低30,000件必要です"
  echo "   テストを続行しますが、途中でコードが枯渇する可能性があります"
  echo ""
fi

# ============================================
# Step 3: k6 テスト実行
# ============================================
echo "🚀 Step 3: TEST 1 - 300 RPS テストを実行..."
echo "📊 プリセット: rps300"
echo "   - Warm up: 100 RPS (15s)"
echo "   - Ramp: 100 → 200 → 300 RPS (30s)"
echo "   - Sustain: 300 RPS (60s)"
echo "   - Cool down: 300 → 100 RPS (25s)"
echo ""

cd "$SCRIPT_DIR"

# テスト開始時刻を記録
TEST_START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "📅 テスト開始: $TEST_START_TIME"
echo ""

# resultsディレクトリを作成
mkdir -p results

# k6 実行
k6 run \
  --env BASE_URL="$BASE_URL" \
  --env CLIENT_ID="$CLIENT_ID" \
  --env CLIENT_SECRET="$CLIENT_SECRET" \
  --env PRESET=rps300 \
  --env AUTH_CODE_PATH="${SCRIPT_DIR}/seeds/authorization_codes.json" \
  --env RESULTS_DIR="${SCRIPT_DIR}/results" \
  scripts/test1-token-load.js

# テスト終了時刻を記録
TEST_END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo ""
echo "📅 テスト終了: $TEST_END_TIME"

# ============================================
# Step 4: Cloudflare Analytics 取得
# ============================================
echo ""
echo "📊 Step 4: Cloudflare Workers Analytics を取得..."

if [ -n "$CF_API_TOKEN" ]; then
  # 少し待ってからAnalyticsを取得（データ反映待ち）
  echo "   ⏳ データ反映を待機中（10秒）..."
  sleep 10

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
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "  📊 TEST 1 完了！"
echo "  📁 結果は results/ ディレクトリを確認してください"
echo "═══════════════════════════════════════════════════════════════════════════════"
