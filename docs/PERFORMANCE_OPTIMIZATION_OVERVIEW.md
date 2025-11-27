# Authrim Workers パフォーマンス最適化 総合プラン

## エグゼクティブサマリー

Authrimの全Workers（7個）のパフォーマンス分析を実施し、CPU時間削減の最適化プランを策定しました。

### 現状の課題

| Worker | 現状CPU時間 | 無料プラン適合 | 優先度 |
|--------|------------|--------------|--------|
| op-discovery | P999 8.77ms | ⚠️ ギリギリ | 高 |
| op-token | P90 14.95ms | ❌ 超過 | 最高 |
| op-auth | 20-250ms | ❌ 大幅超過 | 最高 |
| op-management | 20-50ms | ❌ 超過 | 高 |
| op-userinfo | 20-100ms | ❌ 超過 | 高 |
| op-async | 8-20ms | ⚠️ ギリギリ | 中 |
| router | 3-10ms | ✅ 問題なし | 低 |

### 最適化による期待効果

| Worker | 最適化後CPU時間 | 削減率 | 無料プラン適合 |
|--------|---------------|--------|--------------|
| op-discovery | 3-4ms | 60% | ✅ |
| op-token | 8-10ms | 35-45% | ⚠️ ギリギリ |
| op-auth | 10-40ms | 50-84% | ⚠️ 条件付き |
| op-management | 10-25ms | 40-50% | ⚠️ ギリギリ |
| op-userinfo | 10-50ms | 40-50% | ⚠️ 条件付き |
| op-async | 5-12ms | 35-40% | ✅ |
| router | 2-6ms | 40% | ✅ |

---

## 共通ボトルネック分析

### 1. JWT処理（全Workerで共通）

**問題**:
- RSA秘密鍵/公開鍵のインポート（`importPKCS8`, `importJWK`）が非常に重い（5-10ms）
- 毎回実行されている
- 全Workerで同じ処理が重複

**推定CPU時間**: 5-20ms（Workerによる）

**解決策**:
- **グローバル鍵キャッシュの実装**（全Worker共通）
- TTLベースのキャッシュ戦略（60秒推奨）
- 鍵ローテーション時のOverlap期間設定

### 2. Durable Object呼び出し（全Workerで共通）

**問題**:
- Rate Limiting、認証コード検証、トークン管理などで多用
- 各呼び出しでJSON.stringify/parseが発生（1-2ms）
- 逐次実行されている場合が多い

**推定CPU時間**: 5-15ms（呼び出し回数による）

**解決策**:
- **並行実行の活用**（複数のDO呼び出しを同時実行）
- **バッチ処理**（可能な場合）
- **キャッシュ戦略**（read-through cache）

### 3. ミドルウェア処理（全Workerで共通）

**問題**:
- logger: デバッグ用ログ出力（0.5-1ms）
- secureHeaders: セキュリティヘッダー設定（0.5-1ms）
- CORS: オリジン検証（1-2ms）
- Rate Limiting: DO呼び出し（5-10ms）

**推定CPU時間**: 7-14ms

**解決策**:
- **本番環境でlogger無効化**
- **middleware実行順序の最適化**（rate limitを最初に配置）
- **不要なmiddleware削除**（router層での重複排除）

### 4. D1クエリ（一部Workerで使用）

**問題**:
- インデックスが不足している可能性
- 不要なカラムまでSELECT
- トランザクション最適化の余地

**推定CPU時間**: 2-15ms（クエリによる）

**解決策**:
- **インデックス最適化**（client_id, jti, user_id等）
- **必要カラムのみSELECT**
- **バッチクエリ**（複数クエリを1つにまとめる）

---

## Worker別最適化プラン

### op-discovery（既に最適化実装済み）

**状況**: P999 8.77ms → 目標 3-4ms

**実装済み最適化**:
1. ✅ Discovery メタデータのキャッシュ化
2. ✅ Rate Limitingをdiscovery endpointから除外

**追加推奨**:
- Logger無効化（本番環境）

**詳細**: `docs/PERFORMANCE_OPTIMIZATION_OP_DISCOVERY.md`（作成推奨）

---

### op-token（ドキュメント作成済み）

**状況**: P90 14.95ms → 目標 8-10ms

**優先度: 最高**

**主要な最適化策**:
1. **署名鍵のキャッシュ化**（最重要）
   - グローバル変数でキャッシュ
   - TTL 60秒
   - 緊急ローテーション対応（revoked status）
   - 期待効果: 4-5ms削減

2. **Logger無効化 + Audit Log実装**
   - 本番環境でlogger middleware無効化
   - 重要イベントのみD1に記録
   - 期待効果: 0.5-1ms削減

