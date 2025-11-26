# テスト仕様書（Test Specification）フォーマット仕様

## 概要

テスト仕様書は、OIDC適合性テストの実行時に参照されるJSON形式のファイルです。
各テストに対してスクリーンショット取得の要否やタイミングを指定します。

## 生成方法

```bash
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/generate-test-spec.ts \
  --plan-name basic-op \
  --output ./test-spec.json
```

### 利用可能なプラン名

| キー | 説明 |
|------|------|
| `basic-op` | OIDC Basic OP (Authorization Code Flow) |
| `implicit-op` | OIDC Implicit OP |
| `hybrid-op` | OIDC Hybrid OP |
| `config-op` | OIDC Config OP (Discovery/JWKS) |
| `dynamic-op` | OIDC Dynamic OP (Dynamic Client Registration) |
| `formpost-basic` | Form Post + Authorization Code |
| `formpost-implicit` | Form Post + Implicit |
| `formpost-hybrid` | Form Post + Hybrid |
| `rp-logout-op` | RP-Initiated Logout |
| `session-management-op` | Session Management |
| `3rdparty-login-op` | 3rd Party Initiated Login |
| `fapi-2` | FAPI 2.0 Security Profile |

## ファイル構造

```json
{
  "planName": "oidcc-basic-certification-test-plan",
  "generatedAt": "2025-11-26T10:00:00.000Z",
  "configFile": "basic-op.json",
  "tests": [
    {
      "testModule": "oidcc-response-type-missing",
      "testSummary": "This test sends an authorization request...",
      "variant": {
        "client_auth_type": "client_secret_basic",
        "response_type": "code"
      },
      "requiresScreenshot": true,
      "screenshotTiming": "on_error_page",
      "expectedError": "unsupported_response_type|invalid_request",
      "notes": "エラーページのスクリーンショットが必要"
    }
  ]
}
```

---

## トップレベルパラメータ

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `planName` | string | OpenID Conformance Suite のテストプラン名。例: `oidcc-basic-certification-test-plan` |
| `generatedAt` | string | 仕様書が生成された日時（ISO 8601形式） |
| `configFile` | string | 使用する設定ファイル名。`config/` ディレクトリ内のファイル |
| `tests` | array | テストエントリの配列 |

---

## テストエントリ（tests配列の各要素）

### testModule
- **型**: `string`
- **必須**: Yes
- **説明**: テストモジュールの識別子。Conformance Suiteで定義されているテスト名
- **例**: `"oidcc-server"`, `"oidcc-response-type-missing"`, `"oidcc-prompt-login"`

### testSummary
- **型**: `string`
- **必須**: Yes
- **説明**: テストの概要説明。Conformance Suite Plan APIから取得される。テストの目的と期待される動作を記述
- **例**: `"This test sends an authorization request that is missing the response_type parameter..."`

### variant
- **型**: `object`
- **必須**: No
- **説明**: テストのバリエーション設定。認証方式やレスポンスタイプを指定

| サブパラメータ | 値の例 | 説明 |
|---------------|--------|------|
| `client_auth_type` | `"client_secret_basic"`, `"client_secret_post"`, `"private_key_jwt"` | クライアント認証方式 |
| `response_type` | `"code"`, `"id_token"`, `"code id_token"` | OAuth 2.0 レスポンスタイプ |
| `response_mode` | `"default"`, `"form_post"` | レスポンスモード |

### requiresScreenshot
- **型**: `boolean`
- **必須**: Yes
- **説明**: このテストでスクリーンショットのアップロードが必要かどうか
- **自動判定ロジック**: `testSummary` に以下のキーワードが含まれる場合 `true`:
  - `"screenshot"`
  - `"uploaded"`
  - `"image should be"`

| 値 | 説明 |
|----|------|
| `true` | スクリーンショットのアップロードが必要 |
| `false` | スクリーンショット不要 |

### screenshotTiming
- **型**: `string | null`
- **必須**: No（`requiresScreenshot: false` の場合は `null`）
- **説明**: スクリーンショットを取得するタイミング

#### エラー系
| 値 | 説明 | 使用ケース |
|----|------|-----------|
| `"on_error_page"` | エラーページが表示されたとき | 不正なリクエストに対するエラー表示の確認（invalid_request等） |
| `"on_error_redirect"` | エラーでリダイレクトされたとき | エラーレスポンスがコールバックURLに返される場合 |

