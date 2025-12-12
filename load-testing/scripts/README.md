# Load Testing Scripts Guide

このドキュメントでは、負荷テスト用スクリプトの一覧と使い方を説明します。

## Quick Reference

| カテゴリ | スクリプト | 説明 |
|---------|-----------|------|
| **ユーザー作成** | `seed-users.js` | ユーザー事前作成（再利用可能） |
| **シード生成** | `seed-authcodes.js` | Authorization Code生成（事前作成ユーザー使用） |
| **シード生成** | `seed-refresh-tokens.js` | V3シャーディング対応Refresh Token生成（推奨） |
| **シード生成** | `seed-authcodes-multiuser.js` | マルチユーザー + Authorization Code生成 |
| **負荷テスト** | `test-refresh.js` | Refresh Token負荷テスト（k6） |
| **負荷テスト** | `test-authcode.js` | Authorization Code負荷テスト（k6） |
| **負荷テスト** | `test3-full-oidc.js` | フルOIDCフロー負荷テスト（k6） |
| **負荷テスト** | `test4-distributed-load.js` | 分散マルチクライアント負荷テスト（k6） |
| **ベンチマーク** | `test-authorize-silent-benchmark.js` | Authorization Endpoint (prompt=none) ベンチマーク |
| **ベンチマーク** | `test-authorize-silent-benchmark-cloud.js` | Authorization (prompt=none) K6 Cloud版 |
| **ベンチマーク** | `test-userinfo-benchmark.js` | UserInfo Endpoint スループットベンチマーク |
| **ベンチマーク** | `test-introspect-benchmark.js` | Token Introspection API ベンチマーク |
| **シード生成** | `seed-access-tokens.js` | Access Token事前生成（UserInfo/Introspect用） |
| **シード生成** | `seed-distributed.js` | 分散テスト用シード生成（test4用） |
| **レポート** | `report-cf-analytics.js` | Cloudflare Analytics取得 |
| **レポート** | `report-generate.js` | テストレポート生成 |
| **ユーティリティ** | `warmup.js` | ウォームアップ用軽量リクエスト |

---

## シード生成スクリプト

### 0. seed-users.js（ユーザー事前作成）

**負荷テスト用ユーザーを事前に大量作成**

ユーザーはDBを初期化しない限り再利用可能。シード生成前に1回だけ実行すればOK。

```bash
BASE_URL="https://conformance.authrim.com" \
ADMIN_API_SECRET="<your-admin-secret>" \
CLIENT_ID="<your-client-id>" \
USER_COUNT=500000 \
CONCURRENCY=50 \
node scripts/seed-users.js
```

| 環境変数 | 必須 | デフォルト | 説明 |
|---------|------|-----------|------|
| `ADMIN_API_SECRET` | Yes | - | Admin API Bearer Token |
| `BASE_URL` | No | `https://conformance.authrim.com` | 対象URL |
| `USER_COUNT` | No | `10000` | 作成するユーザー数 |
| `CONCURRENCY` | No | `50` | 並列数 |
| `CLIENT_ID` | No | - | シャード計算用（指定するとシャード分布を表示） |
| `SAVE_INTERVAL` | No | `1000` | 自動保存間隔 |

**出力:**
- `seeds/test_users.json` - ユーザー詳細（JSON形式、シャード情報付き）
- `seeds/test_users.txt` - ユーザーID一覧（1行1ID、シンプル形式）

**特徴:**
- 中断時に自動保存、再開時に既存ユーザーをスキップ
- インクリメンタル作成対応（`USER_COUNT=600000`で追加作成）
- シャード分布の確認が可能

---

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

**Authorization Code（認可コード）を並列生成（事前作成ユーザー使用）**

`seed-users.js`で作成したユーザーを使用して認可コードを生成。`test-authcode.js`用。

**前提:** `seed-users.js`でユーザーを事前作成済みであること

```bash
# Step 1: ユーザー作成（初回のみ）
USER_COUNT=500000 node scripts/seed-users.js

# Step 2: 認可コード生成（何度でも実行可能）
BASE_URL="https://conformance.authrim.com" \
CLIENT_ID="<your-client-id>" \
CLIENT_SECRET="<your-client-secret>" \
ADMIN_API_SECRET="<your-admin-secret>" \
AUTH_CODE_COUNT=50000 \
CONCURRENCY=50 \
node scripts/seed-authcodes.js
```

| 環境変数 | 必須 | デフォルト | 説明 |
|---------|------|-----------|------|
| `CLIENT_ID` | Yes | - | OAuth Client ID |
| `CLIENT_SECRET` | Yes | - | OAuth Client Secret |
| `ADMIN_API_SECRET` | Yes | - | Admin API Bearer Token |
| `BASE_URL` | No | `https://conformance.authrim.com` | 対象URL |
| `AUTH_CODE_COUNT` | No | `1000` | 生成する認可コード数 |
| `USER_COUNT` | No | `0`（全ユーザー使用） | 使用するユーザー数 |
| `CONCURRENCY` | No | `10` | 並列数 |