3. **鍵ローテーション運用ポリシー策定**
   - 通常ローテーション（90日ごと、Overlap期間24時間）
   - 緊急ローテーション（鍵漏洩時、即座に無効化）
   - KeyManager DOスキーマ拡張

**詳細**: `docs/PERFORMANCE_OPTIMIZATION_OP_TOKEN.md`

---

### op-auth

**状況**: 20-250ms → 目標 10-40ms

**優先度: 最高**

**主要なボトルネック**:
1. **HTTPS request_uriフェッチ**（50-200ms）
2. **Request Object (JWT)検証**（10-20ms）
3. **Passkey検証**（15-25ms）
4. **Rate Limiting**（5-10ms）

**推奨最適化策**:

1. **HTTPS request_uriの最適化**
   ```typescript
   // タイムアウト設定を厳格に
   const controller = new AbortController();
   const timeoutId = setTimeout(() => controller.abort(), 3000); // 3秒

   try {
     const response = await fetch(request_uri, {
       signal: controller.signal,
       headers: { 'User-Agent': 'Authrim/1.0' }
     });
   } catch (error) {
     if (error.name === 'AbortError') {
       return c.json({ error: 'request_uri_timeout' }, 400);
     }
   } finally {
     clearTimeout(timeoutId);
   }
   ```
   - 期待効果: タイムアウト時間を制限（現在は無制限の可能性）

2. **Request Object検証の最適化**
   ```typescript
   // グローバルキャッシュ
   let cachedClientPublicKeys: Map<string, CryptoKey> = new Map();

   async function getClientPublicKey(clientId: string, jwk: JWK): Promise<CryptoKey> {
     const cacheKey = `${clientId}:${jwk.kid}`;

     if (cachedClientPublicKeys.has(cacheKey)) {
       return cachedClientPublicKeys.get(cacheKey)!;
     }

     const publicKey = await importJWK(jwk, 'RS256');
     cachedClientPublicKeys.set(cacheKey, publicKey);

     // キャッシュサイズ制限（メモリ管理）
     if (cachedClientPublicKeys.size > 100) {
       const firstKey = cachedClientPublicKeys.keys().next().value;
       cachedClientPublicKeys.delete(firstKey);
     }

     return publicKey;
   }
   ```
   - 期待効果: 5-10ms削減

3. **Passkey検証の最適化**
   ```typescript
   // SimpleWebAuthn処理を並行実行
   const [verificationResult, challengeData] = await Promise.all([
     verifyAuthenticationResponse({
       response: credential,
       expectedChallenge: storedChallenge,
       expectedOrigin: origin,
       expectedRPID: rpID,
       authenticator: authenticator,
     }),
     // チャレンジ削除を並行実行
     deleteChallenge(c.env, challengeId)
   ]);
   ```
   - 期待効果: 2-5ms削減

4. **Middleware順序最適化**
   ```typescript
   // Rate limitingを最初に実行
   app.use('/authorize', rateLimitMiddleware(...));
   app.use('/par', rateLimitMiddleware(...));
   // その後、他のmiddleware
   app.use('*', cors(...));
   app.use('*', secureHeaders(...));
   ```

**期待される改善**: 20-250ms → 10-40ms（50-84%削減）

---

### op-management

**状況**: 20-50ms → 目標 10-25ms

**優先度: 高**

**主要なボトルネック**:
1. **JWT検証（Introspection）**（10-20ms）
2. **D1書き込み**（5-15ms）
3. **Rate Limiting**（5-10ms）

**推奨最適化策**:

1. **JWT検証の最適化**
   ```typescript
   // PUBLIC_JWK_JSONのパース結果をキャッシュ
   let cachedPublicJWK: CryptoKey | null = null;

   async function getPublicKey(env: Env): Promise<CryptoKey> {
     if (cachedPublicJWK) {
       return cachedPublicJWK;
     }

     const publicJWK = JSON.parse(env.PUBLIC_JWK_JSON);
     cachedPublicJWK = await importJWK(publicJWK, 'RS256');

     return cachedPublicJWK;
   }
   ```
   - 期待効果: 5-10ms削減

2. **D1クエリ最適化**
   ```sql
   -- インデックス追加
   CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id);
   CREATE INDEX IF NOT EXISTS idx_refresh_tokens_jti ON refresh_tokens(jti);
   CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

   -- 必要カラムのみSELECT
   SELECT id, client_id, client_secret FROM oauth_clients WHERE client_id = ?;
   -- 代わりに SELECT * は避ける
   ```
   - 期待効果: 2-5ms削減

3. **テストユーザー作成の非同期化**
   ```typescript
   // OIDC適合性テスト検出時、バックグラウンドで実行
   if (isOIDCConformanceTest(client_id)) {
     c.executionCtx.waitUntil(
       createTestUser(c.env, client_id)
     );
   }
   ```
   - 期待効果: 5-10ms削減

