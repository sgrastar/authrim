# op-token Worker パフォーマンス最適化ガイド

## 目的

op-token WorkerのCPU時間を削減し、Cloudflare Workers無料プラン（10ms制限）で安定動作させる。

**現状**: P90 = 14.95ms（無料プラン制限超過）
**目標**: P90 ≤ 10ms（無料プラン適合）
**stretch goal**: P90 ≤ 8ms

---

## パフォーマンス分析結果

### 特定されたボトルネック

| ボトルネック | 推定CPU時間 | 優先度 | 対応策 |
|------------|------------|--------|--------|
| RSA秘密鍵のインポート（毎回） | 5-7ms | 最高 | キャッシュ化 |
| 複数のDurable Object呼び出し | 3-5ms | 中 | 統合・最適化 |
| JWT作成処理（署名×3回） | 4-8ms | 中 | キャッシュ活用 |
| ID Token JWE暗号化（オプション） | 2-3ms | 低 | 必要時のみ |
| Rate Limiting Middleware | 2-3ms | 中 | 必須（維持） |
| 複数のミドルウェア | 1-2ms | 中 | logger無効化 |

**合計推定CPU時間**: 17-28ms

### 処理フロー（Authorization Code Grant）

```
1. リクエスト受信 & パース (1ms)
2. Rate Limiting チェック (2-3ms) - DO呼び出し
3. クライアント認証 (1ms)
4. 署名鍵取得 (5-7ms) ← 最大のボトルネック
   - KeyManager DOへのフェッチ
   - JSON.parse
   - importPKCS8（RSA秘密鍵インポート）
5. Authorization Code消費 (2ms) - DO呼び出し
6. JWT作成 (4-8ms)
   - Access Token署名 (2ms)
   - at_hash計算 (1ms)
   - ID Token署名 (2ms)
   - Refresh Token署名 (2ms)
7. Refresh Token登録 (2ms) - DO呼び出し
8. レスポンス返却 (0.5ms)
```

---

## 最適化戦略

### 優先度: 最高（必須実装）

#### 1. 署名鍵のキャッシュ化

**問題**:
- `getSigningKeyFromKeyManager`が毎回呼び出される
- RSA秘密鍵のインポート（`importPKCS8`）が非常に重い（5-7ms）
- すべてのgrant typeハンドラーで実行される

**解決策**:
グローバル変数でキャッシュし、TTLベースで更新

**実装**:

```typescript
// packages/op-token/src/token.ts

// グローバルキャッシュ変数
let cachedSigningKey: { privateKey: CryptoKey; kid: string } | null = null;
let cachedKeyTimestamp = 0;
const KEY_CACHE_TTL = 60000; // 60秒（1分）

async function getSigningKeyFromKeyManager(
  env: Env
): Promise<{ privateKey: CryptoKey; kid: string }> {
  const now = Date.now();

  // キャッシュ有効期限チェック
  if (cachedSigningKey && (now - cachedKeyTimestamp) < KEY_CACHE_TTL) {
    console.log('[KeyCache] Cache hit, using cached signing key');
    return cachedSigningKey;
  }

  console.log('[KeyCache] Cache miss or expired, fetching from KeyManager');

  // 既存の実装（KeyManager DOからの取得）
  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available');
  }

  if (!env.KEY_MANAGER_SECRET) {
    throw new Error('KEY_MANAGER_SECRET not configured');
  }

  const keyManagerId = env.KEY_MANAGER.idFromName('default-v3');
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  const authHeaders = {
    Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
  };

  const activeResponse = await keyManager.fetch('http://dummy/internal/active-with-private', {
    method: 'GET',
    headers: authHeaders,
  });

  let keyData: { kid: string; privatePEM: string; status?: string };

  if (activeResponse.ok) {
    keyData = await activeResponse.json() as { kid: string; privatePEM: string; status?: string };

    // 緊急ローテーション対応: revokedキーはキャッシュしない
    if (keyData.status === 'revoked') {
      throw new Error('Active key is revoked - emergency rotation in progress');
    }
  } else {
    // 鍵が存在しない場合は生成
    const rotateResponse = await keyManager.fetch('http://dummy/internal/rotate', {
      method: 'POST',
      headers: authHeaders,
    });

    if (!rotateResponse.ok) {
      throw new Error('Failed to generate signing key');
    }

    const rotateData = JSON.parse(await rotateResponse.text()) as {
      success: boolean;
      key: { kid: string; privatePEM: string };
    };
    keyData = rotateData.key;
  }

  // Import private key
  const privateKey = await importPKCS8(keyData.privatePEM, 'RS256');

  // キャッシュを更新
  cachedSigningKey = { privateKey, kid: keyData.kid };
  cachedKeyTimestamp = now;

  console.log('[KeyCache] Cached new signing key', { kid: keyData.kid });

  return cachedSigningKey;
}
```

**期待される改善**: 4-5ms削減（初回は遅いが、2回目以降は高速）

**セキュリティ考慮事項**:

1. **Cloudflare Workers Isolateの特性**:
   - 複数のisolateが並行して動作する
   - 各isolateが独立したグローバル変数を持つ
   - 鍵ローテーション時に一時的に古い鍵で署名する可能性がある

