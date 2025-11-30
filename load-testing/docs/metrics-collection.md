# メトリクス収集手順

## 概要

負荷テスト実行後、Cloudflare Graph API（GraphQL Analytics）と wrangler を使用してメトリクスを収集します。

## 前提条件

### 1. Cloudflare API Token の準備

Cloudflare Dashboard から API Token を作成：

1. https://dash.cloudflare.com/profile/api-tokens にアクセス
2. "Create Token" をクリック
3. 以下の権限を付与：
   - **Account** → **Workers Scripts** → **Read**
   - **Account** → **Analytics** → **Read**
   - **Account** → **Logs** → **Read**
4. トークンをコピーして保存

### 2. 環境変数の設定

`.env` ファイルに追加：

```bash
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token_here
WORKER_NAME=authrim-worker
```

または、環境変数として直接エクスポート：

```bash
export CLOUDFLARE_ACCOUNT_ID=your_account_id
export CLOUDFLARE_API_TOKEN=your_api_token_here
```

### 3. wrangler の認証

```bash
# API トークンを使用する場合
export CLOUDFLARE_API_TOKEN=your_api_token_here

# または、対話的ログイン
wrangler login
```

## 収集するメトリクス

### 1. Workers メトリクス

| メトリクス | 説明 | 重要度 |
|-----------|------|--------|
| **requests** | 総リクエスト数 | ★★★ |
| **errors** | エラー数（4xx/5xx） | ★★★ |
| **cpuTime** | CPU 使用時間（ms） | ★★★ |
| **duration** | 処理時間（p50/p90/p99） | ★★★ |
| **subrequests** | サブリクエスト数（DO/KV/D1） | ★★☆ |

### 2. Durable Objects メトリクス

| メトリクス | 説明 | 重要度 |
|-----------|------|--------|
| **invocations** | DO 実行回数 | ★★★ |
| **activeTime** | アクティブ時間 | ★★☆ |
| **cpuTime** | CPU 時間 | ★★★ |

### 3. D1 メトリクス

| メトリクス | 説明 | 重要度 |
|-----------|------|--------|
| **readQueries** | 読み取りクエリ数 | ★★☆ |
| **writeQueries** | 書き込みクエリ数 | ★★★ |
| **rowsRead** | 読み取り行数 | ★☆☆ |
| **rowsWritten** | 書き込み行数 | ★★☆ |

### 4. KV メトリクス

| メトリクス | 説明 | 重要度 |
|-----------|------|--------|
| **reads** | 読み取り回数 | ★★☆ |
| **writes** | 書き込み回数 | ★☆☆ |

## GraphQL クエリの実行

### 方法 1: wrangler を使った手動クエリ（推奨）

#### Workers 統計の取得

```bash
wrangler graphql --account-id $CLOUDFLARE_ACCOUNT_ID <<'EOF'
query {
  viewer {
    accounts(filter: { accountTag: "$CLOUDFLARE_ACCOUNT_ID" }) {
      workersInvocationsAdaptive(
        limit: 10000
        filter: {
          scriptName: "authrim-worker"
          datetime_geq: "2025-11-30T00:00:00Z"
          datetime_lt: "2025-11-30T23:59:59Z"
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
          cpuTimeP99
          durationP50
          durationP90
          durationP99
        }
      }
    }
  }
}
EOF
```

#### Durable Objects 統計の取得

```bash
wrangler graphql --account-id $CLOUDFLARE_ACCOUNT_ID <<'EOF'
query {
  viewer {
    accounts(filter: { accountTag: "$CLOUDFLARE_ACCOUNT_ID" }) {
      durableObjectsInvocationsAdaptive(
        limit: 10000
        filter: {
          scriptName: "authrim-worker"
          datetime_geq: "2025-11-30T00:00:00Z"
          datetime_lt: "2025-11-30T23:59:59Z"
        }
      ) {
        sum {
          requests
          cpuTime
          inboundWebsocketMsgCount
          outboundWebsocketMsgCount
        }
        dimensions {
          className
        }
      }
    }
  }
}
EOF
```

### 方法 2: curl を使った直接 API 呼び出し

```bash
curl -X POST https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data @queries/worker_stats.graphql
```

