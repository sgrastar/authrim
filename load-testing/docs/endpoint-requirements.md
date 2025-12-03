# エンドポイント別 負荷テスト要件仕様書

## 概要

このドキュメントは、Authrim の負荷テストにおける**各エンドポイントの必須設定・状態管理ルール**を定義します。

> **重要**: この仕様に沿えば、Auth0 / Okta / Azure AD B2C が内部で実施している負荷テストと同等の精度を実現できます。

---

## 目次

- [標準ベンチマークテスト](#標準ベンチマークテスト)
- [共通原則](#共通原則)
- [エンドポイント別要件](#エンドポイント別要件)
  - [/authorize](#1-authorize認証開始)
  - [/token (authorization_code)](#2-token-grant_typeauthorization_code)
  - [/token (refresh_token)](#3-token-grant_typerefresh_token)
  - [/token (token_exchange)](#4-token-grant_typetoken_exchange)
  - [/userinfo](#5-userinfo)
  - [/.well-known/openid-configuration](#6-well-knownopenid-configuration)
- [状態変化一覧表](#状態変化一覧表)
- [実運用プリセット](#実運用プリセット)

---

## 標準ベンチマークテスト

### 統一条件: 2 分間 300 RPS テスト

すべてのエンドポイントに対して、以下の統一条件でベンチマークテストを実施します。

| 項目      | 値                   |
| --------- | -------------------- |
| RPS       | **300 RPS（固定）**  |
| Duration  | **2 分間（120 秒）** |
| Ramp-up   | 10 秒                |
| Ramp-down | 10 秒                |

### 目的

- **横断比較**: 全エンドポイントを同一条件で測定し、ボトルネックを特定
- **ベースライン確立**: 改善前後の比較基準として使用
- **限界値の把握**: 300 RPS は MAU 150 万相当のピーク負荷

### 実施対象テスト

| テスト | エンドポイント                | 事前準備                           |
| ------ | ----------------------------- | ---------------------------------- |
| TEST 1 | `/token` (authorization_code) | 36,000 個以上の authorization code |
| TEST 2 | `/token` (refresh_token)      | 300 個以上の独立した RT family     |
| TEST 3 | Full OIDC Flow                | 36,000 個以上の code + session     |

### 成功基準

| 指標         | 目標値  |
| ------------ | ------- |
| p95 Latency  | < 300ms |
| p99 Latency  | < 500ms |
| Error Rate   | < 0.1%  |
| Success Rate | > 99.9% |

### 実行コマンド例

```bash
# TEST 1: Token endpoint (300 RPS × 2 min)
k6 run --env RPS=300 --env DURATION=120s scripts/test1-token-load.js

# TEST 2: Refresh Token Storm (300 RPS × 2 min)
k6 run --env RPS=300 --env DURATION=120s scripts/test2-refresh-storm.js

# TEST 3: Full OIDC (300 RPS × 2 min)
k6 run --env RPS=300 --env DURATION=120s scripts/test3-full-oidc.js
```

### 事前データ生成

```bash
# 300 RPS × 120 秒 = 36,000 リクエスト分のシードを生成
cd load-testing/scripts

# TEST 1 用: authorization code
AUTH_CODE_COUNT=40000 REFRESH_COUNT=0 node generate-seeds.js

# TEST 2 用: 独立した RT family（VU 数分）
AUTH_CODE_COUNT=0 REFRESH_COUNT=300 node generate-refresh-tokens-parallel.js
```

---

## 共通原則

### 原則1: VU = 実利用ユーザーとして振る舞う

**VU（Virtual User）は実際のユーザーとして振る舞うこと。**

VU ごとに**認証状態・セッション・Refresh Token ファミリー**を保持しないと「意味のない負荷テスト」になります。

```
VU 1 → user1 の refresh_token family
VU 2 → user2 の refresh_token family
...
VU N → userN の refresh_token family
```

> **禁止事項**: 全 VU で共通の Refresh Token を使うことは**絶対にNG**（実際の動作と異なる）

### 原則2: DO 衝突を避けるための分散戦略

RefreshTokenRotator DO は `user_id` と `client_id` でシャーディングされています。

| 項目        | 分散戦略                          |
| ----------- | --------------------------------- |
| `user_id`   | VU ごとに異なる値を使用（必須）   |
| `client_id` | 全 VU で共通で OK（実運用に近い） |

### 原則3: トークンは事前生成しておく

負荷テスト中に認証フロー全体を含める必要は**ありません**。

`generate-seeds.js` などを使って、事前に以下を準備：

- VU ごとの `access_token`
- VU ごとの `refresh_token`（**必須**）
- VU ごとの session（D1 に保存済み状態）
- 必要数の `authorization_code`（TEST 1 用）

### 原則4: 正しいヘッダを使用する

Workers は header mismatch で遅くなることがあるため、以下のヘッダを必ず設定：

```http
Content-Type: application/x-www-form-urlencoded
Accept: application/json
Connection: keep-alive
```

---

## エンドポイント別要件

### 1. /authorize（認証開始）

#### 必須設定

| 項目           | 要件                                            | 理由                              |
| -------------- | ----------------------------------------------- | --------------------------------- |
| `state`        | **毎リクエストでランダム生成**                  | 実運用でも毎回異なる（CSRF 保護） |
| `nonce`        | **毎リクエストでランダム生成**                  | リプレイアタック防止              |
| `redirect_uri` | 固定で OK                                       | VU ごとに変える必要なし           |
| Cookie         | **Set-Cookie を受け取り、次のリクエストで返す** | セッション管理                    |

#### リクエスト例

```http
GET /authorize?
  response_type=code
  &client_id={client_id}
  &redirect_uri=https://localhost:3000/callback
  &scope=openid%20profile%20email
  &state={random_state}
  &nonce={random_nonce}
  &code_challenge={pkce_challenge}
  &code_challenge_method=S256
HTTP/1.1
Host: conformance.authrim.com
Accept: application/json
```

#### k6 実装例

```javascript
import { randomString } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';
import { URL } from 'https://jslib.k6.io/url/1.0.0/index.js';

export default function () {
  const state = randomString(32);
  const nonce = randomString(32);
  const codeVerifier = randomString(64);
  const codeChallenge = sha256base64url(codeVerifier);

  const url = new URL(`${BASE_URL}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  const res = http.get(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  // Cookie を保存（次のリクエストで使用）
  const cookies = res.cookies;
  // code を抽出（次の /token リクエストで使用）
}
```

#### 禁止事項

- `state` を固定値にする
- Cookie を無視する
- `/authorize` → `/token` の `code` を無視して POST する

---

### 2. /token (grant_type=authorization_code)

#### 必須設定

| 項目                          | 要件                                    | 理由           |
| ----------------------------- | --------------------------------------- | -------------- |
| `code`                        | **/authorize で受け取った code を使用** | One-Time Use   |
| `redirect_uri`                | **/authorize と完全一致**               | OAuth 2.0 仕様 |
| `client_id` / `client_secret` | 固定で OK                               | 認証情報       |
| `code_verifier`               | **/authorize で使った verifier**        | PKCE 検証      |

#### 重要な状態処理

```
code は「1回限りの使い捨て」
↓
/token 成功後、refresh_token を VU ローカルに保存
↓
次の refresh テストでその RT を使用
```

#### リクエスト例

```http
POST /token HTTP/1.1
Host: conformance.authrim.com
Content-Type: application/x-www-form-urlencoded
Authorization: Basic {base64(client_id:client_secret)}

grant_type=authorization_code
&code={pre_generated_code}
&redirect_uri=https://localhost:3000/callback
&code_verifier={pkce_verifier}
```

#### k6 実装例

```javascript
export default function () {
  const vuId = __VU;
  const seed = seeds[vuId % seeds.length];

  const res = http.post(
    `${BASE_URL}/token`,
    {
      grant_type: 'authorization_code',
      code: seed.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: seed.code_verifier,
    },
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      },
    }
  );

  if (res.status === 200) {
    const data = res.json();
    // refresh_token を VU ローカルに保存（次の refresh テストで使用）
    vuState.refreshToken = data.refresh_token;
  }
}
```

#### 禁止事項

- 同じ `code` を複数回使用する
- `redirect_uri` を `/authorize` と異なる値にする

---

### 3. /token (grant_type=refresh_token)

> **最重要**: エンドポイント負荷テストの最難関。この設定を間違えると意味のないテストになります。

#### 必須設定（超重要）

| 項目           | 要件                               | 理由               |
| -------------- | ---------------------------------- | ------------------ |
| Token Rotation | **必ず有効化**                     | 実運用ではほぼ必須 |
| RT family      | **VU ごとに独立**                  | DO 衝突防止        |
| RT 更新        | **毎リクエストで前回の RT を使用** | Rotation の本質    |

#### Refresh Token Rotation のフロー

```
初期状態: rt = seeds[VU].initialRT

for each request:
   res = POST /token (refresh_token=rt)
   rt = res.refresh_token  ← 新しい RT で更新
```

**これが一番重要。毎回新しい RT を使わないと Token Rotation のテストにならない。**

#### リクエスト例

```http
POST /token HTTP/1.1
Host: conformance.authrim.com
Content-Type: application/x-www-form-urlencoded
Authorization: Basic {base64(client_id:client_secret)}

grant_type=refresh_token
&refresh_token={current_refresh_token}
```

#### k6 実装例（Stateful）

```javascript
// VU ごとの状態管理
const vuState = {};

export function setup() {
  // seeds から VU ごとの初期 RT を読み込み
  const seeds = JSON.parse(open('./seeds/refresh_tokens.json'));
  return { seeds };
}

export default function (data) {
  const vuId = __VU;

  // 初回は seeds から RT を取得
  if (!vuState.refreshToken) {
    vuState.refreshToken = data.seeds[vuId % data.seeds.length].refresh_token;
    vuState.userId = data.seeds[vuId % data.seeds.length].user_id;
  }

  const res = http.post(
    `${BASE_URL}/token`,
    {
      grant_type: 'refresh_token',
      refresh_token: vuState.refreshToken,
    },
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      },
    }
  );

  if (res.status === 200) {
    const data = res.json();
    // ★ 新しい RT で更新（最重要）
    vuState.refreshToken = data.refresh_token;
  }

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has new refresh_token': (r) => r.json('refresh_token') !== undefined,
  });
}
```

#### 禁止事項（絶対にやってはいけない）

| NG パターン                             | 結果                            |
| --------------------------------------- | ------------------------------- |
| 全 VU が同じ RT を使い回す              | DO が 1 個に集中して死ぬ        |
| 毎回同じ RT を使う                      | Rotation にならず実運用と異なる |
| RT の更新結果を VU ローカルに保存しない | テスト無意味                    |

#### 盗難検知テストについて

旧 RT の使用（Theft Detection）パスは**別テストで行う**こと。
まずは正常パスの負荷テストを完了させてから。

---

### 4. /token (grant_type=token_exchange)

#### 必須設定

| 項目                      | 要件          | 理由         |
| ------------------------- | ------------- | ------------ |
| `subject_token`           | VU ごとに保持 | ユーザー識別 |
| `actor_token`             | VU ごとに保持 | 代理認証     |
| exchange 先の `client_id` | 固定で OK     | 対象サービス |

#### リクエスト例

```http
POST /token HTTP/1.1
Host: conformance.authrim.com
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token={session_token}
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&requested_token_type=urn:ietf:params:oauth:token-type:access_token
```

#### RT との違い

```
Token Exchange:
  - 毎回同じ session_token を送る ＝ OK
  - RT のように毎回更新する必要は「ない」
```

---

### 5. /userinfo

#### 必須設定

| 項目           | 要件                       | 理由                         |
| -------------- | -------------------------- | ---------------------------- |
| `access_token` | VU ごとに固定で OK         | 実運用でも AT 変更頻度は低い |
| AT 有効期限    | **有効期限内のものを使用** | 認証エラー防止               |

#### 推奨設定

負荷テスト用に `exp=30m` 程度の AT を事前生成するのがベスト。

#### リクエスト例

```http
GET /userinfo HTTP/1.1
Host: conformance.authrim.com
Authorization: Bearer {access_token}
Accept: application/json
```

---

### 6. /.well-known/openid-configuration

#### 必須設定

**特になし。** 単純な GET リクエスト。

#### 推奨ヘッダ

```http
GET /.well-known/openid-configuration HTTP/1.1
Host: conformance.authrim.com
Accept: application/json
Connection: keep-alive
```

#### 用途

主にキャッシュ負荷のテストに使用。

---

## 状態変化一覧表

各エンドポイントで「何を変える必要があるか」の一覧：

| エンドポイント      | 毎回変える?        | VU ごと? | 必須状態管理      | 備考                |
| ------------------- | ------------------ | -------- | ----------------- | ------------------- |
| `/authorize`        | YES（state/nonce） | NO       | state, cookie     | code は使い捨て     |
| `/token` (code)     | YES（code）        | YES      | code, session     | RT 受け取ったら保存 |
| `/token` (refresh)  | **YES（RT 更新）** | **YES**  | **refresh_token** | RT family を保持    |
| `/token` (exchange) | NO                 | YES      | session_token     | 再利用 OK           |
| `/userinfo`         | NO                 | YES      | AT のみ           | AT は固定利用可     |
| `/.well-known`      | NO                 | NO       | なし              | キャッシュ負荷      |

---

## 実運用プリセット

### プリセット A: 普通の Web サービス（ログイン 1 回/日）

**想定サービス**: 業務系 SaaS、EC サイト、社内ポータル

| エンドポイント     | 要件                        | 頻度       |
| ------------------ | --------------------------- | ---------- |
| `/authorize`       | Cookie を正しく扱う         | 1 回/日    |
| `/token` (code)    | code は使い捨て             | 1 回/日    |
| `/token` (refresh) | RT は初回しか使わない       | 1-2 回/日  |
| `/userinfo`        | AT 固定のまま複数回呼ばれる | 5-10 回/日 |

### プリセット B: スマホアプリ

#### B-1: 低頻度（起動時だけ）

**想定サービス**: 天気アプリ、ニュースアプリ

- RT → AT: 1-2 回/日
- `/authorize` は初回のみ

#### B-2: 中頻度（チャット / ソシャゲ）

**想定サービス**: メッセンジャー、モバイルゲーム

- `/token` (refresh): 1-4 回/時
- `/userinfo` はほぼ呼ばない

#### B-3: 高頻度（動画配信 / API 連打系）

**想定サービス**: 動画ストリーミング、リアルタイムアプリ

- AT が頻繁に expire しないので refresh 中心
- `/userinfo` は最小限

### プリセット C: IoT（POS / 家電）

**想定サービス**: POS 端末、スマート家電、センサー

| エンドポイント     | 要件                   | 頻度              |
| ------------------ | ---------------------- | ----------------- |
| `/authorize`       | 初回のみ               | 1 回/セットアップ |
| `/token` (refresh) | 定期メンテナンス系     | 30 分間隔         |
| `/userinfo`        | ほぼ一定間隔で呼ばれる | 10 分間隔         |

---

## テストデータ生成要件

### Refresh Token Storm 用シード生成

```bash
# VU 数に応じた独立した RT family を生成
cd load-testing/scripts

# 例: 100 VU 用に 100 個の独立した RT を生成
AUTH_CODE_COUNT=0 \
REFRESH_COUNT=100 \
node generate-refresh-tokens-parallel.js
```

### 生成されるデータ構造

```json
[
  {
    "user_id": "user-loadtest-001",
    "refresh_token": "rt_xxx...",
    "client_id": "b42bdc5e-..."
  },
  {
    "user_id": "user-loadtest-002",
    "refresh_token": "rt_yyy...",
    "client_id": "b42bdc5e-..."
  }
]
```

### 重要なポイント

- `user_id` は VU ごとに異なる
- `client_id` は全 VU で共通で OK
- 各 RT は独立した token family に属する

---

## 関連ドキュメント

- [テストシナリオ詳細](./test-scenarios.md) - TEST 1/2/3 の詳細仕様
- [アーキテクチャ](./architecture.md) - テスト環境構成
- [メトリクス収集](./metrics-collection.md) - Cloudflare Analytics からのデータ取得
- [負荷テスト結果](./LOAD_TEST_RESULTS.md) - 過去のテスト結果

---

## 変更履歴

| 日付       | 変更内容 |
| ---------- | -------- |
| 2025-12-03 | 初版作成 |
