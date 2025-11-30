#!/bin/bash

#######################################
# Cloudflare Analytics メトリクス収集スクリプト
#
# Usage:
#   ./scripts/collect-metrics.sh
#   ./scripts/collect-metrics.sh --start "2025-11-30T10:00:00Z" --end "2025-11-30T11:00:00Z"
#   ./scripts/collect-metrics.sh --test-name "test1-standard" --output results/
#######################################

set -e

# デフォルト値
START_TIME=""
END_TIME=""
TEST_NAME="load-test"
OUTPUT_DIR="../results"
WORKER_NAME="${WORKER_NAME:-authrim-worker}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID}"
API_TOKEN="${CLOUDFLARE_API_TOKEN}"

# カラー出力
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ヘルプ表示
show_help() {
  cat << EOF
Usage: ./scripts/collect-metrics.sh [OPTIONS]

Cloudflare Analytics からメトリクスを収集します。

OPTIONS:
  --start TIME          開始時刻 (ISO 8601 format, UTC)
  --end TIME            終了時刻 (ISO 8601 format, UTC)
  --test-name NAME      テスト名（結果ファイル名に使用）
  --output DIR          出力ディレクトリ
  --worker NAME         Worker 名
  --help                このヘルプを表示

EXAMPLES:
  # 最新のテスト結果を収集（過去1時間）
  ./scripts/collect-metrics.sh

  # 特定の時間範囲を指定
  ./scripts/collect-metrics.sh --start "2025-11-30T10:00:00Z" --end "2025-11-30T11:00:00Z"

  # テスト名を指定
  ./scripts/collect-metrics.sh --test-name "test1-standard"

ENVIRONMENT VARIABLES:
  CLOUDFLARE_ACCOUNT_ID   Cloudflare Account ID (required)
  CLOUDFLARE_API_TOKEN    Cloudflare API Token (required)
  WORKER_NAME             Worker 名 (default: authrim-worker)

EOF
  exit 0
}

# 引数解析
while [[ $# -gt 0 ]]; do
  case $1 in
    --start)
      START_TIME="$2"
      shift 2
      ;;
    --end)
      END_TIME="$2"
      shift 2
      ;;
    --test-name)
      TEST_NAME="$2"
      shift 2
      ;;
    --output)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --worker)
      WORKER_NAME="$2"
      shift 2
      ;;
    --help)
      show_help
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      show_help
      ;;
  esac
done

# 必須環境変数のチェック
if [ -z "$ACCOUNT_ID" ]; then
  echo -e "${RED}Error: CLOUDFLARE_ACCOUNT_ID is not set${NC}"
  echo "Please set CLOUDFLARE_ACCOUNT_ID environment variable"
  exit 1
fi

if [ -z "$API_TOKEN" ]; then
  echo -e "${RED}Error: CLOUDFLARE_API_TOKEN is not set${NC}"
  echo "Please set CLOUDFLARE_API_TOKEN environment variable"
  exit 1
fi

# 時間範囲の設定
if [ -z "$START_TIME" ]; then
  # デフォルト: 1時間前から現在まで
  START_TIME=$(date -u -v-1H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '1 hour ago' +"%Y-%m-%dT%H:%M:%SZ")
fi

if [ -z "$END_TIME" ]; then
  END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
fi

# 出力ディレクトリの作成
mkdir -p "$OUTPUT_DIR"

# タイムスタンプ
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
OUTPUT_FILE="$OUTPUT_DIR/${TEST_NAME}_${TIMESTAMP}.json"

echo -e "${BLUE}📊 メトリクス収集を開始します...${NC}\n"

echo "テスト情報:"
echo "  Worker: $WORKER_NAME"
echo "  期間: $START_TIME 〜 $END_TIME"
echo "  出力: $OUTPUT_FILE"
echo ""

# GraphQL クエリの構築
QUERY=$(cat << 'EOF'
query {
  viewer {
    accounts(filter: { accountTag: "$ACCOUNT_ID" }) {
      workersInvocationsAdaptive(
        limit: 10000
        filter: {
          scriptName: "$WORKER_NAME"
          datetime_geq: "$START_TIME"
          datetime_lt: "$END_TIME"
        }
      ) {
        sum {
          requests
          errors
          subrequests
        }
        quantiles {
          cpuTimeP50
          cpuTimeP90
          cpuTimeP95
          cpuTimeP99
          durationP50
          durationP90
          durationP95
          durationP99
        }
      }
      durableObjectsInvocationsAdaptive(
        limit: 10000
        filter: {
          scriptName: "$WORKER_NAME"
          datetime_geq: "$START_TIME"
          datetime_lt: "$END_TIME"
        }
      ) {
        sum {
          requests
          cpuTime
          activeTime
        }
        dimensions {
          className
        }
      }
    }
  }
}
EOF
)

