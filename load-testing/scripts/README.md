# Load Testing Scripts Guide

このドキュメントでは、負荷テスト用スクリプトの一覧と使い方を説明します。

## Quick Reference

| カテゴリ | スクリプト | 説明 |
|---------|-----------|------|
| **シード生成** | `seed-refresh-tokens.js` | V3シャーディング対応Refresh Token生成（推奨） |
| **シード生成** | `seed-authcodes.js` | Authorization Code生成（並列） |
| **シード生成** | `seed-authcodes-multiuser.js` | マルチユーザー + Authorization Code生成 |
| **負荷テスト** | `test-refresh.js` | Refresh Token負荷テスト（k6） |
| **負荷テスト** | `test-authcode.js` | Authorization Code負荷テスト（k6） |
| **負荷テスト** | `test3-full-oidc.js` | フルOIDCフロー負荷テスト（k6） |
| **負荷テスト** | `test4-distributed-load.js` | 分散マルチクライアント負荷テスト（k6） |
| **シード生成** | `seed-distributed.js` | 分散テスト用シード生成（test4用） |
| **レポート** | `report-cf-analytics.js` | Cloudflare Analytics取得 |
| **レポート** | `report-generate.js` | テストレポート生成 |
| **ユーティリティ** | `warmup.js` | ウォームアップ用軽量リクエスト |

---

## シード生成スクリプト

### 1. seed-refresh-tokens.js（推奨）

**V3シャーディング対応のRefresh Tokenを直接生成**

Admin APIを使用してローカル署名 + 並列登録により高速生成。ユーザーは作成せず、トークンのみ生成。

```bash
BASE_URL="https://conformance.authrim.com" \
CLIENT_ID="<your-client-id>" \
CLIENT_SECRET="<your-client-secret>" \
ADMIN_API_SECRET="<your-admin-secret>" \
COUNT=100 \
CONCURRENCY=10 \
USER_ID_PREFIX="user-loadtest" \
node scripts/seed-refresh-tokens.js
```

| 環境変数 | 必須 | デフォルト | 説明 |
|---------|------|-----------|------|
| `CLIENT_ID` | Yes | - | OAuth Client ID |
| `CLIENT_SECRET` | Yes | - | OAuth Client Secret |
| `ADMIN_API_SECRET` | Yes | - | Admin API Bearer Token |
| `BASE_URL` | No | `https://conformance.authrim.com` | 対象URL |
| `COUNT` | No | `120` | 生成するトークン数 |
| `CONCURRENCY` | No | `20` | 並列数 |
| `USER_ID_PREFIX` | No | `user-loadtest` | ユーザーIDプレフィックス |

**出力:** `seeds/refresh_tokens.json`

---

### 2. seed-authcodes.js

**Authorization Code（認可コード）を並列生成**

テストユーザー1人に対して複数の認可コードを生成。`test-authcode.js`用。

```bash
BASE_URL="https://conformance.authrim.com" \
CLIENT_ID="<your-client-id>" \
CLIENT_SECRET="<your-client-secret>" \
ADMIN_API_SECRET="<your-admin-secret>" \
AUTH_CODE_COUNT=100 \
CONCURRENCY=10 \
node scripts/seed-authcodes.js
```

**出力:** `seeds/authorization_codes.json`

---

### 3. seed-authcodes-multiuser.js

**マルチユーザー + シャード分散対応のAuthorization Code生成**

128人のユーザーを作成し、ハッシュベースシャーディングで全シャードに負荷を分散。

```bash
BASE_URL="https://conformance.authrim.com" \
CLIENT_ID="<your-client-id>" \
CLIENT_SECRET="<your-client-secret>" \
ADMIN_API_SECRET="<your-admin-secret>" \
AUTH_CODE_COUNT=1000 \
USER_COUNT=128 \
CONCURRENCY=30 \
node scripts/seed-authcodes-multiuser.js
```

**出力:** `seeds/authorization_codes.json`

---

## 負荷テストスクリプト（k6）

### 1. test-refresh.js（Refresh Token テスト）

**Refresh Token Rotationの負荷テスト**

```bash
# シード生成（事前に必須）
COUNT=100 ... node scripts/seed-refresh-tokens.js

# テスト実行
k6 run --env PRESET=rps10 scripts/test-refresh.js    # 10 RPS（デバッグ用）
k6 run --env PRESET=rps100 scripts/test-refresh.js   # 100 RPS（本番基準）
k6 run --env PRESET=rps300 scripts/test-refresh.js   # 300 RPS（ベンチマーク）
k6 run --env PRESET=rps600 scripts/test-refresh.js   # 600 RPS（高負荷）
k6 run --env PRESET=rps1000 scripts/test-refresh.js  # 1000 RPS（限界テスト）
```

