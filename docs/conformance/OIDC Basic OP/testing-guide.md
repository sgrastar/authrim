# Enrai - OpenID Conformance Testing Guide ⚡️

**Purpose:** Complete guide for OpenID Connect conformance testing without Docker
**Target:** Phase 3 - Testing & Validation
**Last Updated:** 2025-11-18

---

## Quick Start (30 Minutes) 🚀

Follow these steps to quickly start OpenID Conformance Testing:

### Prerequisites
- Node.js 18+ installed
- Cloudflare account created
- wrangler CLI authenticated (`wrangler login`)

### Step 1: Local Verification (5 minutes)

```bash
# Navigate to project root
cd /path/to/enrai

# Install dependencies (first time only)
pnpm install

# Generate and configure RSA keys
./scripts/setup-dev.sh

# Start development server
pnpm run dev
```

Verify in another terminal:

```bash
# Discovery endpoint
curl http://localhost:8787/.well-known/openid-configuration | jq .issuer

# JWKS endpoint
curl http://localhost:8787/.well-known/jwks.json | jq '.keys | length'
# Output should be "1" or higher for OK
```

### Step 2: Deploy to Production (10 minutes)

```bash
# Generate production keys
pnpm run generate-keys

# Configure wrangler.toml
# Set ISSUER = "https://enrai.YOUR_SUBDOMAIN.workers.dev"
# Set KEY_ID from: jq -r '.kid' .keys/metadata.json

# Configure secrets
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON

# Build and deploy
pnpm run build
pnpm run deploy
```

### Step 3: Run Conformance Tests (15 minutes)

1. Access https://www.certification.openid.net/
2. Create account and login
3. Create test plan: **OpenID Connect Provider** → **Basic OP**
4. Enter your issuer URL: `https://enrai.YOUR_SUBDOMAIN.workers.dev`
5. Click "Discover" to load metadata
6. Start tests and follow browser instructions

### Success Criteria

- ✅ Conformance Score: ≥85%
- ✅ Critical Failures: 0
- ✅ Discovery & JWKS: All passing

---

## Table of Contents

