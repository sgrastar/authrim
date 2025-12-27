# API Versioning Strategy

Authrimは**Stripe方式の日付ベースAPIバージョニング**を採用しています。

## 概要

```
Authrim-Version: 2024-12-01
```

- **対象**: 管理API（`/api/admin/*`, `/register`など）
- **除外**: OIDCエンドポイント（`/authorize`, `/token`, `/userinfo`など）- 仕様準拠のため除外
- **フォーマット**: `YYYY-MM-DD`形式のみ

## アーキテクチャ

### Middleware実行順序

```
api-version → deprecation-headers → sdk-compatibility → auth / policy / handler
```

**理由**: バージョン確定前に警告を出す事故を防ぐ。SDK警告がversionに依存できる。

### ヘッダー仕様

| ヘッダー | 方向 | 用途 |
|---------|------|------|
| `Authrim-Version` | リクエスト | クライアントが希望するAPIバージョン |
| `X-Authrim-Version` | レスポンス | 実際に適用されたAPIバージョン |
| `X-Authrim-Version-Warning` | レスポンス | 不明バージョン時の警告 |

### Unknown Version時の挙動モード

| モード | HTTP | 用途 |
|--------|------|------|
| `fallback` | 200 | デフォルトバージョンにフォールバック（**推奨**） |
| `warn` | 200 | 要求バージョンを使用、警告ヘッダー付与 |
| `reject` | 400 | RFC 9457 Problem Details形式でエラー応答 |

**デフォルト**: `fallback`（Stripeも初期はwarn→rejectに移行）

## セキュリティ設計

### Fail-Open Architecture

このmiddlewareは**フェイルオープン**設計をデフォルトとしています：

- KVが利用不可の場合 → 環境変数/デフォルト値を使用
- バージョン解析失敗 → デフォルトバージョンにフォールバック
- 設定が無効 → 安全なデフォルトで継続

**理由（OIDC/OAuth2コンテキスト）**:
- OIDCは認証インフラ - 可用性が最重要
- バージョンチェック失敗が認証フローをブロックすべきではない
- 無効なリクエストを拒否するより、デフォルトバージョンで処理する方が良い

**トレードオフ**: 厳密なバージョン制御より可用性を優先。
厳密な環境では `API_UNKNOWN_VERSION_MODE=reject` を設定してください。

### パス正規化

OIDCエンドポイント判定時に以下の攻撃を防御：

```typescript
// 防御対象
/authorize/         → /authorize (末尾スラッシュ除去)
/authorize//admin   → /authorize/admin (連続スラッシュ圧縮)
/authorize%2F       → /authorize/ (URLデコード)
/authorize%252F     → /authorize/ (二重エンコード対応)
/authorize/../admin → /admin (パストラバーサル解決)
/ａｕｔｈｏｒｉｚｅ → /authorize (Unicode正規化)
```

### セキュリティ対策一覧

本実装には以下の11項目のセキュリティ対策が施されています：

| # | カテゴリ | 対策 | 説明 |
|---|---------|------|------|
| 1 | DoS防止 | Integer Overflow対策 | `MAX_TTL_SECONDS=86400`でキャッシュTTL上限を24時間に制限 |
| 2 | DoS防止 | パス長制限 | `MAX_PATH_LENGTH=2048`で正規化の前・中・後に複数回チェック |
| 3 | Race Condition | TOCTOU対策 | `Date.now()`を一度キャプチャして再利用 |
| 4 | Memory Leak | 期限切れエントリ削除 | キャッシュevict時に期限切れエントリを先にクリーンアップ |
| 5 | DoS防止 | JSONサイズ制限 | `MAX_DEPRECATION_JSON_SIZE=10000`でKVからの読み込みを制限 |
| 6 | Timing Attack | O(1)ルックアップ | `supportedVersionsSet`(Set)で定数時間のバージョン検証 |
| 7 | ReDoS防止 | 正規表現の安全化 | SDK_VERSION_PATTERNに有界量指定子を使用 |
| 8 | Invalid Input | NaN汚染防止 | `formatSunsetDate`が無効な日付でnullを返却 |
| 9 | Type Safety | 型強制防止 | `compareSemver`が無効なバージョンでnullを返却 |
| 10 | Header Injection | CRLF除去順序 | 長さ制限→制御文字削除の順序で処理 |
| 11 | Defense-in-Depth | 最終長さチェック | `normalizePath`で正規化後にも長さを再検証 |

### その他のセキュリティ対策

