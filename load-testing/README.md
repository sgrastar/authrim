# 🚀 Authrim 負荷テスト仕様書

Authrim の家庭用〜準商用向け負荷テストプリセット

## 📋 目次

- [全体方針](#全体方針)
- [テスト環境アーキテクチャ](#テスト環境アーキテクチャ)
- [テストプリセット](#テストプリセット)
- [クイックスタート](#クイックスタート)
- [詳細ドキュメント](#詳細ドキュメント)

## 🎯 全体方針

このテストフレームワークの目的は以下の通りです：

1. **現在の Authrim architecture（Worker + DO + KV + D1）で耐えられるRPSの実測値を出す**
2. **軽負荷〜重負荷まで、家庭環境で再現可能な現実的プリセットを提供する**
3. **テスト後に Cloudflare Analytics API / Graph API から実際のCPU・メモリ・リクエスト統計を wrangler 経由で収集する**
4. **すべて k6 OSS と家庭の光回線・MacBook/Mac mini で実行可能**

## 🏗️ テスト環境アーキテクチャ

### テスト実行環境（ローカル）

- **マシン**: macOS (M1/M2/M3)
- **回線**: 上り 50〜200Mbps の一般家庭用光回線
- **必要なツール**:
  - [k6 OSS](https://k6.io/)
  - [wrangler](https://developers.cloudflare.com/workers/wrangler/)
  - jq（結果整形用・任意）

### Authrim 側構成

```
k6 (ローカル)
    ↓
Cloudflare Edge
    ↓
Authrim Worker + KeyManager (cache)
    ├→ KV (JWK)
    ├→ DO: AuthorizationCodeStore
    ├→ DO: TokenRotator
    └→ D1: token/session storage
```

詳細は [docs/architecture.md](./docs/architecture.md) を参照してください。

## 📊 テストプリセット

### TEST 1: /token 単体負荷テスト

認証フローのピーク耐性を測定

| プリセット | RPS | Duration | VUs | 期待値 |
|-----------|-----|----------|-----|--------|
| **Light** | 5 → 20 | 60秒 | 20 | p99 < 250ms |
| **Standard** | 30 → 100 | 120秒 | 100 | p99 < 500ms |
| **Heavy** | 200 → 600 | 180秒 | 200〜600 | 429/500エラーレート測定 |

### TEST 2: Refresh Token Storm

実世界の最大トラフィック測定

| プリセット | RPS | Duration | 期待値 |
|-----------|-----|----------|--------|
| **Light** | 50 | 5分 | p99 < 300ms |
| **Standard** | 200–500 | 10分 | error rate < 0.1% |
| **Heavy** | 800–1200 | 10分 | DO ロック競合測定 |

### TEST 3: フル OIDC 認証フロー

実サービス最も近いワークロード

| プリセット | RPS | Duration | 期待値 |
|-----------|-----|----------|--------|
| **Light** | 10–20 | 120秒 | p99 < 300ms |
| **Standard** | 30–50 | 180秒 | p99 < 500ms |
| **Heavy** | 80–100 | 180秒 | レイテンシ跳ね上がり地点測定 |

詳細は [docs/test-scenarios.md](./docs/test-scenarios.md) を参照してください。

## 🚀 クイックスタート

### 1. 環境セットアップ

```bash
# k6 のインストール（macOS）
brew install k6

# wrangler のインストール
npm install -g wrangler

# wrangler ログイン
wrangler login
```

### 2. テスト対象環境の設定

`.env` ファイルを作成：

```bash
cp .env.example .env
```

以下を設定：

```env
# テスト対象の Authrim Worker URL
BASE_URL=https://conformance.authrim.com

# テスト用クライアント情報
CLIENT_ID=test_client_id
CLIENT_SECRET=test_client_secret

# Cloudflare 設定（メトリクス収集用）
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token
```

### 3. テスト実行

```bash
# Light プリセットで TEST 1 を実行
./scripts/run-test.sh test1 light

# Standard プリセットで TEST 2 を実行
./scripts/run-test.sh test2 standard

# Heavy プリセットで TEST 3 を実行
./scripts/run-test.sh test3 heavy
```

### 4. 結果収集

```bash
# Cloudflare Analytics からメトリクスを取得
./scripts/collect-metrics.sh

# 結果は results/ ディレクトリに保存されます
ls -la results/
```

## 📁 ディレクトリ構成

```
load-testing/
├── README.md                          # このファイル
├── docs/                              # 詳細ドキュメント
│   ├── architecture.md                # テスト環境アーキテクチャ
│   ├── test-scenarios.md              # テストシナリオ詳細
│   └── metrics-collection.md          # メトリクス収集手順
├── scripts/                           # テストスクリプト
│   ├── test1-token-load.js            # TEST 1: /token 単体
│   ├── test2-refresh-storm.js         # TEST 2: Refresh Storm
│   ├── test3-full-oidc.js             # TEST 3: フル OIDC
│   ├── run-test.sh                    # テスト実行ヘルパー
│   ├── collect-metrics.sh             # メトリクス収集スクリプト
│   └── generate-seeds.js              # シードデータ生成スクリプト
├── seeds/                             # シードデータ出力先
├── queries/                           # GraphQL クエリ
│   └── worker_stats.graphql           # Worker 統計取得クエリ
├── presets/                           # プリセット設定
│   ├── light.json                     # Light プリセット
│   ├── standard.json                  # Standard プリセット
│   └── heavy.json                     # Heavy プリセット
└── results/                           # テスト結果（gitignore）
```

---

## 🔧 シードデータ生成（generate-seeds.js）

負荷テスト用のauthorization codeやrefresh tokenを事前生成するスクリプトです。

### 使用方法

```bash
cd load-testing/scripts

# 基本的な使い方
CLIENT_ID=xxx CLIENT_SECRET=yyy ADMIN_API_SECRET=zzz node generate-seeds.js
```

### 環境変数

| 変数 | 必須 | デフォルト | 説明 |
|------|------|----------|------|
| `BASE_URL` | No | `https://conformance.authrim.com` | 対象のAuthrim Worker URL |
| `CLIENT_ID` | **Yes** | - | OAuthクライアントID |
| `CLIENT_SECRET` | **Yes** | - | OAuthクライアントシークレット |
| `REDIRECT_URI` | No | `https://localhost:3000/callback` | リダイレクトURI |
| `ADMIN_API_SECRET` | No | - | Admin API認証用Bearerトークン |
| `AUTH_CODE_COUNT` | No | `200` | 生成するauthorization code数 |
| `REFRESH_COUNT` | No | `200` | 生成するrefresh token数 |
| `OUTPUT_DIR` | No | `../seeds` | 出力ディレクトリ |

### 出力ファイル

```
seeds/
├── auth_codes.json        # authorization code + PKCE verifier
└── refresh_tokens.json    # refresh token
```

### 事前準備：クライアント作成

Admin APIを使用してテスト用クライアントを作成できます。

> **重要**: クライアント作成時の `redirect_uris` と generate-seeds.js の `REDIRECT_URI` は一致させる必要があります。

```bash
# クライアント作成（デフォルトのREDIRECT_URIに合わせる）
curl -X POST "https://conformance.authrim.com/api/admin/clients" \
  -H "Authorization: Bearer YOUR_ADMIN_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Load Test Client",
    "redirect_uris": ["https://localhost:3000/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "scope": "openid profile email",
    "skip_consent": true
  }'

# レスポンス例:
# {
#   "client": {
#     "client_id": "550e8400-e29b-...",
#     "client_secret": "a1b2c3d4e5f6...",
#     ...
#   }
# }

# 取得したclient_idとclient_secretを使用してシード生成
CLIENT_ID="550e8400-e29b-..." \
CLIENT_SECRET="a1b2c3d4e5f6..." \
ADMIN_API_SECRET="YOUR_ADMIN_API_SECRET" \
node generate-seeds.js
```

### リダイレクトURIについて

OAuth 2.0のセキュリティ要件として、`/authorize`リクエストの`redirect_uri`はクライアント登録時の`redirect_uris`に含まれている必要があります。

- **デフォルト**: `https://localhost:3000/callback`（テスト用、実際にサーバーを立てる必要なし）
- **注意**: Conformance環境ではHTTPSが必須です（`http://` は拒否されます）
- クライアント作成時に別のURIを指定した場合は、`REDIRECT_URI`環境変数で同じ値を指定してください

```bash
# カスタムリダイレクトURIを使用する場合
REDIRECT_URI="https://mytest.local/callback" \
CLIENT_ID=xxx \
CLIENT_SECRET=yyy \
node generate-seeds.js
```

詳細は [Admin Client API ドキュメント](../docs/api/admin/clients.md) を参照してください。

## 📚 詳細ドキュメント

- [テスト環境アーキテクチャ](./docs/architecture.md) - テスト環境の詳細構成
- [テストシナリオ詳細](./docs/test-scenarios.md) - 各テストの詳細仕様
- [メトリクス収集手順](./docs/metrics-collection.md) - Cloudflare Analytics からの結果取得方法

## 📈 収集メトリクス一覧

テスト完了後、Cloudflare GraphQL API から以下のメトリクスを自動収集します。

### 📗 Worker メトリクス

| メトリクス | 説明 | 単位 |
|-----------|------|------|
| `duration` (p50/p90/p99) | Worker実行時間のパーセンタイル | ms |
| `cpu_time` (p50/p90/p99) | CPU実行時間のパーセンタイル | ms |
| `memory_max` / `memory_avg` | 使用メモリ（最大/平均） | MB |
| `cpu_throttling_count` | CPUスロットリング発生回数 | 回 |
| `worker_errors` (5xx) | 5xxエラー数 | 回 |
| `requests_by_status` | ステータスコード別リクエスト数 | 回 |

### 📙 Durable Objects メトリクス

| メトリクス | 説明 | 単位 |
|-----------|------|------|
| `do_duration` (p50/p90/p99) | DO Wall Time（実行時間）のパーセンタイル | ms |
| `do_waitTime` (p50/p95/p99) | DO待機時間のパーセンタイル | ms |
| `do_requests_total` | DO総リクエスト数 | 回 |
| `do_concurrency` | 同時実行数 | - |
| `do_errors` | DOエラー数（CPU/メモリ超過含む） | 回 |
| `storage_read_units` / `storage_write_units` | ストレージ読み書きユニット | units |

### 📕 D1 データベース メトリクス

| メトリクス | 説明 | 単位 |
|-----------|------|------|
| `d1_read_count` / `d1_write_count` | 読み取り/書き込みクエリ数 | 回 |
| `d1_duration` (p50/p95/p99) | クエリ実行時間のパーセンタイル | ms |
| `d1_rate_limited_count` | レート制限発生回数 | 回 |
| `rows_read` / `rows_written` | 読み書き行数 | rows |

### 📒 KV メトリクス

| メトリクス | 説明 | 単位 |
|-----------|------|------|
| `kv_reads_total` | KV読み取り操作数 | 回 |
| `kv_writes_total` | KV書き込み操作数 | 回 |
| `kv_cache_hits` | エッジキャッシュヒット数 | 回 |
| `kv_cache_misses` | エッジキャッシュミス数 | 回 |
| `kv_read_duration` | KV読み取りレイテンシ | ms |

### 📓 全体メトリクス

| メトリクス | 説明 | 単位 |
|-----------|------|------|
| `requests_by_pop` | エッジロケーション（PoP）別リクエスト分布 | 回 |
| `retries` | Cloudflare側リトライ数 | 回 |
| `inflight_requests_peak` | 同時処理中リクエストのピーク | 回 |

### メトリクス収集の使用方法

```bash
# テスト完了後に手動で取得する場合
node scripts/fetch-cf-analytics.js --start "2025-11-30T10:20:00Z" --end "2025-11-30T10:35:00Z"

# 過去N分間のデータを取得
node scripts/fetch-cf-analytics.js --minutes 15

# JSON形式で出力（パイプライン用）
node scripts/fetch-cf-analytics.js --minutes 10 --json > metrics.json

# テストスクリプト（run-light-test.sh等）は自動でメトリクスを収集
export CF_API_TOKEN="your_cloudflare_api_token"
./run-light-test.sh
```

> 💡 **Tip**: メトリクスは `results/cf-analytics_YYYY-MM-DDTHH-MM-SS.json` に自動保存されます。

---

## 🎯 テスト基準（判定ライン）

### ① /token 単体
- p99 < 500ms
- error rate < 1%
- 200–300 RPS が安定すれば本番耐性十分

### ② refresh storm
- p99 < 700ms
- error rate < 2%
- 300–800 RPS 安定が理想
- D1 書き込みエラーが0であること

### ③ フル OIDC
- p99 < 500ms
- error rate < 1%
- 50RPS 安定 → 実サービス 10万MAU で十分余裕

## 🔧 トラブルシューティング

### k6 が見つからない

```bash
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

### wrangler 認証エラー

```bash
# ログアウトして再ログイン
wrangler logout
wrangler login

# または API トークンを直接設定
export CLOUDFLARE_API_TOKEN=your_token_here
```

### テストが 429 エラーで失敗する

- Cloudflare Workers プランを確認（Unlimited 推奨）
- Rate Limit 設定を確認
- プリセットを Light に変更して再試行

## 📝 ライセンス

このテストフレームワークは Authrim プロジェクトの一部です。

## 🤝 コントリビューション

改善提案やバグ報告は Issue または PR でお願いします。
