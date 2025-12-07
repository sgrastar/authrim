# K6 Cloud Authorization Code 負荷テストガイド

このドキュメントでは、K6 Cloudを使用したAuthorization Code Grant負荷テストの実施方法、発生した問題、およびその解決策を包括的に説明します。

---

## 目次

1. [概要](#概要)
2. [システム構成](#システム構成)
3. [問題の原因分析](#問題の原因分析)
4. [解決策](#解決策)
5. [テスト実行ガイド](#テスト実行ガイド)
6. [プリセット一覧](#プリセット一覧)
7. [トラブルシューティング](#トラブルシューティング)

---

## 概要

### テスト対象

OAuth 2.0 Authorization Code Grant の `/token` エンドポイント

**特徴:**
- 認可コードは **1回限り使用**（使用後は即時無効化）
- TTL: 8時間
- PKCE (code_verifier) 必須

### テスト結果サマリー

| テスト | RPS | 成功率 | P95 | 備考 |
|--------|-----|--------|-----|------|
| 500 RPS（イテレーションベース） | 500 | **99.9%** | 3,126ms | 1インスタンス実行 |
| 2000 RPS（1回目） | 2,430 | 0% | 901ms | コード既使用 |
| 2000 RPS（2回目・新コード） | 2,752 | 0% | 569ms | 全て400エラー |

---

## システム構成

```
┌─────────────────────────────┐
│  K6 Cloud                   │
│  (Tokyo Region)             │
│  ┌─────────┐ ┌─────────┐    │
│  │Instance0│ │Instance1│ ...│  ← 高RPS時は複数インスタンス
│  └─────────┘ └─────────┘    │
└──────────────┬──────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│  Cloudflare Workers                       │
│  (conformance.authrim.com)               │
│                                           │
│  POST /token                              │
│    ↓                                      │
│  ┌────────────────────────────────────┐  │
│  │ Durable Objects (32 shards)        │  │
│  │ - AuthorizationCodeStore           │  │
│  │ - FNV-1a ハッシュでシャード分散      │  │
│  │ - user_id:client_id でルーティング   │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

### シード生成フロー

```
seed-users.js          seed-authcodes.js           test-authcode.js
     │                       │                           │
     ▼                       ▼                           ▼
 ユーザー作成 ────────▶ 認可コード生成 ────────▶ /token テスト
 (50万ユーザー)         (POST /authorize)        (K6 Cloud実行)
     │                       │                           │
     ▼                       ▼                           ▼
seeds/test_users.json  seeds/authorization_codes.json   結果レポート
```

---

## 問題の原因分析

### 根本原因: `iterationInTest` の仕様誤解

#### K6ドキュメントの記述

> exec.scenario.iterationInTest – The iteration index **in the whole test**.

これを見ると「クラスタ全体でユニークな通し番号」と誤解してしまう。

#### 実際の挙動

**K6 Cloudで複数インスタンス実行時、同じ番号が発生する:**

```
Instance 0: iterationInTest = 0, 3, 6, 9...
Instance 1: iterationInTest = 1, 4, 7, 10...
Instance 2: iterationInTest = 2, 5, 8, 11...
```

ログ例:
```
instance_id=0: iteration=0, poolSize=69998
instance_id=0: iteration=3, poolSize=69998
instance_id=1: iteration=1, poolSize=69998
instance_id=1: iteration=4, poolSize=69998
instance_id=2: iteration=2, poolSize=69998
```

**問題:** 各インスタンスが `iteration=0` から開始するため、**同じ認可コードが複数回使用される**。

### なぜ500 RPSは成功して2000 RPSは失敗したか？

| テスト | インスタンス数 | 結果 |
|--------|--------------|------|
| 500 RPS | 1台 | 成功（競合なし） |
| 2000 RPS | 3台 | 失敗（同一コード3回使用） |

K6 Cloudはシナリオ設定・RPSに応じて動的にインスタンス数を増減する。

- 小規模テスト（500 RPS）→ 1インスタンスで完結 → 競合なし
- 大規模テスト（2000 RPS）→ 3インスタンス分散実行 → 競合発生

### 結論

**`iterationInTest` は分散環境でグローバル一意性を保証しない。**

分散実行では各インスタンス間で同期を取らないため、完全なユニーク性は設計上不可能。

---

## 解決策

### 方式1: Remote Queue API（推奨）

**最も確実な方法。** Durable Objectで認可コードキューを管理し、K6から `/pop-code` APIを呼び出す。

#### 実装例: AuthorizationCodeQueueDO

```typescript
// packages/shared/src/durable-objects/AuthorizationCodeQueueDO.ts
export class AuthorizationCodeQueueDO {
  private state: DurableObjectState;
  private codes: string[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/pop') {
      // Atomic increment
      const idx = await this.state.storage.get<number>('idx') || 0;
      await this.state.storage.put('idx', idx + 1);

      const codes = await this.state.storage.get<string[]>('codes') || [];
      if (idx >= codes.length) {
        return new Response('No more codes', { status: 404 });
      }

      return Response.json(codes[idx]);
    }

    if (url.pathname === '/init' && request.method === 'POST') {
      const codes = await request.json() as string[];
      await this.state.storage.put('codes', codes);
      await this.state.storage.put('idx', 0);
      return new Response('OK');
    }

    return new Response('Not found', { status: 404 });
  }
}
```

#### K6側の実装

```javascript
// test-authcode.js
export default function(data) {
  // Remote Queueからコードを取得
  const popRes = http.get(`${BASE_URL}/api/test/pop-code`);
  if (popRes.status !== 200) {
    console.error('Failed to pop code');
    return;
  }

  const codeData = popRes.json();

  // Token交換
  const tokenRes = http.post(`${BASE_URL}/token`, {
    grant_type: 'authorization_code',
    code: codeData.code,
    code_verifier: codeData.code_verifier,
    redirect_uri: codeData.redirect_uri,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  check(tokenRes, {
    'token success': (r) => r.status === 200,
  });
}
```

**利点:**
- 完全なユニーク性保証
- CI/CDで実運用を考えると最も自然
- DOのatomic操作で競合なし

---

### 方式2: シャード分割配布（インターリーブ方式）【実装済み】

単一のJSONファイルを使用し、各インスタンスが異なるインデックスを使用するインターリーブ方式。
ファイル分割が不要でシンプル。

#### 計算式

```
globalIndex = instanceId + (localIteration × maxInstances)
```

#### 動作例（3インスタンス、コードプール100個）

```
Instance 0: codes[0, 3, 6, 9, 12, ...]   (localIter=0,1,2,3,4...)
Instance 1: codes[1, 4, 7, 10, 13, ...]  (localIter=0,1,2,3,4...)
Instance 2: codes[2, 5, 8, 11, 14, ...]  (localIter=0,1,2,3,4...)
```

#### K6側の実装（test-authcode.js）

```javascript
function getGlobalCodeIndex(codePoolSize) {
  // K6 Cloud環境変数からインスタンス情報を取得
  // ローカル実行時は0/1がデフォルト
  const instanceId = parseInt(__ENV.K6_CLOUDRUN_INSTANCE_ID || '0', 10);
  const maxInstances = parseInt(__ENV.MAX_INSTANCES || '10', 10);

  // インスタンス内のイテレーション番号（各インスタンスで0から始まる）
  const localIteration = exec.scenario.iterationInInstance;

  // シャード分割: 各インスタンスが異なるコードを使用
  const globalIndex = instanceId + localIteration * maxInstances;

  return globalIndex;
}
```

#### 必要なシード数の計算

```
必要シード数 = maxInstances × (目標イテレーション数 / maxInstances)
            ≈ 目標総イテレーション数

例: 2000 RPS × 50秒 = 100,000イテレーション
    → 100,000個以上のシードが必要
```

#### テスト実行コマンド

```bash
# MAX_INSTANCES を明示的に指定（K6 Cloudのインスタンス数に合わせる）
k6 cloud \
  --env PRESET=rps2000 \
  --env CLIENT_ID="your-client-id" \
  --env CLIENT_SECRET="your-client-secret" \
  --env MAX_INSTANCES=10 \
  scripts/test-authcode.js
```

**利点:**
- ファイル分割不要（単一JSONファイル）
- 既存の構成をほぼ変えずに対応可能
- 外部APIコールが不要

**注意点:**
- `MAX_INSTANCES` は実際のインスタンス数以上の値を設定（安全マージン）
- `K6_CLOUDRUN_INSTANCE_ID` は K6 Cloud が自動設定

---

### 方式3: KVは使用しない

KVはatomic incrementをサポートしないため、pop操作で競合（レースコンディション）が発生する。

**認可コードキューには必ずDurable Objectを使用すること。**

---

## テスト実行ガイド

### 前提条件

```bash
cd load-testing

# 環境変数設定
export BASE_URL="https://conformance.authrim.com"
export CLIENT_ID="your-client-id"
export CLIENT_SECRET="your-client-secret"
export ADMIN_API_SECRET="your-admin-secret"
```

### Step 1: ユーザー事前作成（初回のみ）

```bash
USER_COUNT=500000 CONCURRENCY=50 node scripts/seed-users.js
```

**出力:**
- `seeds/test_users.json` - ユーザー詳細（シャード情報付き）
- `seeds/test_users.txt` - ユーザーID一覧

**特徴:**
- 中断時に自動保存、再開時にスキップ
- DB初期化しない限り再利用可能

### Step 2: 認可コード生成（テストごとに実行）

```bash
AUTH_CODE_COUNT=70000 USER_COUNT=5000 CONCURRENCY=100 node scripts/seed-authcodes.js
```

**出力:** `seeds/authorization_codes.json`

**重要:** 認可コードは1回限り使用のため、テストごとに再生成が必要。

### Step 3: K6テスト実行

#### ローカル実行

```bash
k6 run --env PRESET=rps100 scripts/test-authcode.js
```

#### K6 Cloud実行

```bash
k6 cloud \
  --env PRESET=rps500 \
  --env CLIENT_ID="$CLIENT_ID" \
  --env CLIENT_SECRET="$CLIENT_SECRET" \
  scripts/test-authcode.js
```

**注意:** K6 Cloudでは `CLIENT_ID` と `CLIENT_SECRET` を明示的に渡す必要がある。

---

## プリセット一覧

| プリセット | RPS | 時間 | maxVUs | 用途 |
|-----------|-----|------|--------|------|
| `rps10` | 10 | 40s | 20 | デバッグ・検証 |
| `rps50` | 50 | 2.5min | 80 | 軽量テスト |
| `rps100` | 100 | 3min | 150 | 本番基準 |
| `rps200` | 200 | 3min | 300 | 高トラフィック |
| `rps300` | 300 | 2.5min | 400 | 標準ベンチマーク |
| `rps500` | 500 | 2.5min | 600 | 高容量ベンチマーク |
| `rps1000` | 1000 | 2.5min | 1000 | 限界テスト |
| `rps2000` | 2000 | 50s | 2500 | 最大容量テスト |

### 必要なシード数の目安

| プリセット | ローカル必要数 | K6 Cloud必要数（×10） |
|-----------|--------------|----------------------|
| `rps100` | 150 | 1,500 |
| `rps300` | 400 | 4,000 |
| `rps500` | 600 | 6,000 |
| `rps1000` | 1,200 | 12,000 |
| `rps2000` | 2,500 | 25,000+ |

**重要:** K6 Cloudでは複数インスタンスでVU IDが重複するため、シード数を10倍以上用意する必要がある（現行方式の場合）。

---

## トラブルシューティング

### エラー: 100% 400 invalid_grant

**原因:** 同じ認可コードが複数回使用されている

**対処:**
1. 新しい認可コードを生成: `node scripts/seed-authcodes.js`
2. K6 Cloudの場合、[解決策](#解決策)のRemote Queue方式を検討

### エラー: 100% 401 Unauthorized

**原因:** CLIENT_ID/CLIENT_SECRET がK6 Cloudに渡されていない

**対処:**
```bash
k6 cloud \
  --env PRESET=rps500 \
  --env CLIENT_ID="your-client-id" \
  --env CLIENT_SECRET="your-client-secret" \
  scripts/test-authcode.js
```

### エラー: 413 The data value transmitted exceeds the capacity limit

**原因:** シードファイルが大きすぎる（K6 Cloud制限: 約10MB）

**対処:**
1. シード数を減らす（70,000個程度が目安）
2. テスト時間を短縮

### 警告: Insufficient VUs

**原因:** レスポンスが遅く、VUが解放されない

**対処:**
1. `preAllocatedVUs` と `maxVUs` を増やす
2. レイテンシが高い場合はシステム側の最適化を検討

### VU不足で目標RPSに達しない

**計算式:**
```
必要VU数 = 目標RPS × 平均レスポンス時間(秒)
```

例: 2000 RPS × 1秒 = 2000 VUs必要

---

## 今後の改善提案

### 1. テスト環境用TTL短縮

本番: 8時間
テスト: 5分（古いコードの影響を軽減）

### 2. Remote Queue API実装

`/api/test/pop-code` エンドポイントをDOで実装し、完全なユニーク配布を実現。

### 3. Cloudflare Analytics連携

```bash
CF_API_TOKEN=xxx node scripts/report-cf-analytics.js --minutes 15
```

テスト後にCloudflare側のメトリクスを取得して分析。

---

## 関連ファイル

| ファイル | 説明 |
|---------|------|
| `scripts/seed-users.js` | ユーザー事前作成 |
| `scripts/seed-authcodes.js` | 認可コード生成 |
| `scripts/test-authcode.js` | K6負荷テストスクリプト |
| `scripts/README.md` | スクリプト一覧 |
| `seeds/test_users.json` | ユーザーキャッシュ |
| `seeds/authorization_codes.json` | 認可コードシード |

---

## 参考リンク

- [K6 Documentation - Scenarios](https://k6.io/docs/using-k6/scenarios/)
- [K6 Cloud - Distributed Testing](https://k6.io/docs/cloud/creating-and-running-a-test/cloud-tests-from-the-cli/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