# 変数の置換
QUERY=$(echo "$QUERY" | sed "s/\$ACCOUNT_ID/$ACCOUNT_ID/g")
QUERY=$(echo "$QUERY" | sed "s/\$WORKER_NAME/$WORKER_NAME/g")
QUERY=$(echo "$QUERY" | sed "s/\$START_TIME/$START_TIME/g")
QUERY=$(echo "$QUERY" | sed "s/\$END_TIME/$END_TIME/g")

# GraphQL API へのリクエスト
echo -e "${YELLOW}📈 Workers メトリクス取得中...${NC}"

RESPONSE=$(curl -s -X POST \
  https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"query\": $(echo "$QUERY" | jq -Rs .)}")

# レスポンスのチェック
if echo "$RESPONSE" | jq -e '.errors' > /dev/null 2>&1; then
  echo -e "${RED}❌ GraphQL エラー:${NC}"
  echo "$RESPONSE" | jq '.errors'
  exit 1
fi

# 結果の保存
echo "$RESPONSE" | jq '.' > "$OUTPUT_FILE"

echo -e "${GREEN}✅ 完了${NC}\n"

# サマリーの表示
echo -e "${BLUE}📊 結果サマリー:${NC}"

# jq で結果を整形して表示
if command -v jq &> /dev/null; then
  WORKERS_DATA=$(echo "$RESPONSE" | jq -r '.data.viewer.accounts[0].workersInvocationsAdaptive')

  if [ "$WORKERS_DATA" != "null" ]; then
    TOTAL_REQUESTS=$(echo "$WORKERS_DATA" | jq -r '.sum.requests // 0')
    TOTAL_ERRORS=$(echo "$WORKERS_DATA" | jq -r '.sum.errors // 0')
    ERROR_RATE=$(echo "scale=2; $TOTAL_ERRORS * 100 / $TOTAL_REQUESTS" | bc 2>/dev/null || echo "0")

    P50=$(echo "$WORKERS_DATA" | jq -r '.quantiles.durationP50 // 0')
    P90=$(echo "$WORKERS_DATA" | jq -r '.quantiles.durationP90 // 0')
    P99=$(echo "$WORKERS_DATA" | jq -r '.quantiles.durationP99 // 0')

    CPU_P50=$(echo "$WORKERS_DATA" | jq -r '.quantiles.cpuTimeP50 // 0')
    CPU_P99=$(echo "$WORKERS_DATA" | jq -r '.quantiles.cpuTimeP99 // 0')

    echo "┌────────────────────┬──────────┐"
    echo "│ メトリクス         │ 値       │"
    echo "├────────────────────┼──────────┤"
    printf "│ 総リクエスト数     │ %'8d │\n" "$TOTAL_REQUESTS"
    printf "│ エラー数           │ %'8d │\n" "$TOTAL_ERRORS"
    printf "│ エラーレート       │ %7.2f%% │\n" "$ERROR_RATE"
    printf "│ p50 レスポンス     │ %6.0fms │\n" "$P50"
    printf "│ p90 レスポンス     │ %6.0fms │\n" "$P90"
    printf "│ p99 レスポンス     │ %6.0fms │\n" "$P99"
    printf "│ p50 CPU 時間       │ %6.0fms │\n" "$CPU_P50"
    printf "│ p99 CPU 時間       │ %6.0fms │\n" "$CPU_P99"
    echo "└────────────────────┴──────────┘"
  else
    echo -e "${YELLOW}⚠️  データが見つかりませんでした${NC}"
    echo "時間範囲を確認してください: $START_TIME 〜 $END_TIME"
  fi
else
  echo "jq がインストールされていないため、サマリーを表示できません"
fi

echo ""
echo -e "${GREEN}💾 結果保存先: $OUTPUT_FILE${NC}"
echo ""

# 追加の分析提案
echo -e "${BLUE}📌 次のステップ:${NC}"
echo "  1. 詳細な分析: cat $OUTPUT_FILE | jq ."
echo "  2. CSV エクスポート: ./scripts/export-csv.sh $OUTPUT_FILE"
echo "  3. レポート生成: ./scripts/generate-report.sh $OUTPUT_FILE"
echo ""