**出力:** `seeds/authorization_codes.json`

**特徴:**
- 事前作成ユーザーを使用（ユーザー作成とシード生成を分離）
- ユーザーはDB初期化まで何度でも再利用可能
- シャード分散が保証される（FNV-1aハッシュ）

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

### Authorization Code負荷テスト（推奨ワークフロー）

```bash
cd load-testing

# 1. 環境変数設定
export BASE_URL="https://conformance.authrim.com"
export CLIENT_ID="<your-client-id>"
export CLIENT_SECRET="<your-client-secret>"
export ADMIN_API_SECRET="<your-admin-secret>"

# 2. ユーザー事前作成（初回のみ、DB初期化まで再利用可能）
USER_COUNT=500000 CONCURRENCY=50 node scripts/seed-users.js

# 3. 認可コード生成（テストごとに実行）
AUTH_CODE_COUNT=50000 CONCURRENCY=50 node scripts/seed-authcodes.js

# 4. テスト実行
k6 run --env PRESET=rps300 scripts/test-authcode.js
```

**ポイント:**
- Step 2 のユーザー作成は初回のみ実行（DBを初期化しない限り再利用可能）
- Step 3 の認可コード生成はテストごとに実行（1回限り使用のため）
- ユーザーとシード生成を分離することで、繰り返しテストが高速化

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

## ベンチマークテスト（外部公開仕様準拠）

外部公開向け性能テスト仕様書に基づいたベンチマークテストスクリプト群。
各エンドポイントの最大スループットを測定し、Auth0/Keycloak/Oryとの比較指標を提供。

### seed-access-tokens.js（Access Token事前生成）

**UserInfo/Introspectionベンチマーク用のアクセストークンを事前生成**

```bash
BASE_URL="https://conformance.authrim.com" \
CLIENT_ID="<your-client-id>" \
CLIENT_SECRET="<your-client-secret>" \
ADMIN_API_SECRET="<your-admin-secret>" \
TOKEN_COUNT=1000 \
CONCURRENCY=20 \
node scripts/seed-access-tokens.js
```

| 環境変数 | 必須 | デフォルト | 説明 |
|---------|------|-----------|------|
| `CLIENT_ID` | Yes | - | OAuth Client ID |
| `CLIENT_SECRET` | Yes | - | OAuth Client Secret |
| `ADMIN_API_SECRET` | Yes | - | Admin API Bearer Token |
| `BASE_URL` | No | `https://conformance.authrim.com` | 対象URL |
| `TOKEN_COUNT` | No | `1000` | 生成するトークン総数 |
| `CONCURRENCY` | No | `20` | 並列数 |
| `USER_ID_PREFIX` | No | `user-bench` | ユーザーIDプレフィックス |
| `OUTPUT_DIR` | No | `./seeds` | 出力ディレクトリ |

**トークン種別（混合比率）:**
- **Valid**: 70% - 正常なトークン（exp=30日後）
- **Expired**: 10% - 期限切れトークン（exp=過去）
- **Invalid**: 10% - 不正なJWT（ランダム文字列）
- **Revoked**: 10% - 正常に発行後、POST /revokeで無効化

**出力:** `seeds/access_tokens.json`

---

### test-userinfo-benchmark.js（UserInfo Endpointベンチマーク）

**UserInfo API の最大スループットを測定**

```bash
# シード生成（事前に必須）
TOKEN_COUNT=1000 ... node scripts/seed-access-tokens.js

# テスト実行
k6 run --env PRESET=rps500 scripts/test-userinfo-benchmark.js
```

| プリセット | RPS | Duration | p95目標 | p99目標 | maxVUs |
|-----------|-----|----------|---------|---------|--------|
| `rps100` | 100 | 30s | <300ms | <500ms | 150 |
| `rps500` | 500 | 2min | <200ms | <300ms | 800 |
| `rps1000` | 1000 | 2min | <200ms | <300ms | 1500 |
| `rps1500` | 1500 | 2min | <200ms | <300ms | 2200 |
| `rps2000` | 2000 | 2min | <200ms | <300ms | 3000 |

**成功基準（仕様書準拠）:**
- 成功率: > 99.9%
- p95: < 200ms
- p99: < 300ms

---

### test-introspect-benchmark.js（Token Introspectionベンチマーク）

**Token Introspection API のパフォーマンスを測定**

重み付けトークン選択で現実的なワークロードをシミュレート。

```bash
# シード生成（事前に必須）
TOKEN_COUNT=1000 ... node scripts/seed-access-tokens.js

# テスト実行
k6 run --env PRESET=rps300 scripts/test-introspect-benchmark.js
```

