# Phase 4: Audit Routing and Sinks

最終更新: 2026-04-23

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
- archive
  - R2
- forwarding sink
  - Cloudflare Logpush
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

- actual fan-out execution
- sink backend config UI / registry
- sink ごとの delivery guarantee
- backpressure と retry policy
- sink failure 時の degrade 戦略
- Phase 0 / Phase 1 の持ち越し一覧
  - [deferred-items.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/deferred-items.md)