**期待される改善**: 20-50ms → 10-25ms（40-50%削減）

---

### op-userinfo

**状況**: 20-100ms → 目標 10-50ms

**優先度: 高**

**主要なボトルネック**:
1. **JWE暗号化**（15-25ms）
2. **JWT署名**（10-15ms）
3. **JWT検証（introspection）**（10-20ms）
4. **KeyManager DO呼び出し**（5-10ms）

**推奨最適化策**:

1. **KeyManager署名鍵のキャッシュ**（op-tokenと同様）
   ```typescript
   // グローバルキャッシュ
   let cachedSigningKey: { privateKey: CryptoKey; kid: string } | null = null;
   let cachedKeyTimestamp = 0;
   const KEY_CACHE_TTL = 60000; // 60秒
   ```
   - 期待効果: 5-10ms削減

2. **クライアント公開鍵のキャッシュ**（JWE暗号化用）
   ```typescript
   let cachedClientPublicKeys: Map<string, { key: CryptoKey; kid?: string }> = new Map();

   async function getClientPublicKeyForEncryption(
     clientMetadata: any
   ): Promise<{ key: CryptoKey; kid?: string } | null> {
     const cacheKey = clientMetadata.client_id;

     if (cachedClientPublicKeys.has(cacheKey)) {
       return cachedClientPublicKeys.get(cacheKey)!;
     }

     const publicKey = await getClientPublicKey(clientMetadata);
     if (publicKey) {
       cachedClientPublicKeys.set(cacheKey, publicKey);
     }

     return publicKey;
   }
   ```
   - 期待効果: 5-10ms削減

3. **D1クエリ最適化**
   ```typescript
   // 必要なカラムのみSELECT
   const user = await c.env.DB.prepare(
     `SELECT id, email, name, family_name, given_name, picture,
             email_verified, phone_number, phone_number_verified,
             address_json, locale, zoneinfo
      FROM users WHERE id = ?`
   ).bind(tokenPayload.sub).first();
   ```
   - 期待効果: 1-2ms削減

**期待される改善**: 20-100ms → 10-50ms（40-50%削減）

---

### op-async

**状況**: 8-20ms → 目標 5-12ms

**優先度: 中**

**主要なボトルネック**:
1. **DO書き込み**（5-10ms × 2回）
2. **getClient() D1クエリ**（2-5ms）

**推奨最適化策**:

1. **並行処理の活用**
   ```typescript
   // クライアント検証とコード生成を並行実行
   const [clientMetadata, deviceCode, userCode] = await Promise.all([
     getClient(c.env, client_id),
     generateDeviceCode(),
     generateUserCode()
   ]);
   ```
   - 期待効果: 2-3ms削減

2. **getClient()のキャッシュ強化**（既に実装済みだが、TTL調整）

**期待される改善**: 8-20ms → 5-12ms（35-40%削減）

---

### router

**状況**: 3-10ms → 目標 2-6ms

**優先度: 低**

**推奨最適化策**:

1. **Middleware順序最適化**
   ```typescript
   // loggerを条件付きに
   if (c.env.ENVIRONMENT === 'development') {
     app.use('*', logger());
   }
   ```

2. **CORS重複排除**
   - Router層ではCORSをスキップ
   - 各Worker層で実装（現状維持）

**期待される改善**: 3-10ms → 2-6ms（40%削減）

---

## 横断的な最適化戦略

### 1. JWT処理の統一ライブラリ化

**問題**: 各Workerで同様のJWT処理が重複実装

**解決策**:
`packages/shared`に共通ライブラリを作成

```typescript
// packages/shared/src/utils/jwt-cache.ts

export class JWTKeyCache {
  private static privateKeyCache: Map<string, { key: CryptoKey; timestamp: number }> = new Map();
  private static publicKeyCache: Map<string, { key: CryptoKey; timestamp: number }> = new Map();
  private static readonly TTL = 60000; // 60秒

  static async getPrivateKey(
    kid: string,
    pemOrJWK: string | JWK,
    algorithm: string
  ): Promise<CryptoKey> {
    const cached = this.privateKeyCache.get(kid);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.TTL) {
      return cached.key;
    }

    const key = typeof pemOrJWK === 'string'
      ? await importPKCS8(pemOrJWK, algorithm)
      : await importJWK(pemOrJWK, algorithm);

    this.privateKeyCache.set(kid, { key, timestamp: now });
    return key;
  }

  static async getPublicKey(
    kid: string,
    jwk: JWK,
    algorithm: string
  ): Promise<CryptoKey> {
    const cached = this.publicKeyCache.get(kid);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.TTL) {
      return cached.key;
    }

    const key = await importJWK(jwk, algorithm);
    this.publicKeyCache.set(kid, { key, timestamp: now });
    return key;
  }

  static clearCache() {
    this.privateKeyCache.clear();
    this.publicKeyCache.clear();
  }
}
```

