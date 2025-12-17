#!/bin/bash
# =============================================================================
# Passkey負荷テスト用カスタムk6バイナリビルドスクリプト
# =============================================================================
#
# 概要:
#   xk6-passkeys拡張(Authrimフォーク版)を含むカスタムk6バイナリをビルドします。
#   このバイナリを使うことで、Passkey認証のECDSA P-256署名を
#   k6スクリプト内で生成できるようになります。
#
#   フォーク版の追加機能:
#   - ExportCredential() / ImportCredential(): setup()とdefault()間でのクレデンシャル共有
#   - ExportRelyingParty() / ImportRelyingParty(): RP設定のシリアライズ
#
# 必要環境:
#   - Go 1.23+ (https://go.dev/dl/)
#   - Git
#   - Make (オプション)
#   ※ Dockerは不要
#
# 使い方:
#   ./scripts/build-k6-passkeys.sh
#
# 出力:
#   ./bin/k6-passkeys (カスタムk6バイナリ)
#
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${PROJECT_ROOT}/bin"
OUTPUT_BINARY="${OUTPUT_DIR}/k6-passkeys"

echo "=============================================="
echo "🔨 Building k6 with xk6-passkeys extension"
echo "=============================================="
echo ""

# Go バージョン確認
if ! command -v go &> /dev/null; then
    echo "❌ Error: Go is not installed"
    echo "   Please install Go 1.23+ from https://go.dev/dl/"
    exit 1
fi

GO_VERSION=$(go version | grep -oE 'go[0-9]+\.[0-9]+' | sed 's/go//')
GO_MAJOR=$(echo "$GO_VERSION" | cut -d. -f1)
GO_MINOR=$(echo "$GO_VERSION" | cut -d. -f2)

if [ "$GO_MAJOR" -lt 1 ] || ([ "$GO_MAJOR" -eq 1 ] && [ "$GO_MINOR" -lt 23 ]); then
    echo "❌ Error: Go 1.23+ is required (found: go${GO_VERSION})"
    exit 1
fi

echo "✅ Go version: go${GO_VERSION}"

# xk6 インストール
echo ""
echo "📦 Installing xk6 build tool..."
go install go.k6.io/xk6/cmd/xk6@latest

# PATH確認
if ! command -v xk6 &> /dev/null; then
    export PATH="$PATH:$(go env GOPATH)/bin"
fi

# ビルド実行
echo ""
echo "🔨 Building k6 with passkeys extension (Authrim fork)..."
echo "   Extension: github.com/authrim/xk6-passkeys (local)"
echo "   Source: ${PROJECT_ROOT}/extensions/xk6-passkeys"

# 一時ディレクトリでビルド（既存のgo.modとの競合を避ける）
BUILD_DIR=$(mktemp -d)
cd "$BUILD_DIR"

# ローカルフォーク版を使用してビルド
xk6 build --with github.com/authrim/xk6-passkeys="${PROJECT_ROOT}/extensions/xk6-passkeys"

# 出力ディレクトリ作成・移動
echo ""
echo "📁 Moving k6 binary to ${OUTPUT_BINARY}"
mkdir -p "$OUTPUT_DIR"
mv ./k6 "$OUTPUT_BINARY"

# 一時ディレクトリ削除
cd "$PROJECT_ROOT"
rm -rf "$BUILD_DIR"

# 実行権限付与
chmod +x "$OUTPUT_BINARY"

# バージョン確認
echo ""
echo "✅ Build complete!"
echo ""
echo "k6 version:"
"$OUTPUT_BINARY" version
echo ""
echo "=============================================="
echo "Usage:"
echo "  ${OUTPUT_BINARY} run --env BASE_URL=... scripts/test-passkey-full-login-benchmark.js"
echo "=============================================="
