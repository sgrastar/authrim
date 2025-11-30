#!/bin/bash
#
# Authrim Load Test Runner with Cloudflare Analytics
#
# k6テスト実行後、Cloudflare GraphQL APIからメトリクスを自動取得します。
#
# 使用方法:
#   ./scripts/run-load-test.sh [TEST_SCRIPT] [OPTIONS]
#
# 例:
#   ./scripts/run-load-test.sh test1 --preset rps50
#   ./scripts/run-load-test.sh test2 --preset light
#
# 環境変数:
#   CF_API_TOKEN: Cloudflare API Token (Analytics read権限が必要)
#   BASE_URL: テスト対象のURL (default: https://conformance.authrim.com)
#   CLIENT_ID: OAuthクライアントID
#   CLIENT_SECRET: OAuthクライアントシークレット
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOAD_TEST_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="${LOAD_TEST_DIR}/results"

# デフォルト値
TEST_SCRIPT="test1"
PRESET="light"
BASE_URL="${BASE_URL:-https://conformance.authrim.com}"
CLIENT_ID="${CLIENT_ID:-b42bdc5e-7183-46ef-859c-fd21d4589cd6}"
CLIENT_SECRET="${CLIENT_SECRET:-6ec3c4aed67c40d9ae8891e4641292ae15cf215264ba4618b7c89356b54b0bde}"
AUTH_CODE_PATH="${AUTH_CODE_PATH:-../seeds/authorization_codes.json}"
REFRESH_TOKEN_PATH="${REFRESH_TOKEN_PATH:-../seeds/refresh_tokens.json}"
CF_API_TOKEN="${CF_API_TOKEN:-}"
CF_ANALYTICS_BUFFER="${CF_ANALYTICS_BUFFER:-60}"  # Analytics取得時の前後バッファ（秒）

# 引数解析
while [[ $# -gt 0 ]]; do
  case $1 in
    test1|test2)
      TEST_SCRIPT="$1"
      shift
      ;;
    --preset|-p)
      PRESET="$2"
      shift 2
      ;;
    --no-analytics)
      SKIP_ANALYTICS=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [TEST_SCRIPT] [OPTIONS]"
      echo ""
      echo "Test Scripts:"
      echo "  test1    /token 単体負荷テスト"
      echo "  test2    refresh_token ストームテスト"
      echo ""
      echo "Options:"
      echo "  --preset, -p PRESET   使用するプリセット (light, rps50, standard, rps200, heavy)"
      echo "  --no-analytics        Cloudflare Analytics取得をスキップ"
      echo "  --help, -h            このヘルプを表示"
      echo ""
      echo "Environment Variables:"
      echo "  CF_API_TOKEN          Cloudflare API Token"
      echo "  BASE_URL              テスト対象URL"
      echo "  CLIENT_ID             OAuthクライアントID"
      echo "  CLIENT_SECRET         OAuthクライアントシークレット"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# 結果ディレクトリの作成
mkdir -p "$RESULTS_DIR"

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "  🚀 Authrim Load Test Runner"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "  Test Script:  ${TEST_SCRIPT}"
echo "  Preset:       ${PRESET}"
echo "  Target:       ${BASE_URL}"
echo "  Results Dir:  ${RESULTS_DIR}"
echo "───────────────────────────────────────────────────────────────────────────────"
echo ""

# テスト開始時刻を記録 (ISO 8601 UTC)
START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "📅 テスト開始時刻: ${START_TIME}"
echo ""

# k6テスト実行
echo "🔄 k6テスト実行中..."
echo ""

cd "$LOAD_TEST_DIR"

K6_EXIT_CODE=0
k6 run \
  --env PRESET="${PRESET}" \
  --env BASE_URL="${BASE_URL}" \
  --env CLIENT_ID="${CLIENT_ID}" \
  --env CLIENT_SECRET="${CLIENT_SECRET}" \
  --env AUTH_CODE_PATH="${AUTH_CODE_PATH}" \
  --env REFRESH_TOKEN_PATH="${REFRESH_TOKEN_PATH}" \
  --env RESULTS_DIR="${RESULTS_DIR}" \
  "scripts/${TEST_SCRIPT}-token-load.js" 2>&1 || K6_EXIT_CODE=$?

# テスト終了時刻を記録
END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo ""
echo "📅 テスト終了時刻: ${END_TIME}"

# Cloudflare Analytics取得
if [[ -z "${SKIP_ANALYTICS}" ]] && [[ -n "${CF_API_TOKEN}" ]]; then
  echo ""
  echo "───────────────────────────────────────────────────────────────────────────────"
  echo "📊 Cloudflare Analytics 取得中..."
  echo "───────────────────────────────────────────────────────────────────────────────"

  # 少し待機してからAnalyticsを取得（データ反映の遅延を考慮）
  echo "   ⏳ Analyticsデータ反映待機 (10秒)..."
  sleep 10

  # Analytics取得のための時間範囲を計算（バッファを追加）
  # macOSとLinuxの両方に対応
  if [[ "$(uname)" == "Darwin" ]]; then
    # macOS
    ANALYTICS_START=$(date -u -j -v-${CF_ANALYTICS_BUFFER}S -f "%Y-%m-%dT%H:%M:%SZ" "${START_TIME}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "${START_TIME}")
    ANALYTICS_END=$(date -u -j -v+${CF_ANALYTICS_BUFFER}S -f "%Y-%m-%dT%H:%M:%SZ" "${END_TIME}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "${END_TIME}")
  else
    # Linux
    ANALYTICS_START=$(date -u -d "${START_TIME} - ${CF_ANALYTICS_BUFFER} seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "${START_TIME}")
    ANALYTICS_END=$(date -u -d "${END_TIME} + ${CF_ANALYTICS_BUFFER} seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "${END_TIME}")
  fi

  echo "   期間: ${ANALYTICS_START} ~ ${ANALYTICS_END}"
  echo ""

  CF_API_TOKEN="${CF_API_TOKEN}" node "${SCRIPT_DIR}/fetch-cf-analytics.js" \
    --start "${ANALYTICS_START}" \
    --end "${ANALYTICS_END}" || echo "⚠️  Analytics取得に失敗しました（テスト結果には影響しません）"
else
  if [[ -z "${CF_API_TOKEN}" ]]; then
    echo ""
    echo "⚠️  CF_API_TOKEN が設定されていないため、Cloudflare Analyticsはスキップされました"
    echo "   設定方法: export CF_API_TOKEN=\"your-token\""
  fi
fi

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "  ✅ テスト完了"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""

exit ${K6_EXIT_CODE}
