# Authrim 負荷テスト結果レポート

## 概要

Authrim OAuth2/OIDC サーバーの `/token` エンドポイント負荷テスト結果をまとめたドキュメントです。

**テスト環境:**
- ターゲット: `https://conformance.authrim.com`
- テスト日: 2025-12-01
- テストツール: k6
- インフラ: Cloudflare Workers + Durable Objects + D1

### テスト環境の設定（本番との差分）

| 設定項目 | テスト環境 | 本番推奨値 | 理由 |
|---------|-----------|-----------|------|
| `CODE_EXPIRY` | 3600秒 (1時間) | 120秒 (2分) | シード事前生成のため延長。トークン発行処理自体は同一 |
| `REFRESH_TOKEN_ROTATION_ENABLED` | false | true | 今回は authorization_code フローのみテスト。リフレッシュフローは別途テスト予定 |

**実運用との整合性:**
- `/token` エンドポイントの authorization_code grant 処理は本番と**完全に同一**
- CODE_EXPIRYが長いだけで、JWT署名・DO処理・D1クエリは実運用と同じ負荷
- リフレッシュトークンローテーションは今回のテストフローには影響しない

---

## 最適化の履歴

| 日時 | 最適化内容 | 影響 |
|------|-----------|------|
| 2025-11-30 | AuthCodeStore シャーディング (**64 shards**) | DO競合削減、負荷分散 |
| 2025-11-30 | KeyManager Worker側キャッシュ (TTL 5分) | DOホップ削減 |
| 2025-12-01 | RefreshTokenRotator 粒度細分化ストレージ | ストレージI/O削減 |
| 2025-12-01 | RefreshTokenRotator 差分保存 | 書き込み削減 |
| 2025-12-01 | RefreshTokenRotator 条件付き非同期監査ログ | 遅延削減 |

**シャーディング詳細:**
- Authorization Code用のDurable Objectを64個のシャードに分散（`AUTHRIM_CODE_SHARDS`環境変数、デフォルト64）
- コード形式: `{shardIndex}_{randomCode}` (例: `76_6jKth...`)
- ランダムシャード選択により、全シャードに均等に負荷を分散
- 実装: `packages/shared/src/utils/tenant-context.ts:101`

---

## テスト結果サマリー

### 1. 50RPS テスト（最適化後）

**実施日時:** 2025-12-01 00:59:26 JST (2025-11-30T23:59:26Z)

**テスト条件:**
- プリセット: `rps50`
- 期間: 1分35秒（ランプアップ含む）
- 最大VU: 60

**k6 結果:**
| メトリクス | 値 |
|-----------|-----|
| 総リクエスト | 3,849 |
| 成功率 | 100% |
| 失敗 | 0 |
| p50 レスポンス | 0ms (k6表示) |
| p90 レスポンス | 115.76ms |
| p95 レスポンス | 119.30ms |

**Cloudflare Analytics:**
- ファイル: `results/cf-analytics_2025-12-01T00-02-31.json`
- 期間: 2025-11-30T23:59:00Z ~ 2025-12-01T00:03:00Z

| メトリクス | 値 |
|-----------|-----|
| Worker Duration p50 | 11.60 ms |
| Worker Duration p75 | 12.49 ms |
| Worker Duration p90 | 12.91 ms |
| Worker Duration p99 | 16.00 ms |
| Worker Duration p999 | 133.13 ms |
| CPU Time p50 | 4.69 ms |
| CPU Time p99 | 8.10 ms |
| DO Wall Time p50 | 19.50 ms |
| DO Wall Time p99 | 11,194.05 ms |
| DO Wall Time p999 | 43,649.00 ms |
| D1 Read Queries | 76,715 |
| D1 Write Queries | 56,310 |

---

### 2. 50RPS テスト（最適化前 - ベースライン）

**実施日時:** 2025-11-30 19:11:07 JST (2025-11-30T18:51:00Z)

**Cloudflare Analytics:**
- ファイル: `results/cf-analytics_2025-11-30T19-11-07.json`
- 期間: 2025-11-30T18:51:00Z ~ 2025-11-30T18:53:00Z

| メトリクス | 値 |
|-----------|-----|
| Worker Duration p50 | 30.53 ms |
| Worker Duration p75 | 93.19 ms |
| Worker Duration p90 | 164.16 ms |
| Worker Duration p99 | 261.65 ms |
| Worker Duration p999 | 414.82 ms |
| CPU Time p50 | 4.68 ms |
| CPU Time p99 | 7.55 ms |
| DO Wall Time p50 | 59.22 ms |
| DO Wall Time p99 | 13,919.74 ms |
| DO Wall Time p999 | 131,496.91 ms |
| D1 Read Queries | 58,752 |
| D1 Write Queries | 48,582 |

