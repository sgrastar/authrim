# Deferred Items Across Phases

最終更新: 2026-04-23

## 目的

Phase 0 と Phase 1 で決めたもの、実装したもののうち、Phase 2 から Phase 4 以降へ持ち越す項目を 1 箇所に集約する。

このメモは「未着手」を列挙するだけではなく、どの phase で拾う前提か、なぜ後回しにしたかも残す。

## Phase 0 からの持ち越し

### Phase 1 で一部だけ着手し、後段でも継続して扱うもの

- `is_required` の canonical semantics を全 write path へ広げる作業
  - signup / admin / SCIM / federation / upgrade は Phase 1 で揃えた
  - import runner、将来の sync / bulk / background provisioning は後続 phase でも同じ helper を使う
- `lifecycle_state` の拡張
  - Phase 1 では `active / incomplete` の materialization まで
  - `invited / pending_verification / provisioning / dormant / archived / deprovisioned` の本格運用は後段で行う
- Admin UI 文言と導線の完全整理
  - semantics は docs 上で固定済み
  - UI の最終的な説明文、補完導線、profile completion UX は後段で詰める

## Phase 1 からの持ち越し

### Phase 2 へ持ち越すもの

- custom claims / registration fields の DB portability
  - shared helper は `DatabaseAdapter` / `DatabaseSource` に寄せ始めた
  - route layer と runtime wiring の concrete backend 依存はまだ残る
- custom claims 周辺の SQL portability inventory
  - `ON CONFLICT`, JSON 参照、bind 数対策、migration 差分の棚卸しが必要
- `users/import` 実処理
  - 現状は import job 作成 API のみ
  - runner 実装時に `validateCustomClaimWrite(...)` と `syncUserLifecycleState(...)` を共通利用する

### Phase 3 へ持ち越すもの

- completion ticket / missing reason の materialization
  - Phase 1 では `missing_required_fields` を動的に返すところまで
  - tenant / environment ごとの storage profile を持つ段階で、どこへ保存するかを決める
- profile completion flow の保存先整理
  - `storage profile`
  - `audit profile`
  - `residency profile`
  と矛盾しない形で state を formalize する

### Phase 4 へ持ち越すもの

- required 違反 detector の監査連携
  - 現在は admin endpoint による on-demand detection
  - 将来は audit sink / forwarding sink へ流すかを設計する
- federation / provisioning の incomplete 遷移イベント
  - 現在の JIT / federation は hard-fail が基本
  - incomplete mode に切り替えるなら audit routing 設計とも接続する

## Phase 2 完了後に残る wider portability items

- custom claims route layer の backend wiring 統一
  - shared helper の `DatabaseSource` 化は先行済み
  - ただし `admin.ts` など broader runtime path の `D1Adapter` 直結は段階的に寄せる
- PostgreSQL / MySQL backend 実装
  - まだ adapter 自体は未実装
  - 先に portable SQL subset と差分一覧を固める
- registration / custom-claims cache invalidation helper の共通化
  - cache invalidation 自体は既に修正済み
  - backend 切替前提の抽象はまだない

## Phase 3 完了後の follow-up

- repo-wide user-store portability
  - Phase 3 では profile model と主要 user-store path の wiring まで完了
  - raw `new D1Adapter(...)` 残骸や non-user-store 領域の portability は後続で整理する
- profile registry backend の運用強化
  - `kv` / `database` backend 自体は実装済み
  - setup UI、secret/reference lifecycle、migration/rollback の運用は未整備
- residency policy の runtime/sharding 接続
  - residency profile の型と pointer は入った
  - 実際の shard placement や region-specific provisioning は後続

## Phase 4 で残している持ち越し

- routing rule の canonical fan-out model
  - Phase 4 の初手で `backend` から `targets.primaryStore / archiveStores / forwardingSinks` へ正規化する
  - legacy `backend` は read/write で受けつつ canonical shape に寄せる
- `primary store / archive store / forwarding sink` への audit model 拡張
- Cloudflare Logpush 実装
- Cloudflare 非依存 sink 実装
  - 例: Firehose 相当
- mirror / dual-write / temporary capture の rule model
- retention / retry / backpressure / delivery guarantee の backend 別設計

## 後段でも意識する前提

- user は `tenant-scoped`
- tenant は environment に閉じる
- environment 間連携は OIDC / Federation で解く
- storage profile は `environment default + tenant override`
- tenant には full JSON ではなく pointer を持たせる
- profile registry backend は deployment profile ごとに選べる
- DB portability は `portable SQL subset` を原則とする
- audit は `primary store / archive store / forwarding sink`
