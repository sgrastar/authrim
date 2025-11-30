# テストシナリオ詳細

## 概要

このドキュメントでは、Authrim の負荷テストにおける 3 つの標準テストシナリオの詳細を定義します。

## テスト設計の原則

### 1. 現実性（Realism）

- 実際のユーザー行動に基づいたシナリオ
- 本番環境と同じエンドポイント・パスを使用
- 現実的なペイロードサイズとリクエスト頻度

### 2. 再現性（Reproducibility）

- 同じプリセットで何度実行しても同じ結果が得られる
- 乱数シードの固定化
- テストデータの事前準備

### 3. 段階性（Gradual Load）

- Light → Standard → Heavy の順に実行
- 各段階で十分なクールダウン時間を確保
- システムの限界を段階的に探る

## TEST 1: /token 単体負荷テスト

### 目的

Authrim の**最大RPS上限**を簡易に測定し、JWT 署名処理の CPU 負荷とDO ロック競合の発生域を確認する。

### テスト対象エンドポイント

```
POST /token
```

### リクエスト仕様

#### リクエストヘッダー

```http
POST /token HTTP/1.1
Host: conformance.authrim.com
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)
```

#### リクエストボディ

```
grant_type=authorization_code
&code={pre_generated_code}
&redirect_uri=https://example.com/callback
&code_verifier={pkce_verifier}
```

### 事前準備

テスト実行前に以下を準備：

1. **大量の認可コード生成**
   - 最低 10,000 個の有効な認可コードを事前生成
   - AuthorizationCodeStore DO に保存
   - テストスクリプトは CSV ファイルから読み込み

2. **テスト用クライアント登録**
   - Client ID / Secret の発行
   - Redirect URI の登録
   - PKCE 必須設定

### プリセット詳細

#### 🔹 Light（軽負荷）

**ユースケース**: 実サービスの通常運用時の負荷

| パラメータ | 値 |
|-----------|-----|
| RPS（開始） | 5 |
| RPS（終了） | 20 |
| Duration | 60秒 |
| VUs | 20 |
| Ramp-up | 10秒 |
| Ramp-down | 10秒 |

**期待される結果**:
- p50: < 100ms
- p90: < 200ms
- p99: < 250ms
- Error Rate: < 0.1%
- CPU Time: < 50ms/request

**k6 設定例**:

```javascript
export const options = {
  scenarios: {
    token_load_light: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 30,
      stages: [
        { target: 5, duration: '10s' },   // Ramp up to 5 RPS
        { target: 20, duration: '20s' },  // Ramp up to 20 RPS
        { target: 20, duration: '20s' },  // Stay at 20 RPS
        { target: 5, duration: '10s' },   // Ramp down to 5 RPS
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<250'],
    http_req_failed: ['rate<0.001'],
  },
};
```

#### 🔹 Standard（中負荷）

**ユースケース**: MAU 10万〜30万のピーク時想定

| パラメータ | 値 |
|-----------|-----|
| RPS（開始） | 30 |
| RPS（終了） | 100 |
| Duration | 120秒 |
| VUs | 100 |
| Ramp-up | 20秒 |
| Ramp-down | 20秒 |

**期待される結果**:
- p50: < 150ms
- p90: < 350ms
- p99: < 500ms
- Error Rate: < 0.5%
- CPU Time: < 80ms/request

#### 🔹 Heavy（重負荷）

**ユースケース**: アーキテクチャの天井計測

| パラメータ | 値 |
|-----------|-----|
| RPS（開始） | 200 |
| RPS（終了） | 600 |
| Duration | 180秒 |
| VUs | 200〜600 |
| Ramp-up | 30秒 |
| Ramp-down | 30秒 |

**期待される結果**:
- **エラーレートが急上昇する RPS を特定**
- 429 (Rate Limit) または 500 (Internal Error) の発生域を確認
- p99 が 1秒を超える地点を記録

### 測定項目

1. **パフォーマンスメトリクス**
   - レスポンスタイム（p50/p90/p95/p99）
   - スループット（RPS）
   - エラーレート

2. **Cloudflare メトリクス**
   - CPU Time (ms)
   - KeyManager DO 実行回数
   - JWT 署名処理時間
   - KV 読み取り回数

3. **ボトルネック分析**
   - CPU Time が最も長いリクエスト
   - DO ロック待ち時間
   - ネットワーク I/O 時間

### 成功基準

