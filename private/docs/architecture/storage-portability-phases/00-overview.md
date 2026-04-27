# Storage / Validation 全体フェーズ

最終更新: 2026-04-24

## 目的

以下を段階的に実装する。

- `is_required` と `registration_required` の意味を確定する
- custom claims / registration fields の validation を整理する
- custom claims 領域を最初の DB portability 対象にする
- `storage profile`, `audit profile`, `residency profile` を formalize する
- audit log を `primary store / archive store / forwarding sink` に拡張する

## なぜこの分け方にするか

最初の論点は `is_required` の意味の曖昧さだった。  
ここを決めずに DB portability や audit routing を進めると、後で validation と storage の責務がずれて手戻りになる。

そのため、進め方は次の順にする。

1. 意味を決める
2. 既存挙動を直す
3. 影響範囲の狭い領域から portability を始める
4. profile と audit の抽象を広げる

## フェーズ一覧

### Phase 0

`is_required` と `registration_required` の意味を固定する。

状態:

- semantics は 2026-04-22 時点で docs 上固定済み
- 実装反映は Phase 1 で進める

理由:

- ここが未確定だと実装判断がぶれる
- 既存 tenant 互換の扱いも決まらない

### Phase 1

registration / signup / admin update の validation を整理する。

状態:

- Phase 1 scope は 2026-04-23 時点で完了
- 持ち越しは import runner や completion UX など後段の周辺機能

理由:

- 元の問題意識に最も近い
- ユーザー影響が明確

### Phase 2

custom claims / registration fields を最初の DB portability 対象にする。

状態:

- Phase 2 scope は 2026-04-23 時点で完了
- remaining items は wider backend portability や concrete adapter 実装

理由:

- D1 直結箇所が明確
- auth core 全体より安全に始められる

### Phase 3

`storage / audit / residency profile` を formalize する。

状態:

- Phase 3 scope は 2026-04-23 時点で完了
- repo 全体の wider portability は後続 follow-up として扱う

理由:

- setup に residency 要素がすでにある
- tenant override を設計するための土台になる

### Phase 4

audit routing を拡張し、Logpush など forwarding sink を扱えるようにする。

状態:

- Phase 4 scope は 2026-04-24 時点で完了
- rule model の canonical 化
- audit profile 正本化
- queue fan-out
- routing rule 由来の delivery plan 反映
- generic HTTP sink
- PostgreSQL / MySQL audit primary
- canonical log format `authrim.audit.v1`
  まで実装済み
- 残りは Firehose、archive-only の検索系、target 単位 failure mode など後続項目

理由:

- 小規模と大規模の両方に対応できる
- vendor lock-in を避けながら Cloudflare native も使える

### Phase 5

repo-wide storage portability の残骸を整理する。

状態:

- Phase 5 は 2026-04-24 時点で開始
- Phase 2 / 3 / 4 で局所的に進めた adapter/profile 対応を、
  repo 全体の runtime wiring へ広げるフェーズとして定義する
- 実施単位は `5a / 5b / 5c` に分ける
- `5a` の inventory / classification は開始済み
- `5b` の first slice として
  `SessionStore` / `DeviceCodeStore` / `CIBARequestStore`
  の store-specific persistence 契約を追加済み

理由:

- これは全体調整であり、個別機能追加と混ぜるとスコープが崩れやすい
- audit と user-store の一部だけ portability が進んだ状態を閉じるため、
  独立した 1 フェーズとして扱う方が管理しやすい

#### Phase 5a

inventory / classification。

- raw `new D1Adapter(...)`
- env-level binding 直結
- profile-aware でない runtime path

を棚卸しし、優先順位と slice を決める。

#### Phase 5b

security-sensitive store portability。

- sessions
- refresh tokens
- device codes
- CIBA requests
- token / consent / auth-code 周辺の stateful store

を portability の観点で整理する。

#### Phase 5c

broader runtime wiring / cache invalidation。

- admin / management / bridge / policy / vc などの wider runtime path
- custom claims route wiring の残り
- backend-agnostic cache invalidation helper

を寄せる。

### Phase 6

Phase 4 以降の運用強化と個別 follow-up を進める。

状態:

- Phase 6 は 2026-04-24 時点で未着手
- 対象は次の通り
  - audit の retention / retry / backpressure / delivery guarantee 整理
  - profile registry の運用強化
  - Firehose sink
  - sink UI 改善
  - import runner
  - archive-only 検索系

理由:

- portability の横断調整を終えた後でないと、運用面の改善と機能拡張の責務がぶれやすい
- 独立して進めやすい item を 1 つの後続フェーズにまとめることで優先順位を管理しやすい

## 先に決まっている方針

- user は `tenant-scoped`
- tenant は environment に閉じる
- environment 間連携は OIDC / Federation で解く
- storage profile は `environment default + tenant override`
- tenant には full JSON ではなく pointer を持たせる
- profile registry backend は deployment profile ごとに選べる
- DB portability は `portable SQL subset` を原則とする
- audit は `primary store / archive store / forwarding sink`

## 実装順序

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6

## 持ち越し管理

Phase 0 / Phase 1 で決めたが、Phase 2 から Phase 4 へ回した項目は以下に集約する。

- [deferred-items.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/deferred-items.md)

## 後日実施メモ

以下はこのフェーズ列には入れるが、直近の着手対象ではない。

- auth core 全体の DB portability
- backup / export / retention profile の formalization
- Cloudflare 以外の sink 実装
- tenant ごとの高度な override UI
