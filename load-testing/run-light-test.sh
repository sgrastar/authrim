#!/bin/bash
#
# Light 負荷テスト実行サンプル
#
# 使い方:
#   chmod +x run-light-test.sh
#   ./run-light-test.sh
#
# このスクリプトは以下を自動で実行します:
#   1. テスト用クライアント作成
#   2. テストユーザー＋セッション作成
#   3. シードデータ生成（認可コード、リフレッシュトークン）
#   4. k6負荷テスト実行
#   5. クリーンアップ
#

set -e

# ============================================
# 設定 - 環境に合わせて変更してください
# ============================================
export BASE_URL="https://conformance.authrim.com"
export ADMIN_API_SECRET="${ADMIN_API_SECRET:-production-secret-change-me}"  # Cloudflare Secrets で設定した値

echo "🔧 Configuration:"
echo "   BASE_URL: $BASE_URL"
echo "   ADMIN_API_SECRET: ${ADMIN_API_SECRET:0:10}..."
echo ""

# ============================================
# Step 1: テスト用クライアント作成
# ============================================
echo "🔧 Step 1: テスト用クライアントを作成..."

RESPONSE=$(curl -s -X POST "${BASE_URL}/api/admin/clients" \
  -H "Authorization: Bearer ${ADMIN_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Load Test Client",
    "redirect_uris": ["https://localhost:3000/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "scope": "openid profile email",
    "is_trusted": true,
    "skip_consent": true
  }')

# レスポンスからclient_id, client_secretを抽出
export CLIENT_ID=$(echo $RESPONSE | jq -r '.client.client_id')
export CLIENT_SECRET=$(echo $RESPONSE | jq -r '.client.client_secret')

if [ "$CLIENT_ID" == "null" ] || [ -z "$CLIENT_ID" ]; then
  echo "❌ クライアント作成に失敗しました"
  echo "Response: $RESPONSE"
  exit 1
fi

echo "✅ クライアント作成成功"
echo "   CLIENT_ID: $CLIENT_ID"
echo "   CLIENT_SECRET: ${CLIENT_SECRET:0:20}..."
echo ""

# ============================================
# Step 2: シードデータ生成
# ============================================
echo "🌱 Step 2: シードデータを生成..."
echo "   (テストユーザーとセッションも自動作成されます)"
echo ""

cd "$(dirname "$0")/scripts"

# Light用に少なめのシード
AUTH_CODE_COUNT=30 REFRESH_COUNT=30 node generate-seeds.js

if [ $? -ne 0 ]; then
  echo "❌ シード生成に失敗しました"
  # クリーンアップ
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
echo "🚀 Step 3: Light負荷テストを実行..."
echo ""

cd ..

# Check if k6 is installed
if ! command -v k6 &> /dev/null; then
  echo "❌ k6 がインストールされていません"
  echo "   以下のコマンドでインストールしてください:"
  echo "   brew install k6"
  # クリーンアップ
  curl -s -X DELETE "${BASE_URL}/api/admin/clients/${CLIENT_ID}" \
    -H "Authorization: Bearer ${ADMIN_API_SECRET}" > /dev/null
  exit 1
fi

# テスト開始時刻を記録
TEST_START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Check if run-test.sh exists
if [ -f "./scripts/run-test.sh" ]; then
  ./scripts/run-test.sh test1 light
else
  echo "⚠️  ./scripts/run-test.sh が見つかりません"
  echo "   シードデータは生成されました: seeds/"
  ls -la seeds/
fi

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

  node "$(dirname "$0")/scripts/fetch-cf-analytics.js" \
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

# テスト用クライアントを削除
curl -s -X DELETE "${BASE_URL}/api/admin/clients/${CLIENT_ID}" \
  -H "Authorization: Bearer ${ADMIN_API_SECRET}" > /dev/null

echo "✅ テスト用クライアントを削除しました"
echo ""
echo "📊 テスト完了！結果は results/ ディレクトリを確認してください"