2. **対策1: Overlap期間の活用**:
   - KeyManager DO側で、鍵ローテーション時に古い鍵を24時間JWKSに含める
   - これにより、古い鍵で署名されたトークンも検証可能
   - Google、Auth0、Oktaなど主要OPが採用する標準的な手法

3. **対策2: TTLの短縮**:
   - TTLを60秒（1分）に設定
   - 最大1分の遅延で新しい鍵に切り替わる
   - CPU削減効果と同期速度のバランスを取る

4. **緊急ローテーション時の対応**:
   - 鍵漏洩時など緊急時は、古い鍵を即座に無効化する必要がある
   - KeyManager DOでkeyのstatusを`revoked`に設定
   - Worker側はstatusをチェックし、`revoked`の場合はキャッシュを使わず即座に再フェッチ

#### 2. 鍵ローテーション運用ポリシー

**通常ローテーション（定期）**:
- 頻度: 90日ごと（推奨）
- 手順:
  1. 新しい鍵を生成しアクティブ化
  2. 古い鍵を`overlap`ステータスに変更
  3. 古い鍵を24時間JWKSに含める
  4. 24時間後に古い鍵を削除
- Worker側の動作:
  - キャッシュTTL（60秒）内は古い鍵を使用する可能性あり
  - Overlapにより、古い鍵で署名されたトークンも検証可能

**緊急ローテーション（鍵漏洩時）**:
- 手順:
  1. 漏洩した鍵を即座に`revoked`ステータスに変更
  2. JWKSから即座に削除
  3. 新しい鍵を生成しアクティブ化
- Worker側の動作:
  - `revoked`ステータスの鍵はキャッシュを無視
  - 即座に新しい鍵を取得
  - 最大60秒間は古い鍵で署名される可能性あり（TTLによる）

**KeyManager DO スキーマ拡張案**:

```typescript
interface KeyMetadata {
  kid: string;
  privatePEM: string;
  publicJWK: JWK;
  status: 'active' | 'overlap' | 'revoked';
  rotation_type: 'normal' | 'emergency';
  created_at: number;
  activated_at?: number;
  revoked_at?: number;
  expires_at?: number; // overlap期間の終了時刻
}
```

---

### 優先度: 高

#### 3. 本番環境でlogger middleware無効化

**問題**:
- `logger()`ミドルウェアが全リクエストでコンソールログを出力（1-2ms）
- 本番環境ではデバッグ情報は不要

**解決策**:
環境変数で制御し、本番環境では無効化

**実装**:

```typescript
// packages/op-token/src/index.ts

// 開発環境のみloggerを有効化
if (c.env.ENVIRONMENT === 'development') {
  app.use('*', logger());
}
```

**期待される改善**: 0.5-1ms削減

#### 4. Audit Logの実装（logger代替）

**重要**: `logger()`ミドルウェアを無効化しても、セキュリティ監査用のログは必須

**実装**:

```typescript
// packages/op-token/src/token.ts

/**
 * Token発行イベントを監査ログに記録
 * 非同期で実行し、レスポンス時間に影響を与えない
 */
async function logTokenIssuance(
  c: Context<{ Bindings: Env }>,
  data: {
    success: boolean;
    clientId: string;
    userId?: string;
    grantType: string;
    error?: string;
    errorDescription?: string;
  }
) {
  // executionCtx.waitUntilを使用して非同期実行
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await c.env.DB.prepare(
          `INSERT INTO token_events
           (timestamp, success, client_id, user_id, grant_type, error, error_description, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          Date.now(),
          data.success ? 1 : 0,
          data.clientId,
          data.userId || null,
          data.grantType,
          data.error || null,
          data.errorDescription || null,
          c.req.header('CF-Connecting-IP') || 'unknown'
        ).run();
      } catch (error) {
        console.error('Failed to write audit log:', error);
      }
    })()
  );
}
```

**使用例**:

```typescript
// 成功時
await logTokenIssuance(c, {
  success: true,
  clientId: client_id,
  userId: authCodeData.sub,
  grantType: 'authorization_code',
});

