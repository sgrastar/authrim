# テスト環境アーキテクチャ

## 概要

このドキュメントでは、Authrim の負荷テストにおける標準アーキテクチャを定義します。

## テスト実行環境（ローカル）

### ハードウェア要件

| 項目         | 推奨スペック             | 最低スペック        |
| ------------ | ------------------------ | ------------------- |
| CPU          | Apple Silicon (M1/M2/M3) | Intel Core i5 以上  |
| メモリ       | 16GB 以上                | 8GB 以上            |
| ストレージ   | SSD 100GB 以上の空き     | SSD 50GB 以上の空き |
| ネットワーク | 上り 100Mbps 以上        | 上り 50Mbps 以上    |

### ソフトウェア要件

#### 必須ツール

1. **k6 OSS**
   - バージョン: v0.45.0 以上
   - インストール方法:

     ```bash
     # macOS
     brew install k6

     # Linux (Debian/Ubuntu)
     sudo gpg -k
     sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
       --keyserver hkp://keyserver.ubuntu.com:80 \
       --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
     echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
       sudo tee /etc/apt/sources.list.d/k6.list
     sudo apt-get update
     sudo apt-get install k6
     ```

2. **wrangler**
   - バージョン: v3.0.0 以上
   - インストール方法:
     ```bash
     npm install -g wrangler
     wrangler login
     ```

3. **Node.js**
   - バージョン: v18.0.0 以上
   - 用途: wrangler の実行、結果処理スクリプト

#### 任意ツール

1. **jq**
   - 用途: JSON 結果の整形・フィルタリング
   - インストール:
     ```bash
     brew install jq
     ```

2. **curl**
   - 用途: API の手動テスト、デバッグ
   - 通常は OS にプリインストール済み

## Authrim 側構成

### アーキテクチャ図

```
┌─────────────────────────────────────────────────────────────┐
│                      ローカルテスト環境                        │
│                                                               │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐             │
│  │   k6     │     │ wrangler │     │   jq     │             │
│  │  (負荷)   │     │(メトリクス)│     │ (整形)    │             │
│  └────┬─────┘     └──────────┘     └──────────┘             │
│       │                                                       │
└───────┼───────────────────────────────────────────────────────┘
        │
        │ HTTPS
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│                  Cloudflare Edge Network                      │
│                                                               │
│  ┌───────────────────────────────────────────────────────┐   │
│  │  Edge Cache / WAF / DDoS Protection / Rate Limiting   │   │
│  └─────────────────────┬─────────────────────────────────┘   │
│                        │                                      │
└────────────────────────┼──────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Authrim Workers Layer                      │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Authrim Worker                                      │    │
│  │  ├─ /authorize (認可エンドポイント)                    │    │
│  │  ├─ /token (トークン発行)                             │    │
│  │  ├─ /userinfo (ユーザー情報)                          │    │
│  │  └─ /.well-known/openid-configuration                │    │
│  └────┬────────────────────────────────────────┬─────────┘    │
│       │                                        │              │
│       │                                        │              │
└───────┼────────────────────────────────────────┼──────────────┘
        │                                        │
        │                                        │
        ▼                                        ▼
┌─────────────────┐                    ┌─────────────────┐
│  KeyManager DO  │                    │   Other DOs     │
│                 │                    │                 │
│  ├─ JWK Cache   │                    │ ├─ AuthzCode   │
│  ├─ Key Rotate  │                    │ ├─ TokenStore  │
│  └─ Sign/Verify │                    │ └─ Session     │
└────┬────────────┘                    └────┬────────────┘
     │                                      │
     │                                      │
     ▼                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Storage Layer                   │
│                                                               │
│  ┌──────────┐      ┌──────────┐      ┌──────────┐           │
│  │    KV    │      │    D1    │      │    R2    │           │
│  │          │      │          │      │          │           │
│  │ ・JWK    │      │・Refresh │      │ ・Logs   │           │
│  │ ・Config │      │・Session │      │ (Optional)│           │
│  └──────────┘      └──────────┘      └──────────┘           │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 各コンポーネントの役割

#### 1. Cloudflare Edge Network

- **役割**:
  - リクエストの最前線受付
  - DDoS 保護
  - Rate Limiting
  - Edge キャッシュ（静的コンテンツ）

- **負荷テストへの影響**:
  - Rate Limiting 設定により、テストが制限される可能性
  - Workers Unlimited プランを推奨

#### 2. Authrim Worker

- **役割**:
  - OIDC プロトコルの実装
  - リクエストルーティング
  - DO / KV / D1 への振り分け

- **負荷テストで測定する項目**:
  - CPU 時間 (ms)
  - リクエスト数
  - エラーレート
  - レスポンスタイム (p50/p90/p99)

#### 3. Durable Objects (DO)

##### KeyManager DO

- **役割**:
  - JWK のキャッシュ
  - JWT の署名・検証
  - 鍵のローテーション

- **負荷テストで測定する項目**:
  - DO 実行回数
  - 署名処理時間
  - キャッシュヒット率

##### AuthorizationCodeStore DO

- **役割**:
  - 認可コードの一時保存
  - PKCE 検証データの保持

- **負荷テストで測定する項目**:
  - 書き込み/読み取り競合
  - コード発行レート

##### TokenStore DO

- **役割**:
  - アクセストークンの管理
  - Refresh Token のローテーション

- **負荷テストで測定する項目**:
  - Refresh 時の競合
  - ローテーション処理時間

#### 4. Cloudflare Storage

##### KV (Key-Value Store)

- **役割**:
  - JWK の公開鍵保存
  - 設定情報のキャッシュ

- **特性**:
  - Eventually Consistent
  - 読み取り高速、書き込み遅延あり

##### D1 (SQLite Database)

- **役割**:
  - Refresh Token の永続化
  - Session データの保存

- **負荷テストで測定する項目**:
  - 書き込み速度
  - 読み取り速度
  - トランザクション競合

##### R2 (Object Storage)

- **役割** (任意):
  - 監査ログの保存
  - テスト結果の長期保存

## テストトラフィックフロー

### TEST 1: /token 単体

```
k6
 ↓
 POST /token
 ↓
