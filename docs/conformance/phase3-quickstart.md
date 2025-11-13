# Phase 3 クイックスタートガイド 🚀

**所要時間:** 約30分
**対象:** Enrai Phase 3テストの実施者
**更新日:** 2025-11-11

---

## 概要

このガイドでは、Phase 3のOpenID Conformance Testingを最短で開始する手順を説明します。

**前提条件:**
- Node.js 18+インストール済み
- Cloudflareアカウント作成済み
- wrangler CLI認証済み (`wrangler login`)

---

## ステップ1: ローカル動作確認 (5分)

```bash
# プロジェクトルートに移動
cd /path/to/enrai

# 依存関係のインストール（初回のみ）
npm install

# RSA鍵の生成と設定
./scripts/setup-dev.sh

# 開発サーバーの起動
npm run dev
```

別のターミナルで動作確認：

```bash
# Discovery endpoint
curl http://localhost:8787/.well-known/openid-configuration | jq .issuer

# JWKS endpoint
curl http://localhost:8787/.well-known/jwks.json | jq '.keys | length'
# 出力が "1" 以上であればOK
```

**✓ 期待される結果:**
- Discovery: `"http://localhost:8787"` が返る
- JWKS: 数字（1以上）が返る

---

## ステップ2: プロダクション環境へのデプロイ (10分)

### 2.1 プロダクション用鍵の生成

```bash
# 開発サーバーを停止 (Ctrl+C)

# 既存の鍵をバックアップ
cp -r .keys .keys.dev

# 新しい鍵を生成
npm run generate-keys

# 生成された KEY_ID を確認
jq -r '.kid' .keys/metadata.json
```

### 2.2 wrangler.toml の設定

`wrangler.toml` を開き、以下を設定：

```toml
[vars]
ISSUER = "https://enrai.YOUR_SUBDOMAIN.workers.dev"
KEY_ID = "ここに上でコピーしたKEY_IDを貼り付け"
ALLOW_HTTP_REDIRECT = "false"
```

**YOUR_SUBDOMAINの確認:**

```bash
wrangler whoami
# Account: Your Account Name
# Account ID: xxxxxxxxxxxxxxxxxxxx
```

通常は `enrai.YOUR_USERNAME.workers.dev` になります。

### 2.3 Secretsの設定

```bash
# PRIVATE_KEY_PEM を設定
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM

# PUBLIC_JWK_JSON を設定
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON
```

**注意:** 各コマンド実行後、Enterキーを押してから Ctrl+D で入力を完了します。

### 2.4 ビルドとデプロイ

```bash
# TypeScriptをビルド
npm run build

# Cloudflare Workersにデプロイ
npm run deploy
```

**✓ 期待される出力:**

```
Published enrai (X.XX sec)
  https://enrai.YOUR_SUBDOMAIN.workers.dev
```

このURLをコピーしてメモします。

### 2.5 デプロイの動作確認

```bash
# 環境変数に設定
export ENRAI_URL="https://enrai.YOUR_SUBDOMAIN.workers.dev"

# Discovery endpoint
curl $ENRAI_URL/.well-known/openid-configuration | jq .issuer
# 出力が $ENRAI_URL と一致すればOK

# JWKS endpoint
curl $ENRAI_URL/.well-known/jwks.json | jq '.keys[0].kty'
# 出力が "RSA" であればOK
```

**トラブルシューティング:**
- JWKS が空の場合 → Secretsを再設定してデプロイ
- Issuer が一致しない場合 → wrangler.toml の ISSUER を修正してデプロイ

---

## ステップ3: OpenID Conformance Suiteでのテスト (15分)

### 3.1 アカウント作成

1. https://www.certification.openid.net/ にアクセス
2. 「Sign up」をクリック
3. メールアドレスとパスワードを入力
4. メールを確認してログイン

### 3.2 テストプランの作成

1. 「Create a new test plan」をクリック
2. 以下を選択：
   - Test Type: **OpenID Connect Provider**
   - Profile: **Basic OP**
   - Client Type: **Public Client**
   - Response Type: **code**
3. 「Continue」をクリック

### 3.3 Enraiの設定

**Issuer URL** に以下を入力：

```
https://enrai.YOUR_SUBDOMAIN.workers.dev
```

「Discover」ボタンをクリックすると、自動的にメタデータが読み込まれます。

### 3.4 テストの実行

