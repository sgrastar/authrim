# Storage / Validation 全体フェーズ

最終更新: 2026-04-23

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

- Phase 4 は 2026-04-23 時点で着手済み
- 最初の slice は rule model を `backend` から `primary / archive / sink` へ正規化する

理由:

- 小規模と大規模の両方に対応できる
- vendor lock-in を避けながら Cloudflare native も使える

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

## 持ち越し管理

Phase 0 / Phase 1 で決めたが、Phase 2 から Phase 4 へ回した項目は以下に集約する。

- [deferred-items.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/deferred-items.md)

## 後日実施メモ

以下はこのフェーズ列には入れるが、直近の着手対象ではない。

- auth core 全体の DB portability
- backup / export / retention profile の formalization
- Cloudflare 以外の sink 実装
- tenant ごとの高度な override UI