### 方法 3: 自動化スクリプト（後述）

```bash
./scripts/collect-metrics.sh
```

## wrangler tail によるリアルタイムログ

テスト実行中にリアルタイムでログを確認：

```bash
wrangler tail authrim-worker --format pretty
```

### フィルタリング例

```bash
# エラーのみ表示
wrangler tail authrim-worker --status error

# 特定のメソッドのみ
wrangler tail authrim-worker --method POST

# サンプリング（10%）
wrangler tail authrim-worker --sampling-rate 0.1
```

## 結果の保存と整形

### JSON 形式で保存

```bash
wrangler graphql --account-id $CLOUDFLARE_ACCOUNT_ID \
  --query-file queries/worker_stats.graphql \
  > results/metrics_$(date +%Y%m%d_%H%M%S).json
```

### jq を使った整形

```bash
# p99 レスポンスタイムを抽出
cat results/metrics_latest.json | jq '.data.viewer.accounts[0].workersInvocationsAdaptive.quantiles.durationP99'

# エラーレートを計算
cat results/metrics_latest.json | jq '
  .data.viewer.accounts[0].workersInvocationsAdaptive.sum |
  (.errors / .requests * 100)
'

# DO 別の実行回数を表示
cat results/metrics_latest.json | jq '
  .data.viewer.accounts[0].durableObjectsInvocationsAdaptive[] |
  {className: .dimensions.className, requests: .sum.requests}
'
```

## 自動収集スクリプトの使用

### 基本的な使い方

```bash
# 最新のテスト結果を収集
./scripts/collect-metrics.sh

# 特定の時間範囲を指定
./scripts/collect-metrics.sh --start "2025-11-30T10:00:00Z" --end "2025-11-30T11:00:00Z"

# テスト名を指定して保存
./scripts/collect-metrics.sh --test-name "test1-standard" --output results/
```

### 出力例

```
📊 メトリクス収集を開始します...

テスト情報:
- Worker: authrim-worker
- 期間: 2025-11-30T10:00:00Z 〜 2025-11-30T11:00:00Z

📈 Workers メトリクス取得中...
✅ 完了

📈 Durable Objects メトリクス取得中...
✅ 完了

📈 D1 メトリクス取得中...
✅ 完了

📊 結果サマリー:
┌────────────────────┬──────────┐
│ メトリクス         │ 値       │
├────────────────────┼──────────┤
│ 総リクエスト数     │ 120,000  │
│ エラー数           │ 120      │
│ エラーレート       │ 0.10%    │
│ p50 レスポンス     │ 45ms     │
│ p90 レスポンス     │ 120ms    │
│ p99 レスポンス     │ 350ms    │
│ 平均 CPU 時間      │ 25ms     │
│ DO 実行回数        │ 240,000  │
│ D1 書き込み        │ 80,000   │
└────────────────────┴──────────┘

💾 結果保存先: results/test1-standard_20251130_103045.json
```

## メトリクスの分析

### 1. パフォーマンス分析

#### CPU Time の分析

```bash
# CPU Time が高いリクエストを特定
cat results/metrics_latest.json | jq '.data.viewer.accounts[0].workersInvocationsAdaptive.quantiles | {
  p50: .cpuTimeP50,
  p90: .cpuTimeP90,
  p99: .cpuTimeP99
}'
```

**評価基準**:
- p99 < 50ms: 優秀
- p99 < 100ms: 良好
- p99 > 150ms: 最適化が必要

#### レスポンスタイムの分析

```bash
# Duration の分布を確認
cat results/metrics_latest.json | jq '.data.viewer.accounts[0].workersInvocationsAdaptive.quantiles | {
  p50: .durationP50,
  p90: .durationP90,
  p99: .durationP99
}'
```

**評価基準**:
- p99 < 300ms: 優秀
- p99 < 500ms: 良好
- p99 > 1000ms: 改善が必要

### 2. エラー分析

```bash
# エラーレートの計算
cat results/metrics_latest.json | jq '
  .data.viewer.accounts[0].workersInvocationsAdaptive.sum |
  {
    total: .requests,
    errors: .errors,
    error_rate: ((.errors / .requests) * 100 | tostring + "%")
  }
'
```