Authrim Worker
 ↓
KeyManager DO (JWT 署名)
 ↓
KV (JWK 読取)
 ↓
Response (JWT)
```

### TEST 2: Refresh Token Storm

```
k6
 ↓
 POST /token (grant_type=refresh_token)
 ↓
Authrim Worker
 ↓
TokenStore DO (ローテーション)
 ↓
D1 (Refresh Token 更新)
 ↓
KeyManager DO (JWT 署名)
 ↓
Response (新しい Access Token + Refresh Token)
```

### TEST 3: フル OIDC フロー

```
k6
 ↓
 GET /authorize
 ↓
Authrim Worker
 ↓
AuthorizationCodeStore DO (コード発行)
 ↓
Response (code)
 ↓
k6 (code 受取)
 ↓
 POST /token
 ↓
Authrim Worker
 ↓
AuthorizationCodeStore DO (コード検証・削除)
 ↓
TokenStore DO (トークン発行)
 ↓
D1 (Session 保存)
 ↓
KeyManager DO (JWT 署名)
 ↓
Response (Access Token + Refresh Token)
```

## ネットワーク要件

### 帯域幅計算

#### 最小帯域幅（Light プリセット）

- RPS: 20
- リクエストサイズ: 約 2KB
- レスポンスサイズ: 約 5KB
- **必要帯域幅**: 20 × (2 + 5) KB = 140 KB/s ≈ **1.1 Mbps**

#### 推奨帯域幅（Standard プリセット）

- RPS: 100
- **必要帯域幅**: 100 × 7 KB = 700 KB/s ≈ **5.6 Mbps**

#### Heavy プリセット

- RPS: 600
- **必要帯域幅**: 600 × 7 KB = 4,200 KB/s ≈ **33.6 Mbps**

### レイテンシ要件

- **RTT (Round Trip Time)**: 通常 50-100ms（日本から Cloudflare Edge まで）
- **Worker 処理時間**: 通常 10-50ms
- **DO 処理時間**: 通常 5-20ms
- **D1 書き込み**: 通常 10-30ms

**合計予想レスポンスタイム**: 75-200ms（正常時）

## Cloudflare Analytics 設定

### 必要な権限

Cloudflare API Token に以下の権限が必要：

- **Workers Scripts: Read**
- **Analytics: Read**
- **Logs: Read**

### Analytics Engine の有効化

`wrangler.toml` に以下を追加：

```toml
[observability]
enabled = true
head_sampling_rate = 1.0  # テスト時は 100% サンプリング

[analytics_engine_datasets]
# 必要に応じてカスタムデータセットを定義
```

### Graph API エンドポイント

```
https://api.cloudflare.com/client/v4/graphql
```

## セキュリティ考慮事項

### テスト環境の分離

- 本番環境とテスト環境を完全に分離
- テスト用の専用 Worker、DO、D1 を使用
- テスト用のダミーデータのみを使用

### Rate Limiting

- テスト中は Rate Limiting を緩和または無効化
- テスト後は必ず元に戻す

### 認証情報の管理

- `.env` ファイルは `.gitignore` に追加
- API トークンは最小権限の原則に従う
- テスト終了後、不要なトークンは削除

## モニタリング

### リアルタイムモニタリング

テスト実行中は以下をモニタリング：

1. **Cloudflare Dashboard**
   - Workers Analytics
   - リアルタイムリクエスト数
   - エラーレート

2. **k6 出力**
   - リアルタイム RPS
   - レスポンスタイム
   - VU 状態

### 事後分析

テスト終了後は以下を収集：

1. **Cloudflare Graph API**
   - CPU 使用量
   - メモリ使用量
   - DO 実行回数
   - D1 クエリ数

2. **k6 結果**
   - サマリーレポート
   - タイムライングラフ
   - エラーログ

## トラブルシューティング

### よくある問題

#### 1. 429 Too Many Requests

**原因**: Rate Limiting に引っかかっている

**解決策**:

- Workers Unlimited プランに変更
- Rate Limiting 設定を緩和
- テストの RPS を下げる

#### 2. 500 Internal Server Error の急増

**原因**: DO のロック競合、D1 の書き込み競合

**解決策**:

- プリセットを下げる
- DO の設計を見直す（競合回避）
- D1 のトランザクションを最適化

#### 3. タイムアウトエラー

**原因**: Worker の処理時間超過（CPU Time Limit）

**解決策**:

- 不要な処理を削減
- キャッシュを活用
- 処理を非同期化

## 関連ドキュメント

- [endpoint-requirements.md](./endpoint-requirements.md) - エンドポイント別の必須設定・状態管理ルール
- [test-scenarios.md](./test-scenarios.md) - テストシナリオ詳細
- [metrics-collection.md](./metrics-collection.md) - メトリクス収集手順

## 参考資料

- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects Best Practices](https://developers.cloudflare.com/durable-objects/best-practices/)
- [D1 Database Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [k6 Documentation](https://k6.io/docs/)