| プリセット | RPS | Duration | p95目標 | p99目標 | maxVUs |
|-----------|-----|----------|---------|---------|--------|
| `rps100` | 100 | 30s | <400ms | <600ms | 150 |
| `rps300` | 300 | 2min | <300ms | <400ms | 450 |
| `rps600` | 600 | 2min | <300ms | <400ms | 900 |
| `rps800` | 800 | 2min | <300ms | <400ms | 1200 |
| `rps1000` | 1000 | 2min | <300ms | <400ms | 1500 |

**検証項目:**
- `active: true` → Validトークン (70%)
- `active: false` → Expired/Invalid/Revoked (30%)
- False Positive/False Negativeの追跡

---

### test-authorize-silent-benchmark.js（Authorization Endpointベンチマーク - サイレント認証）

**prompt=none での認可レスポンスを測定（ローカル実行用）**

Admin APIでテストセッションを作成し、prompt=noneで即時認可コード発行。
既存セッションでの認可リクエスト（サイレント認証）をシミュレート。

```bash
# テスト実行（セッションはsetup()で自動作成）
k6 run --env PRESET=rps200 scripts/test-authorize-silent-benchmark.js
```

| プリセット | RPS | Duration | p95目標 | p99目標 | セッション数 |
|-----------|-----|----------|---------|---------|-------------|
| `rps50` | 50 | 30s | <2000ms | <3000ms | 100 |
| `rps200` | 200 | 3min | <1500ms | <2000ms | 500 |
| `rps400` | 400 | 3min | <1500ms | <2000ms | 500 |
| `rps600` | 600 | 3min | <1500ms | <2000ms | 500 |
| `rps800` | 800 | 3min | <1500ms | <2000ms | 500 |
| `rps1000` | 1000 | 3min | <1500ms | <2000ms | 500 |
| `rps1200` | 1200 | 3min | <1500ms | <2000ms | 500 |

| 環境変数 | 必須 | デフォルト | 説明 |
|---------|------|-----------|------|
| `CLIENT_ID` | Yes | - | OAuth Client ID |
| `ADMIN_API_SECRET` | Yes | - | Admin API Bearer Token |
| `BASE_URL` | No | `https://conformance.authrim.com` | 対象URL |
| `REDIRECT_URI` | No | `https://localhost:3000/callback` | リダイレクトURI |

**成功基準（仕様書準拠）:**
- 成功率: > 99%
- p95: < 1500ms
- p99: < 2000ms

---

### test-authorize-silent-benchmark-cloud.js（K6 Cloud版）

**K6 Cloud経由での分散負荷テスト用**

ローカル版より高いRPSが可能（クライアント側TCP制限なし）。

```bash
# K6 Cloud実行
export K6_CLOUD_TOKEN="your-k6-cloud-token"
k6 cloud --env PRESET=rps1000 scripts/test-authorize-silent-benchmark-cloud.js
```

| プリセット | RPS | Duration | p95目標 | p99目標 | maxVUs |
|-----------|-----|----------|---------|---------|--------|
| `rps100` | 100 | 1min | <1500ms | <2000ms | 200 |
| `rps200` | 200 | 3min | <1500ms | <2000ms | 400 |
| `rps500` | 500 | 3min | <1500ms | <2000ms | 900 |
| `rps1000` | 1000 | 3min | <1500ms | <2000ms | 1600 |
| `rps1500` | 1500 | 3min | <1500ms | <2000ms | 2400 |
| `rps2000` | 2000 | 3min | <1500ms | <2000ms | 3500 |
| `rps3000` | 3000 | 3min | <2000ms | <3000ms | 5000 |

**K6 Cloud固有の環境変数:**
| 環境変数 | 必須 | デフォルト | 説明 |
|---------|------|-----------|------|
| `K6_CLOUD_PROJECT_ID` | No | - | K6 CloudプロジェクトID |
| `USER_LIST_URL` | No | - | R2等からユーザーリストをフェッチするURL |

---

### ベンチマーククイックスタート

```bash
cd load-testing

# 1. 環境変数設定
export BASE_URL="https://conformance.authrim.com"
export CLIENT_ID="<your-client-id>"
export CLIENT_SECRET="<your-client-secret>"
export ADMIN_API_SECRET="<your-admin-secret>"

# 2. Access Token生成（UserInfo/Introspect用）
TOKEN_COUNT=1000 CONCURRENCY=20 node scripts/seed-access-tokens.js

# 3. 各ベンチマーク実行
k6 run --env PRESET=rps500 scripts/test-userinfo-benchmark.js
k6 run --env PRESET=rps300 scripts/test-introspect-benchmark.js
k6 run --env PRESET=rps200 scripts/test-authorize-silent-benchmark.js

# K6 Cloud実行（高負荷テスト用）
export K6_CLOUD_TOKEN="your-k6-cloud-token"
k6 cloud --env PRESET=rps1000 scripts/test-authorize-silent-benchmark-cloud.js
```

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