**評価基準**:
- < 0.1%: 優秀
- < 1%: 良好
- < 5%: 許容範囲
- > 5%: 要改善

### 3. DO パフォーマンス分析

```bash
# DO クラス別の統計
cat results/metrics_latest.json | jq '
  .data.viewer.accounts[0].durableObjectsInvocationsAdaptive |
  map({
    class: .dimensions.className,
    invocations: .sum.requests,
    avg_cpu: (.sum.cpuTime / .sum.requests)
  })
'
```

### 4. D1 パフォーマンス分析

```bash
# 書き込み/読み取り比率
cat results/metrics_latest.json | jq '
  .data.viewer.accounts[0].d1Queries.sum |
  {
    reads: .readQueries,
    writes: .writeQueries,
    write_ratio: ((.writeQueries / (.readQueries + .writeQueries)) * 100)
  }
'
```

## レポート生成

### HTML レポートの生成

```bash
./scripts/generate-report.sh results/metrics_latest.json
```

生成されるレポート例:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Authrim 負荷テスト結果</title>
</head>
<body>
  <h1>TEST 1 - Standard プリセット</h1>
  <h2>サマリー</h2>
  <table>
    <tr><td>総リクエスト数</td><td>120,000</td></tr>
    <tr><td>エラーレート</td><td>0.10%</td></tr>
    <tr><td>p99 レスポンス</td><td>350ms</td></tr>
  </table>
  <!-- グラフやチャート -->
</body>
</html>
```

### CSV エクスポート

```bash
./scripts/export-csv.sh results/metrics_latest.json > results/metrics.csv
```

Excel や Google Sheets で開いて分析可能。

## トラブルシューティング

### 1. API Token エラー

```
Error: Authentication error
```

**解決策**:
```bash
# トークンの確認
echo $CLOUDFLARE_API_TOKEN

# トークンの再設定
export CLOUDFLARE_API_TOKEN=new_token_here

# または wrangler 再ログイン
wrangler logout
wrangler login
```

### 2. Account ID が見つからない

```
Error: Account not found
```

**解決策**:
```bash
# Account ID の確認
wrangler whoami

# または Cloudflare Dashboard から確認
# https://dash.cloudflare.com/ → 右上のアカウント名 → Account ID
```

### 3. データが空

```json
{
  "data": {
    "viewer": {
      "accounts": []
    }
  }
}
```

**原因**: 時間範囲が間違っている、またはデータがまだ集計されていない

**解決策**:
- 時間範囲を確認（UTC で指定）
- テスト終了後、5〜10分待ってから実行
- `datetime_geq` と `datetime_lt` を正しく設定

### 4. GraphQL クエリエラー

```
Error: GraphQL query error
```

**解決策**:
- クエリ構文を確認
- スキーマが最新か確認（Cloudflare の API 変更の可能性）
- `queries/worker_stats.graphql` のバージョンを確認

## ベストプラクティス

### 1. 定期的な収集

テスト実行直後ではなく、5〜10分後に収集：

```bash
# テスト実行
./scripts/run-test.sh test1 standard

# 10分待機
sleep 600

# メトリクス収集
./scripts/collect-metrics.sh --test-name "test1-standard"
```

### 2. バージョン管理

```bash
# Git タグでテスト結果を管理
git tag load-test-20251130-test1-standard
git push origin --tags
```

### 3. 結果の比較

```bash
# 過去の結果と比較
./scripts/compare-results.sh results/metrics_20251130.json results/metrics_20251129.json
```

### 4. 自動化

CI/CD パイプラインに組み込む：

```yaml
# .github/workflows/load-test.yml
- name: Run Load Test
  run: ./scripts/run-test.sh test1 standard

- name: Collect Metrics
  run: |
    sleep 600
    ./scripts/collect-metrics.sh --test-name "ci-test1-standard"

- name: Validate Results
  run: ./scripts/validate-results.sh results/ci-test1-standard.json
```

## 参考資料

- [Cloudflare GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/)
- [Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
- [Wrangler GraphQL Command](https://developers.cloudflare.com/workers/wrangler/commands/#graphql)
