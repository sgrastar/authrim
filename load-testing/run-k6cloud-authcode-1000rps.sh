#!/bin/bash
# K6 Cloud - AuthCode 1000 RPS / 2分間テスト
#
# 使用方法:
#   ./run-k6cloud-authcode-1000rps.sh
#
# 必要条件:
#   - K6 Cloud へのログイン (k6 login cloud)
#   - seeds/authorization_codes.json に150,000件以上のコード
#
# テスト構成:
#   - ランプアップ: 15秒で 0 → 1000 RPS
#   - 維持: 120秒（2分間）1000 RPS
#   - ランプダウン: 15秒で 1000 → 0 RPS
#   - 実行リージョン: Tokyo (amazon:jp:tokyo)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 環境変数
export BASE_URL="${BASE_URL:-https://conformance.authrim.com}"
export CLIENT_ID="${CLIENT_ID:-b42bdc5e-7183-46ef-859c-fd21d4589cd6}"
export CLIENT_SECRET="${CLIENT_SECRET:-6ec3c4aed67c40d9ae8891e4641292ae15cf215264ba4618b7c89356b54b0bde}"
export REDIRECT_URI="${REDIRECT_URI:-https://localhost:3000/callback}"
export PRESET="rps1000"
export AUTH_CODE_PATH="../seeds/authorization_codes.json"
export MAX_INSTANCES="${MAX_INSTANCES:-10}"

# シードファイルの確認
if [ ! -f "seeds/authorization_codes.json" ]; then
    echo "❌ Error: seeds/authorization_codes.json が見つかりません"
    echo "   seed-authcodes.js でシードを生成してください"
    exit 1
fi

# シード数の確認
SEED_COUNT=$(cat seeds/authorization_codes.json | node -e "const d=require('fs').readFileSync(0,'utf8'); console.log(JSON.parse(d).length)")
REQUIRED_COUNT=135000

echo "📊 AuthCode 1000 RPS テスト (K6 Cloud)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📍 ターゲット: $BASE_URL"
echo "📦 シード数: $SEED_COUNT (必要: $REQUIRED_COUNT 以上)"
echo "⚡ プリセット: $PRESET"
echo "🌏 リージョン: Tokyo (amazon:jp:tokyo)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$SEED_COUNT" -lt "$REQUIRED_COUNT" ]; then
    echo "⚠️  Warning: シード数が推奨値未満です"
    echo "   テスト後半でシード不足によるスキップが発生する可能性があります"
    read -p "続行しますか? (y/N): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        echo "中止しました"
        exit 1
    fi
fi

echo ""
echo "🚀 K6 Cloud テストを開始します..."
echo ""

# K6 Cloud で実行
k6 cloud scripts/test-authcode.js

echo ""
echo "✅ テスト完了"
echo "📊 結果は K6 Cloud ダッシュボードで確認できます:"
echo "   https://app.k6.io/"
