# Phase 4: Audit Routing and Sinks

最終更新: 2026-04-24

## 目的

audit log を小規模と大規模の両方に対応できるモデルへ広げる。

## 方針

audit log は次の 3 層で扱う。

- primary store
- archive store
- forwarding sink

## 想定する backend / sink

- primary
  - D1
  - PostgreSQL + Hyperdrive
  - MySQL + Hyperdrive
- archive
  - R2
- forwarding sink
  - Cloudflare Logpush
  - generic HTTP sink
  - 将来的な Kinesis Data Firehose
  - 他 vendor sink

## 実施内容

- 現行の `1 rule -> 1 backend` を見直す
- dual-write / mirror / temporary capture を表現できる rule model を設計する
- retention を backend ごとに分ける
- Logpush を forwarding sink として扱う
- Cloudflare 依存しすぎない sink abstraction を作る

## 実装済み slice

- routing rule の canonical shape を `targets` ベースに定義した
  - `targets.primaryStore`
  - `targets.archiveStores`
  - `targets.forwardingSinks`
- legacy な `backend` は read/write 時に `targets.primaryStore` へ正規化する
- admin audit-storage API は canonical shape を返す
- routing rule の validation は「少なくとも 1 つ target があること」を要求する
- rule CRUD の test を target-based model に追従させた
- routing evaluation helper を追加した
  - default backend から開始する
  - priority の低い rule から評価する
  - `primaryStore` は first-match wins
  - `archiveStores` / `forwardingSinks` は union する
- audit profile の top-level targets を実配送に使う slice を追加した
  - `primary` は request path で処理
  - `archive / sink` は queue consumer で処理
  - `primary=null` の archive-only profile を許可
  - `archiveFailureMode`
  - `sinkFailureMode`
    を audit profile 単位で持つ
- Logpush は Authrim から直接 API 送信するのではなく、
  queue consumer が structured `console.log()` を出し、
  Cloudflare Workers Logpush で外部配送する前提にした
- archive-only profile の hot query は当面 `not_supported`
  - archive scan は後段対応
- legacy `audit_log` utility は transitional に unified audit service へ mirror する
  - 既存の `audit_log` table write は維持
  - 新しい `audit profile / queue fan-out` も同時に有効化する
- `AUDIT_QUEUE` consumer は `ar-management` に寄せる
  - 既存の scheduled cleanup と DB / R2 binding があるため
  - setup / wrangler も consumer を生成するよう揃える
- `audit-storage` settings API は audit profile を正本として扱うようにした
  - managed audit profile を作成・更新する
  - legacy `batchConfig` だけは transitional に KV へ残す
- `runtime-profiles` API で environment default profile を更新できるようにした
  - `audit profile` は managed profile だけでなく built-in / custom profile を default にできる
  - `audit-storage` API は compatibility facade として残しつつ、canonical な default 切替先を明確にした
- generic HTTP sink を実装した
  - `audit profile.sinks[]` で `type='http'` を指定できる
  - queue consumer が JSON payload を `POST` する
  - `url` の直書きと `urlRef` / `authTokenRef` の両方を扱える
- setup tool から custom audit profile を seed できる
  - config の `profiles.seed.audit[]` に generic HTTP sink を含められる
  - deploy / web deploy 時に registry backend へ seed する
  - CLI の config edit からも default audit profile と seeded HTTP sink profile を更新できる
- Admin UI から runtime profile を変更できる
  - `/admin/settings/runtime-profiles` を追加
  - 現在は JSON editor ベースだが、deploy 後に `http` / `logpush` / `firehose` sink を更新できる
- `audit-storage` の retention endpoint は audit profile retention を正本として返す
  - `eventLogRetentionDays / piiLogRetentionDays / archiveBeforeDelete / minimumRetentionDays`
    を managed audit profile に保存する
- unified audit service は routing rule の解決結果を delivery plan に反映する
  - matched rule の `archiveStores` / `forwardingSinks` を queue fan-out に載せる
  - matched rule の retention override は `retentionUntil` 計算へ反映する
- fan-out plan は複数 archive target を持てる
  - queue consumer は `archives[]` を順に配送する
