#!/bin/bash
# R2にシードデータをアップロードするスクリプト
#
# 使い方:
#   ./scripts/upload-seeds-to-r2.sh [seed_file]
#
# 例:
#   ./scripts/upload-seeds-to-r2.sh                          # デフォルト: seeds/authorization_codes.json
#   ./scripts/upload-seeds-to-r2.sh seeds/custom_seeds.json  # カスタムファイル

set -e

# 設定
BUCKET_NAME="authrim-loadtest-seeds"
R2_PUBLIC_URL="https://pub-999cabb8466b46c4a2b32b63ef5579cc.r2.dev"

# 引数処理
SEED_FILE="${1:-seeds/authorization_codes.json}"

# ファイル存在確認
if [ ! -f "$SEED_FILE" ]; then
    echo "❌ Error: Seed file not found: $SEED_FILE"
    exit 1
fi

# ファイル情報
FILE_SIZE=$(ls -lh "$SEED_FILE" | awk '{print $5}')
CODE_COUNT=$(jq 'length' "$SEED_FILE" 2>/dev/null || echo "unknown")
OBJECT_NAME="authcodes-$(date +%Y%m%d%H%M%S).json"

echo "🚀 R2 Seed Upload"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📁 Source file: $SEED_FILE"
echo "📊 File size: $FILE_SIZE"
echo "🔢 Auth codes: $CODE_COUNT"
echo "🗂️  Object name: $OBJECT_NAME"
echo "🪣 Bucket: $BUCKET_NAME"
echo ""

# アップロード実行
echo "⏳ Uploading to R2..."
npx wrangler r2 object put "$BUCKET_NAME/$OBJECT_NAME" --file "$SEED_FILE" --content-type "application/json"

# 結果表示
PUBLIC_URL="${R2_PUBLIC_URL}/${OBJECT_NAME}"
echo ""
echo "✅ Upload complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🌐 Public URL:"
echo "   $PUBLIC_URL"
echo ""
echo "📋 K6 Cloud実行用コマンド:"
echo "   k6 cloud --env AUTH_CODE_URL=\"$PUBLIC_URL\" --env PRESET=rps1000 scripts/test-authcode.js"
echo ""

# URL検証
echo "⏳ Verifying URL accessibility..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$PUBLIC_URL")
if [ "$HTTP_STATUS" = "200" ]; then
    echo "✅ URL is accessible (HTTP $HTTP_STATUS)"
else
    echo "⚠️  URL returned HTTP $HTTP_STATUS (may take a moment to propagate)"
fi

# 環境変数ファイル更新
ENV_FILE=".env.k6cloud"
echo ""
echo "📝 Updating $ENV_FILE..."
if [ -f "$ENV_FILE" ]; then
    # 既存のAUTH_CODE_URLを削除
    grep -v "^AUTH_CODE_URL=" "$ENV_FILE" > "${ENV_FILE}.tmp" || true
    mv "${ENV_FILE}.tmp" "$ENV_FILE"
fi
echo "AUTH_CODE_URL=$PUBLIC_URL" >> "$ENV_FILE"
echo "✅ $ENV_FILE updated"