#### ログイン系
| 値 | 説明 | 使用ケース |
|----|------|-----------|
| `"on_login"` | 初回ログイン画面 | ログイン画面の表示確認 |
| `"on_login_2nd"` | 2回目のログイン画面 | `prompt=login` による再認証 |
| `"on_login_3rd"` | 3回目のログイン画面 | 複数回の認証が必要なテスト |
| `"on_reauth"` | 再認証画面 | `max_age` による強制再認証 |

#### 同意系
| 値 | 説明 | 使用ケース |
|----|------|-----------|
| `"on_consent"` | 初回同意画面 | 同意画面の表示確認 |
| `"on_consent_2nd"` | 2回目の同意画面 | `prompt=consent` による再同意 |

#### セッション管理系
| 値 | 説明 | 使用ケース |
|----|------|-----------|
| `"on_logout"` | ログアウト画面 | ログアウト確認画面の表示 |
| `"on_logout_confirm"` | ログアウト確認ダイアログ | フロントチャネルログアウトの確認 |
| `"on_session_check"` | セッションチェック画面 | セッション管理のiframe確認 |

#### 特殊ケース
| 値 | 説明 | 使用ケース |
|----|------|-----------|
| `"on_interaction"` | ユーザー操作が必要な画面 | `interaction_required` エラー時の画面 |
| `"on_account_selection"` | アカウント選択画面 | `prompt=select_account` による選択画面 |
| `"on_mfa"` | MFA/2要素認証画面 | 追加認証が必要な場合 |
| `"manual"` | 手動でスクリーンショットを取得 | 自動取得が困難なケース |
| `null` | スクリーンショット不要 | `requiresScreenshot: false` の場合 |

#### 複数タイミング指定
複数のタイミングでスクリーンショットが必要な場合は、カンマ区切りで指定可能：
```json
"screenshotTiming": "on_login_2nd,on_error_page"
```

#### 自動判定ロジック

`generate-test-spec.ts` は以下のルールでタイミングを自動判定します：

| testModuleパターン | 判定されるタイミング |
|-------------------|-------------------|
| `prompt-login` | `on_login_2nd` |
| `max-age` | `on_reauth` |
| `id-token-hint` | `on_login_2nd` |
| `prompt-consent` | `on_consent_2nd` |
| `logout` | `on_logout` |
| `session` | `on_session_check` |
| `select-account` | `on_account_selection` |
| `interaction` | `on_interaction` |
| `missing`, `invalid`, `mismatch` | `on_error_page` |
| `prompt-none-not-logged-in` | `on_error_page` |

### expectedError
- **型**: `string | null`
- **必須**: No
- **説明**: テストで期待されるOAuth 2.0エラーコード。複数の場合はパイプ（`|`）区切り
- **自動判定ロジック**: `testSummary` から以下のエラーコードを抽出:

| エラーコード | 説明 |
|-------------|------|
| `unsupported_response_type` | サポートされていないレスポンスタイプ |
| `invalid_request` | 不正なリクエスト |
| `access_denied` | アクセス拒否 |
| `login_required` | ログインが必要 |
| `interaction_required` | ユーザー操作が必要 |
| `consent_required` | 同意が必要 |
| `invalid_scope` | 不正なスコープ |
| `invalid_grant` | 不正なグラント |
| `unauthorized_client` | 認可されていないクライアント |
| `invalid_client` | 不正なクライアント |

- **例**: `"unsupported_response_type|invalid_request"`（どちらかのエラーが期待される）

### notes
- **型**: `string`
- **必須**: No
- **説明**: ユーザーが追記できるメモ欄。テスト実行時の注意事項や補足情報
- **自動生成**: `screenshotTiming` に基づいて日本語の説明が設定される
- **例**: `"エラーページのスクリーンショットが必要"`, `"2回目のログイン画面のスクリーンショットが必要"`

---

## 使用例

### 基本的なテスト（スクリーンショット不要）

```json
{
  "testModule": "oidcc-server",
  "testSummary": "Tests primarily 'happy' flows",
  "variant": {
    "client_auth_type": "client_secret_basic",
    "response_type": "code"
  },
  "requiresScreenshot": false,
  "screenshotTiming": null,
  "expectedError": null,
  "notes": ""
}
```

### エラーページのスクリーンショットが必要なテスト

```json
{
  "testModule": "oidcc-response-type-missing",
  "testSummary": "This test sends an authorization request that is missing the response_type parameter. The authorization server must either redirect back with an 'unsupported_response_type' or 'invalid_request' error, or must display an error saying the response type is missing, a screenshot of which should be uploaded.",
  "variant": {
    "client_auth_type": "client_secret_basic",
    "response_type": "code"
  },
  "requiresScreenshot": true,
  "screenshotTiming": "on_error_page",
  "expectedError": "unsupported_response_type|invalid_request",
  "notes": "エラーページのスクリーンショットが必要"
}
```