- `event-dispatcher` や legacy `audit_log` utility は shared helper 経由に寄せた
  - runtime path では direct `audit_log` insert を個別実装しない
  - legacy table write 自体は transitional に維持する
- `audit-storage` の stats / cleanup 補助 endpoint は resolved audit profile を返す
  - archive-only profile では hot query / primary cleanup を `not_supported` と明示する
- audit query endpoint 自体も hot query 可否を返す
  - archive-only profile では `not_supported`
  - PostgreSQL primary + Hyperdrive binding では `supported`
  - MySQL primary + Hyperdrive binding でも `supported`
  - binding を解決できない external primary や未対応 backend は `pending_runtime_support`
  - response に `profile_id` と `hot_query_status` を含める
- compatibility として `audit-storage` API からも default audit profile を切り替えられる
  - `builtin:audit:archive-only-logpush` を admin API から選択可能
  - storage mutation と custom profile 指定の同時実行は拒否する
- Hyperdrive/PostgreSQL adapter の baseline を `pg` で実装した
  - `HyperdriveAuditAdapter` の placeholder client を除去
  - PostgreSQL で無効な `DELETE ... LIMIT` は CTE ベースの retention cleanup に置き換えた
- unified audit service の request path は external Postgres primary に同期 write できる
  - D1 fast path は維持
  - Postgres primary は target resolver 経由で `HyperdriveAuditAdapter` を使う
  - event / pii の両方を同じ flow で処理する
- admin hot query / stats は external Postgres primary を読める
  - Hyperdrive binding が解決できる場合に `event_log` を hot query source として使う
  - archive-only profile は引き続き `not_supported`
  - MySQL など未対応 primary は `pending_runtime_support`
- scheduled cleanup は resolved audit profile を見て primary ごとに retention cleanup を実行する
  - archive-only tenant は skip
  - D1 primary は `event_log / pii_log` の retention cleanup を継続
  - PostgreSQL primary は `HyperdriveAuditAdapter.deleteByRetention(...)` を使う
  - MySQL primary は `MysqlAuditAdapter.deleteByRetention(...)` を使う
  - legacy `audit_log` cleanup は transitional に維持する
- audit / archive / sink の共通 canonical payload format を `authrim.audit.v1` に固定した
  - archive (R2 JSONL)
  - Logpush structured logs
  - generic HTTP sink payload
  で同じ record / batch schema を使う
- MySQL primary を audit scope で実装した
  - request path の同期 write
  - admin hot query / stats
  - scheduled cleanup
  まで対応した

この sliceを先に入れる理由:

- 配送実装より先に rule model を固定したい
- Logpush / Firehose 実装を急ぐより、admin API と KV の保存形を先に安定させる方が後戻りが少ない
- legacy `backend` を受けながら canonical shape に寄せれば、段階移行しやすい

## 実現したいユースケース

- D1 と R2 に同時保存
- D1 は 1 日だけ保持して自動削除
- 通常は Logpush / archive 主体
- 特定 tenant / user / category / time window だけ D1 に mirror

## なぜ最後にやるか

価値は高いが、モデルが広く、最初に着手すると議論が散りやすいため。  
custom claims portability と profile の概念を先に作ってからの方が設計しやすい。

## 後日メモ

- external primary の対応順
  - 最初は `audit + PostgreSQL + Hyperdrive + pg`
  - audit scope の MySQL primary は実装済み
  - repo-wide storage portability は後段
- target ごとの failure mode
  - 現在は audit profile 単位
  - target 単位 override は後段
- Firehose など追加 sink の実装
  - generic HTTP sink は実装済み
  - Firehose など他 vendor sink はこれに続けて追加する
- sink backend config UI の改善
  - 現在は Admin UI の JSON editor で編集する
  - sink ごとのフォーム UI や接続確認 UX は後段
- archive scan / hot query の後段実装
  - archive-only profile では管理画面検索を `not_supported` としている
  - R2/S3 側を直接読む検索は後段
- sink ごとの delivery guarantee
- backpressure と retry policy
- sink failure 時の degrade 戦略
- Phase 0 / Phase 1 の持ち越し一覧
  - [deferred-items.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/deferred-items.md)
