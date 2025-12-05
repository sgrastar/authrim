#!/bin/bash
#
# TEST 1: Token AuthCode (1000 RPS プリセット)
#
# 使い方:
#   chmod +x run-test1-1000rps.sh
#   ./run-test1-1000rps.sh
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
echo ""

# ============================================
# Step 1: テスト用クライアント取得または作成
# ============================================
echo "🔧 Step 1: テスト用クライアントを確認..."

# 既存のクライアントを使用（シード生成時と同じ）
export CLIENT_ID="b42bdc5e-7183-46ef-859c-fd21d4589cd6"
export CLIENT_SECRET="6ec3c4aed67c40d9ae8891e4641292ae15cf215264ba4618b7c89356b54b0bde"

echo "✅ クライアント設定"
echo "   CLIENT_ID: $CLIENT_ID"
echo ""

# ============================================
# Step 2: シードデータ確認
# ============================================
echo "🌱 Step 2: シードデータを確認..."

SEED_COUNT=$(cat "$SCRIPT_DIR/seeds/authorization_codes.json" | jq 'length')
echo "   Auth Codes: $SEED_COUNT 件"

if [ "$SEED_COUNT" -lt 100000 ]; then
  echo "⚠️  シード数が不足しています（1000 RPSには12万件以上必要）"
  echo "   generate-seeds-parallel.js で追加生成してください"
fi

echo ""

# ============================================
# Step 2.5: Durable Object ウォームアップ
# ============================================
echo "🔥 Step 2.5: Durable Object ウォームアップ..."
echo "   Cold Start回避のため128シャードを事前にウォームアップします"
echo ""

node "${SCRIPT_DIR}/scripts/warmup.js"

if [ $? -ne 0 ]; then
  echo "⚠️  ウォームアップに失敗しましたが、テストを続行します"
fi

echo ""

# ============================================
# Step 3: k6 テスト実行
# ============================================
echo "🚀 Step 3: TEST 1 - Token AuthCode 1000 RPS を実行..."
echo "📊 プリセット: rps1000 (約2.5分間)"
echo ""

cd "$SCRIPT_DIR"

# テスト開始時刻を記録
TEST_START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# resultsディレクトリを作成
mkdir -p results

# k6 cloud 実行
k6 cloud \
  -e BASE_URL="$BASE_URL" \
  -e CLIENT_ID="$CLIENT_ID" \
  -e CLIENT_SECRET="$CLIENT_SECRET" \
  -e PRESET=rps1000 \
  scripts/token-authcode.js

# テスト終了時刻を記録
TEST_END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ============================================
# Step 4: Cloudflare Analytics 取得
# ============================================
echo ""
echo "📊 Step 4: Cloudflare Workers Analytics を取得..."

if [ -n "$CF_API_TOKEN" ]; then
  # 少し待ってからAnalyticsを取得（データ反映待ち）
  sleep 10

  node "${SCRIPT_DIR}/scripts/fetch-cf-analytics.js" \
    --start "$TEST_START_TIME" \
    --end "$TEST_END_TIME"
else
  echo "⚠️  CF_API_TOKEN が設定されていないため、Analytics取得をスキップしました"
  echo "   設定方法: export CF_API_TOKEN=\"your_cloudflare_api_token\""
fi

echo ""
echo "📊 テスト完了！"