---

## 最適化効果の比較

### Worker Duration

| パーセンタイル | 最適化前 | 最適化後 | 改善率 |
|---------------|---------|---------|--------|
| p50 | 30.53 ms | 11.60 ms | **-62%** |
| p75 | 93.19 ms | 12.49 ms | **-87%** |
| p90 | 164.16 ms | 12.91 ms | **-92%** |
| p99 | 261.65 ms | 16.00 ms | **-94%** |
| p999 | 414.82 ms | 133.13 ms | **-68%** |

### Durable Objects Wall Time

| パーセンタイル | 最適化前 | 最適化後 | 改善率 |
|---------------|---------|---------|--------|
| p50 | 59.22 ms | 19.50 ms | **-67%** |
| p75 | 489.57 ms | 73.55 ms | **-85%** |
| p90 | 2,600.01 ms | 2,415.96 ms | -7% |
| p99 | 13,919.74 ms | 11,194.05 ms | **-20%** |
| p999 | 131,496.91 ms | 43,649.00 ms | **-67%** |

---

## 100RPS テスト

**実施日時:** 2025-12-01 09:48:11 JST (2025-12-01T00:48:11Z)

**テスト条件:**
- プリセット: `rps100`
- 期間: 約2分45秒（100RPSを2分間維持）
- 最大VU: 150
- シード数: 15,000

**k6 結果:**
- **ログファイル:** `results/test1-rps100_20251201_014811.log`

| メトリクス | 値 |
|-----------|-----|
| 総リクエスト | **14,775** |
| 成功率 | **100%** |
| 失敗 | 0 |
| p50 レスポンス | 0ms (k6表示) |
| p90 レスポンス | 114.94ms |
| p95 レスポンス | **119.17ms** |
| p99 レスポンス | 127.58ms |

**Cloudflare Analytics:**
- ファイル: `results/cf-analytics_2025-12-01T02-52-03.json`
- 期間: 2025-12-01T00:48:00Z ~ 2025-12-01T00:52:00Z

| メトリクス | 値 |
|-----------|-----|
| Worker Duration p50 | 17.20 ms |
| Worker Duration p75 | 18.21 ms |
| Worker Duration p90 | 19.26 ms |
| Worker Duration p99 | 22.57 ms |
| Worker Duration p999 | 157.26 ms |
| CPU Time p50 | 2.18 ms |
| CPU Time p99 | 6.00 ms |
| DO Wall Time p50 | 10.08 ms |
| DO Wall Time p99 | 2,789.84 ms |
| DO Wall Time p999 | 107,490.74 ms |
| D1 Read Queries | 150,114 |
| D1 Write Queries | 209,835 |

---

## 200RPS テスト

**実施日時:** 2025-12-01 11:07:43 JST (2025-12-01T02:07:43Z)

**テスト条件:**
- プリセット: `rps200`
- 期間: 約2分45秒（200RPSを2分間維持）
- 最大VU: 200
- シード数: 30,000

**k6 結果:**
- **ログファイル:** `results/test1-rps200_20251201_020743.log`

| メトリクス | 値 |
|-----------|-----|
| 総リクエスト | **29,748** |
| 成功率 | **100%** |
| 失敗 | 0 |
| p50 レスポンス | 0ms (k6表示) |
| p90 レスポンス | 117.40ms |
| p95 レスポンス | **123.66ms** |
| p99 レスポンス | 131.59ms |

**Cloudflare Analytics:**
- ファイル: `results/cf-analytics_2025-12-01T02-53-41.json`
- 期間: 2025-12-01T02:12:00Z ~ 2025-12-01T02:16:00Z

| メトリクス | 値 |
|-----------|-----|
| Worker Duration p50 | 11.58 ms |
| Worker Duration p75 | 12.14 ms |
| Worker Duration p90 | 12.80 ms |
| Worker Duration p99 | 25.50 ms |
| Worker Duration p999 | 426.66 ms |
| CPU Time p50 | 4.65 ms |
| CPU Time p99 | 9.82 ms |
| DO Wall Time p50 | 9.42 ms |
| DO Wall Time p99 | 2,658.30 ms |
| DO Wall Time p999 | 41,864.63 ms |
| D1 Read Queries | 150,114 |
| D1 Write Queries | 209,835 |

**スケーリング特性:**
- 100→200RPS: リクエスト数2倍増加
- p95レスポンス: 119.17ms → 123.66ms (+3.8%) - ほぼ線形スケール

---

## 300RPS テスト

**実施日時:** 2025-12-01 11:21:38 JST (2025-12-01T02:21:38Z)

