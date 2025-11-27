# Worker分割戦略 - Authrim

## 概要

Authrimの一部Workerが無料プラン（10ms CPU制限）を超過している問題に対して、Worker分割によるアプローチを検討します。

---

## 現状の課題

### CPU時間超過Worker

| Worker | 現状CPU時間 | 主なボトルネック |
|--------|------------|----------------|
| op-token | 14.95ms | JWT署名×3回 (6-9ms) + JWE暗号化 (15-25ms) |
| op-auth | 20-250ms | Request Object検証 (10-20ms) + Passkey検証 (15-25ms) + HTTPS fetch (50-200ms) |
| op-management | 20-50ms | JWT検証 (10-20ms) + D1書き込み (5-15ms) |
| op-userinfo | 20-100ms | JWT検証 (10-20ms) + JWE暗号化 (15-25ms) |

### sharedライブラリの問題

**現状**: 全てのWorkerが不要な依存関係まで含んでいる

```typescript
// packages/shared/src/index.ts
export * from './utils/jwt';      // jose (~80KB)
export * from './utils/jwe';      // jose依存
export * from './utils/passkey';  // @simplewebauthn (~120KB)
export * from './middleware/rate-limit';
// ... 全Worker が全てを読み込む
```

**影響**:
- op-discovery: 署名処理を使わないが、joseを含む（+80KB）
- router: 暗号化処理を使わないが、全依存関係を含む（+200KB）
- Cold start時間の増加

---

## 解決策の比較

### アプローチ1: sharedライブラリの分割（推奨）

**難易度**: 低
**実装期間**: 1-2日
**効果**: 中（バンドルサイズ10-15%削減）

```
packages/
├── shared-core/          # 全Workerで使用
│   ├── validation.ts
│   ├── errors.ts
│   └── types.ts
├── shared-crypto/        # 暗号化処理のみ
│   ├── jwt.ts           # jose依存
│   ├── jwe.ts
│   └── key-cache.ts
├── shared-auth/          # 認証処理のみ
│   ├── passkey.ts       # @simplewebauthn依存
│   └── webauthn.ts
└── shared-middleware/    # ミドルウェア
    ├── rate-limit.ts
    └── cors.ts
```

**各Workerでの使用**:

```typescript
// op-discovery: coreのみ
import { validateClientId } from '@authrim/shared-core';
// jose, @simplewebauthn は含まれない

// op-token: core + crypto
import { validateClientId } from '@authrim/shared-core';
import { signJWT, encryptJWE } from '@authrim/shared-crypto';
// @simplewebauthn は含まれない

// op-auth: core + auth + crypto
import { validateClientId } from '@authrim/shared-core';
import { verifyPasskey } from '@authrim/shared-auth';
import { verifyJWT } from '@authrim/shared-crypto';
```

**期待される効果**:
- op-discovery: 200KB削減 → Cold start改善
- op-token: 120KB削減
- 全Worker: 平均15%バンドルサイズ削減

---

### アプローチ2: crypto-service Workerの作成

**難易度**: 中
**実装期間**: 1週間
**効果**: 高（CPU時間30-50%削減、ただしレイテンシ増加）

#### アーキテクチャ

```
┌─────────────┐
│ op-token    │─┐
└─────────────┘ │
┌─────────────┐ │
│ op-auth     │─┤
└─────────────┘ │      ┌────────────────────┐
┌─────────────┐ │      │ crypto-service     │
│ op-management│─┼─────>│                    │
└─────────────┘ │      │ ┌────────────────┐ │
┌─────────────┐ │      │ │ JWT Engine     │ │
│ op-userinfo │─┘      │ │ • sign()       │ │
└─────────────┘        │ │ • verify()     │ │
                       │ │ • keyCache     │ │
                       │ └────────────────┘ │
                       │ ┌────────────────┐ │
                       │ │ JWE Engine     │ │
                       │ │ • encrypt()    │ │
                       │ │ • decrypt()    │ │
                       │ └────────────────┘ │
                       └────────────────────┘
```

#### 実装案

##### crypto-service Worker

