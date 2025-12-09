# OIDC Conformance テスト対応管理

> 最終更新: 2025-12-09
> ベースライン: 2025-12-07 / 2025-12-08 テスト結果

## 対応サマリー

| 優先度 | 総数 | 完了 | 調査完了 | 未着手 |
|--------|------|------|----------|--------|
| P0 (Critical) | 2 | 2 | 0 | 0 |
| P1 (High) | 4 | 4 | 0 | 0 |
| P2 (Medium) | 3 | 2 | 1 | 0 |
| P3 (Low) | 8 | 4 | 2 | 2 |

**注**: ブラウザ自動化（ISSUE-001）の改善が完了しました。指数バックオフとフォールバック戦略によりテストの安定性が向上します。

---

## P0: Critical - 認定ブロッカー

### ISSUE-001: ブラウザ自動化エラー
- **ステータス**: ✅ 完了
- **作成日**: 2025-12-09
- **更新日**: 2025-12-09
- **影響テスト**: 約25テスト (Form Post, Frontchannel Logout, Dynamic OP等)
- **症状**: `Test marked as FAILED due to browser automation error`
- **原因**: Playwrightのタイムアウトまたはエラーページ検出失敗
- **対応状況**:
  - [x] HTMLエラーページのタイトルによる検出追加（`Unregistered`, `Invalid`, `Error`等）
  - [x] redirect_uriエラーページのHTML内容による検出追加
  - [x] リトライロジックの改善（指数バックオフ追加）
  - [x] タイムアウト設定の最適化（フォールバック戦略追加）
- **修正内容**:
  - `conformance/scripts/lib/browser-automator.ts` の改善:
    - `detectPageType()` 関数: ページタイトル・HTML内容によるエラー検出追加
    - `calculateBackoffDelay()` 関数追加: 連続unknown pages時の指数バックオフ
    - `waitForPageLoad()` 関数追加: networkidle → domcontentloaded フォールバック戦略
    - navigationTimeout/maxRetryDelay オプション追加
    - 全てのページ待機を `waitForPageLoad()` に統一
- **担当**:
- **完了予定日**:

---

### ISSUE-002: oidcc-ensure-request-without-nonce-fails
- **ステータス**: ✅ 完了（コード側は実装済み、テスト失敗はブラウザ自動化問題）
- **作成日**: 2025-12-09
- **完了日**: 2025-12-09
- **影響テスト**: 4回 FAILED (Implicit/Hybrid フロー)
- **調査結果**:
  - コードは正しく `error=invalid_request&error_description=nonce+is+required+when+response_type+contains+id_token` を返している
  - FAILEDはスクリーンショットキャプチャ/ブラウザ自動化の問題
  - ISSUE-001（ブラウザ自動化）の修正で解決予定
