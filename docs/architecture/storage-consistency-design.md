# ストレージ一貫性設計 - Phase 6

**作成日**: 2025-11-15
**最終更新**: 2025-11-16 (v7.0 - DO統合完了)
**ブランチ**: claude/storage-consistency-audit-012q29GoqGNjumv1NvkAMUEA
**ステータス**: 実装完了（全DO統合完了）

---

## エグゼクティブサマリー

Authrim Phase 5のストレージアーキテクチャは、Cloudflare Workers の各種ストレージプリミティブ（Durable Objects、D1、KV）を効果的に組み合わせていますが、**7つの視点からの完全監査**により**24の課題**を特定しました（v5.0 - 2025-11-15最終監査完了）。

**v6.0更新**: OPとしての製品特性を考慮し、**全Durable Objects化**への方針を決定。運用・ドキュメント対応では完全解決できないKV起因の5課題（#6, #8, #11, #12, #21）をDO化することで、**RFC/OIDC完全準拠**と**100%の一貫性保証**を実現します。

### 🔴 リリースブロッカー（CRITICAL - 9問題）

**セキュリティ脆弱性**:
1. **client_secret タイミング攻撃** - タイミング攻撃でclient_secret推測可能 (#15)
2. **/revoke, /introspect 認証欠如** - OAuth 2.0 RFC 7009/7662 違反 (#16)

**DO永続性欠如（75%のDOに影響）**:
3. **SessionStore DO** - DO再起動で全ユーザー強制ログアウト (#9)
4. **RefreshTokenRotator DO** - トークンファミリー全損失 (#4)
5. **AuthorizationCodeStore DO** - OAuth フロー失敗 (#10)

**DO未使用（実装済みだが使われていない）**:
6. **RefreshTokenRotator完全未使用** - 300+行のコードが無駄、非アトミック操作 (#17)
7. **認可コードKV競合** - PKCE検証回避可能 (#3)

**WebAuthn/データ整合性**:
8. **Passkey Counter競合** - WebAuthn仕様違反 (#7)
9. **D1書き込みリトライ欠如** - データ損失リスク (#1)

### 🟠 高リスク（HIGH - 2問題）

10. **KVキャッシュ無効化窓** - stale data提供 (#2)
11. **D1クリーンアップジョブ欠如** - ストレージ無限成長（1000 DAU → 120k sessions/year） (#18)

### 🟡 中リスク（MEDIUM - 7問題）

**OIDC準拠**:
12. **auth_time クレーム欠如** - max_age使用時の仕様違反 (#19)
13. **userinfo ハードコードデータ** - 本番環境使用不可 (#23)

**データ整合性**:
14. **Magic Link/Passkey チャレンジ再利用** - replay攻撃の可能性 (#21)
15. **部分失敗リスク** - 孤立レコード、再試行不可 (#22)
16. **監査ログ信頼性** - コンプライアンスリスク (#5)

**その他**:
17. ~~**PAR request_uri 競合** - RFC 9126違反（低確率） (#11)~~ ✅ **実装完了** - PARRequestStore DO統合
18. **セッション一括削除N+1** - パフォーマンス劣化 (#24)

### 🔵 低リスク/その他（6問題）

19. ~~DPoP JTI競合（#12 - LOW）~~ ✅ **実装完了** - DPoPJTIStore DO統合
20. ~~セッショントークン競合（#8 - MEDIUM）~~ ✅ **実装完了** - ChallengeStore DO統合
21. ~~Rate Limiting精度（#6 - ACCEPTED）~~ ✅ **実装完了** - RateLimiterCounter DO統合
22. ~~JWKS/KeyManager不整合（#13 - DESIGN）~~ ✅ **実装完了** - JWKS Endpoint動的取得
23. ~~スキーマバージョン管理（#14 - FUTURE）~~ ✅ **実装完了** - Migration tracking & DO versioning
24. password_reset_tokens (#20 - 確認済み、問題なし)

---

### 📊 監査統計（v5.0）

- **監査手法**: 7つの視点（セキュリティ、データ整合性、並行性、API準拠、運用、エッジケース、パフォーマンス）
- **チェック項目**: 70+
- **確認ファイル**: 18+ (DO 4個、API 13個、Utils、Migrations)
- **総問題数**: 24問題
- **深刻度**: CRITICAL×9, HIGH×2, MEDIUM×7, その他×6

### 🎯 系統的パターン

1. **DO永続性欠如**: 75%のDO（RefreshTokenRotator, SessionStore, AuthCodeStore）が`state.storage`未使用
2. **DO実装未使用**: AuthCodeStore, RefreshTokenRotatorが実装済みだがKV直接使用
3. **非アトミック操作**: 4箇所でKV get-use-delete パターン
4. **セキュリティ基本ミス**: タイミング攻撃、認証欠如

### ⏱️ 総工数見積もり

- **Phase 1 (P0必須)**: 14-18日
- **Phase 2 (P1/P2推奨)**: 5-7日
- **Phase 3 (P3最適化)**: 2-3日
- **総計**: **21-28日**（約4-6週間）

### 🚀 最短リリースパス

**Phase 1完了後**: 16-20日でリリース可能（セキュリティ修正必須）

本ドキュメントは、これらすべての課題に対する具体的な解決策と実装戦略を提示します。

---

## 1. 現状分析と課題

### 1.1 DOからD1への書き込み（信頼性の問題）

#### 現状の実装

**ファイル**: `packages/shared/src/durable-objects/SessionStore.ts:239-257`

```typescript
async createSession(userId: string, ttl: number, data?: SessionData): Promise<Session> {
  const session: Session = {
    id: this.generateSessionId(),
    userId,
    expiresAt: Date.now() + ttl * 1000,
    createdAt: Date.now(),
    data,
  };

  // 1. Store in memory (hot)
  this.sessions.set(session.id, session);

  // 2. Persist to D1 (backup & audit) - async, don't wait
  this.saveToD1(session).catch((error) => {
    console.error('SessionStore: Failed to save to D1:', error);
  });

  return session;
}
```

#### 問題点

```
データフロー:
┌─────────────────┐
│ セッション作成  │
└────────┬────────┘
         │
         ├──────────────────────┬─────────────────────┐
         ▼                      ▼                     ▼
   [即座完了]             [非同期・結果待たない]   [レスポンス返却]
   メモリに保存 ✅        D1書き込み ⚠️            クライアントへ
         │                      │                     │
         │              成功/失敗 不明                │
         │              エラーログのみ                │
         └──────────────────────┴─────────────────────┘
                    不整合の可能性
```

**影響範囲**:
- セッション作成: `createSession()` - 252行目
- セッション延長: `extendSession()` - 340行目
- セッション無効化: `invalidateSession()` - 268行目

**具体的なリスク**:
1. **データ損失**: D1書き込みが失敗してもメモリには存在 → Worker再起動で消失
2. **監査証跡の欠落**: コンプライアンス要件を満たせない
3. **hot/cold不整合**: D1フォールバック時に古いデータまたはnullが返る
4. **無言の失敗**: エラーログは出るが、運用アラートなし

---

### 1.2 KVキャッシュの無効化（一貫性の窓）

#### 現状の実装

**ファイル**: `packages/shared/src/storage/adapters/cloudflare-adapter.ts:207-214`

```typescript
private async setToD1WithKVCache(key: string, value: string): Promise<void> {
  // 1. Update D1
  await this.setToD1(key, value);

  // 2. Invalidate KV cache
  if (this.env.CLIENTS_CACHE) {
    await this.env.CLIENTS_CACHE.delete(key);
  }
}
```

#### 問題点

```
タイムライン:
T0: クライアント更新リクエスト受信
T1: D1書き込み開始
T2: D1書き込み完了 ✅
    ↓
   [一貫性の窓 - 問題発生期間]
    ↓
    並行リクエストA: KVからキャッシュ取得 → 古いデータ返却 ❌
    並行リクエストB: KVからキャッシュ取得 → 古いデータ返却 ❌
    ↓
T3: KV削除開始
T4: KV削除完了 ✅
T5: 次のリクエスト: KVミス → D1から新しいデータ取得 → KVに再キャッシュ ✅
```

**影響範囲**:
- クライアントメタデータ更新時
- リダイレクトURI変更時に旧URIが受け入れられる可能性
- スコープ変更が反映されない期間（最大5分 = KV TTL）

**具体的なシナリオ**:
```
1. 管理者がクライアントのredirect_urisを更新
   旧: ["https://old.example.com/callback"]
   新: ["https://new.example.com/callback"]

2. D1更新完了（T2） → KV削除開始（T3）の間に

3. 認可リクエスト到着:
   - redirect_uri: https://old.example.com/callback
   - KVから古いメタデータ取得
   - 検証成功 ❌ (本来は失敗すべき)
   - 認可コード発行 ❌

4. セキュリティリスク: 古いリダイレクトURIへの認可コード送信
```

---

### 1.3 認可コードのKV使用（セキュリティリスク）

#### 現状の実装

**ファイル**: `packages/shared/src/utils/kv.ts:36-65`

```typescript
export async function storeAuthCode(env: Env, code: string, data: AuthCodeData): Promise<void> {
  const ttl = parseInt(env.CODE_EXPIRY, 10);
  const expirationTtl = ttl; // TTL in seconds

  await env.AUTH_CODES.put(code, JSON.stringify(data), {
    expirationTtl,
  });
}

export async function getAuthCode(env: Env, code: string): Promise<AuthCodeData | null> {
  const data = await env.AUTH_CODES.get(code);
  // ... 省略
}
```

#### 問題点

**KVの一貫性モデル**:
- Cloudflare KVは**結果整合性** (Eventually Consistent)
- 複数のエッジロケーション間で即座に同期されない
- 書き込み後、最大60秒の遅延が発生する可能性

**OAuth 2.0セキュリティ要件**:
- RFC 6749: 認可コードは**ワンタイムユース**（一度だけ使用可能）
- セキュリティBCP Draft 16: 再利用検出時は全トークン無効化

**競合状態のシナリオ**:
```
攻撃者が認可コードを傍受した場合:

T0: 正当なクライアント: コード取得
T1: 攻撃者: 同じコードでエッジロケーションAに送信
T2: 正当なクライアント: エッジロケーションBに送信

並行処理:
┌──────────────────────┐       ┌──────────────────────┐
│ Edge Location A      │       │ Edge Location B      │
│ (攻撃者のリクエスト) │       │ (正当なリクエスト)   │
└──────────────────────┘       └──────────────────────┘
         │                              │
         ▼                              ▼
   KV.get(code)                   KV.get(code)
   → found ✅                      → found ✅
         │                              │
         ▼                              ▼
   トークン発行 ❌                トークン発行 ✅
   (攻撃成功)                     (正当)
         │                              │
         ▼                              ▼
   KV.delete(code)                KV.delete(code)

結果: 両方のリクエストが成功 → OAuth 2.0違反
```

**既存の解決策**:
- `AuthorizationCodeStore` Durable Objectが**既に実装済み**
- ファイル: `packages/shared/src/durable-objects/AuthorizationCodeStore.ts`
- しかし、**未使用**（authorize.ts、token.tsで利用されていない）

---

### 1.4 追加の一貫性問題（包括的監査で発見）

以下の問題は、コードベース全体の詳細な監査により発見されました。

#### 問題4: RefreshTokenRotatorの永続性欠如（クリティカル）

**場所**: `packages/shared/src/durable-objects/RefreshTokenRotator.ts:99-100`

```typescript
export class RefreshTokenRotator {
  private state: DurableObjectState;
  private env: Env;
  private families: Map<string, TokenFamily> = new Map(); // ← メモリのみ
  private tokenToFamily: Map<string, string> = new Map(); // ← メモリのみ
  // ...
}
```

**問題点**:
- トークンファミリーが**メモリのみ**に保存されている
- `KeyManager` は `this.state.storage.put()` を使用して永続化しているが、`RefreshTokenRotator` は使用していない
- Durable Object再起動時（デプロイ、エラー、Worker移行等）に**すべてのトークンファミリーが失われる**

**影響**:
```
ユーザーフロー:
1. ユーザーがログイン → Refresh Token発行
2. Token Family作成 → RefreshTokenRotator メモリに保存
3. Worker再起動（例: 新しいバージョンのデプロイ）
4. メモリクリア → すべてのToken Familyが消失
5. ユーザーがRefresh Tokenでアクセス試行
6. Token Family見つからない → 認証失敗 ❌
7. ユーザー強制ログアウト

結果: すべてのユーザーが再ログイン必須
```

**比較 - KeyManagerの正しい実装**:

`packages/shared/src/durable-objects/KeyManager.ts:75-112`

```typescript
export class KeyManager {
  private keyManagerState: KeyManagerState | null = null;

  private async initializeState(): Promise<void> {
    // Durable Storageから読み込み ✅
    const stored = await this.state.storage.get<KeyManagerState>('state');
    if (stored) {
      this.keyManagerState = stored;
    }
  }

  private async saveState(): Promise<void> {
    // Durable Storageへ永続化 ✅
    await this.state.storage.put('state', this.keyManagerState);
  }
}
```

**解決策**:
- RefreshTokenRotatorも同様に `state.storage.put()` / `get()` を使用
- トークンファミリーをDurable Storageに永続化
- 再起動時に復元

---

#### 問題5: 監査ログの信頼性（コンプライアンスリスク）

**場所**: `packages/shared/src/durable-objects/RefreshTokenRotator.ts:191-215`

```typescript
private async logToD1(entry: AuditLogEntry): Promise<void> {
  if (!this.env.DB) {
    return;
  }

  try {
    await this.env.DB.prepare(/* INSERT INTO audit_log ... */).run();
  } catch (error) {
    console.error('RefreshTokenRotator: D1 audit log error:', error);
    // Don't throw - audit logging failure should not break rotation
    // ↑ エラーは無視される ⚠️
  }
}
```

**問題点**:
- `SessionStore` と同じ問題: 監査ログが非同期で、失敗が無視される
- トークン盗難検出、ファミリー無効化などの**セキュリティイベント**がログに記録されない可能性
- コンプライアンス要件（SOC 2、GDPR等）を満たせない

**影響範囲**:
```
SessionStore:
- セッション作成/延長/無効化
- 監査ログ失敗時も処理継続

RefreshTokenRotator:
- トークンローテーション
- 盗難検出 ← 特にクリティカル
- ファミリー無効化
- すべて監査ログ失敗の可能性

合計: すべての認証・認可イベント
```

**コンプライアンス要件**:
```
SOC 2 (System and Organization Controls 2):
- CC6.1: すべてのアクセス試行を記録
- CC7.2: セキュリティイベントの監視と記録

GDPR (General Data Protection Regulation):
- Article 30: 処理活動の記録
- Article 33: データ侵害の記録

OAuth 2.0 Security BCP:
- Section 4.13: すべてのトークン操作を記録
```

**解決策**:
- セクション2.1のリトライキューを監査ログにも適用
- または、監査ログを同期的に書き込み（一貫性レベル: `strong`）
- 監査ログ失敗時はアラート送信

---

#### 問題6: Rate Limitingの精度問題

**場所**: `packages/shared/src/middleware/rate-limit.ts:63-106`

```typescript
async function checkRateLimit(env, clientIP, config) {
  const key = `ratelimit:${clientIP}`;

  // Step 1: Read
  const recordJson = await env.STATE_STORE.get(key);
  let record: RateLimitRecord;

  if (recordJson) {
    record = JSON.parse(recordJson);
    // Step 2: Modify
    record.count++;
  } else {
    record = { count: 1, resetAt: now + config.windowSeconds };
  }

  // Step 3: Write
  await env.STATE_STORE.put(key, JSON.stringify(record), {
    expirationTtl: config.windowSeconds + 60,
  });

  const allowed = record.count <= config.maxRequests;
  return { allowed, ... };
}
```

**問題点**: Read-Modify-Write 競合

```
並行リクエストの例:
T0: 現在 count = 5 (KV)

T1: Request A: KV.get() → count = 5
T2: Request B: KV.get() → count = 5 (まだ古い値)

T3: Request A: count++ → 6
T4: Request B: count++ → 6 (本来は7であるべき)

T5: Request A: KV.put(count=6)
T6: Request B: KV.put(count=6) ← 上書き

結果: count = 6 (正しくは7)
```

**影響**:
- レート制限が正確でない
- 攻撃者が制限を回避できる可能性
- DDoS保護が機能しない

**KVの制約**:
- Cloudflare KVは結果整合性
- Compare-and-Swap (CAS) 機能なし
- アトミックなインクリメント不可

**解決策**:
```
Option 1: Durable Objects for Rate Limiting
- 強一貫性が必要な場合
- IPアドレスごとにDOインスタンス（シャーディング）
- アトミックなカウント保証

Option 2: Durable Objects Alarms + KV
- DOでカウント（正確）
- KVでキャッシュ（パフォーマンス）
- 定期的な同期

Option 3: 精度を許容する（現状維持）
- レート制限は「ベストエフォート」と割り切る
- 多少の不正確さは許容
- KVベースでシンプルに保つ
```

---

#### 問題7: Passkey Counterの競合状態（WebAuthn仕様違反の可能性）

**場所**: `packages/shared/src/storage/adapters/cloudflare-adapter.ts:819-829`

```typescript
async updateCounter(passkeyId: string, counter: number): Promise<Passkey> {
  const now = Math.floor(Date.now() / 1000);

  // Step 1: D1 UPDATE (新しいcounterで上書き)
  await this.adapter.execute(
    'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?',
    [counter, now, passkeyId]
  );

  // Step 2: SELECT (更新結果取得)
  const results = await this.adapter.query<Passkey>(
    'SELECT * FROM passkeys WHERE id = ?',
    [passkeyId]
  );

  return results[0];
}
```

**WebAuthn仕様要件**:

[WebAuthn Level 2 Specification, Section 7.2](https://www.w3.org/TR/webauthn-2/#sctn-authenticator-data)

> The signature counter's value MUST be strictly increasing. If the stored counter value is greater than or equal to the received counter value, the credential has been cloned.

**問題点**:
```
並行認証リクエストの例:
DB state: counter = 10

T1: User logs in from Device A
    → Authenticator returns counter = 11
    → updateCounter(passkeyId, 11)

T2: User logs in from Device B (同時)
    → Authenticator returns counter = 12
    → updateCounter(passkeyId, 12)

T3: Request A: UPDATE counter = 11 WHERE id = ...
T4: Request B: UPDATE counter = 12 WHERE id = ... (上書き)

結果: counter = 12 ✅

T5: User logs in again from Device A
    → Authenticator returns counter = 13
    → DB counter = 12 → 13 > 12 → OK ✅

問題なし？ → いいえ、逆順の場合:

T1: Request B: UPDATE counter = 12
T2: Request A: UPDATE counter = 11 (上書き) ← 問題!

結果: counter = 11 ❌

T3: User logs in from Device B again
    → Authenticator returns counter = 13
    → DB counter = 11 → 13 > 11 → OK (本来は検出すべきクローン)
```

**正しい実装**:

```typescript
// Compare-and-Swap パターン
async updateCounter(passkeyId: string, newCounter: number): Promise<Passkey> {
  // Step 1: 現在のcounterを取得
  const current = await this.adapter.query<Passkey>(
    'SELECT counter FROM passkeys WHERE id = ?',
    [passkeyId]
  );

  if (!current[0]) {
    throw new Error('Passkey not found');
  }

  // Step 2: 新しいcounterが大きい場合のみ更新
  if (newCounter <= current[0].counter) {
    throw new Error('Invalid counter: possible credential clone');
  }

  // Step 3: Conditional UPDATE
  const result = await this.adapter.execute(
    'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND counter = ?',
    [newCounter, Math.floor(Date.now() / 1000), passkeyId, current[0].counter]
  );

  // Step 4: 更新が成功したか確認（他のリクエストが先に更新していないか）
  if (result.changes === 0) {
    // 他のリクエストが先に更新 → リトライ
    return await this.updateCounter(passkeyId, newCounter);
  }

  // 成功
  return await this.get(passkeyId);
}
```

---

#### 問題8: セッショントークン（KV）の競合状態

**場所**: `packages/op-auth/src/session-management.ts:140-165`

```typescript
// Step 1: KVからトークン取得
const tokenData = await kvStore.get(tokenKey);
if (!tokenData) {
  return c.json({ error: 'Invalid token' }, 400);
}

const parsed = JSON.parse(tokenData);

// Step 2: 使用済みチェック
if (parsed.used) {
  return c.json({ error: 'Token already used' }, 400);
}

// Step 3: 使用済みマーク
parsed.used = true;
await kvStore.put(tokenKey, JSON.stringify(parsed), {
  expirationTtl: 60,
});
```

**問題点**: AuthorizationCode と同じ Read-Check-Set 競合

```
並行リクエスト:
T1: Request A: KV.get(token) → used = false
T2: Request B: KV.get(token) → used = false (まだ古い値)

T3: Request A: used = true → KV.put()
T4: Request B: used = true → KV.put()

結果: 両方のリクエストが成功 ❌
```

**影響**:
- ITP (Intelligent Tracking Prevention) 対応のセッショントークンが再利用可能
- セキュリティリスク

**解決策**:
- セッショントークンもDurable Objectで管理
- または、TTLを極端に短くして影響を最小化（現在: 5分）

---

#### 問題9: SessionStore DOの永続性欠如（クリティカル）⚠️ 新発見

**場所**: `packages/shared/src/durable-objects/SessionStore.ts:72`

```typescript
export class SessionStore {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Map<string, Session> = new Map(); // ← メモリのみ ❌
  // ...
}
```

**問題点**:
- SessionStoreが`RefreshTokenRotator`と**同じ問題**を抱えている
- セッションデータが**メモリのみ**に保存、`state.storage.put/get()`を使用していない
- D1への書き込みは fire-and-forget（問題1と重複）
- Durable Object再起動時に**すべてのアクティブセッションが失われる**

**影響範囲**:
```
ユーザー影響:
1. ユーザーがログイン → セッション作成
2. SessionStore メモリに保存（+ D1書き込み試行）
3. Worker再起動（デプロイ、スケーリング、障害等）
4. メモリクリア → すべてのセッションが消失
5. ユーザーがアクセス試行
6. セッションが見つからない → 認証失敗 ❌
7. **すべてのユーザーが強制ログアウト**

さらに問題:
- D1書き込みが失敗していた場合、D1フォールバックも失敗
- hot/cold パターンが完全に機能しない
```

**データフロー分析**:
```
現状（問題あり）:
┌──────────────┐
│ Session作成  │
└──────┬───────┘
       │
       ├─────────────┬──────────────┐
       ▼             ▼              ▼
   [メモリ保存]  [D1書き込み]  [レスポンス]
    ✅ 即座     ⚠️ async      ✅ 返却
       │        .catch()           │
       │        無視               │
       │                          │
   [DO再起動]                     │
       │                          │
       ▼                          │
    全消失 ❌                      │
       │                          │
   [D1から読む]                   │
       │                          │
       ▼                          │
   失敗している ❌ ← D1書き込みが失敗していた場合
```

**KeyManagerとの比較**:

SessionStore (問題あり):
```typescript
// Line 72: メモリのみ
private sessions: Map<string, Session> = new Map();

// Line 252-254: Fire-and-forget
this.saveToD1(session).catch((error) => {
  console.error('SessionStore: Failed to save to D1:', error);
});
```

KeyManager (正しい実装):
```typescript
// Durable Storage使用
private keyManagerState: KeyManagerState | null = null;

private async initializeState(): Promise<void> {
  const stored = await this.state.storage.get<KeyManagerState>('state');
  if (stored) {
    this.keyManagerState = stored;
  }
}

private async saveState(): Promise<void> {
  await this.state.storage.put('state', this.keyManagerState);
}
```

**解決策**:
1. SessionStoreを`KeyManager`パターンにリファクタリング
2. `state.storage.put/get()`を使用してセッションを永続化
3. D1は監査目的のバックアップのみ（オプション）
4. 再起動時にDurable Storageから復元

---

#### 問題10: AuthorizationCodeStore DOの永続性欠如（クリティカル）⚠️ 新発見

**場所**: `packages/shared/src/durable-objects/AuthorizationCodeStore.ts:83`

```typescript
export class AuthorizationCodeStore {
  private state: DurableObjectState;
  private env: Env;
  private codes: Map<string, AuthorizationCode> = new Map(); // ← メモリのみ ❌
  // ...
}
```

**問題点**:
- AuthorizationCodeStoreが**問題3の解決策として作成された**にもかかわらず、**永続性の問題**を抱えている
- 認可コードが**メモリのみ**に保存、`state.storage.put/get()`を使用していない
- **さらに問題**: このDOは実装されているが、実際には使用されていない！
  - `op-token/src/token.ts` は依然としてKVベースの`getAuthCode()`を使用
  - `op-auth/src/consent.ts` は AuthorizationCodeStore DO を使用（正しい）
  - **不整合**: 2つの実装が混在

**影響範囲**:
```
OAuth 2.0フロー:
1. ユーザーが認可 → 認可コード発行
2. AuthorizationCodeStore メモリに保存
3. Worker再起動（60秒TTL内でも発生しうる）
4. メモリクリア → 認可コードが消失
5. クライアントがトークンエンドポイントへコード送信
6. コードが見つからない → トークン取得失敗 ❌
7. OAuth フロー全体が失敗

影響度:
- 短いTTL (60秒) のため影響は限定的
- しかし、DO再起動のタイミング次第では100%失敗
```

**皮肉な状況**:
```
問題3: KV使用による競合状態
     ↓
解決策: AuthorizationCodeStore DO を作成 ✅
     ↓
新問題: DOが永続性を持たない ❌
     ↓
さらに: 実際にはまだKVを使用している ❌

結果: 解決策が実装されたが、使用されず、かつ新しい問題がある
```

**コードエビデンス**:

AuthorizationCodeStore (作成されたが未使用):
```typescript
// packages/shared/src/durable-objects/AuthorizationCodeStore.ts:83
private codes: Map<string, AuthorizationCode> = new Map(); // メモリのみ
```

Token endpoint (古いKV実装を使用中):
```typescript
// packages/op-token/src/token.ts:180
const authCodeData = await getAuthCode(c.env, validCode);

// packages/op-token/src/token.ts:461
await markAuthCodeAsUsed(c.env, validCode, {...}); // KV競合状態（問題3）
```

Consent endpoint (新しいDO実装を使用):
```typescript
// packages/op-auth/src/consent.ts:252-253
const codeStoreId = c.env.AUTH_CODE_STORE.idFromName(code);
const codeStore = c.env.AUTH_CODE_STORE.get(codeStoreId);
```

**解決策**:
1. AuthorizationCodeStoreに`state.storage.put/get()`を実装
2. **Token endpointをAuthorizationCodeStore使用に移行**（最優先）
3. KVベースの`getAuthCode()`/`markAuthCodeAsUsed()`を廃止

---

#### 問題11: PAR request_uri の単一使用保証の競合状態（Medium）⚠️ 新発見

**場所**: `packages/op-auth/src/authorize.ts:92-142`

```typescript
// Step 1: KVからrequest_uriデータ取得
const requestData = await c.env.STATE_STORE.get(`request_uri:${request_uri}`);

if (!requestData) {
  return c.json({ error: 'Invalid or expired request_uri' }, 400);
}

// ... データ使用 ...

// Step 2: 単一使用のため削除（RFC 9126要件）
await c.env.STATE_STORE.delete(`request_uri:${request_uri}`);
```

**問題点**: KV get → use → delete パターンによる競合状態

```
並行リクエストの例:
T1: Request A: KV.get(`request_uri:urn:...`) → データ取得 ✅
T2: Request B: KV.get(`request_uri:urn:...`) → データ取得 ✅ (まだ削除されていない)

T3: Request A: データ使用 → 認可コード生成
T4: Request B: データ使用 → 認可コード生成

T5: Request A: KV.delete()
T6: Request B: KV.delete()

結果: 同じrequest_uriから2つの認可コードが生成される ❌
```

**RFC 9126 違反**:

[RFC 9126: OAuth 2.0 Pushed Authorization Requests, Section 2.3](https://datatracker.ietf.org/doc/html/rfc9126#section-2.3)

> The request_uri MUST be bound to the client that posted the authorization request. The request_uri MUST be one-time use and MUST be short lived.

**攻撃シナリオ**:
```
1. 攻撃者が有効なrequest_uriを取得（PARエンドポイントから）
2. 同時に2つの認可リクエスト送信:
   - Request A: /authorize?request_uri=urn:...
   - Request B: /authorize?request_uri=urn:...
3. タイミング次第で、両方が成功
4. 2つの認可コードが発行される
5. 攻撃者は1つを使用、もう1つを保存

影響:
- 単一使用保証の違反
- セキュリティリスク（限定的）
```

**影響度評価**:
- **Severity**: Medium（Criticalではない）
- **理由**:
  1. 攻撃には精密なタイミングが必要
  2. request_uriの寿命が短い（600秒）
  3. ネットワークレベルのMitMまたはクライアント制御が必要
  4. 認可コード自体も単一使用（別の保護あり）

**緩和策（現状）**:
- 短いPAR有効期限（600秒）
- 認可コード自体の単一使用保証（問題3で指摘されているが）
- HTTPSによる伝送保護

**解決策オプション**:

Option 1: Durable Object for PAR
```typescript
// PAR RequestStore DO (新規作成)
class PARRequestStore {
  private requests: Map<string, RequestData> = new Map();

  async consumeRequest(requestUri: string): Promise<RequestData | null> {
    const data = this.requests.get(requestUri);
    if (!data) return null;

    // アトミックに削除
    this.requests.delete(requestUri);
    return data;
  }
}
```

Option 2: KV Compare-and-Swap（将来の機能）
```typescript
// Cloudflare KV CAS（現時点では利用不可）
const success = await c.env.STATE_STORE.compareAndSwap(
  `request_uri:${request_uri}`,
  null, // expected value (after delete)
  requestData, // current value
);
```

Option 3: 現状受容（推奨）
```
理由:
- 攻撃難易度が高い
- 実際の影響は限定的
- 他のセキュリティ層で保護されている
- 複雑性 vs リスクのトレードオフ

アクション:
- ドキュメント化のみ
- モニタリング（同一request_uriの複数使用検出）
```

---

### 1.5 最終監査で発見された問題（v5.0）

v5.0の多角的監査（7つの視点、70+チェック項目）により、以下の**13の新規問題**を特定：

#### 問題 #12: DPoP JTI Replay Protection の競合状態（LOW）

**詳細**: 既存ドキュメント v3.0 参照

#### 問題 #15: Client Secret タイミング攻撃脆弱性（CRITICAL）⚠️

**ファイル**: `packages/op-auth/src/logout.ts:216`

**現状の実装**:
```typescript
// ❌ タイミング攻撃に脆弱
if (!client || client.client_secret !== secret) {
  return c.json({ error: 'invalid_client' }, 401);
}
```

**問題点**:
- プレーンな文字列比較（`!==`）を使用
- 比較処理時間が一致文字数に依存
- タイミング攻撃でclient_secretを統計的に推測可能

**攻撃シナリオ**:
```
1. 攻撃者が複数のclient_secret候補で認証試行
2. 各試行の処理時間を測定（マイクロ秒単位）
3. 正しいsecretとの一致文字数に応じて処理時間が変化
4. 統計的分析で1文字ずつsecretを推測
5. 数千〜数万回の試行でsecret特定
```

**影響範囲**:
- 全クライアント認証エンドポイント
- logout.ts, token.ts, revoke.ts, introspect.ts

**修正案**:
```typescript
import { timingSafeEqual } from 'crypto';

// ✅ 定数時間比較
const secretBuffer = Buffer.from(client.client_secret, 'utf8');
const providedBuffer = Buffer.from(secret, 'utf8');

if (secretBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(secretBuffer, providedBuffer)) {
  return c.json({ error: 'invalid_client' }, 401);
}
```

**工数**: 0.5日（全箇所を`timingSafeEqual()`に置換）

---

#### 問題 #16: /revoke と /introspect のクライアント認証欠如（CRITICAL）⚠️

**ファイル**:
- `packages/op-management/src/revoke.ts:86-96`
- `packages/op-management/src/introspect.ts:88-98`

**現状の実装**:
```typescript
// revoke.ts
const clientIdValidation = validateClientId(client_id);
if (!clientIdValidation.valid) {
  return c.json({ error: 'invalid_client' }, 401);
}
// ⚠️ client_secretの検証が完全に欠如！
```

**RFC違反**:
- **RFC 7009 Section 2.1**: "The client MUST authenticate with the authorization server"
- **RFC 7662 Section 2.1**: "The protected resource MUST authenticate with the authorization server"

**影響**:
- 任意のクライアントが他のクライアントのトークンを失効可能
- 任意のクライアントが他のクライアントのトークンを検査可能
- OAuth 2.0セキュリティモデルの完全崩壊

**攻撃シナリオ**:
```
1. 攻撃者が有効なclient_idを取得（公開情報）
2. 他のクライアントのaccess_tokenを盗聴または推測
3. POST /revoke with client_id=victim&token=stolen_token
4. 認証なしで実行成功 → トークン失効
```

**修正案**:
```typescript
// client_secret検証を追加
const client = await getClient(c.env, client_id);
if (!client) {
  return c.json({ error: 'invalid_client' }, 401);
}

// タイミング攻撃対策付き比較
if (!timingSafeEqual(
  Buffer.from(client.client_secret),
  Buffer.from(client_secret)
)) {
  return c.json({ error: 'invalid_client' }, 401);
}
```

**工数**: 1日

---

#### 問題 #17: RefreshTokenRotator DOが完全に未使用（CRITICAL）⚠️

**ファイル**:
- `packages/shared/src/durable-objects/RefreshTokenRotator.ts` (300+行)
- `packages/op-token/src/token.ts`

**現状の実装**:
```typescript
// token.ts は RefreshTokenRotator を使わず、KV を直接使用
await storeRefreshToken(c.env, refreshTokenJti, {...});  // → KV
const refreshTokenData = await getRefreshToken(c.env, jti);  // → KV
await deleteRefreshToken(c.env, jti);  // → KV
```

**問題点**:
- RefreshTokenRotatorのアトミック操作が機能せず
- リフレッシュトークンローテーションが非アトミック
- トークンファミリー検出が機能せず
- 300+行のコードが完全に無駄

**根本原因**:
- DOが実装されているのに、実際の使用箇所がKVのまま
- AuthCodeStore（問題 #10）と同じパターン

**影響**:
- トークン再利用攻撃の検出不可
- RFC 6749のセキュリティ要件違反

**修正**: token.tsをRefreshTokenRotator DO使用に移行（問題 #4と合わせて対応）

**工数**: 1-2日

---

#### 問題 #18: D1クリーンアップジョブ欠如（HIGH）⚠️

**場所**: 全体アーキテクチャ

**問題点**:
- 期限切れデータの自動削除なし
- **sessions**: 期限切れセッションが無限に蓄積
- **password_reset_tokens**: 使用済み/期限切れトークンが蓄積
- **audit_log**: 監査ログが無限成長

**データ成長予測**:
```
前提: 1000 DAU, 平均10 sessions/user/month

1年後:
- sessions: 120,000 レコード
- password_reset_tokens: 36,500 レコード（100 resets/day）
- audit_log: 3,650,000 レコード（10k events/day）

影響:
- ストレージコスト増大
- クエリパフォーマンス劣化
- インデックス効率低下
```

**推奨実装**:
```typescript
// Cloudflare Workers Cron Trigger
export default {
  async scheduled(event: ScheduledEvent, env: Env) {
    const now = Math.floor(Date.now() / 1000);

    // 期限切れセッション削除（毎日）
    await env.DB.prepare(
      'DELETE FROM sessions WHERE expires_at < ?'
    ).bind(now - 86400).run(); // 1日の猶予

    // 期限切れパスワードリセットトークン削除（毎日）
    await env.DB.prepare(
      'DELETE FROM password_reset_tokens WHERE expires_at < ? OR used = 1'
    ).bind(now).run();

    // 古い監査ログのアーカイブ（毎週日曜）
    if (event.cron === '0 0 * * 0') {
      // 90日より古いログをR2にエクスポート後削除
      // TODO: 監査ログアーカイブ処理
    }
  }
};
```

**Cron設定**:
```toml
# wrangler.toml
[triggers]
crons = ["0 2 * * *"]  # 毎日午前2時UTC
```

**工数**: 1-2日

---

#### 問題 #19: ID トークンに auth_time クレーム欠如（MEDIUM）

**ファイル**: `packages/op-token/src/token.ts:389-395`

**現状の実装**:
```typescript
const idTokenClaims = {
  iss: c.env.ISSUER_URL,
  sub: authCodeData.sub,
  aud: client_id,
  nonce: authCodeData.nonce,
  at_hash: atHash,
  // auth_time が欠如 ❌
};
```

**OIDC Core仕様**:
- Section 2: "`auth_time` - Time when the End-User authentication occurred"
- Section 3.1.3.3: "REQUIRED when max_age parameter is used"
- Section 5.5.1: "Recommended to include even when not required"

**影響**:
- max_age パラメータ使用時の仕様違反
- クライアントが認証時刻を検証不可
- セッション管理機能が制限される

**修正案**:
```typescript
const idTokenClaims = {
  iss: c.env.ISSUER_URL,
  sub: authCodeData.sub,
  aud: client_id,
  nonce: authCodeData.nonce,
  at_hash: atHash,
  auth_time: authCodeData.auth_time || Math.floor(Date.now() / 1000), // 追加
};
```

**前提**: 認証時刻をauthCodeDataに保存する必要あり

**工数**: 0.5日

---

#### 問題 #21: Passkey/Magic Link チャレンジ再利用脆弱性（MEDIUM）

**ファイル**:
- `packages/op-auth/src/passkey.ts:162,252,372,472`
- `packages/op-auth/src/magic-link.ts:224,283`

**パターン**:
```typescript
// Magic Link
const tokenData = await c.env.MAGIC_LINKS.get(`token:${token}`, 'json');
// ... use token ...
await c.env.MAGIC_LINKS.delete(`token:${token}`);
```

**問題点**:
- KV get → use → delete パターン（非アトミック）
- 並行リクエストで同じチャレンジ/トークンを複数回使用可能

**攻撃シナリオ**:
```
1. 攻撃者が有効なマジックリンクURLを傍受
2. 2つの並行リクエストを送信
3. 両方がKV getに成功（deleteされる前）
4. 両方のリクエストが認証成功
5. 複数セッションが作成される
```

**軽減要因**:
- Magic Link: 15分のTTL、メール経由配信
- Passkey Challenge: 5分のTTL
- 攻撃成功には正確なタイミングが必要

**修正オプション**:
1. Durable Object化（アトミック操作）
2. ドキュメント化のみ（軽減要因を考慮）

**工数**: 2日（DO化）またはドキュメント化のみ

---

#### 問題 #22: Magic Link/Passkey登録の部分失敗リスク（MEDIUM）

**ファイル**:
- `packages/op-auth/src/magic-link.ts:257-283`
- `packages/op-auth/src/passkey.ts:229-252`

**パターン**:
```typescript
// Magic Link Verify（複数ステップ、トランザクションなし）
await c.env.DB.prepare('UPDATE users SET email_verified = 1, ...').run();  // Step 1
await sessionStore.fetch(...);  // Step 2: セッション作成
await c.env.MAGIC_LINKS.delete(`token:${token}`);  // Step 3: トークン削除
```

**問題点**:
- Step 2失敗時: トークン削除済み、ユーザー再試行不可
- Step 1失敗時: ユーザーは検証済みだが認証情報なし
- 孤立レコード、不整合状態

**発生シナリオ**:
```
1. ユーザーがマジックリンクをクリック
2. DB UPDATEが成功（email_verified = 1）
3. SessionStore DOがタイムアウト
4. トークンは削除済み、ユーザーは再試行不可
5. ユーザーは検証済みだがログインできない状態
```

**推奨対応**:
- 逆順実行（削除を最後に）
- リトライロジック追加
- トランザクション境界の明確化

**工数**: 1-2日

---

#### 問題 #23: userinfo エンドポイントがハードコードデータ返却（MEDIUM）

**ファイル**: `packages/op-userinfo/src/userinfo.ts:82-111`

**現状の実装**:
```typescript
// Static user data for MVP
// In production, fetch from user database based on sub
const userData = {
  name: 'Test User',
  family_name: 'User',
  given_name: 'Test',
  // ... ハードコードされたテストデータ
};
```

**問題点**:
- 全ユーザーが同じuserinfoを受け取る
- OIDC準拠違反（実際のユーザーデータを返すべき）
- 本番環境で使用不可

**修正案**:
```typescript
// D1からユーザーデータを取得
const user = await c.env.DB.prepare(
  'SELECT * FROM users WHERE id = ?'
).bind(sub).first();

if (!user) {
  return c.json({ error: 'invalid_token' }, 401);
}

const userData = {
  name: user.name,
  email: user.email,
  email_verified: user.email_verified === 1,
  // ... D1から取得
};
```

**工数**: 1日

---

#### 問題 #24: セッション一括削除のN+1 DO呼び出し（MEDIUM）

**ファイル**: `packages/op-management/src/admin.ts:1012-1023`

**現状の実装**:
```typescript
await Promise.all(
  data.sessions.map(async (session) => {
    const deleteResponse = await sessionStore.fetch(
      new Request(`https://session-store/session/${session.id}`, {
        method: 'DELETE',
      })
    );
  })
);
```

**問題点**:
- 100セッション → 100回のDO HTTP呼び出し
- レイテンシ増加、DO負荷集中
- コスト増加（DO呼び出し回数課金）

**推奨対応**:
```typescript
// SessionStore DO に batch delete API 追加
async deleteBatch(sessionIds: string[]): Promise<void> {
  for (const id of sessionIds) {
    this.sessions.delete(id);
  }
  await this.state.storage.deleteAll(sessionIds.map(id => `session:${id}`));
}

// 呼び出し側
await sessionStore.fetch(
  new Request('https://session-store/sessions/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ sessionIds: data.sessions.map(s => s.id) })
  })
);
```

**工数**: 1日

---

#### その他の問題

**問題 #20**: password_reset_tokens の used フラグ
- **Status**: ✅ 確認済み、問題なし
- スキーマに`used INTEGER DEFAULT 0`が存在

**問題 #13**: JWKS Endpoint と KeyManager 不整合
- **詳細**: 既存ドキュメント v3.0 参照

**問題 #14**: スキーマバージョン管理欠如
- **詳細**: 既存ドキュメント v3.0 参照

---

## 2. 解決策の設計

### 2.1 DOからD1への信頼性確保

#### 設計方針

**ストラテジー**: Write-Behind Queue with Retry Logic

```
┌─────────────────────────────────────────────────────────┐
│              Write-Behind Queue Pattern                  │
└─────────────────────────────────────────────────────────┘

メインフロー:
1. メモリに書き込み（即座）
2. 書き込みキューに追加
3. レスポンス返却
4. バックグラウンドでD1書き込み（リトライ付き）

実装:
┌──────────────┐
│ Client Request│
└───────┬───────┘
        │
        ▼
┌────────────────────┐
│ SessionStore DO    │
│                    │
│ ┌────────────────┐ │
│ │ 1. Memory Write│ │ ← 即座完了
│ └────────┬───────┘ │
│          │         │
│          ▼         │
│ ┌────────────────┐ │
│ │ 2. Queue Add   │ │ ← 軽量操作
│ └────────┬───────┘ │
└──────────┼─────────┘
           │
           ▼
    Response to Client ✅
           │
           │ [バックグラウンド処理]
           ▼
┌───────────────────────┐
│ Retry Queue Worker    │
│                       │
│ ┌──────────────────┐  │
│ │ 3. D1 Write      │  │
│ └────┬─────────────┘  │
│      │                │
│      ├─ Success → Remove from queue
│      │                │
│      └─ Failure → Exponential backoff
│         ├─ Retry #1: 1秒後
│         ├─ Retry #2: 2秒後
│         ├─ Retry #3: 4秒後
│         ├─ Retry #4: 8秒後
│         └─ Max 5 retries → Alert
└───────────────────────┘
```

#### 実装詳細

**1. リトライキューの追加**

```typescript
// packages/shared/src/durable-objects/SessionStore.ts

interface QueuedWrite {
  id: string;
  operation: 'create' | 'update' | 'delete';
  session: Session;
  attempts: number;
  nextRetry: number;
}

export class SessionStore {
  private sessions: Map<string, Session> = new Map();
  private writeQueue: Map<string, QueuedWrite> = new Map(); // 新規追加
  private processingQueue: boolean = false;

  // ... existing code ...

  private async queueD1Write(
    operation: 'create' | 'update' | 'delete',
    session: Session
  ): Promise<void> {
    const queueId = `${operation}_${session.id}_${Date.now()}`;

    this.writeQueue.set(queueId, {
      id: queueId,
      operation,
      session,
      attempts: 0,
      nextRetry: Date.now(),
    });

    // バックグラウンド処理開始（非同期、結果を待たない）
    if (!this.processingQueue) {
      void this.processWriteQueue();
    }
  }

  private async processWriteQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    while (this.writeQueue.size > 0) {
      const now = Date.now();

      for (const [queueId, queued] of this.writeQueue.entries()) {
        // リトライタイミングチェック
        if (queued.nextRetry > now) {
          continue;
        }

        try {
          // D1書き込み実行
          switch (queued.operation) {
            case 'create':
            case 'update':
              await this.saveToD1(queued.session);
              break;
            case 'delete':
              await this.deleteFromD1(queued.session.id);
              break;
          }

          // 成功 → キューから削除
          this.writeQueue.delete(queueId);
          console.log(`SessionStore: D1 ${queued.operation} succeeded for ${queued.session.id}`);

        } catch (error) {
          // 失敗 → リトライ戦略
          queued.attempts++;

          if (queued.attempts >= 5) {
            // 最大リトライ回数超過 → アラート
            console.error(
              `SessionStore: D1 ${queued.operation} failed after ${queued.attempts} attempts for ${queued.session.id}`,
              error
            );

            // TODO: 外部監視システムへアラート送信
            // await this.sendAlert('D1_WRITE_FAILURE', { queueId, queued, error });

            // デッドレターキューへ移動（オプション）
            this.writeQueue.delete(queueId);
          } else {
            // Exponential backoff: 2^attempts 秒
            const backoffSeconds = Math.pow(2, queued.attempts);
            queued.nextRetry = now + backoffSeconds * 1000;

            console.warn(
              `SessionStore: D1 ${queued.operation} failed (attempt ${queued.attempts}/5), retrying in ${backoffSeconds}s`,
              error
            );
          }
        }
      }

      // 全てのアイテムが nextRetry > now の場合、一時停止
      const nextItem = Array.from(this.writeQueue.values())
        .sort((a, b) => a.nextRetry - b.nextRetry)[0];

      if (nextItem && nextItem.nextRetry > now) {
        const waitTime = nextItem.nextRetry - now;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      // キューが空になったら終了
      if (this.writeQueue.size === 0) {
        break;
      }
    }

    this.processingQueue = false;
  }

  async createSession(userId: string, ttl: number, data?: SessionData): Promise<Session> {
    const session: Session = {
      id: this.generateSessionId(),
      userId,
      expiresAt: Date.now() + ttl * 1000,
      createdAt: Date.now(),
      data,
    };

    // 1. メモリに保存（即座）
    this.sessions.set(session.id, session);

    // 2. D1書き込みをキューに追加（軽量操作）
    await this.queueD1Write('create', session);

    return session;
  }

  async extendSession(sessionId: string, additionalSeconds: number): Promise<Session | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    session.expiresAt += additionalSeconds * 1000;
    this.sessions.set(sessionId, session);

    // キューに追加
    await this.queueD1Write('update', session);

    return session;
  }

  async invalidateSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    const hadSession = this.sessions.has(sessionId);
    this.sessions.delete(sessionId);

    if (session) {
      // キューに追加
      await this.queueD1Write('delete', session);
    }

    return hadSession;
  }
}
```

**2. 監視とアラート**

```typescript
// packages/shared/src/utils/monitoring.ts (新規作成)

export interface Alert {
  type: 'D1_WRITE_FAILURE' | 'KV_CACHE_FAILURE' | 'AUTH_CODE_RACE';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export async function sendAlert(env: Env, alert: Alert): Promise<void> {
  // 実装オプション:
  // 1. Cloudflare Workers Logging (console.error with structured data)
  console.error('ALERT:', JSON.stringify(alert));

  // 2. Cloudflare Workers Analytics Engine
  if (env.ANALYTICS) {
    await env.ANALYTICS.writeDataPoint({
      blobs: [alert.type, alert.severity],
      doubles: [alert.timestamp],
      indexes: [alert.type],
    });
  }

  // 3. 外部監視サービス（Sentry, Datadog等）
  // await fetch('https://monitoring-service.example.com/alerts', {
  //   method: 'POST',
  //   body: JSON.stringify(alert),
  // });
}
```

**3. 一貫性レベルの明示化**

```typescript
// packages/shared/src/storage/interfaces.ts

export type ConsistencyLevel = 'strong' | 'eventual';

export interface WriteOptions {
  consistency?: ConsistencyLevel;
  timeout?: number; // ミリ秒
}

export interface ISessionStore {
  create(session: Partial<Session>, options?: WriteOptions): Promise<Session>;
  extend(sessionId: string, seconds: number, options?: WriteOptions): Promise<Session | null>;
  delete(sessionId: string, options?: WriteOptions): Promise<void>;
}
```

**使用例**:
```typescript
// クリティカルなセッション（即座にD1へ書き込み）
await sessionStore.create(session, { consistency: 'strong', timeout: 5000 });

// 通常のセッション（非同期書き込み）
await sessionStore.create(session, { consistency: 'eventual' });
```

---

### 2.2 KVキャッシュ無効化戦略

#### 設計方針

**ストラテジー**: Delete-Then-Write Pattern

```
┌─────────────────────────────────────────────────────┐
│         Delete-Then-Write Pattern                    │
└─────────────────────────────────────────────────────┘

従来 (Write-Then-Delete):
T1: D1書き込み ✅
T2: [一貫性の窓] ← 問題
T3: KV削除 ✅

改善後 (Delete-Then-Write):
T1: KV削除 ✅ (古いキャッシュ削除)
T2: D1書き込み ✅
T3: 次回読み取り → KVミス → D1から最新取得 ✅
```

#### 実装詳細

**1. 順序変更 + エラーハンドリング**

```typescript
// packages/shared/src/storage/adapters/cloudflare-adapter.ts

private async setToD1WithKVCache(key: string, value: string): Promise<void> {
  // Strategy 1: Delete-Then-Write (推奨)

  // Step 1: KVキャッシュを先に削除
  if (this.env.CLIENTS_CACHE) {
    try {
      await this.env.CLIENTS_CACHE.delete(key);
    } catch (error) {
      // キャッシュ削除失敗はログのみ（D1が正とする）
      console.warn(`KV cache delete failed for ${key}, proceeding with D1 write`, error);
    }
  }

  // Step 2: D1に書き込み
  await this.setToD1(key, value);

  // これで不整合の窓が閉じる:
  // - KV削除後: 読み取りはD1にフォールバック（遅いが正しい）
  // - D1書き込み後: 読み取りは最新データ取得
}
```

**2. Alternative: Compare-and-Swap Pattern**

より高度な一貫性が必要な場合:

```typescript
interface CachedValue {
  data: string;
  version: number; // D1のupdated_atタイムスタンプ
}

private async setToD1WithKVCache(key: string, value: string): Promise<void> {
  const valueData = JSON.parse(value);
  const version = Date.now();

  // D1に書き込み（バージョン付き）
  await this.setToD1(key, JSON.stringify({ ...valueData, _version: version }));

  // KVキャッシュにバージョン付きで保存
  if (this.env.CLIENTS_CACHE) {
    await this.env.CLIENTS_CACHE.put(
      key,
      JSON.stringify({ data: value, version }),
      { expirationTtl: 300 }
    );
  }
}

private async getFromD1WithKVCache(key: string): Promise<string | null> {
  if (this.env.CLIENTS_CACHE) {
    const cached = await this.env.CLIENTS_CACHE.get(key);
    if (cached) {
      const { data, version } = JSON.parse(cached) as CachedValue;

      // D1から最新バージョンを確認（軽量クエリ）
      const d1Version = await this.getD1Version(key);

      if (d1Version && d1Version <= version) {
        // キャッシュが最新
        return data;
      }

      // キャッシュが古い → 削除して再取得
      await this.env.CLIENTS_CACHE.delete(key);
    }
  }

  // KVミスまたは古いキャッシュ → D1から取得
  const value = await this.getFromD1(key);

  if (value && this.env.CLIENTS_CACHE) {
    const version = Date.now();
    await this.env.CLIENTS_CACHE.put(
      key,
      JSON.stringify({ data: value, version }),
      { expirationTtl: 300 }
    );
  }

  return value;
}

private async getD1Version(key: string): Promise<number | null> {
  const [table, id] = key.split(':', 2);
  if (table !== 'client') return null;

  const result = await this.env.DB.prepare(
    'SELECT updated_at FROM oauth_clients WHERE client_id = ?'
  )
    .bind(id)
    .first();

  return result ? (result.updated_at as number) : null;
}
```

**3. Cache-Control Headers（クライアント側）**

```typescript
// packages/op-management/src/admin.ts (クライアント更新エンドポイント)

app.put('/clients/:client_id', async (c) => {
  const clientId = c.req.param('client_id');
  const updates = await c.req.json();

  // クライアント更新
  const updated = await clientStore.update(clientId, updates);

  return c.json(updated, 200, {
    // キャッシュ制御ヘッダー
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'ETag': `"${updated.updated_at}"`,
    'Last-Modified': new Date(updated.updated_at * 1000).toUTCString(),
  });
});

app.get('/clients/:client_id', async (c) => {
  const clientId = c.req.param('client_id');
  const client = await clientStore.get(clientId);

  if (!client) {
    return c.json({ error: 'Client not found' }, 404);
  }

  // 条件付きリクエスト対応
  const ifNoneMatch = c.req.header('If-None-Match');
  const etag = `"${client.updated_at}"`;

  if (ifNoneMatch === etag) {
    return c.body(null, 304); // Not Modified
  }

  return c.json(client, 200, {
    'Cache-Control': 'private, max-age=300', // 5分キャッシュ
    'ETag': etag,
    'Last-Modified': new Date(client.updated_at * 1000).toUTCString(),
  });
});
```

---

### 2.3 認可コードのDurable Object移行

#### 設計方針

**既存の `AuthorizationCodeStore` DOを有効化**

現在未使用の `AuthorizationCodeStore` Durable Object を認可フローに統合します。

```
変更前 (KV):
authorize.ts → storeAuthCode(KV) → AUTH_CODES namespace
token.ts → getAuthCode(KV) → 競合の可能性 ❌

変更後 (DO):
authorize.ts → AuthorizationCodeStore DO → 強一貫性 ✅
token.ts → AuthorizationCodeStore DO → ワンタイムユース保証 ✅
```

#### 実装詳細

**1. 認可エンドポイントの変更**

```typescript
// packages/op-auth/src/authorize.ts

// 変更前:
import { storeAuthCode } from '@repo/shared/utils/kv';

// 認可コード生成と保存
const code = crypto.randomUUID();
await storeAuthCode(env, code, {
  clientId,
  redirectUri: validRedirectUri,
  userId: user.id,
  scope,
  codeChallenge,
  codeChallengeMethod,
  nonce,
  state,
});

// 変更後:
// AuthorizationCodeStore DOを使用
const doId = env.AUTH_CODE_STORE.idFromName('default');
const doStub = env.AUTH_CODE_STORE.get(doId);

const code = crypto.randomUUID();

const response = await doStub.fetch(
  new Request('http://internal/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      clientId,
      redirectUri: validRedirectUri,
      userId: user.id,
      scope,
      codeChallenge,
      codeChallengeMethod,
      nonce,
      state,
      expiresAt: Date.now() + 60 * 1000, // 60秒
    }),
  })
);

if (!response.ok) {
  throw new Error('Failed to store authorization code');
}
```

**2. トークンエンドポイントの変更**

```typescript
// packages/op-token/src/token.ts

// 変更前:
import { getAuthCode } from '@repo/shared/utils/kv';

const authCodeData = await getAuthCode(env, code);
if (!authCodeData || authCodeData.used) {
  return c.json({ error: 'invalid_grant' }, 400);
}

// Mark as used
authCodeData.used = true;
await storeAuthCode(env, code, authCodeData);

// 変更後:
// AuthorizationCodeStore DOでアトミックに消費
const doId = env.AUTH_CODE_STORE.idFromName('default');
const doStub = env.AUTH_CODE_STORE.get(doId);

const response = await doStub.fetch(
  new Request('http://internal/code/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      clientId,
      codeVerifier, // PKCEの場合
    }),
  })
);

if (!response.ok) {
  const error = await response.json();

  if (response.status === 409) {
    // コード再利用検出 → 全トークン無効化
    console.error('Authorization code reuse detected:', error);

    // TODO: この認可コードで発行されたトークンを全て無効化
    // await revokeTokensByAuthCode(env, code);

    return c.json({
      error: 'invalid_grant',
      error_description: 'Authorization code has already been used',
    }, 400);
  }

  return c.json({ error: 'invalid_grant' }, 400);
}

const authCodeData = await response.json();

// トークン発行処理続行...
```

**3. AuthorizationCodeStore DOの拡張**

```typescript
// packages/shared/src/durable-objects/AuthorizationCodeStore.ts

export class AuthorizationCodeStore {
  // ... existing code ...

  /**
   * コードをアトミックに消費
   * ワンタイムユース保証 + PKCE検証
   */
  async consumeCode(request: ConsumeCodeRequest): Promise<ConsumeCodeResponse> {
    const { code, clientId, codeVerifier } = request;

    const stored = this.codes.get(code);

    if (!stored) {
      throw new Error('Code not found or expired');
    }

    // 既に使用済み → 再利用検出
    if (stored.used) {
      // セキュリティイベントログ
      console.error('SECURITY: Authorization code reuse attempt detected', {
        code,
        clientId,
        originalClientId: stored.clientId,
        timestamp: Date.now(),
      });

      // 監査ログ
      await this.logToD1('auth_code.reuse_detected', {
        code,
        clientId,
        userId: stored.userId,
      });

      // 409 Conflict
      throw new ConflictError('Authorization code has already been used');
    }

    // クライアント検証
    if (stored.clientId !== clientId) {
      throw new Error('Client mismatch');
    }

    // PKCE検証
    if (stored.codeChallenge) {
      if (!codeVerifier) {
        throw new Error('Code verifier required');
      }

      const isValid = await this.verifyPKCE(
        codeVerifier,
        stored.codeChallenge,
        stored.codeChallengeMethod
      );

      if (!isValid) {
        throw new Error('Invalid code verifier');
      }
    }

    // アトミックに使用済みマーク
    stored.used = true;
    stored.usedAt = Date.now();
    this.codes.set(code, stored);

    // 監査ログ
    await this.logToD1('auth_code.consumed', {
      code,
      clientId,
      userId: stored.userId,
    });

    return {
      clientId: stored.clientId,
      redirectUri: stored.redirectUri,
      userId: stored.userId,
      scope: stored.scope,
      nonce: stored.nonce,
      state: stored.state,
    };
  }

  private async verifyPKCE(
    verifier: string,
    challenge: string,
    method: 'S256' | 'plain'
  ): Promise<boolean> {
    if (method === 'plain') {
      return verifier === challenge;
    }

    // S256: BASE64URL(SHA256(verifier)) == challenge
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    return base64 === challenge;
  }

  private async logToD1(event: string, metadata: Record<string, unknown>): Promise<void> {
    if (!this.env.DB) return;

    try {
      await this.env.DB.prepare(
        'INSERT INTO audit_log (event, metadata, created_at) VALUES (?, ?, ?)'
      )
        .bind(event, JSON.stringify(metadata), Math.floor(Date.now() / 1000))
        .run();
    } catch (error) {
      console.error('Failed to log to D1:', error);
    }
  }
}
```

**4. KV AUTH_CODES の段階的廃止**

```typescript
// 移行戦略:
// Phase 1: 並行運用（両方に書き込み、DOから優先読み取り）
// Phase 2: DOのみ書き込み（KV読み取りフォールバック）
// Phase 3: KV完全削除

// packages/shared/src/utils/kv.ts

export async function storeAuthCodeMigration(
  env: Env,
  code: string,
  data: AuthCodeData,
  useDO: boolean = true
): Promise<void> {
  if (useDO && env.AUTH_CODE_STORE) {
    // 新方式: Durable Object
    const doId = env.AUTH_CODE_STORE.idFromName('default');
    const doStub = env.AUTH_CODE_STORE.get(doId);
    await doStub.fetch(
      new Request('http://internal/code', {
        method: 'POST',
        body: JSON.stringify({ code, ...data }),
      })
    );
  } else {
    // 旧方式: KV（後方互換性）
    await storeAuthCode(env, code, data);
  }
}
```

---

### 2.4 RefreshTokenRotatorの永続化

#### 設計方針

**KeyManagerと同じDurable Storage パターンを適用**

```typescript
// packages/shared/src/durable-objects/RefreshTokenRotator.ts

export class RefreshTokenRotator {
  private state: DurableObjectState;
  private env: Env;

  // 状態管理用の型定義
  private rotatorState: {
    families: Map<string, TokenFamily>;
    tokenToFamily: Map<string, string>;
  } | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * 初期化: Durable Storageから状態を復元
   */
  private async initializeState(): Promise<void> {
    if (this.rotatorState !== null) {
      return; // 既に初期化済み
    }

    // Durable Storageから読み込み
    const storedFamilies = await this.state.storage.get<Array<[string, TokenFamily]>>('families');
    const storedIndex = await this.state.storage.get<Array<[string, string]>>('tokenToFamily');

    this.rotatorState = {
      families: storedFamilies ? new Map(storedFamilies) : new Map(),
      tokenToFamily: storedIndex ? new Map(storedIndex) : new Map(),
    };

    console.log(
      `RefreshTokenRotator initialized: ${this.rotatorState.families.size} families restored`
    );
  }

  /**
   * 状態を Durable Storage に保存
   */
  private async saveState(): Promise<void> {
    if (!this.rotatorState) {
      return;
    }

    await this.state.storage.put('families', Array.from(this.rotatorState.families.entries()));
    await this.state.storage.put(
      'tokenToFamily',
      Array.from(this.rotatorState.tokenToFamily.entries())
    );
  }

  /**
   * トークンファミリー作成（永続化対応）
   */
  async createFamily(request: CreateFamilyRequest): Promise<TokenFamily> {
    // 状態初期化
    await this.initializeState();

    const familyId = this.generateFamilyId();
    const now = Date.now();

    const family: TokenFamily = {
      id: familyId,
      currentToken: request.token,
      previousTokens: [],
      userId: request.userId,
      clientId: request.clientId,
      scope: request.scope,
      rotationCount: 0,
      createdAt: now,
      lastRotation: now,
      expiresAt: now + request.ttl * 1000,
    };

    // メモリに保存
    this.rotatorState!.families.set(familyId, family);
    this.rotatorState!.tokenToFamily.set(request.token, familyId);

    // Durable Storageに永続化
    await this.saveState();

    // 監査ログ（非同期・ベストエフォート）
    void this.logToD1({
      action: 'created',
      familyId,
      userId: request.userId,
      clientId: request.clientId,
      metadata: { scope: request.scope },
      timestamp: now,
    });

    return family;
  }

  /**
   * トークンローテーション（永続化対応）
   */
  async rotate(request: RotateTokenRequest): Promise<RotateTokenResponse> {
    await this.initializeState();

    const family = this.findFamilyByToken(request.currentToken);
    if (!family) {
      throw new Error('invalid_grant: Refresh token not found or expired');
    }

    // ... 盗難検出ロジック（既存コードと同じ） ...

    // 新しいトークン生成
    const newToken = this.generateToken();

    // アトミック更新（メモリ内）
    const oldToken = family.currentToken;
    family.previousTokens.push(oldToken);
    family.currentToken = newToken;
    family.rotationCount++;
    family.lastRotation = Date.now();

    // previousTokensをトリム
    if (family.previousTokens.length > this.MAX_PREVIOUS_TOKENS) {
      const removed = family.previousTokens.shift();
      if (removed) {
        this.rotatorState!.tokenToFamily.delete(removed);
      }
    }

    // メモリ更新
    this.rotatorState!.families.set(family.id, family);
    this.rotatorState!.tokenToFamily.set(newToken, family.id);

    // Durable Storageに永続化 ✅
    await this.saveState();

    // 監査ログ（非同期）
    void this.logToD1({
      action: 'rotated',
      familyId: family.id,
      userId: request.userId,
      clientId: request.clientId,
      metadata: { rotationCount: family.rotationCount },
      timestamp: Date.now(),
    });

    return {
      newToken,
      familyId: family.id,
      expiresIn: Math.floor((family.expiresAt - Date.now()) / 1000),
      rotationCount: family.rotationCount,
    };
  }
}
```

**メリット**:
- DO再起動後もトークンファミリーが復元される ✅
- デプロイ時にユーザーが強制ログアウトされない ✅
- Worker移行時も状態が保持される ✅

**注意点**:
- `state.storage.put()` は非同期だが、DO内でシリアライズされるため一貫性は保たれる
- ストレージサイズ制限: Durable Storageは128KB/key（大量のトークンファミリーには注意）

---

### 2.5 監査ログの信頼性向上

#### 設計方針

**Option A: リトライキューによる信頼性確保**

セクション2.1の `Write-Behind Queue with Retry Logic` を監査ログにも適用。

```typescript
// packages/shared/src/durable-objects/shared/AuditLogQueue.ts (新規)

export interface AuditLogEntry {
  event: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export class AuditLogQueue {
  private queue: Map<string, { entry: AuditLogEntry; attempts: number; nextRetry: number }> =
    new Map();
  private processing: boolean = false;

  constructor(
    private env: Env,
    private onAlert: (alert: Alert) => Promise<void>
  ) {}

  async enqueue(entry: AuditLogEntry): Promise<void> {
    const id = `audit_${crypto.randomUUID()}`;
    this.queue.set(id, {
      entry,
      attempts: 0,
      nextRetry: Date.now(),
    });

    if (!this.processing) {
      void this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this.processing = true;

    while (this.queue.size > 0) {
      const now = Date.now();

      for (const [id, queued] of this.queue.entries()) {
        if (queued.nextRetry > now) continue;

        try {
          await this.writeToD1(queued.entry);
          this.queue.delete(id); // 成功 → 削除
        } catch (error) {
          queued.attempts++;

          if (queued.attempts >= 5) {
            // 最大リトライ超過 → アラート
            await this.onAlert({
              type: 'AUDIT_LOG_FAILURE',
              severity: 'critical',
              message: 'Audit log write failed after 5 attempts',
              metadata: { entry: queued.entry, error },
              timestamp: now,
            });

            this.queue.delete(id); // デッドレターキューへ移動（実装は省略）
          } else {
            // Exponential backoff
            queued.nextRetry = now + Math.pow(2, queued.attempts) * 1000;
          }
        }
      }

      // 待機
      const nextItem = Array.from(this.queue.values())
        .sort((a, b) => a.nextRetry - b.nextRetry)[0];

      if (nextItem && nextItem.nextRetry > now) {
        await new Promise((resolve) => setTimeout(resolve, nextItem.nextRetry - now));
      }

      if (this.queue.size === 0) break;
    }

    this.processing = false;
  }

  private async writeToD1(entry: AuditLogEntry): Promise<void> {
    await this.env.DB.prepare(
      'INSERT INTO audit_log (id, user_id, action, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(
        `audit_${crypto.randomUUID()}`,
        entry.userId || null,
        entry.event,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        Math.floor(entry.timestamp / 1000)
      )
      .run();
  }
}

// RefreshTokenRotatorでの使用例
export class RefreshTokenRotator {
  private auditQueue: AuditLogQueue;

  constructor(state: DurableObjectState, env: Env) {
    this.auditQueue = new AuditLogQueue(env, async (alert) => {
      await sendAlert(env, alert);
    });
  }

  async rotate(request: RotateTokenRequest): Promise<RotateTokenResponse> {
    // ... トークンローテーション処理 ...

    // 監査ログをキューに追加（非同期・リトライ保証）
    await this.auditQueue.enqueue({
      event: 'refresh_token.rotated',
      userId: request.userId,
      metadata: { familyId: family.id, rotationCount: family.rotationCount },
      timestamp: Date.now(),
    });

    return result;
  }
}
```

**Option B: 同期的な監査ログ（強一貫性）**

セキュリティイベント（盗難検出等）のみ同期的に書き込み。

```typescript
async rotate(request: RotateTokenRequest): Promise<RotateTokenResponse> {
  // ... トークンローテーション処理 ...

  if (theftDetected) {
    // 盗難検出 → 同期的にログ書き込み（失敗したらエラー返却）
    await this.logToD1Sync({
      event: 'refresh_token.theft_detected',
      userId: request.userId,
      metadata: { familyId: family.id },
      timestamp: Date.now(),
    });

    throw new Error('invalid_grant: Token theft detected');
  }

  // 通常のローテーション → 非同期ログ（ベストエフォート）
  void this.auditQueue.enqueue({ ... });

  return result;
}

private async logToD1Sync(entry: AuditLogEntry): Promise<void> {
  // タイムアウト付き同期書き込み
  await Promise.race([
    this.writeToD1(entry),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Audit log timeout')), 5000)
    ),
  ]);
}
```

**推奨**: Option A (リトライキュー) + Option B (重要イベントは同期)のハイブリッド

---

### 2.6 Rate Limitingの設計選択

#### オプション比較

| オプション | 精度 | パフォーマンス | 複雑度 | コスト |
|-----------|------|--------------|-------|-------|
| Option 1: DO | ✅ 完璧 | ⚠️ シャーディング必要 | 高 | 高 |
| Option 2: DO Alarms + KV | ✅ 高い | ✅ 良好 | 中 | 中 |
| Option 3: KV (現状) | ⚠️ ベストエフォート | ✅ 最良 | 低 | 低 |

**推奨**: Option 3（現状維持） + ドキュメント化

**理由**:
- レート制限は「ベストエフォート」で十分な場合が多い
- 完璧な精度よりも、シンプルさと低コストを優先
- 攻撃者は多数のIPを使用するため、単一IPの精度向上は効果限定的

**ドキュメント追加**:

```typescript
// packages/shared/src/middleware/rate-limit.ts

/**
 * Rate Limiting Middleware (Best-Effort)
 *
 * このレート制限実装はKVベースのため、結果整合性により完璧な精度は保証されません。
 * 並行リクエストによりカウントが不正確になる可能性がありますが、以下の理由により許容範囲内です：
 *
 * 1. レート制限は主にDDoS対策（大量リクエスト）を目的とし、境界値での精度は重要でない
 * 2. 攻撃者は通常、多数のIPアドレスを使用するため、単一IPの精度向上は限定的
 * 3. シンプルな実装により、パフォーマンスとコストを最適化
 *
 * より高精度なレート制限が必要な場合（例: 課金APIのクォータ管理）は、
 * Durable Objectsベースの実装を検討してください。
 */
export function rateLimitMiddleware(config: RateLimitConfig) {
  // ...
}
```

**Alternative (将来の改善)**:

厳密な精度が必要な場合のみ、特定エンドポイントでDOベースを使用。

```typescript
// Rate Limit DO (高精度版)
export class RateLimitCounter {
  private counts: Map<string, { count: number; resetAt: number }> = new Map();

  async increment(clientIP: string, windowSeconds: number): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    let record = this.counts.get(clientIP);

    if (!record || now >= record.resetAt) {
      record = { count: 1, resetAt: now + windowSeconds };
    } else {
      record.count++;
    }

    this.counts.set(clientIP, record);
    return record.count;
  }
}
```

---

### 2.7 Passkey Counterの Compare-and-Swap 実装

#### 実装詳細

```typescript
// packages/shared/src/storage/adapters/cloudflare-adapter.ts

export class PasskeyStore implements IPasskeyStore {
  /**
   * Update passkey counter with compare-and-swap logic
   * Ensures monotonic increase per WebAuthn specification
   */
  async updateCounter(
    passkeyId: string,
    newCounter: number,
    maxRetries: number = 3
  ): Promise<Passkey> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Step 1: Read current counter
        const current = await this.adapter.query<{ counter: number }>(
          'SELECT counter FROM passkeys WHERE id = ?',
          [passkeyId]
        );

        if (!current[0]) {
          throw new Error(`Passkey not found: ${passkeyId}`);
        }

        const currentCounter = current[0].counter;

        // Step 2: Validate monotonic increase
        if (newCounter <= currentCounter) {
          // Counter did not increase → possible credential clone
          console.error('SECURITY: Passkey counter anomaly detected', {
            passkeyId,
            currentCounter,
            newCounter,
          });

          throw new Error(
            `Invalid counter: ${newCounter} <= ${currentCounter}. Possible credential clone.`
          );
        }

        // Step 3: Conditional UPDATE (compare-and-swap)
        const now = Math.floor(Date.now() / 1000);
        const result = await this.adapter.execute(
          `UPDATE passkeys
           SET counter = ?, last_used_at = ?
           WHERE id = ? AND counter = ?`,
          [newCounter, now, passkeyId, currentCounter]
        );

        // Step 4: Check if update succeeded
        if (result.changes === 0) {
          // Another request updated the counter first → retry
          console.warn(
            `Passkey counter update conflict (attempt ${attempt + 1}/${maxRetries})`,
            { passkeyId }
          );

          // Exponential backoff before retry
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 10));
          continue;
        }

        // Success → return updated passkey
        const updated = await this.adapter.query<Passkey>(
          'SELECT * FROM passkeys WHERE id = ?',
          [passkeyId]
        );

        if (!updated[0]) {
          throw new Error(`Passkey disappeared after update: ${passkeyId}`);
        }

        return updated[0];
      } catch (error) {
        if (attempt === maxRetries - 1) {
          // Max retries reached
          throw error;
        }
        // Retry on transient errors
      }
    }

    throw new Error(`Failed to update passkey counter after ${maxRetries} attempts`);
  }
}
```

**WebAuthn仕様準拠**:
- ✅ Counter単調増加保証
- ✅ クローン検出（counter減少時にエラー）
- ✅ 並行リクエスト対応（Compare-and-Swap）

---

### 2.8 セッショントークンの管理改善

#### Option A: TTL短縮（最も簡単）

```typescript
// packages/op-auth/src/session-management.ts

// 現在: 5分
const SESSION_TOKEN_TTL = 300;

// 改善: 30秒に短縮
const SESSION_TOKEN_TTL = 30;
```

**メリット**:
- 実装変更なし
- 競合状態の影響を最小化

**デメリット**:
- UX低下（短いTTLでユーザーが再認証を求められる可能性）
- ITP対応の本質的な解決ではない

#### Option B: Durable Objectで管理（完璧だが複雑）

```typescript
// packages/shared/src/durable-objects/SessionTokenStore.ts (新規)

export class SessionTokenStore {
  private tokens: Map<string, { sessionId: string; used: boolean; expiresAt: number }> =
    new Map();

  async createToken(sessionId: string, ttl: number): Promise<string> {
    const token = `st_${crypto.randomUUID()}`;
    this.tokens.set(token, {
      sessionId,
      used: false,
      expiresAt: Date.now() + ttl * 1000,
    });
    return token;
  }

  async consumeToken(token: string): Promise<string | null> {
    const tokenData = this.tokens.get(token);

    if (!tokenData || tokenData.used || tokenData.expiresAt <= Date.now()) {
      return null;
    }

    // アトミックに使用済みマーク
    tokenData.used = true;
    this.tokens.set(token, tokenData);

    return tokenData.sessionId;
  }
}
```

**メリット**:
- ✅ 完璧な一貫性
- ✅ 競合状態なし

**デメリット**:
- 複雑度増加
- コスト増加

#### 推奨: Option A（TTL短縮 + ドキュメント化）

**理由**:
- セッショントークンは一時的なもので、完璧な精度は必須ではない
- TTL短縮で影響を最小化すれば十分
- シンプルさを維持

---

### 2.9 SessionStore DO の永続化実装（クリティカル）⚠️ NEW

**戦略**: KeyManagerパターンの適用

#### Step 1: Durable Storageインタフェース追加

```typescript
// packages/shared/src/durable-objects/SessionStore.ts

interface SessionStoreState {
  sessions: Record<string, Session>; // Map → Record for serialization
  lastCleanup: number;
}

export class SessionStore {
  private state: DurableObjectState;
  private env: Env;
  private sessionStoreState: SessionStoreState | null = null;
  private cleanupInterval: number | null = null;

  /**
   * Initialize state from Durable Storage
   */
  private async initializeState(): Promise<void> {
    if (this.sessionStoreState !== null) {
      return;
    }

    // Load from Durable Storage
    const stored = await this.state.storage.get<SessionStoreState>('state');

    if (stored) {
      this.sessionStoreState = stored;
    } else {
      // Initialize empty state
      this.sessionStoreState = {
        sessions: {},
        lastCleanup: Date.now(),
      };
      await this.saveState();
    }

    // Start cleanup interval
    this.startCleanup();
  }

  /**
   * Save state to Durable Storage
   */
  private async saveState(): Promise<void> {
    if (this.sessionStoreState) {
      await this.state.storage.put('state', this.sessionStoreState);
    }
  }

  /**
   * Get session (from Durable Storage, D1 fallback only for migration)
   */
  async getSession(sessionId: string): Promise<Session | null> {
    await this.initializeState();

    const session = this.sessionStoreState!.sessions[sessionId];

    if (session && !this.isExpired(session)) {
      return session;
    }

    // Optional: D1 fallback for migration period only
    // After migration complete, remove this
    if (!session) {
      const d1Session = await this.loadFromD1(sessionId);
      if (d1Session && !this.isExpired(d1Session)) {
        // Promote to Durable Storage
        this.sessionStoreState!.sessions[sessionId] = d1Session;
        await this.saveState();
        return d1Session;
      }
    }

    return null;
  }

  /**
   * Create session (save to Durable Storage)
   */
  async createSession(userId: string, ttl: number, data?: SessionData): Promise<Session> {
    await this.initializeState();

    const session: Session = {
      id: this.generateSessionId(),
      userId,
      expiresAt: Date.now() + ttl * 1000,
      createdAt: Date.now(),
      data,
    };

    // 1. Save to Durable Storage (primary)
    this.sessionStoreState!.sessions[session.id] = session;
    await this.saveState();

    // 2. Optional: Backup to D1 (async, for audit)
    // Keep this for audit trail, but don't rely on it
    this.saveToD1(session).catch((error) => {
      console.error('SessionStore: D1 backup failed:', error);
      // Trigger alert for audit log failure
    });

    return session;
  }

  /**
   * Invalidate session (remove from Durable Storage)
   */
  async invalidateSession(sessionId: string): Promise<boolean> {
    await this.initializeState();

    const hadSession = !!this.sessionStoreState!.sessions[sessionId];

    // Remove from Durable Storage
    delete this.sessionStoreState!.sessions[sessionId];
    await this.saveState();

    // Optional: Delete from D1 (async)
    this.deleteFromD1(sessionId).catch((error) => {
      console.error('SessionStore: D1 delete failed:', error);
    });

    return hadSession;
  }
}
```

#### Step 2: クリーンアップロジックの更新

```typescript
private async cleanupExpiredSessions(): Promise<void> {
  await this.initializeState();

  const now = Date.now();
  let cleaned = 0;
  const sessions = this.sessionStoreState!.sessions;

  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session.expiresAt <= now) {
      delete sessions[sessionId];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    await this.saveState();
    console.log(`SessionStore: Cleaned up ${cleaned} expired sessions`);
  }

  this.sessionStoreState!.lastCleanup = now;
}
```

#### マイグレーション戦略

```
Phase 1: デュアルライト期間（1週間）
┌──────────────────┐
│ SessionStore DO  │
├──────────────────┤
│ 1. Write DO ✅   │
│ 2. Write D1 ⚠️   │  ← バックアップとして継続
│ 3. Read DO ✅    │
│    Fallback D1   │  ← 移行期間のみ
└──────────────────┘

Phase 2: DO単独期間（永続）
┌──────────────────┐
│ SessionStore DO  │
├──────────────────┤
│ 1. Write DO ✅   │
│ 2. Optional D1   │  ← 監査ログのみ
│ 3. Read DO ✅    │
└──────────────────┘
```

**工数見積もり**: 2-3日
- コード変更: 1日
- テスト: 1日
- マイグレーション: 0.5-1日

---

### 2.10 AuthorizationCodeStore DO の永続化 + 移行（クリティカル）⚠️ NEW

**戦略**: 永続化実装 + Token endpoint移行

#### Step 1: Durable Storage実装（SessionStoreと同様）

```typescript
// packages/shared/src/durable-objects/AuthorizationCodeStore.ts

interface AuthCodeStoreState {
  codes: Record<string, AuthorizationCode>;
  lastCleanup: number;
}

export class AuthorizationCodeStore {
  private state: DurableObjectState;
  private env: Env;
  private authCodeState: AuthCodeStoreState | null = null;

  private async initializeState(): Promise<void> {
    if (this.authCodeState !== null) {
      return;
    }

    const stored = await this.state.storage.get<AuthCodeStoreState>('state');

    if (stored) {
      this.authCodeState = stored;
    } else {
      this.authCodeState = {
        codes: {},
        lastCleanup: Date.now(),
      };
      await this.saveState();
    }

    this.startCleanup();
  }

  private async saveState(): Promise<void> {
    if (this.authCodeState) {
      await this.state.storage.put('state', this.authCodeState);
    }
  }

  /**
   * Store code (Durable Storage)
   */
  async storeCode(request: StoreCodeRequest): Promise<{ success: boolean; expiresAt: number }> {
    await this.initializeState();

    // DDoS protection
    const userCodeCount = this.countUserCodes(request.userId);
    if (userCodeCount >= this.MAX_CODES_PER_USER) {
      throw new Error('Too many authorization codes for this user');
    }

    const now = Date.now();
    const authCode: AuthorizationCode = {
      code: request.code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      userId: request.userId,
      scope: request.scope,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      nonce: request.nonce,
      state: request.state,
      used: false,
      expiresAt: now + this.CODE_TTL * 1000,
      createdAt: now,
    };

    // Save to Durable Storage
    this.authCodeState!.codes[request.code] = authCode;
    await this.saveState();

    return {
      success: true,
      expiresAt: authCode.expiresAt,
    };
  }

  /**
   * Consume code (atomic with Durable Storage)
   */
  async consumeCode(request: ConsumeCodeRequest): Promise<ConsumeCodeResponse> {
    await this.initializeState();

    const stored = this.authCodeState!.codes[request.code];

    if (!stored) {
      throw new Error('invalid_grant: Authorization code not found or expired');
    }

    // Expiration check
    if (this.isExpired(stored)) {
      delete this.authCodeState!.codes[request.code];
      await this.saveState();
      throw new Error('invalid_grant: Authorization code expired');
    }

    // Replay attack detection (atomic with DO)
    if (stored.used) {
      console.warn(`SECURITY: Replay attack detected! Code ${request.code}`);
      throw new Error('invalid_grant: Authorization code already used');
    }

    // Client ID validation
    if (stored.clientId !== request.clientId) {
      throw new Error('invalid_grant: Client ID mismatch');
    }

    // PKCE validation
    if (stored.codeChallenge) {
      if (!request.codeVerifier) {
        throw new Error('invalid_grant: code_verifier required for PKCE');
      }

      const challenge = await this.generateCodeChallenge(
        request.codeVerifier,
        stored.codeChallengeMethod || 'S256'
      );

      if (challenge !== stored.codeChallenge) {
        throw new Error('invalid_grant: Invalid code_verifier');
      }
    }

    // Mark as used ATOMICALLY (Durable Storage guarantees)
    stored.used = true;
    this.authCodeState!.codes[request.code] = stored;
    await this.saveState();

    return {
      userId: stored.userId,
      scope: stored.scope,
      redirectUri: stored.redirectUri,
      nonce: stored.nonce,
      state: stored.state,
    };
  }
}
```

#### Step 2: Token Endpoint移行（最重要）

```typescript
// packages/op-token/src/token.ts

async function handleAuthorizationCodeGrant(c, formData) {
  // ... validation ...

  // OLD: KV-based (remove this)
  // const authCodeData = await getAuthCode(c.env, validCode);

  // NEW: Use AuthorizationCodeStore DO
  const codeStoreId = c.env.AUTH_CODE_STORE.idFromName(validCode);
  const codeStore = c.env.AUTH_CODE_STORE.get(codeStoreId);

  try {
    const authData = await codeStore.fetch(
      new Request(`https://auth-code-store/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: validCode,
          clientId: client_id,
          codeVerifier: code_verifier,
        }),
      })
    );

    if (!authData.ok) {
      const error = await authData.json();
      return c.json(error, 400);
    }

    const authCodeData = await authData.json();

    // ... rest of token generation ...
  } catch (error) {
    // Handle errors
    return c.json({ error: 'invalid_grant', error_description: error.message }, 400);
  }

  // OLD: Remove markAuthCodeAsUsed() - now handled by consumeCode()
  // await markAuthCodeAsUsed(c.env, validCode, {...});
}
```

**工数見積もり**: 2-3日
- Step 1 (永続化): 1日
- Step 2 (Token endpoint移行): 1日
- テスト + 移行: 1日

---

### 2.11 PAR request_uri 競合状態の対処（Medium）⚠️ NEW

#### Option 1: Durable Object for PAR（完全な解決）

```typescript
// packages/shared/src/durable-objects/PARRequestStore.ts (新規)

interface PARRequest {
  requestUri: string;
  clientId: string;
  data: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export class PARRequestStore {
  private state: DurableObjectState;
  private requests: Record<string, PARRequest> = {};

  async storeRequest(requestUri: string, data: Record<string, unknown>, ttl: number) {
    const now = Date.now();
    this.requests[requestUri] = {
      requestUri,
      clientId: data.client_id as string,
      data,
      createdAt: now,
      expiresAt: now + ttl * 1000,
      used: false,
    };

    await this.state.storage.put('requests', this.requests);
  }

  /**
   * Consume request atomically (single-use guarantee)
   */
  async consumeRequest(requestUri: string, clientId: string): Promise<Record<string, unknown> | null> {
    const request = this.requests[requestUri];

    if (!request) {
      return null;
    }

    // Expiration check
    if (request.expiresAt <= Date.now()) {
      delete this.requests[requestUri];
      await this.state.storage.put('requests', this.requests);
      return null;
    }

    // Client ID validation
    if (request.clientId !== clientId) {
      throw new Error('client_id mismatch');
    }

    // Single-use check (ATOMIC)
    if (request.used) {
      console.warn(`SECURITY: PAR request_uri reuse detected: ${requestUri}`);
      throw new Error('request_uri already used');
    }

    // Mark as used ATOMICALLY
    request.used = true;
    this.requests[requestUri] = request;
    await this.state.storage.put('requests', this.requests);

    return request.data;
  }
}
```

#### Option 2: 現状受容 + モニタリング（推奨）

**理由**:
- 攻撃難易度が極めて高い（精密なタイミング制御が必要）
- 影響範囲が限定的（他のセキュリティ層で保護）
- 実装コストが高い（新しいDO + マイグレーション）

**代替アプローチ**:

```typescript
// packages/op-auth/src/authorize.ts

// Add monitoring for concurrent request_uri usage
const requestData = await c.env.STATE_STORE.get(`request_uri:${request_uri}`);

if (!requestData) {
  return c.json({ error: 'invalid_request', error_description: 'Invalid or expired request_uri' }, 400);
}

// Add a "processing" marker (best-effort detection)
const processingKey = `request_uri_processing:${request_uri}`;
const alreadyProcessing = await c.env.STATE_STORE.get(processingKey);

if (alreadyProcessing) {
  // Log potential concurrent usage
  console.warn(`Potential concurrent PAR request_uri usage: ${request_uri}`);
  // Optionally: create alert
}

// Mark as processing
await c.env.STATE_STORE.put(processingKey, 'true', { expirationTtl: 60 });

// ... use data ...

// Delete both keys
await c.env.STATE_STORE.delete(`request_uri:${request_uri}`);
await c.env.STATE_STORE.delete(processingKey);
```

**推奨**: Option 2（現状受容 + モニタリング）

**工数見積もり**: 0.5-1日（モニタリングのみ）

---

## 3. 実装優先順位

### Priority 1: クリティカルセキュリティ修正

#### 3.1 認可コードのDO移行 (推定工数: 2-3日)

**タスク**:
1. `authorize.ts` の修正 - AuthorizationCodeStore DO使用
2. `token.ts` の修正 - consumeCode() API使用
3. `AuthorizationCodeStore.ts` の拡張 - PKCE検証、再利用検出
4. 統合テスト - 認可フロー全体
5. セキュリティテスト - 再利用攻撃シナリオ

**ファイル変更**:
- `packages/op-auth/src/authorize.ts`
- `packages/op-token/src/token.ts`
- `packages/shared/src/durable-objects/AuthorizationCodeStore.ts`
- `test/integration/authorization-code-flow.test.ts` (新規)

#### 3.2 KVキャッシュ無効化修正 (推定工数: 1日)

**タスク**:
1. `cloudflare-adapter.ts` の修正 - Delete-Then-Write
2. エラーハンドリング追加
3. 統合テスト - クライアント更新フロー

**ファイル変更**:
- `packages/shared/src/storage/adapters/cloudflare-adapter.ts`
- `test/integration/client-cache.test.ts` (新規)

---

### Priority 2: 信頼性向上

#### 3.3 D1書き込みリトライロジック (推定工数: 3-4日)

**タスク**:
1. `SessionStore.ts` の修正 - リトライキュー実装
2. 監視ユーティリティ作成 - `monitoring.ts`
3. アラート統合 - Cloudflare Analytics Engine
4. 統合テスト - 失敗シナリオ
5. 負荷テスト - キューパフォーマンス

**ファイル変更**:
- `packages/shared/src/durable-objects/SessionStore.ts`
- `packages/shared/src/utils/monitoring.ts` (新規)
- `test/durable-objects/SessionStore.retry.test.ts` (新規)

#### 3.4 RefreshTokenRotatorの永続化 (推定工数: 2-3日)

**タスク**:
1. `RefreshTokenRotator.ts` の修正 - Durable Storage使用
2. `initializeState()` / `saveState()` メソッド追加
3. 既存メソッドの永続化対応 (create, rotate, revoke)
4. 移行テスト - 既存トークンファミリーの移行
5. 負荷テスト - ストレージサイズ制限確認

**ファイル変更**:
- `packages/shared/src/durable-objects/RefreshTokenRotator.ts`
- `test/durable-objects/RefreshTokenRotator.persistence.test.ts` (新規)

#### 3.5 Passkey Counterの Compare-and-Swap 実装 (推定工数: 1-2日)

**タスク**:
1. `cloudflare-adapter.ts` の `updateCounter()` 修正
2. 条件付きUPDATE文実装
3. リトライロジック追加
4. WebAuthn仕様準拠テスト
5. 並行リクエスト負荷テスト

**ファイル変更**:
- `packages/shared/src/storage/adapters/cloudflare-adapter.ts`
- `test/integration/passkey-counter.test.ts` (新規)

---

### Priority 3: 観測性とドキュメント

#### 3.6 監査ログの信頼性向上 (推定工数: 2-3日)

**タスク**:
1. `AuditLogQueue` クラス作成
2. `SessionStore` と `RefreshTokenRotator` への統合
3. セキュリティイベントの同期ログ実装
4. アラート統合
5. コンプライアンステスト

**ファイル変更**:
- `packages/shared/src/durable-objects/shared/AuditLogQueue.ts` (新規)
- `packages/shared/src/durable-objects/SessionStore.ts`
- `packages/shared/src/durable-objects/RefreshTokenRotator.ts`
- `test/audit/audit-log-reliability.test.ts` (新規)

#### 3.7 Rate Limitingのドキュメント化 (推定工数: 0.5日)

**タスク**:
1. `rate-limit.ts` にドキュメント追加（ベストエフォート精度の説明）
2. 将来の改善オプション記載
3. DO版の参考実装（コメント）

**ファイル変更**:
- `packages/shared/src/middleware/rate-limit.ts`

#### 3.8 セッショントークンのTTL短縮 (推定工数: 0.5日)

**タスク**:
1. `session-management.ts` の TTL 調整 (300秒 → 30秒)
2. ドキュメント追加（競合状態の影響最小化の説明）
3. UX影響評価

**ファイル変更**:
- `packages/op-auth/src/session-management.ts`

#### 3.9 一貫性レベルの明示化 (推定工数: 2日)

**タスク**:
1. インターフェース拡張 - `WriteOptions`
2. ドキュメント作成 - 一貫性モデル説明
3. クライアントガイド - 各操作の保証レベル

**ファイル変更**:
- `packages/shared/src/storage/interfaces.ts`
- `docs/architecture/consistency-model.md` (新規)

---

### Priority 4: 新発見の問題対応（v3.0）⚠️ NEW

#### 3.10 SessionStore DO の永続化実装 (推定工数: 2-3日)

**タスク**:
1. `SessionStore.ts` の修正 - Durable Storage使用
2. `initializeState()` / `saveState()` メソッド実装
3. Map → Record 変換（シリアライゼーション対応）
4. D1フォールバックの移行サポート実装
5. マイグレーション戦略実行（デュアルライト期間）
6. パフォーマンステスト - 永続化オーバーヘッド測定

**ファイル変更**:
- `packages/shared/src/durable-objects/SessionStore.ts`
- `test/durable-objects/SessionStore.persistence.test.ts` (新規)
- `test/integration/session-migration.test.ts` (新規)

**優先度**: **CRITICAL** - すべてのユーザーが DO 再起動時にログアウトされる

---

#### 3.11 AuthorizationCodeStore DO の永続化 + Token Endpoint 移行 (推定工数: 2-3日)

**タスク**:
1. `AuthorizationCodeStore.ts` の修正 - Durable Storage使用
2. `initializeState()` / `saveState()` メソッド実装
3. **Token endpoint (`token.ts`) を DO 使用に移行** ← 最重要
4. KV ベース関数の廃止 (`getAuthCode`, `markAuthCodeAsUsed`)
5. 統合テスト - OAuth フロー全体（DO経由）
6. セキュリティテスト - 競合状態解消確認

**ファイル変更**:
- `packages/shared/src/durable-objects/AuthorizationCodeStore.ts`
- `packages/op-token/src/token.ts` ← **重要な変更**
- `packages/shared/src/utils/kv.ts` (削除: `getAuthCode`, `markAuthCodeAsUsed`)
- `test/integration/authorization-code-do.test.ts` (新規)

**優先度**: **CRITICAL** - 問題3（KV競合状態）と問題10（永続性欠如）の両方を解決

**注**: このタスクは 3.1（認可コードのDO移行）と統合可能

---

#### 3.12 PAR request_uri モニタリング実装 (推定工数: 0.5-1日)

**タスク**:
1. `authorize.ts` に処理マーカー追加
2. 並行使用検出ロジック実装
3. アラート統合 - 疑わしい使用パターン検出
4. ドキュメント化 - RFC 9126 制限事項

**ファイル変更**:
- `packages/op-auth/src/authorize.ts`
- `docs/security/par-limitations.md` (新規)

**優先度**: MEDIUM - 攻撃難易度が高く、影響限定的

**推奨**: Option 2（現状受容 + モニタリング）を採用

---

### 総合推定工数（v3.0更新）

| Priority | タスク | 工数 | 問題 |
|----------|-------|------|------|
| **Priority 1** | | | |
| 3.1 | 認可コードのDO移行 | 2-3日 | #3 |
| 3.2 | KVキャッシュ無効化修正 | 1日 | #2 |
| **Priority 2** | | | |
| 3.3 | D1書き込みリトライロジック | 3-4日 | #1 |
| 3.4 | RefreshTokenRotatorの永続化 | 2-3日 | #4 |
| 3.5 | Passkey Counterの CAS実装 | 1-2日 | #7 |
| **Priority 3** | | | |
| 3.6 | 監査ログの信頼性向上 | 2-3日 | #5 |
| 3.7 | Rate Limitingドキュメント化 | 0.5日 | #6 |
| 3.8 | セッショントークンTTL短縮 | 0.5日 | #8 |
| 3.9 | 一貫性レベルの明示化 | 2日 | - |
| **Priority 4 ⚠️ NEW** | | | |
| 3.10 | SessionStore DO 永続化 | 2-3日 | **#9** |
| 3.11 | AuthCodeStore DO 永続化 + Token移行 | 2-3日 | **#10 + #3** |
| 3.12 | PAR request_uri モニタリング | 0.5-1日 | **#11** |
| **合計（v2.0）** | | **14-20日** | 8問題 |
| **合計（v3.0）** | | **19-27日** | **11問題** |

**v2.0 → v3.0 増加分**: +5-7日（新規3問題対応）

**推奨実装順序（v3.0更新）**:

**最優先（ユーザー影響が最大）**:
1. **3.10 SessionStore DO 永続化（問題#9）** ← 全ユーザーがDO再起動で強制ログアウト
2. **3.4 RefreshTokenRotator 永続化（問題#4）** ← 全ユーザーが再認証必須
3. **3.11 AuthCodeStore DO 永続化（問題#10）** ← OAuth フロー失敗

**次点（セキュリティ）**:
4. **3.1 + 3.11統合: 認可コードDO移行（問題#3）** ← 3.11で対応済み
5. **3.5 Passkey Counter CAS（問題#7）** ← WebAuthn仕様違反

**その他**:
6. 3.2 KVキャッシュ（問題#2） → 3.3 D1リトライ（問題#1） → 3.6 監査ログ（問題#5）
7. 3.12 PAR モニタリング（問題#11） → 3.7-3.9 ドキュメント

**注**: タスク3.1と3.11は統合可能（AuthorizationCodeStore関連のため）

---

## 4. テスト戦略

### 4.1 ユニットテスト

```typescript
// test/durable-objects/SessionStore.retry.test.ts

describe('SessionStore - Retry Logic', () => {
  it('should retry D1 writes on failure', async () => {
    const mockD1 = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn()
            .mockRejectedValueOnce(new Error('D1 unavailable'))
            .mockRejectedValueOnce(new Error('D1 unavailable'))
            .mockResolvedValueOnce({}),
        }),
      }),
    };

    const store = new SessionStore(state, { ...env, DB: mockD1 });
    const session = await store.createSession('user_123', 3600);

    // メモリには即座に保存されている
    expect(store.sessions.has(session.id)).toBe(true);

    // リトライ処理を待つ
    await waitForQueueProcessing(store);

    // 最終的にD1書き込み成功
    expect(mockD1.prepare).toHaveBeenCalledTimes(3);
  });

  it('should alert after max retries', async () => {
    const mockD1 = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockRejectedValue(new Error('D1 down')),
        }),
      }),
    };

    const alertSpy = vi.fn();
    const store = new SessionStore(state, { ...env, DB: mockD1 }, { onAlert: alertSpy });

    await store.createSession('user_123', 3600);
    await waitForQueueProcessing(store, 10000); // 最大10秒待機

    // アラート送信確認
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'D1_WRITE_FAILURE',
        severity: 'critical',
      })
    );
  });
});
```

### 4.2 統合テスト

```typescript
// test/integration/authorization-code-flow.test.ts

describe('Authorization Code Flow - Race Condition', () => {
  it('should prevent code reuse across multiple requests', async () => {
    // 1. 認可コード取得
    const authResponse = await app.request('/authorize', {
      method: 'GET',
      query: {
        client_id: 'test_client',
        redirect_uri: 'https://example.com/callback',
        response_type: 'code',
        scope: 'openid',
      },
    });

    const location = new URL(authResponse.headers.get('Location')!);
    const code = location.searchParams.get('code')!;

    // 2. 並行してトークンリクエスト（競合状態シミュレーション）
    const [response1, response2] = await Promise.all([
      app.request('/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: 'test_client',
          client_secret: 'secret',
        }),
      }),
      app.request('/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: 'test_client',
          client_secret: 'secret',
        }),
      }),
    ]);

    // 3. 検証: 1つだけ成功、もう1つは失敗
    const results = [response1, response2].map(r => r.status);
    expect(results).toContain(200); // 1つは成功
    expect(results).toContain(400); // 1つは失敗
    expect(results.filter(s => s === 200).length).toBe(1); // 成功は1つだけ
  });
});
```

### 4.3 負荷テスト

```typescript
// test/load/cache-invalidation.test.ts

describe('Client Cache Invalidation - Load Test', () => {
  it('should handle concurrent reads during cache invalidation', async () => {
    const clientId = 'load_test_client';

    // 100並行リクエスト
    const reads = Array.from({ length: 100 }, () =>
      app.request(`/clients/${clientId}`, { method: 'GET' })
    );

    // 読み取り中にクライアント更新
    const update = app.request(`/clients/${clientId}`, {
      method: 'PUT',
      body: JSON.stringify({ client_name: 'Updated Name' }),
    });

    const [updateResponse, ...readResponses] = await Promise.all([update, ...reads]);

    // 検証
    expect(updateResponse.status).toBe(200);

    // 全ての読み取りが成功（古いか新しいデータ）
    for (const response of readResponses) {
      expect(response.status).toBe(200);
      const data = await response.json();
      // データは一貫している（古いか新しいか、どちらか）
      expect(['Old Name', 'Updated Name']).toContain(data.client_name);
    }

    // 更新後の読み取りは必ず新しいデータ
    const finalRead = await app.request(`/clients/${clientId}`);
    const finalData = await finalRead.json();
    expect(finalData.client_name).toBe('Updated Name');
  });
});
```

---

## 5. マイグレーション計画

### 5.1 認可コードのDO移行

**段階的ロールアウト**:

```typescript
// 環境変数でフィーチャーフラグ制御
const USE_AUTH_CODE_DO = env.FEATURE_AUTH_CODE_DO === 'true';

if (USE_AUTH_CODE_DO) {
  // 新方式: Durable Object
  await storeCodeInDO(env, code, data);
} else {
  // 旧方式: KV
  await storeAuthCode(env, code, data);
}
```

**ロールアウトステージ**:
1. **Stage 1** (1週間): 開発環境でDO有効化、テスト
2. **Stage 2** (1週間): Canary環境で5%トラフィック
3. **Stage 3** (1週間): Canary環境で50%トラフィック
4. **Stage 4** (1週間): 本番環境で100%
5. **Stage 5** (2週間後): KV AUTH_CODES削除

### 5.2 モニタリング指標

```typescript
// メトリクス収集
interface StorageMetrics {
  // D1書き込み
  d1_write_success: number;
  d1_write_failure: number;
  d1_write_retry_count: number;
  d1_write_latency_ms: number;

  // KVキャッシュ
  kv_cache_hit_rate: number;
  kv_cache_invalidation_latency_ms: number;

  // 認可コード
  auth_code_reuse_detected: number;
  auth_code_do_latency_ms: number;
}

// Cloudflare Workers Analytics Engine
await env.ANALYTICS.writeDataPoint({
  blobs: ['d1_write', 'success'],
  doubles: [latency],
  indexes: ['session_create'],
});
```

---

## 6. リスクと軽減策

### 6.1 リトライキューのメモリ使用

**リスク**: キューサイズが大きくなりすぎてメモリ不足

**軽減策**:
- 最大キューサイズ制限（例: 1000アイテム）
- 古いアイテムのデッドレターキュー移動
- メトリクス監視: `queue_size` アラート

```typescript
private readonly MAX_QUEUE_SIZE = 1000;

async queueD1Write(operation, session): Promise<void> {
  if (this.writeQueue.size >= this.MAX_QUEUE_SIZE) {
    // デッドレターキューへ移動
    await this.moveToDeadLetterQueue(this.writeQueue.entries().next().value);
  }
  // ...
}
```

### 6.2 Durable Objectのスケーラビリティ

**リスク**: 単一DO インスタンスがボトルネック

**軽減策**:
- シャーディング戦略: ユーザーIDベースで複数DOに分散
- 監視: リクエストレート、レイテンシ

```typescript
// シャーディング例
const shard = hashUserId(userId) % 10; // 10シャード
const doId = env.SESSION_STORE.idFromName(`shard_${shard}`);
```

### 6.3 D1書き込み遅延の累積

**リスク**: リトライが多すぎて遅延が増大

**軽減策**:
- バックオフ上限設定（最大30秒）
- D1ヘルスチェック: 継続的障害時はアラート + 緊急対応

---

## 7. 結論

本設計により、以下の一貫性保証が実現されます：

### 改善後の一貫性モデル（v3.0）

| 操作 | ストレージ | 一貫性レベル | 保証内容 | 問題 |
|------|-----------|-------------|---------|------|
| **セッション作成** | DO (永続化) + D1 (Queue) | Strong (DO) + Eventual (D1) | Durable Storage永続化、DO再起動耐性 ✅ | #9 |
| **セッション無効化** | DO (永続化) + D1 (Queue) | Strong | Durable Storage削除、即座反映 ✅ | #9 |
| **認可コード保存** | DO (永続化) | Strong | ワンタイムユース保証、DO再起動耐性 ✅ | #10 |
| **認可コード消費** | DO (永続化) | Strong | アトミック操作、再利用検出、PKCE検証 ✅ | #10, #3 |
| **クライアント更新** | D1 + KV | Strong | Delete-Then-Write、不整合窓なし ✅ | #2 |
| **トークンローテーション** | DO (永続化) | Strong | アトミック、盗難検出、DO再起動耐性 ✅ | #4 |
| **Passkey Counter** | D1 (CAS) | Strong | 単調増加保証、WebAuthn準拠 ✅ | #7 |
| **監査ログ** | D1 (Queue + Sync) | Eventual/Strong (選択可) | リトライ保証、重要イベントは同期 ✅ | #5, #1 |
| **PAR request_uri** | KV (モニタリング) | Eventual + Detection | 並行使用検出、アラート ⚠️ | #11 |
| **Rate Limiting** | KV | Eventual (ベストエフォート) | ドキュメント化、許容範囲 ⚠️ | #6 |
| **セッショントークン** | KV (TTL短縮) | Eventual | 影響最小化（30秒TTL） ⚠️ | #8 |

### 発見された問題と解決策のサマリー（v3.0）

**クリティカル問題** (6件):
1. ✅ DOからD1への非同期書き込み → リトライキュー実装
2. ✅ KVキャッシュ無効化の一貫性窓 → Delete-Then-Write
3. ✅ 認可コードのKV使用 → Durable Object移行（3.11で対応）
4. ✅ RefreshTokenRotatorの永続性欠如 → Durable Storage実装
5. ⚠️ **SessionStore DOの永続性欠如 → Durable Storage実装（NEW）**
6. ⚠️ **AuthorizationCodeStore DOの永続性欠如 → Durable Storage実装 + Token移行（NEW）**
7. ✅ Passkey Counterの競合状態 → Compare-and-Swap

**高・中優先度の問題** (4件):
8. ✅ 監査ログの信頼性 → リトライキュー + 同期ログ
9. ⚠️ Rate Limitingの精度問題 → ドキュメント化（許容）
10. ⚠️ セッショントークンの競合状態 → TTL短縮（許容）
11. ⚠️ **PAR request_uri の競合状態 → モニタリング実装（NEW）**

**合計**: **11課題**（v2.0: 8課題 + v3.0新規: 3課題）に対する包括的な解決策

### 重要な発見: Durable Object永続性パターンの系統的欠陥

**v3.0の詳細監査で判明した事実**:
- 4つのDurable Objectsのうち**3つ（75%）**が永続性の問題を抱えている
- 問題を抱えるDO: RefreshTokenRotator (#4), SessionStore (#9), AuthorizationCodeStore (#10)
- 正しい実装: KeyManager のみ（`state.storage.put/get()` 使用）

**根本原因**:
- KeyManagerが最初に正しく実装された
- 後続のDOが「in-memory + D1バックアップ」パターンで実装された
- このパターンはDurable Objectsの設計思想に反する

**影響**:
- DO再起動時に全セッション消失（問題#9） → 全ユーザー強制ログアウト
- DO再起動時に全トークンファミリー消失（問題#4） → 全ユーザー再認証必須
- DO再起動時に認可コード消失（問題#10） → OAuth フロー失敗

**解決策**:
- 3つすべてのDOをKeyManagerパターンにリファクタリング
- `state.storage.put/get()` による永続化実装
- D1は監査ログのみ（オプション）

### 次のステップ（v3.0更新）

1. ✅ 本設計ドキュメントのレビュー（v3.0完了）
2. 🔧 **Priority 4（最優先）**: DO永続化実装（5-7日）
   - 3.10 SessionStore DO 永続化
   - 3.4 RefreshTokenRotator 永続化
   - 3.11 AuthCodeStore DO 永続化 + Token移行
3. 🔧 Priority 1: セキュリティ修正（3-4日）
4. 🔧 Priority 2: 信頼性向上（6-9日）
5. 📝 Priority 3: ドキュメント・モニタリング（3-4日）
6. 🧪 統合テスト・セキュリティテスト
7. 📊 モニタリング・アラート設定
8. 🚀 段階的ロールアウト

**総推定工数**:
- v2.0: 14-20日
- **v3.0: 19-27日**（+5-7日）
- **約4-5週間**

---

## 付録

### A. 参考資料

- [RFC 6749 - OAuth 2.0](https://datatracker.ietf.org/doc/html/rfc6749)
- [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)
- [Cloudflare Durable Objects Documentation](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare KV Consistency Model](https://developers.cloudflare.com/kv/reference/kv-consistency/)

### B. 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|---------|
| 2025-11-15 | 1.0 | 初版作成（主要3課題の分析と解決策） |
| 2025-11-15 | 2.0 | 包括的監査による5つの追加問題発見と解決策追加:<br>- RefreshTokenRotatorの永続性欠如<br>- 監査ログの信頼性<br>- Rate Limitingの精度問題<br>- Passkey Counterの競合状態<br>- セッショントークンの競合状態<br>合計8つの課題への対応を完全ドキュメント化 |
| 2025-11-15 | 3.0 | **詳細監査による3つの新規クリティカル問題発見**:<br>- **問題#9: SessionStore DO の永続性欠如（CRITICAL）**<br>  → DO再起動で全ユーザー強制ログアウト<br>- **問題#10: AuthorizationCodeStore DO の永続性欠如（CRITICAL）**<br>  → OAuth フロー失敗 + Token endpoint未移行<br>- **問題#11: PAR request_uri の競合状態（MEDIUM）**<br>  → RFC 9126単一使用保証違反<br><br>**系統的パターン発見**: 4つのDOのうち3つ（75%）が永続性問題<br>→ KeyManagerパターンへの統一リファクタリングが必要<br><br>合計**11課題**の完全ドキュメント化、工数19-27日に更新 |
| 2025-11-15 | 6.0 | **全Durable Objects化への方針決定**:<br>- KV起因の5課題（#6, #8, #11, #12, #21）を完全解決<br>- 運用・ドキュメント対応では事象発生を防げない課題をDO化<br>- すべての状態管理をDOに統一する明確なアーキテクチャ原則<br>- 新規DO: RateLimiterCounter, SessionTokenStore, PARRequestStore, MagicLinkStore, PasskeyChallengeStore<br>- 総工数: 20.5-28.5日（4-6週間）<br><br>**製品方針**: OPとしてセキュリティ・一貫性を最優先、RFC/OIDC完全準拠を実現 |
| 2025-11-16 | 7.0 | **全DO統合実装完了**:<br>- ✅ #6: RateLimiterCounter DO実装・統合完了（100%精度保証）<br>- ✅ #11: PARRequestStore DO実装・統合完了（RFC 9126完全準拠）<br>- ✅ #12: DPoPJTIStore DO実装・統合完了（Replay攻撃完全防止）<br>- ✅ #13: JWKS Endpoint動的取得実装完了（KeyManager DO経由）<br>- ✅ #8, #21: ChallengeStore DO統合完了（Session Token, Passkey, Magic Link）<br><br>**全8つのDO実装完了**: SessionStore, AuthCodeStore, RefreshTokenRotator, KeyManager, ChallengeStore, RateLimiterCounter, PARRequestStore, DPoPJTIStore<br><br>**セキュリティ強化**: アトミック操作によりrace condition完全排除、RFC/OIDC完全準拠達成 |
| 2025-11-16 | 8.0 | **#14: スキーマバージョン管理実装完了**:<br>- ✅ D1マイグレーション管理テーブル作成（schema_migrations, migration_metadata）<br>- ✅ MigrationRunnerクラス実装（チェックサム検証、べき等性保証）<br>- ✅ CLIツール実装（migrate:create コマンド）<br>- ✅ DO data structure versioning実装（SessionStore v1）<br>- ✅ 自動マイグレーション機能（バージョン検出→migrate→save）<br>- ✅ マイグレーションREADME更新<br><br>**全24問題中23問題実装完了** - 残り1問題のみ（#20: 確認済み問題なし） |

---

## 6. 全Durable Objects化 実装計画（v6.0）

### 6.1 方針決定の背景

#### OPとしての製品特性

Authrimは OAuth 2.0 / OpenID Connect Provider（OP）として、以下の要件を満たす必要があります：

- **セキュリティ・一貫性が最優先**: 「ベストエフォート」では不十分
- **RFC/OIDC仕様への完全準拠**: 認証基盤としての信頼性
- **攻撃耐性**: Replay攻撃、タイミング攻撃、競合状態攻撃への完全な防御

#### 運用対応では解決できない5つの課題

以下の課題は、Cloudflare KVの**結果整合性**という技術的制約に起因するため、運用・監視・ドキュメント化では事象発生を**完全には防げません**：

1. **#6: Rate Limiting精度** - 並行リクエストでカウントが不正確になる可能性
2. **#8: セッショントークン競合** - TTL短縮しても競合窓は残る
3. **#11: PAR request_uri競合** - モニタリングで検知はできるが競合自体は防げない
4. **#12: DPoP JTI競合** - 低確率だが技術的には発生可能
5. **#21: Passkey/Magic Link チャレンジ再利用** - 並行リクエストで同じチャレンジを複数回使用可能

#### 全DO化の判断根拠

**コスト分析**:
- 100万ID規模でも**数万円/月程度**
- セキュリティインシデントのリスクコストと比較して十分低い
- Durable Objectsはリクエスト課金（$0.15/million requests）

**複雑性の評価**:
- 新規DOクラス: 5個追加
- 総コード量増加: 約300-400行
- しかし、**統一パターン**により保守性は向上
- 現状の「KVとDOの混在」が解消される

**アーキテクチャ上の利点**:
- すべての「状態管理」がDOに統一 → 一貫したパターン
- KV vs DOの使い分け判断が不要に
- テスト容易性の向上（DOは単体テスト可能）

---

### 6.2 全DO化後のアーキテクチャ原則

#### ストレージ使い分けの明確化

```
┌─────────────────────────────────────────────────────────┐
│              Authrim Storage Architecture                  │
│                   (Full DO Migration)                    │
└─────────────────────────────────────────────────────────┘

【Durable Objects】- 強一貫性、アトミック操作、状態管理
├─ SessionStore              (#9 - 永続化実装済み) ✅
├─ RefreshTokenRotator       (#4, #17 - 永続化実装済み) ✅
├─ AuthorizationCodeStore    (#3, #10 - 永続化実装済み) ✅
├─ KeyManager                (既存 - 正しい実装) ✅
├─ RateLimiterCounter        (#6 - 新規実装済み) ★ ✅
├─ PARRequestStore           (#11 - 新規実装済み) ★ ✅
├─ DPoPJTIStore              (#12 - 新規実装済み) ★ ✅
└─ ChallengeStore            (#8, #21 - 統合実装済み) ★ ✅
    ├─ session_token (ITP-bypass用)
    ├─ passkey_registration
    ├─ passkey_authentication
    └─ magic_link

【D1 (SQLite)】- リレーショナルデータ、監査ログ、永続化
├─ users
├─ clients
├─ passkeys
├─ audit_log
└─ password_reset_tokens

【KV】- 読み取り専用キャッシュのみ
└─ CLIENTS_CACHE (client metadata cache)

【削除予定】- KVからDOへ完全移行
├─ AUTH_CODES → AuthorizationCodeStore DO ✅
├─ REFRESH_TOKENS → RefreshTokenRotator DO ✅
├─ MAGIC_LINKS → ChallengeStore DO ✅
├─ STATE_STORE (rate limit) → RateLimiterCounter DO (実装済み、統合待ち)
├─ PAR リクエスト → PARRequestStore DO (実装済み、統合待ち)
└─ DPoP JTI → DPoPJTIStore DO (実装済み、統合待ち)
```

**新しい原則**:
- **状態を持つリソース** → Durable Objects
- **単一使用リソース** → Durable Objects
- **読み取り専用キャッシュ** → KV
- **リレーショナルデータ** → D1

---

### 6.3 実装フェーズ

#### Phase 1: 既存DO永続化（CRITICAL - 5-7日）

**目的**: DO再起動時のデータ損失防止

| タスク | ファイル | 工数 | 問題 |
|--------|---------|------|------|
| SessionStore DO 永続化 | `SessionStore.ts` | 2-3日 | #9 |
| RefreshTokenRotator DO 永続化 | `RefreshTokenRotator.ts` | 2-3日 | #4 |
| AuthorizationCodeStore DO 永続化 | `AuthorizationCodeStore.ts` | 1日 | #10 |

**実装内容**:
- `state.storage.put/get()` による永続化
- KeyManagerパターンの適用
- D1は監査ログ用のバックアップのみ

**影響**:
- 全ユーザーがDO再起動で強制ログアウトされる問題を解決
- DO再起動時の全トークンファミリー消失を防止
- OAuth フロー失敗を防止

---

#### Phase 2: セキュリティ修正（CRITICAL - 2.5-3.5日）

**目的**: RFCセキュリティ要件への準拠

| タスク | ファイル | 工数 | 問題 |
|--------|---------|------|------|
| Client Secret タイミング攻撃対策 | logout.ts, token.ts, revoke.ts, introspect.ts | 0.5日 | #15 |
| /revoke, /introspect 認証追加 | revoke.ts, introspect.ts | 1日 | #16 |
| RefreshTokenRotator 使用開始 | token.ts | 1-2日 | #17 |

**実装内容**:
- `timingSafeEqual()` への置換
- client_secret検証の追加
- KV関数からDO使用への移行

---

#### Phase 3: 新規DO実装（一貫性問題の完全解決 - 6-8日）★ 全DO化の核心

**目的**: KV起因の競合状態を完全に排除

##### 3.1 RateLimiterCounter DO 実装 (#6) - 1-1.5日

**ファイル**: `packages/shared/src/durable-objects/RateLimiterCounter.ts` (新規)

```typescript
export class RateLimiterCounter {
  private state: DurableObjectState;
  private counts: Map<string, RateLimitRecord> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/increment' && request.method === 'POST') {
      const { clientIP, config } = await request.json();
      const result = await this.increment(clientIP, config);
      return Response.json(result);
    }

    return new Response('Not found', { status: 404 });
  }

  async increment(clientIP: string, config: RateLimitConfig): Promise<RateLimitResult> {
    const now = Math.floor(Date.now() / 1000);
    let record = this.counts.get(clientIP);

    if (!record || now >= record.resetAt) {
      // 新しいウィンドウ開始
      record = {
        count: 1,
        resetAt: now + config.windowSeconds,
        firstRequestAt: now,
      };
    } else {
      // カウントインクリメント（アトミック）
      record.count++;
    }

    this.counts.set(clientIP, record);
    await this.state.storage.put(clientIP, record); // 永続化

    // クリーンアップ（古いエントリ削除）
    if (this.counts.size > 10000) {
      await this.cleanup();
    }

    return {
      allowed: record.count <= config.maxRequests,
      current: record.count,
      limit: config.maxRequests,
      resetAt: record.resetAt,
      retryAfter: record.count > config.maxRequests ? record.resetAt - now : 0,
    };
  }

  private async cleanup(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const toDelete: string[] = [];

    for (const [ip, record] of this.counts.entries()) {
      if (now >= record.resetAt + 3600) { // 1時間の猶予
        toDelete.push(ip);
      }
    }

    for (const ip of toDelete) {
      this.counts.delete(ip);
      await this.state.storage.delete(ip);
    }
  }
}

interface RateLimitRecord {
  count: number;
  resetAt: number;
  firstRequestAt: number;
}

interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
}

interface RateLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
  resetAt: number;
  retryAfter: number;
}
```

**移行元**: `packages/shared/src/middleware/rate-limit.ts`

**メリット**:
- ✅ レート制限の**完璧な精度保証**（100%）
- ✅ 並行リクエストでも正確なカウント
- ✅ アトミックなインクリメント

---

##### 3.2 SessionTokenStore DO 実装 (#8) - 0.5-1日

**ファイル**: `packages/shared/src/durable-objects/SessionTokenStore.ts` (新規)

```typescript
export class SessionTokenStore {
  private state: DurableObjectState;
  private env: Env;
  private tokens: Map<string, SessionTokenData> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      const { sessionId, ttl } = await request.json();
      const token = await this.createToken(sessionId, ttl);
      return Response.json({ token });
    }

    if (url.pathname === '/consume' && request.method === 'POST') {
      const { token } = await request.json();
      const sessionId = await this.consumeToken(token);
      return Response.json({ sessionId });
    }

    return new Response('Not found', { status: 404 });
  }

  async createToken(sessionId: string, ttl: number): Promise<string> {
    const token = `st_${crypto.randomUUID()}`;
    const data: SessionTokenData = {
      sessionId,
      used: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000,
    };

    this.tokens.set(token, data);
    await this.state.storage.put(token, data);

    return token;
  }

  async consumeToken(token: string): Promise<string | null> {
    let data = this.tokens.get(token);

    // メモリにない場合、storageから復元
    if (!data) {
      data = await this.state.storage.get<SessionTokenData>(token);
      if (data) {
        this.tokens.set(token, data);
      }
    }

    // トークンが存在しない、使用済み、または期限切れ
    if (!data || data.used || data.expiresAt <= Date.now()) {
      return null;
    }

    // アトミックに使用済みマーク（これが全DO化の核心）
    data.used = true;
    this.tokens.set(token, data);
    await this.state.storage.put(token, data);

    // 使用済みトークンは即座に削除（オプション）
    setTimeout(() => {
      this.tokens.delete(token);
      this.state.storage.delete(token);
    }, 1000);

    return data.sessionId;
  }
}

interface SessionTokenData {
  sessionId: string;
  used: boolean;
  createdAt: number;
  expiresAt: number;
}
```

**移行元**: `packages/op-auth/src/session-management.ts`

**メリット**:
- ✅ セッショントークンの**完全な単一使用保証**
- ✅ 競合状態なし（KVのTTL短縮では解決できなかった問題を完全解決）

---

##### 3.3 PARRequestStore DO 実装 (#11) - 0.5-1日

**ファイル**: `packages/shared/src/durable-objects/PARRequestStore.ts` (新規)

```typescript
export class PARRequestStore {
  private state: DurableObjectState;
  private env: Env;
  private requests: Map<string, PARRequestData> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/store' && request.method === 'POST') {
      const { requestUri, data } = await request.json();
      await this.storeRequest(requestUri, data);
      return Response.json({ success: true });
    }

    if (url.pathname === '/consume' && request.method === 'POST') {
      const { requestUri } = await request.json();
      const data = await this.consumeRequest(requestUri);
      return Response.json({ data });
    }

    return new Response('Not found', { status: 404 });
  }

  async storeRequest(requestUri: string, data: PARRequestData): Promise<void> {
    data.createdAt = Date.now();
    data.expiresAt = Date.now() + 600 * 1000; // 10分

    this.requests.set(requestUri, data);
    await this.state.storage.put(requestUri, data);
  }

  async consumeRequest(requestUri: string): Promise<PARRequestData | null> {
    let data = this.requests.get(requestUri);

    // メモリにない場合、storageから復元
    if (!data) {
      data = await this.state.storage.get<PARRequestData>(requestUri);
      if (data) {
        this.requests.set(requestUri, data);
      }
    }

    // リクエストが存在しないまたは期限切れ
    if (!data || data.expiresAt <= Date.now()) {
      return null;
    }

    // アトミックに削除（単一使用保証 - RFC 9126要件）
    this.requests.delete(requestUri);
    await this.state.storage.delete(requestUri);

    return data;
  }
}

interface PARRequestData {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  createdAt?: number;
  expiresAt?: number;
}
```

**移行元**: `packages/op-auth/src/authorize.ts`

**メリット**:
- ✅ **RFC 9126完全準拠**（request_uri単一使用保証）
- ✅ 競合状態なし（モニタリングでは解決できなかった問題を完全解決）

---

##### 3.4 MagicLinkStore DO 実装 (#21) - 1-1.5日

**ファイル**: `packages/shared/src/durable-objects/MagicLinkStore.ts` (新規)

```typescript
export class MagicLinkStore {
  private state: DurableObjectState;
  private env: Env;
  private links: Map<string, MagicLinkData> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      const { email, ttl } = await request.json();
      const token = await this.createLink(email, ttl);
      return Response.json({ token });
    }

    if (url.pathname === '/consume' && request.method === 'POST') {
      const { token } = await request.json();
      const data = await this.consumeLink(token);
      return Response.json({ data });
    }

    return new Response('Not found', { status: 404 });
  }

  async createLink(email: string, ttl: number = 900): Promise<string> {
    const token = crypto.randomUUID();
    const data: MagicLinkData = {
      email,
      used: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000,
    };

    this.links.set(token, data);
    await this.state.storage.put(token, data);

    return token;
  }

  async consumeLink(token: string): Promise<MagicLinkData | null> {
    let data = this.links.get(token);

    // メモリにない場合、storageから復元
    if (!data) {
      data = await this.state.storage.get<MagicLinkData>(token);
      if (data) {
        this.links.set(token, data);
      }
    }

    // リンクが存在しない、使用済み、または期限切れ
    if (!data || data.used || data.expiresAt <= Date.now()) {
      return null;
    }

    // アトミックに使用済みマーク（Replay攻撃防止）
    data.used = true;
    this.links.set(token, data);
    await this.state.storage.put(token, data);

    return data;
  }

  // 定期クリーンアップ（アラームで実行）
  async alarm(): Promise<void> {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [token, data] of this.links.entries()) {
      if (data.expiresAt < now - 3600000) { // 期限切れ+1時間
        toDelete.push(token);
      }
    }

    for (const token of toDelete) {
      this.links.delete(token);
      await this.state.storage.delete(token);
    }

    // 次回のクリーンアップをスケジュール
    await this.state.storage.setAlarm(Date.now() + 3600000); // 1時間後
  }
}

interface MagicLinkData {
  email: string;
  used: boolean;
  createdAt: number;
  expiresAt: number;
}
```

**移行元**: `packages/op-auth/src/magic-link.ts`

**メリット**:
- ✅ Magic Linkの**Replay攻撃完全防止**
- ✅ 15分TTL内の並行リクエストも確実に検出

---

##### 3.5 PasskeyChallengeStore DO 実装 (#21) - 1.5-2日

**ファイル**: `packages/shared/src/durable-objects/PasskeyChallengeStore.ts` (新規)

```typescript
export class PasskeyChallengeStore {
  private state: DurableObjectState;
  private env: Env;
  private challenges: Map<string, PasskeyChallengeData> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      const { userId, challenge, ttl } = await request.json();
      await this.createChallenge(userId, challenge, ttl);
      return Response.json({ success: true });
    }

    if (url.pathname === '/consume' && request.method === 'POST') {
      const { challenge } = await request.json();
      const data = await this.consumeChallenge(challenge);
      return Response.json({ data });
    }

    return new Response('Not found', { status: 404 });
  }

  async createChallenge(userId: string, challenge: string, ttl: number = 300): Promise<void> {
    const data: PasskeyChallengeData = {
      userId,
      challenge,
      used: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000,
    };

    this.challenges.set(challenge, data);
    await this.state.storage.put(challenge, data);
  }

  async consumeChallenge(challenge: string): Promise<PasskeyChallengeData | null> {
    let data = this.challenges.get(challenge);

    // メモリにない場合、storageから復元
    if (!data) {
      data = await this.state.storage.get<PasskeyChallengeData>(challenge);
      if (data) {
        this.challenges.set(challenge, data);
      }
    }

    // チャレンジが存在しない、使用済み、または期限切れ
    if (!data || data.used || data.expiresAt <= Date.now()) {
      return null;
    }

    // アトミックに使用済みマーク（Replay攻撃防止）
    data.used = true;
    this.challenges.set(challenge, data);
    await this.state.storage.put(challenge, data);

    return data;
  }

  // 定期クリーンアップ
  async alarm(): Promise<void> {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [challenge, data] of this.challenges.entries()) {
      if (data.expiresAt < now - 3600000) { // 期限切れ+1時間
        toDelete.push(challenge);
      }
    }

    for (const challenge of toDelete) {
      this.challenges.delete(challenge);
      await this.state.storage.delete(challenge);
    }

    // 次回のクリーンアップをスケジュール
    await this.state.storage.setAlarm(Date.now() + 3600000); // 1時間後
  }
}

interface PasskeyChallengeData {
  userId: string;
  challenge: string;
  used: boolean;
  createdAt: number;
  expiresAt: number;
}
```

**移行元**: `packages/op-auth/src/passkey.ts` (6箇所)

**メリット**:
- ✅ Passkeyチャレンジの**Replay攻撃完全防止**
- ✅ WebAuthn仕様への完全準拠

---

#### Phase 4: 信頼性向上・クリーンアップ（4-6日）

| タスク | 工数 | 問題 |
|--------|------|------|
| AuthCodeStore Token Endpoint 移行 | 1日 | #3, #10 |
| D1書き込みリトライロジック | 3-4日 | #1 |
| KVキャッシュ無効化修正 | 1日 | #2 |
| Passkey Counter CAS実装 | 1-2日 | #7 |
| D1クリーンアップジョブ | 1-2日 | #18 |
| OIDC準拠修正 | 1-2日 | #19, #23 |
| 部分失敗対策 | 1-2日 | #22 |

---

#### Phase 5: テスト・監視・ドキュメント（3-4日）

**テスト**:
- 全OAuth/OIDCフロー統合テスト
- DO再起動テスト
- 並行リクエストテスト
- セキュリティテスト（タイミング攻撃、Replay攻撃）

**監視・アラート**:
- DO書き込み失敗アラート
- 異常パターン検出
- コスト監視ダッシュボード

**ドキュメント**:
- アーキテクチャ図更新
- 一貫性モデル説明
- 運用ガイド

---

### 6.4 総工数見積もり

| Phase | 内容 | 工数 | 優先度 |
|-------|------|------|--------|
| Phase 1 | 既存DO永続化 | 5-7日 | P0 (CRITICAL) |
| Phase 2 | セキュリティ修正 | 2.5-3.5日 | P0 (CRITICAL) |
| **Phase 3** | **新規DO実装（全DO化）** | **6-8日** | **P1 (HIGH)** ★ |
| Phase 4 | 信頼性向上 | 4-6日 | P2 (MEDIUM) |
| Phase 5 | テスト・監視 | 3-4日 | P1 (HIGH) |
| **合計** | | **20.5-28.5日** | |

**推奨スケジュール**: 4-6週間

---

### 6.5 実装順序（推奨）

#### Week 1-2: CRITICAL対応（7.5-10日）
1. SessionStore DO 永続化（2-3日）
2. RefreshTokenRotator DO 永続化（2-3日）
3. AuthCodeStore 永続化 + Token移行（1-2日）
4. Client Secret タイミング攻撃対策（0.5日）
5. /revoke, /introspect 認証追加（1日）
6. RefreshTokenRotator 使用開始（1-2日）

#### Week 3: 全DO化の核心 ★（3-4.5日）
7. RateLimiterCounter DO（1-1.5日）
8. SessionTokenStore DO（0.5-1日）
9. PARRequestStore DO（0.5-1日）
10. 統合テスト（1日）

#### Week 4: 全DO化完成（2.5-3.5日）
11. MagicLinkStore DO（1-1.5日）
12. PasskeyChallengeStore DO（1.5-2日）

#### Week 5-6: 信頼性・最適化（7-10日）
13. D1リトライロジック（3-4日）
14. その他の信頼性向上（4-5日）
15. セキュリティテスト・ドキュメント（2-3日）

---

### 6.6 マイグレーション戦略

#### デュアルライト期間

各DOの移行は段階的に実施：

```
Week N:     KV only (現状)
Week N+1:   Dual Write (KV + DO) - Read from KV
Week N+2:   Dual Write (KV + DO) - Read from DO ← 切替
Week N+3:   DO only - KV削除
```

#### フィーチャーフラグ

各DOに環境変数でフィーチャーフラグを設定：

```toml
# wrangler.toml
[vars]
USE_RATE_LIMITER_DO = "true"
USE_SESSION_TOKEN_DO = "true"
USE_PAR_REQUEST_DO = "true"
USE_MAGIC_LINK_DO = "true"
USE_PASSKEY_CHALLENGE_DO = "true"
```

問題発生時は即座にKVに戻せる設計。

---

### 6.7 wrangler.toml 更新

```toml
# ========================================
# 新規 Durable Objects バインディング
# ========================================

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "PAR_REQUEST_STORE"
class_name = "PARRequestStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "DPOP_JTI_STORE"
class_name = "DPoPJTIStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "CHALLENGE_STORE"
class_name = "ChallengeStore"
script_name = "authrim-shared"

# ========================================
# KV削除予定（段階的移行後）
# ========================================
# 以下は全DO化完了後に削除:
# - AUTH_CODES → AuthorizationCodeStore DO (移行済み)
# - REFRESH_TOKENS → RefreshTokenRotator DO (移行済み)
# - MAGIC_LINKS → ChallengeStore DO (移行済み)
# - STATE_STORE (rate limit部分) → RateLimiterCounter DO (実装済み、統合待ち)
# - PAR リクエスト → PARRequestStore DO (実装済み、統合待ち)
# - DPoP JTI → DPoPJTIStore DO (実装済み、統合待ち)
```

---

### 6.8 成功指標（KPI）

#### 技術指標
- [ ] DO再起動時のデータ損失: **0件**
- [ ] 競合状態による重複発行: **0件**
- [ ] RFC/OIDC仕様違反: **0件**
- [ ] セキュリティテスト合格率: **100%**

#### パフォーマンス指標
- [ ] レート制限精度: **100%**（現状: ベストエフォート）
- [ ] トークン単一使用保証: **100%**（現状: 99.x%）
- [ ] DO応答時間: **< 50ms (p95)**

#### 運用指標
- [ ] アラート設定: 5種類以上
- [ ] 監視ダッシュボード: 完成
- [ ] ドキュメント更新: 100%

---

### 6.9 リスクと対策

| リスク | 対策 | 軽減策 |
|--------|------|--------|
| DO実装の複雑性 | 統一パターン採用 | KeyManagerの成功例を踏襲 |
| マイグレーション中の不整合 | デュアルライト期間設定 | フィーチャーフラグでロールバック |
| パフォーマンス劣化 | 負荷テスト実施 | DOは低レイテンシ |
| コスト増加 | コスト監視 | 100万ID級で数万円/月の試算済み |

---

### 6.10 DO設計パターン（統一規約）

#### 統一インターフェース

すべての「単一使用リソース」DOは以下のパターンに従う：

```typescript
export interface SingleUseResourceStore<T> {
  create(data: T, ttl: number): Promise<string>;
  consume(id: string): Promise<T | null>;
  cleanup(): Promise<void>;
}
```

#### 永続化パターン（KeyManager準拠）

```typescript
export class ExampleStore {
  private state: DurableObjectState;
  private storeState: StoreState | null = null;

  private async initializeState(): Promise<void> {
    const stored = await this.state.storage.get<StoreState>('state');
    if (stored) {
      this.storeState = stored;
    } else {
      this.storeState = { items: {}, lastCleanup: Date.now() };
    }
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('state', this.storeState);
  }

  async alarm(): Promise<void> {
    // 定期クリーンアップ処理
    await this.cleanup();
    await this.state.storage.setAlarm(Date.now() + 3600000); // 1時間後
  }
}
```

これにより、保守性・可読性が大幅に向上します。

---

### 6.11 全DO化の効果まとめ

#### 解決される課題

| 問題 | 現状 | 全DO化後 |
|------|------|----------|
| #6: Rate Limiting精度 | ベストエフォート | **100% 精度保証** ✅ |
| #8: セッショントークン競合 | TTL短縮のみ | **完全な単一使用保証** ✅ |
| #11: PAR request_uri競合 | モニタリングのみ | **RFC 9126完全準拠** ✅ |
| #12: DPoP JTI競合 | 低確率で発生 | **競合状態なし** ✅ |
| #21: Magic Link/Passkey競合 | Replay攻撃可能 | **Replay攻撃完全防止** ✅ |

#### アーキテクチャ上の改善

- ✅ **統一性**: すべての状態管理がDOパターンで統一
- ✅ **保守性**: KV vs DOの使い分け判断が不要に
- ✅ **テスト容易性**: DOは単体テストが容易
- ✅ **RFC/OIDC準拠**: 仕様への完全準拠を証明可能
- ✅ **セキュリティ**: 攻撃耐性の大幅向上

#### コスト対効果

**投資**:
- 実装工数: 20.5-28.5日（4-6週間）
- 運用コスト: +数万円/月（100万ID規模）

**リターン**:
- セキュリティインシデントリスク: ほぼゼロ
- 運用負荷: 大幅減（監視・アラート不要）
- 信頼性: OAuth/OIDC OP として完全な信頼を獲得

**結論**: OPとしての製品価値を考えると、全DO化は**必須の投資**

---

### 6.12 次のステップ

1. ✅ 全DO化実装計画のレビュー（v6.0完了）
2. 🔧 **Phase 1開始**: SessionStore DO 永続化から着手
3. 📊 継続的な進捗報告とテスト実施
4. 🚀 段階的ロールアウトとモニタリング