```typescript
// packages/crypto-service/src/index.ts

import { Hono } from 'hono';
import type { Env } from '@authrim/shared-core';
import { JWTEngine } from './jwt-engine';
import { JWEEngine } from './jwe-engine';

const app = new Hono<{ Bindings: Env }>();

// JWT署名
app.post('/jwt/sign', async (c) => {
  const { payload, kid, expiresIn } = await c.req.json();

  const result = await JWTEngine.sign(c.env, {
    payload,
    kid,
    expiresIn,
  });

  return c.json(result);
});

// JWT検証
app.post('/jwt/verify', async (c) => {
  const { token, expectedIssuer, expectedAudience } = await c.req.json();

  const result = await JWTEngine.verify(c.env, {
    token,
    expectedIssuer,
    expectedAudience,
  });

  return c.json(result);
});

// JWE暗号化
app.post('/jwe/encrypt', async (c) => {
  const { payload, clientId, alg, enc } = await c.req.json();

  const result = await JWEEngine.encrypt(c.env, {
    payload,
    clientId,
    alg,
    enc,
  });

  return c.json(result);
});

export default app;
```

##### JWTEngine（鍵キャッシュ統合）

```typescript
// packages/crypto-service/src/jwt-engine.ts

import { importPKCS8, SignJWT, jwtVerify, importJWK } from 'jose';

// グローバルキャッシュ（全リクエストで共有）
class KeyCache {
  private static signingKeys = new Map<string, { key: CryptoKey; timestamp: number }>();
  private static verifyingKeys = new Map<string, { key: CryptoKey; timestamp: number }>();
  private static readonly TTL = 60000; // 60秒

  static async getSigningKey(
    env: Env,
    kid: string
  ): Promise<CryptoKey> {
    const cached = this.signingKeys.get(kid);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.TTL) {
      return cached.key;
    }

    // KeyManager DOから取得
    const keyManagerId = env.KEY_MANAGER.idFromName('default-v3');
    const keyManager = env.KEY_MANAGER.get(keyManagerId);

    const response = await keyManager.fetch('http://dummy/internal/active-with-private', {
      headers: { Authorization: `Bearer ${env.KEY_MANAGER_SECRET}` },
    });

    const { privatePEM } = await response.json();
    const key = await importPKCS8(privatePEM, 'RS256');

    this.signingKeys.set(kid, { key, timestamp: now });
    return key;
  }

  static async getVerifyingKey(
    env: Env,
    kid: string
  ): Promise<CryptoKey> {
    const cached = this.verifyingKeys.get(kid);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.TTL) {
      return cached.key;
    }

    // KeyManager DOから公開鍵を取得
    const keyManagerId = env.KEY_MANAGER.idFromName('default-v3');
    const keyManager = env.KEY_MANAGER.get(keyManagerId);

    const response = await keyManager.fetch('http://internal/jwks');
    const { keys } = await response.json();

    const jwk = keys.find((k: any) => k.kid === kid);
    if (!jwk) throw new Error('Key not found');

    const key = await importJWK(jwk, 'RS256');

    this.verifyingKeys.set(kid, { key, timestamp: now });
    return key;
  }
}

export class JWTEngine {
  static async sign(
    env: Env,
    options: {
      payload: Record<string, any>;
      kid: string;
      expiresIn: number;
    }
  ): Promise<{ token: string; jti: string }> {
    const key = await KeyCache.getSigningKey(env, options.kid);
    const jti = crypto.randomUUID();

    const token = await new SignJWT(options.payload)
      .setProtectedHeader({ alg: 'RS256', kid: options.kid })
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + options.expiresIn)
      .sign(key);

    return { token, jti };
  }

  static async verify(
    env: Env,
    options: {
      token: string;
      expectedIssuer: string;
      expectedAudience: string;
    }
  ): Promise<{ payload: any; kid: string }> {
    // kidを取得
    const header = JSON.parse(
      atob(options.token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))
    );
    const kid = header.kid;

    const key = await KeyCache.getVerifyingKey(env, kid);

    const { payload } = await jwtVerify(options.token, key, {
      issuer: options.expectedIssuer,
      audience: options.expectedAudience,
    });

    return { payload, kid };
  }
}
```