### 再認証画面のスクリーンショットが必要なテスト

```json
{
  "testModule": "oidcc-prompt-login",
  "testSummary": "This test calls the authorization endpoint test twice. The second time it will include prompt=login, so that the authorization server is required to ask the user to login a second time. A screenshot of the second authorization should be uploaded.",
  "variant": {
    "client_auth_type": "client_secret_basic",
    "response_type": "code"
  },
  "requiresScreenshot": true,
  "screenshotTiming": "on_login_2nd",
  "expectedError": null,
  "notes": "2回目のログイン画面のスクリーンショットが必要"
}
```

### max_age による再認証テスト

```json
{
  "testModule": "oidcc-max-age-1",
  "testSummary": "This test calls the authorization endpoint test twice. The second time it waits 1 second and includes max_age=1, so that the authorization server is required to ask the user to login a second time and must return an auth_time claim in the second id_token. A screenshot of the second authorization should be uploaded.",
  "variant": {
    "client_auth_type": "client_secret_basic",
    "response_type": "code"
  },
  "requiresScreenshot": true,
  "screenshotTiming": "on_reauth",
  "expectedError": null,
  "notes": "再認証画面のスクリーンショットが必要"
}
```

### 手動スクリーンショットが必要なテスト

```json
{
  "testModule": "oidcc-custom-test",
  "testSummary": "This test requires manual screenshot capture...",
  "variant": {
    "client_auth_type": "client_secret_basic",
    "response_type": "code"
  },
  "requiresScreenshot": true,
  "screenshotTiming": "manual",
  "expectedError": null,
  "notes": "手動でスクリーンショットを取得する必要あり"
}
```

---

## ユーザー編集ガイドライン

### 編集可能なフィールド

以下のフィールドはユーザーが編集することを想定しています：

1. **`requiresScreenshot`** - 自動判定が誤っている場合に修正
2. **`screenshotTiming`** - 適切なタイミングに変更
3. **`notes`** - 補足情報やメモを追記

### 編集すべきでないフィールド

以下のフィールドは変更しないでください：

- `testModule` - テスト識別子
- `testSummary` - APIから取得した説明文
- `variant` - テストのバリエーション設定

### 編集例

自動判定で `requiresScreenshot: false` となったが、実際にはスクリーンショットが必要な場合：

```json
// Before
{
  "testModule": "oidcc-custom-test",
  "requiresScreenshot": false,
  "screenshotTiming": null,
  "notes": ""
}

// After（ユーザー編集後）
{
  "testModule": "oidcc-custom-test",
  "requiresScreenshot": true,
  "screenshotTiming": "on_error_page",
  "notes": "エラー表示の確認が必要"
}
```

---

## 関連コマンド

```bash
# 仕様書生成
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/generate-test-spec.ts \
  --plan-name basic-op \
  --output ./test-spec.json

# 仕様書を使ってテスト実行
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/run-conformance.ts \
  --plan basic-op \
  --spec ./test-spec.json

# プレースホルダーを確認
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/check-image-placeholders.ts \
  --plan <planId>

# 手動で画像をアップロード
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/check-image-placeholders.ts \
  --module <moduleId> \
  --upload ./screenshot.png
```

---

## Conformance Suite API

### 画像アップロードエンドポイント

#### 制限事項
- **ファイル形式**: PNG または JPEG のみ
- **最大サイズ**: 500KB
- **フォーマット**: Data URI形式 (`data:image/png;base64,<base64data>`)

#### 新規画像アップロード
```
POST /api/log/{moduleId}/images
Content-Type: text/plain;charset=UTF-8
Authorization: Bearer {token}

Body: data:image/png;base64,iVBORw0KGgo...  (Data URI形式、生文字列)

Query Parameters:
- description: 画像の説明（オプション）
```

#### プレースホルダーへのアップロード
```
POST /api/log/{moduleId}/images/{placeholder}
Content-Type: text/plain;charset=UTF-8
Authorization: Bearer {token}

Body: data:image/png;base64,iVBORw0KGgo...  (Data URI形式、生文字列)
```

### 画像プレースホルダーの検出

テストログ内の `upload.placeholder` フィールドを確認：

```json
{
  "src": "VerifyUserAuthenticated",
  "msg": "Please upload a screenshot...",
  "upload": {
    "placeholder": "error_screenshot"
  }
}
```