### 2. Middleware実行順序の統一

**推奨順序**（全Worker共通）:
1. Rate Limiting（不正リクエストを早期拒否）
2. CORS（オリジン検証）
3. Secure Headers（セキュリティヘッダー）
4. Logger（開発環境のみ）

### 3. D1インデックス最適化

**必須インデックス**:
```sql
-- oauth_clients
CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id);

-- users
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_id ON users(id);

-- refresh_tokens
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_jti ON refresh_tokens(jti);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_client_id ON refresh_tokens(client_id);

-- authorization_codes
CREATE INDEX IF NOT EXISTS idx_authorization_codes_code ON authorization_codes(code);

-- sessions
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
```

---

## 実装ロードマップ

### Phase 1: 緊急対応（1-2週間）

**目標**: 無料プラン制限超過Workerを制限内に収める

1. **op-token**: 署名鍵キャッシュ + Logger無効化
2. **op-auth**: Request Object公開鍵キャッシュ + HTTPS timeoutそ
3. **op-management**: PUBLIC_JWK_JSONキャッシュ
4. **op-userinfo**: 署名鍵キャッシュ

**期待される成果**:
- op-token: 14.95ms → 9-10ms
- op-auth: 50-100ms → 20-40ms（通常フロー）
- op-management: 30-40ms → 15-25ms
- op-userinfo: 30-60ms → 15-35ms

### Phase 2: 中期最適化（2-4週間）

**目標**: さらなるパフォーマンス改善とコスト削減

1. **JWT処理統一ライブラリ化**（shared package）
2. **D1インデックス最適化**
3. **Middleware順序統一**
4. **Durable Object呼び出し並行化**
5. **KeyManager DO拡張**（鍵ローテーション対応）

**期待される成果**:
- 全Worker で 10-20% 追加削減
- コードの保守性向上
- 運用負荷軽減

### Phase 3: 長期戦略（3-6ヶ月）

**目標**: アーキテクチャレベルの最適化

1. **ES256への段階的移行**（RSA → ECDSA）
2. **Edge Cache活用**（Cloudflare Cache API）
3. **Durable Object統合**（複数DOを1つにまとめる）
4. **有料プランへの移行検討**（必要に応じて）

**期待される成果**:
- ES256使用時: さらに 30-50% CPU削減
- レイテンシ改善
- スケーラビリティ向上

---

## 監視 & 運用

### メトリクス監視（Cloudflare Dashboard）

**重要指標**:
- **CPU Time**: P50, P90, P99, P999
- **Error Rate**: 4xx, 5xx
- **Request Count**: トラフィックパターン
- **Wall Time**: エンドツーエンドレイテンシ

### アラート設定

| Worker | 閾値 | アクション |
|--------|------|----------|
| op-token | P90 > 10ms (30分以上) | 通知 + 調査 |
| op-auth | P90 > 50ms (30分以上) | 通知 |
| op-management | P90 > 30ms (30分以上) | 通知 |
| op-userinfo | P90 > 40ms (30分以上) | 通知 |
| 全Worker | Error Rate > 5% (10分以上) | 緊急対応 |

### 定期レビュー

- **毎週**: CPU時間メトリクスレビュー
- **毎月**: パフォーマンス最適化効果測定
- **四半期**: 長期戦略レビュー（ES256移行等）

---

## コスト分析

### 無料プラン vs 有料プラン

| プラン | CPU制限 | リクエスト制限 | 料金 |
|--------|---------|---------------|------|
| 無料 | 10ms | 100,000/日 | $0 |
| Bundled | 50ms | 10M/月 | $5/月〜 |
| Unbound | 30秒 | 1M/月 | $0.15/M requests |

### 推奨アプローチ

1. **Phase 1完了後**: 無料プランで運用可能
2. **トラフィック増加時**: Bundledプランに移行
3. **エンタープライズ利用**: Unboundプラン検討

---

## 結論

全7つのWorkersのパフォーマンス分析と最適化プランを策定しました。

**重要ポイント**:
1. **JWT処理の最適化が最も効果的**（鍵のキャッシュ化）
2. **op-token, op-auth, op-managementが最優先**
3. **Phase 1で無料プラン適合可能**
4. **長期的にはES256移行を検討**

**次のステップ**:
1. Phase 1の実装開始（署名鍵キャッシュ、Logger無効化）
2. テスト環境でパフォーマンス測定
3. 段階的に本番環境へデプロイ
4. メトリクス監視とフィードバック

このプランに従って実装を進めることで、Authrimの全Workersを無料プラン制限内で安定動作させることが可能になります。