##### 呼び出し側（op-token）

```typescript
// packages/op-token/src/token.ts

async function createAccessToken(
  c: Context<{ Bindings: Env }>,
  claims: any,
  expiresIn: number
): Promise<{ token: string; jti: string }> {
  // crypto-service Workerを呼び出し
  const response = await c.env.CRYPTO_SERVICE.fetch('http://crypto/jwt/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payload: claims,
      kid: 'default-v3', // または動的に取得
      expiresIn,
    }),
  });

  return await response.json();
}
```

#### パフォーマンス分析

**op-tokenの場合**:

| 処理 | 現状 | crypto-service分割後 |
|------|------|---------------------|
| Access Token署名 | 10ms (op-token内) | 2ms (呼び出し) + 8ms (crypto-service) |
| ID Token署名 | 10ms (op-token内) | 2ms (呼び出し) + 8ms (crypto-service) |
| Refresh Token署名 | 10ms (op-token内) | 2ms (呼び出し) + 8ms (crypto-service) |
| **合計** | **30ms** | **6ms (op-token)** + **24ms (crypto-service)** |

**重要な考慮事項**:
- op-token自体は10ms以下になる ✅
- crypto-serviceは24msだが、複数リクエストで並行処理可能
- Service Binding呼び出しのオーバーヘッド: 約1-2ms/回

#### メリット

1. **CPU時間の分散**: 各Workerが10ms制限内に収まる
2. **キャッシュの集中管理**: 署名鍵を1箇所で管理
3. **バンドルサイズの削減**: joseライブラリを1つのWorkerのみに含める
4. **スケーラビリティ**: 暗号化処理だけを独立してスケール

#### デメリット

1. **レイテンシの増加**: Service Binding呼び出し（1-2ms × 回数）
2. **複雑性の増加**:
   - エラーハンドリングが複雑化
   - トレーシング・監視が困難
   - デバッグが難しい
3. **運用コスト**: 管理するWorkerが増える
4. **トランザクションの困難さ**: Worker間でトランザクションが難しい

---

### アプローチ3: auth-helper Workerの作成

**難易度**: 中
**実装期間**: 1週間
**効果**: 中（op-authのCPU時間30-40%削減）

#### アーキテクチャ

```
┌─────────────┐        ┌────────────────────┐
│  op-auth    │───────>│ auth-helper        │
│             │Service │                    │
│             │Binding │ ┌────────────────┐ │
│             │<───────│ │ Passkey Engine │ │
└─────────────┘        │ │ • verify()     │ │
                       │ └────────────────┘ │
                       │ ┌────────────────┐ │
                       │ │ Request Object │ │
                       │ │ • parse()      │ │
                       │ │ • verify()     │ │
                       │ └────────────────┘ │
                       └────────────────────┘
```

#### 実装案

```typescript
// packages/auth-helper/src/index.ts

import { Hono } from 'hono';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';

const app = new Hono<{ Bindings: Env }>();

// Passkey検証
app.post('/passkey/verify', async (c) => {
  const { credential, expectedChallenge, origin, rpID, authenticator } = await c.req.json();

  const verification = await verifyAuthenticationResponse({
    response: credential,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    authenticator,
  });

  return c.json(verification);
});

// Request Object検証
app.post('/request-object/verify', async (c) => {
  const { requestObject, clientMetadata } = await c.req.json();

  // JWT検証ロジック
  const result = await verifyRequestObject(requestObject, clientMetadata);

  return c.json(result);
});

export default app;
```

---

## 推奨される実装ロードマップ

### Phase 1: sharedライブラリの分割（即座に実装）

**期間**: 1-2日
**優先度**: 最高

**実施内容**:
1. shared-core、shared-crypto、shared-authに分割
2. 各Workerで必要なパッケージのみをimport
3. バンドルサイズを測定

**期待される効果**:
- バンドルサイズ: 10-15%削減
- Cold start: 5-10%改善
- CPU時間: 1-2ms削減（バンドル解析時間の削減）

### Phase 2: 鍵キャッシュの実装（op-token, op-userinfo）

**期間**: 2-3日
**優先度**: 高