// 失敗時
await logTokenIssuance(c, {
  success: false,
  clientId: client_id,
  grantType: 'authorization_code',
  error: 'invalid_grant',
  errorDescription: 'Authorization code is invalid or expired',
});
```

**D1スキーマ**:

```sql
CREATE TABLE token_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  success INTEGER NOT NULL, -- 0 or 1
  client_id TEXT NOT NULL,
  user_id TEXT,
  grant_type TEXT NOT NULL,
  error TEXT,
  error_description TEXT,
  ip_address TEXT,
  INDEX idx_timestamp (timestamp),
  INDEX idx_client_id (client_id),
  INDEX idx_success (success)
);
```

---

### 優先度: 中

#### 5. Durable Object呼び出しの最適化

**現状**:
- Authorization Code Grant で複数回のDO呼び出し:
  - AUTH_CODE_STORE: `/code/consume`
  - REFRESH_TOKEN_ROTATOR: `/family`
  - AUTH_CODE_STORE: `/code/{code}/tokens`

**最適化案**:
- 必要に応じてDO呼び出しを統合
- ただし、現在の実装は安全性が高いため、CPU削減効果が限定的な場合は維持

**期待される改善**: 1-2ms削減（実装による）

---

### 優先度: 低（Phase 2）

#### 6. ES256への段階的移行

**背景**:
- RSA-256: 署名・検証が遅い（CPU集約的）
- ES256 (ECDSA): 署名・検証が60-80%高速

**移行戦略**:

1. **Phase 1**: RS256でキャッシュ最適化を実施
2. **Phase 2**: パフォーマンスが不十分な場合、ES256を追加
3. **Phase 3**: 両方のアルゴリズムをサポート（overlap期間）
4. **Phase 4**: クライアントごとにalgを選択可能に
5. **Phase 5**: 既存RS256トークンが失効後、RS256を段階的に縮小

**KeyManager DO拡張**:
- RS256とES256の両方の鍵を管理
- クライアントメタデータで`preferred_signing_alg`を指定可能

**期待される改善**: 3-5ms削減（ES256使用時）

---

## 実装計画

### Step 1: 署名鍵のキャッシュ化（最優先）

- [ ] `getSigningKeyFromKeyManager`にキャッシュロジックを追加
- [ ] TTL 60秒で設定
- [ ] revokedステータスのチェックを追加
- [ ] テスト実装:
  - [ ] キャッシュヒット時の動作確認
  - [ ] TTL期限切れ時の再取得確認
  - [ ] 緊急ローテーション時の動作確認

### Step 2: Logger無効化 + Audit Log実装

- [ ] 本番環境でlogger middleware無効化
- [ ] `logTokenIssuance`関数の実装
- [ ] D1テーブル作成（`token_events`）
- [ ] 全grant typeハンドラーにaudit log追加
- [ ] テスト実装:
  - [ ] 成功時のログ記録確認
  - [ ] 失敗時のログ記録確認

### Step 3: KeyManager DO拡張（鍵ローテーション対応）

- [ ] KeyMetadataスキーマ拡張（status, rotation_type追加）
- [ ] 通常ローテーションAPI実装
- [ ] 緊急ローテーションAPI実装
- [ ] Overlap期間管理機能
- [ ] テスト実装:
  - [ ] 通常ローテーション動作確認
  - [ ] 緊急ローテーション動作確認
  - [ ] Overlap期間の動作確認

### Step 4: テスト & デプロイ

- [ ] ローカル環境でパフォーマンステスト
- [ ] Staging環境でデプロイ & 検証
- [ ] 本番環境へのデプロイ
- [ ] Cloudflare Workersダッシュボードでメトリクス監視
- [ ] 24時間後にP90/P99を確認

---

## 期待される成果

| 項目 | 現状 | 最適化後 | 改善率 |
|------|------|----------|--------|
| P90 CPU時間 | 14.95ms | 8-10ms | 約35-45% |
| P99 CPU時間 | 推定18-20ms | 10-12ms | 約40-50% |
| 無料プラン適合 | ❌ | ⚠️ ギリギリ | - |

**注意**:
- op-tokenは処理が複雑なため、無料プランでギリギリの可能性
- 長期的にはES256への移行を検討
- または有料プラン（Bundled: 50ms制限、月$5〜）への移行

---

## セキュリティ考慮事項まとめ

### ✅ 安全な実装

1. **署名鍵のキャッシュ**:
   - Overlap期間により古い鍵で署名されたトークンも検証可能
   - TTL短縮により同期遅延を最小化
   - 緊急ローテーション時の即時無効化対応

2. **Authorization Code消費**:
   - Durable Objectによるatomic処理
   - replay攻撃検出機能実装済み
   - race conditionのリスクなし

3. **Audit Log**:
   - 全token発行イベントを記録
   - コンプライアンス対応
   - セキュリティインシデント調査に活用

### ⚠️ 注意が必要な点

1. **鍵ローテーション**:
   - 通常ローテーションと緊急ローテーションを区別
   - 緊急時の対応手順を文書化
   - 定期的な訓練・テストの実施

2. **Rate Limiting**:
   - token endpointのRate limitingは維持必須
   - ブルートフォース攻撃対策
   - DDoS対策

---

## 監視 & アラート

### メトリクス監視

- **CPU Time**: P50, P90, P99, P999
- **Error Rate**: 4xx, 5xx エラー率
- **Latency**: Wall Time（ネットワーク含む）
- **Key Cache Hit Rate**: キャッシュヒット率

### アラート設定

- P90 > 10ms が30分以上継続
- Error Rate > 5% が10分以上継続
- Key Cache Hit Rate < 80%

---

## 参考資料

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-2_0-security-profile.html)
- [Cloudflare Workers Performance Best Practices](https://developers.cloudflare.com/workers/platform/limits/)
- [RFC 7517: JSON Web Key (JWK)](https://datatracker.ietf.org/doc/html/rfc7517)
- [RFC 7518: JSON Web Algorithms (JWA)](https://datatracker.ietf.org/doc/html/rfc7518)
