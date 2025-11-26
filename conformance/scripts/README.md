# OIDC Conformance Test Automation

Authrim の OpenID Connect 適合性テストを自動化するツール。
[OpenID Conformance Suite](https://www.certification.openid.net) に対してテストを実行し、結果を収集します。

## 概要

このツールは以下を自動化します：

1. **テストプラン作成** - Conformance Suite API を使用してテストプランを作成
2. **テスト実行** - 各テストモジュールを順次実行
3. **ブラウザ自動化** - Playwright を使用してログイン・同意フローを自動処理
4. **スクリーンショット自動取得** - テスト仕様書に基づいて必要な画面を自動キャプチャ・アップロード
5. **結果収集** - テスト結果を Markdown/JSON/HTML で出力

## クイックスタート

### 1. セットアップ

```bash
# プロジェクトルートで依存関係をインストール
pnpm install

# Playwright ブラウザをインストール
pnpm exec playwright install chromium
```

### 2. API トークン取得

1. https://www.certification.openid.net にログイン
2. 右上のアカウントメニューから「API Tokens」を選択
3. 「Create Token」をクリックしてトークンを生成
4. トークンを安全な場所にコピー

### 3. 実行

```bash
# 環境変数設定
export CONFORMANCE_TOKEN="your-api-token"

# Basic OP テスト実行
pnpm run conformance:basic

# 詳細ログ付きで実行
pnpm run conformance:basic -- --verbose

# ブラウザ表示モードで実行（デバッグ用）
npx tsx conformance/scripts/run-conformance.ts --plan basic-op --show-browser
```

## 利用可能なテストプラン

| キー | テストプラン | 説明 |
|------|-------------|------|
| `basic-op` | OIDC Basic OP | Authorization Code Flow |
| `implicit-op` | OIDC Implicit OP | Implicit Flow |
| `hybrid-op` | OIDC Hybrid OP | Hybrid Flow |
| `config-op` | OIDC Config OP | Discovery / JWKS テスト |
| `dynamic-op` | OIDC Dynamic OP | Dynamic Client Registration |
| `formpost-basic` | OIDC Form Post OP | Form Post + Authorization Code |
| `formpost-implicit` | OIDC Form Post Implicit OP | Form Post + Implicit Flow |
| `formpost-hybrid` | OIDC Form Post Hybrid OP | Form Post + Hybrid Flow |
| `rp-logout-op` | OIDC RP-Initiated Logout OP | ログアウト機能 |
| `session-management-op` | OIDC Session Management OP | セッション管理 |
| `3rdparty-login-op` | OIDC 3rd Party Initiated Login OP | サードパーティログイン |
| `fapi-2` | FAPI 2.0 Security Profile | Financial-grade API 2.0 |

## スクリーンショット自動化

### 概要

一部のテストでは、エラー画面や再認証画面のスクリーンショットをアップロードする必要があります。
このツールは以下のワークフローでスクリーンショットを自動化します：

1. **テスト仕様書生成** - Plan API から必要なスクリーンショットを事前に特定
2. **ユーザーレビュー** - 生成された仕様書を確認・編集
3. **自動キャプチャ** - テスト実行時に指定タイミングでスクリーンショットを取得
4. **自動アップロード** - 取得したスクリーンショットを Conformance Suite にアップロード

### 使用方法

```bash
# 1. テスト仕様書を生成
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/generate-test-spec.ts \
  --plan-name basic-op \
  --output ./test-spec.json

# 2. test-spec.json を確認・必要に応じて編集
# (requiresScreenshot, screenshotTiming を調整)

# 3. 仕様書を使ってテスト実行（自動スクリーンショット）
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/run-conformance.ts \
  --plan basic-op \
  --spec ./test-spec.json

# 4. 手動でスクリーンショットをアップロード（必要な場合）
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/check-image-placeholders.ts \
  --module <moduleId> \
  --upload ./screenshot.png
```

### スクリーンショットタイミング

| タイミング | 説明 | 使用ケース |
|-----------|------|-----------|
| `on_error_page` | エラーページ | 不正なリクエストに対するエラー表示 |
| `on_error_redirect` | エラーリダイレクト | エラーレスポンスがコールバックに返される場合 |
| `on_login` | 初回ログイン画面 | ログイン画面の表示確認 |
| `on_login_2nd` | 2回目のログイン画面 | `prompt=login` による再認証 |
| `on_login_3rd` | 3回目のログイン画面 | 複数回認証が必要なテスト |
| `on_reauth` | 再認証画面 | `max_age` による強制再認証 |
| `on_consent` | 初回同意画面 | 同意画面の表示確認 |
| `on_consent_2nd` | 2回目の同意画面 | `prompt=consent` による再同意 |
| `on_logout` | ログアウト画面 | ログアウト確認画面 |
| `on_session_check` | セッションチェック | セッション管理のiframe確認 |
| `on_account_selection` | アカウント選択画面 | `prompt=select_account` |
| `on_interaction` | ユーザー操作画面 | `interaction_required` エラー時 |
| `manual` | 手動取得 | 自動取得が困難なケース |

詳細は [テスト仕様書フォーマット](docs/test-spec-format.md) を参照してください。

## コマンドラインオプション

### run-conformance.ts

```bash
npx tsx conformance/scripts/run-conformance.ts [options]
```

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--plan <name>` | テストプランキー | `basic-op` |
| `--environment <env>` | 環境 (`conformance`, `staging`, `local`) | `conformance` |
| `--spec <path>` | テスト仕様書JSONファイル | - |
| `--show-browser` | ブラウザ表示モード | `false` |
| `--verbose` | 詳細ログ出力 | `false` |
| `--skip-profile-switch` | プロファイル切り替えをスキップ | `false` |
| `--export-dir <path>` | 結果出力ディレクトリ | `./conformance` |

### generate-test-spec.ts

```bash
npx tsx conformance/scripts/generate-test-spec.ts [options]
```

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--plan-name <name>` | テストプランキー（必須） | - |
| `--output <path>` | 出力ファイルパス | `./test-spec.json` |

### check-image-placeholders.ts

```bash
npx tsx conformance/scripts/check-image-placeholders.ts [options]
```

| オプション | 説明 |
|-----------|------|
| `--plan <planId>` | プラン内の全テストをチェック |
| `--module <moduleId>` | 特定テストをチェック |
| `--upload <imagePath>` | 画像をアップロード |
| `--placeholder <name>` | アップロード先プレースホルダー |
| `--description <text>` | 画像の説明 |

## 環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| `CONFORMANCE_TOKEN` | ✅ | Conformance Suite API トークン |
| `CONFORMANCE_SERVER` | - | Conformance Suite URL (デフォルト: `https://www.certification.openid.net`) |
| `CONFORMANCE_TEST_EMAIL` | - | テストユーザーメール (デフォルト: `test@example.com`) |
| `CONFORMANCE_TEST_PASSWORD` | - | テストユーザーパスワード (デフォルト: `testpassword123`) |

## 設定ファイル

### テストプラン設定

`conformance/scripts/config/` ディレクトリに各テストプランの設定があります：

```
config/
├── test-plans.json           # テストプラン定義（マスター）
├── basic-op.json             # Basic OP 設定
├── implicit-op.json          # Implicit OP 設定
├── hybrid-op.json            # Hybrid OP 設定
├── config-op.json            # Config OP 設定
├── dynamic-op.json           # Dynamic OP 設定
├── formpost-implicit-op.json # Form Post Implicit 設定
├── formpost-hybrid-op.json   # Form Post Hybrid 設定
├── rp-logout-op.json         # RP Logout 設定
├── session-management-op.json # Session Management 設定
├── 3rdparty-login-op.json    # 3rd Party Login 設定
└── fapi-2.json               # FAPI 2.0 設定
```

### test-plans.json 構造

```json
{
  "plans": {
    "basic-op": {
      "name": "oidcc-basic-certification-test-plan",
      "displayName": "OIDC Basic OP Certification",
      "outputDir": "OIDC Basic OP",
      "profile": "basic-op",
      "configFile": "basic-op.json",
      "requiresBrowser": true,
      "variants": {
        "server_metadata": "discovery",
        "client_registration": "dynamic_client"
      }
    }
  },
  "environments": {
    "conformance": {
      "issuer": "https://conformance.authrim.com",
      "adminApiUrl": "https://conformance.authrim.com/api/admin"
    }
  }
}
```

## 出力ファイル

テスト結果は各実行ごとに `conformance/{outputDir}/results/{日時}/` に保存されます：

```
conformance/OIDC Basic OP/results/
└── 2025-11-26_153045/
    ├── run.log                       # 実行ログ（コンソール出力）
    ├── debug.log                     # デバッグログ（API詳細）
    ├── report.md                     # Markdown レポート
    ├── summary.json                  # JSON サマリー
    ├── plan-{planId}.html            # HTML レポート
    └── screenshots/                  # スクリーンショット
        ├── oidcc-server_login_2025-11-26T15-30-45.png
        └── oidcc-response-type-missing_error_2025-11-26T15-31-00.png
```

## アーキテクチャ

```
conformance/scripts/
├── run-conformance.ts          # メインエントリーポイント
├── generate-test-spec.ts       # テスト仕様書生成
├── check-image-placeholders.ts # 画像プレースホルダー確認・アップロード
├── lib/
│   ├── types.ts                # 型定義
│   ├── conformance-client.ts   # Conformance Suite API クライアント
│   ├── browser-automator.ts    # Playwright ブラウザ自動化
│   ├── profile-manager.ts      # Authrim プロファイル管理
│   ├── result-processor.ts     # 結果処理・レポート生成
│   └── logger.ts               # ロギング
├── config/
│   ├── test-plans.json         # テストプラン定義
│   ├── basic-op.json           # 各プランの設定
│   └── ...
├── expected/
│   └── expected-failures.json  # 既知の失敗テスト
└── docs/
    ├── test-spec-format.md     # テスト仕様書フォーマット仕様
    └── api-docs.json           # Conformance Suite API仕様
```

### 処理フロー

```
┌─────────────────────────────────────────────────────────────────┐
│                    テスト仕様書生成（事前）                        │
│  generate-test-spec.ts                                         │
│  1. テストプラン作成 (POST /api/plan)                            │
│  2. プラン詳細取得 (GET /api/plan/{id}) - testSummary取得        │
│  3. testSummaryからスクリーンショット要否・タイミング判定            │
│  4. JSON仕様書出力                                              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                     ユーザーレビュー・編集
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    テスト実行                                    │
│  run-conformance.ts --spec test-spec.json                      │
│  1. プロファイル切り替え                                          │
│  2. テストプラン作成                                              │
│  3. 各テストモジュール実行                                        │
│     - WAITING状態でブラウザ認証                                   │
│     - 仕様書に基づきスクリーンショット取得                          │
│     - プレースホルダー検出 → 自動アップロード                       │
│  4. 結果収集・レポート生成                                        │
└─────────────────────────────────────────────────────────────────┘
```

## トラブルシューティング

### API トークンエラー

```
Error: 401 Unauthorized
```

→ `CONFORMANCE_TOKEN` が正しく設定されているか確認

### スクリーンショットがアップロードされない

1. テスト仕様書で `requiresScreenshot: true` になっているか確認
2. `screenshotTiming` が適切に設定されているか確認
3. `--verbose` オプションでログを確認

### 手動でスクリーンショットをアップロード

```bash
# プレースホルダーを確認
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/check-image-placeholders.ts \
  --module <moduleId>

# アップロード
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/check-image-placeholders.ts \
  --module <moduleId> \
  --upload ./screenshot.png
```

### ブラウザタイムアウト

```
Error: Max attempts reached without completing authorization
```

→ `--show-browser` でブラウザを表示して確認

### テストが WAITING 状態のまま

- ブラウザ自動化が認証 URL を取得できていない可能性
- `--verbose` オプションで詳細ログを確認

## 参考リンク

- [OpenID Conformance Suite](https://www.certification.openid.net)
- [Conformance Suite API Documentation](https://www.certification.openid.net/swagger-ui/index.html)
- [Conformance Suite Wiki](https://gitlab.com/openid/conformance-suite/-/wikis/home)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-2_0-security-profile.html)