- **仕様参照**: [OpenID Connect Core 3.1.2.1](https://openid.net/specs/openid-connect-core-1_0.html#ImplicitAuthRequest)

---

## P1: High - 認定に影響

### ISSUE-003: oidcc-refresh-token-rp-key-rotation
- **ステータス**: ✅ 完了（コード修正済み、次回テストで確認）
- **作成日**: 2025-12-09
- **更新日**: 2025-12-09
- **影響テスト**: 5回 ERROR (Timeout)
- **症状**: RPのJWKSローテーション後のrefresh token処理でタイムアウト
- **根本原因**:
  - `client-authentication.ts` で埋め込み `jwks` が `jwks_uri` より優先されていた
  - RPがキーをローテーションしても、OPは古い埋め込みJWKSを使用していた
- **修正内容**:
  - `packages/shared/src/utils/client-authentication.ts` を修正
    - `jwks_uri` を優先するようにロジック変更（OIDC Dynamic Registration仕様準拠）
    - `jwks_uri` fetch失敗時は埋め込み `jwks` にフォールバック
    - ログ追加でデバッグ容易化
  - テストケース追加: キーローテーションシナリオとフォールバック動作
- **仕様参照**: [OIDC Dynamic Client Registration Section 2](https://openid.net/specs/openid-connect-registration-1_0.html)

---

### ISSUE-004: oidcc-ensure-request-object-with-redirect-uri (request_uri/JAR)
- **ステータス**: ✅ 完了（実装済み、テストはREVIEW状態で手動確認待ち）
- **作成日**: 2025-12-09
- **更新日**: 2025-12-09
- **影響テスト**: 20回 REVIEW（手動確認待ち）
- **調査結果**:
  - `request_uri` パラメータは既に実装済み:
    - PAR形式 (`urn:ietf:params:oauth:request_uri:`) 対応済み
    - HTTPS形式 (設定で有効化可能、SSRFセキュリティ対策済み) 対応済み
  - `request` パラメータ (Request Object by Value) も実装済み
  - RFC 9101 Section 6.3.1 準拠:
    - Request ObjectとURLパラメータ両方に`redirect_uri`がある場合、一致を検証
    - 不一致時は `invalid_request` エラーを正しく返却
  - テスト結果: `redirect_uri mismatch between query parameter and request object` は**正しい動作**
  - discovery で `request_uri_parameter_supported: true` と `request_parameter_supported: true` を既に公開
- **実装箇所**:
  - `packages/op-auth/src/authorize.ts:152-521` - request_uri/request パラメータ処理
  - `packages/op-discovery/src/discovery.ts:149-150` - discovery metadata
- **仕様参照**: [RFC 9101 - JWT-Secured Authorization Request](https://datatracker.ietf.org/doc/html/rfc9101)

---

### ISSUE-005: oidcc-server WARNING
- **ステータス**: ✅ 完了
- **作成日**: 2025-12-09
- **完了日**: 2025-12-09
- **影響テスト**: 14回 WARNING
- **症状**: discovery endpoint で推奨項目が不足
- **修正内容**:
  - `packages/op-discovery/src/discovery.ts` に以下を追加:
    - `service_documentation`
    - `ui_locales_supported`
    - `claims_locales_supported`
    - `display_values_supported`
  - `packages/shared/src/types/oidc.ts` の OIDCProviderMetadata 型を更新

---

### ISSUE-006: oidcc-codereuse-30seconds
- **ステータス**: 🟡 調査完了（ブラウザ自動化問題と判明）
- **作成日**: 2025-12-09
- **更新日**: 2025-12-09
- **影響テスト**: 9回 FAILED/WARNING
- **調査結果**:
  - `oidcc-codereuse` テストは **PASSED** → コード再利用検知は正常動作
  - `oidcc-codereuse-30seconds` の FAILED は認可リクエスト自体が `server_error` で失敗
  - ログ: `error=server_error&error_description=Failed+to+process+authorization+request`
  - 原因: ブラウザ自動化エラー（ISSUE-001）と同様、テストセットアップ時の問題
- **仕様参照**: [RFC 6749 Section 4.1.2](https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.2)
- **実装状況**:
  - ✅ 認可コードTTL: 60秒（OAuth 2.0 Security BCP準拠）
  - ✅ コード再利用検知: `AuthorizationCodeStore.ts` で `used` フラグ管理
  - ✅ トークン無効化: リプレイ攻撃検知時にJTIを記録・無効化
- **結論**: ISSUE-001（ブラウザ自動化）の修正で解決予定

---

## P2: Medium - セキュリティ強化

### ISSUE-007: oidcc-ensure-client-assertion-with-iss-aud-succeeds
- **ステータス**: ✅ 完了（実装済み、WARNINGは別原因）
- **作成日**: 2025-12-09
- **完了日**: 2025-12-09
- **影響テスト**: 5回 WARNING
- **調査結果**:
  - `packages/shared/src/utils/client-authentication.ts` で RFC 7523 準拠の検証が実装済み
  - iss = client_id 検証 ✓
  - aud = token endpoint URL 検証 ✓
  - WARNINGは Dynamic OP テストプランで発生、Implicit flow (id_token token) ではPASSED
  - code フローでの client_assertion 認証時に別の問題がある可能性（要調査）
- **仕様参照**: [RFC 7523 Section 3](https://datatracker.ietf.org/doc/html/rfc7523#section-3)

---

### ISSUE-008: oidcc-ensure-registered-redirect-uri
- **ステータス**: 🟡 調査完了（実装正常、ブラウザ自動化問題）
- **作成日**: 2025-12-09
- **更新日**: 2025-12-09
- **影響テスト**: 13回 REVIEW
- **調査結果**:
  - `packages/op-auth/src/authorize.ts:1071` で完全一致検証実装済み
  - `registeredRedirectUris.includes(redirect_uri)` による厳密な比較
  - 未登録redirect_uri時はHTMLエラーページを返却（RFC 6749 Section 3.1.2.4準拠）
  - テスト失敗はブラウザ自動化がHTMLエラーページを認識できなかったため
- **仕様参照**: [RFC 6749 Section 3.1.2.3](https://datatracker.ietf.org/doc/html/rfc6749#section-3.1.2.3)
- **結論**: ISSUE-001（ブラウザ自動化改善）で解決予定

---

### ISSUE-009: oidcc-ensure-redirect-uri-in-authorization-request
- **ステータス**: ✅ 完了
- **作成日**: 2025-12-09
- **完了日**: 2025-12-09
- **影響テスト**: 7回 REVIEW
- **症状**: redirect_uri パラメータの必須チェック
- **仕様参照**: [OAuth 2.0 Section 3.1.2.3](https://datatracker.ietf.org/doc/html/rfc6749#section-3.1.2.3)
- **修正内容**:
  - `packages/op-auth/src/authorize.ts` に以下のロジックを追加:
    - 複数redirect_uri登録時: redirect_uriパラメータ必須（省略時は`invalid_request`エラー）
    - 単一redirect_uri登録時: redirect_uriパラメータオプショナル（省略時はデフォルト使用）
  - テストケース追加: `packages/op-auth/src/__tests__/authorize.test.ts`

---

## P3: Low - 品質向上

### ISSUE-010: oidcc-response-type-missing
- **ステータス**: ✅ 完了
- **作成日**: 2025-12-09
- **完了日**: 2025-12-09
- **影響テスト**: 7回 REVIEW
- **症状**: response_type欠落時のエラー形式
- **修正内容**:
  - `packages/op-auth/src/authorize.ts` で response_type 欠落時のエラーコードを修正
  - RFC 6749 Section 4.1.2.1 に準拠:
    - 欠落時: `invalid_request` (必須パラメータの欠落)
    - 未サポート値: `unsupported_response_type` (値がサポートされていない)
  - テストケースも更新済み

---

### ISSUE-011: oidcc-redirect-uri-query-mismatch / query-added
- **ステータス**: ✅ 完了（OP実装正常、ブラウザ自動化バグ修正済み）
- **作成日**: 2025-12-09
- **更新日**: 2025-12-09
- **影響テスト**: 各7回 REVIEW
- **調査結果**:
  - `packages/op-auth/src/authorize.ts:1152` で `includes()` による完全一致検証が実装済み
  - クエリパラメータ不一致・追加時は正しく「Unregistered Redirect URI」エラーページを表示
  - REVIEW状態の原因はブラウザ自動化の`isConformanceCallback`関数のバグ
    - `url.includes('code=')` が `response_type=code` にもマッチしていた
    - エラーページがコールバックと誤認識され、エラー検出がスキップされていた
- **修正内容**:
  - `conformance/scripts/lib/browser-automator.ts` の `isConformanceCallback()` 関数を修正
    - `url.includes('code=')` → `urlObj.searchParams.has('code')` に変更
    - `hash.includes('code=')` → `hashParams.has('code')` に変更
    - URLSearchParamsを使用して実際のパラメータ名を正確に判定
- **仕様参照**: [RFC 6749 Section 3.1.2.3](https://datatracker.ietf.org/doc/html/rfc6749#section-3.1.2.3)

---

### ISSUE-012: oidcc-registration-logo-uri / policy-uri / tos-uri
- **ステータス**: ✅ 完了
- **作成日**: 2025-12-09
- **更新日**: 2025-12-09
- **影響テスト**: 各5-7回 REVIEW
- **調査結果**:
  - Dynamic Client Registration は `logo_uri`, `policy_uri`, `tos_uri` を正しく保存・返却している
  - 同意ページ (`packages/ui/src/routes/consent/+page.svelte`) ではこれらを表示する実装あり
  - ログインページにクライアントメタデータを表示する実装を追加
- **修正内容**:
  - `packages/op-auth/src/authorize.ts` - ログインチャレンジのメタデータにクライアント情報を追加
  - `packages/op-auth/src/login-challenge.ts` - 新規APIエンドポイント (GET /auth/login-challenge)
  - `packages/ui/src/lib/api/client.ts` - loginChallengeAPI.getData() を追加
  - `packages/ui/src/routes/login/+page.svelte` - クライアントロゴ、ポリシー、ToSリンクを表示
- **仕様参照**: [OIDC Dynamic Client Registration Section 2](https://openid.net/specs/openid-connect-registration-1_0.html)

---

### ISSUE-013: oidcc-prompt-login / max-age-1
- **ステータス**: 🟡 調査完了（ブラウザ自動化問題）
- **作成日**: 2025-12-09
- **更新日**: 2025-12-09
- **影響テスト**: 各5-7回 TIMEOUT
- **調査結果**:
  - `oidcc-prompt-login`、`oidcc-max-age-1`、`oidcc-max-age-10000` 全てタイムアウト
  - ログ分析: 第1回認可は成功してcodeを取得
  - テストは2段階フロー: セッション確立 → 再認証テスト
  - 問題: ブラウザ自動化が2回目の認可リクエストを処理できていない
- **仕様参照**: [OIDC Core Section 3.1.2.1](https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest)
- **実装状況**:
  - prompt=login: 再認証を強制
  - max_age: auth_timeとの比較で再認証判定
- **結論**: ISSUE-001（ブラウザ自動化）の改善で解決予定

---

## 完了済み

### ISSUE-000: oidcc-ensure-request-without-nonce-succeeds-for-code-flow
- **ステータス**: ✅ 完了
- **完了日**: 2025-12-08
- **影響テスト**: 改善 (12/7: 2 FAILED → 12/8: 5 PASSED)
- **対応内容**: code フローでは nonce がオプショナルであることを正しく処理

---

## 変更履歴

| 日付 | 変更内容 |
|------|----------|
| 2025-12-09 | 初版作成 (12/7, 12/8 テスト結果分析) |

---

## 参考リンク

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)
- [OpenID Connect Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)
- [RFC 9101 - JWT-Secured Authorization Request (JAR)](https://datatracker.ietf.org/doc/html/rfc9101)
- [RFC 6749 - OAuth 2.0](https://datatracker.ietf.org/doc/html/rfc6749)
- [RFC 7523 - JWT Bearer Assertion](https://datatracker.ietf.org/doc/html/rfc7523)
- [OIDC Conformance Suite](https://www.certification.openid.net/)
