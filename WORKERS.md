# Authrim Worker分割アーキテクチャ

このドキュメントは、Authrimの新しいWorker分割アーキテクチャについて説明します。

## 📦 Monorepo構造

```
authrim/
├── packages/
│   ├── shared/              # 共通ライブラリ
│   │   ├── src/
│   │   │   ├── utils/       # JWT, crypto, validation etc.
│   │   │   ├── types/       # TypeScript型定義
│   │   │   ├── middleware/  # レート制限など
│   │   │   ├── storage/     # KV抽象化レイヤー
│   │   │   ├── durable-objects/ # KeyManager
│   │   │   └── constants.ts
│   │   └── package.json
│   │
│   ├── op-discovery/        # Discovery & JWKS Worker
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── discovery.ts
│   │   │   └── jwks.ts
│   │   ├── wrangler.toml
│   │   └── package.json
│   │
│   ├── op-auth/             # Authorization & PAR Worker
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── authorize.ts
│   │   │   └── par.ts
│   │   ├── wrangler.toml
│   │   └── package.json
│   │
│   ├── op-token/            # Token Endpoint Worker
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── token.ts
│   │   ├── wrangler.toml
│   │   └── package.json
│   │
│   ├── op-userinfo/         # UserInfo Endpoint Worker
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── userinfo.ts
│   │   ├── wrangler.toml
│   │   └── package.json
│   │
│   └── op-management/       # Management Endpoints Worker
│       ├── src/
│       │   ├── index.ts
│       │   ├── register.ts  # Dynamic Client Registration
│       │   ├── introspect.ts # Token Introspection
│       │   └── revoke.ts    # Token Revocation
│       ├── wrangler.toml
│       └── package.json
│
├── pnpm-workspace.yaml     # Monorepo設定
├── turbo.json              # Turborepo設定
└── package.json            # ルートpackage.json
```

## 🎯 Worker分割の目的

### ファイル容量の最適化
各Workerが独立してバンドル → 不要な依存関係を排除
- **Before**: 単一Worker 229KB, 7,061行
- **After**: 5つの独立Worker (各100-200KB程度)

### メモリ使用量の削減
- 各リクエストで必要なコードのみロード
- 128MBメモリ制限の圧力が減少

### デプロイの柔軟性
- エンドポイント単位でのデプロイ・ロールバック可能
- 影響範囲の局所化

### スケーラビリティ
- エンドポイント別にスケール可能
- 高負荷エンドポイント（/token）を独立スケール

## 📊 Worker一覧

| Worker | エンドポイント | 責務 | サイズ予測 |
|--------|---------------|------|-----------|
| **op-discovery** | `/.well-known/openid-configuration`<br>`/.well-known/jwks.json` | 設定情報公開<br>公開鍵公開<br>(CDNキャッシュ推奨) | ~50-70KB |
| **op-auth** | `GET/POST /authorize`<br>`POST /as/par` | 認証リクエスト処理<br>PKCE検証<br>Consent UI (Phase 5) | ~150-200KB |
| **op-token** | `POST /token` | トークン発行<br>code交換<br>refresh_token<br>client認証 | ~250-300KB |
| **op-userinfo** | `GET/POST /userinfo` | ユーザークレーム返却<br>アクセストークン検証 | ~80-100KB |
| **op-management** | `POST /register`<br>`POST /introspect`<br>`POST /revoke` | クライアント管理<br>トークン検証<br>トークン無効化 | ~180-220KB |

## 🔧 ビルド & 開発

### セットアップ

```bash
# 依存関係のインストール
pnpm install

# 全Workerをビルド
pnpm run build

# 特定のWorkerをビルド
cd packages/op-discovery
pnpm run build
```

### 開発サーバー

```bash
# 全Workerを並列起動
pnpm run dev

# 特定のWorkerを起動
cd packages/op-auth
pnpm run dev
```

### デプロイ