- Light: すべてのリクエストが成功（error rate < 0.1%）
- Standard: p99 < 500ms、error rate < 1%
- Heavy: **最大安定 RPS を記録**（エラーレート 5% 未満での最大値）

---

## TEST 2: Refresh Token Storm

### 目的

**実世界の最大トラフィック**を想定し、D1 書き込み負荷と DO Token Rotator の競合をチェック。

### テスト対象エンドポイント

```
POST /token
```

### リクエスト仕様

#### リクエストヘッダー

```http
POST /token HTTP/1.1
Host: conformance.authrim.com
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)
```

#### リクエストボディ

```
grant_type=refresh_token
&refresh_token={valid_refresh_token}
```

### 事前準備

1. **大量の Refresh Token 生成**
   - 最低 50,000 個の有効な Refresh Token を事前生成
   - D1 に保存（永続化済み状態）
   - 各トークンは異なるユーザーに紐付け

2. **Token Rotation 設定**
   - Refresh Token Rotation を有効化
   - 古いトークンの即時無効化設定

### プリセット詳細

#### 🔹 Light（軽負荷）

**ユースケース**: 日常的な Refresh トラフィック

| パラメータ | 値 |
|-----------|-----|
| RPS | 50 |
| Duration | 5分 (300秒) |
| VUs | 50 |
| Think Time | 100ms |

**期待される結果**:
- p99: < 300ms
- Error Rate: < 0.1%
- D1 書き込み成功率: 100%

#### 🔹 Standard（中負荷）

**ユースケース**: ピーク時の Refresh トラフィック

| パラメータ | 値 |
|-----------|-----|
| RPS（開始） | 200 |
| RPS（最大） | 500 |
| Duration | 10分 (600秒) |
| VUs | 200〜500 |

**期待される結果**:
- p99: < 500ms
- Error Rate: < 0.1%
- D1 書き込み成功率: > 99.9%

#### 🔹 Heavy（重負荷）

**ユースケース**: 極限的な Refresh Storm

| パラメータ | 値 |
|-----------|-----|
| RPS（開始） | 800 |
| RPS（最大） | 1200 |
| Duration | 10分 (600秒) |
| VUs | 800〜1200 |

**期待される結果**:
- **DO ロック競合の観測**
- D1 書き込みエラーの発生域を確認
- タイムアウトやリトライの挙動を測定

### 測定項目

1. **パフォーマンスメトリクス**
   - レスポンスタイム（特に p99）
   - D1 書き込み時間
   - Token Rotation 処理時間

2. **Cloudflare メトリクス**
   - TokenStore DO 実行回数
   - D1 Write クエリ数
   - D1 トランザクション競合回数

3. **一貫性チェック**
   - Refresh Token の重複利用検出率
   - 古いトークンの無効化確認
   - Session データの整合性

### 成功基準

- Light: error rate < 0.1%、p99 < 300ms
- Standard: error rate < 0.1%、p99 < 500ms
- Heavy: **D1 書き込みエラーが 2% 未満**

---

## TEST 3: フル OIDC 認証フロー

### 目的

実サービス最も近いワークロードを再現し、PKCE / DO / D1 の全パスを通過するエンドツーエンドテスト。

### テストフロー

```
1. GET /authorize
   ↓
2. (ユーザー認証・同意画面)
   ↓
3. Redirect to callback with code
   ↓
4. POST /token (code exchange)
   ↓
5. Response: access_token + refresh_token
```

### リクエスト仕様

#### Step 1: Authorization Request

```http
GET /authorize?
  response_type=code
  &client_id={client_id}
  &redirect_uri=https://example.com/callback
  &scope=openid%20profile%20email
  &state={random_state}
  &code_challenge={pkce_challenge}
  &code_challenge_method=S256
  &nonce={random_nonce}
```

#### Step 2: Token Request

```http
POST /token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)

grant_type=authorization_code
&code={received_code}
&redirect_uri=https://example.com/callback
&code_verifier={pkce_verifier}
```

### プリセット詳細

#### 🔹 Light（軽負荷）

**ユースケース**: 通常の Web アプリログイン

| パラメータ | 値 |
|-----------|-----|
| RPS（開始） | 10 |
| RPS（終了） | 20 |
| Duration | 120秒 |
| VUs | 20 |
| Think Time | 500ms〜2s |

**期待される結果**:
- 全フロー完了率: > 99%
- p99: < 300ms (authorize + token の合計)
- エラーレート: < 0.5%

