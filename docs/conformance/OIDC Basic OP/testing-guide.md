# Enrai - OpenID Conformance Testing Guide (Without Docker) ⚡️

**Purpose:** How to perform OpenID Connect conformance testing without Docker environment
**Target:** Phase 3 - Testing & Validation
**Last Updated:** 2025-11-11

---

## Overview

This guide explains how to test Enrai's OpenID Connect conformance when you don't have a Docker environment. By using the OpenID Foundation's online Conformance Suite, you can perform official certification testing without installing Docker locally.

**Prerequisites:**
- Enrai deployed at a publicly accessible URL (Cloudflare Workers)
- Accessible via HTTPS
- OpenID Foundation account (free)

---

## Table of Contents

1. [Prepare Test Environment](#1-prepare-test-environment)
2. [Deploy to Cloudflare Workers](#2-deploy-to-cloudflare-workers)
3. [Use OpenID Conformance Suite](#3-use-openid-conformance-suite)
4. [Execute Tests](#4-execute-tests)
5. [Verify and Record Results](#5-verify-and-record-results)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Prepare Test Environment

### 1.1 Local Testing Before Deployment

Before public deployment, verify that Enrai works correctly in your local environment.

```bash
# Navigate to project root
cd /path/to/enrai

# Generate RSA keys (if not already done)
./scripts/setup-dev.sh

# Start development server
pnpm run dev
```

### 1.2 Verify Local Operation

Run the following commands in another terminal to verify all endpoints respond correctly:

```bash
# Discovery endpoint
curl http://localhost:8787/.well-known/openid-configuration | jq

# JWKS endpoint
curl http://localhost:8787/.well-known/jwks.json | jq

# Authorization endpoint (open in browser)
open "http://localhost:8787/authorize?response_type=code&client_id=test&redirect_uri=http://localhost:3000/callback&scope=openid%20profile&state=test"
```

**Expected Results:**
- Discovery endpoint: 200 OK, valid JSON
- JWKS endpoint: 200 OK, JWK Set containing RSA public key
- Authorization endpoint: 302 Found, redirect with authorization code

After verifying all endpoints work correctly, proceed to the next step.

---

## 2. Deploy to Cloudflare Workers

The OpenID Conformance Suite requires an internet-accessible URL. Deploy to Cloudflare Workers to obtain a public URL.

### 2.1 Generate Production RSA Keys

Generate a new RSA key pair for the production environment:

```bash
# Backup existing development keys (optional)
cp -r .keys .keys.dev

# Generate new keys
pnpm run generate-keys
```

### 2.2 Configure Wrangler Secrets

Set the generated keys as Cloudflare Workers secrets:

```bash
# Configure PRIVATE_KEY_PEM
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM

# Configure PUBLIC_JWK_JSON
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON
```

**Important:** Secrets are stored encrypted and only accessible in the Workers runtime.

### 2.3 wrangler.toml の設定確認

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

### 2.4 TypeScriptのビルド

デプロイ前にTypeScriptをビルドします：

```bash
pnpm run build
```

エラーがないことを確認してください。

### 2.5 デプロイ

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

### 2.6 デプロイの動作確認

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

## 3. OpenID Conformance Suiteの利用

### 3.1 アカウント登録

1. OpenID Conformance Suiteにアクセス:
   https://www.certification.openid.net/

2. 「Sign up」をクリックして新規アカウントを作成します

3. メールアドレスを確認し、ログインします

### 3.2 テストプランの作成

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

### 3.3 OP（OpenID Provider）情報の入力

テストプランの設定画面で、Enraiの情報を入力します：

| フィールド | 値 | 例 |
|-----------|-----|-----|
| **Issuer** | デプロイしたWorkerのURL | `https://enrai.YOUR_SUBDOMAIN.workers.dev` |
| **Discovery URL** | `{ISSUER}/.well-known/openid-configuration` | `https://enrai.YOUR_SUBDOMAIN.workers.dev/.well-known/openid-configuration` |

「Discover」ボタンをクリックすると、自動的にEnraiのメタデータが読み込まれます。

### 3.4 クライアント登録

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

### 3.5 サポートされている高度な機能

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

## 4. テストの実行

### 4.1 Basic OP Profile テストの選択

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

### 4.2 テストの開始

1. テストモジュールを選択後、「Start Test」をクリック

2. ブラウザで表示される指示に従います：
   - Authorization URLが表示されたら、クリックしてEnraiの認可エンドポイントにアクセス
   - リダイレクト後、テストスイートが自動的に続行します

3. 各テストの実行中に表示されるログを確認します

### 4.3 テストケースの詳細

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

## 5. 結果の確認と記録

### 5.1 テスト結果の確認

テスト完了後、以下の情報を確認します：

- **Passed Tests:** 合格したテスト数
- **Failed Tests:** 失敗したテスト数
- **Warnings:** 警告の数（合格だが改善推奨）
- **Skipped Tests:** スキップされたテスト数

### 5.2 合格基準

**Basic OP Profile 認証の要件:**
- Core tests: 100% pass
- Discovery tests: 100% pass
- JWKS tests: 100% pass
- Optional tests: 推奨される

**Enraiの目標:**
- 100% overall conformance score (すべての必須機能実装済み)
- 0 critical failures
- すべてのOIDC OP Basic Profileテストに合格

### 5.3 結果のエクスポート

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

### 5.4 テストレポートの作成

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

## 6. トラブルシューティング

### 6.1 よくある問題

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

### 6.2 デバッグ方法

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
npm test

# 特定のエンドポイントをテスト
npm test -- --grep "discovery"
npm test -- --grep "token"
```

### 6.3 サポートとリソース

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
- [Deployment Guide](../DEPLOYMENT.md) - デプロイメントガイド

---

## 7. Phase 3 タスクリストとの対応

このガイドは、TASKS.mdのPhase 3タスクに対応しています：

### Week 13: Conformance Suite Setup ✓

- [x] ~~Install Docker and Docker Compose~~ → オンライン版を使用するため不要
- [x] ~~Clone OpenID Conformance Suite repository~~ → オンライン版を使用するため不要
- [x] Configure conformance suite for Basic OP profile → セクション3.2で実施
- [x] Set up test environment → セクション2で実施

### Week 13.2: Configuration ✓

- [x] Configure OP metadata → セクション3.3で実施
- [x] Configure test plan → セクション3.2で実施
- [x] Document setup process → このドキュメント全体

### Week 13.3: Initial Test Run

- [ ] Run conformance suite → セクション4で実施予定
- [ ] Collect test results → セクション5で実施予定
- [ ] Identify failing tests → セクション5.1で実施予定
- [ ] Prioritize fixes → セクション5.4で実施予定

### Week 14-17: Conformance Test Fixes

- [ ] Fix discovery endpoint issues
- [ ] Fix core flow issues
- [ ] Fix JWT/JWK issues
- [ ] Fix OAuth 2.0 issues
- [ ] Fix edge cases

### Week 18: Final Validation

- [ ] Complete test run
- [ ] Create test report → セクション5.4で実施予定
- [ ] Verify conformance score ≥ 85%
- [ ] Document certification readiness

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

> ⚡️ **Enrai** - Docker不要のOpenID Conformance Testing
>
> **更新日:** 2025-11-18
> **ステータス:** Phase 5 完了 - すべての必須機能実装済み
> **目標:** 100% conformance score (達成見込み)
>
> このガイドを使用して、Dockerなしでも正式なOpenID Connect準拠テストを実施できます。