**実施内容**:
1. op-tokenに署名鍵キャッシュを実装
2. op-userinfoに署名鍵キャッシュを実装
3. パフォーマンステスト

**期待される効果**:
- op-token: 14.95ms → 9-10ms
- op-userinfo: 20-60ms → 12-35ms

### Phase 3: パフォーマンス測定 & 判断

**期間**: 1週間
**優先度**: 高

**実施内容**:
1. Phase 1-2の効果を本番環境で測定
2. 各Workerが10ms制限内に収まるか確認
3. Worker分割の必要性を判断

**判断基準**:
- ✅ 全Workerが10ms以内 → Worker分割不要
- ⚠️ 一部Workerが10-15ms → crypto-service検討
- ❌ 複数Workerが15ms超過 → crypto-service実装

### Phase 4: crypto-service Workerの実装（条件付き）

**期間**: 1-2週間
**優先度**: 中（Phase 3の結果次第）

**実施内容**:
1. crypto-service Workerの実装
2. Service Bindingsの設定
3. op-token, op-auth, op-management, op-userinfoの改修
4. パフォーマンステスト
5. 段階的なロールアウト

**期待される効果**:
- 全Workerが10ms制限内に収まる
- ただし、エンドツーエンドのレイテンシは+2-5ms

---

## パフォーマンス比較（総合）

### シナリオ1: op-token（Authorization Code Grant）

| アプローチ | op-token CPU | crypto-service CPU | 総レイテンシ |
|-----------|-------------|-------------------|------------|
| 現状 | 14.95ms | - | 14.95ms |
| Phase 1-2 | 9-10ms | - | 9-10ms |
| crypto-service | 4-6ms | 20-24ms | 9-10ms (+1-2ms) |

### シナリオ2: op-auth（Passkey認証）

| アプローチ | op-auth CPU | auth-helper CPU | 総レイテンシ |
|-----------|------------|----------------|------------|
| 現状 | 35-60ms | - | 35-60ms |
| Phase 1-2 | 25-45ms | - | 25-45ms |
| auth-helper | 10-20ms | 20-30ms | 25-45ms (+2-5ms) |

---

## 結論と推奨事項

### 推奨アプローチ

**1. 即座に実施: sharedライブラリの分割**
- リスク: 低
- 効果: 中
- コスト: 低

**2. 次に実施: 鍵キャッシュの実装**
- リスク: 低
- 効果: 高
- コスト: 低

**3. 条件付き実施: crypto-service Worker**
- 条件: Phase 1-2で不十分な場合のみ
- リスク: 中
- 効果: 高
- コスト: 中

### 判断基準

**crypto-service Workerを実装すべきケース**:
1. Phase 1-2実施後も、op-tokenが12ms以上
2. トラフィックが増加し、有料プラン移行を検討している
3. マイクロサービスアーキテクチャへの移行を計画している
4. 暗号化処理のスケーリングを独立して行いたい

**crypto-service Workerを実装すべきでないケース**:
1. Phase 1-2で全Workerが10ms以内に収まった
2. エンドツーエンドのレイテンシを最小化したい
3. シンプルなアーキテクチャを維持したい
4. 運用コストを最小化したい

### 次のステップ

1. **Phase 1を即座に開始**: sharedライブラリの分割
2. **Phase 2を並行実施**: 鍵キャッシュの実装
3. **1週間後に判断**: crypto-service Workerの必要性を評価
4. **必要に応じてPhase 4実施**: crypto-service Workerの実装

---

## 付録: Service Bindings vs Durable Objects

### Service Bindings（推奨）

**メリット**:
- 低レイテンシ（<1ms）
- 簡単な実装
- Worker間の直接通信

**デメリット**:
- ステートレス（状態を持てない）

### Durable Objects

**メリット**:
- ステートフル（キャッシュを持てる）
- トランザクション保証

**デメリット**:
- やや高いレイテンシ（1-3ms）
- 複雑な実装

### 推奨

crypto-serviceには**Service Bindings**を使用:
- キャッシュはWorkerメモリで管理
- ステートレスな設計
- 低レイテンシを優先
