# ロギングシステム仕様書

Authrimの構造化ロギングシステムの仕様、使い方、設定方法についてまとめたドキュメントです。

## 概要

Authrimでは、すべてのWorkerパッケージで統一された構造化ロギングを使用しています。

### 特徴

- **JSON構造化ログ**: ログ解析ツール（Cloudflare Logs、Datadog等）での検索・フィルタリングが容易
- **テナント分離**: マルチテナント環境で`tenantId`による自動フィルタリング
- **リクエスト相関**: `requestId`による分散トレーシング対応
- **プライバシー保護**: `hashUserId`オプションによるユーザーID匿名化
- **レベルフィルタリング**: 環境別のログレベル制御

---

## 基本的な使い方

### 1. リクエストハンドラー内での使用

```typescript
import { getLogger } from '@authrim/ar-lib-core';

export async function myHandler(c: Context<{ Bindings: Env }>) {
  // コンテキストからロガーを取得
  const log = getLogger(c);

  // 基本的なログ出力
  log.info('Processing request');
  log.warn('Something might be wrong');
  log.error('An error occurred');
  log.debug('Debug information');

  // 追加コンテキスト付きログ
  log.info('User action completed', {
    action: 'login',
    clientId: 'my-client',
    durationMs: 150,
  });

  return c.json({ success: true });
}
```

### 2. モジュール名付きロガー

```typescript
const log = getLogger(c).module('AUTH');

log.info('Session created');
// 出力: {"module":"AUTH","message":"Session created",...}
```

### 3. スタンドアロンロガー（非リクエストコンテキスト）

```typescript
import { createLogger } from '@authrim/ar-lib-core';

// Durable Object内やスケジュールジョブで使用
const log = createLogger({ tenantId: 'default' }).module('SCHEDULER');

log.info('Job started');
```

---

## ログ出力形式

### JSON形式（デフォルト）

```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "level": "info",
  "tenantId": "default",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "module": "AUTH",
  "message": "User logged in",
  "userId": "user-123",
  "clientId": "my-app",
  "durationMs": 42
}
```

### Pretty形式（開発用）

```
10:30:45.123 INFO  [AUTH] User logged in (42ms)
```

---

## 設定方法

### 環境変数

| 変数名 | 説明 | デフォルト値 | 有効な値 |
|--------|------|-------------|---------|
| `LOG_LEVEL` | 最小ログレベル | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | 出力形式 | `json` | `json`, `pretty` |
| `LOG_HASH_USER_ID` | ユーザーID匿名化 | `false` | `true`, `false` |

### wrangler.toml での設定例

```toml
[vars]
LOG_LEVEL = "info"
LOG_FORMAT = "json"
LOG_HASH_USER_ID = "false"

# 開発環境
[env.dev.vars]
LOG_LEVEL = "debug"
LOG_FORMAT = "pretty"
```

### プログラムからの設定

```typescript
import { setLoggerConfig, initLoggerFromEnv } from '@authrim/ar-lib-core';

// 環境変数から初期化（推奨）
initLoggerFromEnv(env);

// 直接設定
setLoggerConfig({
  level: 'debug',
  format: 'pretty',
  hashUserId: true,
});
```

---

## ログレベル

| レベル | 値 | 用途 |
|--------|---|------|
| `debug` | 0 | 開発時のデバッグ情報、詳細なトレース |
| `info` | 1 | 通常の操作ログ、重要なイベント |
| `warn` | 2 | 警告（処理は継続するが注意が必要） |
| `error` | 3 | エラー（処理失敗、要対応） |

**フィルタリング**: 設定されたレベル以上のログのみ出力されます。
例: `LOG_LEVEL=warn` の場合、`warn`と`error`のみ出力

---

## LogContext フィールド

ログに含めることができる標準フィールド:

| フィールド | 型 | 説明 |
|-----------|---|------|
| `tenantId` | `string` | テナント識別子（自動設定） |
| `requestId` | `string` | リクエスト識別子（自動設定） |
| `userId` | `string` | ユーザー識別子 |
| `userIdHash` | `string` | ハッシュ化されたユーザーID |
| `clientId` | `string` | OAuthクライアント識別子 |
| `sessionId` | `string` | セッション識別子 |
| `module` | `string` | モジュール/コンポーネント名 |
| `action` | `string` | 実行中のアクション |
| `durationMs` | `number` | 処理時間（ミリ秒） |

カスタムフィールドも追加可能:
```typescript
log.info('Custom event', {
  customField: 'value',
  numericValue: 42,
});
```

---

## エラーログのベストプラクティス

### PII保護パターン

エラーオブジェクトには個人情報（PII）が含まれる可能性があるため、以下のパターンを推奨:

```typescript
// ❌ 避けるべき: エラーオブジェクト全体をログ
log.error('Operation failed', { action: 'process' }, error as Error);

// ✅ 推奨: エラータイプのみをログ
log.error('Operation failed', {
  action: 'process',
  errorType: error instanceof Error ? error.name : 'Unknown',
});
```

### 例外処理

```typescript
try {
  await riskyOperation();
} catch (error) {
  // PIIを含まないエラー（内部エラーなど）
  log.error('Database connection failed', {
    action: 'db_connect',
  }, error as Error);

  // PIIを含む可能性のあるエラー
  log.error('User authentication failed', {
    action: 'auth',
    errorType: error instanceof Error ? error.name : 'Unknown',
    // error.message は含めない
  });
}
```

---

## タイマー機能

処理時間の計測に便利な`startTimer`メソッド:

```typescript
const log = getLogger(c);
const endTimer = log.startTimer('Database query');

await database.query('...');

endTimer(); // ログ出力: "Database query completed" with durationMs
```

---

## 子ロガーの作成

追加コンテキストを持つ子ロガーを作成:

```typescript
const log = getLogger(c);

// モジュール名を追加
const authLog = log.module('AUTH');

// 追加フィールドを持つ子ロガー
const userLog = log.child({ userId: 'user-123' });
userLog.info('Action performed'); // userIdが自動的に含まれる
```

---

## ミドルウェア設定

### requestContextMiddleware

すべてのリクエストに自動的にロガーをセットアップ:

```typescript
import { requestContextMiddleware } from '@authrim/ar-lib-core';

const app = new Hono<{ Bindings: Env }>();

// すべてのルートにミドルウェアを適用
app.use('*', requestContextMiddleware());

// ハンドラー内でロガーが利用可能に
app.get('/api/example', (c) => {
  const log = getLogger(c);
  log.info('Handler executed');
  return c.json({ ok: true });
});
```

### オプション

```typescript
requestContextMiddleware({
  // テナント解決失敗時にエラーを返すか（デフォルト: true）
  requireTenant: true,
});
```

---

## マルチテナント対応

マルチテナントモードでは、`tenantId`が自動的にHostヘッダーから解決されます:

```typescript
// tenant1.example.com へのリクエスト
log.info('Request received');
// 出力: {"tenantId":"tenant1","message":"Request received",...}
```

### テナント別ログレベル設定

```typescript
setLoggerConfig({
  level: 'info',
  tenantOverrides: {
    'debug-tenant': { level: 'debug' },
    'quiet-tenant': { level: 'error' },
  },
});
```

---

## Cloudflare Workers での注意事項

### ログの永続化

Cloudflare Workersの`console.*`はCloudflare Dashboardの「Logs」で確認できますが、デフォルトでは永続化されません。永続化には以下を利用:

- **Logpush**: S3、R2、Datadog等への自動転送
- **Workers Analytics Engine**: カスタムメトリクス

### パフォーマンス

- ログ出力は同期的に実行されます
- 大量のログはCPU時間を消費するため、本番環境では`info`以上を推奨
- `debug`レベルは開発環境のみで使用

---

## 移行ガイド

### console.log からの移行

```typescript
// Before
console.log('[AUTH] User logged in:', userId);

// After
const log = getLogger(c).module('AUTH');
log.info('User logged in', { userId });
```

### 移行チェックリスト

1. `console.log/error/warn` を `log.info/error/warn` に置換
2. 文字列連結を構造化コンテキストに変更
3. エラーオブジェクトの取り扱いをPII保護パターンに
4. モジュール名を`.module()`で設定

---

## FAQ

### Q: ログが出力されない

A: `LOG_LEVEL`の設定を確認してください。`LOG_LEVEL=error`の場合、`info`や`warn`は出力されません。

### Q: 本番環境でdebugログを一時的に有効にしたい

A: `wrangler secret`でLOG_LEVELを変更するか、特定テナントのみ`tenantOverrides`で設定できます。

### Q: ログにユーザーIDを含めたくない

A: `LOG_HASH_USER_ID=true`を設定すると、`userId`がハッシュ化された`userIdHash`に置換されます。

### Q: Pretty形式で色が表示されない

A: ターミナルがANSIカラーコードをサポートしている必要があります。`wrangler dev`では通常サポートされています。

---

## 関連ファイル

| ファイル | 説明 |
|---------|------|
| `packages/ar-lib-core/src/utils/logger.ts` | ロガーのコア実装 |
| `packages/ar-lib-core/src/middleware/request-context.ts` | ミドルウェアと`getLogger` |
| `packages/ar-lib-core/src/index.ts` | エクスポート定義 |

---

## 更新履歴

- **2024-01**: 構造化ロガー実装、console.log移行完了
- 全228ファイルで統一されたロギングパターンを適用
- PII保護パターンの導入
