#!/bin/bash
# OIDC Conformance 全テスト自動実行スクリプト
#
# 全てのスペックファイルを順次実行し、実行記録を日付ベースのMarkdownファイルに保存します。
# FAPI/CIBA テストは除外されます。
#
# Usage:
#   ./run-all-conformance-tests.sh [--yes]
#
# Options:
#   --yes    確認プロンプトをスキップして即座に実行開始

set -e  # エラー時は即終了（テストループ内では set +e でエラー継続）

# ============================================================
# コマンドライン引数の処理
# ============================================================
SKIP_CONFIRM=false
if [[ "$1" == "--yes" ]] || [[ "$1" == "-y" ]]; then
    SKIP_CONFIRM=true
fi

# ============================================================
# 設定
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SPECS_DIR="$SCRIPT_DIR/specs"
OUTPUT_BASE_DIR="$SCRIPT_DIR/../OIDC All Tests"
DATE=$(date +%Y-%m-%d)
TIME=$(date +%H%M%S)
OUTPUT_FILE="$OUTPUT_BASE_DIR/${DATE}_all-tests.md"
LOG_FILE="$OUTPUT_BASE_DIR/${DATE}_all-tests.log"
WAIT_SECONDS=${WAIT_SECONDS:-120}  # デフォルト2分

# ============================================================
# 環境変数チェック
# ============================================================
if [ -z "$CONFORMANCE_TOKEN" ]; then
    echo "Error: CONFORMANCE_TOKEN が設定されていません"
    echo "Usage: CONFORMANCE_TOKEN=xxx ADMIN_API_SECRET=xxx $0"
    exit 1
fi

if [ -z "$ADMIN_API_SECRET" ]; then
    echo "Error: ADMIN_API_SECRET が設定されていません"
    echo "Usage: CONFORMANCE_TOKEN=xxx ADMIN_API_SECRET=xxx $0"
    exit 1
fi

# ============================================================
# スペックディレクトリの確認
# ============================================================
if [ ! -d "$SPECS_DIR" ]; then
    echo "Error: specs ディレクトリが見つかりません: $SPECS_DIR"
    exit 1
fi

# ディレクトリ移動
cd "$SCRIPT_DIR"

