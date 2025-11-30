#!/bin/bash

#######################################
# 負荷テスト実行ヘルパースクリプト
#
# Usage:
#   ./scripts/run-test.sh test1 light
#   ./scripts/run-test.sh test2 standard
#   ./scripts/run-test.sh test3 heavy
#######################################

set -e

# カラー出力
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# スクリプトのディレクトリ
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# デフォルト値
BASE_URL="${BASE_URL:-https://conformance.authrim.com}"
CLIENT_ID="${CLIENT_ID}"
CLIENT_SECRET="${CLIENT_SECRET}"
RESULTS_DIR="${RESULTS_DIR:-$PROJECT_ROOT/results}"

# ヘルプ表示
show_help() {
  cat << EOF
Usage: ./scripts/run-test.sh <test> <preset>

負荷テストを実行します。

ARGUMENTS:
  test      テスト番号 (test1, test2, test3)
  preset    プリセット (light, standard, heavy)

TESTS:
  test1     /token 単体負荷テスト
  test2     Refresh Token Storm
  test3     フル OIDC 認証フロー

PRESETS:
  light     軽負荷 - 実サービスの通常運用相当
  standard  中負荷 - MAU 10万〜30万のピーク想定
  heavy     重負荷 - アーキテクチャの天井計測

EXAMPLES:
  ./scripts/run-test.sh test1 light
  ./scripts/run-test.sh test2 standard
  ./scripts/run-test.sh test3 heavy

ENVIRONMENT VARIABLES:
  BASE_URL        テスト対象URL (default: https://conformance.authrim.com)
  CLIENT_ID       クライアントID (required)
  CLIENT_SECRET   クライアントシークレット (required)

EOF
  exit 0
}

# 引数チェック
if [ "$1" == "--help" ] || [ "$1" == "-h" ]; then
  show_help
fi

if [ $# -lt 2 ]; then
  echo -e "${RED}Error: 引数が不足しています${NC}"
  show_help
fi

TEST_NAME=$1
PRESET=$2

# テスト名の検証
case $TEST_NAME in
  test1)
    TEST_SCRIPT="test1-token-load.js"
    TEST_DESCRIPTION="/token 単体負荷テスト"
    ;;
  test2)
    TEST_SCRIPT="test2-refresh-storm.js"
    TEST_DESCRIPTION="Refresh Token Storm"
    ;;
  test3)
    TEST_SCRIPT="test3-full-oidc.js"
    TEST_DESCRIPTION="フル OIDC 認証フロー"
    ;;
  *)
    echo -e "${RED}Error: 不正なテスト名: $TEST_NAME${NC}"
    echo "有効なテスト: test1, test2, test3"
    exit 1
    ;;
esac

# プリセットの検証
case $PRESET in
  light|standard|heavy)
    ;;
  *)
    echo -e "${RED}Error: 不正なプリセット: $PRESET${NC}"
    echo "有効なプリセット: light, standard, heavy"
    exit 1
    ;;
esac

# 必須環境変数のチェック
if [ -z "$CLIENT_ID" ]; then
  echo -e "${YELLOW}Warning: CLIENT_ID is not set${NC}"
  echo "テストにはクライアント認証情報が必要です"
  echo "export CLIENT_ID=your_client_id"
  # テストを続行（デフォルト値を使用）
fi

if [ -z "$CLIENT_SECRET" ]; then
  echo -e "${YELLOW}Warning: CLIENT_SECRET is not set${NC}"
  echo "テストにはクライアント認証情報が必要です"
  echo "export CLIENT_SECRET=your_client_secret"
  # テストを続行（デフォルト値を使用）
fi

# k6 のチェック
if ! command -v k6 &> /dev/null; then
  echo -e "${RED}Error: k6 がインストールされていません${NC}"
  echo ""
  echo "インストール方法:"
  echo "  macOS:  brew install k6"
  echo "  Linux:  https://k6.io/docs/getting-started/installation/"
  exit 1
fi

# テスト開始
echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Authrim 負荷テスト${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""
echo -e "${BLUE}テスト情報:${NC}"
echo "  テスト: $TEST_DESCRIPTION ($TEST_NAME)"
echo "  プリセット: $PRESET"
echo "  ターゲット: $BASE_URL"
echo "  スクリプト: $TEST_SCRIPT"
echo ""

# プリセット情報の表示
PRESET_FILE="$PROJECT_ROOT/presets/${PRESET}.json"
if [ -f "$PRESET_FILE" ]; then
  echo -e "${BLUE}プリセット詳細:${NC}"
  if command -v jq &> /dev/null; then
    cat "$PRESET_FILE" | jq -r ".${TEST_NAME} |
      \"  RPS: \(.rps.start // .rps.constant) \(.rps.end // \"\")\n\" +
      \"  Duration: \(.duration)\n\" +
      \"  VUs: \(.vus)\n\" +
      \"  Thresholds: p99 < \(.thresholds.p99_ms // \"N/A\")ms, error rate < \(.thresholds.error_rate_percent // \"N/A\")%\"
    " 2>/dev/null || cat "$PRESET_FILE"
  else
    cat "$PRESET_FILE"
  fi
  echo ""
fi

# 確認プロンプト（heavy のみ）
if [ "$PRESET" == "heavy" ]; then
  echo -e "${YELLOW}⚠️  警告: Heavy プリセットは高負荷テストです${NC}"
  echo "このテストは以下の影響を及ぼす可能性があります:"
  echo "  - 一時的なレスポンスタイムの低下"
  echo "  - Rate Limiting の発動"
  echo "  - Cloudflare の課金増加"
  echo ""
  read -p "続行しますか？ (yes/no): " -r
  echo
  if [[ ! $REPLY =~ ^[Yy](es)?$ ]]; then
    echo "テストをキャンセルしました"
    exit 0
  fi
fi

# テスト実行
echo -e "${GREEN}🚀 テスト開始...${NC}"
echo ""

mkdir -p "$RESULTS_DIR"

# k6 実行
cd "$SCRIPT_DIR"

k6 run \
  --env BASE_URL="$BASE_URL" \
  --env CLIENT_ID="$CLIENT_ID" \
  --env CLIENT_SECRET="$CLIENT_SECRET" \
  --env RESULTS_DIR="$RESULTS_DIR" \
  --env PRESET="$PRESET" \
  "$TEST_SCRIPT"

TEST_EXIT_CODE=$?

echo ""

# 結果の判定
if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}✅ テスト完了${NC}"
else
  echo -e "${RED}❌ テスト失敗 (exit code: $TEST_EXIT_CODE)${NC}"
fi

echo ""
echo -e "${BLUE}次のステップ:${NC}"
echo "  1. メトリクス収集（5-10分待機後）:"
echo "     ./scripts/collect-metrics.sh --test-name \"${TEST_NAME}-${PRESET}\""
echo ""
echo "  2. 結果の確認:"
echo "     ls -la \"$RESULTS_DIR\""
echo ""
echo "  3. 詳細な分析:"
echo "     cat \"$RESULTS_DIR/${TEST_NAME}-${PRESET}_\"*.json | jq ."
echo ""

exit $TEST_EXIT_CODE