| プリセット | RPS | 時間 | VU数 | 用途 |
|-----------|-----|------|------|------|
| `rps10` | 10 | 40s | 10-15 | デバッグ・検証 |
| `rps100` | 100 | 3.5min | 100-120 | 本番基準 |
| `rps300` | 300 | 2.5min | 300-360 | 標準ベンチマーク |
| `rps600` | 600 | 2.5min | 600-720 | 高負荷テスト |
| `rps1000` | 1000 | 2.5min | 1500-2000 | 限界テスト |

**必要なシード数:** `maxVUs` 以上（1 VU = 1 token family）

---

### 2. test-authcode.js（Authorization Code テスト）

**Authorization Code → Token交換の負荷テスト**

```bash
# シード生成（事前に必須）
AUTH_CODE_COUNT=500 ... node scripts/seed-authcodes.js

# テスト実行
k6 run --env PRESET=rps100 scripts/test-authcode.js
```

**注意:** 認可コードは1回限り使用のため、テストごとに再生成が必要。

---

### 3. test3-full-oidc.js（フルOIDCフロー）

**authorize → token → userinfo の完全なOIDCフローをテスト**

```bash
k6 run scripts/test3-full-oidc.js
```

---

### 4. test4-distributed-load.js（分散負荷テスト）

**複数クライアントを使用したマルチテナント負荷テスト**

```bash
# クライアントセットアップ
ADMIN_API_SECRET=xxx node scripts/setup-test-clients.js

# シード生成（各クライアント用）
ADMIN_API_SECRET=xxx node scripts/seed-distributed.js

# テスト実行
k6 run --env MAU_PRESET=mau-500k scripts/test4-distributed-load.js

# クリーンアップ
ADMIN_API_SECRET=xxx node scripts/cleanup-test-clients.js
```

---

## レポートスクリプト

### report-cf-analytics.js

Cloudflare Analytics APIからメトリクスを取得。

```bash
CF_API_TOKEN=xxx node scripts/report-cf-analytics.js --minutes 15
```

### report-generate.js

テスト結果からHTML/MD/CSVレポートを生成。

```bash
node scripts/report-generate.js
```

---

## ユーティリティスクリプト

### warmup.js

テスト前のウォームアップ用。Cloudflare Workerのコールドスタートを回避。

```bash
k6 run scripts/warmup.js
```

---

## テスト実行フロー（クイックスタート）

### Refresh Token負荷テスト

```bash
cd load-testing

# 1. 環境変数設定
export BASE_URL="https://conformance.authrim.com"
export CLIENT_ID="<your-client-id>"
export CLIENT_SECRET="<your-client-secret>"
export ADMIN_API_SECRET="<your-admin-secret>"

# 2. シード生成（テストのmaxVUs以上のCOUNTを指定）
COUNT=150 CONCURRENCY=20 node scripts/seed-refresh-tokens.js

# 3. テスト実行
k6 run --env PRESET=rps100 scripts/test-refresh.js
```

---

## K6 Cloud実行時の注意

K6 Cloudでは複数インスタンス（load generator）で分散実行されます。
各インスタンスでVU IDがローカルに番号付けされるため、**シード数を10倍以上用意する必要があります。**

### シード数の目安

| プリセット | maxVUs | ローカル必要数 | K6 Cloud必要数 |
|-----------|--------|--------------|---------------|
| `rps10` | 15 | 20 | 200 |
| `rps100` | 120 | 150 | 1,500 |
| `rps300` | 360 | 400 | 4,000 |
| `rps1000` | 2,000 | 2,200 | **22,000** |

### K6 Cloudでの1000 RPSテスト

```bash
# 1. 大量シード生成（22,000個）
COUNT=22000 CONCURRENCY=50 USER_ID_PREFIX="user-cloud-1krps" \
node scripts/seed-refresh-tokens.js

# 2. K6 Cloudでテスト実行
k6 cloud --env PRESET=rps1000 scripts/test-refresh.js
```

### VU割り当ての仕組み

- **ローカル実行**: `tokenIndex = VU - 1`（単純な連番）
- **K6 Cloud実行**: `tokenIndex = (instanceId * tokensPerInstance) + VU - 1`
  - `K6_CLOUDRUN_INSTANCE_ID`環境変数でインスタンスを識別
  - 各インスタンスにトークンプールを均等分割

---

## トラブルシューティング

### "Refresh token is invalid or expired"

シードが古い、または別のテストで消費済み → `seed-refresh-tokens.js`で再生成

### シード数が足りない

テストのmaxVUs > シード数 → `COUNT`を増やして再生成

### K6 Cloudで大量の400エラー

**症状:** K6 Cloudで`error_code: '1400'`（invalid_grant）が多発

**原因:** 複数インスタンスでVU IDが重複し、同じトークンを複数VUが使用

**解決策:**
1. シード数を10倍以上に増やす（例: 1000 RPSなら22,000個）
2. `test-refresh.js`の`getGlobalTokenIndex()`関数がK6 Cloud対応済みか確認