1. 「Start Test」をクリック
2. ブラウザで Authorization URL が表示されたらクリック
3. Enrai の認可エンドポイントにリダイレクトされます
4. 自動的にテストスイートにリダイレクトされ、テストが続行されます

### 3.5 結果の確認

テスト完了後、以下を確認：

- **Passed Tests:** 合格したテスト数
- **Failed Tests:** 失敗したテスト数（目標: 0）
- **Conformance Score:** 適合率（目標: ≥85%）

**✓ 成功基準:**
- Passed Tests: ≥85%
- Critical Failures: 0
- Discovery & JWKS: すべて合格

---

## ステップ4: 結果の記録

### 4.1 テスト結果のエクスポート

1. テスト結果画面で「Export」をクリック
2. JSON ファイルをダウンロード

### 4.2 結果の保存

```bash
# test-results ディレクトリを作成
mkdir -p docs/conformance/test-results

# ダウンロードしたファイルを移動
mv ~/Downloads/conformance-test-result-*.json docs/conformance/test-results/

# 日付付きでリネーム
cd docs/conformance/test-results
mv conformance-test-result-*.json result-$(date +%Y%m%d-%H%M).json
```

### 4.3 結果のコミット

```bash
# Gitに追加
git add docs/conformance/test-results/

# コミット
git commit -m "test: add OpenID Conformance test results for Phase 3"

# プッシュ
git push origin claude/phase3-test-documentation-011CV2461YR1rAMaAnJdqK1v
```

---

## トラブルシューティング

### 問題: "Unable to connect to issuer"

**解決方法:**
```bash
# HTTPSアクセスを確認
curl -I $ENRAI_URL/.well-known/openid-configuration

# 200 OK が返ることを確認
```

### 問題: "JWKS endpoint returns empty keys"

**解決方法:**
```bash
# Secrets を再設定
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON

# 再デプロイ
npm run deploy

# 確認
curl $ENRAI_URL/.well-known/jwks.json | jq
```

### 問題: "Token endpoint error (500)"

**解決方法:**
```bash
# PRIVATE_KEY_PEM を再設定
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM

# 再デプロイ
npm run deploy
```

---

## チェックリスト

Phase 3完了のためのチェックリスト：

### デプロイ前
- [ ] ローカル環境でDiscovery endpointが動作
- [ ] ローカル環境でJWKS endpointが動作
- [ ] すべてのユニットテストが合格 (`npm test`)

### デプロイ後
- [ ] プロダクション環境でDiscovery endpointが動作
- [ ] プロダクション環境でJWKS endpointが動作
- [ ] Issuer URLが一貫している

### テスト実施後
- [ ] OpenID Conformance Suiteでテスト完了
- [ ] Conformance Score ≥ 85%
- [ ] Critical Failures = 0
- [ ] テスト結果をエクスポート・保存
- [ ] 結果をGitにコミット

### ドキュメント
- [ ] テスト結果レポートを作成
- [ ] 失敗したテスト（もしあれば）の分析
- [ ] 次のステップを文書化

---

## 次のステップ

### テストが成功した場合（≥85%）

1. **Phase 3完了の宣言**
   ```bash
   # ROADMAP.md を更新
   # Phase 3のステータスを ⏳ → ✅ に変更
   ```

2. **Phase 4の準備**
   - Dynamic Client Registration の設計
   - Key Rotation の実装計画

### テストが失敗した場合（<85%）

1. **失敗原因の分析**
   - エラーログを確認
   - どのテストが失敗したか特定

2. **コード修正**
   - 該当するハンドラーを修正
   - ユニットテストを追加

3. **再テスト**
   - デプロイ
   - Conformance Suite で再実行

---

## リソース

**詳細ドキュメント:**
- [完全なテストガイド](./testing-guide.md) - 詳細な手順
- [手動チェックリスト](./manual-checklist.md) - 手動テストの方法
- [テスト計画](./test-plan.md) - テスト要件の詳細

**外部リンク:**
- [OpenID Conformance Suite](https://www.certification.openid.net/)
- [OpenID Connect Core Spec](https://openid.net/specs/openid-connect-core-1_0.html)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)

**サポート:**
- GitHub Issues: https://github.com/sgrastar/enrai/issues
- TASKS.md: Phase 3 タスクリスト

---

> 💥 **Enrai Phase 3** - 30分でConformance Testing開始
>
> **更新日:** 2025-11-11
> **所要時間:** 約30分
> **目標:** ≥85% conformance score
>
> このガイドに従って、迅速にPhase 3のテストを開始できます。