#### 🔹 Standard（中負荷）

**ユースケース**: ピーク時のログイントラフィック

| パラメータ | 値 |
|-----------|-----|
| RPS（開始） | 30 |
| RPS（終了） | 50 |
| Duration | 180秒 |
| VUs | 50 |
| Think Time | 200ms〜1s |

**期待される結果**:
- 全フロー完了率: > 98%
- p99: < 500ms
- エラーレート: < 1%

#### 🔹 Heavy（重負荷）

**ユースケース**: 同時大量ログイン（フラッシュセール等）

| パラメータ | 値 |
|-----------|-----|
| RPS（開始） | 80 |
| RPS（終了） | 100 |
| Duration | 180秒 |
| VUs | 100 |
| Think Time | 100ms〜500ms |

**期待される結果**:
- **80RPS を超えると DO 競合が顕著**
- レイテンシ跳ね上がり地点を特定
- Queue 待ち時間の測定

### 測定項目

1. **フロー完了率**
   - authorize → token の完全成功率
   - 途中離脱率（code 取得失敗、token 取得失敗）

2. **ステップ別レスポンスタイム**
   - GET /authorize の処理時間
   - POST /token の処理時間
   - 全フローの合計時間

3. **Cloudflare メトリクス**
   - AuthorizationCodeStore DO 実行回数
   - TokenStore DO 実行回数
   - D1 Session 書き込み回数

### 成功基準

- Light: 完了率 > 99%、p99 < 300ms
- Standard: 完了率 > 98%、p99 < 500ms
- Heavy: **80RPS で安定動作**（error rate < 5%）

---

## テスト実行順序

### 推奨実行順

1. **TEST 1 - Light** → ウォームアップとして実行
2. **TEST 1 - Standard** → 基本性能確認
3. ⏸️ **30分のクールダウン**
4. **TEST 2 - Light** → D1 書き込み負荷の初期確認
5. **TEST 2 - Standard** → Refresh Storm の本格測定
6. ⏸️ **1時間のクールダウン**
7. **TEST 3 - Light** → エンドツーエンドの動作確認
8. **TEST 3 - Standard** → 実運用想定の負荷テスト
9. ⏸️ **2時間のクールダウン**
10. **TEST 1/2/3 - Heavy** → 天井探索（順不同）

### クールダウンの重要性

- Cloudflare の内部キャッシュやメトリクスのリセット
- DO の状態クリア
- D1 のトランザクションログのフラッシュ
- システム全体の安定化

---

## データ準備スクリプト

### 認可コード事前生成

```bash
# scripts/prepare-authz-codes.sh
./scripts/generate-codes.sh 10000 > data/authz_codes.csv
```

### Refresh Token 事前生成

```bash
# scripts/prepare-refresh-tokens.sh
./scripts/generate-refresh-tokens.sh 50000 > data/refresh_tokens.csv
```

### テストユーザー作成

```bash
# scripts/create-test-users.sh
./scripts/create-users.sh 1000
```

---

## 結果の評価方法

### 合格基準マトリクス

| テスト | プリセット | p99 | Error Rate | 追加条件 |
|--------|-----------|-----|-----------|---------|
| TEST 1 | Light | < 250ms | < 0.1% | - |
| TEST 1 | Standard | < 500ms | < 1% | - |
| TEST 1 | Heavy | - | < 5% | 最大 RPS 記録 |
| TEST 2 | Light | < 300ms | < 0.1% | D1 エラー 0 |
| TEST 2 | Standard | < 500ms | < 0.1% | D1 エラー < 0.1% |
| TEST 2 | Heavy | < 700ms | < 2% | DO 競合観測 |
| TEST 3 | Light | < 300ms | < 0.5% | 完了率 > 99% |
| TEST 3 | Standard | < 500ms | < 1% | 完了率 > 98% |
| TEST 3 | Heavy | < 1000ms | < 5% | 80RPS 安定 |

### 不合格時のアクション

1. **p99 超過**: アルゴリズム最適化、キャッシュ強化
2. **Error Rate 超過**: DO ロック設計見直し、リトライロジック追加
3. **D1 エラー**: トランザクション分離、バッチ書き込み
4. **完了率低下**: タイムアウト設定見直し、エラーハンドリング強化

---

## 次のステップ

テスト実行後は [metrics-collection.md](./metrics-collection.md) に従って、Cloudflare Analytics からメトリクスを収集してください。
