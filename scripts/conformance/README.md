# OIDC Conformance Test Automation

Authrim の OpenID Connect 適合性テストを自動化するツール。
[OpenID Conformance Suite](https://www.certification.openid.net) に対してテストを実行し、結果を収集します。

## 概要

このツールは以下を自動化します：

1. **テストプラン作成** - Conformance Suite API を使用してテストプランを作成
2. **テスト実行** - 各テストモジュールを順次実行
3. **ブラウザ自動化** - Playwright を使用してログイン・同意フローを自動処理
4. **結果収集** - テスト結果を Markdown/JSON/HTML で出力

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
npx tsx scripts/conformance/run-conformance.ts --plan basic-op --show-browser
```

## 利用可能なテストプラン

| コマンド | テストプラン | 説明 |
|---------|-------------|------|
| `pnpm run conformance:basic` | Basic OP | OpenID Connect Basic OP 認定テスト |
| `pnpm run conformance:config` | Config OP | 設定ベースの OP テスト |
| `pnpm run conformance:dynamic` | Dynamic OP | Dynamic Client Registration テスト |
| `pnpm run conformance:fapi2` | FAPI 2.0 | Financial-grade API 2.0 セキュリティプロファイル |
| `pnpm run conformance:all` | All | 全テストプラン実行 |

## コマンドラインオプション

```bash
npx tsx scripts/conformance/run-conformance.ts [options]
```

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--plan <name>` | テストプラン名 (`basic-op`, `config-op`, `dynamic-op`, `fapi-2`) | `basic-op` |
| `--environment <env>` | 環境 (`conformance`, `staging`, `local`) | `conformance` |
| `--show-browser` | ブラウザ表示モード（デバッグ用） | `false` |
| `--verbose` | 詳細ログ出力 | `false` |
| `--skip-profile-switch` | プロファイル切り替えをスキップ | `false` |

## 環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| `CONFORMANCE_TOKEN` | ✅ | Conformance Suite API トークン |
| `CONFORMANCE_TEST_EMAIL` | - | テストユーザーメール (デフォルト: `test@example.com`) |
| `CONFORMANCE_TEST_PASSWORD` | - | テストユーザーパスワード (デフォルト: `testpassword123`) |
| `HEADLESS` | - | ヘッドレスモード (`true`/`false`) |
| `SLOW_MO` | - | ブラウザ操作の遅延 (ms) |
| `BROWSER_TIMEOUT` | - | ブラウザタイムアウト (ms, デフォルト: `30000`) |
| `SCREENSHOT_ON_ERROR` | - | エラー時スクリーンショット (`true`/`false`) |
| `SCREENSHOT_DIR` | - | スクリーンショット保存先 |

## 設定ファイル

### テストプラン設定

`scripts/conformance/config/` ディレクトリに各テストプランの設定があります：

- `basic-op.json` - Basic OP テスト設定
- `config-op.json` - Config OP テスト設定
- `dynamic-op.json` - Dynamic OP テスト設定
- `fapi-2.json` - FAPI 2.0 テスト設定

設定ファイルの例（`basic-op.json`）:

```json
{
  "alias": "authrim-basic-op",
  "description": "Authrim OpenID Connect Basic OP Certification Test",
  "server": {
    "discoveryUrl": "{ISSUER}/.well-known/openid-configuration"
  },
  "client": {
    "scope": "openid profile email"
  },
  "client2": {
    "scope": "openid profile email"
  }
}
```

### 環境設定

`scripts/conformance/config/environments.ts` で環境ごとの設定を管理：

- `conformance` - 本番テスト環境 (`https://conformance.authrim.com`)
- `staging` - ステージング環境
- `local` - ローカル開発環境

## 出力ファイル

テスト結果は各実行ごとに `docs/conformance/results/{プラン名}_{日時}/` に保存されます：

```
docs/conformance/results/
└── basic-op_2025-11-26_153045/      # テストプラン名_日時
    ├── run.log                       # 実行ログ（コンソール出力）
    ├── debug.log                     # デバッグログ（API詳細）
    ├── report.md                     # Markdown レポート
    ├── summary.json                  # JSON サマリー
    ├── plan-{planId}.html            # HTML レポート（ブラウザ用）
    └── screenshots/                  # スクリーンショット
        ├── oidcc-server_login_2025-11-26T15-30-45.png
        ├── oidcc-server_consent_2025-11-26T15-30-46.png
        └── oidcc-scope-profile_error_2025-11-26T15-31-00.png
```

スクリーンショットファイル名: `{テスト名}_{タイプ}_{タイムスタンプ}.png`
- タイプ: `login`, `consent`, `error`

## アーキテクチャ

```
scripts/conformance/
├── run-conformance.ts          # メインエントリーポイント
├── lib/
│   ├── types.ts                # 型定義
│   ├── conformance-client.ts   # Conformance Suite API クライアント
│   ├── browser-automator.ts    # Playwright ブラウザ自動化
│   ├── profile-manager.ts      # Authrim プロファイル管理
│   └── result-processor.ts     # 結果処理・レポート生成
├── config/
│   ├── environments.ts         # 環境設定
│   ├── basic-op.json           # Basic OP テスト設定
│   └── ...
└── expected/
    └── expected-failures.json  # 既知の失敗テスト
```

### 処理フロー

1. **初期化**
   - プロファイル切り替え（必要に応じて）
   - ブラウザ初期化

2. **テストプラン作成**
   - Conformance Suite API でテストプランを作成
   - Dynamic Client Registration でテストクライアントを登録

3. **テスト実行ループ**
   - 各テストモジュールを順次作成・実行
   - `WAITING` 状態でブラウザによる認証フローを処理
   - テスト完了まで状態をポーリング

4. **結果収集**
   - テスト結果を API から取得
   - レポートを生成・保存

## ブラウザ自動化

Playwright を使用して以下を自動処理します：

### ログインフロー
- ユーザー名/メール入力フィールドを検出
- パスワード入力（設定されている場合）
- ログインボタンクリック

### 同意フロー
- スコープ確認画面を検出
- 「許可」ボタンを自動クリック

### エラーハンドリング
- OAuth エラーレスポンスを検出（ネガティブテスト用）
- エラー時にスクリーンショットを保存

## トラブルシューティング

### API トークンエラー

```
Error: 401 Unauthorized
```

→ `CONFORMANCE_TOKEN` が正しく設定されているか確認

### ブラウザタイムアウト

```
Error: Max attempts reached without completing authorization
```

→ `--show-browser` でブラウザを表示して確認
→ ログイン画面の要素が正しく検出されているか確認

### テストが WAITING 状態のまま

- ブラウザ自動化が認証 URL を取得できていない可能性
- `--verbose` オプションで詳細ログを確認

### プロファイル切り替えエラー

```
Error: Failed to switch profile
```

→ Authrim サーバーが起動しているか確認
→ `--skip-profile-switch` オプションでスキップ可能

## GitHub Actions

`.github/workflows/conformance-test.yml` で GitHub Actions から実行可能：

1. リポジトリの Settings > Secrets に `CONFORMANCE_TOKEN` を設定
2. Actions タブから "OIDC Conformance Test" を選択
3. "Run workflow" をクリックして実行

### ワークフロー設定

```yaml
on:
  workflow_dispatch:
    inputs:
      plan:
        description: 'Test plan to run'
        required: true
        default: 'basic-op'
        type: choice
        options:
          - basic-op
          - config-op
          - dynamic-op
          - fapi-2
          - all
```

## テスト結果の解釈

### ステータス

| ステータス | 意味 |
|-----------|------|
| `PASSED` | テスト成功 |
| `FAILED` | テスト失敗 |
| `WARNING` | 警告付きで成功 |
| `SKIPPED` | スキップ（前提条件不一致など） |
| `REVIEW` | 手動レビューが必要 |

### 一般的なテスト

| テスト名 | 説明 |
|---------|------|
| `oidcc-server` | 基本的な認証フロー |
| `oidcc-idtoken-signature` | ID トークン署名検証 |
| `oidcc-userinfo-*` | UserInfo エンドポイント |
| `oidcc-prompt-*` | prompt パラメータ処理 |
| `oidcc-scope-*` | スコープ処理 |
| `oidcc-refresh-token` | リフレッシュトークン |
| `oidcc-codereuse*` | 認可コード再利用防止 |

## 開発・カスタマイズ

### 新しいテストプランの追加

1. `config/` に新しい設定ファイルを作成
2. `run-conformance.ts` の `TEST_PLANS` に定義を追加
3. `package.json` にコマンドを追加

### ブラウザ自動化のカスタマイズ

`lib/browser-automator.ts` を編集：

- `detectPageType()` - ページタイプ検出ロジック
- `handleLogin()` - ログイン処理
- `handleConsent()` - 同意処理

## テスト結果の詳細取得

失敗したテストの詳細を取得するスクリプト：

### 使い方

```bash
# プラン内の全テスト状態を表示
pnpm conformance:details --plan <planId>

# 失敗したテストのみ表示
pnpm conformance:errors --plan <planId>

# 特定モジュールの詳細
pnpm conformance:details --module <moduleId> -v

# 全ログを表示
pnpm conformance:details --module <moduleId> --logs
```

### オプション

| オプション | 説明 |
|-----------|------|
| `--plan <id>` | プランIDを指定（URLのplan=xxxから取得） |
| `--module <id>` | モジュールIDを指定 |
| `--failed-only` | 失敗/中断テストのみ表示 |
| `-v, --verbose` | 詳細情報を表示 |
| `--logs` | 全ログエントリを表示 |

### 例

```bash
# プランの結果サマリーと失敗テストの詳細を取得
CONFORMANCE_TOKEN="xxx" pnpm conformance:errors --plan aa4Qs25G69eya

# 特定テストの全ログを確認
CONFORMANCE_TOKEN="xxx" pnpm conformance:details --module 14YFyRbuDaYPusY --logs
```

## 参考リンク

- [OpenID Conformance Suite](https://www.certification.openid.net)
- [Conformance Suite API Documentation](https://gitlab.com/openid/conformance-suite/-/wikis/Developers/API)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-2_0-security-profile.html)