```bash
# 全Workerをデプロイ
pnpm run deploy

# 特定のWorkerをデプロイ
cd packages/op-token
pnpm run deploy
```

## 🔗 Worker間連携

### 現在の実装: KV Namespace経由のデータ共有

各Workerは**独立して動作**し、KV Namespaceを通じて間接的にデータを共有しています:

```
op-auth (認可コード生成) → AUTH_CODES KV → op-token (コード検証)
op-management (クライアント登録) → CLIENTS KV → 全Worker (クライアント認証)
op-token (トークン発行) → REFRESH_TOKENS KV → op-token (リフレッシュ)
```

**この方法のメリット:**
- ✅ 各Workerが完全に独立してデプロイ・ロールバック可能
- ✅ 依存関係が少なくシンプル
- ✅ 現時点で十分なパフォーマンスと機能を実現

### Service Bindingsを現在使用していない理由

**技術的な制約ではなく、設計思想です:**

1. **YAGNI原則 (You Aren't Gonna Need It)**
   現在の要件ではKV Namespaceで十分に機能している

2. **TypeScript型の厳密性**
   未使用の機能は型定義に含めない方針（`packages/shared/src/types/env.ts`参照）

3. **段階的な実装アプローチ**
   必要になったときに追加する

**なお、`wrangler.toml`にはすでにService Bindingsの定義が存在します（準備済み）:**

```typescript
// wrangler.tomlの例（既に定義済み）
[[services]]
binding = "OP_TOKEN"
service = "authrim-op-token"

// コード内での使用（将来的に実装予定）
const response = await env.OP_TOKEN.fetch(request);
```

### 将来的なユースケース

Service Bindingsが有用になる場面:

1. **リアルタイムなトークン失効**
   op-managementがトークンを失効させたとき、op-userinfoに即座に通知

2. **KeyManager（Durable Object）の本格活用**
   キーローテーション機能を複数Workerから統一的に利用

3. **クライアント情報のキャッシング**
   op-managementでクライアント更新時、他Workerのキャッシュを無効化

## 📝 設定

各Workerの`wrangler.toml`で、以下を設定します:

1. **環境変数** (`[vars]`セクション)
   - `ISSUER_URL`
   - `TOKEN_EXPIRY`, `CODE_EXPIRY`など

2. **KV Namespaces** (`[[kv_namespaces]]`)
   - 各Workerが必要なKVのみバインド

3. **Durable Objects** (`[[durable_objects.bindings]]`)
   - KeyManagerへの参照

4. **Routes** (本番環境)
   - ドメインごとのルーティング設定

## 🚀 デプロイ戦略

### 段階的デプロイ
1. **op-discovery** → 最もシンプル、影響範囲小
2. **op-userinfo** → 依存関係少ない
3. **op-auth, op-token** → コア機能
4. **op-management** → 管理系

### ロールバック
Workerごとに独立してロールバックが可能。

### モニタリング
各Workerのメトリクスを個別に監視:
- リクエスト数
- エラー率
- レスポンスタイム
- メモリ使用量

## ⚠️ 注意事項

### KV Namespace IDの設定
各`wrangler.toml`の`id`と`preview_id`を実際の値に更新してください:

```toml
[[kv_namespaces]]
binding = "AUTH_CODES"
id = "your_actual_namespace_id"
preview_id = "your_preview_namespace_id"
```

### Durable Objectsの共有
KeyManagerは`op-discovery`に配置し、他のWorkerから参照します:

```toml
[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "authrim-op-discovery"
```

### 共通パッケージの変更
`packages/shared`を変更した場合、全Workerの再ビルドが必要です:

```bash
pnpm run build
```

## 📚 参考資料

- [Turborepo ドキュメント](https://turbo.build/repo/docs)
- [Cloudflare Workers ドキュメント](https://developers.cloudflare.com/workers/)
- [pnpm Workspaces](https://pnpm.io/workspaces)