# ============================================================
# スペックファイルの列挙（FAPI/CIBA/3rdparty/rp-logout-op除外、アルファベット順）
# rp-logout-opテストは手動アップロードが多いため手動テスト推奨
# ============================================================
SPEC_FILES=$(ls "$SPECS_DIR"/*.json 2>/dev/null | grep -v -E '(fapi|ciba|3rdparty|rp-logout-op)' | sort)
SPEC_COUNT=$(echo "$SPEC_FILES" | wc -l | tr -d ' ')

if [ "$SPEC_COUNT" -eq 0 ]; then
    echo "Error: 実行対象のスペックファイルが見つかりません"
    exit 1
fi

# ============================================================
# 実行前の確認プロンプト
# ============================================================
echo "=========================================="
echo "OIDC Conformance 全テスト実行"
echo "=========================================="
echo ""
echo "実行対象テスト数: $SPEC_COUNT"
echo "テスト間待機時間: ${WAIT_SECONDS}秒 (約$(($WAIT_SECONDS / 60))分)"
echo "推定実行時間: 約$(($SPEC_COUNT * ($WAIT_SECONDS + 900) / 3600))時間"
echo ""
echo "除外テスト: FAPI/CIBA/3rdparty/rp-logout-op (手動テスト推奨)"
echo ""
echo "記録ファイル: $OUTPUT_FILE"
echo "詳細ログ: $LOG_FILE"
echo ""

if [ "$SKIP_CONFIRM" = false ]; then
    read -p "実行しますか? (y/n): " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "キャンセルされました"
        exit 0
    fi

    echo ""
fi

echo "実行を開始します..."
echo ""

# ============================================================
# 出力ディレクトリとファイルの初期化
# ============================================================
mkdir -p "$OUTPUT_BASE_DIR"

# Markdownファイルのヘッダー作成
START_TIME=$(date +%Y-%m-%d\ %H:%M:%S)
cat > "$OUTPUT_FILE" << EOF
# OIDC Conformance 全テスト実行記録

実行日: $DATE
開始時刻: $START_TIME

**環境変数:**
- CONFORMANCE_TOKEN: 設定済み
- ADMIN_API_SECRET: 設定済み
- WAIT_SECONDS: ${WAIT_SECONDS}秒

**実行対象:**
- 総テスト数: $SPEC_COUNT
- 除外: FAPI/CIBA/3rdparty/rp-logout-op テスト (手動テスト推奨)

---

## テスト結果

EOF

# 詳細ログファイルのヘッダー
cat > "$LOG_FILE" << EOF
========================================
OIDC Conformance 全テスト実行ログ
開始時刻: $START_TIME
========================================

EOF

# ============================================================
# 各テストの実行ループ
# ============================================================
COMPLETED=0
SUCCESS=0
FAILED=0

# テストループ内ではエラーでも継続
set +e

for spec_file in $SPEC_FILES; do
    COMPLETED=$((COMPLETED + 1))
    SPEC_NAME=$(basename "$spec_file" .json)

    echo "==========================================" | tee -a "$LOG_FILE"
    echo "[$COMPLETED/$SPEC_COUNT] $SPEC_NAME" | tee -a "$LOG_FILE"
    echo "==========================================" | tee -a "$LOG_FILE"

    # テスト開始時刻
    TEST_START_TIME=$(date +%Y-%m-%d\ %H:%M:%S)
    TEST_START_TIMESTAMP=$(date +%s)

    echo "開始時刻: $TEST_START_TIME" | tee -a "$LOG_FILE"
    echo "" | tee -a "$LOG_FILE"

    # テスト実行（エラーでも継続）
    # 出力を一時ファイルに保存して解析
    TEMP_OUTPUT="/tmp/conformance_test_$$.tmp"
    echo "実行中..." | tee -a "$LOG_FILE"
    if CONFORMANCE_TOKEN="$CONFORMANCE_TOKEN" \
       ADMIN_API_SECRET="$ADMIN_API_SECRET" \
       npx tsx run-conformance.ts --spec "$spec_file" 2>&1 | tee -a "$LOG_FILE" "$TEMP_OUTPUT"; then
        STATUS="✅ 成功"
        SUCCESS=$((SUCCESS + 1))
    else
        STATUS="❌ 失敗"
        FAILED=$((FAILED + 1))
    fi

    # テスト結果の詳細を抽出（macOS互換）
    PASS_RATE=""
    TESTS_PASSED=""
    TESTS_TOTAL=""
    UNEXPECTED_FAILURES=""

    if [ -f "$TEMP_OUTPUT" ]; then
        # "Pass Rate: XX%" を抽出
        PASS_RATE=$(grep -o "Pass Rate: [0-9.]*%" "$TEMP_OUTPUT" | tail -1 | sed 's/Pass Rate: //')
        # "Tests: XX/YY passed" を抽出
        TESTS_INFO=$(grep -o "Tests: [0-9]*/[0-9]* passed" "$TEMP_OUTPUT" | tail -1 | sed 's/Tests: //' | sed 's/ passed//')
        if [ -n "$TESTS_INFO" ]; then
            TESTS_PASSED=$(echo "$TESTS_INFO" | cut -d'/' -f1)
            TESTS_TOTAL=$(echo "$TESTS_INFO" | cut -d'/' -f2)
        fi
        # "Unexpected Failures: XX" を抽出
        UNEXPECTED_FAILURES=$(grep -o "Unexpected Failures: [0-9]*" "$TEMP_OUTPUT" | tail -1 | sed 's/Unexpected Failures: //')
        rm -f "$TEMP_OUTPUT"
    fi

    # テスト終了時刻
    TEST_END_TIME=$(date +%Y-%m-%d\ %H:%M:%S)
    TEST_END_TIMESTAMP=$(date +%s)
    DURATION=$((TEST_END_TIMESTAMP - TEST_START_TIMESTAMP))
    DURATION_MIN=$((DURATION / 60))
    DURATION_SEC=$((DURATION % 60))

    # 記録をMarkdownファイルに追記
    cat >> "$OUTPUT_FILE" << EOF
### $COMPLETED. $SPEC_NAME

- **ステータス**: $STATUS
- **開始時刻**: $TEST_START_TIME
- **終了時刻**: $TEST_END_TIME
- **実行時間**: ${DURATION}秒 (約${DURATION_MIN}分${DURATION_SEC}秒)
- **スペックファイル**: \`$(basename "$spec_file")\`
EOF

    # テスト結果の詳細を追記
    if [ -n "$TESTS_TOTAL" ]; then
        cat >> "$OUTPUT_FILE" << EOF
- **テスト結果**: ${TESTS_PASSED}/${TESTS_TOTAL} 成功
EOF
    fi

    if [ -n "$PASS_RATE" ]; then
        cat >> "$OUTPUT_FILE" << EOF
- **成功率**: ${PASS_RATE}
EOF
    fi

    if [ -n "$UNEXPECTED_FAILURES" ] && [ "$UNEXPECTED_FAILURES" != "0" ]; then
        cat >> "$OUTPUT_FILE" << EOF
- **予期しない失敗**: ${UNEXPECTED_FAILURES}件 ⚠️
EOF
    fi

    cat >> "$OUTPUT_FILE" << EOF

---

EOF

    echo "" | tee -a "$LOG_FILE"
    echo "ステータス: $STATUS" | tee -a "$LOG_FILE"
    echo "終了時刻: $TEST_END_TIME" | tee -a "$LOG_FILE"
    echo "実行時間: ${DURATION_MIN}分${DURATION_SEC}秒" | tee -a "$LOG_FILE"
    echo "" | tee -a "$LOG_FILE"

    # 最後のテスト以外は待機
    if [ $COMPLETED -lt $SPEC_COUNT ]; then
        # 失敗時は1分、成功時は設定された待機時間
        if [ "$STATUS" = "❌ 失敗" ]; then
            CURRENT_WAIT=60
            echo "次のテストまで${CURRENT_WAIT}秒 (1分) 待機中... (失敗のため短縮)" | tee -a "$LOG_FILE"
        else
            CURRENT_WAIT=$WAIT_SECONDS
            echo "次のテストまで${CURRENT_WAIT}秒 (約$(($CURRENT_WAIT / 60))分) 待機中..." | tee -a "$LOG_FILE"
        fi
        sleep $CURRENT_WAIT
        echo "" | tee -a "$LOG_FILE"
    fi
done

# エラーチェック再開
set -e

# ============================================================
# サマリーの追記
# ============================================================
FINISH_TIME=$(date +%Y-%m-%d\ %H:%M:%S)
SUCCESS_RATE=$(awk "BEGIN {printf \"%.1f\", ($SUCCESS/$SPEC_COUNT)*100}")

cat >> "$OUTPUT_FILE" << EOF

## 実行サマリー

- **終了時刻**: $FINISH_TIME
- **総テスト数**: $SPEC_COUNT
- **成功**: $SUCCESS ✅
- **失敗**: $FAILED ❌
- **成功率**: ${SUCCESS_RATE}%

---

## 詳細ログ

詳細な実行ログは以下のファイルを参照してください：
\`${LOG_FILE}\`

EOF

echo "==========================================" | tee -a "$LOG_FILE"
echo "全テスト完了" | tee -a "$LOG_FILE"
echo "==========================================" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "終了時刻: $FINISH_TIME" | tee -a "$LOG_FILE"
echo "総テスト数: $SPEC_COUNT" | tee -a "$LOG_FILE"
echo "成功: $SUCCESS ✅" | tee -a "$LOG_FILE"
echo "失敗: $FAILED ❌" | tee -a "$LOG_FILE"
echo "成功率: ${SUCCESS_RATE}%" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "記録ファイル: $OUTPUT_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

echo "=========================================="
echo "実行記録が保存されました："
echo "  - Markdown: $OUTPUT_FILE"
echo "  - ログ: $LOG_FILE"
echo "=========================================="