**テスト条件:**
- プリセット: `rps300`
- 期間: 約2分50秒（300RPSを2分間維持）
- 最大VU: 300
- シード数: 50,000

**k6 結果:**
- **ログファイル:** `results/test1-rps300_20251201_022138.log`
- **シード生成ログ:** `/tmp/seed_gen_300rps.log`

| メトリクス | 値 |
|-----------|-----|
| 総リクエスト | **48,708** |
| 成功率 | **99.998%** |
| 失敗 | 1 (ネットワークタイムアウト) |
| p50 レスポンス | 0ms (k6表示) |
| p90 レスポンス | 124.35ms |
| p95 レスポンス | **138.75ms** |
| p99 レスポンス | 1,027.85ms |

**Cloudflare Analytics:**
- ファイル: `results/cf-analytics_2025-12-01T02-54-07.json`
- 期間: 2025-12-01T02:21:00Z ~ 2025-12-01T02:25:00Z

| メトリクス | 値 |
|-----------|-----|
| Worker Duration p50 | 17.58 ms |
| Worker Duration p75 | 18.66 ms |
| Worker Duration p90 | 19.85 ms |
| Worker Duration p99 | 34.00 ms |
| Worker Duration p999 | 416.31 ms |
| CPU Time p50 | 4.59 ms |
| CPU Time p99 | 10.80 ms |
| DO Wall Time p50 | 10.10 ms |
| DO Wall Time p99 | 1,875.07 ms |
| DO Wall Time p999 | 34,270.47 ms |
| D1 Read Queries | 150,114 |
| D1 Write Queries | 209,835 |

**スケーリング特性:**
- 200→300RPS: リクエスト数1.5倍増加
- p95レスポンス: 123.66ms → 138.75ms (+12.2%) - 若干の非線形性
- p99でのテール遅延が発生（1,027ms）- 300RPSでの負荷集中を示唆

**シード生成:**
- 50,000コード生成: 310.3秒
- 生成速度: 161.1 codes/sec
- 並列度: 30 concurrent requests

---

## テスト結果の比較表

| RPS | 総リクエスト | 成功率 | p95レスポンス | p99レスポンス | 結果ファイル |
|-----|------------|--------|-------------|-------------|------------|
| 50 | 3,849 | 100% | 119.30ms | - | - |
| **100** | **14,775** | **100%** | **119.17ms** | 127.58ms | `test1-rps100_20251201_014811.log` |
| **200** | **29,748** | **100%** | **123.66ms** | 131.59ms | `test1-rps200_20251201_020743.log` |
| **300** | **48,708** | **99.998%** | **138.75ms** | 1,027.85ms | `test1-rps300_20251201_022138.log` |

**パフォーマンス分析:**
- 100-200RPS: ほぼ線形スケール（p95: +3.8%）
- 200-300RPS: 若干の非線形性（p95: +12.2%）
- p99での大きなテール遅延は300RPSで顕著（1秒超）

---

## スケール目安

| RPS | トークン発行/時 | トークン発行/日 | 想定MAU |
|-----|----------------|----------------|---------|
| 50 | 180,000 | 4.3M | 10万〜20万 |
| 100 | 360,000 | 8.6M | 20万〜40万 |
| 200 | 720,000 | 17.3M | 50万〜100万 |
| 300 | 1,080,000 | 25.9M | 100万〜200万 |

**スケーリング上限の推定:**
- **保守的推定:** 500 RPS（レイテンシ<200ms維持）
- **楽観的推定:** 800-1,000 RPS（現在のアーキテクチャで64シャード活用）
- **更なる改善案:**
  - `AUTHRIM_CODE_SHARDS`を128に増加（DO分散強化）
  - Refresh Token Rotatorの更なる最適化
  - D1クエリの最適化（インデックス追加）

---

## 関連ファイル

### Analytics データ
- `results/cf-analytics_2025-11-30T19-11-07.json` - ベースライン (50RPS)
- `results/cf-analytics_2025-12-01T00-02-31.json` - 最適化後 (50RPS)
- `results/cf-analytics_2025-12-01T02-52-03.json` - 100RPSテスト
- `results/cf-analytics_2025-12-01T02-53-41.json` - 200RPSテスト
- `results/cf-analytics_2025-12-01T02-54-07.json` - 300RPSテスト

### テストスクリプト
- `scripts/test1-token-load.js` - トークンエンドポイント負荷テスト
- `scripts/generate-seeds-parallel.js` - 並列シード生成

### 設定ファイル
- `packages/op-token/wrangler.conformance.toml` - CODE_EXPIRY=3600 (テスト用)
- `packages/op-auth/wrangler.conformance.toml` - CODE_EXPIRY=3600 (テスト用)