| 対策 | 説明 |
|------|------|
| 本番環境での情報隠蔽 | `supported_versions`を非公開 |
| エラーログのサニタイズ | スタックトレース非出力 |
| キャッシュサイズ制限 | LRUキャッシュ（MAX_CACHE_SIZE）でDoS防止 |
| KV障害時の短TTL | エラー時30秒キャッシュ（通常3分） |
| ランタイム型検証 | KVから読み込んだデータの型をガード関数で検証 |

## 設定

### 環境変数

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `API_VERSIONING_ENABLED` | 有効化フラグ | `true` |
| `API_DEFAULT_VERSION` | デフォルトAPIバージョン | `2024-12-01` |
| `API_UNKNOWN_VERSION_MODE` | 不明バージョン時の挙動 | `fallback` |
| `API_SUPPORTED_VERSIONS` | サポートバージョン（カンマ区切り） | `2024-12-01` |
| `API_CURRENT_STABLE_VERSION` | 現在の安定バージョン | `2024-12-01` |

### KV設定（動的オーバーライド）

キー: `api_versions:config`

```json
{
  "defaultVersion": "2024-12-01",
  "currentStableVersion": "2024-12-01",
  "supportedVersions": ["2024-12-01", "2024-06-01"],
  "unknownVersionMode": "fallback",
  "oidcEndpoints": ["/authorize", "/token", "/userinfo", "/.well-known/"]
}
```

**優先順位**: キャッシュ → KV → 環境変数 → コードデフォルト

## OIDCエンドポイント除外

以下のエンドポイントはAPIバージョニングの対象外です（OIDC仕様準拠）：

| エンドポイント | マッチング方式 |
|---------------|---------------|
| `/authorize` | 完全一致 |
| `/token` | 完全一致 |
| `/userinfo` | 完全一致 |
| `/introspect` | 完全一致 |
| `/revoke` | 完全一致 |
| `/jwks` | 完全一致 |
| `/par` | 完全一致 |
| `/device_authorization` | 完全一致 |
| `/bc-authorize` | 完全一致 |
| `/ciba` | 完全一致 |
| `/logout` | 完全一致 |
| `/session` | 完全一致 |
| `/.well-known/` | プレフィックス一致 |

## Deprecation通知

### 出力ヘッダー（RFC 8594準拠）

```http
Deprecation: true
Sunset: Sat, 01 Jun 2025 00:00:00 GMT
Link: <https://docs.authrim.com/migration/v2>; rel="deprecation"
```

### KV設定

```json
// deprecation:version:2024-06-01
{
  "sunsetDate": "2025-06-01T00:00:00Z",
  "migrationGuideUrl": "https://docs.authrim.com/migration/2024-12",
  "replacement": "2024-12-01",
  "enabled": true
}
```

## SDK互換性チェック

### リクエストヘッダー

```
Authrim-SDK-Version: authrim-js/1.0.0
```

### レスポンスヘッダー

```
X-Authrim-SDK-Warning: SDK version 0.9.0 is outdated. Please upgrade to 1.0.0.
X-Authrim-SDK-Recommended: 1.0.0
```

### 互換性ステータス

| ステータス | 説明 |
|-----------|------|
| `compatible` | 推奨バージョン以上 |
| `outdated` | 最小バージョン以上、推奨未満 |
| `deprecated` | 非推奨バージョン |
| `unsupported` | 最小バージョン未満 |

## 関連ファイル

| ファイル | 説明 |
|---------|------|
| `packages/ar-lib-core/src/middleware/api-version.ts` | APIバージョンmiddleware |
| `packages/ar-lib-core/src/middleware/deprecation-headers.ts` | Deprecationヘッダーmiddleware |
| `packages/ar-lib-core/src/middleware/sdk-compatibility.ts` | SDK互換性middleware |
| `packages/ar-lib-core/src/types/api-version.ts` | 型定義・正規化関数 |
| `packages/ar-lib-core/src/utils/api-version-config.ts` | 設定管理 |

## テスト

```bash
# APIバージョンmiddlewareテスト
pnpm --filter @authrim/ar-lib-core exec vitest run src/middleware/__tests__/api-version.test.ts

# SDK互換性テスト
pnpm --filter @authrim/ar-lib-core exec vitest run src/middleware/__tests__/sdk-compatibility.test.ts
```

## 関連ドキュメント

- [Rollback Procedures](../operations/rollback.md) - ロールバック手順
- [Worker Version Management](../operations/version-management.md) - 旧バージョン管理（非推奨）