1. [Local Development Setup](#1-local-development-setup)
2. [Prepare Test Environment](#2-prepare-test-environment)
3. [Deploy to Cloudflare Workers](#3-deploy-to-cloudflare-workers)
4. [Use OpenID Conformance Suite](#4-use-openid-conformance-suite)
5. [Execute Tests](#5-execute-tests)
6. [Verify and Record Results](#6-verify-and-record-results)
7. [Troubleshooting](#7-troubleshooting)
8. [Next Steps](#8-next-steps)

---

## 1. Local Development Setup

This section explains how to set up Enrai for local development and testing.

### 1.1 Prerequisites

- Node.js 18.0.0 or higher
- pnpm (or npm)
- jq (for JSON processing in setup script)

### 1.2 Quick Setup

Run the automated setup script:

```bash
./scripts/setup-dev.sh
```

This script will:
1. Generate RSA key pairs for JWT signing (if not already present)
2. Create `.dev.vars` file with necessary environment variables
3. Update `wrangler.toml` with the generated KEY_ID

### 1.3 Manual Setup (Optional)

If you prefer to set up manually:

#### Generate RSA Keys

```bash
pnpm run generate-keys
```

This creates:
- `.keys/private.pem` - Private key for signing tokens
- `.keys/public.jwk.json` - Public key in JWK format
- `.keys/metadata.json` - Key metadata (kid, algorithm, etc.)

#### Create `.dev.vars` File

Create a `.dev.vars` file in the project root:

```bash
PRIVATE_KEY_PEM="<content of .keys/private.pem>"
PUBLIC_JWK_JSON='<compact JSON from .keys/public.jwk.json>'
ALLOW_HTTP_REDIRECT="true"
```

**Important:**
- The `PRIVATE_KEY_PEM` should include the full PEM content with newlines
- The `PUBLIC_JWK_JSON` should be a compact JSON string (single line, no spaces)
- Both values should be quoted as shown above

#### Update `wrangler.toml`

Update the `KEY_ID` in `wrangler.toml` to match the `kid` from `.keys/metadata.json`:

```toml
[vars]
KEY_ID = "dev-key-1234567890-xxxxx"
```

### 1.4 Running the Server

Start the development server:

```bash
pnpm run dev
```

The server will be available at `http://localhost:8787`.

### 1.5 Testing the Local Setup

#### Test Discovery Endpoint

```bash
curl http://localhost:8787/.well-known/openid-configuration | jq
```

Expected: JSON response with OpenID configuration

#### Test JWKS Endpoint

```bash
curl http://localhost:8787/.well-known/jwks.json | jq
```

Expected: JSON response with public key in JWK format

#### Test Authorization Flow

```bash
curl -i "http://localhost:8787/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid%20profile&state=test-state&nonce=test-nonce"
```

Expected: 302 redirect with authorization code

#### Test Token Exchange

```bash
CODE="<authorization-code>"
curl -X POST http://localhost:8787/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=$CODE" \
  -d "client_id=test-client" \
  -d "redirect_uri=https://example.com/callback" | jq
```

Expected: JSON response with `access_token`, `id_token`, and other token fields

#### Test UserInfo Endpoint

```bash
ACCESS_TOKEN="<access-token>"
curl http://localhost:8787/userinfo \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq
```

Expected: JSON response with user claims

### 1.6 Running Tests

```bash
pnpm test
```

To run tests with coverage:

```bash
pnpm run test:coverage
```

### 1.7 Security Notes

- The `.keys/` directory is gitignored by default
- Never commit private keys to version control
- `.dev.vars` is also gitignored and contains sensitive data
- For production deployment, use Wrangler secrets instead of `.dev.vars`

---

## 2. Prepare Test Environment

### 2.1 Overview

Before public deployment, verify that Enrai works correctly in your local environment. This has been covered in detail in [Section 1: Local Development Setup](#1-local-development-setup).

If you've already completed the local setup, you can skip to [Section 3: Deploy to Cloudflare Workers](#3-deploy-to-cloudflare-workers).

---

## 3. Deploy to Cloudflare Workers

The OpenID Conformance Suite requires an internet-accessible URL. Deploy to Cloudflare Workers to obtain a public URL.

### 3.1 Generate Production RSA Keys

Generate a new RSA key pair for the production environment:

```bash
# Backup existing development keys (optional)
cp -r .keys .keys.dev

# Generate new keys
pnpm run generate-keys
```

### 3.2 Configure Wrangler Secrets

Set the generated keys as Cloudflare Workers secrets:

```bash
# Configure PRIVATE_KEY_PEM
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM

# Configure PUBLIC_JWK_JSON
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON
```

**Important:** Secrets are stored encrypted and only accessible in the Workers runtime.

### 3.3 wrangler.toml の設定確認

`wrangler.toml` を開き、以下を確認します：

```toml
name = "enrai"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
ISSUER = "https://enrai.YOUR_SUBDOMAIN.workers.dev"
KEY_ID = "edge-key-1"  # .keys/metadata.json の kid と一致させる
TOKEN_TTL = "3600"
CODE_TTL = "120"
ALLOW_HTTP_REDIRECT = "false"  # 本番環境では false

# KV Namespace (初回デプロイ時に自動作成)
[[kv_namespaces]]
binding = "KV"
id = ""
```

**KEY_ID の確認:**

```bash
# .keys/metadata.json から kid を取得
jq -r '.kid' .keys/metadata.json
```

この値を `wrangler.toml` の `KEY_ID` に設定します。

### 3.4 TypeScriptのビルド

デプロイ前にTypeScriptをビルドします：

```bash
pnpm run build
```

エラーがないことを確認してください。

### 3.5 デプロイ

Cloudflare Workersにデプロイします：

```bash
pnpm run deploy
```

**期待される出力:**

```
Total Upload: XX.XX KiB / gzip: XX.XX KiB
Uploaded enrai (X.XX sec)
Published enrai (X.XX sec)
  https://enrai.YOUR_SUBDOMAIN.workers.dev
Current Deployment ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

デプロイされたURLをメモしておきます。

### 3.6 デプロイの動作確認

デプロイされたエンドポイントをテストします：

```bash
ENRAI_URL="https://enrai.YOUR_SUBDOMAIN.workers.dev"

# Discovery endpoint
curl $ENRAI_URL/.well-known/openid-configuration | jq

# JWKS endpoint
curl $ENRAI_URL/.well-known/jwks.json | jq
```

**確認ポイント:**
- Discovery endpointのissuerフィールドがデプロイURLと一致していること
- JWKS endpointが空でない公開鍵を返すこと
- すべてのエンドポイントURLがHTTPSであること

---

## 4. OpenID Conformance Suiteの利用

### 4.1 アカウント登録

1. OpenID Conformance Suiteにアクセス:
   https://www.certification.openid.net/

2. 「Sign up」をクリックして新規アカウントを作成します

3. メールアドレスを確認し、ログインします

### 4.2 テストプランの作成

1. ログイン後、「Create a new test plan」をクリック

2. 以下の設定を選択:

   | 項目 | 設定値 |
   |------|--------|
   | **Test Type** | OpenID Connect Provider |
   | **Profile** | Basic OP (Authorization Code Flow) |
   | **Client Type** | Public Client |
   | **Response Type** | code |
   | **Response Mode** | default (query) |

3. 「Continue」をクリック

### 4.3 OP（OpenID Provider）情報の入力

テストプランの設定画面で、Enraiの情報を入力します：

| フィールド | 値 | 例 |
|-----------|-----|-----|
| **Issuer** | デプロイしたWorkerのURL | `https://enrai.YOUR_SUBDOMAIN.workers.dev` |
| **Discovery URL** | `{ISSUER}/.well-known/openid-configuration` | `https://enrai.YOUR_SUBDOMAIN.workers.dev/.well-known/openid-configuration` |

「Discover」ボタンをクリックすると、自動的にEnraiのメタデータが読み込まれます。

### 4.4 クライアント登録

OpenID Conformance Suiteが使用するテストクライアント情報を記録します。

**✅ 実装済み:** EnraiはDynamic Client Registration (DCR) を完全にサポートしています。

テストスイートは以下の手順でクライアントを自動登録できます：

```bash
curl -X POST $ENRAI_URL/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "OpenID Conformance Test Client",
    "redirect_uris": [
      "https://www.certification.openid.net/test/a/enrai/callback",
      "https://www.certification.openid.net/test/a/enrai/callback?dummy1=lorem",
      "https://www.certification.openid.net/test/a/enrai/callback?dummy2=ipsum"
    ],
    "response_types": ["code"],
    "grant_types": ["authorization_code", "refresh_token"],
    "token_endpoint_auth_method": "client_secret_basic",
    "subject_type": "public"
  }'
```

レスポンス例：
```json
{
  "client_id": "client_xxxxxxxxxxxxx",
  "client_secret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "client_id_issued_at": 1234567890,
  "client_secret_expires_at": 0,
  "redirect_uris": [...],
  "token_endpoint_auth_method": "client_secret_basic",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "application_type": "web",
  "subject_type": "public"
}
```

### 4.5 サポートされている高度な機能

Enraiは以下のOIDC拡張機能をサポートしています：

**RFC 9101: JWT Secured Authorization Request (JAR)**
- `request` パラメータによる認可リクエストのJWT化
- 署名付き (RS256) および未署名 (alg=none) リクエストオブジェクトの両方をサポート
- リクエストパラメータの上書き（request object parameters take precedence）

**OIDC Core 3.1.2.1: 認証パラメータ**
- `prompt`: none, login, consent, select_account
- `max_age`: 再認証時間制約
- `id_token_hint`: セッションヒント用IDトークン
- `acr_values`: 認証コンテキストクラスリファレンス

**RFC 6749: Refresh Token**
- Refresh Token発行とローテーション
- スコープのダウングレードをサポート

**OIDC Core 8: Subject Types**
- Public subject identifiers
- Pairwise subject identifiers (sector_identifier_uri対応)

---

## 5. テストの実行

### 5.1 Basic OP Profile テストの選択

OpenID Conformance Suiteで以下のテストモジュールを選択します：

#### 必須テスト (Core Tests)

1. **oidcc-basic-certification-test-plan**
   - Discovery endpoint test
   - Authorization Code Flow test
   - Token endpoint test
   - UserInfo endpoint test
   - ID Token validation test

2. **oidcc-test-plan-jwks**
   - JWKS endpoint test
   - Key format validation
   - Signature verification

3. **oidcc-test-rp-discovery**
   - Metadata format validation
   - Endpoint URL validation
   - Supported features validation

### 5.2 テストの開始

1. テストモジュールを選択後、「Start Test」をクリック

2. ブラウザで表示される指示に従います：
   - Authorization URLが表示されたら、クリックしてEnraiの認可エンドポイントにアクセス
   - リダイレクト後、テストスイートが自動的に続行します

3. 各テストの実行中に表示されるログを確認します

### 5.3 テストケースの詳細

**Discovery Tests:**
- `.well-known/openid-configuration` の形式確認
- 必須フィールドの存在確認
- Issuer URLの一貫性確認

**Authorization Tests:**
- 認可コードの生成
- State パラメータの検証
- Nonce パラメータの検証
- PKCEサポートの確認

**Token Tests:**
- 認可コードの交換
- ID Tokenの形式確認
- Access Tokenの発行
- Token有効期限の確認

**UserInfo Tests:**
- Bearer Token認証
- Claims返却の確認
- `sub` claimの一貫性確認

**JWKS Tests:**
- JWK Set形式の確認
- RS256公開鍵の検証
- 署名検証

**Request Object (JAR) Tests:**
- `request` パラメータの処理
- 未署名 (alg=none) リクエストオブジェクトの検証
- 署名付き (RS256) リクエストオブジェクトの検証
- パラメータオーバーライドの確認

**Authentication Parameter Tests:**
- `prompt=none` の既存セッション要件の確認
- `prompt=login` の強制再認証
- `max_age` の時間制約の適用
- `id_token_hint` からのセッション抽出
- `acr_values` の選択と ID Token への含有

**Refresh Token Tests:**
- Refresh Token の発行
- Refresh Token による新規 Access Token の取得
- スコープのダウングレード
- Refresh Token のローテーション

**Dynamic Client Registration Tests:**
- POST /register エンドポイント
- メタデータの検証
- client_id と client_secret の発行
- Pairwise subject type のサポート

---

## 6. 結果の確認と記録

### 6.1 テスト結果の確認

テスト完了後、以下の情報を確認します：

- **Passed Tests:** 合格したテスト数
- **Failed Tests:** 失敗したテスト数
- **Warnings:** 警告の数（合格だが改善推奨）
- **Skipped Tests:** スキップされたテスト数

### 6.2 合格基準

**Basic OP Profile 認証の要件:**
- Core tests: 100% pass
- Discovery tests: 100% pass
- JWKS tests: 100% pass
- Optional tests: 推奨される

**Enraiの目標:**
- 100% overall conformance score (すべての必須機能実装済み)
- 0 critical failures
- すべてのOIDC OP Basic Profileテストに合格

### 6.3 結果のエクスポート

1. テスト結果画面で「Export」をクリック
2. JSON形式でダウンロード
3. `docs/conformance/test-results/` に保存

```bash
# test-results ディレクトリを作成
mkdir -p docs/conformance/test-results

# ダウンロードしたファイルを移動
mv ~/Downloads/conformance-test-result-*.json docs/conformance/test-results/

# 結果ファイルをリネーム（日付付き）
cd docs/conformance/test-results
mv conformance-test-result-*.json result-$(date +%Y%m%d).json
```

### 6.4 テストレポートの作成

テスト結果を以下のテンプレートでレポートにまとめます：

```markdown
# Enrai - OpenID Conformance Test Report

**Test Date:** YYYY-MM-DD
**Tester:** Your Name
**Enrai Version:** vX.Y.Z
**Environment:** Cloudflare Workers
**Test Suite:** OpenID Connect Basic OP Profile

## Test Results Summary

| Category | Passed | Failed | Warnings | Total |
|----------|--------|--------|----------|-------|
| Core     | X      | X      | X        | X     |
| Discovery| X      | X      | X        | X     |
| JWKS     | X      | X      | X        | X     |
| **Total**| **X**  | **X**  | **X**    | **X** |

**Overall Conformance Score:** XX.X%

## Detailed Results

### Passed Tests
- [List of passed tests]

### Failed Tests
- [List of failed tests with reasons]

### Warnings
- [List of warnings and recommendations]

## Issues Identified

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | ... | High | Open |

## Next Steps
- [Action items based on test results]
```

---

## 7. トラブルシューティング

### 7.1 よくある問題

#### 問題: Discovery endpointが見つからない (404)

**原因:**
- デプロイが完了していない
- ルーティング設定が間違っている

**解決方法:**
```bash
# デプロイステータスを確認
wrangler deployments list

# 最新のデプロイメントが active であることを確認
# 必要に応じて再デプロイ
pnpm run deploy
```

#### 問題: JWKS endpointが空のkeys配列を返す

**原因:**
- `PUBLIC_JWK_JSON` シークレットが設定されていない
- 環境変数の形式が間違っている

**解決方法:**
```bash
# PUBLIC_JWK_JSON を再設定
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON

# 設定を確認
wrangler secret list
```

#### 問題: Token endpointでサーバーエラー (500)

**原因:**
- `PRIVATE_KEY_PEM` シークレットが設定されていない
- 鍵の形式が間違っている

**解決方法:**
```bash
# PRIVATE_KEY_PEM を再設定
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM

# 再デプロイ
pnpm run deploy
```

#### 問題: Issuer URLの不一致

**原因:**
- `wrangler.toml` の `ISSUER` 環境変数がデプロイURLと一致していない

**解決方法:**
```toml
# wrangler.toml を編集
[vars]
ISSUER = "https://enrai.YOUR_SUBDOMAIN.workers.dev"
```

```bash
# 再デプロイ
pnpm run deploy
```

#### 問題: Conformance Suiteが"Unable to connect"エラーを表示

**原因:**
- EnraiがHTTPSでアクセスできない
- CORS設定が間違っている
- ファイアウォールがアクセスをブロックしている

**解決方法:**
```bash
# HTTPSアクセスを確認
curl -I https://enrai.YOUR_SUBDOMAIN.workers.dev/.well-known/openid-configuration

# CORS設定を確認（src/index.ts）
# 必要に応じてCORSミドルウェアを追加
```

### 7.2 デバッグ方法

#### Cloudflare Workers のログ確認

```bash
# リアルタイムでログを確認
wrangler tail

# ログをファイルに保存
wrangler tail > logs.txt
```

#### ローカルでの再現テスト

```bash
# 開発サーバーを起動
pnpm run dev

# 別のターミナルで同じリクエストを送信
curl -v http://localhost:8787/.well-known/openid-configuration
```

#### テストスクリプトの使用

```bash
# 統合テストを実行
pnpm test

# 特定のエンドポイントをテスト
pnpm test -- --grep "discovery"
pnpm test -- --grep "token"
```

### 7.3 サポートとリソース

**ドキュメント:**
- [OpenID Connect Core Specification](https://openid.net/specs/openid-connect-core-1_0.html)
- [OpenID Conformance Testing](https://openid.net/certification/testing/)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)

**コミュニティ:**
- Enrai GitHub Issues: https://github.com/sgrastar/enrai/issues
- OpenID Foundation: https://openid.net/

**参考資料:**
- [Manual Conformance Checklist](./manual-checklist.md) - 手動テストチェックリスト
- [Test Plan](./test-plan.md) - テスト計画の詳細

---

## 8. 次のステップ

### 8.1 すぐに実施すること

1. **デプロイの実行**
   ```bash
   pnpm run deploy
   ```

2. **OpenID Conformance Suiteでアカウント作成**
   - https://www.certification.openid.net/

3. **初回テストの実行**
   - Basic OP Profileテストを選択
   - 結果を記録

### 8.2 テスト後の対応

1. **失敗したテストの分析**
   - エラーメッセージを確認
   - ログを調査
   - 原因を特定

2. **コードの修正**
   - 該当するハンドラーを修正
   - ユニットテストを追加
   - 統合テストで確認

3. **再テストの実行**
   - 修正をデプロイ
   - Conformance Suiteで再テスト
   - 合格率を確認

### 8.3 実装完了機能の確認

以下の機能がすべて実装済みです：

1. ✅ `/register` エンドポイント (Dynamic Client Registration)
2. ✅ クライアントメタデータの検証
3. ✅ クライアントストレージ（KV）
4. ✅ Refresh Token サポート
5. ✅ Request Object (JAR) サポート
6. ✅ 認証パラメータ (prompt, max_age, id_token_hint, acr_values)
7. ✅ Subject Type (public, pairwise) サポート

**次のステップ:** Conformance Suiteで全テストを実行し、100%合格を確認

---

> ⚡️ **Enrai** - Complete OpenID Conformance Testing Guide
>
> **更新日:** 2025-11-18
> **ステータス:** Phase 5 完了 - すべての必須機能実装済み
> **目標:** 100% conformance score (達成見込み)
>
> このガイドを使用して、ローカル開発からConformance Testingまで完全にサポートします。
